import { defineConfig } from "vite"
import { feedbackPlugin } from "./scripts/feedback-plugin"
import { sfxPicksPlugin } from "./scripts/sfx-picks-plugin"

export default defineConfig({
  base: "./",
  plugins: [feedbackPlugin(), sfxPicksPlugin()],
  build: { target: "esnext", outDir: "dist/arcade/carrier", emptyOutDir: true, rolldownOptions: { input: { main: "index.html", ship: "ship.html", menu: "menu.html" } } },
  server: {
    port: 5197,
    strictPort: true,
    allowedHosts: true,
    // No hot reload: many agents edit files at once and every save reloaded the designer's page mid-test. Refresh by
    // hand. HOT=1 brings it back (behind the opentunnel HTTPS route the browser reaches HMR on 443).
    hmr: !process.env.HOT ? false : process.env.TUNNEL ? { clientPort: 443, protocol: "wss" } : undefined,
    proxy: { "/ws": { target: "ws://localhost:8797", ws: true }, "/api": { target: "http://localhost:8797" } },
  },
})
