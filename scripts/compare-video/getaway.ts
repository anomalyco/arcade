import ts from "typescript"
import type { Page } from "playwright-core"
import { createHash } from "node:crypto"

// These hooks are patched in HTTP responses only. No renderer or checkout is edited.
function legacy(source: string) {
  for (const anchor of ["void paintAtlas().then", "const cam = new Camera()", "let last = performance.now()"])
    if (!source.includes(anchor)) throw new Error(`Unsupported historical Getaway main: missing ${anchor}; use a compatible ref.`)
  source = source
    .replace("void paintAtlas().then", "const atlasReady = paintAtlas().then")
    .replace(/const staged = [^;\n]+/, "const staged = true")
    .replace("const cam = new Camera()", "let cam = new Camera()")
  if (!/import\s*\{\s*applyStage/.test(source)) source = 'import { applyStage } from "/src/game/stage.ts";\n' + source
  return source.replace(
    "let last = performance.now()",
    `
  window.__getawayBench = {
    ready: atlasReady, adapterInfo: {vendor:adapter.info.vendor, architecture:adapter.info.architecture, device:adapter.info.device, description:adapter.info.description},
    reset() {
      let seed = 1337;
      Math.random = () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
      const local = new LocalSession("Dax", {robber:"muscle",cop:"cruiser"}, 7);
      applyStage(local.world,"chase");
      local.world.cops().forEach((c,i) => { const p = [[225,139,.08],[231,131,-.06],[226,122,.04]][i]; if(p) Object.assign(c.body,{x:p[0],z:p[1],h:p[2],vx:0,vz:28}); });
      local.world.seen = true; local.world.lastSeen = {x:226,z:150,t:local.world.t};
      Object.assign(local.world.heli,{active:true,x:246,y:18,z:162,h:-1.6,sx:229,sz:174});
      local.prev = local.curr = local.world.view(local.myId); session = local;
      for (const key of ["puffs","alpha","add","skids"]) if(scene.fx[key]) scene.fx[key].length=0;
      scene.vis.clear(); scene.time=0; scene.shake=0; cam=new Camera(); snapped=false;
    },
    async step(i,dt=1/30,waitGpu=false) {
      const local = session;
      const input = {throttle:1,brake:0,steer:0,handbrake:false,boost:false,gadget:null,engine:false};
      const view = local.update(dt,input);
      const focus = view.cars.find(c=>c.ownerId===local.myId && !c.ghost);
      if(focus) { if(!snapped) {cam.snap(focus.x,focus.z);snapped=true;} cam.update(focus.x,focus.z,focus.vx,focus.vz,dt); }
      if(scene.shake>0) {cam.bump(scene.shake);scene.shake=0;}
      scene.draw(view,cam,canvas.width,canvas.height,dt,focus);
      local.drainEvents();
      if(waitGpu) await device.queue.onSubmittedWorkDone();
    }
  };
  return;
  let last = performance.now()`,
  )
}

/** AST anchors also work in minified production bundles; unknown hook shapes fail closed. */
export function instrumentGetaway(source: string): string {
  if (!source.includes("__getawayBench")) source = legacy(source)
  const file = ts.createSourceFile("main.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const all: ts.Node[] = []
  const visit = (node: ts.Node) => {
    all.push(node)
    ts.forEachChild(node, visit)
  }
  visit(file)
  const assignment = all.find(
    (n): n is ts.BinaryExpression =>
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      n.left.getText(file).endsWith(".__getawayBench") &&
      ts.isObjectLiteralExpression(n.right),
  )
  if (!assignment || !ts.isObjectLiteralExpression(assignment.right)) throw new Error("Unsupported __getawayBench assignment")
  const methods = assignment.right.properties
  const reset = methods.find((n) => n.name?.getText(file) === "reset")
  const step = methods.find((n) => n.name?.getText(file) === "step")
  if (!reset || !step) throw new Error("Missing benchmark reset/step")
  const inside = (parent: ts.Node, node: ts.Node) => node.pos >= parent.pos && node.end <= parent.end
  const localNew = all.find((n): n is ts.NewExpression => inside(reset, n) && ts.isNewExpression(n) && n.arguments?.length === 3)
  if (!localNew) throw new Error("Cannot find benchmark LocalSession constructor")
  const className = localNew.expression.getText(file)
  const edits: { start: number; end: number; text: string }[] = []
  const replace = (n: ts.Node, text: string) => edits.push({ start: n.getStart(file), end: n.end, text })
  for (const n of all) {
    if (ts.isNewExpression(n) && n.expression.getText(file) === className && n.arguments) {
      if (n.arguments.length === 3) replace(n.arguments[2]!, "window.__compareVideo.seed")
      else if (n.arguments.length === 2) edits.push({ start: n.end - 1, end: n.end - 1, text: ", window.__compareVideo.seed" })
    }
    if (inside(reset, n) && ts.isNumericLiteral(n) && n.text === "1337") replace(n, "window.__compareVideo.seed")
  }
  const input = all.find(
    (n): n is ts.ObjectLiteralExpression =>
      inside(step, n) && ts.isObjectLiteralExpression(n) && n.properties.some((p) => p.name?.getText(file) === "throttle"),
  )
  const update = all.find(
    (n): n is ts.CallExpression =>
      inside(step, n) &&
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "update" &&
      n.arguments.length === 2,
  )
  const draw = all.find(
    (n): n is ts.CallExpression =>
      inside(step, n) && ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "draw",
  )
  if (!input || !update || !draw) throw new Error("Unsupported benchmark input/update/draw; use the source ref instead")
  replace(input, "window.__compareVideo.input")
  replace(update, `(window.__compareVideo.lastView = window.__compareVideo.view ?? ${update.getText(file)})`)
  const camera = draw.arguments[1]!.getText(file)
  const keys = JSON.stringify(["fx", "fz", "dist", "fov", "lx", "lz", "t", "shake", "landing"])
  replace(
    draw,
    `(window.__compareVideo.camera && Object.assign(${camera},window.__compareVideo.camera), window.__compareVideo.lastCamera = Object.fromEntries(${keys}.map(k=>[k,${camera}[k] ?? 0])), window.__compareVideo.draw(${camera}, () => ${draw.getText(file)}))`,
  )
  edits.sort((a, b) => b.start - a.start)
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i]!
    if (i && e.end > edits[i - 1]!.start) throw new Error("Overlapping benchmark hook edits")
    source = source.slice(0, e.start) + e.text + source.slice(e.end)
  }
  return source.replace(/\/\/# sourceMappingURL=.*$/gm, "")
}

export const getaway = {
  async install(page: Page, seed: number, zoom = 1) {
    await page.addInitScript(
      ({ seed, zoom }) => {
        ;(window as any).__compareVideo = {
          seed,
          // Change projection only while drawing. Replay and camera smoothing retain the unzoomed state.
          draw(camera: { fov: number }, draw: () => unknown) {
            const fov = camera.fov
            camera.fov = 2 * Math.atan(Math.tan(fov / 2) / zoom)
            try {
              return draw()
            } finally {
              camera.fov = fov
            }
          },
        }
        // Seed atlas/scene creation too, not just the session reset.
        let s = seed
        Math.random = () => {
          s |= 0
          s = (s + 0x6d2b79f5) | 0
          let t = Math.imul(s ^ (s >>> 15), 1 | s)
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296
        }
      },
      { seed, zoom },
    )
    let patched = false
    let hookSourceSha256 = ""
    let failure: Error | undefined
    await page.route(/\/(?:src\/main\.ts|assets\/[^/?]+\.js)(?:\?.*)?$/, async (route) => {
      try {
        const response = await route.fetch()
        let source = await response.text()
        if (source.includes("__getawayBench") || new URL(route.request().url()).pathname === "/src/main.ts") {
          hookSourceSha256 = createHash("sha256").update(source).digest("hex")
          source = instrumentGetaway(source)
          patched = true
        }
        await route.fulfill({ response, body: source })
      } catch (error) {
        failure = error as Error
        await route.abort()
      }
    })
    // A live preview must not reload halfway through a recording.
    await page.routeWebSocket("**", (socket) => socket.close())
    return async () => {
      if (failure) throw failure
      if (!patched) throw new Error("This URL exposes no supported Getaway benchmark hook. Use ref:<deployed-commit> instead.")
      await page.waitForFunction(() => Boolean((window as any).__getawayBench), null, { timeout: 30_000 })
      const adapter = await page.evaluate(async () => {
        const b = (window as any).__getawayBench
        await b.ready
        b.reset()
        return b.adapterInfo
      })
      return { adapter, hookSourceSha256 }
    }
  },
  async step(page: Page, frame: number, fps: number, input: unknown, replay?: { view: unknown; camera: unknown }) {
    return page.evaluate(
      async ({ frame, fps, input, replay }) => {
        const w = window as any
        Object.assign(w.__compareVideo, { input, view: replay?.view, camera: replay?.camera })
        await w.__getawayBench.step(frame, 1 / fps, true)
        return { view: w.__compareVideo.lastView, camera: w.__compareVideo.lastCamera }
      },
      { frame, fps, input, replay },
    )
  },
  canvas: "#view",
}
