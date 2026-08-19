import { continuationDelayMs } from "./response-pacing.js";
import type { RoomActivity } from "./room-activity.js";

interface BurstDeliveryOptions {
  messages: string[];
  activity: RoomActivity;
  revision: number;
  firstDelayMs: number;
  deliver: (message: string, sequence: number) => Promise<boolean | void>;
  cancel: () => Promise<void>;
}

export async function deliverBurst({
  messages,
  activity,
  revision,
  firstDelayMs,
  deliver,
  cancel,
}: BurstDeliveryOptions) {
  for (let sequence = 0; sequence < messages.length; sequence += 1) {
    const delay = sequence === 0 ? firstDelayMs : continuationDelayMs(messages[sequence], sequence);
    if (!(await activity.wait(delay, revision))) {
      await cancel();
      return false;
    }
    const delivered = await deliver(messages[sequence], sequence);
    if (delivered === false) {
      await cancel();
      return false;
    }
  }
  return true;
}
