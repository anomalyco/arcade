import { defineConfig } from "vite"

// Builds bench/pixel/capture.html from a snapshot root (copied there with capture.ts) into a static folder.
export default defineConfig({
  base: "./",
  build: { target: "esnext", emptyOutDir: true, chunkSizeWarningLimit: 4000, rollupOptions: { input: ["capture.html"] } },
})
