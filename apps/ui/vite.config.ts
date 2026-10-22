import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev, proxy API calls to a local orchestrator; in production the orchestrator serves dist/.
const api = process.env.CATAPULT_URL ?? "http://127.0.0.1:7700";
const routes = ["/projects", "/schedules", "/jobs", "/sessions", "/actions", "/status", "/stream", "/health"];

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { proxy: Object.fromEntries(routes.map((r) => [r, api])) },
});
