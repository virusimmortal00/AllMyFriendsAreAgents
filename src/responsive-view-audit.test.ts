import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { VIEWS, viewAttributes } from "./view-registry";

const audit = readFileSync(new URL("../docs/design/responsive-view-audit.md", import.meta.url), "utf8");
const VIEW_ID = /^(APP|CHAT|WORK|ROOM|PERSON|GH|AUX)-\d{2}$/;
const QUESTION_HEADERS = ["ID", "Screen use", "Navigation", "Retro style", "Proportion", "Empty area", "Scroll and actions", "Outcome"];
const VIEWPORTS = ["P", "T", "L", "D"].sort();

function tableCells(line: string) {
  if (!line.startsWith("|") || !line.endsWith("|")) return [];
  return line.slice(1, -1).split("|").map((cell) => cell.trim());
}

const rows = audit.split("\n").map(tableCells).filter((cells) => cells.length > 0);
const inventory = rows.filter((cells) => cells.length === 4 && VIEW_ID.test(cells[0])).map(([id, name, state, status]) => ({ id, name, state, status }));
const answers = rows.filter((cells) => cells.length === 8 && VIEW_ID.test(cells[0]));
const sourceDirectory = fileURLToPath(new URL(".", import.meta.url));
const productionViewSource = readdirSync(sourceDirectory, { recursive: true, encoding: "utf8" })
  .filter((path) => path.endsWith(".tsx") && !path.endsWith(".test.tsx"))
  .map((path) => readFileSync(resolve(sourceDirectory, path), "utf8"))
  .join("\n");

function coveredViewports(answer: string) {
  const covered = new Set<string>();
  for (const match of answer.matchAll(/(?:^|[.;]\s+)([PTLD](?:\/[PTLD])*)\s*:/g)) {
    for (const viewport of match[1].split("/")) covered.add(viewport);
  }
  return [...covered].sort();
}

describe("responsive view registry contract", () => {
  it("keeps stable IDs and names unique and every inventory row complete", () => {
    expect(inventory.length).toBeGreaterThan(0);
    expect(new Set(inventory.map(({ id }) => id)).size).toBe(inventory.length);
    expect(new Set(inventory.map(({ name }) => name)).size).toBe(inventory.length);
    for (const view of inventory) {
      expect(view.name, view.id).not.toBe("");
      expect(view.state, view.id).not.toBe("");
      expect(view.status, view.id).toBe("Complete");
    }
  });

  it("keeps the code registry identical to the documented inventory", () => {
    expect(Object.values(VIEWS).map(({ id, name, state }) => ({ id, name, state }))).toEqual(inventory.map(({ id, name, state }) => ({ id, name, state })));
  });

  it("connects every registered view to production markup through the shared attributes", () => {
    for (const key of Object.keys(VIEWS) as Array<keyof typeof VIEWS>) {
      expect(productionViewSource, `${VIEWS[key].id} (${key}) is not attached to a production view`).toContain(`VIEWS.${key}`);
    }
    expect(productionViewSource).not.toMatch(/\bdata-view-(?:id|name|state)\s*=\s*["']/);
    expect(viewAttributes(VIEWS.roomChat)).toEqual({
      "data-view-id": "CHAT-01",
      "data-view-name": "Room Chat",
      "data-view-state": "Transcript, composer, status bar, and desktop Who’s Here rail",
    });
  });

  it("pairs every registered view with exactly one seven-question audit", () => {
    const inventoryIds = inventory.map(({ id }) => id);
    const answerIds = answers.map(([id]) => id);
    expect(answerIds).toEqual(inventoryIds);
    expect(new Set(answerIds).size).toBe(answerIds.length);
    for (const header of rows.filter((cells) => cells[0] === "ID" && cells.length === 8)) expect(header).toEqual(QUESTION_HEADERS);
  });

  it("answers every question explicitly for Phone, Tablet, Short laptop, and Desktop", () => {
    const incomplete: string[] = [];
    for (const [id, ...questionAnswers] of answers) {
      expect(questionAnswers).toHaveLength(7);
      for (const [index, answer] of questionAnswers.entries()) {
        if (JSON.stringify(coveredViewports(answer)) !== JSON.stringify(VIEWPORTS)) incomplete.push(`${id} / ${QUESTION_HEADERS[index + 1]} (${coveredViewports(answer).join("/") || "none"})`);
      }
    }
    expect(incomplete).toEqual([]);
  });
});
