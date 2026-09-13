import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { agentProcessEnvironment } from "../server/agent-runner.ts";
import { connectOpenRouter, exchangeOpenRouterCode, readSetupSecret, withSetupRuntime } from "./setup-auth.mjs";

describe("setup credentials", () => {
  it("masks input and restores terminal state after Enter", async () => {
    const input = new PassThrough(); input.isTTY = true; input.isRaw = false;
    input.setRawMode = vi.fn(value => { input.isRaw = value; });
    let output = "";
    const result = readSetupSecret({ input, output: { write: value => { output += value; } } });
    input.write("fictional-secret\r");
    expect(await result).toBe("fictional-secret");
    expect(output).not.toContain("fictional-secret");
    expect(input.isRaw).toBe(false);
    expect(input.listenerCount("keypress")).toBe(0);
  });
  it.each(["\x1b", "\x03", "\x04"])("restores masked input on cancellation", async text => {
    const input = new PassThrough(); input.isTTY = true; input.setRawMode = vi.fn();
    const result = readSetupSecret({ input, output: { write() {} } });
    const assertion = expect(result).rejects.toThrow("cancelled");
    input.write(text); await assertion;
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
  });
  it("exchanges a one-time code using S256 without opening a local browser", async () => {
    let url;
    const key = await connectOpenRouter({ headless: true, write: value => { url = value.match(/https:\/\/openrouter[^\s]+/)[0]; },
      readSecret: async () => "fictional-code", openBrowser: () => { throw new Error("Must not open"); },
      fetchImpl: async (target, options) => {
        const body = JSON.parse(options.body);
        expect(target).toBe("https://openrouter.ai/api/v1/auth/keys");
        expect(body.code).toBe("fictional-code");
        expect(new URL(url).searchParams.get("code_challenge")).toBe(createHash("sha256").update(body.code_verifier).digest("base64url"));
        expect(new URL(url).searchParams.has("callback_url")).toBe(false);
        return Response.json({ key: "fictional-key" });
      } });
    expect(key).toBe("fictional-key");
  });
  it("accepts only the bound loopback callback and exchanges it once", async () => {
    let callback;
    const exchange = vi.fn(async () => Response.json({ key: "fictional-key" }));
    const key = await connectOpenRouter({ write() {}, fetchImpl: exchange,
      openBrowser: async url => {
        callback = new URL(url).searchParams.get("callback_url");
        const wrong = new URL(callback); wrong.pathname = "/wrong";
        expect((await fetch(wrong)).status).toBe(404);
        const good = new URL(callback); good.searchParams.set("code", "fictional-code");
        expect((await fetch(good)).status).toBe(200);
        return true;
      } });
    expect(key).toBe("fictional-key"); expect(exchange).toHaveBeenCalledOnce();
    await expect(fetch(callback)).rejects.toThrow();
  });
  it("closes the callback on timeout", async () => {
    let callback;
    await expect(connectOpenRouter({ write() {}, timeoutMs: 30, openBrowser: async url => {
      callback = new URL(url).searchParams.get("callback_url"); return false;
    } })).rejects.toThrow("timed out");
    await expect(fetch(callback)).rejects.toThrow();
  });
  it("does not leak response bodies or transport errors", async () => {
    await expect(exchangeOpenRouterCode("private", "verifier", { fetchImpl: async () => { throw new Error("private-response"); } })).rejects.toThrow("The connection could not finish");
    await expect(exchangeOpenRouterCode("private", "verifier", { fetchImpl: async () => Response.json({ key: "" }) })).rejects.toThrow("The connection could not finish");
  });
  it.each([false, true])("detects reusable configuration with the room environment (persistent=%s)", async persistent => {
    const script = `const http=require('node:http');const s=http.createServer((q,r)=>{r.setHeader('Content-Type','application/json');r.end(JSON.stringify({connected:(process.env.OPENROUTER_API_KEY || ${persistent})?['openrouter']:[]}));});s.listen(0,'127.0.0.1',()=>console.log('opencode server listening on http://127.0.0.1:'+s.address().port));`;
    const environment = agentProcessEnvironment({ OPENROUTER_API_KEY: "fictional-key", XDG_CONFIG_HOME: "/fixture/config" });
    const configured = await withSetupRuntime("fixture", process.cwd(), client => client.configured(), {
      environment,
      spawnImpl: (_command, _args, options) => {
        expect(options.env.OPENROUTER_API_KEY).toBeUndefined();
        expect(options.env.XDG_CONFIG_HOME).toBe("/fixture/config");
        return spawn(process.execPath, ["-e", script], options);
      },
    });
    expect(configured).toBe(persistent);
  });
  it("uses an authenticated runtime API and shuts down the child", async () => {
    let child;
    const script = `const http=require('node:http');const s=http.createServer((q,r)=>{if(q.headers.authorization!=='Basic '+Buffer.from('amfaa:'+process.env.OPENCODE_SERVER_PASSWORD).toString('base64')){r.writeHead(401);r.end();return;}let body='';q.on('data',x=>body+=x);q.on('end',()=>{r.setHeader('Content-Type','application/json');if(q.url==='/provider')r.end(JSON.stringify({connected:['openrouter']}));else if(q.url==='/auth/openrouter'&&q.method==='PUT')r.end(JSON.stringify(JSON.parse(body).key==='fictional-key'));else{r.writeHead(404);r.end();}})});s.listen(0,'127.0.0.1',()=>console.log('opencode server listening on http://127.0.0.1:'+s.address().port));`;
    const result = await withSetupRuntime("fixture", process.cwd(), async client => {
      expect(await client.configured()).toBe(true); await client.save("fictional-key"); return "done";
    }, { spawnImpl: (_command, args, options) => {
      expect(args).toEqual(["serve", "--hostname=127.0.0.1", "--port=0"]);
      child = spawn(process.execPath, ["-e", script], options); return child;
    } });
    expect(result).toBe("done"); expect(child.signalCode).toBe("SIGTERM");
  });
});
