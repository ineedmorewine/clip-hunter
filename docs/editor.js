// clip-hunter editor: trims a clip, cuts in videos/images/black frames,
// layers stickers/GIFs/text and sound effects, and records the result to MP4
// in real time (canvas + Web Audio + MediaRecorder). Everything stays local.

const W = 1080, H = 1920, FPS = 30;
const GIPHY_KEY = "clip-hunter-giphy-key";
const EMOJI = [
  "1f602", "1f923", "1f62d", "1f480", "1f525", "1f631", "1f92f", "1f633", "1f644", "1f60f",
  "1f921", "1f440", "1f4af", "1f44f", "1f389", "1f621", "1f92c", "1f634", "1f976", "1f975",
  "1f608", "1f47b", "1f4a5", "26a1", "1f494", "1f914", "1f62c", "1fae0", "1f643", "1f926",
  "1f64f", "1f44b", "1f90c", "1f60e", "1f973", "1f629", "1f970", "1f92e", "1f910", "1f44d",
];

let S = {};
const state = {
  base: null,      // { video, name, duration, in, out, volume, audioNode, gain }
  inserts: [],     // { id, kind: video|image|black, at, dur, el, name, volume, gain }
  overlays: [],    // { id, kind: sticker|text, start, dur, x, y, w, frames|text, ... }
  sounds: [],      // { id, name, start, buffer, volume, credit }
  selected: null,
  t: 0,            // output time in seconds
  playing: false,
  exporting: false,
};
let nextId = 1;

// ---------- small helpers ----------

const $ = id => document.getElementById(id);
function fmt(t, v = {}) { return (t || "").replace(/\{(\w+)\}/g, (_, k) => v[k] ?? ""); }
function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) n.append(c);
  return n;
}
function tc(t) {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}
function store(key, value) {
  try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key); } catch { /* ignore */ }
}
function load(key) { try { return localStorage.getItem(key) || ""; } catch { return ""; } }
function fileButton(label, accept, onFile, cls = "btn ghost") {
  const input = el("input", { type: "file", accept, onchange: e => { const f = e.target.files[0]; if (f) onFile(f); e.target.value = ""; } });
  return el("label", { class: `${cls} file-btn` }, [el("span", { text: label }), input]);
}

// ---------- audio graph ----------

const ctx = new AudioContext();
const master = ctx.createGain();
const recordDest = ctx.createMediaStreamDestination();
master.connect(ctx.destination);
master.connect(recordDest);

function mediaGain(mediaEl, volume) {
  const node = ctx.createMediaElementSource(mediaEl);
  const gain = ctx.createGain();
  gain.gain.value = volume;
  node.connect(gain).connect(master);
  return gain;
}

// ---------- timeline model ----------

function segments() {
  const b = state.base;
  if (!b) return [];
  const ins = state.inserts.map(i => ({ ...i, at: Math.min(Math.max(i.at, b.in), b.out) }))
    .sort((x, y) => x.at - y.at);
  const segs = [];
  let cursor = b.in, out = 0;
  for (const i of ins) {
    if (i.at > cursor) { segs.push({ type: "base", from: cursor, to: i.at, outStart: out }); out += i.at - cursor; cursor = i.at; }
    segs.push({ type: "insert", ins: state.inserts.find(x => x.id === i.id), outStart: out }); out += i.dur;
  }
  if (b.out > cursor) segs.push({ type: "base", from: cursor, to: b.out, outStart: out });
  for (const s of segs) s.outEnd = s.outStart + (s.type === "base" ? s.to - s.from : s.ins.dur);
  return segs;
}
function total() { const s = segments(); return s.length ? s[s.length - 1].outEnd : 0; }
function segAt(t) { const segs = segments(); return segs.find(s => t >= s.outStart && t < s.outEnd) || segs[segs.length - 1]; }
// Base-clip time at output time t (inserts map to the base time where they sit).
function baseTimeAt(t) {
  const s = segAt(t);
  if (!s) return 0;
  return s.type === "base" ? s.from + (t - s.outStart) : s.ins.at;
}

// ---------- media sync + drawing ----------

let activeMedia = null;
function syncMedia(t, forcePlay) {
  const s = segAt(t);
  let want = null, wantTime = 0;
  if (s?.type === "base") { want = state.base.video; wantTime = s.from + (t - s.outStart); }
  else if (s?.ins.kind === "video") { want = s.ins.el; wantTime = t - s.outStart; }
  if (activeMedia && activeMedia !== want) activeMedia.pause();
  activeMedia = want;
  if (!want) return;
  if (Math.abs(want.currentTime - wantTime) > 0.25) want.currentTime = wantTime;
  if ((state.playing || forcePlay) && want.paused) want.play().catch(() => {});
  if (!state.playing && !forcePlay && !want.paused) want.pause();
}

function drawContain(c, src, sw, sh) {
  const scale = Math.min(W / sw, H / sh);
  const dw = sw * scale, dh = sh * scale;
  c.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

function stickerFrame(o, local) {
  if (o.frames.length === 1) return o.frames[0].bmp;
  const totalMs = o.loopMs || 1;
  let ms = (local * 1000) % totalMs;
  for (const f of o.frames) { if (ms < f.ms) return f.bmp; ms -= f.ms; }
  return o.frames[o.frames.length - 1].bmp;
}

function draw() {
  const c = $("canvas").getContext("2d");
  c.fillStyle = "#000";
  c.fillRect(0, 0, W, H);
  const t = state.t;
  const s = segAt(t);
  if (s?.type === "base") drawContain(c, state.base.video, state.base.video.videoWidth || W, state.base.video.videoHeight || H);
  else if (s?.ins.kind === "video" && s.ins.el.videoWidth) drawContain(c, s.ins.el, s.ins.el.videoWidth, s.ins.el.videoHeight);
  else if (s?.ins.kind === "image") drawContain(c, s.ins.el, s.ins.el.width, s.ins.el.height);

  for (const o of state.overlays) {
    if (t < o.start || t >= o.start + o.dur) continue;
    if (o.kind === "sticker") {
      const bmp = stickerFrame(o, t - o.start);
      const w = o.w * W, h = w * (bmp.height / bmp.width);
      c.drawImage(bmp, o.x * W - w / 2, o.y * H - h / 2, w, h);
      o.box = [o.x * W - w / 2, o.y * H - h / 2, w, h];
    } else if (o.kind === "text") {
      const size = Math.round(o.w * 400);
      c.font = `800 ${size}px "DM Sans", system-ui, sans-serif`;
      c.textAlign = "center"; c.textBaseline = "middle";
      c.lineJoin = "round"; c.lineWidth = size * 0.16; c.strokeStyle = "#000";
      const lines = o.text.split("\n");
      lines.forEach((line, i) => {
        const y = o.y * H + (i - (lines.length - 1) / 2) * size * 1.15;
        c.strokeText(line, o.x * W, y);
        c.fillStyle = o.color; c.fillText(line, o.x * W, y);
      });
      const wMax = Math.max(...lines.map(l => c.measureText(l).width));
      o.box = [o.x * W - wMax / 2, o.y * H - lines.length * size * 0.6, wMax, lines.length * size * 1.2];
    }
    if (state.selected === o.id && !state.exporting) {
      c.strokeStyle = "#d6a84e"; c.lineWidth = 6; c.setLineDash([18, 12]);
      c.strokeRect(...o.box); c.setLineDash([]);
    }
  }
  const tot = total();
  $("time").textContent = `${tc(t)} / ${tc(tot)}`;
  if (!scrubbing) $("scrub").value = tot ? Math.round((t / tot) * 1000) : 0;
  const head = document.querySelector(".track .head");
  if (head && tot) head.style.left = `${(t / tot) * 100}%`;
}

// ---------- playback ----------

let clockStart = 0, tAtStart = 0, rafId = 0, soundNodes = [], onEnded = null;

function scheduleSounds(fromT) {
  stopSounds();
  for (const snd of state.sounds) {
    const offset = fromT - snd.start;
    if (offset >= snd.buffer.duration) continue;
    const src = ctx.createBufferSource();
    src.buffer = snd.buffer;
    const g = ctx.createGain(); g.gain.value = snd.volume;
    src.connect(g).connect(master);
    src.start(ctx.currentTime + Math.max(0, -offset), Math.max(0, offset));
    soundNodes.push(src);
  }
}
function stopSounds() { soundNodes.forEach(n => { try { n.stop(); } catch { /* already stopped */ } }); soundNodes = []; }

function tick() {
  state.t = tAtStart + (performance.now() - clockStart) / 1000;
  const tot = total();
  if (state.t >= tot) {
    state.t = tot;
    pause();
    draw();
    if (onEnded) { const cb = onEnded; onEnded = null; cb(); }
    return;
  }
  syncMedia(state.t);
  draw();
  rafId = requestAnimationFrame(tick);
}

async function play() {
  if (!state.base) return;
  await ctx.resume();
  if (state.t >= total() - 0.05) state.t = 0;
  state.playing = true;
  syncMedia(state.t, true);
  // Give the media element a moment to reach the seek target before the clock starts.
  await new Promise(r => setTimeout(r, 120));
  clockStart = performance.now(); tAtStart = state.t;
  scheduleSounds(state.t);
  $("play-btn").textContent = `❚❚ ${S.pause}`;
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(tick);
}
function pause() {
  state.playing = false;
  cancelAnimationFrame(rafId);
  stopSounds();
  if (activeMedia) activeMedia.pause();
  $("play-btn").textContent = `▶ ${S.play}`;
}
function seek(t) {
  const was = state.playing;
  if (was) pause();
  state.t = Math.max(0, Math.min(t, total()));
  syncMedia(state.t);
  const m = activeMedia;
  if (m) m.addEventListener("seeked", draw, { once: true });
  draw();
  if (was) play();
}

// ---------- export ----------

async function exportVideo() {
  if (state.exporting || !state.base) return;
  pause();
  state.exporting = true;
  const prevSel = state.selected; state.selected = null;
  const mime = ["video/mp4;codecs=avc1.640028,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm"]
    .find(m => MediaRecorder.isTypeSupported(m));
  if (!mime.startsWith("video/mp4")) $("export-status").textContent = S.exportNoSupport;
  const stream = new MediaStream([...$("canvas").captureStream(FPS).getVideoTracks(), ...recordDest.stream.getAudioTracks()]);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000, audioBitsPerSecond: 192_000 });
  const chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  const done = new Promise(r => { rec.onstop = r; });
  $("export-btn").setAttribute("disabled", "");
  state.t = 0; syncMedia(0); await new Promise(r => setTimeout(r, 400));
  const tot = total();
  const progress = setInterval(() => {
    $("export-status").textContent = fmt(S.exporting, { p: Math.min(99, Math.round((state.t / tot) * 100)) });
  }, 300);
  rec.start(500);
  onEnded = () => rec.stop();
  await play();
  await done;
  clearInterval(progress);
  const ext = mime.startsWith("video/mp4") ? "mp4" : "webm";
  const blob = new Blob(chunks, { type: mime.split(";")[0] });
  const a = el("a", { href: URL.createObjectURL(blob), download: `${(state.base.name || "klip").replace(/\.[^.]+$/, "")}_edit.${ext}` });
  document.body.append(a); a.click(); a.remove();
  $("export-status").textContent = S.exportDone;
  $("export-btn").removeAttribute("disabled");
  state.exporting = false; state.selected = prevSel; draw();
}

// ---------- loading media ----------

async function decodeImage(blob) {
  // Animated GIF/WebP -> frames with durations; static images -> one frame.
  if ("ImageDecoder" in window && /gif|webp|png|apng/.test(blob.type)) {
    try {
      const dec = new ImageDecoder({ data: await blob.arrayBuffer(), type: blob.type });
      await dec.tracks.ready;
      const count = Math.min(dec.tracks.selectedTrack.frameCount || 1, 240);
      const frames = [];
      for (let i = 0; i < count; i++) {
        const { image } = await dec.decode({ frameIndex: i });
        frames.push({ bmp: await createImageBitmap(image), ms: Math.max(20, (image.duration || 100000) / 1000) });
        image.close();
      }
      if (frames.length) return frames;
    } catch { /* fall back to a static decode */ }
  }
  return [{ bmp: await createImageBitmap(blob), ms: 100 }];
}

async function addSticker(source, label) {
  try {
    const blob = source instanceof Blob ? source : await (await fetch(source)).blob();
    const frames = await decodeImage(blob);
    const o = { id: nextId++, kind: "sticker", label, start: state.t, dur: 2.5, x: 0.5, y: 0.3, w: 0.4, frames,
                loopMs: frames.reduce((s, f) => s + f.ms, 0) };
    state.overlays.push(o); state.selected = o.id;
    renderLayers(); draw();
  } catch {
    alert(S.stickerFailed);
  }
}

function addText(text) {
  if (!text.trim()) return;
  const o = { id: nextId++, kind: "text", label: text, text, start: state.t, dur: 3, x: 0.5, y: 0.18, w: 0.22, color: "#ffffff" };
  state.overlays.push(o); state.selected = o.id;
  renderLayers(); draw();
}

async function addSound(source, name, credit = "") {
  const buf = source instanceof Blob ? await source.arrayBuffer() : await (await fetch(source)).arrayBuffer();
  const buffer = await ctx.decodeAudioData(buf);
  state.sounds.push({ id: nextId++, kind: "sound", label: name, start: state.t, buffer, volume: 0.9, credit });
  renderLayers(); draw();
}

function addInsert(kind, file) {
  const at = baseTimeAt(state.t);
  const ins = { id: nextId++, kind, at, dur: 2, name: file?.name || S.kindInsertBlack, volume: 1 };
  if (kind === "video") {
    const v = el("video", { playsinline: "", preload: "auto" });
    v.src = URL.createObjectURL(file);
    v.addEventListener("loadedmetadata", () => { ins.dur = Math.round(v.duration * 10) / 10; renderLayers(); draw(); }, { once: true });
    ins.el = v; ins.gain = mediaGain(v, 1);
  } else if (kind === "image") {
    const img = new Image(); img.src = URL.createObjectURL(file); img.onload = draw; ins.el = img;
  }
  state.inserts.push(ins);
  renderLayers(); draw();
}

function openBase(file) {
  const v = el("video", { playsinline: "", preload: "auto" });
  v.src = URL.createObjectURL(file);
  v.addEventListener("loadedmetadata", () => {
    state.base = { video: v, name: file.name, duration: v.duration, in: 0, out: v.duration, volume: 1 };
    state.base.gain = mediaGain(v, 1);
    $("open-screen").hidden = true; $("editor").hidden = false;
    $("export-btn").removeAttribute("disabled");
    renderTrim(); renderLayers();
    v.addEventListener("seeked", draw);
    seek(0);
  }, { once: true });
  v.addEventListener("error", () => alert(S.loadFailed), { once: true });
}

// ---------- canvas interaction ----------

let drag = null;
function canvasPoint(e) {
  const r = $("canvas").getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
}
function setupCanvas() {
  const cv = $("canvas");
  cv.addEventListener("pointerdown", e => {
    const [px, py] = canvasPoint(e);
    const hit = [...state.overlays].reverse().find(o => o.box && state.t >= o.start && state.t < o.start + o.dur &&
      px >= o.box[0] && px <= o.box[0] + o.box[2] && py >= o.box[1] && py <= o.box[1] + o.box[3]);
    state.selected = hit ? hit.id : null;
    if (hit) { drag = { o: hit, dx: px / W - hit.x, dy: py / H - hit.y }; cv.setPointerCapture(e.pointerId); }
    renderLayers(); draw();
  });
  cv.addEventListener("pointermove", e => {
    if (!drag) return;
    const [px, py] = canvasPoint(e);
    drag.o.x = Math.min(1, Math.max(0, px / W - drag.dx));
    drag.o.y = Math.min(1, Math.max(0, py / H - drag.dy));
    draw();
  });
  cv.addEventListener("pointerup", () => { drag = null; });
  cv.addEventListener("wheel", e => {
    const o = state.overlays.find(x => x.id === state.selected);
    if (!o) return;
    e.preventDefault();
    o.w = Math.min(1.5, Math.max(0.05, o.w * (e.deltaY < 0 ? 1.06 : 0.94)));
    renderLayers(); draw();
  }, { passive: false });
}

// ---------- panels ----------

const TABS = ["Stickers", "Sounds", "Inserts", "Text"];
let currentTab = "Stickers";

function renderTabs() {
  $("panel-tabs").replaceChildren(...TABS.map(t => el("a", {
    href: "#", class: t === currentTab ? "tab on" : "tab", text: S[`tab${t}`],
    onclick: e => { e.preventDefault(); currentTab = t; renderTabs(); renderPanel(); },
  })));
}

function renderPanel() {
  const body = $("panel-body");
  if (currentTab === "Stickers") body.replaceChildren(...stickerPanel());
  if (currentTab === "Sounds") body.replaceChildren(...soundPanel());
  if (currentTab === "Inserts") body.replaceChildren(...insertPanel());
  if (currentTab === "Text") body.replaceChildren(...textPanel());
}

function stickerPanel() {
  const emojiGrid = el("div", { class: "sticker-grid" }, EMOJI.map(code => el("button", {
    type: "button", title: code,
    onclick: () => addSticker(`https://fonts.gstatic.com/s/e/notoemoji/latest/${code}/512.webp`, `emoji ${code}`),
  }, [el("img", { src: `https://fonts.gstatic.com/s/e/notoemoji/latest/${code}/emoji.svg`, alt: "", loading: "lazy",
                  onerror: e => e.target.closest("button").remove() })])));

  const results = el("div", { class: "sticker-grid" });
  let kind = "stickers";
  const segBtns = [["stickers", S.giphyStickers], ["gifs", S.giphyGifs]].map(([k, label]) =>
    el("button", { type: "button", class: k === kind ? "on" : "", text: label, onclick: e => {
      kind = k; segBtns.forEach(b => b.classList.toggle("on", b === e.target));
    } }));
  const q = el("input", { type: "search", placeholder: S.giphyPlaceholder });
  const giphyBlock = load(GIPHY_KEY)
    ? el("form", { class: "row-form", onsubmit: async e => {
        e.preventDefault();
        const res = await fetch(`https://api.giphy.com/v1/${kind}/search?api_key=${encodeURIComponent(load(GIPHY_KEY))}&q=${encodeURIComponent(q.value)}&limit=24&rating=r`);
        const data = res.ok ? (await res.json()).data : [];
        results.replaceChildren(...data.map(g => el("button", { type: "button", title: g.title,
          onclick: () => addSticker(g.images.original.webp || g.images.original.url, g.title || "GIF") },
          [el("img", { src: g.images.fixed_width_small.url, alt: "", loading: "lazy" })])));
      } }, [el("span", { class: "seg" }, segBtns), q, el("button", { class: "btn small", type: "submit", text: S.search })])
    : giphyKeyForm();

  return [
    el("h4", { text: S.emoji }), emojiGrid,
    el("h4", { text: S.giphy }), giphyBlock, results,
    el("h4", { text: S.uploadImage }),
    fileButton(S.uploadImage, "image/*", f => addSticker(f, f.name)),
  ];
}

function giphyKeyForm() {
  const input = el("input", { type: "password", placeholder: S.giphyKeyPlaceholder });
  return el("div", {}, [
    el("p", { class: "muted small" }, [document.createTextNode(`${S.giphyNeedsKey} `),
      el("a", { href: "https://developers.giphy.com/dashboard/?create=true", target: "_blank", rel: "noopener", text: S.giphyKeyLink })]),
    el("form", { class: "row-form", onsubmit: e => { e.preventDefault(); if (input.value.trim()) { store(GIPHY_KEY, input.value.trim()); renderPanel(); } } },
      [input, el("button", { class: "btn small", type: "submit", text: S.giphyKeySave })]),
  ]);
}

let previewAudio = null;
function soundPanel() {
  const list = el("div", { class: "sound-list" });
  const q = el("input", { type: "search", placeholder: S.soundPlaceholder });
  const form = el("form", { class: "row-form", onsubmit: async e => {
    e.preventDefault();
    const res = await fetch(`https://api.openverse.org/v1/audio/?q=${encodeURIComponent(q.value)}&license=cc0,by&page_size=30`);
    const items = res.ok ? (await res.json()).results.filter(r => !r.duration || r.duration <= 30000) : [];
    if (!items.length) { list.replaceChildren(el("p", { class: "muted", text: S.soundNoResults })); return; }
    list.replaceChildren(...items.map(r => {
      const credit = r.license === "cc0" ? "" : `"${r.title}" — ${r.creator || "?"} (CC BY, ${r.source})`;
      return el("div", { class: "sound" }, [
        el("div", {}, [el("div", { class: "name", text: r.title }),
          el("div", { class: "meta", text: `${r.duration ? (r.duration / 1000).toFixed(1) + ` ${S.seconds} · ` : ""}${r.license === "cc0" ? S.soundLicenseCC0 : S.soundLicenseBY}` })]),
        el("button", { class: "btn ghost small", type: "button", text: `▶ ${S.preview}`, onclick: () => {
          if (previewAudio) previewAudio.pause();
          previewAudio = new Audio(r.url); previewAudio.play();
        } }),
        el("button", { class: "btn small", type: "button", text: S.add, onclick: () => addSound(r.url, r.title, credit) }),
      ]);
    }));
  } }, [q, el("button", { class: "btn small", type: "submit", text: S.search })]);
  return [
    el("h4", { text: S.soundSearch }), form, list,
    el("h4", { text: S.uploadSound }),
    fileButton(S.uploadSound, "audio/*", f => addSound(f, f.name)),
  ];
}

function insertPanel() {
  const dur = el("input", { type: "number", min: "0.2", step: "0.1", value: "1" });
  return [
    el("p", { class: "muted small", text: S.insertHelp }),
    el("div", { class: "row-form" }, [fileButton(S.insertVideo, "video/*", f => addInsert("video", f), "btn")]),
    el("div", { class: "row-form", style: "margin-top:10px" }, [fileButton(S.insertImage, "image/*", f => addInsert("image", f))]),
    el("div", { class: "row-form", style: "margin-top:10px" }, [
      dur, el("span", { class: "muted", text: S.seconds }),
      el("button", { class: "btn ghost", type: "button", text: S.insertBlack, onclick: () => {
        addInsert("black"); state.inserts[state.inserts.length - 1].dur = Math.max(0.2, Number(dur.value) || 1);
        renderLayers(); draw();
      } }),
    ]),
  ];
}

function textPanel() {
  const input = el("textarea", { rows: "2", placeholder: S.textPlaceholder,
    style: "width:100%;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:10px;padding:8px;font:inherit" });
  return [input, el("button", { class: "btn", type: "button", style: "margin-top:8px", text: S.textAdd,
    onclick: () => { addText(input.value); input.value = ""; } })];
}

// ---------- trim + layer list ----------

function numberInput(value, onChange, step = "0.1") {
  return el("input", { type: "number", step, value: String(Math.round(value * 10) / 10),
    onchange: e => { onChange(Number(e.target.value)); renderLayers(); renderTrack(); draw(); } });
}

function renderTrim() {
  const b = state.base;
  $("trim-row").replaceChildren(
    el("label", { class: "muted small" }, [document.createTextNode(`${S.start} `), numberInput(b.in, v => { b.in = Math.max(0, Math.min(v, b.out - 0.5)); })]),
    el("button", { class: "btn ghost small", type: "button", text: S.trimStart, onclick: () => { b.in = Math.min(baseTimeAt(state.t), b.out - 0.5); renderTrim(); seek(0); } }),
    el("label", { class: "muted small" }, [document.createTextNode(`${S.duration.toLowerCase()} → `), numberInput(b.out, v => { b.out = Math.min(b.duration, Math.max(v, b.in + 0.5)); })]),
    el("button", { class: "btn ghost small", type: "button", text: S.trimEnd, onclick: () => { b.out = Math.max(baseTimeAt(state.t), b.in + 0.5); renderTrim(); seek(Math.min(state.t, total())); } }),
    el("label", { class: "muted small" }, [document.createTextNode(`${S.baseVolume} `),
      el("input", { type: "range", min: "0", max: "1.5", step: "0.05", value: String(b.volume),
        oninput: e => { b.volume = Number(e.target.value); b.gain.gain.value = b.volume; } })]),
  );
  renderTrack();
}

function renderTrack() {
  const tot = total() || 1;
  const parts = segments().map(s => el("div", {
    class: s.type === "base" ? "seg-base" : "seg-insert",
    style: `left:${(s.outStart / tot) * 100}%;width:${((s.outEnd - s.outStart) / tot) * 100}%`,
  }));
  const marks = [...state.overlays, ...state.sounds].map(o => el("div", { class: "mark",
    style: `left:${(o.start / tot) * 100}%;width:${(Math.max(0.2, o.dur || o.buffer?.duration || 1) / tot) * 100}%` }));
  const track = $("track");
  track.replaceChildren(...parts, ...marks, el("div", { class: "head" }));
  track.onpointerdown = e => {
    const r = track.getBoundingClientRect();
    seek(((e.clientX - r.left) / r.width) * total());
  };
}

function kindLabel(item) {
  if (item.kind === "sticker") return S.kindSticker;
  if (item.kind === "text") return S.kindText;
  if (item.kind === "sound") return S.kindSound;
  return { video: S.kindInsertVideo, image: S.kindInsertImage, black: S.kindInsertBlack }[item.kind];
}

function renderLayers() {
  const items = [
    ...state.inserts.map(i => ({ item: i, list: state.inserts, isInsert: true })),
    ...state.overlays.map(o => ({ item: o, list: state.overlays })),
    ...state.sounds.map(s => ({ item: s, list: state.sounds })),
  ];
  if (!items.length) { $("layers").replaceChildren(el("p", { class: "muted small", text: S.noLayers })); renderTrack(); return; }
  $("layers").replaceChildren(...items.map(({ item, list, isInsert }) => {
    const ctrls = [];
    if (isInsert) {
      ctrls.push(el("label", {}, [document.createTextNode(S.startInClip), numberInput(item.at, v => { item.at = v; })]));
      if (item.kind !== "video") ctrls.push(el("label", {}, [document.createTextNode(S.duration), numberInput(item.dur, v => { item.dur = Math.max(0.2, v); })]));
      if (item.kind === "video") ctrls.push(el("label", {}, [document.createTextNode(S.volume),
        el("input", { type: "range", min: "0", max: "1.5", step: "0.05", value: String(item.volume),
          oninput: e => { item.volume = Number(e.target.value); item.gain.gain.value = item.volume; } })]));
      ctrls.push(el("button", { class: "btn ghost small", type: "button", text: S.atPlayhead,
        onclick: () => { item.at = baseTimeAt(state.t); renderLayers(); renderTrack(); draw(); } }));
    } else {
      ctrls.push(el("label", {}, [document.createTextNode(S.start), numberInput(item.start, v => { item.start = Math.max(0, v); })]));
      if (item.kind !== "sound") ctrls.push(el("label", {}, [document.createTextNode(S.duration), numberInput(item.dur, v => { item.dur = Math.max(0.2, v); })]));
      if (item.kind === "sticker" || item.kind === "text") ctrls.push(el("label", {}, [document.createTextNode(S.size),
        el("input", { type: "range", min: "0.05", max: "1.2", step: "0.01", value: String(item.w), oninput: e => { item.w = Number(e.target.value); draw(); } })]));
      if (item.kind === "text") ctrls.push(el("input", { type: "color", value: item.color, oninput: e => { item.color = e.target.value; draw(); } }));
      if (item.kind === "sound") ctrls.push(el("label", {}, [document.createTextNode(S.volume),
        el("input", { type: "range", min: "0", max: "1.5", step: "0.05", value: String(item.volume), oninput: e => { item.volume = Number(e.target.value); } })]));
      ctrls.push(el("button", { class: "btn ghost small", type: "button", text: S.atPlayhead,
        onclick: () => { item.start = state.t; renderLayers(); renderTrack(); draw(); } }));
    }
    ctrls.push(el("button", { class: "btn ghost small", type: "button", text: S.remove, onclick: () => {
      list.splice(list.indexOf(item), 1);
      if (state.selected === item.id) state.selected = null;
      renderLayers(); renderTrack(); draw();
    } }));
    const extra = item.credit ? el("div", { class: "muted small", text: fmt(S.soundCredit, { credit: item.credit }) }) : null;
    return el("div", { class: state.selected === item.id ? "layer sel" : "layer",
      onclick: () => { if (item.kind === "sticker" || item.kind === "text") { state.selected = item.id; draw(); renderLayersSelection(); } } }, [
      el("div", {}, [el("div", { class: "kind", text: kindLabel(item) }), el("div", { class: "label", text: item.label || item.name || "" })]),
      el("div", { class: "controls" }, ctrls),
      extra,
    ]);
  }));
  renderTrack();
}
function renderLayersSelection() { renderLayers(); }

// ---------- boot ----------

async function main() {
  S = await (await fetch("editor.tr.json")).json();
  document.title = S.pageTitle;
  document.querySelectorAll("[data-s]").forEach(n => { n.textContent = S[n.dataset.s] ?? ""; });
  $("back-link").textContent = `← ${S.back}`;
  $("export-btn").textContent = `↓ ${S.export}`;
  $("play-btn").textContent = `▶ ${S.play}`;

  const params = new URLSearchParams(location.hash.slice(1));
  const name = params.get("name"), url = params.get("url");
  if (name) {
    $("open-hint").textContent = fmt(S.openHintNamed, { name });
    if (url) $("open-download").replaceChildren(el("a", { href: url, text: `↓ ${S.downloadFirst}` }));
  } else {
    $("open-hint").textContent = S.openHint;
  }

  $("base-file").addEventListener("change", e => e.target.files[0] && openBase(e.target.files[0]));
  const drop = $("drop");
  drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("over"); const f = e.dataTransfer.files[0]; if (f) openBase(f); });

  $("play-btn").addEventListener("click", () => (state.playing ? pause() : play()));
  $("export-btn").addEventListener("click", exportVideo);
  const scrub = $("scrub");
  scrub.addEventListener("pointerdown", () => { scrubbing = true; });
  scrub.addEventListener("input", () => seek((scrub.value / 1000) * total()));
  scrub.addEventListener("pointerup", () => { scrubbing = false; });
  document.addEventListener("keydown", e => {
    if (e.target.matches("input, textarea")) return;
    if (e.code === "Space") { e.preventDefault(); state.playing ? pause() : play(); }
    if ((e.key === "Delete" || e.key === "Backspace") && state.selected) {
      state.overlays = state.overlays.filter(o => o.id !== state.selected); state.selected = null; renderLayers(); draw();
    }
  });

  setupCanvas();
  renderTabs();
  renderPanel();
}
let scrubbing = false;

main();
