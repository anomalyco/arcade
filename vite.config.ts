import { defineConfig } from "vite"

export default defineConfig({
  base: "./",
  build: { target: "esnext", outDir: "dist/labs/blackout", emptyOutDir: true },
  server: {
    allowedHosts: true,
    proxy: { "/ws": { target: "ws://localhost:8788", ws: true }, "/api": { target: "http://localhost:8788" } },
  },
})
