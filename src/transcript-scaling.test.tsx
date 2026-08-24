// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TranscriptHeader } from "./components";

afterEach(cleanup);

describe("transcript scaling controls", () => {
  it("offers bounded local scaling and an explicit reset", async () => {
    const user = userEvent.setup();
    const change = vi.fn();
    const reset = vi.fn();
    render(<TranscriptHeader roomName="The Agent Room" magnification={125} onMagnificationChange={change} onMagnificationReset={reset} />);

    await user.click(screen.getByRole("button", { name: "Decrease transcript magnification" }));
    await user.click(screen.getByRole("button", { name: "Increase transcript magnification" }));
    await user.click(screen.getByRole("button", { name: "Reset transcript magnification from 125% to 100%" }));
    expect(change.mock.calls).toEqual([[-1], [1]]);
    expect(reset).toHaveBeenCalledOnce();
  });

  it("disables controls at the scale boundaries and reset at 100%", () => {
    const { rerender } = render(<TranscriptHeader roomName="Room" magnification={75} onMagnificationChange={() => undefined} onMagnificationReset={() => undefined} />);
    expect(screen.getByRole("button", { name: "Decrease transcript magnification" }).hasAttribute("disabled")).toBe(true);
    rerender(<TranscriptHeader roomName="Room" magnification={150} onMagnificationChange={() => undefined} onMagnificationReset={() => undefined} />);
    expect(screen.getByRole("button", { name: "Increase transcript magnification" }).hasAttribute("disabled")).toBe(true);
    rerender(<TranscriptHeader roomName="Room" magnification={100} onMagnificationChange={() => undefined} onMagnificationReset={() => undefined} />);
    expect(screen.getByRole("button", { name: "Reset transcript magnification from 100% to 100%" }).hasAttribute("disabled")).toBe(true);
  });
});
