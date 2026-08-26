// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style";
import { HumanAvatar, HumanAvatarDialog } from "./human-avatar";

afterEach(cleanup);

describe("human profile photos", () => {
  it("uses initials as the friendly fallback", () => {
    render(<HumanAvatar name="Ada Lovelace" compact />);
    expect(screen.getByLabelText("Ada Lovelace's initials").textContent).toBe("AL");
  });

  it("lets the current human remove their saved photo", async () => {
    const onAvatarChange = vi.fn().mockResolvedValue(undefined);
    render(<HumanAvatarDialog
      human={{ id: "human-1", name: "Ada", style: DEFAULT_PARTICIPANT_STYLES.you, avatarUrl: "data:image/jpeg;base64,/9j/AA==" }}
      busy={false}
      returnFocusTo={null}
      onAvatarChange={onAvatarChange}
      onClose={() => undefined}
    />);

    await userEvent.click(screen.getByRole("button", { name: "Remove photo" }));
    await waitFor(() => expect(onAvatarChange).toHaveBeenCalledWith());
  });
});
