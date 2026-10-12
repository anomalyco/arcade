import { resolve } from "node:path"
import { defineConfig } from "vite"

export default defineConfig(({ command }) => ({
  // absolute in production so nested room links (/arcade/salvo/r/:room) resolve assets
  base: command === "build" ? "/arcade/salvo/" : "/",
  build: {
    target: "esnext",
    outDir: "dist/arcade/salvo",
    emptyOutDir: true,
    rollupOptions: { input: { main: resolve(import.meta.dirname, "index.html") } },
  },
  server: {
    allowedHosts: true,
    proxy: {
      "/arcade/salvo/ws": { target: "ws://localhost:8787", ws: true },
      "/arcade/salvo/api": { target: "http://localhost:8787" },
    },
  },
}))
