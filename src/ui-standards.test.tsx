// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { defineViewMenu } from "./application-menu-policy";

const command = { label: "Example", accessKey: "E", onSelect: () => {} };

describe("non-negotiable UI standards", () => {
  it("fails closed when a non-presentation command is placed in View", () => {
    expect(() => defineViewMenu([command as never])).toThrow(/View cannot contain non-presentation command/);
  });

  it("never replaces Chat: the application has no workspace-switching surface", () => {
    const app = readFileSync(resolve(process.cwd(), "src", "App.tsx"), "utf8");
    expect(app).not.toMatch(/WorkspaceSurface|workspaceCommand|defineWindowMenu/);
    expect(app).toContain("<AdministrationWindow");
  });
});
