import type { LabControl } from "@arcade/kit/lab-panel"
import { coopScalingControls } from "../../shared/night-ramp/coop"
import { DEFAULT_NIGHT_RAMP_TUNING, nightRampControls } from "../../shared/night-ramp/ramp"
import type { NightRampState } from "../../shared/night-ramp/runtime"
import { registerOutbreakClientFeature } from "../feature-registry"

/**
 * Night ramp (D-40), client half: the Lab's Night ramp and Co-op scaling groups (Backquote › Night ramp, "Night ramp:
 * Today" turns it off; Backquote › Co-op scaling, "Co-op scaling: Today (linear)") and harness telemetry. The rules
 * live in `shared/night-ramp/`.
 */
export const outbreakNightRampFeature = registerOutbreakClientFeature({
  id: "nightRamp",
  order: 18,
  settingsGroup: { subsystem: "nightRamp", defaults: DEFAULT_NIGHT_RAMP_TUNING },
  labControls: (): LabControl[] => [...(nightRampControls as readonly LabControl[]), ...(coopScalingControls as readonly LabControl[])],
  harnessState: (host) => {
    const session = host.session()
    return {
      nightRamp: {
        night: session.sim.getFeatureState<NightRampState>("nightRamp")?.night ?? 0,
        escalation: { ...session.ai.pacing.escalation },
        coop: { ...session.ai.pacing.coop },
      },
    }
  },
})
