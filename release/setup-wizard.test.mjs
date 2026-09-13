import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { runSetupWizard, selectSetupOption } from "./setup-wizard.mjs";

function fixture(answers) {
  let output = "";
  return {
    output: () => output,
    options: {
      ask: vi.fn(async prompt => prompt.includes("finish setup") && answers.length === 0 ? "" : answers.shift()),
      write: (value) => { output += value; },
      runtimeReady: vi.fn(async () => true),
      authenticate: vi.fn(async () => 0),
      persist: vi.fn(async () => undefined),
      project: "/projects/example",
    },
  };
}

describe("native first-time setup wizard", () => {
  it("waits for Consolio's goodbye acknowledgement before saving setup", async () => {
    const value = fixture(["", "m", "", ""]);
    const ask = value.options.ask;
    value.options.ask = async prompt => {
      if (prompt.includes("finish setup")) {
        expect(value.options.persist).not.toHaveBeenCalled();
        expect(value.output().replace(/\s+/g, " ")).toContain("Just remember, at the end of the day, there is no greater gift than friendship. Well... money is probably better, but besides that - probably friendship.");
      }
      return ask(prompt);
    };
    expect(await runSetupWizard(value.options)).toMatchObject({ completed: true, start: true });
    expect(value.options.persist).toHaveBeenCalledOnce();
  });
  it("leaves setup incomplete when goodbye is cancelled", async () => {
    const value = fixture(["", "m", "", "", undefined]);
    expect(await runSetupWizard(value.options)).toMatchObject({ completed: false, start: false });
    expect(value.options.persist).not.toHaveBeenCalled();
  });
  it.each(["", "k"])("saves only after the %s connection succeeds", async method => {
    const value = fixture(["", method, "", ""]);
    await expect(runSetupWizard(value.options)).resolves.toEqual({ code: 0, completed: true, start: true });
    expect(value.options.authenticate).toHaveBeenCalledWith(method ? "key" : "browser", expect.anything());
    expect(value.options.persist).toHaveBeenCalledOnce();
    expect(value.output()).toContain("Key saved!");
  });
  it("offers one-time-code connection without requiring a local browser", async () => {
    const value = fixture(["", "", "2", ""]);
    await runSetupWizard(value.options);
    expect(value.options.authenticate).toHaveBeenCalledWith("headless", expect.anything());
  });
  it("finishes manual setup without authenticating or claiming a saved key", async () => {
    const value = fixture(["", "m", "", "n"]);
    await expect(runSetupWizard(value.options)).resolves.toEqual({ code: 0, completed: true, start: false });
    expect(value.options.authenticate).not.toHaveBeenCalled();
    expect(value.options.persist).toHaveBeenCalledOnce();
    expect(value.output()).toContain("provider.openrouter.options.apiKey");
    expect(value.output()).not.toContain("OPENROUTER_API_KEY");
    expect(value.output()).not.toContain("Key saved!");
  });
  it("recognizes external configuration without opening authentication", async () => {
    const value = fixture(["", "", ""]);
    await runSetupWizard({ ...value.options, configured: async () => true });
    expect(value.options.authenticate).not.toHaveBeenCalled();
    expect(value.output()).toContain("Use existing configuration");
    expect(value.options.persist).toHaveBeenCalledOnce();
  });
  it("preview never reads configuration, authenticates, or persists", async () => {
    const value = fixture(["", "", "", ""]);
    const configured = vi.fn();
    await runSetupWizard({ ...value.options, configured, preview: true });
    expect(configured).not.toHaveBeenCalled();
    expect(value.options.authenticate).not.toHaveBeenCalled();
    expect(value.options.persist).not.toHaveBeenCalled();
    expect(value.output()).toContain("no credentials, files, or services were changed");
  });
  it.each([[undefined], ["", undefined], ["", "k", undefined], ["", "m", undefined], ["", "k", "", undefined]])("cancels safely on EOF (%j)", async (...answers) => {
    const value = fixture(answers);
    await expect(runSetupWizard(value.options)).resolves.toMatchObject({ completed: false, start: false });
    expect(value.options.persist).not.toHaveBeenCalled();
  });
  it("recovers from connection failure without exposing the error or secret", async () => {
    const value = fixture(["", "k", "", "", "", "", ""]);
    value.options.authenticate.mockRejectedValueOnce(new Error("fictional-private-key"));
    await runSetupWizard(value.options);
    expect(value.options.authenticate).toHaveBeenCalledTimes(2);
    expect(value.options.persist).toHaveBeenCalledOnce();
    expect(value.output()).not.toContain("fictional-private-key");
  });
  it("does not complete after connection failure and exit", async () => {
    const value = fixture(["", "k", "", "q"]);
    value.options.authenticate.mockResolvedValueOnce(7);
    await expect(runSetupWizard(value.options)).resolves.toMatchObject({ code: 7, completed: false });
    expect(value.options.persist).not.toHaveBeenCalled();
  });
  it("keeps existing credentials when configuration detection fails", async () => {
    const value = fixture(["", "q"]);
    await runSetupWizard({ ...value.options, configured: async () => { throw new Error("private path"); } });
    expect(value.output()).not.toContain("private path");
    expect(value.options.authenticate).not.toHaveBeenCalled();
  });
  it("stops before provider interaction if the runtime is unavailable", async () => {
    const value = fixture([""]);
    value.options.runtimeReady.mockResolvedValue(false);
    await expect(runSetupWizard(value.options)).resolves.toMatchObject({ code: 69 });
    expect(value.options.authenticate).not.toHaveBeenCalled();
  });
  it.each(["manual", "failure"])("uses the %s page heading in fullscreen mode", async route => {
    const value = fixture([]);
    value.options.authenticate.mockRejectedValue(new Error("connection failed"));
    let captured = "";
    await runSetupWizard({ ...value.options, fullscreen: true, width: 160, rows: 50,
      select: async (items, animation, anyKey) => {
        if (anyKey) return "continue";
        captured = value.output().split("\u001b[2J\u001b[H").at(-1);
        if (captured.includes("Prefer to do the wiring") || captured.includes("Let's try that connection again.")) return "quit";
        if (items.some(item => item.value === "manual")) return route === "manual" ? "manual" : "key";
        return items[0].value;
      },
    });
    expect(captured).toContain(route === "manual" ? "Connect whenever you are ready." : "Let's try that connection again.");
    expect(captured).not.toContain("Let's give that key a home.");
  });
  it("centers the splash across the full terminal", async () => {
    const value = fixture([]);
    await runSetupWizard({ ...value.options, width: 160, rows: 45, fullscreen: true });
    expect(value.output().split("\n").find(line => line.includes("Consolio")).indexOf("[")).toBeGreaterThan(60);
  });
  it("keeps monochrome text and sanitized project paths", async () => {
    const value = fixture(["", "", "", ""]);
    await runSetupWizard({ ...value.options, preview: true, color: false, project: "/projects/demo\u001b[2J" });
    expect(value.output()).not.toContain("\u001b[");
    expect(value.output()).toContain("/projects/demo\\x1b[2J");
  });
  it.each([[40,16], [80,16], [40,20], [80,24]])("fits every page at %i by %i", async (width, rows) => {
    const value = fixture([]);
    const frames = [];
    await runSetupWizard({ ...value.options, preview: true, fullscreen: true, width, rows,
      select: async (items, animation, anyKey) => {
        if (anyKey) return "continue";
        const input = new PassThrough(); input.setRawMode = () => {};
        const selected = selectSetupOption({ input, output: { write: value.options.write }, items, width, rows });
        const frame = value.output().split("\u001b[2J\u001b[H").at(-1).replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "");
        frames.push(frame);
        expect(frame.split("\n").length).toBe(rows);
        if (items[0].value === "next") {
          const lines = frame.split("\n");
          const face = lines.findIndex(line => /\[ .+ \]/.test(line));
          const action = lines.findIndex(line => line.includes("› Sure, go on"));
          let lastText = action - 1;
          while (lastText >= 0 && !lines[lastText].trim()) lastText--;
          expect(Math.abs(face - (action - lastText - 1))).toBeLessThanOrEqual(1);
        }
        input.write("\r"); return selected;
      },
    });
    expect(frames.join(" ").replace(/\s+/g, " ")).toContain("Hello there! I'm Consolio");
    expect(value.options.authenticate).not.toHaveBeenCalled();
  });
});

describe("setup keyboard selection", () => {
  function terminal() {
    const input = new PassThrough();
    input.isRaw = false;
    input.setRawMode = vi.fn(value => { input.isRaw = value; });
    let output = "";
    return { input, output: () => output, options: {
      input, output: { write: text => { output += text; } }, color: false,
      items: [{ label: "I have a key", value: "connect" }, { label: "Help me get one", value: "help" }, { label: "Finish later", value: "quit" }],
    } };
  }

  it("moves the visible marker with arrows and confirms the highlighted item with Enter", async () => {
    const value = terminal();
    const result = selectSetupOption(value.options);
    expect(value.output()).toContain("› I have a key");
    value.input.write("\u001b[B");
    expect(value.output()).toContain("› Help me get one");
    value.input.write("\r");
    await expect(result).resolves.toBe("help");
    expect(value.input.isRaw).toBe(false);
    expect(value.input.listenerCount("keypress")).toBe(0);
    expect(value.output()).toContain("\u001b[?25h");
  });

  it("loops Consolio's animation without changing selection, then stops when Enter is pressed", async () => {
    vi.useFakeTimers();
    try {
      const value = terminal();
      const result = selectSetupOption({ ...value.options, animation: { offset: 4 }, rows: 30 });
      vi.advanceTimersByTime(1350);
      expect(value.output()).toContain("[ -_- ] Consolio");
      vi.advanceTimersByTime(2700);
      expect(value.output().match(/\[ -_- \] Consolio/g)).toHaveLength(2);
      value.input.write("\u001b[B\r");
      await expect(result).resolves.toBe("help");
      const stopped = value.output();
      vi.advanceTimersByTime(3000);
      expect(value.output()).toBe(stopped);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each(["x", " ", "\r", "\u001b[A", "q"])("continues the splash on any ordinary key (%j)", async key => {
    const value = terminal();
    const result = selectSetupOption({ ...value.options, items: [], anyKey: true });
    expect(value.output()).toContain("Press any key to continue");
    expect(value.output()).not.toContain("Enter selects");
    value.input.write(key);
    await expect(result).resolves.toBe("continue");
    expect(value.input.isRaw).toBe(false);
  });

  it("recenters the splash on resize and cleans up the animation and resize listener", async () => {
    vi.useFakeTimers();
    try {
      const value = terminal();
      const output = new PassThrough();
      output.write = vi.fn();
      output.columns = 120;
      output.rows = 40;
      const redrawSplash = vi.fn(() => ({ offset: 4, indent: "    " }));
      const result = selectSetupOption({ ...value.options, output, items: [], anyKey: true, animation: { offset: 4 }, redrawSplash });
      output.emit("resize");
      expect(redrawSplash).toHaveBeenCalledWith(120, 40);
      expect(vi.getTimerCount()).toBe(1);
      value.input.write("x");
      await expect(result).resolves.toBe("continue");
      expect(output.listenerCount("resize")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("supports moving back up and Enter on the default selection", async () => {
    const value = terminal();
    const result = selectSetupOption(value.options);
    value.input.write("\u001b[B\u001b[A\r");
    await expect(result).resolves.toBe("connect");
  });

  it.each(["\u0003", "\u001b"])("cancels on a quit key and restores input without submitting a selection (%j)", async key => {
    const value = terminal();
    const result = selectSetupOption(value.options);
    value.input.write(key);
    await expect(result).resolves.toBe("quit");
    expect(value.input.isRaw).toBe(false);
    expect(value.input.listenerCount("keypress")).toBe(0);
  });

  it("stops on EOF and restores raw mode and listeners on stream failure", async () => {
    const ended = terminal();
    const endResult = selectSetupOption(ended.options);
    ended.input.end();
    await expect(endResult).resolves.toBe("quit");
    const failed = terminal();
    const failure = selectSetupOption(failed.options);
    failed.input.emit("error", new Error("terminal closed"));
    await expect(failure).rejects.toThrow("terminal closed");
    expect(failed.input.isRaw).toBe(false);
    expect(failed.input.listenerCount("keypress")).toBe(0);
  });
});
