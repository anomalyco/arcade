import { expect, test } from "bun:test"
import worker from "./index"

const go = (path: string, method = "GET") => worker.fetch(new Request(`https://anoma.ly${path}`, { method }))

test("keeps the path and query", () => {
  const res = go("/labs/blackout/?room=abcd")
  expect(res.status).toBe(301)
  expect(res.headers.get("location")).toBe("https://anoma.ly/arcade/blackout/?room=abcd")
  expect(go("/labs/getaway").headers.get("location")).toBe("https://anoma.ly/arcade/getaway")
  expect(go("/labs/getaway/api/stats").headers.get("location")).toBe("https://anoma.ly/arcade/getaway/api/stats")
  expect(go("/labs/wings/?room=abc12").headers.get("location")).toBe("https://anoma.ly/arcade/wings/?room=abc12")
})

test("keeps the method for non-GET requests", () => {
  expect(go("/labs/blackout/api/create", "POST").status).toBe(308)
})

test("only rewrites whole game segments", () => {
  expect(go("/labs/blackoutx").status).toBe(404)
  expect(go("/labs/salvo/").status).toBe(404)
})
