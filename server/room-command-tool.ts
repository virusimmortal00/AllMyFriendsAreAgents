import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type express from "express";
import type { CommandInput, CommandInvocation, RoomCommandName } from "../shared/command-domain.js";
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
  readonly requests: Map<string, { readonly fingerprint: string; readonly result: Promise<unknown> }>;
}

function digest(value: string) { return createHash("sha256").update(value).digest(); }
function fingerprint(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

export class RoomCommandToolBroker {
  private readonly leases = new Map<string, CommandToolLease>();

  constructor(private readonly runtime: CommandRuntime, private readonly now: () => number = Date.now, private readonly currentProviderSessionId?: (agentId:ActiveAgentId)=>string|null) {}

  issue(input: { agentId: ActiveAgentId; displayName: string; providerSessionId: string | null; allowedCommands: readonly RoomCommandName[] }) {
    this.prune();
    const token = `${randomUUID()}${randomUUID()}`;
    const key = digest(token).toString("hex");
    this.leases.set(key, { digest: digest(token), ...input, allowedCommands: [...input.allowedCommands], expiresAt: this.now() + LEASE_LIFETIME_MS, requests: new Map() });
    return token;
  }

  async execute(token: string, input: { invocation: CommandInput | {command:"polls"}|{command:"poll_vote";pollId:string;optionIndex:number}|{command:"poll_close";pollId:string;expectedRevision:number}|{command:"gh_diagnostic";submissionId:string}; clientSubmissionId: string }) {
    this.prune();
    const supplied = digest(token);
    const lease = this.leases.get(supplied.toString("hex"));
    if (!lease || lease.digest.length !== supplied.length || !timingSafeEqual(lease.digest, supplied)) return undefined;
    if(this.currentProviderSessionId&&this.currentProviderSessionId(lease.agentId)!==lease.providerSessionId){this.leases.delete(supplied.toString("hex"));return undefined;}
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(input.clientSubmissionId)) return { kind: "private-error", message: "A valid command request ID is required." } as const;
    const requestFingerprint = fingerprint(input);
    const replay = lease.requests.get(input.clientSubmissionId);
    if (replay) return replay.fingerprint === requestFingerprint
      ? replay.result
      : { kind: "private-error", message: "That request ID is already bound to a different room command." } as const;
    if (lease.requests.size >= 8) return { kind: "private-error", message: "This room command session has reached its bounded call limit." } as const;
    const operation = typeof input.invocation === "object" && input.invocation ? input.invocation.command : undefined;
    const command = operation==="polls"||operation==="poll_vote"||operation==="poll_close"?"poll":operation==="gh_diagnostic"?"gh":operation;
    if (!command || !lease.allowedCommands.includes(command as RoomCommandName)) {
      const rejected = Promise.resolve({ kind: "private-error", message: "That command is not available to this participant." } as const);
      lease.requests.set(input.clientSubmissionId, { fingerprint: requestFingerprint, result: rejected });
      return rejected;
    }
    const invoker={ kind: "agent" as const, id: lease.agentId, displayName: lease.displayName };
    const special=input.invocation as {command:string;pollId?:string;optionIndex?:number;expectedRevision?:number;submissionId?:string};
    const result = operation==="polls"?this.runtime.listOpenPolls(invoker):operation==="poll_vote"?this.runtime.vote(special.pollId||"",invoker,input.clientSubmissionId,special.optionIndex??-1):operation==="poll_close"?this.runtime.closePoll(special.pollId||"",invoker,input.clientSubmissionId,special.expectedRevision??-1):operation==="gh_diagnostic"?this.runtime.getGhDiagnostic(invoker,special.submissionId||""):this.runtime.submit(input.invocation as CommandInvocation,invoker,input.clientSubmissionId);
    lease.requests.set(input.clientSubmissionId, { fingerprint: requestFingerprint, result });
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
