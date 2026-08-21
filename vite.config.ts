import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const allowedHosts = (process.env.ALL_MY_FRIENDS_ARE_AGENTS_ALLOWED_HOSTS || "")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4173,
    ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
    proxy: {
      "/api": "http://127.0.0.1:53147",
    },
  },
});
