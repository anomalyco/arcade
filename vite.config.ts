import { resolve } from "node:path"
import { defineConfig } from "vite"

export default defineConfig({
  base: "./",
  build: {
    target: "esnext",
    outDir: "dist/labs/salvo",
    emptyOutDir: true,
    rollupOptions: { input: { main: resolve(__dirname, "index.html") } },
  },
  server: { allowedHosts: true, proxy: { "/labs/salvo/ws": { target: "ws://localhost:8787", ws: true } } },
})
