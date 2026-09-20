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
    const message = messages[sequence];
    if (message === undefined) throw new Error(`Burst message ${sequence} is missing.`);
    const delay = sequence === 0 ? firstDelayMs : continuationDelayMs(message, sequence);
    if (!(await activity.wait(delay, revision))) {
      await cancel();
      return false;
    }
    const delivered = await deliver(message, sequence);
    if (delivered === false) {
      await cancel();
      return false;
    }
  }
  return true;
}
