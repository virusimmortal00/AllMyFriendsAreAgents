import { useId, useState } from "react";
import { DialogFrame } from "./dialog-frame";
import { VIEWS } from "./view-registry";
import type { ActiveAgentId } from "../shared/participants";

export const NEXT_AVAILABLE_AGENT = "";
const MAX_TASK_LENGTH = 8_000;

export interface AssignableAgent { readonly agentId: ActiveAgentId; readonly alias: string }

/** Builds the exact `/task` command the room already understands; this dialog adds no new authority path. */
export function taskCommand(agentId: ActiveAgentId | typeof NEXT_AVAILABLE_AGENT, task: string) {
  const text = task.trim();
  return agentId ? `/task @${agentId} ${text}` : `/task ${text}`;
}

export function AssignTaskDialog({ agents, initialAgentId = NEXT_AVAILABLE_AGENT, disabled = false, returnFocusTo = null, onSubmit, onClose }: {
  agents: readonly AssignableAgent[];
  initialAgentId?: ActiveAgentId | typeof NEXT_AVAILABLE_AGENT;
  disabled?: boolean;
  returnFocusTo?: HTMLElement | null;
  /** Resolves to an error message, or undefined once the room accepted the command. */
  onSubmit: (command: string) => Promise<string | undefined>;
  onClose: () => void;
}) {
  const [agentId, setAgentId] = useState<ActiveAgentId | typeof NEXT_AVAILABLE_AGENT>(agents.some((agent) => agent.agentId === initialAgentId) ? initialAgentId : NEXT_AVAILABLE_AGENT);
  const [task, setTask] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const helpId = useId();
  const formId = useId();
  const canSend = !disabled && !sending && Boolean(task.trim()) && agents.length > 0;

  async function submit() {
    if (!canSend) return;
    setSending(true);
    setError("");
    const failure = await onSubmit(taskCommand(agentId, task));
    setSending(false);
    if (failure) setError(failure);
    else onClose();
  }

  return <DialogFrame title="Assign task" closeLabel="Close assign task" className="assign-task-window" bodyClassName="assign-task-body" returnFocusTo={returnFocusTo} view={VIEWS.assignTask} onClose={onClose} actions={<>
    <button type="submit" form={formId} className="classic-button" data-default-button disabled={!canSend}>{sending ? "Sending…" : "OK"}</button>
    <button type="button" className="classic-button" disabled={sending} onClick={onClose}>Cancel</button>
  </>}>
    <form id={formId} className="assign-task-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label className="classic-property-row"><span>Agent</span><select className="classic-select" value={agentId} disabled={sending} onChange={(event) => setAgentId(event.target.value as ActiveAgentId)}>
        <option value={NEXT_AVAILABLE_AGENT}>Next available agent</option>
        {agents.map((agent) => <option key={agent.agentId} value={agent.agentId}>{agent.alias}</option>)}
      </select></label>
      <label className="assign-task-field">Task<textarea className="classic-input" rows={5} maxLength={MAX_TASK_LENGTH} autoFocus value={task} disabled={sending} aria-describedby={helpId} onChange={(event) => setTask(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void submit(); } }} /></label>
      {error ? <p className="room-settings-error" role="alert">{error}</p> : null}
      <small id={helpId}>{agents.length ? "Sends /task to the room. The agent works read-only and posts its result in the transcript." : "Add an agent with Manage agents before assigning work."}</small>
    </form>
  </DialogFrame>;
}
