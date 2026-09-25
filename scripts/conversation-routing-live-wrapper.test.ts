import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createLiveOpenCodeWrapper } from "./conversation-routing-live-wrapper.js";

const execute = promisify(execFile);

it.skipIf(process.platform === "win32")(
  "passes exact argv and only the provider key to a filtered isolated OpenCode child",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-routing-wrapper-test-"));
    const marker = path.join(root, "observed.json");
    const fakeOpenCode = path.join(root, "opencode-fixture.cjs");
    const fakeLauncher = path.join(root, "secret-launcher-fixture");
    try {
      await mkdir(path.join(root, "xdg-data"), { mode: 0o700 });
      await writeFile(
        fakeOpenCode,
        `#!${process.execPath}\nconst {writeFileSync}=require('node:fs');\n` +
          `writeFileSync(${JSON.stringify(marker)},JSON.stringify({argv:process.argv.slice(2),hasKey:process.env.OPENROUTER_API_KEY==='fixture-provider-key',` +
          `hasOtherSecret:'BWS_ACCESS_TOKEN' in process.env,home:process.env.HOME,config:process.env.XDG_CONFIG_HOME}));\n` +
          `process.stdout.write('1.18.25\\n');\n`,
        { mode: 0o700 },
      );
      await writeFile(
        fakeLauncher,
        '#!/bin/sh\nOPENROUTER_API_KEY=fixture-provider-key; export OPENROUTER_API_KEY\nBWS_ACCESS_TOKEN=fixture-other-secret; export BWS_ACCESS_TOKEN\nexec "$@"\n',
        { mode: 0o700 },
      );
      const { wrapperPath, shimPath, configPath } = await createLiveOpenCodeWrapper({
        root,
        realCommand: fakeOpenCode,
        secretLauncher: fakeLauncher,
        launcherHome: root,
        isolatedHome: root,
        modelId: "anthropic/fixture-model",
      });
      const args = [
        "run",
        "a prompt with spaces",
        "--flag=one:two",
        "quoted 'value' and \"double\"",
        "line one\nline two",
      ];
      const result = await execute(wrapperPath, args, {
        timeout: 10_000,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          XDG_DATA_HOME: path.join(root, "xdg-data"),
          XDG_CONFIG_HOME: path.join(root, "xdg-config"),
          XDG_CACHE_HOME: path.join(root, "cache"),
          XDG_STATE_HOME: path.join(root, "state"),
          BWS_ACCESS_TOKEN: "upstream-secret-must-not-pass",
        },
      });
      expect(result.stdout.trim()).toBe("1.18.25");
      expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({
        argv: args,
        hasKey: true,
        hasOtherSecret: false,
        home: root,
        config: path.join(root, "xdg-config"),
      });
      const files = `${await readFile(configPath, "utf8")}${await readFile(shimPath, "utf8")}${await readFile(wrapperPath, "utf8")}`;
      expect(files).toContain("{env:OPENROUTER_API_KEY}");
      expect(files).not.toContain("fixture-provider-key");
      expect(files).not.toContain("fixture-other-secret");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);
