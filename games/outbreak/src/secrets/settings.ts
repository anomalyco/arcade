import type { LabControl } from "@arcade/kit/lab-panel"
import { DEFAULT_SECRETS_TUNING, secretsControls, type SecretsTuning } from "../../shared/secrets/catalog"

/**
 * Lab settings for the secrets (Backquote › Secrets): what a run has (sent as the session's `secrets` tuning, so the
 * offline sim agrees) and how they look. A co-op room plays the defaults.
 */
export type OutbreakSecretsSettings = SecretsTuning & {
  /** How long a secret is held up close when you look at it (s). */
  secretGlance: number
  /** The tall man is gone when you come this close (m). */
  secretVanish: number
}

export const DEFAULT_SECRETS_SETTINGS: OutbreakSecretsSettings = {
  ...DEFAULT_SECRETS_TUNING,
  secretGlance: 2.6,
  secretVanish: 15,
}

export const secretsLookControls: LabControl[] = [
  { key: "secrets.secretGlance", field: "secretGlance", label: "Glance time", group: "Secrets", min: 0.5, max: 8, step: 0.1, unit: "s" } as LabControl,
  { key: "secrets.secretVanish", field: "secretVanish", label: "Tall man vanishes within", group: "Secrets", min: 4, max: 30, step: 0.5, unit: "m" } as LabControl,
]

export const secretsSimControls = secretsControls as unknown as LabControl[]
