// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style";
import { roomMentionCandidates, type MessageMention } from "../shared/mentions";
import { ChatComposer } from "./components";

afterEach(() => cleanup());

function MentionFlow() {
  const [draft, setDraft] = useState("");
  const [mentions, setMentions] = useState<MessageMention[]>([]);
  return <>
    <ChatComposer
      draft={draft}
      mentions={mentions}
      mentionCandidates={roomMentionCandidates([{ id: "human-alice", name: "Alice" }])}
      style={DEFAULT_PARTICIPANT_STYLES.you}
      onDraftChange={setDraft}
      onMentionsChange={setMentions}
      onStyleChange={() => undefined}
      onSubmit={(event) => event.preventDefault()}
    />
    <output aria-label="Mention metadata">{JSON.stringify(mentions)}</output>
  </>;
}

describe("participant mention autocomplete", () => {
  it("supports keyboard selection and keeps the stable target after more typing", async () => {
    const user = userEvent.setup();
    render(<MentionFlow />);
    const message = screen.getByRole("textbox", { name: "Message" });
    await user.type(message, "hello @gr");
    expect(screen.getByRole("listbox", { name: "Mention a participant" })).toBeTruthy();
    await user.keyboard("{Enter}");
    expect((message as HTMLTextAreaElement).value).toBe("hello @Grok");
    await user.type(message, " please review");
    expect(screen.getByLabelText("Mention metadata").textContent).toContain('"targetId":"cursor-grok"');
  });

  it("offers humans and dismisses without sending", async () => {
    const user = userEvent.setup();
    render(<MentionFlow />);
    const message = screen.getByRole("textbox", { name: "Message" });
    await user.type(message, "@ali");
    expect(screen.getByRole("option", { name: /@Alice/ })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect((message as HTMLTextAreaElement).value).toBe("@ali");
  });
});
