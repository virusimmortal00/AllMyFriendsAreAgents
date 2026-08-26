import { providerDisplayName } from "../shared/model-presentation";

export type AgentListSort = "room" | "name" | "maker" | "provider";

export const AGENT_LIST_SORT_OPTIONS: readonly { value: AgentListSort; label: string }[] = [
  { value: "room", label: "Room order" },
  { value: "name", label: "Name A–Z" },
  { value: "maker", label: "Model maker" },
  { value: "provider", label: "Access provider" },
];

const STORAGE_KEY = "all-my-friends-are-agents-agent-list-view";
const VALID_SORTS = new Set<AgentListSort>(AGENT_LIST_SORT_OPTIONS.map(({ value }) => value));

export interface AgentListDisplayItem {
  readonly agentId: string;
  readonly alias: string;
  readonly authorId?: string;
  readonly providerId?: string;
}

export function sortAgentListItems<T extends AgentListDisplayItem>(items: readonly T[], sort: AgentListSort): T[] {
  if (sort === "room") return [...items];
  return items.map((item, position) => ({ item, position })).sort((left, right) => {
    const group = sort === "maker"
      ? providerDisplayName(left.item.authorId).localeCompare(providerDisplayName(right.item.authorId))
      : sort === "provider"
        ? providerDisplayName(left.item.providerId).localeCompare(providerDisplayName(right.item.providerId))
        : 0;
    return group || left.item.alias.localeCompare(right.item.alias) || left.position - right.position;
  }).map(({ item }) => item);
}

export function agentListGroupLabel(item: AgentListDisplayItem, sort: AgentListSort) {
  if (sort === "maker") return providerDisplayName(item.authorId);
  if (sort === "provider") return providerDisplayName(item.providerId);
  return undefined;
}

export function loadAgentListSort(storage: Pick<Storage, "getItem"> | undefined): AgentListSort {
  if (!storage) return "room";
  try {
    const value = JSON.parse(storage.getItem(STORAGE_KEY) || "null") as { version?: unknown; sort?: unknown } | null;
    return value?.version === 1 && VALID_SORTS.has(value.sort as AgentListSort) ? value.sort as AgentListSort : "room";
  } catch {
    return "room";
  }
}

export function saveAgentListSort(storage: Pick<Storage, "setItem"> | undefined, sort: AgentListSort) {
  storage?.setItem(STORAGE_KEY, JSON.stringify({ version: 1, sort }));
}
