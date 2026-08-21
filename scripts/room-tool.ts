import path from "node:path";
import { fileURLToPath } from "node:url";
import { readDeveloperToken } from "../server/developer-access.js";
import { resolveStorageConfiguration } from "../server/storage/config.js";
import type { PublicRoomState, RoomMessage } from "../server/types.js";

interface DeveloperRoom extends PublicRoomState {
  busy: boolean;
  cursor?: string;
}

interface SendResult {
  accepted: true;
  message: RoomMessage;
  room: DeveloperRoom;
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");

function option(name: string) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function commandArguments() {
  return process.argv.slice(3).filter((argument, index, all) => {
    if (argument.startsWith("--")) return false;
    return index === 0 || !all[index - 1]?.startsWith("--") || all[index - 1]?.includes("=");
  });
}

function output(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const command = process.argv[2] || "state";
  if (!(["state", "send", "wait"].includes(command))) {
    throw new Error("Usage: pnpm room:tool <state|send|wait> [message] [--wait] [--limit=50] [--timeout=120]");
  }

  const configuration = resolveStorageConfiguration(projectRoot);
  const token = await readDeveloperToken(configuration.dataDirectory).catch((error) => {
    throw new Error(`Could not load the developer bridge token. Start the room server first. ${error instanceof Error ? error.message : error}`);
  });
  const port = process.env.ALL_MY_FRIENDS_ARE_AGENTS_PORT || process.env.AGENTWIRE_PORT || "53147";
  const baseUrl = (process.env.ALL_MY_FRIENDS_ARE_AGENTS_DEVELOPER_URL || `http://127.0.0.1:${port}`).replace(/\/$/, "");
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const limit = Math.max(1, Math.min(200, Number(option("limit") || 50)));

  const room = async () => {
    const response = await fetch(`${baseUrl}/api/developer/room?limit=${limit}`, { headers });
    if (!response.ok) throw new Error(`Developer bridge returned ${response.status}: ${await response.text()}`);
    return response.json() as Promise<DeveloperRoom>;
  };

  const waitForRoom = async (after: string | undefined, requireChange: boolean) => {
    const timeoutSeconds = Math.max(1, Math.min(600, Number(option("timeout") || 120)));
    const deadline = Date.now() + timeoutSeconds * 1_000;
    let latest = await room();
    while (Date.now() < deadline) {
      const changed = !after || latest.cursor !== after;
      if (!latest.busy && latest.status !== "working" && (!requireChange || changed)) return latest;
      await new Promise((resolve) => setTimeout(resolve, 500));
      latest = await room();
    }
    throw new Error(`Timed out after ${timeoutSeconds}s waiting for the active room.`);
  };

  if (command === "state") return output(await room());
  if (command === "wait") {
    const current = await room();
    return output(await waitForRoom(option("after") || current.cursor, true));
  }

  const text = commandArguments().join(" ").trim();
  if (!text) throw new Error("A message is required: pnpm room:tool send \"What do you think?\"");
  const response = await fetch(`${baseUrl}/api/developer/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text }),
  });
  if (!response.ok) throw new Error(`Developer bridge returned ${response.status}: ${await response.text()}`);
  const result = await response.json() as SendResult;
  if (!hasFlag("wait")) return output(result);
  output(await waitForRoom(result.message.id, false));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
