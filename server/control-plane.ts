import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type express from "express";

const scrypt = promisify(scryptCallback);
export const CONTROL_SESSION_COOKIE = "amfaa_control_session";
export const CONTROL_CAPABILITIES = ["PROVIDER_VIEW", "PROVIDER_CONFIGURE", "MODEL_SELECT", "ROSTER_MANAGE"] as const;
export type ControlCapability = (typeof CONTROL_CAPABILITIES)[number];
export type ControlRole = "OWNER" | "ADMIN" | "MEMBER";

interface PrincipalRecord {
  id: string;
  username: string;
  passwordSalt: string;
  passwordHash: string;
  role: ControlRole;
  capabilities: ControlCapability[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ControlAuditEvent {
  readonly id: string;
  readonly at: string;
  readonly actorPrincipalId: string | null;
  readonly action: "OWNER_BOOTSTRAPPED" | "OWNER_TRANSFERRED" | "OWNER_RECOVERED" | "PRINCIPAL_CREATED" | "GRANTS_CHANGED" | "SESSION_REVOKED" | "PROVIDER_SETUP_INITIATED" | "PROVIDER_SETUP_COMPLETED" | "PROVIDER_SETUP_FAILED" | "MODEL_SELECTION_CHANGED" | "CREDENTIAL_REVOCATION_SIGNAL";
  readonly targetId?: string;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

interface ControlState {
  schemaVersion: 1;
  ownerId: string;
  principals: Record<string, PrincipalRecord>;
  audit: ControlAuditEvent[];
}

interface ControlSession { principalId: string; principalRevision: number; csrfToken: string; expiresAt: number; }

const ALL_CAPABILITIES = [...CONTROL_CAPABILITIES];
const ADMIN_DEFAULTS: ControlCapability[] = ["PROVIDER_VIEW", "PROVIDER_CONFIGURE", "MODEL_SELECT", "ROSTER_MANAGE"];
const SESSION_TTL_MS = 8 * 60 * 60_000;
const AUDIT_LIMIT = 5_000;

function validUsername(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{2,47}$/.test(value); }
function validPassword(value: unknown): value is string { return typeof value === "string" && value.length >= 12 && value.length <= 256; }
function safeEqual(left: string, right: string) { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
async function passwordHash(password: string, salt: string) { return (await scrypt(password, salt, 64) as Buffer).toString("hex"); }
function publicPrincipal(principal: PrincipalRecord) { return { id: principal.id, username: principal.username, role: principal.role, capabilities: effectiveCapabilities(principal), revision: principal.revision, createdAt: principal.createdAt, updatedAt: principal.updatedAt }; }
function effectiveCapabilities(principal: PrincipalRecord): readonly ControlCapability[] { return principal.role === "OWNER" ? ALL_CAPABILITIES : principal.role === "ADMIN" ? [...new Set([...ADMIN_DEFAULTS, ...principal.capabilities])] : principal.capabilities; }
function parseCookie(header: string | undefined, name: string) { const encoded = header?.split(";").map((part) => part.trim().split("=")).find(([candidate]) => candidate === name)?.[1]; if (!encoded) return undefined; try { return decodeURIComponent(encoded); } catch { return undefined; } }
function redactedMetadata(input: Record<string, unknown> = {}) {
  const allowed = new Set(["runtime", "status", "role", "capabilityCount", "reason", "previousRevision", "nextRevision", "mode"]);
  return Object.fromEntries(Object.entries(input).flatMap(([key, value]) => allowed.has(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) ? [[key, typeof value === "string" ? value.slice(0, 200) : value]] : []));
}

export class ControlPlaneStore {
  private state?: ControlState;
  private readonly sessions = new Map<string, ControlSession>();
  private mutation: Promise<unknown> = Promise.resolve();

  private constructor(readonly statePath: string, private readonly bootstrapSecret?: string) {}

  static async open(dataDirectory: string, bootstrapSecret = process.env.ALL_MY_FRIENDS_ARE_AGENTS_OWNER_BOOTSTRAP_SECRET?.trim()) {
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    const store = new ControlPlaneStore(path.join(dataDirectory, "control-plane.json"), bootstrapSecret);
    store.state = await readFile(store.statePath, "utf8").then((value) => JSON.parse(value) as ControlState).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (store.state) {
      store.validateState(store.state);
      const hadLegacyWriteGrant = Object.values(store.state.principals).some((principal) => principal.capabilities.some((capability) => (capability as string) === "WRITE_GRANT"));
      if (hadLegacyWriteGrant) {
        for (const principal of Object.values(store.state.principals)) principal.capabilities = principal.capabilities.filter((capability) => (capability as string) !== "WRITE_GRANT");
        await store.save();
      }
    }
    return store;
  }

  status() { return { claimed: Boolean(this.state), bootstrapConfigured: Boolean(this.bootstrapSecret), principalCount: this.state ? Object.keys(this.state.principals).length : 0 }; }

  async bootstrap(secret: unknown, username: unknown, password: unknown) {
    if (!this.bootstrapSecret || typeof secret !== "string" || !safeEqual(secret, this.bootstrapSecret)) throw new ControlError(403, "Local operator bootstrap proof is invalid or unavailable.");
    if (!validUsername(username) || !validPassword(password)) throw new ControlError(400, "A 3-48 character username and 12-256 character password are required.");
    const ownerUsername = username; const ownerPassword = password;
    return this.serial(async () => {
      if (this.state) throw new ControlError(409, "The server owner has already been claimed.");
      const lock = await open(`${this.statePath}.bootstrap-claimed`, "wx", 0o600).catch((error: NodeJS.ErrnoException) => { if (error.code === "EEXIST") throw new ControlError(409, "The server owner has already been claimed."); throw error; });
      await lock.close();
      const now = new Date().toISOString(); const id = randomUUID(); const salt = randomBytes(24).toString("hex");
      const principal: PrincipalRecord = { id, username: ownerUsername, passwordSalt: salt, passwordHash: await passwordHash(ownerPassword, salt), role: "OWNER", capabilities: [], revision: 1, createdAt: now, updatedAt: now };
      this.state = { schemaVersion: 1, ownerId: id, principals: { [id]: principal }, audit: [] };
      this.appendAudit(id, "OWNER_BOOTSTRAPPED", id, { role: "OWNER" });
      await this.save();
      return publicPrincipal(principal);
    });
  }

  async authenticate(username: unknown, password: unknown) {
    if (!validUsername(username) || typeof password !== "string" || !this.state) return undefined;
    const principal = Object.values(this.state.principals).find((candidate) => candidate.username.toLocaleLowerCase() === username.toLocaleLowerCase());
    if (!principal) { await passwordHash(password, randomBytes(24).toString("hex")); return undefined; }
    const actual = await passwordHash(password, principal.passwordSalt);
    if (!safeEqual(actual, principal.passwordHash)) return undefined;
    return this.issueSession(principal);
  }

  issueSession(principal: PrincipalRecord) { const token = randomBytes(32).toString("base64url"); const csrfToken = randomBytes(24).toString("base64url"); this.sessions.set(token, { principalId: principal.id, principalRevision: principal.revision, csrfToken, expiresAt: Date.now() + SESSION_TTL_MS }); return { token, csrfToken, principal: publicPrincipal(principal) }; }

  session(request: express.Request) {
    const token = parseCookie(request.header("cookie"), CONTROL_SESSION_COOKIE); const session = token ? this.sessions.get(token) : undefined;
    if (!token || !session || session.expiresAt <= Date.now() || !this.state) { if (token) this.sessions.delete(token); return undefined; }
    const principal = this.state.principals[session.principalId];
    if (!principal || principal.revision !== session.principalRevision) { this.sessions.delete(token); return undefined; }
    return { token, csrfToken: session.csrfToken, principal, publicPrincipal: publicPrincipal(principal) };
  }

  require(request: express.Request, capability?: ControlCapability, csrf = false) {
    const session = this.session(request);
    if (!session) throw new ControlError(401, "Authenticate with the server control plane first.");
    if (csrf && request.header("x-amfaa-csrf") !== session.csrfToken) throw new ControlError(403, "A valid control-plane CSRF token is required.");
    if (capability && !effectiveCapabilities(session.principal).includes(capability)) throw new ControlError(403, `The ${capability} capability is required.`);
    return session;
  }

  logout(request: express.Request) { const token = parseCookie(request.header("cookie"), CONTROL_SESSION_COOKIE); if (token) this.sessions.delete(token); }
  principals(actor: PrincipalRecord) { if (actor.role !== "OWNER" && actor.role !== "ADMIN") throw new ControlError(403, "Administrative access is required."); return Object.values(this.state?.principals || {}).map(publicPrincipal); }

  async createPrincipal(actor: PrincipalRecord, input: { username?: unknown; password?: unknown; role?: unknown; capabilities?: unknown }) {
    if (actor.role !== "OWNER") throw new ControlError(403, "Only the owner can create durable control-plane identities.");
    if (!validUsername(input.username) || !validPassword(input.password) || !validRole(input.role) || input.role === "OWNER") throw new ControlError(400, "Valid member/admin identity fields are required.");
    const capabilities = validCapabilities(input.capabilities);
    if (!capabilities) throw new ControlError(400, "Capabilities are invalid.");
    const username = input.username; const password = input.password; const role = input.role;
    return this.serial(async () => { if (!this.state) throw new ControlError(409, "Owner bootstrap is required."); if (Object.values(this.state.principals).some((candidate) => candidate.username.toLocaleLowerCase() === username.toLocaleLowerCase())) throw new ControlError(409, "That control-plane username already exists."); const now = new Date().toISOString(); const id = randomUUID(); const salt = randomBytes(24).toString("hex"); const principal: PrincipalRecord = { id, username, passwordSalt: salt, passwordHash: await passwordHash(password, salt), role, capabilities, revision: 1, createdAt: now, updatedAt: now }; this.state.principals[id] = principal; this.appendAudit(actor.id, "PRINCIPAL_CREATED", id, { role: principal.role, capabilityCount: capabilities.length }); await this.save(); return publicPrincipal(principal); });
  }

  async updateGrants(actor: PrincipalRecord, targetId: string, input: { role?: unknown; capabilities?: unknown; expectedRevision?: unknown }) {
    if (actor.role !== "OWNER") throw new ControlError(403, "Only the owner can change administrative grants.");
    if (!validRole(input.role) || input.role === "OWNER" || !Number.isSafeInteger(input.expectedRevision)) throw new ControlError(400, "A non-owner role and expected revision are required.");
    const capabilities = validCapabilities(input.capabilities); if (!capabilities) throw new ControlError(400, "Capabilities are invalid.");
    const role = input.role; const expectedRevision = Number(input.expectedRevision);
    return this.serial(async () => { const target = this.state?.principals[targetId]; if (!target) throw new ControlError(404, "Control-plane identity not found."); if (target.role === "OWNER") throw new ControlError(403, "Owner transfer requires a server-local operator action."); if (target.revision !== expectedRevision) throw new ControlError(409, "The identity grants changed; reload before retrying."); const previousRevision = target.revision; target.role = role; target.capabilities = capabilities; target.revision += 1; target.updatedAt = new Date().toISOString(); this.revokePrincipalSessions(target.id); this.appendAudit(actor.id, "GRANTS_CHANGED", target.id, { role: target.role, capabilityCount: capabilities.length, previousRevision, nextRevision: target.revision }); await this.save(); return publicPrincipal(target); });
  }

  async audit(actor: PrincipalRecord) { if (actor.role !== "OWNER" && actor.role !== "ADMIN") throw new ControlError(403, "Administrative access is required."); return structuredClone(this.state?.audit || []); }
  async recordAudit(actorPrincipalId: string, action: ControlAuditEvent["action"], targetId?: string, metadata?: Record<string, unknown>) { return this.serial(async () => { this.appendAudit(actorPrincipalId, action, targetId, metadata); await this.save(); }); }

  async transferOwnerLocal(secret: string, targetUsername: string) {
    this.assertLocalOperatorProof(secret);
    if (!validUsername(targetUsername)) throw new ControlError(400, "A valid target username is required.");
    return this.serial(async () => { if (!this.state) throw new ControlError(409, "Owner bootstrap is required."); const current = this.state.principals[this.state.ownerId]; const target = Object.values(this.state.principals).find((principal) => principal.username.toLocaleLowerCase() === targetUsername.toLocaleLowerCase()); if (!target) throw new ControlError(404, "Target identity not found."); if (target.id === current.id) return publicPrincipal(current); current.role = "ADMIN"; current.revision += 1; current.updatedAt = new Date().toISOString(); target.role = "OWNER"; target.revision += 1; target.updatedAt = current.updatedAt; this.state.ownerId = target.id; this.revokePrincipalSessions(current.id); this.revokePrincipalSessions(target.id); this.appendAudit(null, "OWNER_TRANSFERRED", target.id, { previousRevision: current.revision - 1, nextRevision: target.revision }); await this.save(); return publicPrincipal(target); });
  }

  async recoverOwnerLocal(secret: string, newPassword: string) {
    this.assertLocalOperatorProof(secret); if (!validPassword(newPassword)) throw new ControlError(400, "A 12-256 character recovery password is required.");
    return this.serial(async () => { if (!this.state) throw new ControlError(409, "Owner bootstrap is required."); const owner = this.state.principals[this.state.ownerId]; owner.passwordSalt = randomBytes(24).toString("hex"); owner.passwordHash = await passwordHash(newPassword, owner.passwordSalt); owner.revision += 1; owner.updatedAt = new Date().toISOString(); this.revokePrincipalSessions(owner.id); this.appendAudit(null, "OWNER_RECOVERED", owner.id, { nextRevision: owner.revision }); await this.save(); return publicPrincipal(owner); });
  }

  private revokePrincipalSessions(principalId: string) { for (const [token, session] of this.sessions) if (session.principalId === principalId) this.sessions.delete(token); }
  private appendAudit(actorPrincipalId: string | null, action: ControlAuditEvent["action"], targetId?: string, metadata?: Record<string, unknown>) { if (!this.state) return; this.state.audit.push({ id: randomUUID(), at: new Date().toISOString(), actorPrincipalId, action, ...(targetId ? { targetId } : {}), metadata: redactedMetadata(metadata) }); if (this.state.audit.length > AUDIT_LIMIT) this.state.audit.splice(0, this.state.audit.length - AUDIT_LIMIT); }
  private async save() { if (!this.state) return; const temporary = `${this.statePath}.${randomUUID()}.tmp`; await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 }); await chmod(temporary, 0o600); await rename(temporary, this.statePath); await chmod(this.statePath, 0o600); }
  private serial<T>(operation: () => Promise<T>) { const result = this.mutation.then(operation, operation); this.mutation = result.then(() => undefined, () => undefined); return result; }
  private validateState(state: ControlState) { if (state.schemaVersion !== 1 || !state.ownerId || state.principals[state.ownerId]?.role !== "OWNER" || Object.values(state.principals).filter(({ role }) => role === "OWNER").length !== 1) throw new Error("Control-plane state is invalid."); }
  private assertLocalOperatorProof(secret: string) { if (!this.bootstrapSecret || !safeEqual(secret, this.bootstrapSecret)) throw new ControlError(403, "Local operator proof is invalid or unavailable."); }
}

function validRole(value: unknown): value is ControlRole { return value === "OWNER" || value === "ADMIN" || value === "MEMBER"; }
function validCapabilities(value: unknown): ControlCapability[] | undefined { if (!Array.isArray(value) || value.some((candidate) => !CONTROL_CAPABILITIES.includes(candidate as ControlCapability))) return undefined; return [...new Set(value as ControlCapability[])]; }

export class ControlError extends Error { constructor(readonly status: number, message: string) { super(message); this.name = "ControlError"; } }
export function controlRoute(operation: (request: express.Request, response: express.Response) => Promise<unknown> | unknown) { return async (request: express.Request, response: express.Response) => { try { await operation(request, response); } catch (error) { if (error instanceof ControlError) response.status(error.status).json({ error: error.message }); else { console.error("Control-plane request failed", error); response.status(500).json({ error: "The control-plane request failed." }); } } }; }
export function setControlSession(response: express.Response, token: string) { response.setHeader("Set-Cookie", `${CONTROL_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`); }
export function clearControlSession(response: express.Response) { response.setHeader("Set-Cookie", `${CONTROL_SESSION_COOKIE}=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0`); }
