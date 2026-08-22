import { createHash, randomUUID } from "node:crypto";

export const DEFAULT_WORKSPACE_QUOTAS: WorkspaceQuotas = {
  documentCount: 1_000,
  contentSizeBytes: 1_048_576,
  revisionCount: 100,
  aggregateRoomBytes: 104_857_600,
};

export interface WorkspaceQuotas {
  readonly documentCount: number;
  readonly contentSizeBytes: number;
  readonly revisionCount: number;
  readonly aggregateRoomBytes: number;
}

export interface WorkspaceMutation {
  readonly participantId: string;
  readonly timestamp: string;
}

export interface WorkspaceAttachmentInput {
  readonly id?: string;
  readonly name: string;
  readonly mediaType: string;
  /** Portable inline bytes. Workspace records never contain host filesystem paths. */
  readonly dataBase64: string;
}

export interface WorkspaceAttachment {
  readonly id: string;
  readonly roomId: string;
  readonly documentId: string;
  readonly revisionId: string;
  readonly name: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly contentHash: string;
  readonly dataBase64: string;
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface WorkspaceContentRevision {
  readonly id: string;
  readonly roomId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly content: string;
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly attachments: readonly WorkspaceAttachment[];
}

export interface WorkspaceDocument {
  readonly id: string;
  readonly roomId: string;
  readonly path: string;
  readonly currentRevisionId: string;
  readonly currentRevision: number;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly archivedBy: string | null;
}

export type WorkspaceOperation = "CREATE" | "UPDATE" | "RENAME_OR_MOVE" | "ARCHIVE" | "RESTORE";

export interface WorkspaceAuditEvent {
  readonly id: string;
  readonly roomId: string;
  readonly documentId: string;
  readonly participantId: string;
  readonly timestamp: string;
  readonly operation: WorkspaceOperation;
  readonly resultingRevisionId: string;
  readonly resultingRevision: number;
  readonly previousPath: string | null;
  readonly path: string;
}

export interface WorkspaceDocumentView {
  readonly document: WorkspaceDocument;
  readonly revision: WorkspaceContentRevision;
}

export interface WorkspaceDocumentHistory {
  readonly document: WorkspaceDocument;
  readonly revisions: readonly WorkspaceContentRevision[];
  readonly events: readonly WorkspaceAuditEvent[];
}

export interface WorkspaceExport {
  readonly schemaVersion: 1;
  readonly roomId: string;
  readonly quotas: WorkspaceQuotas;
  readonly documents: readonly WorkspaceDocument[];
  readonly revisions: readonly WorkspaceContentRevision[];
  readonly auditEvents: readonly WorkspaceAuditEvent[];
}

export type WorkspaceFailureCode =
  | "DOCUMENT_NOT_FOUND"
  | "REVISION_NOT_FOUND"
  | "PATH_CONFLICT"
  | "REVISION_CONFLICT"
  | "QUOTA_DOCUMENT_COUNT"
  | "QUOTA_CONTENT_SIZE"
  | "QUOTA_REVISION_COUNT"
  | "QUOTA_AGGREGATE_ROOM"
  | "INVALID_WORKSPACE_INPUT"
  | "IMPORT_COLLISION";

export class WorkspaceRepositoryError extends Error {
  readonly name = "WorkspaceRepositoryError";
  constructor(
    readonly code: WorkspaceFailureCode,
    message: string,
    readonly details: Readonly<Record<string, string | number | null>> = {},
  ) {
    super(message);
  }
}

export interface WorkspaceRepository {
  listWorkspaceDocuments(options?: { readonly includeArchived?: boolean }): Promise<readonly WorkspaceDocument[]>;
  getWorkspaceDocument(documentId: string): Promise<WorkspaceDocumentView | undefined>;
  getWorkspaceRevision(documentId: string, revision: number | string): Promise<WorkspaceContentRevision | undefined>;
  createWorkspaceDocument(input: {
    readonly id?: string;
    readonly path: string;
    readonly content: string;
    readonly attachments?: readonly WorkspaceAttachmentInput[];
  }, mutation: WorkspaceMutation): Promise<WorkspaceDocumentView>;
  updateWorkspaceDocument(documentId: string, input: {
    readonly expectedRevisionId: string;
    readonly content: string;
    readonly attachments?: readonly WorkspaceAttachmentInput[];
  }, mutation: WorkspaceMutation): Promise<WorkspaceDocumentView>;
  renameOrMoveWorkspaceDocument(documentId: string, input: {
    readonly expectedRevisionId: string;
    readonly path: string;
  }, mutation: WorkspaceMutation): Promise<WorkspaceDocumentView>;
  archiveWorkspaceDocument(documentId: string, input: { readonly expectedRevisionId: string }, mutation: WorkspaceMutation): Promise<WorkspaceDocumentView>;
  restoreWorkspaceDocument(documentId: string, input: { readonly expectedRevisionId: string }, mutation: WorkspaceMutation): Promise<WorkspaceDocumentView>;
  getWorkspaceHistory(documentId: string): Promise<WorkspaceDocumentHistory | undefined>;
  exportWorkspace(): Promise<WorkspaceExport>;
}

export function workspaceHash(bytes: string | Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function workspaceByteLength(content: string) {
  return Buffer.byteLength(content, "utf8");
}

export function normalizeWorkspacePath(value: string) {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
  if (!normalized || normalized.split("/").some((part) => part === "." || part === ".." || !part)) {
    throw new WorkspaceRepositoryError("INVALID_WORKSPACE_INPUT", "Workspace paths must be non-empty, relative virtual paths without dot segments.");
  }
  return normalized;
}

export function validateWorkspaceMutation(mutation: WorkspaceMutation) {
  if (!mutation.participantId.trim() || !Number.isFinite(Date.parse(mutation.timestamp))) {
    throw new WorkspaceRepositoryError("INVALID_WORKSPACE_INPUT", "Participant attribution and an ISO timestamp are required.");
  }
  return { participantId: mutation.participantId.trim(), timestamp: new Date(mutation.timestamp).toISOString() };
}

export function makeWorkspaceRevision(input: {
  roomId: string; documentId: string; revision: number; content: string;
  attachments?: readonly WorkspaceAttachmentInput[]; mutation: WorkspaceMutation; id?: string;
}): WorkspaceContentRevision {
  const contentHash = workspaceHash(input.content);
  const id = input.id ?? `rev_${randomUUID()}`;
  const attachments = (input.attachments ?? []).map((attachment) => {
    let bytes: Buffer;
    try { bytes = Buffer.from(attachment.dataBase64, "base64"); } catch {
      throw new WorkspaceRepositoryError("INVALID_WORKSPACE_INPUT", "Attachment data must be base64 encoded.");
    }
    if (bytes.toString("base64") !== attachment.dataBase64.replace(/\s/g, "")) {
      throw new WorkspaceRepositoryError("INVALID_WORKSPACE_INPUT", "Attachment data must use canonical base64 encoding.");
    }
    return {
      id: attachment.id ?? `att_${randomUUID()}`, roomId: input.roomId, documentId: input.documentId,
      revisionId: id, name: attachment.name.trim(), mediaType: attachment.mediaType.trim(),
      sizeBytes: bytes.byteLength, contentHash: workspaceHash(bytes), dataBase64: attachment.dataBase64,
      createdAt: input.mutation.timestamp, createdBy: input.mutation.participantId,
    };
  });
  if (attachments.some(({ name, mediaType }) => !name || !mediaType) || new Set(attachments.map(({ id: attachmentId }) => attachmentId)).size !== attachments.length) {
    throw new WorkspaceRepositoryError("INVALID_WORKSPACE_INPUT", "Attachments require unique IDs, names, and media types.");
  }
  return {
    id, roomId: input.roomId, documentId: input.documentId, revision: input.revision,
    content: input.content, contentHash, sizeBytes: workspaceByteLength(input.content),
    createdAt: input.mutation.timestamp, createdBy: input.mutation.participantId, attachments,
  };
}

export function workspaceRevisionBytes(revision: WorkspaceContentRevision) {
  return revision.sizeBytes + revision.attachments.reduce((total, attachment) => total + attachment.sizeBytes, 0);
}
