// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style";
import { HumanAvatar, HumanProfileDialog } from "./human-avatar";

afterEach(cleanup);

describe("human profile photos", () => {
  it("uses initials as the friendly fallback", () => {
    render(<HumanAvatar name="Ada Lovelace" compact />);
    expect(screen.getByLabelText("Ada Lovelace's initials").textContent).toBe("AL");
  });

  it("saves a changed display name and removed photo together", async () => {
    const onProfileChange = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<HumanProfileDialog onOpenAdministration={() => undefined}
      human={{ id: "human-1", name: "Ada", style: DEFAULT_PARTICIPANT_STYLES.you, avatarUrl: "data:image/jpeg;base64,/9j/AA==" }}
      busy={false}
      returnFocusTo={null}
      onProfileChange={onProfileChange}
      onClose={onClose}
    />);

    const user = userEvent.setup();
    const name = screen.getByRole("textbox", { name: "Display name" });
    await user.clear(name);
    await user.type(name, "Grace Hopper");
    await user.click(screen.getByRole("button", { name: "Remove photo" }));
    await user.click(screen.getByRole("button", { name: "Save profile" }));

    await waitFor(() => expect(onProfileChange).toHaveBeenCalledWith({ name: "Grace Hopper", avatarUrl: undefined }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps profile changes local until Save and rejects a blank display name", async () => {
    const onProfileChange = vi.fn().mockResolvedValue(undefined);
    render(<HumanProfileDialog onOpenAdministration={() => undefined}
      human={{ id: "human-1", name: "Ada", style: DEFAULT_PARTICIPANT_STYLES.you }}
      busy={false}
      returnFocusTo={null}
      onProfileChange={onProfileChange}
      onClose={() => undefined}
    />);

    const user = userEvent.setup();
    const name = screen.getByRole("textbox", { name: "Display name" });
    expect(document.activeElement).toBe(name);
    await user.clear(name);
    expect((screen.getByRole("button", { name: "Save profile" }) as HTMLButtonElement).disabled).toBe(true);
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(onProfileChange).not.toHaveBeenCalled();
  });
});
