import { describe, expect, it } from "vitest";
import {
  adjacentTranscriptMagnification,
  DEFAULT_TRANSCRIPT_MAGNIFICATION,
  sanitizeTranscriptMagnification,
} from "./transcript-view";

describe("local transcript magnification", () => {
  it("accepts only the local viewing levels", () => {
    expect(sanitizeTranscriptMagnification(125)).toBe(125);
    expect(sanitizeTranscriptMagnification("150")).toBe(150);
    expect(sanitizeTranscriptMagnification(137)).toBe(DEFAULT_TRANSCRIPT_MAGNIFICATION);
  });

  it("steps through levels without exceeding the bounds", () => {
    expect(adjacentTranscriptMagnification(100, 1)).toBe(110);
    expect(adjacentTranscriptMagnification(75, -1)).toBe(75);
    expect(adjacentTranscriptMagnification(150, 1)).toBe(150);
  });
});
