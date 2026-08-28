import type { ActiveAgentId } from "./participants.js";

export const LEGACY_ROOM_COMMANDS = ["task", "pov", "poll", "help"] as const;
export const ROOM_COMMANDS = ["task", "pov", "poll", "help", "gh"] as const;
export type RoomCommandName = typeof ROOM_COMMANDS[number];
export const COMMAND_CATALOG_REVISION = 2 as const;

export interface RoomCommandCatalogEntry {
  readonly command: RoomCommandName;
  readonly summary: string;
  readonly syntax: string;
  readonly example: string;
}

const COMMAND_CATALOG: Readonly<Record<RoomCommandName, RoomCommandCatalogEntry>> = {
  help: { command: "help", summary: "List the room commands currently available to you.", syntax: "/help", example: "/help" },
  task: { command: "task", summary: "Delegate bounded work to one eligible agent.", syntax: "/task [@agent] <bounded work>", example: "/task @Sol check the error path" },
  pov: { command: "pov", summary: "Request bounded perspectives from all eligible agents or one named agent.", syntax: "/pov [@agent] <question>", example: "/pov @Sol What tradeoff are we missing?" },
  poll: { command: "poll", summary: "Create a server-authoritative poll with quoted options.", syntax: '/poll "Question" "Option A" "Option B"', example: '/poll "Ship today?" "Yes" "No"' },
  gh: { command: "gh", summary: "Read bounded context from the server-configured GitHub repository.", syntax: "/gh recent | pr <number> | issue <number> | ci [<number>]", example: "/gh pr 98" },
};

export function commandCatalog(commands: readonly RoomCommandName[]) {
  const allowed = new Set(commands);
  return ROOM_COMMANDS.filter((command) => allowed.has(command)).map((command) => COMMAND_CATALOG[command]);
}

export function commandHelpText(commands: readonly RoomCommandName[]) {
  const entries = commandCatalog(commands);
  if (!entries.length) return "No room commands are currently available.";
  return ["Room commands available to you:", ...entries.map((entry) => `/${entry.command} — ${entry.summary}\n  Syntax: ${entry.syntax}\n  Example: ${entry.example}`)].join("\n");
}

export function roomCommandGuide(commands: readonly RoomCommandName[]) {
  const entries = commandCatalog(commands);
  if (!entries.length) return "";
  return `ROOM COMMANDS (server-owned; only your currently permitted operations are listed)
- Use the structured room_command tool when you intend to create room work, request bounded perspectives, create a poll, or inspect your current command catalog. Respond conversationally when you only need to answer or discuss something.
- Never emit raw slash-command text as a visible chat response. The tool is the command transport; slash syntax below is explanatory human syntax only.
- A soft @mention in ordinary conversation is only a conversational hint. It is not hard routing, authorization, or delegation. Use room_command task with pinned selection for hard routing.
- Poll participation is an explicit tool action, not conversational discussion: use polls to inspect open polls, poll_vote with a stable poll ID and zero-based option index to vote, and poll_close only for a poll you created.
- GitHub reads are gh subcommands carried by this same room_command tool, not a separate GitHub tool. A roster grant only requests that capability; it creates no authority unless the server configuration, current policy, provider session, and lease also allow it.
${entries.map((entry) => `- ${entry.command}: ${entry.summary} Structured example: ${structuredExample(entry.command)} Human syntax example (never emit it): ${entry.example}`).join("\n")}`;
}

function structuredExample(command: RoomCommandName) {
  if (command === "help") return '{"command":"help"}';
  if (command === "task") return '{"command":"task","prompt":"Check the error path","selection":{"kind":"pinned","agentId":"codex-sol"}}';
  if (command === "pov") return '{"command":"pov","prompt":"What tradeoff are we missing?","selection":{"kind":"all-eligible"}} or {"command":"pov","prompt":"What tradeoff are we missing?","selection":{"kind":"pinned","agentId":"codex-sol"}}';
  if (command === "gh") return '{"command":"gh","selector":{"kind":"recent"}} or {"command":"gh","selector":{"kind":"pr","number":98}}';
  return '{"command":"poll","question":"Ship today?","options":["Yes","No"]}';
}

export type GhSelector =
  | { readonly kind: "recent" }
  | { readonly kind: "pr"; readonly number: number }
  | { readonly kind: "issue"; readonly number: number }
  | { readonly kind: "ci"; readonly number?: number };

export type CommandInvocation =
  | { readonly command: "task"; readonly prompt: string; readonly selection: { readonly kind: "round-robin" } | { readonly kind: "pinned"; readonly agentId: ActiveAgentId } }
  | { readonly command: "pov"; readonly prompt: string; readonly selection: { readonly kind: "all-eligible" } | { readonly kind: "pinned"; readonly agentId: ActiveAgentId } }
  | { readonly command: "poll"; readonly question: string; readonly options: readonly [string, string, ...string[]] }
  | { readonly command: "help" }
  | { readonly command: "gh"; readonly selector: GhSelector };

export type CommandParseResult =
  | { readonly kind: "command"; readonly invocation: CommandInvocation }
  | { readonly kind: "not-command" }
  | { readonly kind: "private-error"; readonly message: string };

export type CommandInput = string | CommandInvocation;

const MAX_PROMPT_LENGTH = 8_000;
const MAX_POLL_VALUE_LENGTH = 500;
const MAX_POLL_OPTIONS = 12;

export function parseCommand(text: string): CommandParseResult {
  const normalized = text.trim();
  if (!normalized.startsWith("/")) return { kind: "not-command" };
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(normalized);
  if (!match) return { kind: "private-error", message: "Try /help to see the available commands." };
  const command = match[1]!.toLocaleLowerCase();
  const rest = match[2]?.trim() ?? "";
  if (!ROOM_COMMANDS.includes(command as RoomCommandName)) return { kind: "private-error", message: `Unknown command /${command}. Try /help.` };
  if (command === "help") return rest ? { kind: "private-error", message: "/help does not take any arguments." } : { kind: "command", invocation: { command: "help" } };
  if (command === "gh") return parseGh(rest);
  if (command === "poll") return parsePoll(rest);
  if (command === "pov") return parsePov(rest);
  if (rest.startsWith("@")) {
    const pinned = /^@([^\s]+)(?:\s+([\s\S]*))?$/.exec(rest);
    if (!pinned) return { kind: "private-error", message: "Choose a roster agent after /task, or omit @agent for round-robin." };
    const prompt = pinned[2]?.trim() ?? "";
    if (prompt.length > MAX_PROMPT_LENGTH) return { kind: "private-error", message: `Keep /task prompts under ${MAX_PROMPT_LENGTH} characters.` };
    return { kind: "command", invocation: { command: "task", prompt, selection: { kind: "pinned", agentId: pinned[1] } } };
  }
  if (rest.length > MAX_PROMPT_LENGTH) return { kind: "private-error", message: `Keep /task prompts under ${MAX_PROMPT_LENGTH} characters.` };
  return { kind: "command", invocation: { command: "task", prompt: rest, selection: { kind: "round-robin" } } };
}

/** Structured tool calls share validation with slash input without changing the caller's explicit selection. */
export function parseCommandInput(input: CommandInput): CommandParseResult {
  if (typeof input === "string") return parseCommand(input);
  if (!input || typeof input !== "object") return { kind: "private-error", message: "Try /help to see the available commands." };
  if (input.command === "help") return parseCommand("/help");
  if (input.command === "gh" && input.selector && typeof input.selector === "object") {
    const selector = input.selector as Partial<GhSelector> & Record<string, unknown>;
    const keys = Object.keys(selector).sort().join(",");
    if (selector.kind === "recent" && keys === "kind") return parseCommand("/gh recent");
    if ((selector.kind === "pr" || selector.kind === "issue") && keys === "kind,number" && typeof selector.number === "number") return parseCommand(`/gh ${selector.kind} ${selector.number}`);
    if (selector.kind === "ci" && (keys === "kind" || keys === "kind,number") && (selector.number === undefined || typeof selector.number === "number")) return parseCommand(`/gh ci${selector.number === undefined ? "" : ` ${selector.number}`}`);
    return ghError();
  }
  if (input.command === "pov" && typeof input.prompt === "string" && (input.selection === undefined || input.selection?.kind === "all-eligible" || input.selection?.kind === "pinned" && typeof input.selection.agentId === "string")) {
    const prompt = input.prompt.trim();
    if (!prompt) return { kind: "private-error", message: "Add a prompt after /pov." };
    if (prompt.length > MAX_PROMPT_LENGTH) return { kind: "private-error", message: `Keep /pov prompts under ${MAX_PROMPT_LENGTH} characters.` };
    return { kind: "command", invocation: { command: "pov", prompt, selection: input.selection || { kind: "all-eligible" } } };
  }
  if (input.command === "task" && typeof input.prompt === "string" && (input.selection?.kind === "round-robin" || input.selection?.kind === "pinned" && typeof input.selection.agentId === "string")) {
    const prompt = input.prompt.trim();
    if (prompt.length > MAX_PROMPT_LENGTH) return { kind: "private-error", message: `Keep /task prompts under ${MAX_PROMPT_LENGTH} characters.` };
    return { kind: "command", invocation: { command: "task", prompt, selection: input.selection } };
  }
  if (input.command === "poll" && typeof input.question === "string" && Array.isArray(input.options)) {
    const quote = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
    if (input.options.every((option) => typeof option === "string")) return parseCommand(`/poll ${[input.question, ...input.options].map(quote).join(" ")}`);
  }
  return { kind: "private-error", message: "The structured command arguments are invalid. Try /help." };
}

function canonicalPositiveDecimal(value: string): number | undefined {
  if (!/^[1-9][0-9]*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseGh(rest: string): CommandParseResult {
  const parts = rest.split(/\s+/).filter(Boolean);
  if (parts.length === 1 && parts[0]?.toLocaleLowerCase() === "recent") return { kind: "command", invocation: { command: "gh", selector: { kind: "recent" } } };
  const selector = parts[0]?.toLocaleLowerCase();
  if (selector === "ci" && parts.length === 1) return { kind: "command", invocation: { command: "gh", selector: { kind: "ci" } } };
  if ((selector === "pr" || selector === "issue" || selector === "ci") && parts.length === 2) {
    const number = canonicalPositiveDecimal(parts[1]!);
    if (number !== undefined) return { kind: "command", invocation: { command: "gh", selector: { kind: selector, number } as GhSelector } };
  }
  return ghError();
}

function ghError(): CommandParseResult {
  return { kind: "private-error", message: "Use /gh recent, /gh pr <number>, /gh issue <number>, or /gh ci [<number>] with a positive decimal number." };
}

function parsePov(rest: string): CommandParseResult {
  if (!rest) return { kind: "private-error", message: "Add a prompt after /pov." };
  if (rest.startsWith("@")) {
    const pinned = /^@([^\s]+)(?:\s+([\s\S]*))?$/.exec(rest);
    const prompt = pinned?.[2]?.trim() ?? "";
    if (!pinned || !prompt) return { kind: "private-error", message: "Choose one roster agent and add a prompt after /pov @agent." };
    if (prompt.length > MAX_PROMPT_LENGTH) return { kind: "private-error", message: `Keep /pov prompts under ${MAX_PROMPT_LENGTH} characters.` };
    return { kind: "command", invocation: { command: "pov", prompt, selection: { kind: "pinned", agentId: pinned[1]! } } };
  }
  if (rest.length > MAX_PROMPT_LENGTH) return { kind: "private-error", message: `Keep /pov prompts under ${MAX_PROMPT_LENGTH} characters.` };
  return { kind: "command", invocation: { command: "pov", prompt: rest, selection: { kind: "all-eligible" } } };
}

function parsePoll(rest: string): CommandParseResult {
  const values: string[] = [];
  let index = 0;
  while (index < rest.length) {
    while (/\s/.test(rest[index] || "")) index++;
    if (index >= rest.length) break;
    if (rest[index] !== '"') return pollError();
    index++;
    let value = "";
    let closed = false;
    while (index < rest.length) {
      const character = rest[index++]!;
      if (character === '"') { closed = true; break; }
      if (character === "\\") {
        const escaped = rest[index++];
        if (escaped !== '"' && escaped !== "\\") return pollError();
        value += escaped;
      } else value += character;
    }
    if (!closed || !value.trim() || value.length > MAX_POLL_VALUE_LENGTH) return pollError();
    values.push(value.trim());
    if (values.length > MAX_POLL_OPTIONS + 1) return pollError();
    if (index < rest.length && !/\s/.test(rest[index]!)) return pollError();
  }
  if (values.length < 3) return pollError();
  const [question, first, second, ...remaining] = values;
  return { kind: "command", invocation: { command: "poll", question: question!, options: [first!, second!, ...remaining] } };
}

function pollError(): CommandParseResult {
  return { kind: "private-error", message: 'Use /poll "Question" "Option A" "Option B" with one question and at least two quoted options.' };
}

export interface CommandPermissions {
  readonly allowAll: boolean;
  readonly allowed: readonly RoomCommandName[];
  readonly catalogRevision?: typeof COMMAND_CATALOG_REVISION;
}

export const ALLOW_ALL_COMMANDS: CommandPermissions = { allowAll: true, allowed: ROOM_COMMANDS, catalogRevision: COMMAND_CATALOG_REVISION };
export const LEGACY_ALLOW_ALL_COMMANDS: CommandPermissions = { allowAll: true, allowed: LEGACY_ROOM_COMMANDS };

export function validCommandPermissions(input: unknown): input is CommandPermissions {
  if (!input || typeof input !== "object") return false;
  const value = input as { allowAll?: unknown; allowed?: unknown };
  if (typeof value.allowAll !== "boolean") return false;
  if ((value as { catalogRevision?: unknown }).catalogRevision !== undefined && (value as { catalogRevision?: unknown }).catalogRevision !== COMMAND_CATALOG_REVISION) return false;
  if (value.allowAll && value.allowed === undefined) return true;
  if (!Array.isArray(value.allowed)) return false;
  return value.allowed.every((command) => typeof command === "string" && ROOM_COMMANDS.includes(command as RoomCommandName))
    && new Set(value.allowed).size === value.allowed.length;
}

export function normalizeCommandPermissions(input: unknown): CommandPermissions {
  if (input === undefined || input === null) return LEGACY_ALLOW_ALL_COMMANDS;
  if (!validCommandPermissions(input)) return { allowAll: false, allowed: [] };
  const value = input as { allowAll?: unknown; allowed?: unknown; catalogRevision?: unknown };
  if (value.allowAll && value.catalogRevision === COMMAND_CATALOG_REVISION) return ALLOW_ALL_COMMANDS;
  if (value.allowAll) {
    const legacyAllowed = Array.isArray(value.allowed) ? value.allowed.filter((candidate): candidate is RoomCommandName => typeof candidate === "string" && LEGACY_ROOM_COMMANDS.includes(candidate as typeof LEGACY_ROOM_COMMANDS[number])) : [...LEGACY_ROOM_COMMANDS];
    return { allowAll: true, allowed: [...new Set(legacyAllowed)] };
  }
  if (!Array.isArray(value.allowed)) return { allowAll: false, allowed: [] };
  const allowed = [...new Set(value.allowed.filter((candidate): candidate is RoomCommandName => typeof candidate === "string" && ROOM_COMMANDS.includes(candidate as RoomCommandName)))].sort((left,right)=>ROOM_COMMANDS.indexOf(left)-ROOM_COMMANDS.indexOf(right));
  return { allowAll: false, allowed, ...(value.catalogRevision === COMMAND_CATALOG_REVISION ? { catalogRevision: COMMAND_CATALOG_REVISION } : {}) };
}

export function effectiveAllowedCommands(agent: CommandPermissions, ceiling: readonly RoomCommandName[]) {
  const ceilingSet = new Set(ceiling);
  const requested = agent.allowAll && agent.catalogRevision === COMMAND_CATALOG_REVISION ? ROOM_COMMANDS : agent.allowed;
  return requested.filter((command) => ceilingSet.has(command));
}

export interface SelectionCandidate { readonly agentId: ActiveAgentId; readonly eligible: boolean }
export type RoundRobinResolution =
  | { readonly kind: "selected"; readonly agentId: ActiveAgentId; readonly nextLastAssignedAgentId: ActiveAgentId | null; readonly advancePointer: boolean }
  | { readonly kind: "no-eligible-candidates"; readonly nextLastAssignedAgentId: ActiveAgentId | null; readonly advancePointer: false };

export function resolveRoundRobin(candidates: readonly SelectionCandidate[], lastAssignedAgentId: ActiveAgentId | null, pinnedAgentId?: ActiveAgentId): RoundRobinResolution {
  if (pinnedAgentId) {
    const pinned = candidates.find((candidate) => candidate.agentId === pinnedAgentId);
    return pinned?.eligible
      ? { kind: "selected", agentId: pinned.agentId, nextLastAssignedAgentId: lastAssignedAgentId, advancePointer: false }
      : { kind: "no-eligible-candidates", nextLastAssignedAgentId: lastAssignedAgentId, advancePointer: false };
  }
  if (!candidates.length) return { kind: "no-eligible-candidates", nextLastAssignedAgentId: lastAssignedAgentId, advancePointer: false };
  const persistedIndex = candidates.findIndex(({ agentId }) => agentId === lastAssignedAgentId);
  const start = persistedIndex < 0 ? 0 : (persistedIndex + 1) % candidates.length;
  for (let offset = 0; offset < candidates.length; offset++) {
    const candidate = candidates[(start + offset) % candidates.length]!;
    if (candidate.eligible) return { kind: "selected", agentId: candidate.agentId, nextLastAssignedAgentId: candidate.agentId, advancePointer: true };
  }
  return { kind: "no-eligible-candidates", nextLastAssignedAgentId: lastAssignedAgentId, advancePointer: false };
}
