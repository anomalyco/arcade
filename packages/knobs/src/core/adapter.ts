import type { ControlDescriptor, RemoteControls } from "./remote.js"
import type { Choice, Schema, State, Values } from "./schema.js"
import type { Controls, DensityMode, MountPanelOptions, ThemeMode } from "./store.js"

export type ChoiceKey<S extends Schema> = {
  [K in keyof S]: S[K] extends Choice ? K : never
}[keyof S] &
  string

export type KnobsPanelProps<S extends Schema = Schema> = MountPanelOptions & {
  controls: Controls<S>
  /**
   * Remote controls only: the descriptors to show. A new array swaps rows in place
   * (`remote.update`); the same array with new `values` just syncs them.
   */
  descriptors?: readonly ControlDescriptor[]
  /** The values to show, from your own state. Keys in hand keep theirs until let go. */
  values?: State
  /** While true, a different item is arriving: values land without springing or rolling. */
  land?: boolean
}

export function syncPanelLook<S extends Schema>(
  host: HTMLElement | null | undefined,
  controls: Controls<S>,
  theme?: ThemeMode,
  density?: DensityMode,
): void {
  const panel = host?.firstElementChild as HTMLElement | null | undefined
  if (!panel) return
  panel.dataset.theme = theme ?? controls.theme
  panel.dataset.density = density ?? controls.density
}

export function syncPanelValues<S extends Schema>(
  controls: Controls<S>,
  descriptors?: readonly ControlDescriptor[],
  values?: State,
  land = false,
): void {
  if (!controls.enabled || (!descriptors && !values)) return
  if (descriptors && "update" in controls)
    (controls as unknown as RemoteControls).update(descriptors, values, { land })
  else if (values) controls.sync(values as Partial<Values<S>>, { replace: true, land })
}

export function mountPanelAdapter<S extends Schema>(
  host: HTMLElement,
  controls: Controls<S>,
  getProps: () => KnobsPanelProps<S>,
): () => void {
  const p = getProps()
  return controls.mount(host, {
    title: p.title,
    // Theme and density restyle the mounted panel in place, so its tokens glide.
    theme: p.theme,
    density: p.density,
    renderer: p.renderer,
    variants: p.variants,
    history: p.history,
    footer: p.footer,
    header: p.header,
    keys: p.keys,
    marks: p.marks,
    preset: p.preset,
    copy: p.copy ? () => getProps().copy?.() ?? controls.code() : undefined,
    actions: p.actions,
    onClose: p.onClose ? () => getProps().onClose?.() : undefined,
    onReady(panel) {
      const cur = getProps()
      syncPanelLook(host, controls, cur.theme, cur.density)
      cur.onReady?.(panel)
    },
  })
}
