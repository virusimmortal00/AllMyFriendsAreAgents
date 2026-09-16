import type { ClassicMenuCommand, ClassicMenuDefinition, ClassicMenuSeparator } from "./classic-menu";

export type PresentationMenuCommand = ClassicMenuCommand & { readonly behavior: "presentation" };
type GuardedMenuItem<Command> = Command | ClassicMenuSeparator;

export function presentationCommand(command: ClassicMenuCommand): PresentationMenuCommand {
  return { ...command, behavior: "presentation" };
}

/** View is presentation-only by construction; commands that open windows or navigate do not type-check here. */
export function defineViewMenu(items: readonly GuardedMenuItem<PresentationMenuCommand>[]): ClassicMenuDefinition {
  for (const item of items) {
    if (item.type === "separator") continue;
    if (item.behavior !== "presentation") throw new Error(`View cannot contain non-presentation command “${item.label}”; expected presentation commands only.`);
  }
  return { id: "view", label: "View", accessKey: "V", items: [...items] };
}
