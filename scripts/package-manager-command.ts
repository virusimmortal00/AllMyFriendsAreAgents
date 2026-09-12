export interface PackageManagerInvocation {
  readonly command: string;
  readonly args: readonly string[];
}

/** Invoke pnpm through Windows' command interpreter because pnpm is a .cmd shim. */
export function pnpmInvocation(
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  commandInterpreter = process.env.ComSpec,
): PackageManagerInvocation {
  return platform === "win32"
    ? { command: commandInterpreter || "cmd.exe", args: ["/d", "/c", "pnpm", ...args] }
    : { command: "pnpm", args };
}
