const SECRET_KEY = "(?:authorization|proxy-authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|auth[-_ ]?token|token|secret|password|passwd|cookie|set-cookie)";
const CREDENTIAL = "(?:Bearer|Basic)\\s+[A-Za-z0-9._~+\\/=-]+";

/** Defense-in-depth redaction for bounded diagnostic text. Server callers remain authoritative. */
export function redactDiagnosticSecrets(input: string) {
  return input
    .replace(/((?:^|\n)(?:cookie|set-cookie)\s*:\s*)[^\r\n]*/gi, "$1[REDACTED]")
    .replace(new RegExp(`(["']?${SECRET_KEY}["']?\\s*[:=]\\s*)(["'])(?:\\\\.|[^"'])*?\\2`, "gi"), "$1$2[REDACTED]$2")
    .replace(new RegExp(`(${SECRET_KEY}\\s*[:=]\\s*)(?:${CREDENTIAL}|[^\\r\\n,;\\s}]+)`, "gi"), "$1[REDACTED]")
    .replace(new RegExp(`\\b${CREDENTIAL}`, "gi"), "[REDACTED CREDENTIAL]")
    .replace(/(?:chain of thought|internal reasoning|hidden reasoning)\s*[:=][^\n]*/gi, "[REDACTED INTERNAL CONTENT]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}
