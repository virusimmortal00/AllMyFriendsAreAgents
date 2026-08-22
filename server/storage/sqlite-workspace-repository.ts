import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_WORKSPACE_QUOTAS,
  WorkspaceRepositoryError,
  makeWorkspaceRevision,
  normalizeWorkspacePath,
  validateWorkspaceMutation,
  workspaceRevisionBytes,
  type WorkspaceAttachment,
  type WorkspaceAttachmentInput,
  type WorkspaceAuditEvent,
  type WorkspaceContentRevision,
  type WorkspaceDocument,
  type WorkspaceDocumentHistory,
  type WorkspaceDocumentView,
  type WorkspaceExport,
  type WorkspaceMutation,
  type WorkspaceOperation,
  type WorkspaceQuotas,
  type WorkspaceRepository,
} from "./workspace-repository.js";

type Row = Record<string, unknown>;

function canonicalExport(snapshot: WorkspaceExport) {
  return {
    ...snapshot,
    documents: [...snapshot.documents].sort((a, b) => a.id.localeCompare(b.id)),
    revisions: [...snapshot.revisions].map((revision) => ({ ...revision, attachments: [...revision.attachments].sort((a, b) => a.id.localeCompare(b.id)) })).sort((a, b) => a.documentId.localeCompare(b.documentId) || a.revision - b.revision),
    auditEvents: [...snapshot.auditEvents].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id)),
  };
}

function documentFrom(row: Row): WorkspaceDocument {
  return { id: String(row.id), roomId: String(row.room_id), path: String(row.virtual_path), currentRevisionId: String(row.current_revision_id), currentRevision: Number(row.current_revision), createdAt: String(row.created_at), createdBy: String(row.created_by), updatedAt: String(row.updated_at), archivedAt: row.archived_at === null ? null : String(row.archived_at), archivedBy: row.archived_by === null ? null : String(row.archived_by) };
}
function attachmentFrom(row: Row): WorkspaceAttachment {
  return { id: String(row.id), roomId: String(row.room_id), documentId: String(row.document_id), revisionId: String(row.revision_id), name: String(row.name), mediaType: String(row.media_type), sizeBytes: Number(row.size_bytes), contentHash: String(row.content_hash), dataBase64: String(row.data_base64), createdAt: String(row.created_at), createdBy: String(row.created_by) };
}
function eventFrom(row: Row): WorkspaceAuditEvent {
  return { id: String(row.id), roomId: String(row.room_id), documentId: String(row.document_id), participantId: String(row.participant_id), timestamp: String(row.occurred_at), operation: row.operation as WorkspaceOperation, resultingRevisionId: String(row.resulting_revision_id), resultingRevision: Number(row.resulting_revision), previousPath: row.previous_path === null ? null : String(row.previous_path), path: String(row.virtual_path) };
}

export class SqliteWorkspaceRepository implements WorkspaceRepository {
  constructor(readonly database: DatabaseSync, readonly roomId: string, quotas?: WorkspaceQuotas) {
    const initial = quotas ?? DEFAULT_WORKSPACE_QUOTAS;
    database.prepare(`INSERT INTO workspace_quotas(room_id, document_count, content_size_bytes, revision_count, aggregate_room_bytes)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(room_id) DO NOTHING`).run(roomId, initial.documentCount, initial.contentSizeBytes, initial.revisionCount, initial.aggregateRoomBytes);
    if (quotas) database.prepare("UPDATE workspace_quotas SET document_count=?, content_size_bytes=?, revision_count=?, aggregate_room_bytes=? WHERE room_id=?")
      .run(quotas.documentCount, quotas.contentSizeBytes, quotas.revisionCount, quotas.aggregateRoomBytes, roomId);
  }

  private transaction<T>(callback: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = callback(); this.database.exec("COMMIT"); return result; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  private quotas(): WorkspaceQuotas {
    const row = this.database.prepare("SELECT * FROM workspace_quotas WHERE room_id = ?").get(this.roomId) as Row;
    return { documentCount: Number(row.document_count), contentSizeBytes: Number(row.content_size_bytes), revisionCount: Number(row.revision_count), aggregateRoomBytes: Number(row.aggregate_room_bytes) };
  }

  private attachments(revisionId: string) {
    return (this.database.prepare("SELECT * FROM workspace_attachments WHERE room_id = ? AND revision_id = ? ORDER BY id").all(this.roomId, revisionId) as Row[]).map(attachmentFrom);
  }

  private revisionFrom(row: Row): WorkspaceContentRevision {
    return { id: String(row.id), roomId: String(row.room_id), documentId: String(row.document_id), revision: Number(row.revision), content: String(row.content), contentHash: String(row.content_hash), sizeBytes: Number(row.size_bytes), createdAt: String(row.created_at), createdBy: String(row.created_by), attachments: this.attachments(String(row.id)) };
  }

  private current(documentId: string): WorkspaceDocumentView {
    const row = this.database.prepare("SELECT * FROM workspace_documents WHERE room_id = ? AND id = ?").get(this.roomId, documentId) as Row | undefined;
    if (!row) throw new WorkspaceRepositoryError("DOCUMENT_NOT_FOUND", `Workspace document ${documentId} does not exist.`, { documentId });
    const document = documentFrom(row);
    const revisionRow = this.database.prepare("SELECT * FROM workspace_revisions WHERE room_id = ? AND id = ?").get(this.roomId, document.currentRevisionId) as Row | undefined;
    if (!revisionRow) throw new WorkspaceRepositoryError("REVISION_NOT_FOUND", `Current revision ${document.currentRevisionId} does not exist.`);
    return { document, revision: this.revisionFrom(revisionRow) };
  }

  private cas(document: WorkspaceDocument, expectedRevisionId: string) {
    if (document.currentRevisionId !== expectedRevisionId) throw new WorkspaceRepositoryError("REVISION_CONFLICT", "The workspace document has changed.", { expectedRevisionId, actualRevisionId: document.currentRevisionId });
  }

  private availablePath(virtualPath: string, exceptId?: string) {
    const found = this.database.prepare("SELECT id FROM workspace_documents WHERE room_id = ? AND virtual_path = ? AND archived_at IS NULL AND id <> ?").get(this.roomId, virtualPath, exceptId ?? "") as Row | undefined;
    if (found) throw new WorkspaceRepositoryError("PATH_CONFLICT", `An active workspace document already exists at ${virtualPath}.`, { path: virtualPath });
  }

  private enforce(revision: WorkspaceContentRevision, create: boolean) {
    const quotas = this.quotas();
    const documentCount = Number((this.database.prepare("SELECT count(*) count FROM workspace_documents WHERE room_id = ?").get(this.roomId) as Row).count);
    if (create && documentCount + 1 > quotas.documentCount) throw new WorkspaceRepositoryError("QUOTA_DOCUMENT_COUNT", "Workspace document-count quota exceeded.", { limit: quotas.documentCount });
    if (revision.sizeBytes > quotas.contentSizeBytes) throw new WorkspaceRepositoryError("QUOTA_CONTENT_SIZE", "Workspace content-size quota exceeded.", { limit: quotas.contentSizeBytes, actual: revision.sizeBytes });
    const revisionCount = Number((this.database.prepare("SELECT count(*) count FROM workspace_revisions WHERE room_id = ? AND document_id = ?").get(this.roomId, revision.documentId) as Row).count);
    if (revisionCount + 1 > quotas.revisionCount) throw new WorkspaceRepositoryError("QUOTA_REVISION_COUNT", "Workspace revision-count quota exceeded.", { limit: quotas.revisionCount });
    const sizes = this.database.prepare(`SELECT coalesce((SELECT sum(size_bytes) FROM workspace_revisions WHERE room_id = ?), 0)
      + coalesce((SELECT sum(size_bytes) FROM workspace_attachments WHERE room_id = ?), 0) total`).get(this.roomId, this.roomId) as Row;
    const aggregate = Number(sizes.total) + workspaceRevisionBytes(revision);
    if (aggregate > quotas.aggregateRoomBytes) throw new WorkspaceRepositoryError("QUOTA_AGGREGATE_ROOM", "Workspace aggregate room quota exceeded.", { limit: quotas.aggregateRoomBytes, actual: aggregate });
  }

  private insertRevision(revision: WorkspaceContentRevision) {
    this.database.prepare(`INSERT INTO workspace_revisions(room_id, document_id, id, revision, content, content_hash, size_bytes, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(this.roomId, revision.documentId, revision.id, revision.revision, revision.content, revision.contentHash, revision.sizeBytes, revision.createdAt, revision.createdBy);
    const statement = this.database.prepare(`INSERT INTO workspace_attachments(room_id, document_id, revision_id, id, name, media_type, size_bytes, content_hash, data_base64, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const attachment of revision.attachments) statement.run(this.roomId, revision.documentId, revision.id, attachment.id, attachment.name, attachment.mediaType, attachment.sizeBytes, attachment.contentHash, attachment.dataBase64, attachment.createdAt, attachment.createdBy);
  }

  private insertEvent(document: WorkspaceDocument, operation: WorkspaceOperation, mutation: WorkspaceMutation, previousPath: string | null, id = `evt_${randomUUID()}`) {
    this.database.prepare(`INSERT INTO workspace_audit_events(room_id, id, document_id, participant_id, occurred_at, operation, resulting_revision_id, resulting_revision, previous_path, virtual_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(this.roomId, id, document.id, mutation.participantId, mutation.timestamp, operation, document.currentRevisionId, document.currentRevision, previousPath, document.path);
  }

  async listWorkspaceDocuments(options: { readonly includeArchived?: boolean } = {}) {
    const where = options.includeArchived ? "" : "AND archived_at IS NULL";
    return (this.database.prepare(`SELECT * FROM workspace_documents WHERE room_id = ? ${where} ORDER BY virtual_path`).all(this.roomId) as Row[]).map(documentFrom);
  }
  async getWorkspaceDocument(documentId: string) { try { return structuredClone(this.current(documentId)); } catch (error) { if (error instanceof WorkspaceRepositoryError && error.code === "DOCUMENT_NOT_FOUND") return undefined; throw error; } }
  async getWorkspaceRevision(documentId: string, revision: number | string) {
    const column = typeof revision === "number" ? "revision" : "id";
    const row = this.database.prepare(`SELECT * FROM workspace_revisions WHERE room_id = ? AND document_id = ? AND ${column} = ?`).get(this.roomId, documentId, revision) as Row | undefined;
    return row ? this.revisionFrom(row) : undefined;
  }

  async createWorkspaceDocument(input: { id?: string; path: string; content: string; attachments?: readonly WorkspaceAttachmentInput[] }, rawMutation: WorkspaceMutation) {
    const mutation = validateWorkspaceMutation(rawMutation);
    return this.transaction(() => {
      const id = input.id ?? `doc_${randomUUID()}`; const virtualPath = normalizeWorkspacePath(input.path); this.availablePath(virtualPath);
      if (this.database.prepare("SELECT 1 FROM workspace_documents WHERE room_id = ? AND id = ?").get(this.roomId, id)) throw new WorkspaceRepositoryError("IMPORT_COLLISION", `Document ID ${id} already exists.`, { documentId: id });
      const revision = makeWorkspaceRevision({ roomId: this.roomId, documentId: id, revision: 1, content: input.content, attachments: input.attachments, mutation }); this.enforce(revision, true);
      const document: WorkspaceDocument = { id, roomId: this.roomId, path: virtualPath, currentRevisionId: revision.id, currentRevision: 1, createdAt: mutation.timestamp, createdBy: mutation.participantId, updatedAt: mutation.timestamp, archivedAt: null, archivedBy: null };
      this.database.prepare(`INSERT INTO workspace_documents(room_id,id,virtual_path,current_revision_id,current_revision,created_at,created_by,updated_at,archived_at,archived_by) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(this.roomId, id, virtualPath, revision.id, 1, mutation.timestamp, mutation.participantId, mutation.timestamp, null, null);
      this.insertRevision(revision); this.insertEvent(document, "CREATE", mutation, null); return { document, revision };
    });
  }

  async updateWorkspaceDocument(documentId: string, input: { expectedRevisionId: string; content: string; attachments?: readonly WorkspaceAttachmentInput[] }, rawMutation: WorkspaceMutation) {
    const mutation = validateWorkspaceMutation(rawMutation);
    return this.transaction(() => {
      const { document } = this.current(documentId); this.cas(document, input.expectedRevisionId);
      const revision = makeWorkspaceRevision({ roomId: this.roomId, documentId, revision: document.currentRevision + 1, content: input.content, attachments: input.attachments, mutation }); this.enforce(revision, false);
      this.insertRevision(revision);
      const changes = this.database.prepare("UPDATE workspace_documents SET current_revision_id=?, current_revision=?, updated_at=? WHERE room_id=? AND id=? AND current_revision_id=?").run(revision.id, revision.revision, mutation.timestamp, this.roomId, documentId, input.expectedRevisionId).changes;
      if (!changes) throw new WorkspaceRepositoryError("REVISION_CONFLICT", "The workspace document has changed.", { expectedRevisionId: input.expectedRevisionId });
      const updated = { ...document, currentRevisionId: revision.id, currentRevision: revision.revision, updatedAt: mutation.timestamp }; this.insertEvent(updated, "UPDATE", mutation, document.path); return { document: updated, revision };
    });
  }

  async renameOrMoveWorkspaceDocument(documentId: string, input: { expectedRevisionId: string; path: string }, rawMutation: WorkspaceMutation) {
    const mutation = validateWorkspaceMutation(rawMutation);
    return this.transaction(() => {
      const { document, revision } = this.current(documentId); this.cas(document, input.expectedRevisionId); const virtualPath = normalizeWorkspacePath(input.path); this.availablePath(virtualPath, documentId);
      this.database.prepare("UPDATE workspace_documents SET virtual_path=?, updated_at=? WHERE room_id=? AND id=? AND current_revision_id=?").run(virtualPath, mutation.timestamp, this.roomId, documentId, input.expectedRevisionId);
      const updated = { ...document, path: virtualPath, updatedAt: mutation.timestamp }; this.insertEvent(updated, "RENAME_OR_MOVE", mutation, document.path); return { document: updated, revision };
    });
  }

  private setArchived(documentId: string, input: { expectedRevisionId: string }, rawMutation: WorkspaceMutation, archived: boolean) {
    const mutation = validateWorkspaceMutation(rawMutation);
    return this.transaction(() => {
      const { document, revision } = this.current(documentId); this.cas(document, input.expectedRevisionId); if (!archived) this.availablePath(document.path, documentId);
      const archivedAt = archived ? mutation.timestamp : null; const archivedBy = archived ? mutation.participantId : null;
      this.database.prepare("UPDATE workspace_documents SET archived_at=?, archived_by=?, updated_at=? WHERE room_id=? AND id=? AND current_revision_id=?").run(archivedAt, archivedBy, mutation.timestamp, this.roomId, documentId, input.expectedRevisionId);
      const updated = { ...document, archivedAt, archivedBy, updatedAt: mutation.timestamp }; this.insertEvent(updated, archived ? "ARCHIVE" : "RESTORE", mutation, document.path); return { document: updated, revision };
    });
  }
  archiveWorkspaceDocument(documentId: string, input: { expectedRevisionId: string }, mutation: WorkspaceMutation) { return Promise.resolve(this.setArchived(documentId, input, mutation, true)); }
  restoreWorkspaceDocument(documentId: string, input: { expectedRevisionId: string }, mutation: WorkspaceMutation) { return Promise.resolve(this.setArchived(documentId, input, mutation, false)); }

  async getWorkspaceHistory(documentId: string): Promise<WorkspaceDocumentHistory | undefined> {
    const view = await this.getWorkspaceDocument(documentId); if (!view) return undefined;
    const revisions = (this.database.prepare("SELECT * FROM workspace_revisions WHERE room_id=? AND document_id=? ORDER BY revision").all(this.roomId, documentId) as Row[]).map((row) => this.revisionFrom(row));
    const events = (this.database.prepare("SELECT * FROM workspace_audit_events WHERE room_id=? AND document_id=? ORDER BY occurred_at,id").all(this.roomId, documentId) as Row[]).map(eventFrom);
    return { document: view.document, revisions, events };
  }

  private exportSync(): WorkspaceExport {
    const documents = (this.database.prepare("SELECT * FROM workspace_documents WHERE room_id=? ORDER BY id").all(this.roomId) as Row[]).map(documentFrom);
    const revisions = (this.database.prepare("SELECT * FROM workspace_revisions WHERE room_id=? ORDER BY document_id,revision").all(this.roomId) as Row[]).map((row) => this.revisionFrom(row));
    const auditEvents = (this.database.prepare("SELECT * FROM workspace_audit_events WHERE room_id=? ORDER BY occurred_at,id").all(this.roomId) as Row[]).map(eventFrom);
    return { schemaVersion: 1, roomId: this.roomId, quotas: this.quotas(), documents, revisions, auditEvents };
  }
  async exportWorkspace() { return this.exportSync(); }

  /** Atomic, retry-safe preservation path used only by the legacy JSON importer. */
  importWorkspace(snapshot: WorkspaceExport): { imported: boolean; documents: number; revisions: number } {
    if (snapshot.schemaVersion !== 1 || snapshot.roomId !== this.roomId) throw new WorkspaceRepositoryError("INVALID_WORKSPACE_INPUT", "Workspace import room identity does not match the target repository.");
    return this.transaction(() => {
      const existingCount = Number((this.database.prepare("SELECT count(*) count FROM workspace_documents WHERE room_id=?").get(this.roomId) as Row).count);
      if (existingCount) {
        if (JSON.stringify(canonicalExport(this.exportSync())) === JSON.stringify(canonicalExport(snapshot))) return { imported: false, documents: snapshot.documents.length, revisions: snapshot.revisions.length };
        throw new WorkspaceRepositoryError("IMPORT_COLLISION", "The target room already contains different workspace documents.", { roomId: this.roomId });
      }
      this.database.prepare("UPDATE workspace_quotas SET document_count=?,content_size_bytes=?,revision_count=?,aggregate_room_bytes=? WHERE room_id=?").run(snapshot.quotas.documentCount, snapshot.quotas.contentSizeBytes, snapshot.quotas.revisionCount, snapshot.quotas.aggregateRoomBytes, this.roomId);
      const docStatement = this.database.prepare("INSERT INTO workspace_documents(room_id,id,virtual_path,current_revision_id,current_revision,created_at,created_by,updated_at,archived_at,archived_by) VALUES (?,?,?,?,?,?,?,?,?,?)");
      for (const document of snapshot.documents) docStatement.run(this.roomId, document.id, document.path, document.currentRevisionId, document.currentRevision, document.createdAt, document.createdBy, document.updatedAt, document.archivedAt, document.archivedBy);
      for (const revision of snapshot.revisions) this.insertRevision({ ...revision, roomId: this.roomId, attachments: revision.attachments.map((attachment) => ({ ...attachment, roomId: this.roomId })) });
      const eventStatement = this.database.prepare(`INSERT INTO workspace_audit_events(room_id,id,document_id,participant_id,occurred_at,operation,resulting_revision_id,resulting_revision,previous_path,virtual_path)
        VALUES (?,?,?,?,?,?,?,?,?,?)`);
      for (const event of snapshot.auditEvents) eventStatement.run(this.roomId, event.id, event.documentId, event.participantId, event.timestamp, event.operation, event.resultingRevisionId, event.resultingRevision, event.previousPath, event.path);
      return { imported: true, documents: snapshot.documents.length, revisions: snapshot.revisions.length };
    });
  }
}
