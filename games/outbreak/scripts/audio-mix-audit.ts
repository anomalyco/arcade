// Offline mix and sample audit for Outbreak (`bun games/outbreak/scripts/audio-mix-audit.ts`).
// Decodes every Outbreak sound sample with ffmpeg (no audio playback), computes raw and effective
// RMS/peak/LUFS across every emitter call site, and flags mix hierarchy and engine issues.
import { busVolume, selectSfx, SFX_BY_ID } from "@arcade/kit/audio"
import { analyzeSfx } from "../../../packages/kit/audio/sfx-analysis"
import { fallTime } from "../../../packages/kit/audio/synth"
import { decode } from "../../../scripts/sfx/decode"
import { AUDIO_BUS_LEVELS, DEFAULT_AUDIO_SETTINGS } from "../src/audio/settings"

const SR = 48000
const db = (lin: number) => 20 * Math.log10(Math.max(1e-9, lin))

export type EmitterUse = {
  emitter: string
  cueId: string
  gain: number
  rate: string
  cadence: string
  notes?: string
}

export const OUTBREAK_EMITTERS: readonly EmitterUse[] = [
  // Player & teammate movement
  { emitter: "OutbreakAudio.footstep (walk)", cueId: "foot.concrete.walk", gain: 1.0, rate: "1.0", cadence: "~2.2/s while walking (and on idle aim turn!)" },
  { emitter: "OutbreakAudio.footstep (run)", cueId: "foot.concrete.run", gain: 1.0, rate: "1.0", cadence: "~3.2/s while sprinting" },
  { emitter: "OutbreakAudio.footstep (wood walk)", cueId: "foot.wood.walk", gain: 1.0, rate: "1.0", cadence: "~2.2/s indoors" },
  { emitter: "OutbreakAudio.footstep (wood run)", cueId: "foot.wood.run", gain: 1.0, rate: "1.0", cadence: "~3.2/s indoors" },
  { emitter: "OutbreakAudio.footstep (grass walk)", cueId: "foot.grass.walk", gain: 1.0, rate: "1.0", cadence: "~2.2/s on lawn" },
  { emitter: "OutbreakAudio.footstep (grass run)", cueId: "foot.grass.run", gain: 1.0, rate: "1.0", cadence: "~3.2/s on lawn" },
  // Weapons & reload
  { emitter: "SoundDirector.shot", cueId: "gun.pistol.shot", gain: 1.0, rate: "1.0", cadence: "per pistol shot" },
  { emitter: "SoundDirector.shot (casing)", cueId: "gun.casing", gain: 1.0, rate: "1.0", cadence: "0.38–0.5s after shot" },
  { emitter: "SoundDirector.dryFire", cueId: "gun.dry-fire", gain: 1.0, rate: "1.0", cadence: "empty trigger / empty reload start" },
  { emitter: "SoundDirector.reload (1/4)", cueId: "gun.pistol.mag-release", gain: 1.0, rate: "1.0", cadence: "0.11 of 1.15s reload" },
  { emitter: "SoundDirector.reload (2/4)", cueId: "gun.pistol.mag-out", gain: 1.0, rate: "1.0", cadence: "0.19 of 1.15s reload" },
  { emitter: "SoundDirector.reload (3/4)", cueId: "gun.pistol.mag-in", gain: 1.0, rate: "1.0", cadence: "0.63 of 1.15s reload" },
  { emitter: "SoundDirector.reload (4/4)", cueId: "gun.pistol.slide", gain: 1.0, rate: "1.0", cadence: "0.84 of 1.15s reload" },
  // Bullet impacts
  { emitter: "SoundDirector.shotImpact (wood)", cueId: "impact.bullet.wood", gain: 1.0, rate: "1.0", cadence: "per missed shot (0.8 through)" },
  { emitter: "SoundDirector.shotImpact (plaster)", cueId: "impact.bullet.plaster", gain: 1.0, rate: "1.0", cadence: "per indoor wall hit" },
  { emitter: "SoundDirector.shotImpact (concrete)", cueId: "impact.bullet.concrete", gain: 1.0, rate: "1.0", cadence: "per brick/concrete hit" },
  { emitter: "SoundDirector.shotImpact (metal)", cueId: "impact.bullet.metal", gain: 1.0, rate: "1.0", cadence: "per car/warehouse/shield hit" },
  { emitter: "SoundDirector.shotImpact (glass)", cueId: "impact.bullet.glass", gain: 1.0, rate: "1.0", cadence: "per window pane / lamp shot" },
  { emitter: "SoundDirector.shotHitZombie", cueId: "zombie.hit", gain: 1.0, rate: "1.0", cadence: "per bullet hitting zombie" },
  // Melee
  { emitter: "SoundDirector.meleeSwing (light)", cueId: "melee.swing.light", gain: 1.0, rate: "0.9–1.0", cadence: "per light swing or whiffed shove" },
  { emitter: "SoundDirector.meleeSwing (heavy)", cueId: "melee.swing.heavy", gain: 1.0, rate: "0.9–1.0", cadence: "per heavy swing" },
  { emitter: "SoundDirector.meleeHit (wood)", cueId: "melee.hit.wood", gain: 1.15, rate: "0.78–1.0", cadence: "per zombie hit (1.3 finisher)" },
  { emitter: "SoundDirector.meleeHit (metal)", cueId: "melee.hit.metal", gain: 1.15, rate: "0.78–1.0", cadence: "per zombie hit (1.3 finisher)" },
  { emitter: "SoundDirector.meleeHit (blade)", cueId: "melee.hit.blade", gain: 1.15, rate: "0.78–1.0", cadence: "per zombie hit (1.3 finisher)" },
  { emitter: "SoundDirector.meleeLowDurability", cueId: "melee.break", gain: 0.42, rate: "1.28", cadence: "every hit at >=65% wear (ODD)" },
  { emitter: "SoundDirector.meleeBreak", cueId: "melee.break", gain: 1.0, rate: "1.0", cadence: "when melee weapon shatters" },
  { emitter: "SoundDirector.shove", cueId: "melee.shove", gain: 1.0, rate: "1.0", cadence: "connected shove / melee finisher (1.15)" },
  // Zombies & specials
  { emitter: "SoundDirector.zombieIdleGroan", cueId: "zombie.groan.idle", gain: 1.0, rate: "1.0", cadence: "4.5s/sqrt(n), min gap 0.7s, 8s/zombie" },
  { emitter: "SoundDirector.zombieAlert", cueId: "zombie.alert", gain: 1.0, rate: "1.0", cadence: "max 1 per 0.35s, 8s/zombie" },
  { emitter: "SoundDirector.zombieAttack", cueId: "zombie.attack", gain: 1.0, rate: "1.0", cadence: "on survivor damage, 0.8s/zombie" },
  { emitter: "SoundDirector.zombieDeath", cueId: "zombie.death", gain: 1.0, rate: "1.0", cadence: "once per zombie death" },
  { emitter: "SoundDirector.zombieKnockdown", cueId: "body.vault", gain: 0.85, rate: "1.0", cadence: "on zombie knockdown (ODD: window climb)" },
  { emitter: "SpecialSounds.screamerShriek", cueId: "zombie.alert", gain: 1.6, rate: "1.55 / 1.8 / 1.35", cadence: "3x burst on alert (ODD: chipmunk + cooldown drop)" },
  { emitter: "SpecialSounds.bloaterGurgle", cueId: "zombie.groan.idle", gain: 0.85, rate: "0.52–0.60", cadence: "every ~3.2s (ODD: tape drag)" },
  { emitter: "SpecialSounds.bloaterBurst", cueId: "zombie.hit", gain: 1.7, rate: "0.50", cadence: "on bloater death (+ zombie.death 0.62 + body.vault 0.55)" },
  { emitter: "SpecialSounds.lurkerWake", cueId: "zombie.alert", gain: 1.4, rate: "0.72", cadence: "on lurker wake (collides with normal alert)" },
  { emitter: "SpecialSounds.bruteStep", cueId: "body.vault", gain: 0.55, rate: "0.50–0.56", cadence: "every ~0.62s while moving (ODD: window sill)" },
  { emitter: "ZombieFootsteps.step", cueId: "zombie.foot.step.concrete", gain: 0.9, rate: "1.0", cadence: "nearest 4 within 14m, <=8/s total" },
  { emitter: "ZombieFootsteps.shuffle", cueId: "zombie.foot.shuffle.concrete", gain: 0.9, rate: "1.0", cadence: "nearest 4 within 14m, <=8/s total" },
  { emitter: "ZombieFootsteps.drag", cueId: "zombie.foot.drag.concrete", gain: 0.9, rate: "1.0", cadence: "nearest 4 within 14m, <=8/s total" },
  { emitter: "OutbreakAudio.horde", cueId: "zombie.horde.shuffle", gain: 1.0, rate: "1.0", cadence: "continuous loop when >1 moving zombie in 22m" },
  // Survivor body & death
  { emitter: "SoundDirector.hurt", cueId: "body.hurt", gain: 1.0, rate: "1.0", cadence: "on health loss >0.5" },
  { emitter: "SoundDirector.exhausted", cueId: "body.breath.exhausted", gain: 1.0, rate: "1.0", cadence: "on stamina exhausted (3s cooldown)" },
  { emitter: "SoundDirector.vault", cueId: "body.vault", gain: 1.0, rate: "1.0", cadence: "on window vault" },
  { emitter: "DeathSounds.down", cueId: "body.hurt", gain: 1.3, rate: "0.72", cadence: "on downed (+ body.vault rate 0.6)" },
  { emitter: "DeathSounds.heartbeat", cueId: "foot.grass.run", gain: 1.35, rate: "0.42 / 0.38", cadence: "2x every 0.48–1.05s while down (ODD: grass swish)" },
  { emitter: "DeathSounds.dead / runOver", cueId: "door.bash", gain: 1.4, rate: "0.42 / 0.34", cadence: "on death / run over (ODD: slowed door rattle)" },
  // Doors, windows, barricades, world verbs
  { emitter: "SoundDirector.doorOpen", cueId: "door.wood.open", gain: 1.0, rate: "1.0", cadence: "on door open" },
  { emitter: "SoundDirector.doorClose", cueId: "door.wood.close", gain: 1.0, rate: "1.0", cadence: "on door close" },
  { emitter: "SoundDirector.doorLocked", cueId: "door.locked", gain: 1.0, rate: "1.0", cadence: "on locked door jiggle" },
  { emitter: "SoundDirector.doorBash", cueId: "door.bash", gain: 1.0, rate: "1.0", cadence: "on zombie portal bash" },
  { emitter: "SoundDirector.windowSlide", cueId: "window.slide", gain: 1.0, rate: "1.0", cadence: "on window open/close" },
  { emitter: "SoundDirector.barricadeHammer", cueId: "barricade.hammer", gain: 1.0, rate: "1.0", cadence: "on plank added" },
  { emitter: "SoundDirector.barricadeBreak", cueId: "barricade.break", gain: 1.0, rate: "1.0", cadence: "on plank broken" },
  { emitter: "InventorySounds.glassBreak", cueId: "glass.break", gain: 1.0, rate: "1.0", cadence: "bottle/car/window smash" },
  { emitter: "InventorySounds.glassStep", cueId: "glass.break", gain: 0.35, rate: "1.0", cadence: "step on broken glass (ODD: full window smash)" },
  // Looting, crafting, bench, items
  { emitter: "SoundDirector.rummage", cueId: "search.rummage", gain: 1.0, rate: "1.0", cadence: "on container search start" },
  { emitter: "InventorySounds.pickup", cueId: "pickup.item", gain: 1.0, rate: "1.0", cadence: "up to 2/frame on item pickup" },
  { emitter: "InventorySounds.drop", cueId: "item.drop", gain: 1.0, rate: "1.0", cadence: "on item drop / radio knocked down (1.3)" },
  { emitter: "InventorySounds.craftLoop", cueId: "craft.tinker.loop", gain: 1.0, rate: "1.0", cadence: "held during craft/heal channel" },
  { emitter: "InventorySounds.craftDone", cueId: "craft.tinker.done", gain: 1.0, rate: "1.0", cadence: "on craft/heal completion" },
  { emitter: "InventorySounds.benchDeposit", cueId: "bench.deposit", gain: 1.0, rate: "1.0", cadence: "on bench deposit" },
  { emitter: "InventorySounds.generator", cueId: "generator.loop", gain: 1.0, rate: "1.0", cadence: "held at night with car battery" },
  { emitter: "InventorySounds.lure", cueId: "lure.loop", gain: 1.0, rate: "1.0", cadence: "held on noisemaker AND car alarm (ODD)" },
  { emitter: "InventorySounds.radio", cueId: "radio.loop", gain: 1.0, rate: "1.0", cadence: "held while house radio is on" },
  // Fire, explosives, flares, dogs, crows
  { emitter: "InventorySounds.flareIgnite", cueId: "flare.ignite", gain: 1.0, rate: "1.0", cadence: "road flare / flamer (0.78) / molotov (0.7) / fuse (1.25)" },
  { emitter: "InventorySounds.flareLoop", cueId: "flare.loop", gain: 1.0, rate: "1.0", cadence: "held on flare, flamethrower, molotov, dynamite fuse" },
  { emitter: "InventorySounds.flareGunShot", cueId: "gun.pistol.shot", gain: 0.55, rate: "0.62", cadence: "on flare gun fire (ODD: slowed pistol)" },
  { emitter: "InventorySounds.firecrackers", cueId: "gun.pistol.shot", gain: 0.32, rate: "1.7–2.1", cadence: "every 0.11s while lit (ODD: pitched pistol, steals gunshots)" },
  { emitter: "InventorySounds.dynamite", cueId: "bomb.explode", gain: 1.5, rate: "0.82", cadence: "on dynamite detonation (+ barricade.break)" },
  { emitter: "InventorySounds.burn", cueId: "cooking.sizzle", gain: 0.9, rate: "0.80", cadence: "when zombie catches fire" },
  { emitter: "InventorySounds.bearTrapSet", cueId: "gun.pistol.slide", gain: 1.1, rate: "0.70", cadence: "on bear trap placed" },
  { emitter: "InventorySounds.bearTrapSnap", cueId: "melee.break", gain: 1.3, rate: "0.80", cadence: "on bear trap snap (ODD: wood splintering)" },
  { emitter: "InventorySounds.dogBark", cueId: "dog.bark", gain: 1.0, rate: "1.0", cadence: "chained dog every 0.9s / distant dog (0.45)" },
  { emitter: "FrameRenderer.crows", cueId: "wings.flap", gain: 0.85, rate: "1.15–1.31", cadence: "3x burst on flock scatter (no caw)" },
  // Ambience & UI
  { emitter: "OutbreakAudio.ambience (day)", cueId: "ambience.day.suburb", gain: 1.0, rate: "1.0", cadence: "continuous loop" },
  { emitter: "OutbreakAudio.ambience (night)", cueId: "ambience.night.suburb", gain: 1.0, rate: "1.0", cadence: "continuous loop" },
  { emitter: "OutbreakAudio.ambience (threat)", cueId: "ambience.threat", gain: 1.0, rate: "1.0", cadence: "continuous loop" },
  { emitter: "OutbreakAudio.pack", cueId: "pack.open", gain: 1.0, rate: "1.0", cadence: "on Tab toggle" },
  { emitter: "InventorySounds.ping", cueId: "ui.ping", gain: 1.0, rate: "1.0", cadence: "on Q ping (missing distance attenuation)" },
]

function max50msRmsDb(ch: Float32Array): number {
  const win = Math.min(ch.length, Math.round(0.05 * SR))
  if (win === 0) return -Infinity
  let sum = 0
  for (let i = 0; i < win; i++) sum += ch[i]! * ch[i]!
  let maxMean = sum / win
  for (let i = win; i < ch.length; i++) {
    sum += ch[i]! * ch[i]! - ch[i - win]! * ch[i - win]!
    if (sum / win > maxMean) maxMean = sum / win
  }
  return 10 * Math.log10(Math.max(1e-18, maxMean))
}

if (import.meta.main) {
  const entries = selectSfx(["game:outbreak"])
  console.log(`Auditing ${entries.length} Outbreak library sound IDs and ${OUTBREAK_EMITTERS.length} emitter sites...`)
  console.log("| Sound ID | Bus | Var | Target LUFS | Spec Gain | Raw Peak dB | 50ms RMS dB | Eff Peak dB | Eff 50ms RMS | Env Decay Loss dB | Range (ref..max) | Policy / MaxV |")
  console.log("| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: | --- | --- |")
  for (const entry of entries) {
    let rawPeak = 0, rms50 = 0, effPeak = 0, effRms50 = 0, envLoss = 0
    for (const f of entry.files) {
      const chs = await decode(f.path)
      const m = chs[0]!
      const stats = analyzeSfx(chs)
      const r50 = max50msRmsDb(m)
      const busSetting = (DEFAULT_AUDIO_SETTINGS[AUDIO_BUS_LEVELS[entry.bus]] as number) / 100
      const volSetting = busVolume(DEFAULT_AUDIO_SETTINGS, entry.bus)
      const gainDb = db(f.gain * entry.gain * busSetting * volSetting)
      rawPeak += stats.peakDb
      rms50 += r50
      effPeak += stats.peakDb + gainDb
      effRms50 += r50 + gainDb
      if (!entry.loop) {
        const dur = m.length / SR
        const tau = fallTime(dur)
        let rawSq = 0, envSq = 0
        for (let i = 0; i < m.length; i++) {
          const t = i / SR
          const env = t < 0.002 ? t / 0.002 : Math.exp(-(t - 0.002) / tau)
          rawSq += m[i]! * m[i]!
          envSq += (m[i]! * env) ** 2
        }
        envLoss += 10 * Math.log10(envSq / Math.max(1e-18, rawSq))
      }
    }
    const k = Math.max(1, entry.files.length)
    console.log(
      `| \`${entry.id}\` | ${entry.bus} | ${entry.files.length} | ${entry.target} | ${entry.gain} | ${(rawPeak / k).toFixed(1)} | ${(rms50 / k).toFixed(1)} | ${(effPeak / k).toFixed(1)} | ${(effRms50 / k).toFixed(1)} | ${entry.loop ? "0.0" : (envLoss / k).toFixed(1)} | ${entry.range.ref}..${entry.range.max}m | ${entry.steal ?? "steal-oldest"} (${entry.maxVoices ?? 24}) |`,
    )
  }
}
