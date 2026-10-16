// commandsFrom(controls): a store's actions, toolbar buttons, presets and fields as palette
// commands, so ⌘K reaches everything a panel shows.
import { hasValue, isReadout, type Field } from "../core/schema.js"
import type { Controls } from "../core/store.js"
import type { Command } from "./palette.js"

export interface CommandsFromOptions {
  /** Prefix for sections ("Station" → "Station · Presets"); the store id is never shown. */
  readonly title?: string
  /** Leave out fields (only actions and presets). */
  readonly fields?: boolean
  /** A field picked from the palette: show it (scroll a panel to it, focus it). */
  reveal?(key: string): void
}

const labelOf = (key: string, field: Field) => field.label ?? key

export function commandsFrom(
  // biome-ignore lint/suspicious/noExplicitAny: any store
  controls: Controls<any>,
  options: CommandsFromOptions = {},
): Command[] {
  const out: Command[] = []
  const title = options.title
  const sec = (name: string) => (title ? `${title} · ${name}` : name)
  const id = (s: string) => `${controls.id}:${s}`
  const schema = controls.schema as Record<string, Field>
  for (const [key, field] of Object.entries(schema)) {
    const keyOf = (item?: string) => {
      const combo = controls.shortcut(key, item)
      return combo ? { shortcut: combo } : {}
    }
    if (field.kind === "action")
      out.push({
        id: id(key),
        label: labelOf(key, field),
        section: sec(field.group ? (controls.groupLabel(field.group) ?? field.group) : "Actions"),
        ...keyOf(),
        disabled: controls.isDisabled(key),
        run: () => controls.action(key),
      })
    else if (field.kind === "toolbar")
      for (const item of field.items)
        out.push({
          id: id(`${key}/${item.id ?? item.label}`),
          label: item.label,
          section: sec(field.label ?? "Actions"),
          ...keyOf(item.id ?? item.label),
          ...(item.disabled ? { disabled: true } : {}),
          run: () => controls.action(key, item.id ?? item.label),
        })
  }
  for (const a of controls.actions)
    out.push({
      id: id(`action/${a.id ?? a.label}`),
      label: a.label,
      section: sec(a.group ?? "Actions"),
      ...(a.shortcut ? { shortcut: a.shortcut } : {}),
      run: () => a.run(controls.get(), controls),
    })
  const current = controls.matchingPreset()
  for (const p of Object.keys(controls.presets))
    out.push({
      id: id(`preset/${p}`),
      label: controls.presetLabel(p),
      section: sec("Presets"),
      keywords: ["preset"],
      ...(p === current ? { hint: "Current" } : {}),
      run: () => controls.preset(p),
    })
  for (const [group, list] of Object.entries(controls.groupPresets)) {
    const name = controls.groupLabel(group) ?? group
    const on = controls.matchingGroupPreset(group)
    list.forEach((p, i) =>
      out.push({
        id: id(`group/${group}/${i}`),
        label: `${name}: ${p.name}`,
        section: sec("Presets"),
        keywords: ["preset", group],
        ...(i === on ? { hint: "Current" } : {}),
        run: () => controls.groupPreset(group, i),
      }),
    )
  }
  if (options.fields !== false) {
    const values = controls.get() as Record<string, unknown>
    for (const [key, field] of Object.entries(schema)) {
      if (!hasValue(field) || isReadout(field)) continue
      const label = labelOf(key, field)
      const section = sec(
        field.group ? (controls.groupLabel(field.group) ?? field.group) : "Fields",
      )
      const off = controls.isDisabled(key) || controls.isReadOnly(key)
      const keywords = [key, ...(field.group ? [field.group] : [])]
      if (field.kind === "toggle")
        out.push({
          id: id(`field/${key}`),
          label: `${values[key] ? "Turn off" : "Turn on"} ${label}`,
          section,
          keywords: [...keywords, label, "toggle"],
          disabled: off,
          run: () => controls.set({ [key]: !controls.get()[key] }),
        })
      else if (field.kind === "choice")
        for (const option of field.options)
          out.push({
            id: id(`field/${key}/${option}`),
            label: `${label}: ${field.labels?.[option] ?? option}`,
            section,
            keywords,
            ...(values[key] === option ? { hint: "Current" } : {}),
            disabled: off,
            run: () => controls.set({ [key]: option }),
          })
      else if (options.reveal) {
        const reveal = options.reveal
        const v = values[key]
        const hint =
          typeof v === "number"
            ? String(Math.round(v * 100) / 100)
            : typeof v === "string" && v.length < 24
              ? v
              : undefined
        out.push({
          id: id(`field/${key}`),
          label,
          section,
          keywords,
          ...(hint ? { hint } : {}),
          run: () => reveal(key),
        })
      }
      if (controls.isModified(key) && !off)
        out.push({
          id: id(`reset/${key}`),
          label: `Reset ${label}`,
          section,
          keywords: [...keywords, "default"],
          run: () => controls.resetKey(key),
        })
    }
  }
  return out
}
