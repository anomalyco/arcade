import { defineConfig } from "vite"

// The production build is the game alone, served by the Worker (wrangler.jsonc) at anoma.ly/arcade/ashwood/; the lab
// pages (look, body, title-lab, …) are dev-server only. The dev server keeps serving everything at `/`.
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/arcade/ashwood/" : "./",
  build: { target: "esnext", outDir: "dist/arcade/ashwood", emptyOutDir: true, chunkSizeWarningLimit: 2000, rollupOptions: { input: ["index.html"] } },
  server: {
    fs: { allow: ["../.."] },
    allowedHosts: true,
    // Transform every source module as soon as the server starts so the first page load doesn't wait on them.
    warmup: { clientFiles: ["./index.html", "./src/**/*.ts"] },
  },
  optimizeDeps: {
    // Scan every source file, not just what index.html reaches statically: a `three/addons/...` import first met in
    // a lazily loaded world module would otherwise trigger a re-optimise and a full page reload mid-boot.
    entries: ["index.html", "src/**/*.ts"],
    include: ["three/webgpu", "three/tsl"],
  },
}))
