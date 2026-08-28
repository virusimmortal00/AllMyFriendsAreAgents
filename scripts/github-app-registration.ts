import path from "node:path";
import { githubAppRegistrationUrl, loadGitHubAppRegistrationTemplate } from "../server/github-app-registration-template.js";

const templatePath = path.resolve(process.argv[2] || "config/github-app-registration.template.json");
const owner = process.argv[3]?.trim() || undefined;
const template = await loadGitHubAppRegistrationTemplate(templatePath);

process.stdout.write(`${githubAppRegistrationUrl(template, owner)}\n\nAfter GitHub creates the App:\n1. Leave expiring user authorization tokens enabled.\n2. Enable Device Flow.\n3. Copy the public Client ID into config/github-app.json.\n`);
