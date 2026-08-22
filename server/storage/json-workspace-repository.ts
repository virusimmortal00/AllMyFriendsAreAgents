import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_WORKSPACE_QUOTAS,
  WorkspaceRepositoryError,
  makeWorkspaceRevision,
  normalizeWorkspacePath,
  validateWorkspaceMutation,
  workspaceRevisionBytes,
  type WorkspaceAuditEvent,
  type WorkspaceContentRevision,
  type WorkspaceDocument,
  type WorkspaceDocumentHistory,
  type WorkspaceDocumentView,
  type WorkspaceExport,
  type WorkspaceMutation,
  type WorkspaceQuotas,
  type WorkspaceRepository,
} from "./workspace-repository.js";

export const WORKSPACE_JSON_FILENAME = "workspace.json";

function emptyState(roomId: string, quotas: WorkspaceQuotas): WorkspaceExport {
  return { schemaVersion: 1, roomId, quotas: { ...quotas }, documents: [], revisions: [], auditEvents: [] };
}

function clone<T>(value: T): T { return structuredClone(value); }

interface MutableWorkspaceState extends Omit<WorkspaceExport, "documents" | "revisions" | "auditEvents"> {
  documents: WorkspaceDocument[];
  revisions: WorkspaceContentRevision[];
  auditEvents: WorkspaceAuditEvent[];
}

export class JsonWorkspaceRepository implements WorkspaceRepository {
  readonly statePath: string;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(private state: MutableWorkspaceState, stateDirectory: string) {
    this.statePath = path.join(stateDirectory, WORKSPACE_JSON_FILENAME);
  }

  static async open(roomId: string, stateDirectory: string, quotas?: WorkspaceQuotas) {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await chmod(stateDirectory, 0o700);
    const statePath = path.join(stateDirectory, WORKSPACE_JSON_FILENAME);
    const state = await readFile(statePath, "utf8").then((value) => JSON.parse(value) as WorkspaceExport).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return emptyState(roomId, quotas ?? DEFAULT_WORKSPACE_QUOTAS);
      throw error;
    });
    if (state.schemaVersion !== 1 || state.roomId !== roomId || !Array.isArray(state.documents)
      || !Array.isArray(state.revisions) || !Array.isArray(state.auditEvents)) {
      throw new WorkspaceRepositoryError("INVALID_WORKSPACE_INPUT", "The persisted workspace JSON is invalid or belongs to another room.");
    }
    const configured = quotas ? { ...state, quotas: { ...quotas } } : state;
    return new JsonWorkspaceRepository(clone(configured) as MutableWorkspaceState, stateDirectory);
  }

  private async settled() { await this.queue; }

  private mutate<T>(operation: (draft: MutableWorkspaceState) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const draft = clone(this.state);
      const result = operation(draft);
      const temporaryPath = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(draft, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.statePath);
      await chmod(this.statePath, 0o600);
      this.state = draft;
      return clone(result);
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private current(state: MutableWorkspaceState, documentId: string) {
    const document = state.documents.find(({ id }) => id === documentId);
    if (!document) throw new WorkspaceRepositoryError("DOCUMENT_NOT_FOUND", `Workspace document ${documentId} does not exist.`, { documentId });
    const revision = state.revisions.find(({ id }) => id === document.currentRevisionId);
    if (!revision) throw new WorkspaceRepositoryError("REVISION_NOT_FOUND", `Current revision ${document.currentRevisionId} does not exist.`);
    return { document, revision };
  }

  private requireCas(document: WorkspaceDocument, expectedRevisionId: string) {
    if (document.currentRevisionId !== expectedRevisionId) {
      throw new WorkspaceRepositoryError("REVISION_CONFLICT", "The workspace document has changed.", {
        expectedRevisionId, actualRevisionId: document.currentRevisionId,
      });
    }
  }

  private requireAvailablePath(state: MutableWorkspaceState, candidate: string, exceptId?: string) {
    if (state.documents.some(({ id, path: storedPath, archivedAt }) => id !== exceptId && !archivedAt && storedPath === candidate)) {
      throw new WorkspaceRepositoryError("PATH_CONFLICT", `An active workspace document already exists at ${candidate}.`, { path: candidate });
    }
  }

  private enforceRevision(state: MutableWorkspaceState, revision: WorkspaceContentRevision, isCreate: boolean) {
    const quotas = state.quotas;
    if (isCreate && state.documents.length + 1 > quotas.documentCount) {
      throw new WorkspaceRepositoryError("QUOTA_DOCUMENT_COUNT", "Workspace document-count quota exceeded.", { limit: quotas.documentCount });
    }
    if (revision.sizeBytes > quotas.contentSizeBytes) {
      throw new WorkspaceRepositoryError("QUOTA_CONTENT_SIZE", "Workspace content-size quota exceeded.", { limit: quotas.contentSizeBytes, actual: revision.sizeBytes });
    }
    const count = state.revisions.filter(({ documentId }) => documentId === revision.documentId).length;
    if (count + 1 > quotas.revisionCount) {
      throw new WorkspaceRepositoryError("QUOTA_REVISION_COUNT", "Workspace revision-count quota exceeded.", { limit: quotas.revisionCount });
    }
    const aggregate = state.revisions.reduce((total, item) => total + workspaceRevisionBytes(item), 0) + workspaceRevisionBytes(revision);
    if (aggregate > quotas.aggregateRoomBytes) {
      throw new WorkspaceRepositoryError("QUOTA_AGGREGATE_ROOM", "Workspace aggregate room quota exceeded.", { limit: quotas.aggregateRoomBytes, actual: aggregate });
    }
  }

  private event(document: WorkspaceDocument, operation: WorkspaceAuditEvent["operation"], mutation: WorkspaceMutation, previousPath: string | null): WorkspaceAuditEvent {
    return {
      id: `evt_${randomUUID()}`, roomId: this.state.roomId, documentId: document.id,
      participantId: mutation.participantId, timestamp: mutation.timestamp, operation,
      resultingRevisionId: document.currentRevisionId, resultingRevision: document.currentRevision,
      previousPath, path: document.path,
    };
  }

  async listWorkspaceDocuments(options: { readonly includeArchived?: boolean } = {}) {
    await this.settled();
    return clone(this.state.documents.filter(({ archivedAt }) => options.includeArchived || !archivedAt).sort((a, b) => a.path.localeCompare(b.path)));
  }

  async getWorkspaceDocument(documentId: string) {
    await this.settled();
    const document = this.state.documents.find(({ id }) => id === documentId);
    if (!document) return undefined;
    const revision = this.state.revisions.find(({ id }) => id === document.currentRevisionId)!;
    return clone({ document, revision });
  }

  async getWorkspaceRevision(documentId: string, revision: number | string) {
    await this.settled();
    return clone(this.state.revisions.find((item) => item.documentId === documentId && (typeof revision === "number" ? item.revision === revision : item.id === revision)));
  }

  createWorkspaceDocument(input: { id?: string; path: string; content: string; attachments?: readonly import("./workspace-repository.js").WorkspaceAttachmentInput[] }, rawMutation: WorkspaceMutation) {
    const mutation = validateWorkspaceMutation(rawMutation);
    return this.mutate((state): WorkspaceDocumentView => {
      const documentId = input.id ?? `doc_${randomUUID()}`;
      if (state.documents.some(({ id }) => id === documentId)) throw new WorkspaceRepositoryError("IMPORT_COLLISION", `Document ID ${documentId} already exists.`, { documentId });
      const virtualPath = normalizeWorkspacePath(input.path);
      this.requireAvailablePath(state, virtualPath);
      const revision = makeWorkspaceRevision({ roomId: state.roomId, documentId, revision: 1, content: input.content, attachments: input.attachments, mutation });
      this.enforceRevision(state, revision, true);
      const document: WorkspaceDocument = {
        id: documentId, roomId: state.roomId, path: virtualPath, currentRevisionId: revision.id, currentRevision: 1,
        createdAt: mutation.timestamp, createdBy: mutation.participantId, updatedAt: mutation.timestamp, archivedAt: null, archivedBy: null,
      };
      state.documents.push(document); state.revisions.push(revision);
      state.auditEvents.push(this.event(document, "CREATE", mutation, null));
      return { document, revision };
    });
  }

  updateWorkspaceDocument(documentId: string, input: { expectedRevisionId: string; content: string; attachments?: readonly import("./workspace-repository.js").WorkspaceAttachmentInput[] }, rawMutation: WorkspaceMutation) {
    const mutation = validateWorkspaceMutation(rawMutation);
    return this.mutate((state): WorkspaceDocumentView => {
      const { document } = this.current(state, documentId); this.requireCas(document, input.expectedRevisionId);
      const revision = makeWorkspaceRevision({ roomId: state.roomId, documentId, revision: document.currentRevision + 1, content: input.content, attachments: input.attachments, mutation });
      this.enforceRevision(state, revision, false);
      const updated = { ...document, currentRevisionId: revision.id, currentRevision: revision.revision, updatedAt: mutation.timestamp };
      state.documents[state.documents.indexOf(document)] = updated; state.revisions.push(revision);
      state.auditEvents.push(this.event(updated, "UPDATE", mutation, document.path));
      return { document: updated, revision };
    });
  }

  renameOrMoveWorkspaceDocument(documentId: string, input: { expectedRevisionId: string; path: string }, rawMutation: WorkspaceMutation) {
    const mutation = validateWorkspaceMutation(rawMutation);
    return this.mutate((state): WorkspaceDocumentView => {
      const { document, revision } = this.current(state, documentId); this.requireCas(document, input.expectedRevisionId);
      const virtualPath = normalizeWorkspacePath(input.path); this.requireAvailablePath(state, virtualPath, documentId);
      const updated = { ...document, path: virtualPath, updatedAt: mutation.timestamp };
      state.documents[state.documents.indexOf(document)] = updated;
      state.auditEvents.push(this.event(updated, "RENAME_OR_MOVE", mutation, document.path));
      return { document: updated, revision };
    });
  }

  private setArchived(documentId: string, input: { expectedRevisionId: string }, rawMutation: WorkspaceMutation, archived: boolean) {
    const mutation = validateWorkspaceMutation(rawMutation);
    return this.mutate((state): WorkspaceDocumentView => {
      const { document, revision } = this.current(state, documentId); this.requireCas(document, input.expectedRevisionId);
      if (!archived) this.requireAvailablePath(state, document.path, documentId);
      const updated = { ...document, updatedAt: mutation.timestamp, archivedAt: archived ? mutation.timestamp : null, archivedBy: archived ? mutation.participantId : null };
      state.documents[state.documents.indexOf(document)] = updated;
      state.auditEvents.push(this.event(updated, archived ? "ARCHIVE" : "RESTORE", mutation, document.path));
      return { document: updated, revision };
    });
  }

  archiveWorkspaceDocument(documentId: string, input: { expectedRevisionId: string }, mutation: WorkspaceMutation) { return this.setArchived(documentId, input, mutation, true); }
  restoreWorkspaceDocument(documentId: string, input: { expectedRevisionId: string }, mutation: WorkspaceMutation) { return this.setArchived(documentId, input, mutation, false); }

  async getWorkspaceHistory(documentId: string): Promise<WorkspaceDocumentHistory | undefined> {
    await this.settled();
    const document = this.state.documents.find(({ id }) => id === documentId); if (!document) return undefined;
    return clone({ document, revisions: this.state.revisions.filter((item) => item.documentId === documentId).sort((a, b) => a.revision - b.revision), events: this.state.auditEvents.filter((item) => item.documentId === documentId).sort((a, b) => a.timestamp.localeCompare(b.timestamp)) });
  }

  async exportWorkspace(): Promise<WorkspaceExport> { await this.settled(); return clone(this.state); }
}
