import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The API serves the built app under /dashboard/, so asset URLs must carry
  // the same prefix or the browser requests /assets/* from the root and gets
  // Fastify's 404 - a blank white page with no console hint on the server.
  base: "/dashboard/",
});
