import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { registerRoomHistoryRoutes } from "./room-history-api.js";
import { SqliteRoomRepository } from "./storage/sqlite-room-repository.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("room history API", () => {
  it("authenticates and returns exact verbatim messages after a cursor", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "amfaa-history-api-"));
    temporaryDirectories.push(projectRoot);
    const store = await SqliteRoomRepository.open(projectRoot, path.join(projectRoot, "amfaa.sqlite"));
    const after = store.snapshot().messages.at(-1)!.id;
    const first = await store.addMessage("you", "Exact <text> & punctuation\nsecond line");
    const second = await store.addMessage("codex-sol", "Agent wording stays exact.");
    const app = express();
    registerRoomHistoryRoutes({ app, store, authorize: (request) => request.header("authorization") === "Bearer room-test" });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect((await fetch(`${base}/api/room/history?after=${after}&limit=2`)).status).toBe(401);
      const response = await fetch(`${base}/api/room/history?after=${after}&limit=2`, { headers: { Authorization: "Bearer room-test" } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ messages: [first, second], nextAfter: second.id });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      store.close();
    }
  });
});
