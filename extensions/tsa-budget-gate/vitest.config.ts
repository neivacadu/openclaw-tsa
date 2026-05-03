import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["_legacy-flat-format/**", "node_modules/**", "dist/**", "dist-local/**"],
  },
});
