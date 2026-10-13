import { defineConfig } from "vite"

export default defineConfig({
  base: "./",
  build: {
    target: "esnext", outDir: "dist/arcade/getaway", emptyOutDir: true,
    rollupOptions: { input: { main: new URL("./index.html", import.meta.url).pathname, compare: new URL("./compare.html", import.meta.url).pathname, lab: new URL("./lab.html", import.meta.url).pathname } },
  },
  server: {
    allowedHosts: true,
    proxy: { "/ws": { target: "ws://localhost:8787", ws: true }, "/api": { target: "http://localhost:8787" } },
  },
})
