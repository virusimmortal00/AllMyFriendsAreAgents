import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { packageVerifiedExecutable } from "./build-native-opencode.js";
import { packageNativeApplication } from "./package-native-application.js";

// Runs only inside the disposable Docker builder. Production checks stay enabled.
const targetId = `linux-${process.arch}`;
const proof = packageVerifiedExecutable({ targetId, binary: "/tmp/native-opencode", outputDirectory: "/tmp/opencode-package" });
const bundle = packageNativeApplication({
  targetId,
  applicationDirectory: "/tmp/production-app",
  applicationCommit: process.env.APPLICATION_COMMIT!,
  nodeBinary: "/tmp/native-node",
  openCodeArchive: `/tmp/opencode-package/${proof.archive}`,
  openCodeEvidence: `/tmp/opencode-package/${proof.archive}.verification.json`,
  outputDirectory: "/tmp/application-package",
});
mkdirSync("/tmp/setup-install");
execFileSync("tar", ["-xf", `/tmp/application-package/${bundle.archive}`, "--strip-components=1", "-C", "/tmp/setup-install"]);
