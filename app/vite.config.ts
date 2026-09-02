import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        // The control view and the projected view are separate documents so the
        // projector can be dragged to another display and carries none of the
        // recognition machinery.
        main: resolve(__dirname, "index.html"),
        projector: resolve(__dirname, "projector.html"),
      },
    },
    // The corpus is fetched at runtime from /data, never bundled.
    assetsInlineLimit: 0,
  },
  worker: { format: "es" },
});
