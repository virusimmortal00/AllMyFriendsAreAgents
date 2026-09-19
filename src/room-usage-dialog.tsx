import { DialogFrame } from "./dialog-frame";
import { RoomSpendPanel } from "./openrouter-integration-section";
import { VIEWS } from "./view-registry";

/** Room → Usage & spend…: this room's OpenRouter spend, open to any member. */
export function RoomUsageDialog({ agentLabels, refreshKey, returnFocusTo = null, onClose }: {
  agentLabels?: Readonly<Record<string, string>>;
  refreshKey?: number;
  returnFocusTo?: HTMLElement | null;
  onClose: () => void;
}) {
  return <DialogFrame title="Usage & spend" closeLabel="Close usage and spend" className="room-usage-window" bodyClassName="room-usage-body" returnFocusTo={returnFocusTo} view={VIEWS.roomUsage} onClose={onClose}
    actions={<button type="button" className="classic-button" data-default-button onClick={onClose}>Close</button>}>
    <p className="room-usage-intro">OpenRouter spend for this room. The account balance is in Server Administration → Integrations.</p>
    <RoomSpendPanel
      {...(agentLabels ? { agentLabels } : {})}
      {...(refreshKey === undefined ? {} : { refreshKey })}
    />
  </DialogFrame>;
}
