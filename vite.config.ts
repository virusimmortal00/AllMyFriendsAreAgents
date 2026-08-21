import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const allowedHosts = (process.env.ALL_MY_FRIENDS_ARE_AGENTS_ALLOWED_HOSTS || "")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);
const webPort = Number(process.env.ALL_MY_FRIENDS_ARE_AGENTS_WEB_PORT || 4173);
const apiPort = Number(process.env.ALL_MY_FRIENDS_ARE_AGENTS_PORT || process.env.AGENTWIRE_PORT || 53147);

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: webPort,
    ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
    proxy: {
      "/api": `http://127.0.0.1:${apiPort}`,
    },
  },
});
