import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { emitKeypressEvents } from "node:readline";

const AUTH_URL = "https://openrouter.ai/auth";
const EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys";
const failure = () => new Error("The connection could not finish. Try again or use an API key.");

// Credentials never enter readline history, command arguments, or diagnostic output.
export function readSetupSecret({ input = process.stdin, output = process.stdout, signal } = {}) {
  if (!input.isTTY || typeof input.setRawMode !== "function") return Promise.reject(new Error("Key entry needs an interactive terminal."));
  return new Promise((resolve, reject) => {
    let value = "", settled = false;
    const wasRaw = input.isRaw, wasPaused = input.isPaused();
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      input.off("keypress", keypress); input.off("end", ended); input.off("error", ended);
      signal?.removeEventListener("abort", ended);
      input.setRawMode(Boolean(wasRaw)); if (wasPaused) input.pause();
      value = ""; output.write("\r\u001b[2K");
      error ? reject(error) : resolve(result);
    };
    const ended = () => finish(new Error("Connection cancelled."));
    const keypress = (text, key = {}) => {
      if (key.name === "escape" || (key.ctrl && ["c", "d"].includes(key.name))) return ended();
      if (key.name === "return" || key.name === "enter") {
        if (value.trim()) finish(undefined, value.trim());
        return;
      }
      if (key.name === "backspace") value = value.slice(0, -1);
      else if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text)) value = (value + text).slice(0, 8192);
      output.write("\r\u001b[2K  " + (value ? "••••••••" : "Paste here (hidden)"));
    };
    emitKeypressEvents(input); input.on("keypress", keypress); input.once("end", ended); input.once("error", ended);
    signal?.addEventListener("abort", ended, { once: true });
    input.setRawMode(true); input.resume(); output.write("  Paste here (hidden)");
    if (signal?.aborted) ended();
  });
}

export async function exchangeOpenRouterCode(code, verifier, { fetchImpl = fetch, signal } = {}) {
  try {
    const response = await fetchImpl(EXCHANGE_URL, { method: "POST", redirect: "error",
      headers: { "Content-Type": "application/json" }, signal: signal || AbortSignal.timeout(30_000),
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }) });
    if (!response.ok) throw failure();
    const data = await response.json();
    if (typeof data.key !== "string" || !data.key.trim() || data.key.length > 8192) throw failure();
    return data.key;
  } catch { throw failure(); }
}

export function openSetupBrowser(url) {
  const command = process.platform === "darwin" ? "/usr/bin/open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: "ignore", shell: false });
    child.once("error", () => resolve(false)); child.once("exit", code => resolve(code === 0));
  });
}

export async function connectOpenRouter({ write, readSecret = readSetupSecret, openBrowser = openSetupBrowser, headless = false, signal, fetchImpl = fetch, timeoutMs = 600_000 } = {}) {
  const verifier = randomBytes(32).toString("base64url");
  const url = new URL(AUTH_URL);
  url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
  url.searchParams.set("code_challenge_method", "S256");
  const deadline = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  if (headless) {
    url.searchParams.set("key_label", "amfaa");
    write(`\nOpen this link in your browser:\n${url}\n\nApprove access, then paste the one-time code here. Esc cancels.\n`);
    const code = await readSecret({ signal: deadline });
    return exchangeOpenRouterCode(code, verifier, { fetchImpl, signal: deadline });
  }
  const route = `/callback/${randomBytes(24).toString("hex")}`;
  let accept, deny;
  const codeResult = new Promise((resolve, reject) => { accept = resolve; deny = reject; });
  // Attach immediately, including while the browser launcher is starting.
  codeResult.catch(() => {});
  let consumed = false;
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store"); response.setHeader("Referrer-Policy", "no-referrer");
    let incoming;
    try { incoming = new URL(request.url || "/", "http://localhost"); }
    catch { response.writeHead(400); response.end(); return; }
    const expectedHost = `127.0.0.1:${server.address().port}`;
    if (request.method !== "GET" || request.headers.host !== expectedHost || incoming.pathname !== route || consumed) {
      response.writeHead(404); response.end(); return;
    }
    const code = incoming.searchParams.get("code");
    if (!code || code.length > 8192 || incoming.searchParams.getAll("code").length !== 1) {
      response.writeHead(400); response.end("Authorization did not finish. Return to the terminal."); deny(failure()); return;
    }
    consumed = true;
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.end("Authorization received. Return to Consolio in your terminal to finish connecting."); accept(code);
  });
  const abort = () => deny(new Error("Connection cancelled or timed out."));
  deadline.addEventListener("abort", abort, { once: true });
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    url.searchParams.set("callback_url", `http://127.0.0.1:${server.address().port}${route}`);
    write(`\nApprove amfaa in your browser. I'll wait here. Ctrl-C cancels.\nIf the browser doesn't open, visit:\n${url}\n`);
    if (deadline.aborted) abort();
    void openBrowser(url.href).catch(() => false);
    return await exchangeOpenRouterCode(await codeResult, verifier, { fetchImpl, signal: deadline });
  } finally {
    deadline.removeEventListener("abort", abort);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}

// Uses the bundled runtime's authenticated loopback API; no parallel auth-file writer.
export async function withSetupRuntime(command, project, action, { environment = process.env, spawnImpl = spawn } = {}) {
  const password = randomBytes(32).toString("base64url");
  const child = spawnImpl(command, ["serve", "--hostname=127.0.0.1", "--port=0"], {
    cwd: project, shell: false, stdio: ["ignore", "pipe", "pipe"],
    env: { ...environment, OPENCODE_SERVER_USERNAME: "amfaa", OPENCODE_SERVER_PASSWORD: password },
  });
  child.stderr.resume();
  const exited = new Promise(resolve => { child.once("exit", resolve); child.once("error", resolve); });
  try {
    const base = await new Promise((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => finish(failure()), 15_000);
      const data = part => {
        buffer = (buffer + part).slice(-4096);
        const match = buffer.match(/opencode server listening on (http:\/\/127\.0\.0\.1:\d+)(?:\r?\n)/);
        if (match) finish(undefined, match[1]);
      };
      const failed = () => finish(failure());
      const finish = (error, url) => {
        clearTimeout(timer); child.stdout.off("data", data); child.off("error", failed); child.off("exit", failed);
        error ? reject(error) : resolve(url);
      };
      child.stdout.on("data", data); child.once("error", failed); child.once("exit", failed);
    });
    child.stdout.resume();
    const request = async (route, method = "GET", body) => {
      const result = await fetch(base + route, { method, redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Basic ${Buffer.from(`amfaa:${password}`).toString("base64")}`, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!result.ok) throw failure();
      return result.json();
    };
    return await action({
      configured: async () => (await request("/provider")).connected?.includes("openrouter") === true,
      save: async key => { if (await request("/auth/openrouter", "PUT", { type: "api", key }) !== true) throw failure(); },
    });
  } catch { throw failure(); }
  finally {
    child.kill("SIGTERM");
    const kill = setTimeout(() => child.kill("SIGKILL"), 2000);
    await exited; clearTimeout(kill);
  }
}
