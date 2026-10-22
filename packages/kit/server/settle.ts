/**
 * Runs a fire-and-forget call and reports any failure, synchronous or async. Workers RPC stubs return a
 * `JsRpcPromise` whose `then` rejects a missing success callback (`then(undefined, onError)` throws a TypeError), so
 * the result is adopted with `Promise.resolve`, which always passes both callbacks.
 */
export function settle(call: () => PromiseLike<unknown> | unknown, onError: (error: unknown) => void): void {
  try {
    Promise.resolve(call()).catch(onError)
  } catch (error) {
    onError(error)
  }
}
