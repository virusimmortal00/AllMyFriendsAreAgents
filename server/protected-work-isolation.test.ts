import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("keeps redirects manual even when fixture callers request automatic following", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "protected-isolation-"));
  let followed = 0;
  const server = http.createServer((request, response) => {
    if (request.url === "/redirect") { response.writeHead(302, { location: "/target" }); response.end(); }
    else { followed++; response.end("Unexpected redirect target"); }
  });
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/redirect`;
    const code = `const url = process.argv[1]; const a = await fetch(url, { redirect: "follow" }); const b = await fetch(new Request(url, { redirect: "follow" })); console.log(JSON.stringify([a.status, b.status]));`;
    const result = await promisify(execFile)(process.execPath, ["--import", "./server/fixtures/protected-work-isolation.mjs", "--input-type=module", "--eval", code, url], { timeout: 10_000, env: { PATH: process.env.PATH, AMFAA_TEST_DIRECTORY: root } });
    expect(JSON.parse(result.stdout)).toEqual([302, 302]); expect(followed).toBe(0);
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
