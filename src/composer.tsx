import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { ChatStyle } from "../shared/chat-style";
import { reconcileMessageMentions, type MentionCandidate, type MessageMention } from "../shared/mentions";
import { ChatComposer } from "./components";
import { loadDraftSnapshot, saveDraftSnapshot, type DraftSnapshot } from "./client-persistence";

export const DRAFT_PERSISTENCE_DELAY_MS = 250;

export interface ComposerSubmission {
  text: string;
  mentions: MessageMention[];
}

export interface ComposerBoundaryHandle {
  flush: () => void;
  discardDraft: () => void;
  restoreDraft: (text: string, mentions?: MessageMention[]) => boolean;
}

interface ComposerBoundaryProps {
  humanId: string;
  mentionCandidates: MentionCandidate[];
  style: ChatStyle;
  sendDisabled?: boolean;
  onStyleChange: (style: ChatStyle) => void;
  onSubmit: (submission: ComposerSubmission) => Promise<{ restoreOnFailure: boolean }>;
}

function initialSnapshot(humanId: string): DraftSnapshot {
  if (typeof window === "undefined") return { text: "", mentions: [] };
  const stored = loadDraftSnapshot(window.localStorage, humanId);
  return { text: stored.text, mentions: reconcileMessageMentions(stored.text, stored.mentions) };
}

const ComposerSession = forwardRef<ComposerBoundaryHandle, ComposerBoundaryProps>(function ComposerSession({
  humanId,
  mentionCandidates,
  style,
  sendDisabled = false,
  onStyleChange,
  onSubmit,
}, ref) {
  const initial = useRef<DraftSnapshot | null>(null);
  if (!initial.current) initial.current = initialSnapshot(humanId);
  const [draft, setDraft] = useState(initial.current.text);
  const [mentions, setMentions] = useState<MessageMention[]>(initial.current.mentions);
  const latest = useRef<DraftSnapshot>(initial.current);
  const revision = useRef(0);
  const persistenceTimer = useRef<number | undefined>(undefined);

  function persist(snapshot = latest.current) {
    if (persistenceTimer.current !== undefined) window.clearTimeout(persistenceTimer.current);
    persistenceTimer.current = undefined;
    saveDraftSnapshot(window.localStorage, humanId, snapshot);
  }

  function schedulePersistence(snapshot: DraftSnapshot) {
    if (persistenceTimer.current !== undefined) window.clearTimeout(persistenceTimer.current);
    persistenceTimer.current = window.setTimeout(() => persist(snapshot), DRAFT_PERSISTENCE_DELAY_MS);
  }

  function replaceDraft(text: string, nextMentions: MessageMention[], persistImmediately = false) {
    const snapshot = { text, mentions: reconcileMessageMentions(text, nextMentions) };
    latest.current = snapshot;
    revision.current += 1;
    setDraft(snapshot.text);
    setMentions(snapshot.mentions);
    if (persistImmediately) persist(snapshot);
    else schedulePersistence(snapshot);
  }

  function changeDraft(text: string) {
    const snapshot = { ...latest.current, text };
    latest.current = snapshot;
    revision.current += 1;
    setDraft(text);
    schedulePersistence(snapshot);
  }

  function changeMentions(nextMentions: MessageMention[]) {
    const snapshot = { text: latest.current.text, mentions: nextMentions };
    latest.current = snapshot;
    revision.current += 1;
    setMentions(nextMentions);
    schedulePersistence(snapshot);
  }

  useImperativeHandle(ref, () => ({
    flush: () => persist(),
    discardDraft: () => replaceDraft("", [], true),
    restoreDraft: (text, nextMentions = []) => {
      if (latest.current.text) return false;
      replaceDraft(text, nextMentions, true);
      return true;
    },
  }));

  useEffect(() => {
    const flush = () => persist();
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [humanId]);

  async function submit() {
    const text = latest.current.text.trim();
    if (!text || sendDisabled) return;
    const submission = { text, mentions: reconcileMessageMentions(text, latest.current.mentions) };
    persist(submission);
    let result: Promise<{ restoreOnFailure: boolean }>;
    try {
      result = Promise.resolve(onSubmit(submission));
    } catch (error) {
      result = Promise.reject(error);
    }
    replaceDraft("", [], true);
    const clearedRevision = revision.current;
    let restoreOnFailure = true;
    try {
      restoreOnFailure = (await result).restoreOnFailure;
    } catch {
      // Parent submit handlers should report their own errors. Preserve the draft
      // if an unexpected rejection escapes that boundary.
    }
    if (restoreOnFailure && revision.current === clearedRevision && !latest.current.text) {
      replaceDraft(submission.text, submission.mentions, true);
    }
  }

  return (
    <ChatComposer
      draft={draft}
      mentions={mentions}
      mentionCandidates={mentionCandidates}
      style={style}
      sendDisabled={sendDisabled}
      onDraftChange={changeDraft}
      onMentionsChange={changeMentions}
      onStyleChange={onStyleChange}
      onBlur={() => persist()}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    />
  );
});

export const ComposerBoundary = forwardRef<ComposerBoundaryHandle, ComposerBoundaryProps>(function ComposerBoundary(props, ref) {
  return <ComposerSession key={props.humanId} ref={ref} {...props} />;
});
