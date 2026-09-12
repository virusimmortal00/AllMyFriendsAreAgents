import { describe, expect, it } from "vitest";
import { pnpmInvocation } from "./package-manager-command.js";

describe("package manager command", () => {
  it("invokes pnpm directly on POSIX hosts", () => {
    expect(pnpmInvocation(["run", "build"], "linux")).toEqual({ command: "pnpm", args: ["run", "build"] });
  });

  it("invokes the pnpm command shim through the Windows command interpreter", () => {
    expect(pnpmInvocation(["run", "build"], "win32", "C:\\Windows\\cmd.exe")).toEqual({
      command: "C:\\Windows\\cmd.exe",
      args: ["/d", "/c", "pnpm", "run", "build"],
    });
  });
});
