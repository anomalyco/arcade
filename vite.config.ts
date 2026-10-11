import { defineConfig } from "vite"

export default defineConfig({
  base: "/labs/wings/",
  server: {
    port: 5173,
    proxy: {
      "/labs/wings/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    target: "es2022",
  },
})
