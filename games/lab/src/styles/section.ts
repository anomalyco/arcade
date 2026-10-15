import { mat4 } from "wgpu-matrix"
import type { LabCommandRegistry } from "@arcade/kit/lab-commands"
import type { LabControl, LabSettings } from "@arcade/kit/lab-panel"
import type { LabWorldObject, SectionFactory } from "@arcade/kit/lab/types"
import { Rng } from "@arcade/kit/sim/rng"
import { supportHeight } from "../../../outbreak/shared/terrain"
import {
  STYLE_LIST,
  STYLE_MODULES,
  STYLE_ORDER,
  createDefaultStyleStates,
  isPeopleStyleId,
  isStyleCameraViewId,
  resolveStyleId,
  type PeopleStyleId,
  type StyleCameraViewId,
  type StyleId,
  type StyleRecipe,
} from "./index"
import { STYLE_HERO_TICK, STYLE_LOOP_DT, STYLE_LOOP_TICKS, StylePlaygroundSim } from "./sim-loop"
import { STYLE_CAMERA_PRESETS, StylePlaygroundRenderer } from "./style-renderer"

const RECIPE_KEYS: readonly (keyof StyleRecipe)[] = [
  "pixelSize",
  "palette",
  "outlineWidth",
  "dither",
  "halftoneSize",
  "rampSteps",
  "fxPunch",
  "pixelSnap",
]

export const stylePlaygroundSection: SectionFactory = context => {
  const { stage, device } = context
  const styleStates = createDefaultStyleStates()
  let activeStyle: StyleId = "tiny-pixel"
  let peopleStyle: PeopleStyleId = "blocky"
  let cameraView: StyleCameraViewId = "room"
  let playing = true
  let seed = 7
  let tuningSeed = 101

  const sim = new StylePlaygroundSim(seed)
  let renderer: StylePlaygroundRenderer | null = null

  function ensureRenderer(): StylePlaygroundRenderer {
    if (!renderer) {
      renderer = new StylePlaygroundRenderer(device, navigator.gpu.getPreferredCanvasFormat())
    }
    return renderer
  }

  function applyCameraPreset(viewId: StyleCameraViewId): void {
    const cfg = STYLE_CAMERA_PRESETS[viewId] ?? STYLE_CAMERA_PRESETS.room
    cameraView = viewId
    stage.focus[0] = cfg.focus[0]
    stage.focus[1] = cfg.focus[1]
    stage.focus[2] = cfg.focus[2]
    stage.targetFocus[0] = cfg.focus[0]
    stage.targetFocus[1] = cfg.focus[1]
    stage.targetFocus[2] = cfg.focus[2]
    stage.camYaw = 0
    stage.targetYaw = 0
    stage.camPitch = cfg.pitch
    stage.targetPitch = cfg.pitch
    stage.camDist = cfg.dist
    stage.targetDist = cfg.dist
    stage.camCustom = false
  }

  function randomizeActiveStyle(explicitSeed?: number) {
    const sVal = Math.max(1, Math.min(9999, Math.round(explicitSeed ?? tuningSeed)))
    const rng = new Rng((sVal * 0x9e3779b9) >>> 0)
    const rec = styleStates[activeStyle]
    rec.pixelSize = Math.round(rng.range(64, 176) / 8) * 8
    rec.palette = rng.int(4)
    rec.outlineWidth = Number((Math.round(rng.range(0.4, 2.4) * 10) / 10).toFixed(1))
    rec.dither = Number((Math.round(rng.range(0.25, 1.25) * 20) / 20).toFixed(2))
    rec.halftoneSize = Number((Math.round(rng.range(3.0, 11.0) * 2) / 2).toFixed(1))
    rec.rampSteps = Math.round(rng.range(2, 6))
    rec.fxPunch = Number((Math.round(rng.range(0.75, 1.65) * 20) / 20).toFixed(2))
    tuningSeed = (sVal % 9999) + 1
    return { style: activeStyle, tuningSeed: sVal, seed, recipe: { ...rec } }
  }

  const settings: LabSettings = {}

  Object.defineProperties(settings, {
    style: {
      enumerable: true,
      get: () => activeStyle,
      set: (val: unknown) => {
        const next = resolveStyleId(val)
        if (next) activeStyle = next
      },
    },
    peopleStyle: {
      enumerable: true,
      get: () => peopleStyle,
      set: (val: unknown) => {
        if (isPeopleStyleId(val)) peopleStyle = val
      },
    },
    cameraView: {
      enumerable: true,
      get: () => cameraView,
      set: (val: unknown) => {
        if (isStyleCameraViewId(val)) cameraView = val
      },
    },
    playing: {
      enumerable: true,
      get: () => playing,
      set: (val: unknown) => {
        playing = Boolean(val)
      },
    },
    loopTime: {
      enumerable: true,
      get: () => sim.loopTime,
      set: (val: unknown) => {
        const num = Number(val)
        if (Number.isFinite(num)) {
          const targetTick = Math.round((Math.max(0, Math.min(7.48, num)) / STYLE_LOOP_DT))
          sim.seekToTick(targetTick)
        }
      },
    },
    seed: {
      enumerable: true,
      get: () => seed,
      set: (val: unknown) => {
        const next = Math.max(1, Math.min(99, Math.round(Number(val) || 7)))
        if (next !== seed) {
          seed = next
          sim.reset(seed, sim.tick)
        }
      },
    },
    tuningSeed: {
      enumerable: true,
      get: () => tuningSeed,
      set: (val: unknown) => {
        const next = Math.max(1, Math.min(9999, Math.round(Number(val) || 101)))
        tuningSeed = next
      },
    },
    pixelSize: {
      enumerable: true,
      get: () => styleStates[activeStyle].pixelSize,
      set: (val: unknown) => {
        const n = Number(val)
        if (Number.isFinite(n)) styleStates[activeStyle].pixelSize = Math.max(48, Math.min(240, Math.round(n)))
      },
    },
    palette: {
      enumerable: true,
      get: () => styleStates[activeStyle].palette,
      set: (val: unknown) => {
        const n = Number(val)
        if (Number.isFinite(n)) styleStates[activeStyle].palette = Math.max(0, Math.min(3, Math.round(n)))
      },
    },
    outlineWidth: {
      enumerable: true,
      get: () => styleStates[activeStyle].outlineWidth,
      set: (val: unknown) => {
        const n = Number(val)
        if (Number.isFinite(n)) styleStates[activeStyle].outlineWidth = Math.max(0, Math.min(3, Number(n.toFixed(2))))
      },
    },
    dither: {
      enumerable: true,
      get: () => styleStates[activeStyle].dither,
      set: (val: unknown) => {
        const n = Number(val)
        if (Number.isFinite(n)) styleStates[activeStyle].dither = Math.max(0, Math.min(1.5, Number(n.toFixed(2))))
      },
    },
    halftoneSize: {
      enumerable: true,
      get: () => styleStates[activeStyle].halftoneSize,
      set: (val: unknown) => {
        const n = Number(val)
        if (Number.isFinite(n)) styleStates[activeStyle].halftoneSize = Math.max(2, Math.min(16, Number(n.toFixed(1))))
      },
    },
    rampSteps: {
      enumerable: true,
      get: () => styleStates[activeStyle].rampSteps,
      set: (val: unknown) => {
        const n = Number(val)
        if (Number.isFinite(n)) styleStates[activeStyle].rampSteps = Math.max(2, Math.min(8, Math.round(n)))
      },
    },
    fxPunch: {
      enumerable: true,
      get: () => styleStates[activeStyle].fxPunch,
      set: (val: unknown) => {
        const n = Number(val)
        if (Number.isFinite(n)) styleStates[activeStyle].fxPunch = Math.max(0, Math.min(2, Number(n.toFixed(2))))
      },
    },
    pixelSnap: {
      enumerable: true,
      get: () => styleStates[activeStyle].pixelSnap,
      set: (val: unknown) => {
        styleStates[activeStyle].pixelSnap = Boolean(val)
      },
    },
  })

  const controls: LabControl[] = [
    {
      key: "style",
      label: "Rendering style",
      group: "Style & Scene",
      type: "select",
      options: STYLE_LIST.map((m, i) => ({ value: m.id, label: `${i + 1} · ${m.name}` })),
      change: val => {
        const next = resolveStyleId(val)
        if (next) {
          activeStyle = next
          context.sync()
        }
      },
    },
    {
      key: "peopleStyle",
      label: "Minimal people",
      group: "Style & Scene",
      type: "select",
      options: [
        { value: "blocky", label: "Chunky Box Figures" },
        { value: "capsule", label: "Minimal Capsules" },
        { value: "pawn", label: "Abstract Board Pawns" },
        { value: "rig", label: "Detailed Shared Rig" },
      ],
      change: () => context.sync(),
    },
    {
      key: "cameraView",
      label: "Camera framing",
      group: "Style & Scene",
      type: "select",
      options: [
        { value: "room", label: "Room cutaway (Target)" },
        { value: "action", label: "Action close-up" },
        { value: "wide", label: "Wide lot cutaway" },
      ],
      change: val => {
        if (isStyleCameraViewId(val)) {
          applyCameraPreset(val)
          context.sync()
        }
      },
    },
    {
      key: "playing",
      label: "Play combat loop",
      group: "Style & Scene",
      change: () => context.sync(),
    },
    {
      key: "loopTime",
      label: "Loop timeline",
      group: "Style & Scene",
      type: "range",
      min: 0,
      max: 7.45,
      step: 0.05,
      unit: "s",
    },
    {
      key: "seed",
      label: "Sim & room seed",
      group: "Style & Scene",
      type: "range",
      min: 1,
      max: 99,
      step: 1,
      unit: "",
    },
    {
      key: "tuningSeed",
      label: "Tuning seed",
      group: "Style & Scene",
      type: "range",
      min: 1,
      max: 9999,
      step: 1,
      unit: "",
    },

    // --- Per-Style Parameters ---
    {
      key: "pixelSize",
      label: "Resolution height",
      group: "Style Parameters",
      type: "range",
      min: 48,
      max: 240,
      step: 8,
      unit: "px",
    },
    {
      key: "palette",
      label: "Colour palette",
      group: "Style Parameters",
      type: "select",
      options: [
        { value: 0, label: "Palette 1 · Default" },
        { value: 1, label: "Palette 2 · Alt A" },
        { value: 2, label: "Palette 3 · Alt B" },
        { value: 3, label: "Palette 4 · Alt C" },
      ],
    },
    {
      key: "outlineWidth",
      label: "Outline / crease width",
      group: "Style Parameters",
      type: "range",
      min: 0,
      max: 3.0,
      step: 0.1,
      unit: "px",
    },
    {
      key: "dither",
      label: "Dither / grain / scanline",
      group: "Style Parameters",
      type: "range",
      min: 0,
      max: 1.5,
      step: 0.05,
      unit: "×",
    },
    {
      key: "halftoneSize",
      label: "Halftone / hatch / grid",
      group: "Style Parameters",
      type: "range",
      min: 2.0,
      max: 16.0,
      step: 0.5,
      unit: "px",
    },
    {
      key: "rampSteps",
      label: "Light ramp steps",
      group: "Style Parameters",
      type: "range",
      min: 2,
      max: 8,
      step: 1,
      unit: "",
    },
    {
      key: "fxPunch",
      label: "Impact & muzzle FX",
      group: "Style Parameters",
      type: "range",
      min: 0,
      max: 2.0,
      step: 0.05,
      unit: "×",
    },
    {
      key: "pixelSnap",
      label: "Pixel-snapped camera",
      group: "Style Parameters",
    },
    {
      key: "randomizeStyle",
      label: "Randomize style parameters",
      group: "Style Parameters",
      type: "action",
      run: () => {
        context.transact?.(`Randomize ${activeStyle}`, () => {
          randomizeActiveStyle()
        })
        context.sync()
      },
    },
    {
      key: "resetStyle",
      label: "Reset style defaults",
      group: "Style Parameters",
      type: "action",
      run: () => {
        context.transact?.(`Reset ${activeStyle}`, () => {
          styleStates[activeStyle] = { ...STYLE_MODULES[activeStyle].defaults }
        })
        context.sync()
      },
    },
  ]

  const sceneObjects = (): LabWorldObject[] => {
    const p = sim.view.player
    const town = sim.view.town
    const list: LabWorldObject[] = [
      {
        id: "survivor",
        label: "Survivor (Player)",
        category: "character",
        x: p.x,
        y: supportHeight(town, p.x, p.y),
        z: p.y,
        yaw: p.aim,
        radius: 0.65,
        movable: true,
      },
    ]
    sim.view.zombies.forEach((z, idx) => {
      list.push({
        id: `zombie:${z.id}`,
        label: `Zombie ${idx + 1} (${z.state})`,
        category: "character",
        x: z.x,
        y: supportHeight(town, z.x, z.y),
        z: z.y,
        yaw: z.aim,
        radius: 0.6,
        movable: true,
      })
    })
    return list
  }

  let selectedObjectId = "survivor"
  let frameCounter = 0

  return {
    id: "styles",
    label: "Styles",
    settings,
    controls,
    get selectedObjectId() {
      return selectedObjectId
    },
    set selectedObjectId(v: string) {
      selectedObjectId = v
    },
    objects: sceneObjects,
    selectObject(id) {
      if (id) selectedObjectId = id
    },
    moveObject(id, x, z, yaw) {
      if (id === "survivor") {
        sim.view.player.x = Math.max(22.5, Math.min(36.2, x))
        sim.view.player.y = Math.max(24.5, Math.min(35.0, z))
        if (typeof yaw === "number" && Number.isFinite(yaw)) sim.view.player.aim = yaw
        return true
      }
      if (id.startsWith("zombie:")) {
        const zid = Number(id.slice("zombie:".length))
        const agent = sim.view.zombies.find(a => a.id === zid)
        if (agent) {
          agent.x = Math.max(22.5, Math.min(36.2, x))
          agent.y = Math.max(24.5, Math.min(35.0, z))
          if (typeof yaw === "number" && Number.isFinite(yaw)) agent.aim = yaw
          return true
        }
      }
      return false
    },
    groundHeight: (x, z) => supportHeight(sim.view.town, x, z),
    frameTarget: () => {
      const cfg = STYLE_CAMERA_PRESETS[cameraView] ?? STYLE_CAMERA_PRESETS.room
      return { x: cfg.focus[0], y: cfg.focus[1], z: cfg.focus[2], dist: cfg.dist }
    },
    retrigger: () => {
      sim.reset(seed, STYLE_HERO_TICK)
    },
    reroll: () => {
      seed = (seed % 99) + 1
      sim.reset(seed, STYLE_HERO_TICK)
      context.sync()
    },
    enter() {
      const r = ensureRenderer()
      applyCameraPreset(cameraView)
      stage.cameraOverride = (w, h, vp, inverse, eye, focus) => {
        r.cam.x = focus[0]!
        r.cam.z = focus[2]!
        r.cam.pitch = stage.camPitch
        r.cam.dist = stage.camDist
        r.cam.zoomOffset = 0
        r.cam.update(w / Math.max(1, h))
        vp.set(r.cam.viewProj)
        mat4.inverse(r.cam.viewProj, inverse)
        eye.set(r.cam.eye)
      }
      stage.customRender = (w, h, outputView, _outputTex, _debug, measure) => {
        const shouldMeasure = Boolean(measure || frameCounter++ % 3 === 0)
        return r.render({
          sim,
          styleId: activeStyle,
          recipe: styleStates[activeStyle],
          peopleStyle,
          focus: [stage.focus[0]!, stage.focus[1]!, stage.focus[2]!],
          camPitch: stage.camPitch,
          camDist: stage.camDist,
          width: w,
          height: h,
          outputView,
          measure: shouldMeasure,
        })
      }
    },
    leave() {
      stage.customRender = undefined
      stage.cameraOverride = undefined
    },
    update(dt) {
      if (playing) {
        sim.step(dt)
      }
    },
    prepare() {},
    telemetry: () => {
      const mod = STYLE_MODULES[activeStyle]
      const rec = styleStates[activeStyle]
      const gpuMs = renderer?.perStyleGpuMs.get(activeStyle) ?? renderer?.lastStyleGpuMs ?? null
      const gpuStr = gpuMs !== null ? `${gpuMs.toFixed(2)} ms` : "—"
      const alive = sim.view.zombies.filter(z => z.state !== "dead").length
      return `Styles · ${mod.name} (${peopleStyle}) · tick ${sim.tick}/${STYLE_LOOP_TICKS} · style GPU ${gpuStr} {"style":"${activeStyle}","people":"${peopleStyle}","pixelSize":${rec.pixelSize},"zombiesAlive":${alive},"shots":${sim.view.shots.length}}`
    },
    registerCommands(commands: LabCommandRegistry) {
      commands.registerAll([
        {
          id: "style.preset",
          label: "Select Style Playground Rendering Style",
          shortLabel: "Style Preset",
          category: "Preset",
          undoable: true,
          args: {
            style: {
              type: "value",
              required: true,
              description: `Style ID or number 1..9 (${STYLE_ORDER.join(", ")})`,
            },
            people: {
              type: "string",
              required: false,
              enum: ["blocky", "capsule", "pawn", "rig"],
              description: "Optional minimal people shape override",
            },
            focus: {
              type: "boolean",
              required: false,
              description: "Focus corresponding tile when variation grid is open",
            },
          },
          enabled: () => true,
          run: (_ctx, args) => {
            const next = resolveStyleId(args?.style)
            if (!next) {
              throw new Error(`Unknown style "${String(args?.style)}". Expected 1..9 or one of: ${STYLE_ORDER.join(", ")}.`)
            }
            activeStyle = next
            if (isPeopleStyleId(args?.people)) {
              peopleStyle = args.people
            }
            const mod = STYLE_MODULES[activeStyle]
            if (args?.focus !== false && commands.get("grid.focus")?.enabled({} as never)) {
              commands.invoke("grid.focus", { tile: mod.index + 1 })
            } else {
              context.sync()
            }
            return {
              style: activeStyle,
              index: mod.index + 1,
              name: mod.name,
              peopleStyle,
              recipe: { ...styleStates[activeStyle] },
              scaling: mod.scaling,
            }
          },
        },
        {
          id: "style.set",
          label: "Set Style Playground Parameter",
          shortLabel: "Set Style Param",
          category: "Inspector",
          undoable: true,
          args: {
            key: {
              type: "string",
              required: true,
              description: "Parameter key (pixelSize, palette, outlineWidth, dither, halftoneSize, rampSteps, fxPunch, pixelSnap, peopleStyle, loopTime, playing)",
            },
            value: {
              type: "value",
              required: true,
              description: "New parameter value",
            },
          },
          enabled: () => true,
          run: (_ctx, args) => {
            const key = String(args?.key ?? "").trim()
            if (!(key in settings)) {
              throw new Error(`Unknown style parameter "${key}".`)
            }
            const before = settings[key]
            settings[key] = args?.value as string | number | boolean
            context.sync()
            return { key, before, value: settings[key], style: activeStyle }
          },
        },
        {
          id: "style.randomize",
          label: "Randomize Active Style Parameters",
          shortLabel: "Randomize Style",
          category: "Preset",
          undoable: true,
          args: {
            seed: {
              type: "number",
              required: false,
              min: 1,
              max: 9999,
              description: "Optional deterministic tuning seed",
            },
          },
          enabled: () => true,
          run: (_ctx, args) => {
            const explicit = typeof args?.seed === "number" ? args.seed : undefined
            const res = randomizeActiveStyle(explicit)
            context.sync()
            return res
          },
        },
      ])
    },
  }
}
