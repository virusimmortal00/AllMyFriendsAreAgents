import path from "node:path";
import { ControlPlaneStore } from "../server/control-plane.js";

const [action, target] = process.argv.slice(2);
const dataDirectory = path.resolve(process.env.ALL_MY_FRIENDS_ARE_AGENTS_DATA_DIR || ".allmyfriendsareagents");
const secret = process.env.ALL_MY_FRIENDS_ARE_AGENTS_OWNER_BOOTSTRAP_SECRET?.trim() || "";
const store = await ControlPlaneStore.open(dataDirectory, secret);

if (action === "transfer-owner" && target) {
  const principal = await store.transferOwnerLocal(secret, target);
  console.log(`Server ownership transferred to ${principal.username}. All affected control sessions were revoked.`);
} else if (action === "recover-owner") {
  const password = process.env.ALL_MY_FRIENDS_ARE_AGENTS_OWNER_RECOVERY_PASSWORD || "";
  const principal = await store.recoverOwnerLocal(secret, password);
  console.log(`Server owner ${principal.username} recovered. All prior owner control sessions were revoked.`);
} else {
  throw new Error("Usage: pnpm control:owner transfer-owner <existing-username> | pnpm control:owner recover-owner (requires server-side bootstrap secret; recovery also requires ALL_MY_FRIENDS_ARE_AGENTS_OWNER_RECOVERY_PASSWORD)");
}
