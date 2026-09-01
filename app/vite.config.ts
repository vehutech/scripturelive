import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "es2022",
    // The corpus is fetched at runtime from /data, never bundled.
    assetsInlineLimit: 0,
  },
  worker: { format: "es" },
});
