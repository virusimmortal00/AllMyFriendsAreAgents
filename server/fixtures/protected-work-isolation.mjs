import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { isAbsolute } from "node:path";
const directory = process.env.AMFAA_TEST_DIRECTORY;
if (!directory || !isAbsolute(directory)) throw new Error("An isolated fixture directory is required.");
os.homedir = () => directory;
syncBuiltinESMExports();
const fetchLocal = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== "127.0.0.1") throw new Error("External fetch is disabled in the protected-work fixture.");
  return fetchLocal(input, { ...options, redirect: "manual" });
};
