import { useState } from "react";
import { createRoot } from "react-dom/client";
import { RosterManagerDialog } from "../../src/roster-manager";
import { requiredVisualFixture, visualRoster } from "./fixtures";
import { AppFixture, appScenario } from "./app-entry";
import "../../src/styles.css";

// Test-only entry point: no production route or authentication bypass is added.
function VisualFixture() {
  const [open, setOpen] = useState(false);
  const scenario = new URLSearchParams(location.search).get("scenario");
  const selectedAgentId = scenario === "roster-detail" ? requiredVisualFixture(visualRoster.entries[0], "selected roster agent").agentId : undefined;
  return <main className="desktop">
    <button type="button" onClick={() => setOpen(true)}>Open roster fixture</button>
    {open ? <RosterManagerDialog onOpenAdministration={() => undefined} initialRoster={visualRoster}
      {...(selectedAgentId === undefined ? {} : { initialSelectedAgentId: selectedAgentId })}
      returnFocusTo={null} onSaved={() => undefined} onClose={() => setOpen(false)} /> : null}
  </main>;
}

createRoot(document.getElementById("root")!).render(appScenario.startsWith("roster-") ? <VisualFixture /> : <AppFixture />);
