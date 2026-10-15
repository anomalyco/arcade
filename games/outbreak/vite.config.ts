import { defineConfig } from "vite"
import { audioAssets } from "../../scripts/audio-assets"
import { textureAssets } from "../../scripts/texture-assets"
import { writeBuildId } from "../../scripts/build-id"

// Co-op clients send this hash of shared/ in hello; a room built from other shared code asks them to reload.
writeBuildId(new URL(".", import.meta.url).pathname)

export default defineConfig({
  plugins: [audioAssets(), textureAssets()],
  base: "./",
  build: {
    target: "esnext",
    outDir: "dist/arcade/outbreak",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: new URL("./index.html", import.meta.url).pathname,
      },
    },
  },
  server: { host: "127.0.0.1", port: Number(process.env.PORT) || 5197, allowedHosts: true },
})
