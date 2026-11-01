import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Read .env from the repository root, shared with the server. Only VITE_* reaches the browser.
  envDir: "../..",
  server: { proxy: { "/api": "http://localhost:8787" } },
});
