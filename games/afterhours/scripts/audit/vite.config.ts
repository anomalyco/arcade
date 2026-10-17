// Frozen audit build: the game page and scripts/audit/audit.html (game + registry global), served from "/".
//   bunx vite build -c scripts/audit/vite.config.ts --outDir $TMPDIR/ah-audit/build
import { defineConfig } from "vite"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../..", import.meta.url))
export default defineConfig({
  root,
  base: "/",
  build: { target: "esnext", emptyOutDir: true, chunkSizeWarningLimit: 4000, rollupOptions: { input: [`${root}index.html`, `${root}look.html`, `${root}scripts/audit/audit.html`] } },
})
