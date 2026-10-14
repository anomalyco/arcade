import { describe, expect, test } from "bun:test"
import { extraPageHosts, isAllowedPageOrigin } from "../../scripts/dev-control-server"

const tailnet = "kits-mac-studio.taila8e7c7.ts.net"

describe("dev control page origins", () => {
  test("loopback origins match their Host", () => {
    expect(isAllowedPageOrigin("http://127.0.0.1:5180", "127.0.0.1:5180")).toBe(true)
    expect(isAllowedPageOrigin("http://arcade.localhost:1355", "arcade.localhost:1355")).toBe(true)
  })

  test("a configured tailnet host is accepted over HTTPS", () => {
    expect(isAllowedPageOrigin(`https://${tailnet}:5180`, `${tailnet}:5180`, [tailnet])).toBe(true)
  })

  test("unlisted, mismatched and downgraded origins are rejected", () => {
    expect(isAllowedPageOrigin(`https://${tailnet}:5180`, `${tailnet}:5180`)).toBe(false)
    expect(isAllowedPageOrigin("https://evil.example:5180", `${tailnet}:5180`, [tailnet])).toBe(false)
    expect(isAllowedPageOrigin(`https://${tailnet}:5181`, `${tailnet}:5180`, [tailnet])).toBe(false)
    expect(isAllowedPageOrigin(`http://${tailnet}:5180`, `${tailnet}:5180`, [tailnet])).toBe(false)
    expect(isAllowedPageOrigin(undefined, `${tailnet}:5180`, [tailnet])).toBe(false)
  })

  test("extra hosts come from either env name and ignore wildcards", () => {
    expect(extraPageHosts({ ARCADE_DEV_ALLOWED_HOSTS: `${tailnet}.`, __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: ".ts.net,other.ts.net" }))
      .toEqual([tailnet, "other.ts.net"])
  })
})
