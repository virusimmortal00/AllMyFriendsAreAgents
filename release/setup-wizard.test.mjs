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
    expect(value.output()).toContain("Provider credentials stay with OpenCode");
    expect(value.output()).toContain("Project for this launch: /projects/example");
  });

  it("uses the same walkthrough in preview without authentication, writes, or launch", async () => {
    const value = fixture(["", ""]);
    await expect(runSetupWizard({ ...value.options, preview: true })).resolves.toEqual({ code: 0, completed: false, start: false });
    expect(value.options.authenticate).not.toHaveBeenCalled();
    expect(value.options.persist).not.toHaveBeenCalled();
    expect(value.output()).toContain("First-time setup · PREVIEW");
    expect(value.output()).toContain("no credentials, files, or services were changed");
    expect(value.output().split("\n").filter((line) => line.startsWith("│"))).toSatisfy((lines) => lines.every((line) => [...line].length === 54));
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

  it("stops before prompts when the bundled runtime is unavailable", async () => {
    const value = fixture([]);
    value.options.runtimeReady.mockResolvedValueOnce(false);
    await expect(runSetupWizard(value.options)).resolves.toEqual({ code: 69, completed: false, start: false });
    expect(value.options.ask).not.toHaveBeenCalled();
  });
});
