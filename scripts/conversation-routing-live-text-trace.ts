import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_LOG_BYTES = 32 * 1024 * 1024;
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_EVENTS = 2048;
const MAX_PARTS = 64;
const MAX_TEXT_UNITS = 32 * 1024;
const MAX_GENERATIONS = 32;
export const PRIVATE_TEXT_TRACE_SUBDIRECTORY = "text-boundaries-v1";

/** The parent is the canary's newly created, validated private review directory. */
export async function createPrivateTextTraceDirectory(parent: string) {
  const directory = path.join(parent, PRIVATE_TEXT_TRACE_SUBDIRECTORY);
  await mkdir(directory, { mode: 0o700 });
  await chmod(directory, 0o700);
  return directory;
}

type Row = Record<string, unknown>;
const object = (value: unknown): Row | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : null;
const identifier = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Mirrors completed-snapshot acceptance and replacement in parseOpenCodeOutput. */
export function textPartBoundaryTrace(stdout: string) {
  if (Buffer.byteLength(stdout) > MAX_STDOUT_BYTES) throw new Error("Private text trace exceeds its stdout limit.");
  const lines = stdout.split("\n").filter((line) => line.trim());
  if (lines.length > MAX_EVENTS) throw new Error("Private text trace exceeds its event limit.");
  const keys = new Map<string, number>();
  const messages = new Map<string, number>();
  const parts: Array<{
    messageOrdinal: number | null;
    stepOrdinal: number;
    completionMarker: "explicit-end" | "legacy-absent";
    text: string;
    snapshots: number;
  }> = [];
  let stepOrdinal = 1;
  let unfinished = 0;
  let replacementSnapshots = 0;
  for (const line of lines) {
    let event: Row | null;
    try {
      event = object(JSON.parse(line));
    } catch {
      throw new Error("Private text trace contains malformed protocol data.");
    }
    if (!event) throw new Error("Private text trace contains malformed protocol data.");
    const part = object(event.part);
    if (event.type === "step_finish" && part?.type === "step-finish") stepOrdinal++;
    if (event.type !== "text" || part?.type !== "text") continue;
    if (typeof part.text !== "string") throw new Error("Private text trace contains malformed text data.");
    const time = part.time === undefined ? undefined : object(part.time);
    if (part.time !== undefined && !(typeof time?.end === "number" && Number.isFinite(time.end) && time.end > 0)) {
      unfinished++;
      continue;
    }
    const identity = [part.sessionID ?? event.sessionID, part.messageID, part.id];
    const key = identity.every((value) => identifier(value)) ? JSON.stringify(identity) : null;
    const existing = key === null ? undefined : keys.get(key);
    const messageId = identifier(part.messageID);
    if (messageId && !messages.has(messageId)) messages.set(messageId, messages.size + 1);
    const entry = {
      messageOrdinal: messageId ? messages.get(messageId)! : null,
      stepOrdinal,
      completionMarker: part.time === undefined ? ("legacy-absent" as const) : ("explicit-end" as const),
      text: part.text,
      snapshots: 1,
    };
    if (existing !== undefined) {
      parts[existing] = { ...entry, snapshots: parts[existing]!.snapshots + 1 };
      replacementSnapshots++;
    } else {
      if (parts.length >= MAX_PARTS) throw new Error("Private text trace exceeds its part limit.");
      if (key !== null) keys.set(key, parts.length);
      parts.push(entry);
    }
  }
  const selected = parts.filter((part) => part.text.length > 0);
  const assembled = selected.map((part) => part.text).join("\n\n");
  if (assembled.length > MAX_TEXT_UNITS) throw new Error("Private text trace exceeds its text limit.");
  let offset = 0;
  return {
    schemaVersion: 1 as const,
    unfinishedSnapshotsSkipped: unfinished,
    replacementSnapshots,
    assembledTextLength: assembled.length,
    assembledTextSha256: digest(assembled),
    parts: selected.map((part, index) => {
      if (index > 0) offset += 2;
      const start = offset;
      offset += part.text.length;
      return {
        ordinal: index + 1,
        messageOrdinal: part.messageOrdinal,
        stepOrdinal: part.stepOrdinal,
        completionMarker: part.completionMarker,
        snapshotCount: part.snapshots,
        start,
        end: offset,
        textLength: part.text.length,
        textSha256: digest(part.text),
      };
    }),
  };
}

/** Reads only completed CLI stdout for this run; private protocol IDs never leave this function. */
export async function retainPrivateTextTrace(
  logDirectory: string,
  directory: string,
  caseOrdinal: number,
  triggerOrdinal: number,
  runId: string,
  expectedCompletions: number,
) {
  const names = (await readdir(logDirectory))
    .filter((name) => /^opencode-harness(?:\.[A-Za-z0-9_-]+)?\.jsonl$/.test(name))
    .sort();
  let bytes = 0;
  const rows: Row[] = [];
  for (const name of names) {
    const file = path.join(logDirectory, name);
    bytes += (await stat(file)).size;
    if (bytes > MAX_LOG_BYTES) throw new Error("Private text trace exceeds its log limit.");
    const contents = await readFile(file, "utf8");
    if (!contents.endsWith("\n")) throw new Error("Private text trace has an incomplete log record.");
    for (const line of contents.split("\n")) {
      if (!line) continue;
      let row: Row | null;
      try {
        row = object(JSON.parse(line));
      } catch {
        throw new Error("Private text trace contains malformed log data.");
      }
      if (!row) throw new Error("Private text trace contains malformed log data.");
      if (row.event === "opencode.stdout" && row.generationEvent === "generation.completed" && row.runId === runId)
        rows.push(row);
    }
  }
  if (rows.length > MAX_GENERATIONS) throw new Error("Private text trace exceeds its generation limit.");
  if (rows.length !== expectedCompletions) throw new Error("Private text trace is missing completed CLI output.");
  const generations = rows.map((row, index) => {
    if (typeof row.output !== "string") throw new Error("Private text trace is missing completed stdout.");
    return { ordinal: index + 1, ...textPartBoundaryTrace(row.output) };
  });
  const filename = path.join(directory, `text-boundaries-case-${caseOrdinal}-trigger-${triggerOrdinal}.json`);
  await writeFile(filename, `${JSON.stringify({ schemaVersion: 1, caseOrdinal, triggerOrdinal, generations })}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await chmod(filename, 0o600);
}
