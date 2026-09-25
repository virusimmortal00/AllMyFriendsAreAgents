/** Room-level preparation state before any participant generation becomes active. */
export interface ConversationActivity {
  phase: "queued" | "deciding";
}
