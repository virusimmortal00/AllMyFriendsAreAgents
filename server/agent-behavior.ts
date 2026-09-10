import { AGENT_BEHAVIOR_RULES } from "../shared/agent-behavior.js";

/** Application-owned guidance, independent of optional room customization. */
export function agentBehaviorContext(now: Date = new Date()): string {
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(now);
  return `CURRENT TURN TIME (server clock)
${now.toISOString()} — ${weekday}, UTC. This is the turn's time, not the transcript's time. A participant's local date may differ; do not assume their timezone.

BASE BEHAVIOR RULES
${AGENT_BEHAVIOR_RULES.map((rule) => `- ${rule}`).join("\n")}`;
}
