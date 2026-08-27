import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type express from "express";
import type { CommandInput, RoomCommandName } from "../shared/command-domain.js";
import type { ActiveAgentId } from "../shared/participants.js";
import type { CommandRuntime, CommandResponse } from "./command-runtime.js";

const LEASE_LIFETIME_MS = 10 * 60_000;

interface CommandToolLease {
  readonly digest: Buffer;
  readonly agentId: ActiveAgentId;
  readonly displayName: string;
  readonly providerSessionId: string | null;
  readonly allowedCommands: readonly RoomCommandName[];
  readonly expiresAt: number;
  readonly requests: Map<string, Promise<CommandResponse>>;
}

function digest(value: string) { return createHash("sha256").update(value).digest(); }
function fingerprint(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

export class RoomCommandToolBroker {
  private readonly leases = new Map<string, CommandToolLease>();

  constructor(private readonly runtime: CommandRuntime, private readonly now: () => number = Date.now) {}

  issue(input: { agentId: ActiveAgentId; displayName: string; providerSessionId: string | null; allowedCommands: readonly RoomCommandName[] }) {
    this.prune();
    const token = `${randomUUID()}${randomUUID()}`;
    const key = digest(token).toString("hex");
    this.leases.set(key, { digest: digest(token), ...input, allowedCommands: [...input.allowedCommands], expiresAt: this.now() + LEASE_LIFETIME_MS, requests: new Map() });
    return token;
  }

  async execute(token: string, input: { invocation: CommandInput; clientSubmissionId: string }) {
    this.prune();
    const supplied = digest(token);
    const lease = this.leases.get(supplied.toString("hex"));
    if (!lease || lease.digest.length !== supplied.length || !timingSafeEqual(lease.digest, supplied)) return undefined;
    const requestFingerprint = fingerprint(input);
    const replay = lease.requests.get(requestFingerprint);
    if (replay) return replay;
    if (lease.requests.size >= 8) return { kind: "private-error", message: "This room command session has reached its bounded call limit." } as const;
    const command = typeof input.invocation === "object" && input.invocation ? input.invocation.command : undefined;
    if (!command || !lease.allowedCommands.includes(command)) {
      const rejected = Promise.resolve({ kind: "private-error", message: "That command is not available to this participant." } as const);
      lease.requests.set(requestFingerprint, rejected);
      return rejected;
    }
    const result = this.runtime.submit(input.invocation, { kind: "agent", id: lease.agentId, displayName: lease.displayName }, input.clientSubmissionId);
    lease.requests.set(requestFingerprint, result);
    return result;
  }

  private prune() {
    const now = this.now();
    for (const [key, lease] of this.leases) if (lease.expiresAt <= now) this.leases.delete(key);
  }
}

export function registerRoomCommandToolRoute(app: express.Express, broker: RoomCommandToolBroker) {
  app.post("/api/agent-tools/room-command", async (request, response) => {
    const authorization = request.header("authorization") || "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!token) return response.status(404).json({ error: "Not found." });
    const clientSubmissionId = typeof request.body?.clientSubmissionId === "string" ? request.body.clientSubmissionId.trim() : "";
    const result = await broker.execute(token, { invocation: request.body?.invocation as CommandInput, clientSubmissionId });
    if (!result) return response.status(404).json({ error: "Not found." });
    return response.set("Cache-Control", "no-store").json(result);
  });
}
