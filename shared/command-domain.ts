import { isActiveAgentId, type ActiveAgentId } from "./participants.js";

export const ROOM_COMMANDS = ["task", "pov", "poll", "help"] as const;
export type RoomCommandName = typeof ROOM_COMMANDS[number];

export interface RoomCommandCatalogEntry {
  readonly command: RoomCommandName;
  readonly summary: string;
  readonly syntax: string;
  readonly example: string;
}

const COMMAND_CATALOG: Readonly<Record<RoomCommandName, RoomCommandCatalogEntry>> = {
  help: { command: "help", summary: "List the room commands currently available to you.", syntax: "/help", example: "/help" },
  task: { command: "task", summary: "Delegate bounded work to one eligible agent.", syntax: "/task [@agent] <bounded work>", example: "/task @Sol check the error path" },
  pov: { command: "pov", summary: "Request bounded perspectives from eligible agents.", syntax: "/pov <question>", example: "/pov What tradeoff are we missing?" },
  poll: { command: "poll", summary: "Create a server-authoritative poll with quoted options.", syntax: '/poll "Question" "Option A" "Option B"', example: '/poll "Ship today?" "Yes" "No"' },
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
${entries.map((entry) => `- ${entry.command}: ${entry.summary} Structured example: ${structuredExample(entry.command)} Human syntax example (never emit it): ${entry.example}`).join("\n")}`;
}

function structuredExample(command: RoomCommandName) {
  if (command === "help") return '{"command":"help"}';
  if (command === "task") return '{"command":"task","prompt":"Check the error path","selection":{"kind":"pinned","agentId":"codex-sol"}}';
  if (command === "pov") return '{"command":"pov","prompt":"What tradeoff are we missing?"}';
  return '{"command":"poll","question":"Ship today?","options":["Yes","No"]}';
}

export type CommandInvocation =
  | { readonly command: "task"; readonly prompt: string; readonly selection: { readonly kind: "round-robin" } | { readonly kind: "pinned"; readonly agentId: ActiveAgentId } }
  | { readonly command: "pov"; readonly prompt: string }
  | { readonly command: "poll"; readonly question: string; readonly options: readonly [string, string, ...string[]] }
  | { readonly command: "help" };

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
  if (command === "poll") return parsePoll(rest);
  if (command === "pov") return rest && rest.length <= MAX_PROMPT_LENGTH
    ? { kind: "command", invocation: { command: "pov", prompt: rest } }
    : { kind: "private-error", message: rest ? `Keep /pov prompts under ${MAX_PROMPT_LENGTH} characters.` : "Add a prompt after /pov." };
  if (rest.startsWith("@")) {
    const pinned = /^@([^\s]+)(?:\s+([\s\S]*))?$/.exec(rest);
    if (!pinned || !isActiveAgentId(pinned[1])) return { kind: "private-error", message: "Choose a roster agent after /task, or omit @agent for round-robin." };
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
  if (input.command === "pov" && typeof input.prompt === "string") return parseCommand(`/pov ${input.prompt}`);
  if (input.command === "task" && typeof input.prompt === "string" && (input.selection?.kind === "round-robin" || input.selection?.kind === "pinned" && isActiveAgentId(input.selection.agentId))) {
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
}

export const ALLOW_ALL_COMMANDS: CommandPermissions = { allowAll: true, allowed: ROOM_COMMANDS };

export function validCommandPermissions(input: unknown): input is CommandPermissions {
  if (!input || typeof input !== "object") return false;
  const value = input as { allowAll?: unknown; allowed?: unknown };
  if (typeof value.allowAll !== "boolean") return false;
  if (value.allowAll && value.allowed === undefined) return true;
  if (!Array.isArray(value.allowed)) return false;
  return value.allowed.every((command) => typeof command === "string" && ROOM_COMMANDS.includes(command as RoomCommandName))
    && new Set(value.allowed).size === value.allowed.length;
}

export function normalizeCommandPermissions(input: unknown): CommandPermissions {
  if (input === undefined || input === null) return ALLOW_ALL_COMMANDS;
  if (!validCommandPermissions(input)) return { allowAll: false, allowed: [] };
  const value = input as { allowAll?: unknown; allowed?: unknown };
  if (value.allowAll) return ALLOW_ALL_COMMANDS;
  if (!Array.isArray(value.allowed)) return { allowAll: false, allowed: [] };
  const allowed = [...new Set(value.allowed.filter((candidate): candidate is RoomCommandName => typeof candidate === "string" && ROOM_COMMANDS.includes(candidate as RoomCommandName)))].sort((left,right)=>ROOM_COMMANDS.indexOf(left)-ROOM_COMMANDS.indexOf(right));
  return { allowAll: false, allowed };
}

export function effectiveAllowedCommands(agent: CommandPermissions, ceiling: readonly RoomCommandName[]) {
  const ceilingSet = new Set(ceiling);
  const requested = agent.allowAll ? ROOM_COMMANDS : agent.allowed;
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
