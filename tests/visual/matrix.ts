import { VIEWS, type ViewKey } from "../../src/view-registry";

export const VISUAL_VIEWPORTS = [
  { id: "phone", width: 390, height: 844, touch: true },
  { id: "phone-short", width: 390, height: 660, touch: true },
  { id: "phone-minimum", width: 320, height: 568, touch: true },
  { id: "tablet", width: 768, height: 1024, touch: true },
  { id: "short-laptop", width: 1024, height: 600, touch: false },
  { id: "desktop", width: 1440, height: 900, touch: false },
] as const;

export const VISUAL_ENGINES = ["chromium", "webkit"] as const;

// Fixture coverage is explicit. Registry entries absent here are NOT verified.
export const ROSTER_SCENARIOS = [
  { id: "roster-populated", view: VIEWS.manageAgentsRoster, shots: ["top", "bottom"] },
  { id: "roster-detail", view: VIEWS.manageAgentsDetail, shots: ["top", "bottom"] },
] as const;

// Explicitly enumerate routes/states; adding a registry entry does not invent coverage.
const APP_VIEW_KEYS = [
  "startup", "joinRoom", "joinRecovery", "roomChat", "compactRoomChat", "roomMenu", "windowMenu",
  "mentionSuggestions", "textColorPalette", "highlightColorPalette", "classicSmileyPicker", "pollCards", "pendingSendRecovery", "connectionNotices",
  "improvementsList", "improvementDetail", "improvementNotFound", "roomTasksList", "roomTaskDetail", "durableContinuations", "backgroundInvestigations", "reviewedContributionsList", "reviewedContributionDetail", "ownerDiagnosticsQuery", "ownerDiagnosticsResults", "serverAdministration",
  "roomPropertiesGeneral", "roomPropertiesAgentBehavior", "roomSummarizerModelPicker", "manageAgentsSignIn", "manageAgentsModelPicker", "manageAgentsConflict", "unsavedChangesConfirmation",
  "yourProfile", "agentStatus", "githubAdminSignIn", "githubClaimOwner", "githubConnect", "githubDeviceAuth", "githubChooseRepo", "githubConfiguredRepo", "githubEmptyRepo",
  "improvementWorkshop", "improvementWorkshopRecovery", "help", "confirmation",
] as const satisfies readonly ViewKey[];
const SCROLLING_VIEWS: readonly ViewKey[] = ["improvementDetail", "roomTaskDetail", "durableContinuations", "backgroundInvestigations", "reviewedContributionDetail", "ownerDiagnosticsResults", "roomPropertiesAgentBehavior", "roomSummarizerModelPicker", "manageAgentsModelPicker", "yourProfile", "improvementWorkshop", "serverAdministration"];
export const APP_SCENARIOS = [...APP_VIEW_KEYS.map((key) => ({
  id: key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`), view: VIEWS[key],
  shots: SCROLLING_VIEWS.includes(key) ? ["top", "bottom"] : ["top"],
})),
  { id: "server-administration-sign-in", view: VIEWS.serverAdministration, shots: ["top", "bottom"] },
  { id: "server-administration-unclaimed", view: VIEWS.serverAdministration, shots: ["top", "bottom"] },
  { id: "your-profile-signed-out", view: VIEWS.yourProfile, shots: ["top", "bottom"] },
  { id: "your-profile-unclaimed", view: VIEWS.yourProfile, shots: ["top", "bottom"] },
  { id: "owner-diagnostics-sign-in", view: VIEWS.ownerDiagnosticsQuery, shots: ["top"] },
  { id: "manage-agents-empty", view: VIEWS.manageAgentsRoster, shots: ["top"] },
];
export const VISUAL_SCENARIOS = [...ROSTER_SCENARIOS, ...APP_SCENARIOS];
export function scenarioApplies(scenario: { id: string }, viewport: { width: number }) {
  return scenario.id !== "compact-room-chat" || viewport.width <= 720;
}

export function expectedVisualKeys(scenarioIds: readonly string[] = VISUAL_SCENARIOS.map((scenario) => scenario.id)) {
  return VISUAL_ENGINES.flatMap((engine) => VISUAL_VIEWPORTS.flatMap((viewport) =>
    VISUAL_SCENARIOS.filter((scenario) => scenarioIds.includes(scenario.id) && scenarioApplies(scenario, viewport)).flatMap((scenario) => scenario.shots.map((shot) =>
      `${engine}--${viewport.id}--${scenario.id}--${shot}`))));
}
