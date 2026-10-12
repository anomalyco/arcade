import { defineConfig } from "vite"

// Built into dist/arcade so wrangler's assets directory (./dist) serves it at /arcade/.
export default defineConfig({
  base: "/arcade/",
  build: { target: "esnext", outDir: "dist/arcade", emptyOutDir: true },
})
