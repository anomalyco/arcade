import { defineConfig } from "vite"

export default defineConfig({
  base: "/arcade/lot/",
  build: {
    outDir: "dist/arcade/lot",
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    host: "127.0.0.1",
    allowedHosts: [".ts.net"],
    fs: { allow: ["../.."] },
  },
})
