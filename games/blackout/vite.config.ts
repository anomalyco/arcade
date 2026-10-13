import { defineConfig } from "vite"

export default defineConfig({
  base: "./",
  build: { target: "esnext", outDir: "dist/arcade/blackout", emptyOutDir: true, rollupOptions: { input: { main: "index.html", compare: "compare.html" } } },
  server: {
    allowedHosts: true,
    // Behind the opentunnel HTTPS route the browser reaches HMR on 443.
    hmr: process.env.TUNNEL ? { clientPort: 443, protocol: "wss" } : undefined,
    proxy: { "/ws": { target: "ws://localhost:8788", ws: true }, "/api": { target: "http://localhost:8788" } },
  },
})
