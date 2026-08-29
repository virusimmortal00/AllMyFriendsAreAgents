import { readFile } from "node:fs/promises";

const PERMISSION = /^[a-z][a-z_]{1,60}$/;
const NAME = /^.{3,100}$/;

export interface GitHubAppRegistrationTemplate {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly description: string;
  readonly homepageUrl: string;
  readonly public: true;
  readonly requestOAuthOnInstall: false;
  readonly webhookActive: false;
  readonly repositoryPermissions: Readonly<Record<string, "read">>;
  readonly postRegistration: {
    readonly enableDeviceFlow: true;
    readonly expireUserAuthorizationTokens: true;
  };
}

export async function loadGitHubAppRegistrationTemplate(filePath: string) {
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  return normalizeTemplate(parsed);
}

/** GitHub supports prefilled registration URLs; device flow is enabled immediately after creation. */
export function githubAppRegistrationUrl(template: GitHubAppRegistrationTemplate, owner?: string) {
  const base = owner
    ? `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new`
    : "https://github.com/settings/apps/new";
  const url = new URL(base);
  url.searchParams.set("name", template.name);
  url.searchParams.set("description", template.description);
  url.searchParams.set("url", template.homepageUrl);
  url.searchParams.set("public", "true");
  url.searchParams.set("request_oauth_on_install", "false");
  url.searchParams.set("webhook_active", "false");
  for (const [permission, access] of Object.entries(template.repositoryPermissions).sort(([left], [right]) => left.localeCompare(right))) {
    url.searchParams.set(permission, access);
  }
  return url.toString();
}

function normalizeTemplate(value: unknown): GitHubAppRegistrationTemplate {
  if (!value || typeof value !== "object") throw new Error("GitHub App registration template must be an object.");
  const template = value as Partial<GitHubAppRegistrationTemplate>;
  let homepage: URL;
  try { homepage = new URL(String(template.homepageUrl)); } catch { throw new Error("GitHub App homepage URL must be absolute HTTPS."); }
  const permissions = template.repositoryPermissions;
  if (template.schemaVersion !== 1 || typeof template.name !== "string" || !NAME.test(template.name)
    || typeof template.description !== "string" || template.description.length < 10 || template.description.length > 200
    || homepage.protocol !== "https:" || homepage.username || homepage.password
    || template.public !== true || template.requestOAuthOnInstall !== false || template.webhookActive !== false
    || !permissions || typeof permissions !== "object" || Array.isArray(permissions)
    || Object.keys(permissions).length === 0 || Object.entries(permissions).some(([permission, access]) => !PERMISSION.test(permission) || access !== "read")
    || template.postRegistration?.enableDeviceFlow !== true || template.postRegistration.expireUserAuthorizationTokens !== true) {
    throw new Error("GitHub App registration template is not canonical and least-privileged.");
  }
  return structuredClone(template) as GitHubAppRegistrationTemplate;
}
