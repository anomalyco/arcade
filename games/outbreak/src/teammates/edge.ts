/**
 * Where a teammate's marker goes: at them when they are on screen, else pinned to the screen's edge on the line from
 * the centre towards them, with the angle its chevron points.
 */
export type EdgeMark = { x: number; y: number; angle: number; onScreen: boolean }

export function edgeMark(px: number, py: number, w: number, h: number, margin: number, ok = true, dir?: { x: number; y: number }): EdgeMark {
  const onScreen = ok && px >= margin && px <= w - margin && py >= margin && py <= h - margin
  if (onScreen) return { x: px, y: py, angle: Math.atan2(py - h / 2, px - w / 2), onScreen }
  const cx = w / 2
  const cy = h / 2
  // Behind the camera the projection is meaningless: fall back to the plan direction.
  let dx = ok ? px - cx : (dir?.x ?? 0)
  let dy = ok ? py - cy : (dir?.y ?? 1)
  if (dx === 0 && dy === 0) dy = 1
  const hx = cx - margin
  const hy = cy - margin
  const t = Math.min(hx / Math.max(1e-6, Math.abs(dx)), hy / Math.max(1e-6, Math.abs(dy)))
  dx *= t
  dy *= t
  return { x: cx + dx, y: cy + dy, angle: Math.atan2(dy, dx), onScreen: false }
}

/**
 * How a teammate is marked: nothing in plain view (their name tag is enough), a ring where an on-screen teammate is
 * out of sight, a chevron at the edge when off screen. A downed teammate on screen within `downNear` metres is left to
 * the death HUD's revive marker.
 */
export function markMode(m: { onScreen: boolean; visible: boolean; down: boolean; dist: number }, downNear = 28): "edge" | "ring" | null {
  if (!m.onScreen) return "edge"
  if (m.down) return m.dist < downNear ? null : "ring"
  return m.visible ? null : "ring"
}
