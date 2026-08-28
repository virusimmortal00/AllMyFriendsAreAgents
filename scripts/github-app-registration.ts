import path from "node:path";
import { githubAppRegistrationUrl, loadGitHubAppRegistrationTemplate } from "../server/github-app-registration-template.js";

const templatePath = path.resolve(process.argv[2] || "config/github-app-registration.template.json");
const owner = process.argv[3]?.trim() || undefined;
const template = await loadGitHubAppRegistrationTemplate(templatePath);

process.stdout.write(`${githubAppRegistrationUrl(template, owner)}\n\nBefore creating the App:\n1. Verify it is installable on Any account.\n2. Leave expiring user authorization tokens enabled.\n3. Enable Device Flow.\n4. Keep webhooks inactive and every selected permission read-only.\n\nAfter GitHub creates the App, copy its public Client ID into config/github-app.json.\n`);
