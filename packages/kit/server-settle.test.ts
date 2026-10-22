import { expect, test } from "bun:test"
import { settle } from "./server/settle"

/** Like workerd's JsRpcPromise: `then` throws unless the success callback is a function. */
class StrictThenable<T> implements PromiseLike<T> {
  constructor(private readonly inner: Promise<T>) {}
  then<A = T, B = never>(ok?: ((v: T) => A | PromiseLike<A>) | null, err?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    if (typeof ok !== "function") throw new TypeError("Failed to execute 'then' on 'JsRpcPromise': parameter 1 is not of type 'Function'.")
    return this.inner.then(ok, err)
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

test("an RPC-style promise that resolves settles without an error", async () => {
  const errors: unknown[] = []
  expect(() => settle(() => new StrictThenable(Promise.resolve(1)), (e) => errors.push(e))).not.toThrow()
  await tick()
  expect(errors).toEqual([])
})

test("an RPC-style promise that rejects reaches the error handler", async () => {
  const errors: unknown[] = []
  settle(() => new StrictThenable(Promise.reject(new Error("lobby down"))), (e) => errors.push(e))
  await tick()
  expect(errors.map((e) => (e as Error).message)).toEqual(["lobby down"])
})

test("a call that throws synchronously reaches the error handler", () => {
  const errors: unknown[] = []
  settle(() => { throw new Error("no stub") }, (e) => errors.push(e))
  expect(errors.map((e) => (e as Error).message)).toEqual(["no stub"])
})

test("the old then(undefined, handler) form throws on such a promise", () => {
  expect(() => new StrictThenable(Promise.resolve(1)).then(undefined, () => {})).toThrow(TypeError)
})
