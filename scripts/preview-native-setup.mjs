import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSetupWizard } from "../release/setup-wizard.mjs";

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runSetupWizard({ preview: true, runtimeReady: async () => true });
  process.exitCode = result.code;
}
