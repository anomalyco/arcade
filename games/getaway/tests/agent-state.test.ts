import { describe, expect, test } from "bun:test"
import { loadAgentState, parseAgentState } from "../../../scripts/agent-ops"

describe("agent-state guardrails", () => {
  test("docs/agent-state.md parses cleanly and enforces main + retired release branches", () => {
    const state = loadAgentState()
    expect(["on", "off"]).toContain(state.deploys)
    expect(state.allowed_base.length).toBeGreaterThan(0)
    expect(state.retired_branches).toContain("release-6")
    expect(state.retired_branches).not.toContain(state.allowed_base)
  })

  test("parseAgentState handles YAML booleans and strings for deploys and browser_proofs_default", () => {
    const parsed = parseAgentState(
      [
        "---",
        "deploys: off",
        "allowed_base: release-8",
        "retired_branches:",
        "  - release-6",
        "  - release-7",
        "browser_proofs_default: on",
        "---",
        "# Body",
      ].join("\n"),
    )
    expect(parsed.deploys).toBe("off")
    expect(parsed.allowed_base).toBe("release-8")
    expect(parsed.retired_branches).toEqual(["release-6", "release-7"])
    expect(parsed.browser_proofs_default).toBe("on")
  })
})
