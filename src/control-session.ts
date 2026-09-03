import { useEffect, useSyncExternalStore } from "react";
import { ApiRequestError, clearControlSessionState, isControlMutationPending, loadControlMe, loadControlStatus } from "./api";
import { controlSessionRevision, controlSessionSnapshot, subscribeControlSession, updateControlSession } from "./control-session-state";

let refreshing: Promise<void> | null = null;
export function refreshControlSession(): Promise<void> {
  if (isControlMutationPending()) return Promise.resolve();
  if (refreshing) return refreshing;
  refreshing = (async () => {
    let revision = controlSessionRevision();
    try {
      const status = await loadControlStatus();
      if (isControlMutationPending() || revision !== controlSessionRevision()) return;
      updateControlSession({ status, error: "" });
      revision = controlSessionRevision();
      await loadControlMe();
    } catch (failure) {
      if (failure instanceof ApiRequestError && failure.status === 401) return;
      if (isControlMutationPending() || revision !== controlSessionRevision()) return;
      clearControlSessionState();
      updateControlSession({ error: "Server administration status could not be checked. Try again." });
    }
  })().finally(() => { refreshing = null; });
  return refreshing;
}

export function useControlSession(refreshOnMount = true) {
  const state = useSyncExternalStore(subscribeControlSession, controlSessionSnapshot, controlSessionSnapshot);
  useEffect(() => {
    if (refreshOnMount) void refreshControlSession();
    const refresh = () => { void refreshControlSession(); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refreshOnMount]);
  useEffect(() => {
    if (!state.session) return;
    const remaining = Date.parse(state.session.expiresAt) - Date.now();
    if (!Number.isFinite(remaining)) return;
    const timer = window.setTimeout(() => {
      // The server decides whether the session expired. A skewed browser clock
      // must not repeatedly clear a session the server still considers valid.
      void refreshControlSession();
    }, remaining > 0 ? Math.min(remaining, 2_147_483_647) : 60_000);
    return () => window.clearTimeout(timer);
  }, [state.session]);
  return state;
}
