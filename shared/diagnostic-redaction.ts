const SECRET_KEY = "(?:authorization|proxy-authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|auth[-_ ]?token|token|secret|password|passwd|cookie|set-cookie)";
const CREDENTIAL = "(?:Bearer|Basic)\\s+[A-Za-z0-9._~+\\/=-]+";

/** Defense-in-depth authentication-secret redaction for diagnostic text. Server callers remain authoritative. */
export function redactDiagnosticSecrets(input: string) {
  return input
    .replace(/((?:^|[\s,;{[(])(?:cookie|set-cookie)\s*:\s*)[^\r\n]*/gi, "$1[REDACTED]")
    .replace(new RegExp(`(["']?${SECRET_KEY}["']?\\s*[:=]\\s*)(["'])(?:\\\\.|[^"'])*?\\2`, "gi"), "$1$2[REDACTED]$2")
    .replace(new RegExp(`(${SECRET_KEY}\\s*[:=]\\s*)(?:${CREDENTIAL}|[^\\r\\n,;\\s}]+)`, "gi"), "$1[REDACTED]")
    .replace(new RegExp(`\\b${CREDENTIAL}`, "gi"), "[REDACTED CREDENTIAL]")
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9._~-]{8,}\b/gi, "[REDACTED CREDENTIAL]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}
