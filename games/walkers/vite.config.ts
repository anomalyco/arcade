import { defineConfig } from "vite"

export default defineConfig({
  base: "/arcade/walkers/",
  build: {
    outDir: "dist/arcade/walkers",
    emptyOutDir: true,
    target: "es2022",
  },
  worker: { format: "es" },
  server: {
    allowedHosts: [".ts.net"],
    fs: { allow: ["../.."] },
  },
})
