import { describe, expect, it, vi } from "vitest";
import { runSetupWizard } from "./setup-wizard.mjs";

function fixture(answers) {
  let output = "";
  return {
    output: () => output,
    options: {
      ask: vi.fn(async () => answers.shift() ?? ""),
      write: (value) => { output += value; },
      runtimeReady: vi.fn(async () => true),
      authenticate: vi.fn(async () => 0),
      persist: vi.fn(async () => undefined),
      project: "/projects/example",
    },
  };
}

describe("native first-time setup wizard", () => {
  it("walks the real flow and persists only after authentication succeeds", async () => {
    const value = fixture(["", ""]);
    await expect(runSetupWizard(value.options)).resolves.toEqual({ code: 0, completed: true, start: true });
    expect(value.options.authenticate).toHaveBeenCalledOnce();
    expect(value.options.persist).toHaveBeenCalledOnce();
    expect(value.output()).toContain("Connect AI models");
    expect(value.output()).toContain("AMFAA never receives or saves your API key");
    expect(value.output()).toContain("AMFAA will open for this project: /projects/example");
  });

  it("uses the same walkthrough in preview without authentication, writes, or launch", async () => {
    const value = fixture(["", ""]);
    await expect(runSetupWizard({ ...value.options, preview: true })).resolves.toEqual({ code: 0, completed: false, start: false });
    expect(value.options.authenticate).not.toHaveBeenCalled();
    expect(value.options.persist).not.toHaveBeenCalled();
    expect(value.output()).toContain("FIRST-TIME SETUP · PREVIEW");
    expect(value.output()).toContain("no credentials, files, or services were changed");
    expect(new Set(value.output().split("\n").filter((line) => line.startsWith("│")).map((line) => [...line].length))).toEqual(new Set([72]));
  });

  it("leaves setup resumable when the provider step is declined or fails", async () => {
    const declined = fixture(["n"]);
    await expect(runSetupWizard(declined.options)).resolves.toMatchObject({ code: 0, completed: false });
    expect(declined.options.authenticate).not.toHaveBeenCalled();
    expect(declined.options.persist).not.toHaveBeenCalled();

    const failed = fixture([""]);
    failed.options.authenticate.mockResolvedValueOnce(7);
    await expect(runSetupWizard(failed.options)).resolves.toEqual({ code: 7, completed: false, start: false });
    expect(failed.options.persist).not.toHaveBeenCalled();
  });

  it("treats terminal EOF as cancellation at either prompt", async () => {
    const beforeProvider = fixture([]);
    beforeProvider.options.ask.mockResolvedValueOnce(undefined);
    await expect(runSetupWizard(beforeProvider.options)).resolves.toEqual({ code: 0, completed: false, start: false });
    expect(beforeProvider.options.authenticate).not.toHaveBeenCalled();
    expect(beforeProvider.options.persist).not.toHaveBeenCalled();

    const beforeLaunch = fixture([""]);
    beforeLaunch.options.ask.mockResolvedValueOnce("").mockResolvedValueOnce(undefined);
    await expect(runSetupWizard(beforeLaunch.options)).resolves.toEqual({ code: 0, completed: false, start: false });
    expect(beforeLaunch.options.authenticate).toHaveBeenCalledOnce();
    expect(beforeLaunch.options.persist).not.toHaveBeenCalled();
  });

  it("stops before prompts when the bundled runtime is unavailable", async () => {
    const value = fixture([]);
    value.options.runtimeReady.mockResolvedValueOnce(false);
    await expect(runSetupWizard(value.options)).resolves.toEqual({ code: 69, completed: false, start: false });
    expect(value.options.ask).not.toHaveBeenCalled();
  });

  it("uses one alternate terminal screen and redraws each focused page", async () => {
    const value = fixture(["", ""]);
    await runSetupWizard({ ...value.options, preview: true, fullscreen: true, width: 64 });
    expect(value.output().match(/\u001b\[\?1049h/g)).toHaveLength(1);
    expect(value.output().match(/\u001b\[2J\u001b\[H/g)).toHaveLength(3);
    expect(value.output().match(/\u001b\[\?1049l/g)).toHaveLength(1);
    expect(value.output()).toContain("FIRST-TIME SETUP · PREVIEW");
    expect(value.output()).toContain("3 / 3");
  });

  it("renders project paths without executing embedded terminal controls", async () => {
    const value = fixture(["", ""]);
    await runSetupWizard({ ...value.options, preview: true, project: "/projects/demo\u001b[2J\nnext" });
    expect(value.output()).toContain("/projects/demo\\x1b[2J\\x0anext");
    expect(value.output()).not.toContain("/projects/demo\u001b[2J");
  });
});
