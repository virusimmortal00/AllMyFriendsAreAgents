import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installer = readFileSync(path.join(root, "scripts/install-windows.ps1"), "utf8");
const acceptance = readFileSync(path.join(root, "scripts/install-windows.test.ps1"), "utf8");
const workflow = readFileSync(path.join(root, ".github/workflows/build-native-opencode.yml"), "utf8");
const packager = readFileSync(path.join(root, "scripts/package-native-application.ts"), "utf8");

describe("PowerShell native installer contract", () => {
  it("exposes current and immutable-version installation without privileged defaults", () => {
    expect(installer).toMatch(/\[string\] \$Version = "current"/);
    expect(installer).toContain("LocalApplicationData");
    expect(installer).toMatch(/\[string\] \$InstallDirectory/);
    expect(installer).toMatch(/\[switch\] \$NoPath/);
    expect(installer).toMatch(/\[switch\] \$DryRun/);
    expect(installer).toContain("No downloads or changes were made.");
    expect(installer).toContain("releases/latest/download");
    expect(installer).toContain("releases/download/v$RequestedVersion");
  });

  it("admits only Windows x64 and binds downloads to the closed native manifest", () => {
    expect(installer).toContain('script:Target = "windows-x64"');
    expect(installer).toContain("Assert-WindowsX64Host");
    expect(installer).toContain("Assert-ExactProperties");
    expect(installer).toContain("Assert-ReleaseFile");
    expect(installer).toContain("Assert-ArtifactProvenance");
    expect(installer).toContain("Get-FileHash -LiteralPath $Path -Algorithm SHA256");
    expect(packager).toMatch(/node\.exe.*native-cli\.mjs.*%\*/s);
    expect(installer).not.toMatch(/Invoke-Expression|\biex\b|Start-Process|ExecutionPolicy|LocalMachine|CurrentUser\\Software\\Microsoft\\PowerShell/i);
  });

  it("keeps activation, rollback, PATH, and uninstall bounded", () => {
    expect(installer).toContain(".installer-stage-");
    expect(installer).toContain("[IO.File]::Replace");
    expect(installer).toContain('"previous.json"');
    expect(installer).toContain('SetEnvironmentVariable("Path", $next, "User")');
    expect(installer).not.toContain('SetEnvironmentVariable("Path", $next, "Machine")');
    expect(installer).toContain("Get-SafeInstallRoot");
    expect(installer).toContain("is not owned by this installer");
    expect(installer).toContain("user state was retained");
  });

  it("has executable Windows acceptance coverage in the native workflow", () => {
    for (const phrase of ["bad artifact hash", "bad provenance", "interrupted download", "unsupported platform", "locked-file failure", "rollback", "uninstall", "user PATH addition is idempotent", "no-PATH option", "uninstall refuses unowned directories", "retains user state"]) {
      expect(acceptance).toContain(phrase);
    }
    expect(workflow).toContain("Run Windows installer acceptance checks");
    expect(workflow).toContain("scripts/install-windows.test.ps1");
    expect(packager).toContain('dereference: target.os === "windows"');
    expect(packager).toContain("files(appInput);");
    expect(acceptance).toContain("uninstall preserves unrelated files");
  });

  it("contains no publication or credential mutation", () => {
    expect(installer).not.toMatch(/GITHUB_TOKEN|GH_TOKEN|Authorization|gh release|create-release|publish|upload/i);
    expect(acceptance).not.toMatch(/GITHUB_TOKEN|GH_TOKEN|Authorization|gh release|create-release|publish|upload/i);
  });
});
