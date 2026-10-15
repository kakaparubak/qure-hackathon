import { defineConfig } from "vitest/config";

// Dipisah dari vite.config.ts supaya plugin Tailwind/React tidak ikut dimuat saat tes.
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});