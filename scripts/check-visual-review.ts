import { readFileSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { validateVisualReview, visualInputDigest } from "./visual-review.js";

try {
  const { values } = parseArgs({ options: { run: { type: "string" }, review: { type: "string" } } });
  if (!values.run || !values.review) throw new Error("Usage: pnpm check:visual-review --run <capture-directory> --review <review.json>");
  const runDirectory = resolve(values.run);
  const errors = validateVisualReview(
    JSON.parse(readFileSync(resolve(runDirectory, "manifest.json"), "utf8")),
    JSON.parse(readFileSync(resolve(values.review), "utf8")),
    visualInputDigest(),
    (key) => {
      const path = resolve(runDirectory, "screenshots", `${key}.png`);
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error("Expected a regular screenshot file.");
      return readFileSync(path);
    },
  );
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("Independent visual reviews passed for every screenshot in the current capture matrix. This does not certify uncovered views or real-device behavior.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Visual review validation failed.");
  process.exitCode = 1;
}
