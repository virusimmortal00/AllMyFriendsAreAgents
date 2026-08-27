import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const basePresenceStyles = styles.slice(styles.indexOf(".presence-row {"), styles.indexOf("@media (max-width: 720px)"));

describe("presence roster layout contract", () => {
  it("locks desktop rows and reserves a stable activity column", () => {
    expect(basePresenceStyles).toMatch(/\.presence-row \{[^}]*height: 40px;/s);
    expect(basePresenceStyles).toMatch(/\.presence-agent-actions \{[^}]*width: 18px;/s);
    expect(basePresenceStyles).toMatch(/\.roster-editor-row\.presence-row \{[^}]*height: auto;/s);
  });

  it("truncates agent aliases to one line without a multi-line clamp", () => {
    expect(basePresenceStyles).toMatch(/\.presence-identity \.speaker \{[^}]*display: block;[^}]*min-width: 0;/s);
    expect(basePresenceStyles).toMatch(/\.presence-row \.speaker \{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/s);
  });
});
