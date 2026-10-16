import { defineConfig } from "vite"

export default defineConfig({
  base: "./",
  build: { target: "esnext", outDir: "dist/arcade/afterhours", emptyOutDir: true },
  server: { fs: { allow: ["../.."] }, allowedHosts: true },
})
