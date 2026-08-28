import type { ClassicMenuCommand, ClassicMenuDefinition, ClassicMenuSeparator } from "./classic-menu";

export type PresentationMenuCommand = ClassicMenuCommand & { readonly behavior: "presentation" };
export type WorkspaceMenuCommand = ClassicMenuCommand & { readonly behavior: "workspace" };
type GuardedMenuItem<Command> = Command | ClassicMenuSeparator;

export function presentationCommand(command: ClassicMenuCommand): PresentationMenuCommand {
  return { ...command, behavior: "presentation" };
}

export function workspaceCommand(command: ClassicMenuCommand): WorkspaceMenuCommand {
  return { ...command, behavior: "workspace" };
}

function assertBehavior(
  menu: string,
  expected: PresentationMenuCommand["behavior"] | WorkspaceMenuCommand["behavior"],
  items: readonly GuardedMenuItem<PresentationMenuCommand | WorkspaceMenuCommand>[],
) {
  for (const item of items) {
    if (item.type === "separator") continue;
    if (item.behavior !== expected) throw new Error(`${menu} cannot contain ${item.behavior} command “${item.label}”; expected ${expected} commands only.`);
  }
}

/** View is presentation-only by construction; navigation commands do not type-check here. */
export function defineViewMenu(items: readonly GuardedMenuItem<PresentationMenuCommand>[]): ClassicMenuDefinition {
  assertBehavior("View", "presentation", items);
  return { id: "view", label: "View", accessKey: "V", items: [...items] };
}

/** Window is the only application menu for whole-workspace destinations. */
export function defineWindowMenu(items: readonly GuardedMenuItem<WorkspaceMenuCommand>[]): ClassicMenuDefinition {
  assertBehavior("Window", "workspace", items);
  return { id: "window", label: "Window", accessKey: "W", items: [...items] };
}
