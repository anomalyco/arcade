import { defineConfig } from "vite"

export default defineConfig({
  base: "./",
  build: { target: "esnext", outDir: "dist/arcade/afterhours", emptyOutDir: true, chunkSizeWarningLimit: 2000, rollupOptions: { input: ["index.html", "look.html", "body.html", "bodyb.html"] } },
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
})
