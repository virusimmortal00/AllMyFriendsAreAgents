import type { ReactNode } from "react";

export const WORKSPACE_NAMES = ["Improvements", "Tasks", "Continuations", "Investigations", "Reviewed contributions", "Diagnostics"] as const;
export type WorkspaceName = (typeof WORKSPACE_NAMES)[number];

/**
 * Mandatory shell for any destination that replaces the chat workspace.
 * Keeping the exit control here makes it impossible for an individual workspace
 * component to accidentally omit the route back to Chat.
 */
export function WorkspaceSurface({ name, onClose, children }: { name: WorkspaceName; onClose: () => void; children: ReactNode }) {
  return <section className="workspace-surface" aria-label={`${name} workspace`}>
    <header className="workspace-surface__titlebar">
      <strong>{name}</strong>
      <button type="button" aria-label={`Close ${name} and return to Chat`} onClick={onClose}>×</button>
    </header>
    <div className="workspace-surface__content">{children}</div>
  </section>;
}
