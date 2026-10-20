// Engine-independent math. IEEE 754 guarantees + - * / and sqrt are correctly rounded everywhere, but Math.sin, cos,
// exp and tanh may differ in the last bit between V8 (Chrome), JavaScriptCore (Bun, Safari) and SpiderMonkey. The sim
// is chaotic, so one ulp grows into a different gait within seconds. Everything the sim and the policy evaluate goes
// through these, so a policy trained headless in Bun replays bit-identically in any browser.

const HALF_PI_HI = 1.5707963267341256
const HALF_PI_LO = 6.077100506506192e-11
const TWO_OVER_PI = 0.6366197723675814

function sinPoly(r: number): number {
  const r2 = r * r
  return r + r * r2 * (-1 / 6 + r2 * (1 / 120 + r2 * (-1 / 5040 + r2 * (1 / 362880 + r2 * (-1 / 39916800 + r2 * (1 / 6227020800))))))
}

function cosPoly(r: number): number {
  const r2 = r * r
  return 1 + r2 * (-0.5 + r2 * (1 / 24 + r2 * (-1 / 720 + r2 * (1 / 40320 + r2 * (-1 / 3628800 + r2 * (1 / 479001600 + r2 * (-1 / 87178291200)))))))
}

/** Writes [sin x, cos x] into out (both from one range reduction). */
export function sincos(x: number, out: [number, number]): [number, number] {
  const k = Math.round(x * TWO_OVER_PI)
  const r = x - k * HALF_PI_HI - k * HALF_PI_LO
  const s = sinPoly(r)
  const c = cosPoly(r)
  const q = ((k % 4) + 4) % 4
  if (q === 0) { out[0] = s; out[1] = c }
  else if (q === 1) { out[0] = c; out[1] = -s }
  else if (q === 2) { out[0] = -s; out[1] = -c }
  else { out[0] = -c; out[1] = s }
  return out
}

const sc: [number, number] = [0, 0]
export const sin = (x: number): number => sincos(x, sc)[0]
export const cos = (x: number): number => sincos(x, sc)[1]

/** Wraps an angle into [-π, π). */
export function wrapAngle(a: number): number {
  const TWO_PI = 6.283185307179586
  return a - TWO_PI * Math.floor((a + 3.141592653589793) / TWO_PI)
}

/** e^x for |x| ≲ 40: x = k·ln2 + r, a Taylor series for e^r, then exact doublings. */
export function exp(x: number): number {
  if (x > 40) x = 40
  else if (x < -40) x = -40
  const k = Math.round(x * 1.4426950408889634)
  const r = x - k * 0.6931471803691238 - k * 1.9082149292705877e-10
  let y = 1 + r * (1 + r * (1 / 2 + r * (1 / 6 + r * (1 / 24 + r * (1 / 120 + r * (1 / 720 + r * (1 / 5040 + r * (1 / 40320 + r * (1 / 362880 + r * (1 / 3628800 + r / 39916800))))))))))
  if (k > 0) for (let i = 0; i < k; i++) y *= 2
  else for (let i = 0; i < -k; i++) y *= 0.5
  return y
}

export function tanh(x: number): number {
  if (x > 19) return 1
  if (x < -19) return -1
  const e = exp(2 * x)
  return (e - 1) / (e + 1)
}
