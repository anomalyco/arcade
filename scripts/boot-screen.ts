import type { Plugin } from "vite"
import { bootScreenBody, bootScreenHead, type BootMarkupOptions } from "../packages/kit/client/boot-screen"

/** Puts the kit boot screen (`@arcade/kit/client/boot-screen`) into index.html so it paints on the first frame, before the game bundle downloads. */
export function bootScreen(options: BootMarkupOptions = {}): Plugin {
  return {
    name: "arcade-boot-screen",
    transformIndexHtml: (html) => html.replace("</head>", `${bootScreenHead(options)}</head>`).replace(/<body([^>]*)>/, (m) => `${m}${bootScreenBody(options)}`),
  }
}
