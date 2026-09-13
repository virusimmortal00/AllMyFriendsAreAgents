import type express from "express";

const RELEASE_DOWNLOAD_BASE = "https://github.com/virusimmortal00/AllMyFriendsAreAgents/releases/latest/download";

export const INSTALLER_DOWNLOADS = {
  "/install.sh": `${RELEASE_DOWNLOAD_BASE}/install-native.sh`,
  "/install.ps1": `${RELEASE_DOWNLOAD_BASE}/install-windows.ps1`,
} as const;

export function registerInstallerRedirects(app: express.Express) {
  for (const [route, download] of Object.entries(INSTALLER_DOWNLOADS)) {
    app.get(route, (request, response, next) => {
      if (request.path !== route) return next();
      return response.set("Cache-Control", "no-store").redirect(302, download);
    });
  }
}
