const STORE_KEY = "afterhours-audio-lab:v1"
const $ = (s, el = document) => el.querySelector(s)

const state = {
  manifest: null,
  cats: [], // [{ id, group, label, loop, sounds: [] }]
  store: loadStore(), // { sounds: { [file]: { fav, rating, notes, loop, gen } }, ab: { [cat]: { a, b } } }
  selected: null, // file
  playing: null, // { file, source, startedAt, offset, loop }
  buffers: new Map(),
  peaks: new Map(),
  cards: new Map(), // file -> card element
}

let ctx
let master
function audio() {
  if (!ctx) {
    ctx = new AudioContext()
    master = ctx.createGain()
    master.gain.value = Number($("#volume").value) ** 2
    master.connect(ctx.destination)
  }
  if (ctx.state === "suspended") ctx.resume()
  return ctx
}

function loadStore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || "{}")
    return { sounds: s.sounds || {}, ab: s.ab || {}, ui: s.ui || {}, previous: s.previous || {} }
  } catch {
    return { sounds: {}, ab: {}, ui: {}, previous: {} }
  }
}
let saveTimer
function save() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => localStorage.setItem(STORE_KEY, JSON.stringify(state.store)), 150)
}
function rec(sound) {
  return state.store.sounds[sound.file] || {}
}
function setRec(sound, patch) {
  const cur = { ...rec(sound), ...patch, gen: sound.generatedAt }
  if (!cur.fav && !cur.rating && !cur.notes && cur.loop === undefined) delete state.store.sounds[sound.file]
  else state.store.sounds[sound.file] = cur
  save()
}

function toast(msg) {
  const t = $("#toast")
  t.textContent = msg
  t.classList.add("show")
  clearTimeout(toast.t)
  toast.t = setTimeout(() => t.classList.remove("show"), 1800)
}

// ---------- data ----------
async function init() {
  const res = await fetch("sfx/manifest.json", { cache: "no-store" })
  state.manifest = await res.json()
  const byCat = new Map()
  for (const c of state.manifest.categories) byCat.set(c.id, { ...c, sounds: [] })
  for (const s of state.manifest.sounds) {
    if (!byCat.has(s.category)) byCat.set(s.category, { id: s.category, group: s.group, label: s.category, loop: s.loop, sounds: [] })
    byCat.get(s.category).sounds.push(s)
  }
  state.cats = [...byCat.values()].filter((c) => c.sounds.length)
  // A file that was regenerated keeps its name; move ratings/notes made on the old take aside so they don't
  // silently apply to new audio. Unchanged files keep their records untouched.
  let moved = 0
  for (const s of state.manifest.sounds) {
    const r = state.store.sounds[s.file]
    if (r?.gen && r.gen !== s.generatedAt) {
      ;(state.store.previous[s.file] ||= []).push({ ...r, prompt: s.previous?.prompt })
      delete state.store.sounds[s.file]
      moved++
    }
  }
  if (moved) {
    save()
    setTimeout(() => toast(`${moved} rated sounds were regenerated; earlier ratings shown as "previous take"`), 300)
  }
  const groups = [...new Set(state.cats.map((c) => c.group))]
  for (const g of groups) $("#group").append(new Option(g, g))
  const ui = state.store.ui
  if (ui.group) $("#group").value = ui.group
  $("#favOnly").checked = !!ui.favOnly
  $("#ratedOnly").checked = !!ui.ratedOnly
  if (ui.volume != null) $("#volume").value = ui.volume
  if (ui.autoLoop != null) $("#autoLoop").checked = ui.autoLoop
  if (ui.qa) $("#qaFilter").value = ui.qa
  render()
}

function soundByFile(file) {
  for (const c of state.cats) for (const s of c.sounds) if (s.file === file) return s
}
function catOf(sound) {
  return state.cats.find((c) => c.id === sound.category)
}
function visibleCats() {
  const q = $("#search").value.trim().toLowerCase()
  const group = $("#group").value
  const favOnly = $("#favOnly").checked
  const ratedOnly = $("#ratedOnly").checked
  const qaF = $("#qaFilter").value
  const out = []
  for (const c of state.cats) {
    if (group && c.group !== group) continue
    const catMatch = !q || c.id.includes(q) || c.label.toLowerCase().includes(q)
    const sounds = c.sounds.filter((s) => {
      const r = rec(s)
      if (favOnly && !r.fav) return false
      if (ratedOnly && !r.rating) return false
      const sc = s.qa?.score ?? 0
      if (qaF === "good" && sc < 4) return false
      if (qaF === "weak" && sc > 3) return false
      if (qaF === "changed" && s.status !== "regenerated" && s.status !== "added") return false
      if (!catMatch && !s.prompt.toLowerCase().includes(q) && !(s.qa?.description || "").toLowerCase().includes(q) && !(r.notes || "").toLowerCase().includes(q)) return false
      return true
    })
    if (sounds.length) out.push({ cat: c, sounds })
  }
  return out
}

// ---------- render ----------
function render() {
  const list = $("#list")
  list.textContent = ""
  state.cards.clear()
  const vis = visibleCats()
  let lastGroup = null
  for (const { cat, sounds } of vis) {
    if (cat.group !== lastGroup) {
      lastGroup = cat.group
      const h = document.createElement("h2")
      h.className = "group-title"
      h.textContent = cat.group
      list.append(h)
    }
    const sec = document.createElement("section")
    sec.className = "cat"
    sec.id = `cat-${cat.id}`
    const ab = state.store.ab[cat.id] || {}
    sec.innerHTML = `
      <div class="cat-head">
        <h3></h3><code>${cat.id}</code>${cat.loop ? '<span class="tag">loop</span>' : ""}
        <div class="ab">A <b class="a">${ab.a ? short(ab.a) : "–"}</b> · B <b class="b">${ab.b ? short(ab.b) : "–"}</b>
          <button class="swap" title="A/B swap (X)">⇄ A/B</button></div>
      </div>
      <div class="grid"></div>`
    $("h3", sec).textContent = cat.label
    $(".swap", sec).onclick = () => abSwap(cat.id)
    const grid = $(".grid", sec)
    for (const s of sounds) grid.append(card(s, cat))
    list.append(sec)
  }
  if (!vis.length) list.innerHTML = `<div class="empty">Nothing matches.</div>`
  renderToc(vis)
  renderStats()
  if (!state.selected || !state.cards.has(state.selected)) {
    const first = vis[0]?.sounds[0]
    state.selected = first?.file || null
  }
  markSelected(false)
  observeWaves()
}

const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
function qa_title(s) {
  const lines = [`Intent: ${s.qa.intent}`, `Issues: ${s.qa.issues}`, `Judge: ${s.qa.model}`]
  if (s.attempts?.length)
    lines.push("Takes:", ...s.attempts.map((a) => `${a.chosen ? "✓" : "·"} ${a.score}/5 ${a.prompt}`))
  return lines.join("\n")
}
const short = (file) => file.split("/").pop().replace(".mp3", "")

function renderToc(vis) {
  const toc = $("#toc")
  toc.textContent = ""
  let lastGroup
  for (const { cat } of vis) {
    if (cat.group !== lastGroup) {
      lastGroup = cat.group
      const g = document.createElement("span")
      g.className = "grp"
      g.textContent = cat.group
      toc.append(g)
    }
    const a = document.createElement("a")
    a.href = `#cat-${cat.id}`
    a.textContent = cat.label.replace(/^Footsteps: /, "")
    if (cat.sounds.some((s) => rec(s).fav)) a.className = "has-pick"
    toc.append(a)
  }
}

function renderStats() {
  const n = state.manifest.sounds.length
  const picks = state.manifest.sounds.filter((s) => rec(s).fav).length
  const rated = state.manifest.sounds.filter((s) => rec(s).rating).length
  const good = state.manifest.sounds.filter((s) => (s.qa?.score ?? 0) >= 4).length
  const changed = state.manifest.sounds.filter((s) => s.status === "regenerated" || s.status === "added").length
  $("#stats").textContent = `${n} sounds · ${state.cats.length} categories · QA ≥4: ${good} · ${changed} regenerated/new · ${picks} ★ · ${rated} rated · ${state.manifest.totalCost} credits`
}

function card(s, cat) {
  const r = rec(s)
  const el = document.createElement("div")
  el.className = "card"
  el.tabIndex = -1
  el.dataset.file = s.file
  const prev = (state.store.previous[s.file] || []).at(-1)
  const badge =
    s.status === "regenerated"
      ? `<span class="badge regen" title="Regenerated after listening QA. Previous take${s.previous?.score ? ` (QA ${s.previous.score}/5)` : ""}: ${esc(s.previous?.prompt || "")}${s.previous?.description ? ` — heard: ${esc(s.previous.description)}` : ""}">regenerated</span>`
      : s.status === "added"
        ? '<span class="badge added" title="New variant added to reach 3 good takes">new</span>'
        : s.status === "locked"
          ? '<span class="badge locked" title="Approved take, never regenerated">approved</span>'
          : ""
  const qa = s.qa
    ? `<div class="qa" title="${esc(qa_title(s))}"><span class="score s${s.qa.score}">QA ${s.qa.score}/5</span> ${esc(s.qa.description)}</div>`
    : '<div class="qa muted">no QA yet</div>'
  el.innerHTML = `
    <div class="row">
      <button class="play" title="Play/stop (Space)">▶</button>
      <span class="vname">${s.variant}</span>
      <span class="meta">${s.duration ?? "auto"}s · pi ${s.influence}</span>
      ${badge}
      <span class="spacer"></span>
      <button class="tag a" title="Mark as A (A)">A</button>
      <button class="tag b" title="Mark as B (B)">B</button>
      ${cat.loop || s.loop ? '<button class="tag loop" title="Loop (L)">loop</button>' : ""}
      <button class="star" title="Pick (S)">★</button>
    </div>
    <canvas class="wave"></canvas>
    <div class="prompt"></div>
    ${qa}
    ${prev ? `<div class="stale">previous take: ${prev.fav ? "★ " : ""}${prev.rating ? `${prev.rating}/5 ` : ""}${esc(prev.notes || "")}</div>` : ""}
    <div class="row">
      <div class="rating">${[1, 2, 3, 4, 5].map((i) => `<button data-r="${i}" title="${i} (key ${i})">●</button>`).join("")}</div>
      <textarea class="notes" placeholder="notes…" rows="1"></textarea>
    </div>`
  $(".prompt", el).textContent = s.prompt
  $(".notes", el).value = r.notes || ""
  $(".play", el).onclick = (e) => {
    e.stopPropagation()
    select(s.file)
    toggle(s.file)
  }
  $(".star", el).onclick = () => toggleFav(s)
  $(".tag.a", el).onclick = () => setAB(s, "a")
  $(".tag.b", el).onclick = () => setAB(s, "b")
  const loopBtn = $(".tag.loop", el)
  if (loopBtn) loopBtn.onclick = () => toggleLoop(s)
  for (const b of el.querySelectorAll(".rating button")) b.onclick = () => rate(s, Number(b.dataset.r))
  $(".notes", el).oninput = (e) => setRec(s, { notes: e.target.value })
  $(".notes", el).onfocus = () => select(s.file, false)
  const canvas = $("canvas", el)
  canvas.onclick = (e) => {
    const rect = canvas.getBoundingClientRect()
    select(s.file)
    play(s.file, ((e.clientX - rect.left) / rect.width) * (state.buffers.get(s.file)?.duration || 0))
  }
  el.onmousedown = (e) => {
    if (!e.target.closest("textarea")) select(s.file, false)
  }
  state.cards.set(s.file, el)
  updateCard(s)
  return el
}

function updateCard(s) {
  const el = state.cards.get(s.file)
  if (!el) return
  const r = rec(s)
  const ab = state.store.ab[s.category] || {}
  el.classList.toggle("fav", !!r.fav)
  $(".star", el).classList.toggle("on", !!r.fav)
  $(".tag.a", el).classList.toggle("on", ab.a === s.file)
  $(".tag.b", el).classList.toggle("on", ab.b === s.file)
  const loopBtn = $(".tag.loop", el)
  if (loopBtn) loopBtn.classList.toggle("on", wantsLoop(s))
  for (const b of el.querySelectorAll(".rating button")) b.classList.toggle("on", Number(b.dataset.r) <= (r.rating || 0))
  el.classList.toggle("playing", state.playing?.file === s.file)
  $(".play", el).textContent = state.playing?.file === s.file ? "■" : "▶"
}

function updateCatHead(catId) {
  const sec = document.getElementById(`cat-${catId}`)
  if (!sec) return
  const ab = state.store.ab[catId] || {}
  $(".ab b.a", sec).textContent = ab.a ? short(ab.a) : "–"
  $(".ab b.b", sec).textContent = ab.b ? short(ab.b) : "–"
}

// ---------- waveform ----------
let io
function observeWaves() {
  io?.disconnect()
  io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        io.unobserve(e.target)
        const file = e.target.closest(".card").dataset.file
        load(file).then(() => drawWave(file)).catch(() => {})
      }
    },
    { rootMargin: "300px" },
  )
  for (const el of state.cards.values()) io.observe($("canvas", el))
}

const loading = new Map()
function load(file) {
  if (state.buffers.has(file)) return Promise.resolve(state.buffers.get(file))
  if (loading.has(file)) return loading.get(file)
  const s = soundByFile(file)
  const p = fetch(`${file}?v=${encodeURIComponent(s?.generatedAt || "")}`)
    .then((r) => r.arrayBuffer())
    .then((ab) => audio().decodeAudioData(ab))
    .then((buf) => {
      state.buffers.set(file, buf)
      const n = 300
      const data = buf.getChannelData(0)
      const step = Math.max(1, Math.floor(data.length / n))
      const peaks = new Float32Array(n)
      let max = 0
      for (let i = 0; i < n; i++) {
        let m = 0
        for (let j = i * step, end = Math.min(data.length, j + step); j < end; j++) m = Math.max(m, Math.abs(data[j]))
        peaks[i] = m
        max = Math.max(max, m)
      }
      state.peaks.set(file, { peaks, max })
      return buf
    })
  loading.set(file, p)
  return p
}

function drawWave(file, progress = -1) {
  const el = state.cards.get(file)
  const pk = state.peaks.get(file)
  if (!el || !pk) return
  const c = $("canvas", el)
  const dpr = devicePixelRatio || 1
  const w = c.clientWidth * dpr
  const h = c.clientHeight * dpr
  if (c.width !== w || c.height !== h) {
    c.width = w
    c.height = h
  }
  const g = c.getContext("2d")
  g.clearRect(0, 0, w, h)
  const n = pk.peaks.length
  const bw = w / n
  const px = progress >= 0 ? progress * w : -1
  for (let i = 0; i < n; i++) {
    const a = Math.max(1 * dpr, (pk.peaks[i] / (pk.max || 1)) * (h / 2 - 2 * dpr))
    const x = i * bw
    g.fillStyle = px >= 0 && x <= px ? "#e8a24a" : "#3f6f64"
    g.fillRect(x, h / 2 - a, Math.max(1, bw - 0.5), a * 2)
  }
  if (px >= 0) {
    g.fillStyle = "#fff"
    g.fillRect(px, 0, dpr, h)
  }
}

// ---------- playback ----------
function wantsLoop(s) {
  const r = rec(s)
  if (r.loop !== undefined) return r.loop
  return $("#autoLoop").checked && (s.loop || !!catOf(s)?.loop)
}

async function play(file, offset = 0) {
  const s = soundByFile(file)
  const buf = await load(file)
  stop()
  const ac = audio()
  const src = ac.createBufferSource()
  src.buffer = buf
  src.loop = wantsLoop(s)
  src.connect(master)
  offset = Math.max(0, Math.min(offset, buf.duration - 0.01))
  src.start(0, offset)
  const p = { file, source: src, startedAt: ac.currentTime, offset }
  state.playing = p
  src.onended = () => {
    if (state.playing === p) {
      state.playing = null
      updateCard(s)
      drawWave(file)
    }
  }
  updateCard(s)
  tick()
}

function stop() {
  const p = state.playing
  if (!p) return
  state.playing = null
  p.source.onended = null
  try {
    p.source.stop()
  } catch {}
  const s = soundByFile(p.file)
  if (s) updateCard(s)
  drawWave(p.file)
}

function position() {
  const p = state.playing
  if (!p) return 0
  const d = p.source.buffer.duration
  const t = p.offset + (ctx.currentTime - p.startedAt)
  return p.source.loop ? t % d : Math.min(t, d)
}

function toggle(file) {
  if (state.playing?.file === file) stop()
  else play(file)
}

function tick() {
  const p = state.playing
  if (!p) return
  drawWave(p.file, position() / p.source.buffer.duration)
  requestAnimationFrame(tick)
}

// ---------- actions ----------
function select(file, scroll = true) {
  if (!file || !state.cards.has(file)) return
  state.selected = file
  markSelected(scroll)
}
function markSelected(scroll) {
  for (const [f, el] of state.cards) el.classList.toggle("sel", f === state.selected)
  const el = state.cards.get(state.selected)
  if (el && scroll) el.scrollIntoView({ block: "nearest", behavior: "smooth" })
}

function toggleFav(s) {
  setRec(s, { fav: !rec(s).fav })
  updateCard(s)
  renderStats()
  renderToc(visibleCats())
}
function rate(s, n) {
  setRec(s, { rating: rec(s).rating === n ? 0 : n })
  updateCard(s)
  renderStats()
}
function toggleLoop(s) {
  const next = !wantsLoop(s)
  setRec(s, { loop: next })
  if (state.playing?.file === s.file) state.playing.source.loop = next
  updateCard(s)
}
function setAB(s, which) {
  const ab = (state.store.ab[s.category] ||= {})
  const other = which === "a" ? "b" : "a"
  ab[which] = ab[which] === s.file ? undefined : s.file
  if (ab[other] === s.file && ab[which] === s.file) ab[other] = undefined
  save()
  for (const x of catOf(s).sounds) updateCard(x)
  updateCatHead(s.category)
}
function abSwap(catId) {
  const cat = state.cats.find((c) => c.id === catId)
  const ab = { ...(state.store.ab[catId] || {}) }
  ab.a ||= cat.sounds[0]?.file
  ab.b ||= cat.sounds.find((s) => s.file !== ab.a)?.file
  if (!ab.a || !ab.b) return
  const cur = state.playing?.file
  const target = cur === ab.a ? ab.b : ab.a
  const pos = cur === ab.a || cur === ab.b ? position() : 0
  select(target, false)
  play(target, pos)
  toast(`${target === ab.a ? "A" : "B"} · ${short(target)}`)
}

function exportPicks() {
  const picks = []
  for (const c of state.cats)
    for (const s of c.sounds) {
      const r = rec(s)
      if (!r.fav && !r.rating && !r.notes) continue
      picks.push({
        category: s.category,
        group: s.group,
        variant: s.variant,
        file: `games/afterhours/audio-lab/${s.file}`,
        fav: !!r.fav,
        rating: r.rating || 0,
        notes: r.notes || "",
        prompt: s.prompt,
        duration: s.duration,
        influence: s.influence,
        loop: s.loop,
        qa: s.qa ? { score: s.qa.score, description: s.qa.description } : null,
        status: s.status || null,
      })
    }
  const ab = Object.fromEntries(
    Object.entries(state.store.ab)
      .filter(([, v]) => v.a || v.b)
      .map(([k, v]) => [k, { a: v.a ? short(v.a) : null, b: v.b ? short(v.b) : null }]),
  )
  const previousTakes = state.store.previous
  const out = { exportedAt: new Date().toISOString(), model: state.manifest.model, count: picks.length, picks, ab, previousTakes }
  const json = JSON.stringify(out, null, 2)
  const a = document.createElement("a")
  a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }))
  a.download = "picks.json"
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  navigator.clipboard?.writeText(json).then(
    () => toast(`Exported ${picks.length} picks · copied to clipboard`),
    () => toast(`Exported ${picks.length} picks (clipboard blocked)`),
  )
}

// ---------- navigation ----------
function navVariant(dir) {
  const files = [...state.cards.keys()]
  const i = files.indexOf(state.selected)
  const cur = soundByFile(state.selected)
  const next = files[i + dir]
  if (!next) return
  // stay within the category for left/right
  if (cur && soundByFile(next).category !== cur.category) return
  select(next)
}
function navCategory(dir) {
  const vis = visibleCats()
  const cur = soundByFile(state.selected)
  const ci = vis.findIndex((v) => v.cat.id === cur?.category)
  const target = vis[ci + dir]
  if (!target) return
  const idx = cur ? Math.max(0, catOf(cur).sounds.indexOf(cur)) : 0
  const pick = target.sounds[Math.min(idx, target.sounds.length - 1)]
  select(pick.file)
}

document.addEventListener("keydown", (e) => {
  const t = e.target
  const typing = t.matches?.("input[type=search], textarea, select")
  if (e.key === "Escape") {
    if (typing) t.blur()
    stop()
    return
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return
  const s = soundByFile(state.selected)
  switch (e.key) {
    case " ":
      e.preventDefault()
      if (s) toggle(s.file)
      break
    case "ArrowRight":
      e.preventDefault()
      navVariant(1)
      break
    case "ArrowLeft":
      e.preventDefault()
      navVariant(-1)
      break
    case "ArrowDown":
      e.preventDefault()
      navCategory(1)
      break
    case "ArrowUp":
      e.preventDefault()
      navCategory(-1)
      break
    case "s":
    case "f":
      if (s) toggleFav(s)
      break
    case "a":
    case "b":
      if (s) setAB(s, e.key)
      break
    case "x":
      if (s) abSwap(s.category)
      break
    case "l":
      if (s) toggleLoop(s)
      break
    case "n":
      if (s) {
        e.preventDefault()
        $(".notes", state.cards.get(s.file))?.focus()
      }
      break
    case "/":
      e.preventDefault()
      $("#search").focus()
      break
    case "?":
      $("#helpDlg").showModal()
      break
    default:
      if (s && /^[0-5]$/.test(e.key)) rate(s, Number(e.key) || rec(s).rating || 0)
  }
})

function saveUi() {
  state.store.ui = {
    group: $("#group").value,
    favOnly: $("#favOnly").checked,
    ratedOnly: $("#ratedOnly").checked,
    volume: Number($("#volume").value),
    autoLoop: $("#autoLoop").checked,
    qa: $("#qaFilter").value,
  }
  save()
}
let searchTimer
$("#search").oninput = () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(render, 120)
}
for (const id of ["#group", "#favOnly", "#ratedOnly", "#qaFilter"])
  $(id).onchange = () => {
    saveUi()
    render()
  }
$("#autoLoop").onchange = () => {
  saveUi()
  for (const c of state.cats) for (const s of c.sounds) updateCard(s)
}
$("#volume").oninput = () => {
  if (master) master.gain.value = Number($("#volume").value) ** 2
  saveUi()
}
$("#stopAll").onclick = stop
$("#export").onclick = exportPicks
$("#help").onclick = () => $("#helpDlg").showModal()

init().catch((err) => {
  $("#list").innerHTML = `<div class="empty">Could not load sfx/manifest.json: ${err.message}</div>`
})
