import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { appFixtureResponse } from "./app-fixtures";

export default defineConfig({
  plugins: [react(), {
    name: "fictional-app-api",
    configureServer(server) {
      // Allow interactive verification against the same isolated fixture. Never proxy a live API.
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith("/api/")) return next();
        response.setHeader("Content-Type", "application/json");
        const scenario = new URL(request.headers.referer || "http://fixture.invalid").searchParams.get("scenario") || "room-chat";
        const result = appFixtureResponse(request.url, request.method || "GET", scenario);
        response.statusCode = result.status;
        response.end(JSON.stringify(result.body));
      });
    },
  }],
  server: { host: "127.0.0.1", port: 4187, strictPort: true },
});
