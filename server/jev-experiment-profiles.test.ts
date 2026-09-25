import { describe, expect, it } from "vitest";
import {
  jevProfileMetadata,
  selectJevExperimentProfiles,
} from "./jev-experiment-profiles.js";

const isolated = {
  NODE_ENV: "test",
  AMFAA_ROUTING_STUDY_ISOLATED: "true",
  ALL_MY_FRIENDS_ARE_AGENTS_HOST: "127.0.0.1",
};

describe("closed Jev experiment profiles", () => {
  it("keeps current behavior when no selector is supplied", () => {
    expect(selectJevExperimentProfiles({})).toEqual({
      questionProfileId: "current-v1", gateProfileId: "current-v1",
    });
  });

  it("accepts only closed IDs in an isolated loopback test server", () => {
    expect(selectJevExperimentProfiles({
      ...isolated, AMFAA_ROUTING_JEV_PROFILE: "relevance-v1", AMFAA_ROUTING_GATE_PROFILE: "relevance-v1",
    })).toEqual({ questionProfileId: "relevance-v1", gateProfileId: "relevance-v1" });
    for (const invalid of [
      { ...isolated, AMFAA_ROUTING_JEV_PROFILE: "unknown-v1" },
      { ...isolated, AMFAA_ROUTING_GATE_PROFILE: "unknown-v1" },
      { ...isolated, AMFAA_ROUTING_GATE_PROFILE: "relevance-v1", AMFAA_ROUTING_JEV_PROFILE: "lean-v1" },
      { ...isolated, NODE_ENV: "production", AMFAA_ROUTING_JEV_PROFILE: "lean-v1" },
      { ...isolated, AMFAA_ROUTING_STUDY_ISOLATED: "false", AMFAA_ROUTING_GATE_PROFILE: "relevance-v1" },
      { ...isolated, ALL_MY_FRIENDS_ARE_AGENTS_HOST: "0.0.0.0", AMFAA_ROUTING_JEV_PROFILE: "lean-v1" },
    ]) expect(() => selectJevExperimentProfiles(invalid)).toThrow();
  });

  it("exports stable scalar IDs and digests without question wording", () => {
    const current = jevProfileMetadata("current-v1", "current-v1");
    const lean = jevProfileMetadata("lean-v1", "current-v1");
    expect(current.jevProfileDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(current.gateProfileDigest).toBe(lean.gateProfileDigest);
    expect(current.jevProfileDigest).not.toBe(lean.jevProfileDigest);
    expect(JSON.stringify(lean)).not.toMatch(/transcript|question|message/i);
  });
});
