import { defineConfig } from "vite"

export default defineConfig({
  base: "./",
  build: { target: "esnext", outDir: "dist/labs/getaway", emptyOutDir: true },
  server: {
    allowedHosts: true,
    proxy: { "/ws": { target: "ws://localhost:8787", ws: true }, "/api": { target: "http://localhost:8787" } },
  },
})
