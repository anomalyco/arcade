import type { LabWorldObject } from "./types"

export type MarqueeRect = {
  left: number
  top: number
  width: number
  height: number
  u0: number
  v0: number
  u1: number
  v1: number
}

export function normalizeMarqueeRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  viewportWidth: number,
  viewportHeight: number,
): MarqueeRect {
  const w = Math.max(1, viewportWidth)
  const h = Math.max(1, viewportHeight)
  const left = Math.max(0, Math.min(x0, x1))
  const right = Math.min(w, Math.max(x0, x1))
  const top = Math.max(0, Math.min(y0, y1))
  const bottom = Math.min(h, Math.max(y0, y1))
  return {
    left,
    top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
    u0: left / w,
    v0: top / h,
    u1: right / w,
    v1: bottom / h,
  }
}

export function pickObjectsInMarquee(
  objects: readonly LabWorldObject[],
  projectFn: (x: number, y: number, z: number) => { u: number; v: number; visible: boolean },
  rect: MarqueeRect,
): LabWorldObject[] {
  const inside = objects.filter(obj => {
    const p = projectFn(obj.x, obj.y + 0.25, obj.z)
    if (!p.visible) return false
    return p.u >= rect.u0 && p.u <= rect.u1 && p.v >= rect.v0 && p.v <= rect.v1
  })
  const authored = inside.filter(o => o.category === "prop" || o.category === "light" || o.category === "emitter")
  return authored.length > 0 ? authored : inside
}

export function applyClickSelection(
  currentIds: readonly string[],
  clickedId: string | null,
  shiftKey: boolean,
): { ids: string[]; primaryId: string | null } {
  if (!clickedId) {
    if (shiftKey) {
      return { ids: [...currentIds], primaryId: currentIds.at(-1) ?? null }
    }
    return { ids: [], primaryId: null }
  }
  if (!shiftKey) {
    return { ids: [clickedId], primaryId: clickedId }
  }
  const exists = currentIds.includes(clickedId)
  if (exists) {
    const next = currentIds.filter(id => id !== clickedId)
    return { ids: next, primaryId: next.at(-1) ?? null }
  }
  const next = [...currentIds, clickedId]
  return { ids: next, primaryId: clickedId }
}

export function applyMarqueeSelection(
  currentIds: readonly string[],
  boxedIds: readonly string[],
  additive: boolean,
): { ids: string[]; primaryId: string | null } {
  if (!additive) {
    return { ids: [...boxedIds], primaryId: boxedIds.at(-1) ?? null }
  }
  const merged = [...currentIds]
  for (const id of boxedIds) {
    if (!merged.includes(id)) merged.push(id)
  }
  return { ids: merged, primaryId: merged.at(-1) ?? null }
}

export function computeSelectionCentroid(objects: readonly LabWorldObject[]): {
  x: number
  y: number
  z: number
  yaw: number
  count: number
} {
  if (objects.length === 0) return { x: 0, y: 0, z: 0, yaw: 0, count: 0 }
  let sx = 0
  let sy = 0
  let sz = 0
  for (const o of objects) {
    sx += o.x
    sy += o.y
    sz += o.z
  }
  const n = objects.length
  const primary = objects.at(-1)!
  return {
    x: sx / n,
    y: sy / n,
    z: sz / n,
    yaw: primary.yaw ?? 0,
    count: n,
  }
}
