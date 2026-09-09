import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

// Docker-host access is the local operator authority. The proof exists only in
// this offline recovery process; it is never installed in the running server.
export const recoveryCode = `
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { ControlPlaneStore } from "/app/server/control-plane.ts";
(async () => {
  const password = readFileSync(0, "utf8");
  const proof = randomBytes(32).toString("hex");
  const store = await ControlPlaneStore.open(process.env.ALL_MY_FRIENDS_ARE_AGENTS_DATA_DIR, proof);
  await store.recoverOwnerLocal(proof, password);
})().catch(() => { console.error("Owner recovery failed; check the existing account and volume permissions."); process.exitCode = 1; });
`;

function command(program, args, input) {
  const result = spawnSync(program, args, { input, encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${program} ${args[0]} failed. Check the container state before retrying.`);
  return result.stdout;
}

export function resetContainerOwner(container, password, run = command) {
  if (!container || container.startsWith("-")) throw new Error("An explicit container name or ID is required.");
  if (password.length < 12 || password.length > 256) throw new Error("Use a password between 12 and 256 characters.");
  const [info] = JSON.parse(run("docker", ["inspect", container]));
  const dataDirectory = info.Config.Env.find((entry) => entry.startsWith("ALL_MY_FRIENDS_ARE_AGENTS_DATA_DIR="))?.split("=").slice(1).join("=");
  if (!dataDirectory?.startsWith("/") || !info.Mounts.some((mount) => mount.RW && (dataDirectory === mount.Destination || dataDirectory.startsWith(`${mount.Destination}/`)))) {
    throw new Error("The configured data directory must be on an existing writable mount.");
  }
  const id = info.Id;
  if (info.State.Running) run("docker", ["stop", "--time", "60", id]);
  try {
    const [stopped] = JSON.parse(run("docker", ["inspect", id]));
    if (stopped.State.Running) throw new Error("The server must remain stopped during recovery.");
    run("docker", ["run", "--rm", "-i", "--network", "none", "--volumes-from", id,
      "--env", `ALL_MY_FRIENDS_ARE_AGENTS_DATA_DIR=${dataDirectory}`,
      "--entrypoint", "/app/node_modules/.bin/tsx", info.Image, "--eval", recoveryCode], password);
  } finally {
    if (info.State.Running) run("docker", ["start", id]);
  }
}

function hiddenPassword(label) {
  if (!process.stdin.isTTY) throw new Error("Use an interactive terminal for password entry.");
  process.stdout.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error) => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\u0003" || char === "\u0004") return finish(new Error("Password entry cancelled."));
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u007f" || char === "\b") value = [...value].slice(0, -1).join("");
        else if (char >= " ") value += char;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function main() {
  const [container, option, ...extra] = process.argv.slice(2);
  if (!container || extra.length || (option && option !== "--generate-clipboard")) {
    throw new Error("Usage: pnpm control:owner:container <container> [--generate-clipboard]");
  }
  let password;
  if (option) {
    if (process.platform !== "darwin") throw new Error("Clipboard generation currently requires macOS. Omit the option to enter a password privately.");
    password = randomBytes(24).toString("base64url");
    command("pbcopy", [], password);
  } else {
    password = await hiddenPassword("New owner password (12–256 characters): ");
    if (password !== await hiddenPassword("Confirm password: ")) throw new Error("Passwords do not match; nothing changed.");
  }
  resetContainerOwner(container, password);
  console.log("Owner password reset. The container was restored to its previous running state. Sign in with your existing username.");
  if (option) console.log("The new password is on your clipboard. Save it in your password manager before replacing the clipboard contents.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
