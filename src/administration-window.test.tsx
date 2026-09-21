// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdministrationWindow } from "./administration-window";

vi.mock("./control-session", () => ({
  useControlSession: () => ({
    checked: true,
    session: { expiresAt: "2099-01-01T00:00:00Z", principal: { id: "owner", username: "owner", role: "OWNER", capabilities: [], revision: 1 } },
  }),
}));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function roomConfiguration() {
  return {
    settings: {
      configurationRevision: 0,
      basePromptRevision: 0,
      basePromptText: "Default merit rule",
      summarizerModel: { providerId: "opencode", modelId: "muse-spark-1.2-contributor-free", variant: "minimal" },
      summarizerPromptText: "Summarize {{transcript}}",
      summarizerPromptRevision: 0,
      featureFlags: { preflightInvocationGating: false },
      preflightMode: "enforce",
      intentClassifierEnabled: true,
      updatedAt: null,
    },
    defaults: { basePromptText: "Default merit rule" },
    routingEvidence: { recordedDecisions: 0, evaluatedShadowSuppressions: 0, falseSuppressionRate: null },
  };
}

describe("AdministrationWindow", () => {
  it("confirms before leaving unsaved Room behavior edits and preserves them when canceled", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(roomConfiguration())));
    const onSelectPage = vi.fn();
    const user = userEvent.setup();
    render(<AdministrationWindow page="RoomBehavior" destination={null} refreshKey={0} onSelectPage={onSelectPage} onContinue={vi.fn()} onClose={vi.fn()} />);

    const prompt = await screen.findByLabelText("Additional room prompt", { selector: "textarea" });
    await user.clear(prompt);
    await user.type(prompt, "Keep this draft");
    await user.click(screen.getByRole("tab", { name: "Diagnostics" }));

    const confirmation = screen.getByRole("alertdialog", { name: "Discard room behavior changes?" });
    expect(onSelectPage).not.toHaveBeenCalled();
    await user.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    expect((prompt as HTMLTextAreaElement).value).toBe("Keep this draft");

    await user.click(screen.getByRole("tab", { name: "Diagnostics" }));
    await user.click(within(screen.getByRole("alertdialog", { name: "Discard room behavior changes?" })).getByRole("button", { name: "Discard changes" }));
    expect(onSelectPage).toHaveBeenCalledWith("Diagnostics");
  });

  it("uses the same discard confirmation for both window close controls", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(roomConfiguration())));
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<AdministrationWindow page="RoomBehavior" destination={null} refreshKey={0} onSelectPage={vi.fn()} onContinue={vi.fn()} onClose={onClose} />);

    const prompt = await screen.findByLabelText("Additional room prompt", { selector: "textarea" });
    await user.clear(prompt);
    await user.type(prompt, "Keep this draft");
    await user.click(screen.getByRole("button", { name: "Close server administration" }));
    await user.click(within(screen.getByRole("alertdialog", { name: "Discard room behavior changes?" })).getByRole("button", { name: "Cancel" }));
    expect((prompt as HTMLTextAreaElement).value).toBe("Keep this draft");

    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(within(screen.getByRole("alertdialog", { name: "Discard room behavior changes?" })).getByRole("button", { name: "Discard changes" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
