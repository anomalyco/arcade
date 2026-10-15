# @arcade/knobs

A vendored copy of [knobs](https://github.com/kitlangton/knobs), the tuning-panel library the Lab and every game's
`LabPanel` render with. The source of truth is Kit's knobs repo (`~/code/open-source/knobs`); don't edit `src/` here.
Refresh it with `bun packages/knobs/scripts/sync.ts`, which copies a committed tree and records it in `VENDORED.json`.
Arcade-side changes knobs needs go to Kit's knobs session as requests; Arcade works around them in
`packages/kit/lab-knobs.ts`.

Imports: `@arcade/knobs` (stores and fields), `@arcade/knobs/panel` (`mountPanel`, `mountPage`) and
`@arcade/knobs/themes`.
