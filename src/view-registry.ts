export type ViewCategory = "application" | "chat" | "workspace" | "room" | "participant" | "github" | "supporting";

export interface ViewDefinition {
  readonly id: `${"APP" | "CHAT" | "WORK" | "ROOM" | "PERSON" | "GH" | "AUX"}-${number}`;
  readonly name: string;
  readonly state: string;
  readonly category: ViewCategory;
}

function defineView<const Definition extends ViewDefinition>(definition: Definition) {
  return definition;
}

export const VIEWS = {
  startup: defineView({ id: "APP-01", name: "Startup", state: "Initial server loading", category: "application" }),
  joinRoom: defineView({ id: "APP-02", name: "Join Room", state: "First-time name entry", category: "application" }),
  joinRecovery: defineView({ id: "APP-03", name: "Join Recovery", state: "Join failure, retry, and cancel", category: "application" }),
  roomChat: defineView({ id: "CHAT-01", name: "Room Chat", state: "Transcript, composer, status bar, and desktop Who’s Here rail", category: "chat" }),
  compactRoomChat: defineView({ id: "CHAT-02", name: "Compact Room Chat", state: "Narrow chat with room controls available through menus", category: "chat" }),
  roomMenu: defineView({ id: "CHAT-03", name: "Room Menu", state: "Room-scoped command menu", category: "chat" }),
  windowMenu: defineView({ id: "CHAT-04", name: "Window Menu", state: "Workspace switcher and return-to-chat navigation", category: "chat" }),
  mentionSuggestions: defineView({ id: "CHAT-05", name: "Mention Suggestions", state: "Composer mention results", category: "chat" }),
  textColorPalette: defineView({ id: "CHAT-06", name: "Text Color Palette", state: "Message text-color picker", category: "chat" }),
  highlightColorPalette: defineView({ id: "CHAT-07", name: "Highlight Color Palette", state: "Message highlight-color picker", category: "chat" }),
  classicSmileyPicker: defineView({ id: "CHAT-08", name: "Classic Smiley Picker", state: "AIM smiley picker", category: "chat" }),
  pollCards: defineView({ id: "CHAT-09", name: "Poll Cards", state: "Active room poll and voting states", category: "chat" }),
  pendingSendRecovery: defineView({ id: "CHAT-10", name: "Pending Send Recovery", state: "Ambiguous-send recovery bar", category: "chat" }),
  connectionNotices: defineView({ id: "CHAT-11", name: "Connection and Action Notices", state: "Reconnect, pending action, and dismissible error strips", category: "chat" }),
  improvementsList: defineView({ id: "WORK-01", name: "Improvements List", state: "Active and All list tabs, including empty/loading/error", category: "workspace" }),
  improvementDetail: defineView({ id: "WORK-02", name: "Improvement Detail", state: "Existing improvement record", category: "workspace" }),
  improvementNotFound: defineView({ id: "WORK-03", name: "Improvement Not Found", state: "Missing improvement recovery", category: "workspace" }),
  roomTasksList: defineView({ id: "WORK-04", name: "Room Tasks List", state: "Task list, empty, loading, and create form", category: "workspace" }),
  roomTaskDetail: defineView({ id: "WORK-05", name: "Room Task Detail", state: "Selected task editor and history", category: "workspace" }),
  durableContinuations: defineView({ id: "WORK-06", name: "Durable Continuations", state: "Policy control, dashboard, and continuation inbox", category: "workspace" }),
  backgroundInvestigations: defineView({ id: "WORK-07", name: "Background Investigations", state: "Policy control, investigation lanes, and findings", category: "workspace" }),
  reviewedContributionsList: defineView({ id: "WORK-08", name: "Reviewed Contributions List", state: "Contribution list, empty, loading, and notices", category: "workspace" }),
  reviewedContributionDetail: defineView({ id: "WORK-09", name: "Reviewed Contribution Detail", state: "Review gates and contribution detail", category: "workspace" }),
  ownerDiagnosticsQuery: defineView({ id: "WORK-10", name: "Owner Diagnostics Query", state: "Bounded diagnostic search controls", category: "workspace" }),
  ownerDiagnosticsResults: defineView({ id: "WORK-11", name: "Owner Diagnostics Results", state: "Result list and selected diagnostic detail", category: "workspace" }),
  serverAdministration: defineView({ id: "WORK-12", name: "Server Administration", state: "Claim, sign-in, and active administrator session", category: "workspace" }),
  roomPropertiesGeneral: defineView({ id: "ROOM-01", name: "Room Properties — General", state: "Room name, topic, and conversation energy", category: "room" }),
  roomPropertiesAgentBehavior: defineView({ id: "ROOM-02", name: "Room Properties — Agent Behavior", state: "Base prompt, summarizer, and routing", category: "room" }),
  roomSummarizerModelPicker: defineView({ id: "ROOM-03", name: "Room Summarizer Model Picker", state: "Lazy-loaded model search, filters, and results", category: "room" }),
  manageAgentsSignIn: defineView({ id: "ROOM-04", name: "Manage Room Agents — Sign In", state: "Server-administrator authentication gate", category: "room" }),
  manageAgentsRoster: defineView({ id: "ROOM-05", name: "Manage Room Agents — Roster", state: "Agent list, sorting, availability, and mobile master pane", category: "room" }),
  manageAgentsDetail: defineView({ id: "ROOM-06", name: "Manage Room Agents — Agent Detail", state: "Selected agent identity, provider, model, and permissions", category: "room" }),
  manageAgentsModelPicker: defineView({ id: "ROOM-07", name: "Manage Room Agents — Model Picker", state: "Provider/model selection and model detail", category: "room" }),
  manageAgentsConflict: defineView({ id: "ROOM-08", name: "Manage Room Agents — Conflict", state: "Save conflict and recovery", category: "room" }),
  unsavedChangesConfirmation: defineView({ id: "ROOM-09", name: "Unsaved Changes Confirmation", state: "Destructive-close confirmation", category: "room" }),
  yourProfile: defineView({ id: "PERSON-01", name: "Your Profile", state: "Name and avatar editor", category: "participant" }),
  agentStatus: defineView({ id: "PERSON-02", name: "Agent Status", state: "Individual agent availability, provider health, and recovery", category: "participant" }),
  githubAdminSignIn: defineView({ id: "GH-01", name: "GitHub — Administrator Sign In", state: "Existing server-owner authentication", category: "github" }),
  githubClaimOwner: defineView({ id: "GH-02", name: "GitHub — Claim Owner", state: "First-time server-owner setup", category: "github" }),
  githubConnect: defineView({ id: "GH-03", name: "GitHub — Connect Account", state: "No connected GitHub account", category: "github" }),
  githubDeviceAuth: defineView({ id: "GH-04", name: "GitHub — Device Authorization", state: "User code and GitHub handoff", category: "github" }),
  githubChooseRepo: defineView({ id: "GH-05", name: "GitHub — Choose Project Repository", state: "Connected account with repository selection", category: "github" }),
  githubConfiguredRepo: defineView({ id: "GH-06", name: "GitHub — Configured Repository", state: "Connected and configured summary", category: "github" }),
  githubEmptyRepo: defineView({ id: "GH-07", name: "GitHub — Empty Repository Access", state: "No repositories available and recovery action", category: "github" }),
  improvementWorkshop: defineView({ id: "AUX-01", name: "Improvement Workshop", state: "Loaded improvement facts and evidence", category: "supporting" }),
  improvementWorkshopRecovery: defineView({ id: "AUX-02", name: "Improvement Workshop Recovery", state: "Loading, unavailable, missing, and retry states", category: "supporting" }),
  help: defineView({ id: "AUX-03", name: "Help", state: "Navigation and room help topics", category: "supporting" }),
  confirmation: defineView({ id: "AUX-04", name: "Confirmation", state: "Shared confirm/cancel alert dialog", category: "supporting" }),
} as const;

export type ViewKey = keyof typeof VIEWS;
export type ViewId = (typeof VIEWS)[ViewKey]["id"];

export function viewAttributes(view: ViewDefinition) {
  return {
    "data-view-id": view.id,
    "data-view-name": view.name,
    "data-view-state": view.state,
  } as const;
}
