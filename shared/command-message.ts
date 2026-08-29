export interface CommandMessageLike {
  readonly id: string;
  readonly speaker: string;
  readonly text: string;
  readonly kind?: string;
}

const COMMAND_DETAIL_SEPARATOR = "\n\n";
const LEGACY_GITHUB_DELIVERY_ID = /^command-delivery:[^:]+:0$/;

export interface CommandMessageDisclosure {
  readonly summary: string;
  readonly detail: string;
  readonly legacy: boolean;
}

export function commandMessageText(summary: string, detail: string) {
  return `${summary.trim()}${COMMAND_DETAIL_SEPARATOR}${detail.trim()}`;
}

export function commandMessageDisclosure(message: CommandMessageLike): CommandMessageDisclosure | undefined {
  if (message.kind === "command") {
    const separator = message.text.indexOf(COMMAND_DETAIL_SEPARATOR);
    if (separator < 0) return { summary: message.text.trim(), detail: "", legacy: false };
    return {
      summary: message.text.slice(0, separator).trim(),
      detail: message.text.slice(separator + COMMAND_DETAIL_SEPARATOR.length).trim(),
      legacy: false,
    };
  }
  if (message.speaker === "system" && (message.kind === undefined || message.kind === "chat") && LEGACY_GITHUB_DELIVERY_ID.test(message.id)) {
    return { summary: "GitHub command result", detail: message.text.trim(), legacy: true };
  }
  return undefined;
}
