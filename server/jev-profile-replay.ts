import { decidePreflight, type PreflightInput } from "./preflight-gate.js";

export interface JevThresholdPoint {
  address: number;
  wholeRoom: number;
}

/** Counterfactual routing only. This cannot predict a model's uninvoked reply. */
export function replayJevThresholds(input: Omit<PreflightInput, "config">, points: readonly JevThresholdPoint[]) {
  if (points.length > 16 || points.some(({ address, wholeRoom }) =>
    !Number.isFinite(address) || address < 0 || address > 1 ||
    !Number.isFinite(wholeRoom) || wholeRoom < 0 || wholeRoom > 1
  )) throw new Error("Invalid Jev threshold replay grid.");
  return points.map(({ address, wholeRoom }) => {
    const decision = decidePreflight({
      ...input,
      config: { classifiedAddressThreshold: address, classifiedWholeRoomThreshold: wholeRoom },
    });
    return {
      addressThreshold: address,
      wholeRoomThreshold: wholeRoom,
      requiredCount: decision.decisions.filter(({ outcome, reason }) =>
        outcome === "invoke" && ["required_mention", "required_plain_address", "structured_task_context", "classified_addressed", "explicit_broadcast"].includes(reason)
      ).length,
      optionalCount: decision.decisions.filter(({ outcome, reason }) =>
        outcome === "invoke" && ["recent_thread_affinity", "ambient_selection", "anti_starvation_probe", "fallback"].includes(reason)
      ).length,
      unavailableCount: decision.decisions.filter(({ outcome }) => outcome === "unavailable").length,
    };
  });
}
