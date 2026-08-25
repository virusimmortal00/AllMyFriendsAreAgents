import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type express from "express";
import { CONTROL_SESSION_COOKIE, ControlError, ControlPlaneStore } from "./control-plane.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));
async function fixture(secret = "local-bootstrap-secret-with-32-characters") { const directory = await mkdtemp(path.join(os.tmpdir(), "amfaa-control-")); directories.push(directory); return { directory, store: await ControlPlaneStore.open(directory, secret), secret }; }
function request(token?: string, csrf?: string) { return { method: "POST", header(name: string) { if (name.toLowerCase() === "cookie" && token) return `${CONTROL_SESSION_COOKIE}=${token}`; if (name.toLowerCase() === "x-amfaa-csrf") return csrf; return undefined; } } as express.Request; }

describe("durable control plane", () => {
  it("allows exactly one race-safe owner bootstrap and rejects replay across restart", async () => {
    const { directory, store, secret } = await fixture();
    const second = await ControlPlaneStore.open(directory, secret);
    const results = await Promise.allSettled([
      store.bootstrap(secret, "owner-one", "correct horse battery staple"),
      second.bootstrap(secret, "owner-two", "another durable password"),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const reopened = await ControlPlaneStore.open(directory, secret);
    await expect(reopened.bootstrap(secret, "replay", "this password is long enough")).rejects.toMatchObject({ status: 409 });
    expect(reopened.status()).toMatchObject({ claimed: true, principalCount: 1 });
  });

  it("persists credentials separately, rotates opaque sessions, and enforces CSRF", async () => {
    const { directory, store, secret } = await fixture();
    await store.bootstrap(secret, "owner", "correct horse battery staple");
    const authenticated = await store.authenticate("owner", "correct horse battery staple");
    expect(authenticated?.token).not.toContain("owner");
    expect(authenticated?.token).not.toBe("attacker-supplied-session");
    expect(() => store.require(request(authenticated?.token), "ROSTER_MANAGE", true)).toThrow(ControlError);
    expect(store.require(request(authenticated?.token, authenticated?.csrfToken), "ROSTER_MANAGE", true).principal.role).toBe("OWNER");
    const reopened = await ControlPlaneStore.open(directory, secret);
    await expect(reopened.authenticate("owner", "correct horse battery staple")).resolves.toBeDefined();
    expect((await stat(path.join(directory, "control-plane.json"))).mode & 0o777).toBe(0o600);
  });

  it("supports delegated capabilities and invalidates sessions immediately on revocation", async () => {
    const { store, secret } = await fixture();
    await store.bootstrap(secret, "owner", "correct horse battery staple");
    const owner = await store.authenticate("owner", "correct horse battery staple");
    const ownerActor = store.require(request(owner?.token, owner?.csrfToken), undefined, true).principal;
    const member = await store.createPrincipal(ownerActor, { username: "operator", password: "operator password long", role: "MEMBER", capabilities: ["PROVIDER_VIEW", "ROSTER_MANAGE"] });
    const operator = await store.authenticate("operator", "operator password long");
    expect(store.require(request(operator?.token), "ROSTER_MANAGE").principal.id).toBe(member.id);
    expect(() => store.require(request(operator?.token), "WRITE_GRANT")).toThrowError(/WRITE_GRANT/);
    await store.updateGrants(ownerActor, member.id, { role: "MEMBER", capabilities: [], expectedRevision: member.revision });
    expect(() => store.require(request(operator?.token), "ROSTER_MANAGE")).toThrowError(/Authenticate/);
  });

  it("never writes bootstrap proofs, passwords, or arbitrary secret metadata to durable audit", async () => {
    const { directory, store, secret } = await fixture("bootstrap-secret-sentinel-never-persist");
    const password = "password-secret-sentinel-long";
    await store.bootstrap(secret, "owner", password);
    const owner = await store.authenticate("owner", password);
    const actor = store.require(request(owner?.token)).principal;
    await store.recordAudit(actor.id, "PROVIDER_SETUP_FAILED", "opencode", { runtime: "opencode", status: "error", authorizationHeader: "Bearer audit-secret-sentinel", password });
    const contents = await readFile(path.join(directory, "control-plane.json"), "utf8");
    expect(contents).not.toContain(secret);
    expect(contents).not.toContain(password);
    expect(contents).not.toContain("audit-secret-sentinel");
    expect((await store.audit(actor)).at(-1)).toMatchObject({ action: "PROVIDER_SETUP_FAILED", metadata: { runtime: "opencode", status: "error" } });
  });
});
