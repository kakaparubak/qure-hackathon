import { defineConfig } from "vite";

export default defineConfig({
  base: "/dashboard/",
  server: { proxy: { "/api": "http://127.0.0.1:3000" } },
});
