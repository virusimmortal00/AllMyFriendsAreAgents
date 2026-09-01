import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const basePresenceStyles = styles.slice(styles.indexOf(".presence-row {"), styles.indexOf("@media (max-width: 720px)"));
const mobilePresenceStyles = styles.slice(styles.indexOf("@media (max-width: 720px)"));

describe("presence roster layout contract", () => {
  it("keeps a minimum row size with room for wrapped identity and a stable activity column", () => {
    expect(basePresenceStyles).toMatch(/\.presence-row \{[^}]*min-height: 40px;[^}]*height: auto;/s);
    expect(basePresenceStyles).toMatch(/\.presence-agent-actions \{[^}]*width: 18px;/s);
    expect(basePresenceStyles).toMatch(/\.roster-editor-row\.presence-row \{[^}]*height: auto;/s);
    expect(mobilePresenceStyles).toMatch(/\.presence-row \{[^}]*min-height: 48px;[^}]*height: auto;/s);
  });

  it("wraps primary aliases while secondary metadata remains compact", () => {
    expect(basePresenceStyles).toMatch(/\.presence-identity \.speaker \{[^}]*display: block;[^}]*min-width: 0;/s);
    expect(basePresenceStyles).toMatch(/\.presence-row \.speaker \{[^}]*overflow-wrap: anywhere;[^}]*white-space: normal;/s);
  });
});
