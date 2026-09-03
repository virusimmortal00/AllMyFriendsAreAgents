import type { ControlSessionProjection, ControlStatus } from "../shared/control-session";

export interface ControlSessionState {
  status: ControlStatus | null;
  session: ControlSessionProjection | null;
  checked: boolean;
  error: string;
}

let state: ControlSessionState = { status: null, session: null, checked: false, error: "" };
let revision = 0;
const listeners = new Set<() => void>();
export const controlSessionSnapshot = () => state;
export const controlSessionRevision = () => revision;
export const subscribeControlSession = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function updateControlSession(update: Partial<ControlSessionState>) {
  state = { ...state, ...update };
  revision++;
  listeners.forEach((listener) => listener());
}
