import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AssignmentGitBroker, claimsFor, newBrokerRequestId, type AssignmentGitClaims, type AssignmentGitRequest } from "./git-security-boundary.js";
import type { AssignmentRecord } from "./assignment-record.js";

interface ShimRequest { readonly token?: string; readonly args?: readonly string[]; readonly health?: boolean }

export class AssignmentGitBrokerServer {
  private server?: Server;
  private claims: AssignmentGitClaims;
  readonly token = randomBytes(32).toString("hex");
  shimDigest = "";

  constructor(
    private readonly broker: AssignmentGitBroker,
    assignment: AssignmentRecord,
    readonly socketPath: string,
    readonly shimDirectory: string,
  ) { this.claims = claimsFor(assignment); }

  async start() {
    if (this.server) throw new Error("Assignment Git broker is already running");
    await mkdir(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    await mkdir(this.shimDirectory, { recursive: true, mode: 0o700 });
    await rm(this.socketPath, { force: true });
    await this.writeShim();
    const server = createServer((socket) => this.handle(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => { server.off("error", reject); resolve(); });
    });
    await chmod(this.socketPath, 0o600);
    this.server = server;
    return this;
  }

  async close() {
    const server = this.server; this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(this.socketPath, { force: true });
  }

  private handle(socket: Socket) {
    let input = "";
    let rejected = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      if (rejected) return;
      input += chunk;
      if (input.length > 64 * 1024 && !rejected) {
        rejected = true;
        void this.rejectIngress(socket, "oversized", "Broker request exceeded limit");
        return;
      }
      const newline = input.indexOf("\n");
      if (newline >= 0) void this.respond(socket, input.slice(0, newline));
    });
    socket.on("error", () => undefined);
  }

  private async respond(socket: Socket, line: string) {
    try {
      const parsed = JSON.parse(line) as ShimRequest;
      if (parsed.token !== this.token) {
        await this.rejectIngress(socket, "invalid-auth", "Git broker client identity is invalid");
        return;
      }
      if (parsed.health === true) {
        const result = await this.broker.execute({ requestId: newBrokerRequestId(), claims: this.claims, operation: "status" });
        if (result.kind !== "ok") { socket.end(`${JSON.stringify(result)}\n`); return; }
        this.claims = result.claims;
        socket.end(`${JSON.stringify({ kind: "health", assignmentId: this.claims.assignmentId, boundaryRevision: "assignment-git-broker/v1" })}\n`);
        return;
      }
      if (!Array.isArray(parsed.args) || !parsed.args.every((arg) => typeof arg === "string")) {
        await this.rejectIngress(socket, "malformed", "Git broker request arguments are invalid");
        return;
      }
      let request: AssignmentGitRequest;
      try {
        request = parseGitArguments(this.claims, parsed.args);
      } catch {
        // Route prohibited command/option attempts through the broker as an
        // unknown operation so their rejection is recorded in the audit chain.
        request = { requestId: newBrokerRequestId(), claims: this.claims, operation: "__prohibited__" as BrokeredNever };
      }
      const result = await this.broker.execute(request);
      if (result.kind === "ok") this.claims = result.claims;
      socket.end(`${JSON.stringify(result)}\n`);
    } catch (error) {
      await this.rejectIngress(socket, "malformed", error instanceof Error ? error.message : "Invalid broker request");
    }
  }

  private async rejectIngress(socket: Socket, operation: string, reason: string) {
    await this.broker.recordIngressRejection({ requestId: newBrokerRequestId(), claims: this.claims, operation, reason }).catch(() => undefined);
    socket.end(`${JSON.stringify({ kind: "rejected", reason })}\n`);
  }

  private async writeShim() {
    const shimPath = path.join(this.shimDirectory, process.platform === "win32" ? "git.cmd" : "git");
    const source = `#!/usr/bin/env node
const net = require("node:net");
const socketPath = process.env.ALL_MY_FRIENDS_ARE_AGENTS_GIT_BROKER_SOCKET;
const token = process.env.ALL_MY_FRIENDS_ARE_AGENTS_GIT_BROKER_TOKEN;
if (!socketPath || !token) { console.error("Assignment Git broker unavailable"); process.exit(126); }
const socket = net.createConnection(socketPath);
let output = "";
socket.setEncoding("utf8");
socket.on("connect", () => socket.write(JSON.stringify({ token, args: process.argv.slice(2) }) + "\\n"));
socket.on("data", chunk => output += chunk);
socket.on("end", () => { try { const result = JSON.parse(output); if (result.kind === "ok") { if (result.output) process.stdout.write(result.output + "\\n"); process.exit(0); } console.error(result.reason || "Git broker rejected request"); process.exit(126); } catch { console.error("Invalid Git broker response"); process.exit(126); } });
socket.on("error", error => { console.error("Assignment Git broker unavailable: " + error.message); process.exit(126); });
`;
    await writeFile(shimPath, source, { mode: 0o700 });
    await chmod(shimPath, 0o700);
    this.shimDigest = createHash("sha256").update(source).digest("hex");
  }
}

type BrokeredNever = AssignmentGitRequest["operation"];

export function parseGitArguments(claims: AssignmentGitClaims, args: readonly string[]): AssignmentGitRequest {
  const requestId = newBrokerRequestId();
  if (args[0] === "status" && args.slice(1).every((arg) => ["--short", "--porcelain", "--branch", "--untracked-files=normal"].includes(arg))) {
    return { requestId, claims, operation: "status" };
  }
  if (args[0] === "diff" && args.slice(1).every((arg) => ["--", "--no-ext-diff", "--no-renames"].includes(arg))) {
    return { requestId, claims, operation: "diff" };
  }
  if (args[0] === "add") {
    const paths = args[1] === "--" ? args.slice(2) : args.slice(1);
    return { requestId, claims, operation: "stage", paths };
  }
  if (args[0] === "commit" && args.length === 3 && args[1] === "-m") {
    return { requestId, claims, operation: "commit", message: args[2] };
  }
  throw new Error("Git command or option is outside the assignment broker allowlist");
}
