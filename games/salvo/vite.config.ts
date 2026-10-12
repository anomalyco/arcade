import { resolve } from "node:path"
import { defineConfig } from "vite"

export default defineConfig(({ command }) => ({
  // absolute in production so nested room links (/labs/salvo/r/:room) resolve assets
  base: command === "build" ? "/labs/salvo/" : "/",
  build: {
    target: "esnext",
    outDir: "dist/labs/salvo",
    emptyOutDir: true,
    rollupOptions: { input: { main: resolve(import.meta.dirname, "index.html") } },
  },
  server: {
    allowedHosts: true,
    proxy: {
      "/labs/salvo/ws": { target: "ws://localhost:8787", ws: true },
      "/labs/salvo/api": { target: "http://localhost:8787" },
    },
  },
}))
