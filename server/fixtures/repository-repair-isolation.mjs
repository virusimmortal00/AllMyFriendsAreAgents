// Loaded only by repository-repair-application.test.ts, never by the application.
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { isAbsolute } from "node:path";

const directory = process.env.AMFAA_REPAIR_TEST_DIRECTORY;
if (!directory || !isAbsolute(directory)) throw new Error("An isolated fixture directory is required.");
os.homedir = () => directory;
syncBuiltinESMExports();
// The application supplies the GitHub fixture transport. No upstream is allowed.
globalThis.fetch = async () => { throw new Error("External fetch is disabled in the repository repair fixture."); };
