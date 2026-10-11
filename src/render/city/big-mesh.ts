import { FLOATS_PER_VERT, type Mat, Mesh, type Rgb } from "../mesh"

/**
 * A Mesh that writes straight into a growable Float32Array. The district runs to hundreds of thousands of
 * triangles, which as a plain number[] would cost several times the memory during the build.
 */
export class BigMesh extends Mesh {
  private buf = new Float32Array(1 << 20)
  private n = 0

  override vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, c: Rgb, mat: Mat, u = 2 / 2048, w = 2 / 2048) {
    if (this.n + FLOATS_PER_VERT > this.buf.length) {
      const next = new Float32Array(this.buf.length * 2)
      next.set(this.buf)
      this.buf = next
    }
    const b = this.buf
    let i = this.n
    b[i++] = x
    b[i++] = y
    b[i++] = z
    b[i++] = nx
    b[i++] = ny
    b[i++] = nz
    b[i++] = c[0]
    b[i++] = c[1]
    b[i++] = c[2]
    b[i++] = mat
    b[i++] = u
    b[i++] = w
    this.n = i
  }

  override append(other: Mesh) {
    const src = other.toArray()
    for (let i = 0; i < src.length; i += FLOATS_PER_VERT) this.vert(src[i]!, src[i + 1]!, src[i + 2]!, src[i + 3]!, src[i + 4]!, src[i + 5]!, [src[i + 6]!, src[i + 7]!, src[i + 8]!], src[i + 9] as Mat, src[i + 10], src[i + 11])
  }

  override toArray(): Float32Array<ArrayBuffer> {
    return this.buf.slice(0, this.n)
  }

  override get count() {
    return this.n / FLOATS_PER_VERT
  }
}
