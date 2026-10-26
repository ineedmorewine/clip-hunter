// clip-hunter editor: trims a clip, cuts in videos/images/black frames,
// layers stickers/GIFs/text and sound effects, and records the result to MP4
// in real time (canvas + Web Audio + MediaRecorder). Everything stays local.

const W = 1080, H = 1920, FPS = 30;
const GIPHY_KEY = "clip-hunter-giphy-key";
const REPO = "ineedmorewine/clip-hunter";
// Speaker colours for subtitles: first = most frequent voice. Warm/bright, no navy.
const SUB_COLORS = ["#ffffff", "#ffd84d", "#7ee0a1", "#ff8fb1", "#ffa94d", "#c9a7ff"];
const EMOJI = [
  "1f602", "1f923", "1f62d", "1f480", "1f525", "1f631", "1f92f", "1f633", "1f644", "1f60f",
  "1f921", "1f440", "1f4af", "1f44f", "1f389", "1f621", "1f92c", "1f634", "1f976", "1f975",
  "1f608", "1f47b", "1f4a5", "26a1", "1f494", "1f914", "1f62c", "1fae0", "1f643", "1f926",
  "1f64f", "1f44b", "1f90c", "1f60e", "1f973", "1f629", "1f970", "1f92e", "1f910", "1f44d",
];

// Channel stickers: Kick-style "K" mark + channel name, drawn as SVG (no webfonts inside SVG images).
const K_PATH = "M0 0h3v2h1v-1h1v-1h3v2h-1v1h-1v2h1v1h1v2h-3v-1h-1v-1h-1v2h-3z";
const KICK = "#53fc18", GOLD = "#d6a84e";
const FONT = "Arial Black, Arial, Helvetica, sans-serif";
function kMark(x, y, size, fill) {
  return `<g transform="translate(${x} ${y}) scale(${size / 8})"><path d="${K_PATH}" fill="${fill}"/></g>`;
}
function brandSvgs(name, b) {
  const t = (x, y, size, txt, fill = "#fff", anchor = "start", weight = 900) =>
    `<text x="${x}" y="${y}" font-family="${FONT}" font-weight="${weight}" font-size="${size}" fill="${fill}" text-anchor="${anchor}">${txt}</text>`;
  const svg = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
  return [
    // 1: classic – black K tile + green-edged name pill with follow tag
    svg(620, 220, `<rect x="250" y="40" width="350" height="140" rx="34" fill="#000" stroke="${KICK}" stroke-width="8"/>
      <rect x="10" y="10" width="220" height="200" rx="52" fill="#000"/>${kMark(55, 45, 130, KICK)}
      ${t(425, 110, 64, name, "#fff", "middle")}
      <rect x="345" y="128" width="160" height="38" rx="10" fill="#222"/>${t(425, 156, 26, `♥ ${b.follow}`, "#fff", "middle", 700)}`),
    // 2: green pill
    svg(600, 160, `<rect x="5" y="5" width="590" height="150" rx="75" fill="${KICK}"/>
      <circle cx="80" cy="80" r="58" fill="#000"/>${kMark(42, 42, 76, KICK)}${t(165, 102, 66, name, "#000")}`),
    // 3: dark minimal with url
    svg(640, 140, `<rect x="4" y="4" width="632" height="132" rx="22" fill="#0d0d0d" stroke="#2a2a2a" stroke-width="4"/>
      ${kMark(30, 30, 80, KICK)}${t(135, 72, 48, name)}${t(137, 112, 28, `kick.com/${name}`, KICK, "start", 700)}`),
    // 4: follow button
    svg(560, 200, `<rect x="10" y="10" width="540" height="180" rx="30" fill="#000"/>
      ${kMark(40, 45, 110, KICK)}${t(175, 92, 54, name)}
      <rect x="175" y="112" width="250" height="56" rx="14" fill="${KICK}"/>${t(300, 150, 30, `+ ${b.followCaps}`, "#000", "middle")}`),
    // 5: stacked badge
    svg(360, 380, `<rect x="10" y="10" width="340" height="360" rx="44" fill="#000" stroke="${KICK}" stroke-width="8"/>
      ${kMark(110, 40, 140, KICK)}${t(180, 260, 54, name, "#fff", "middle")}${t(180, 322, 30, b.liveOn, KICK, "middle", 700)}`),
    // 6: gold crescent (channel brand colours)
    svg(620, 170, `<rect x="6" y="6" width="608" height="158" rx="30" fill="#121110" stroke="${GOLD}" stroke-width="6"/>
      <path d="M95 30a55 55 0 1 0 40 95a44 44 0 1 1 -40 -95z" fill="${GOLD}"/>
      ${kMark(160, 52, 66, KICK)}${t(245, 106, 58, name, "#f3ead8")}`),
    // 7: speech bubble
    svg(560, 240, `<path d="M30 10h500a20 20 0 0 1 20 20v140a20 20 0 0 1 -20 20h-330l-60 45v-45h-110a20 20 0 0 1 -20 -20v-140a20 20 0 0 1 20 -20z" fill="#fff" stroke="#000" stroke-width="8"/>
      ${kMark(40, 45, 100, "#000")}${t(165, 92, 50, name, "#000")}${t(165, 146, 28, b.bubble, "#1a1a1a", "start", 700)}`),
    // 8: neon outline
    svg(600, 170, `<rect x="10" y="10" width="580" height="150" rx="26" fill="none" stroke="${KICK}" stroke-width="10"/>
      <rect x="10" y="10" width="580" height="150" rx="26" fill="none" stroke="#c8ffb0" stroke-width="3"/>
      ${kMark(40, 40, 90, KICK)}${t(155, 108, 66, name, KICK)}`),
    // 9: small corner tag
    svg(420, 110, `<rect x="4" y="4" width="412" height="102" rx="51" fill="rgba(0,0,0,.75)"/>
      <circle cx="55" cy="55" r="38" fill="${KICK}"/>${kMark(32, 32, 46, "#000")}${t(110, 72, 44, name)}`),
    // 11: TikTok-style double shadow name
    svg(620, 170, `${t(318, 118, 92, name, "#ff2d6f", "middle")}${t(310, 112, 92, name, "#25f4ee", "middle")}
      ${t(314, 115, 92, name, "#fff", "middle")}${kMark(20, 120, 40, KICK)}${t(70, 157, 30, `kick.com/${name}`, KICK, "start", 700)}`),
    // 12: green arrow "buraya" pointer
    svg(600, 200, `<path d="M10 40h420l60-30v180l-60-30h-420z" fill="${KICK}" stroke="#000" stroke-width="8"/>
      ${kMark(36, 66, 70, "#000")}${t(126, 120, 56, name, "#000")}${t(126, 158, 26, b.hereLive, "#000", "start", 700)}`),
    // 13: tilted sticker with white border (cut-out look)
    svg(560, 260, `<g transform="rotate(-7 280 130)"><rect x="40" y="55" width="480" height="150" rx="24" fill="#fff"/>
      <rect x="54" y="69" width="452" height="122" rx="16" fill="${KICK}"/>${kMark(76, 92, 76, "#000")}${t(176, 152, 60, name, "#000")}</g>`),
    // 14: gamer tag frame with corner brackets
    svg(600, 180, `<rect x="20" y="20" width="560" height="140" fill="#0b0b0b"/>
      <path d="M10 60V10h50M540 10h50v50M590 120v50h-50M60 170H10v-50" fill="none" stroke="${KICK}" stroke-width="10"/>
      ${kMark(50, 50, 80, KICK)}${t(155, 103, 54, name)}${t(157, 140, 24, b.gg, "#9aa0a6", "start", 700)}`),
    // 15: gold + green moon night badge
    svg(380, 380, `<circle cx="190" cy="190" r="180" fill="#121110" stroke="${GOLD}" stroke-width="8"/>
      <path d="M150 60a85 85 0 1 0 75 145a68 68 0 1 1 -75 -145z" fill="${GOLD}"/>${kMark(175, 105, 70, KICK)}
      ${t(190, 300, 46, name, "#f3ead8", "middle")}${t(190, 340, 22, b.nightLive, GOLD, "middle", 700)}`),
    // 16: subscribe-like bell row
    svg(640, 150, `<rect x="5" y="5" width="630" height="140" rx="70" fill="#fff"/>
      <circle cx="75" cy="75" r="56" fill="#000"/>${kMark(43, 43, 64, KICK)}${t(150, 92, 50, name, "#000")}
      <rect x="400" y="35" width="210" height="80" rx="40" fill="${KICK}"/>${t(505, 88, 30, b.followCaps, "#000", "middle")}`),
    // 10: "live" red dot
    svg(600, 170, `<rect x="6" y="6" width="588" height="158" rx="22" fill="#000"/>
      ${kMark(32, 42, 86, KICK)}${t(140, 92, 56, name)}
      <circle cx="152" cy="128" r="11" fill="#ff3b3b"/>${t(172, 140, 32, b.live, "#ff8a8a", "start", 700)}`),
  ];
}

let S = {};
const state = {
  base: null,      // { video, name, duration, in, out, volume, audioNode, gain }
  inserts: [],     // { id, kind: video|image|black, at, dur, el, name, volume, gain }
  overlays: [],    // { id, kind: sticker|text, start, dur, x, y, w, frames|text, ... }
  sounds: [],      // { id, name, start, buffer, volume, credit }
  selected: null,
  subs: { on: true, size: 0.075, y: 0.74, colors: [...SUB_COLORS], cues: [], loaded: false },
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
function saveButton(url, name, kind, credit = "") {
  return el("button", { class: "save-btn", type: "button", title: S.saveToLibrary, text: "☆", onclick: async e => {
    const btn = e.currentTarget;
    try {
      const blob = await (await fetch(url)).blob();
      await saveMedia(new File([blob], name, { type: blob.type }), kind, credit);
      btn.textContent = "★"; btn.classList.add("on");
    } catch { alert(S.saveFailed); }
  } });
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
  const ranges = b.ranges;
  // Each insert belongs to the kept range nearest to its base time.
  const owner = at => {
    let best = 0, dist = Infinity;
    ranges.forEach(([a, z], i) => {
      const d = at < a ? a - at : at > z ? at - z : 0;
      if (d < dist) { dist = d; best = i; }
    });
    return best;
  };
  const segs = [];
  let out = 0;
  ranges.forEach(([a, z], ri) => {
    const ins = state.inserts.filter(i => owner(i.at) === ri)
      .map(i => ({ i, at: Math.min(Math.max(i.at, a), z) })).sort((x, y) => x.at - y.at);
    let cursor = a;
    for (const { i, at } of ins) {
      if (at > cursor) { segs.push({ type: "base", ri, from: cursor, to: at, outStart: out }); out += at - cursor; cursor = at; }
      segs.push({ type: "insert", ins: i, outStart: out }); out += i.dur;
    }
    if (z > cursor) segs.push({ type: "base", ri, from: cursor, to: z, outStart: out });
  });
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

// Base-clip time -> output time (first base segment that contains it), or null if trimmed away.
function outTimeOf(bt) {
  const s = segments().find(x => x.type === "base" && bt >= x.from && bt < x.to);
  return s ? s.outStart + (bt - s.from) : null;
}

function wrapLines(c, text, maxW) {
  const lines = [];
  let cur = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const test = cur ? `${cur} ${word}` : word;
    if (cur && c.measureText(test).width > maxW) { lines.push(cur); cur = word; } else cur = test;
  }
  if (cur) lines.push(cur);
  return lines;
}

function drawSubs(c, t) {
  const sb = state.subs;
  if (!sb.on || !sb.cues.length) return;
  const seg = segAt(t);
  if (seg?.type !== "base") return;
  const bt = seg.from + (t - seg.outStart);
  const cue = sb.cues.find(q => bt >= q.s && bt < q.e);
  if (!cue || !cue.t.trim()) return;
  const size = Math.round(sb.size * W);
  c.font = `800 ${size}px "DM Sans", system-ui, sans-serif`;
  c.textAlign = "center"; c.textBaseline = "middle"; c.lineJoin = "round";
  const lines = wrapLines(c, cue.t.toLocaleUpperCase("tr-TR"), W * 0.86);
  lines.forEach((line, i) => {
    const y = sb.y * H + (i - (lines.length - 1) / 2) * size * 1.15;
    c.lineWidth = size * 0.22; c.strokeStyle = "#000"; c.strokeText(line, W / 2, y);
    c.fillStyle = sb.colors[cue.p] || "#ffffff"; c.fillText(line, W / 2, y);
  });
}

// Simple animations for stickers/text: an entrance, a loop, or both.
const EFFECTS = ["none", "pop", "fade", "slideL", "slideR", "drop", "pulse", "shake", "float", "spin", "wiggle"];
function applyEffect(c, o, local) {
  const fx = o.fx || "none";
  if (fx === "none") return;
  const cx = o.x * W, cy = o.y * H;
  const enter = Math.min(1, local / 0.35), ease = 1 - Math.pow(1 - enter, 3);
  const left = o.dur - local, exit = Math.min(1, left / 0.25);
  let sc = 1, dx = 0, dy = 0, rot = 0, alpha = 1;
  if (fx === "pop") { sc = enter < 1 ? 0.2 + 1.0 * ease + Math.sin(enter * Math.PI) * 0.15 : 1; sc *= 0.6 + 0.4 * exit; alpha = exit; }
  if (fx === "fade") alpha = Math.min(enter, exit);
  if (fx === "slideL") { dx = -(1 - ease) * W; alpha = exit; }
  if (fx === "slideR") { dx = (1 - ease) * W; alpha = exit; }
  if (fx === "drop") { const b = enter < 1 ? (1 - ease) : 0; dy = -b * H * 0.4 + Math.abs(Math.sin(local * 9)) * 30 * Math.max(0, 1 - local / 0.9); alpha = exit; }
  if (fx === "pulse") sc = 1 + Math.sin(local * 6) * 0.07;
  if (fx === "shake") { dx = Math.sin(local * 55) * 14; rot = Math.sin(local * 40) * 0.04; }
  if (fx === "float") dy = Math.sin(local * 2.6) * 22;
  if (fx === "spin") rot = local * 2 * Math.PI * 0.6;
  if (fx === "wiggle") rot = Math.sin(local * 7) * 0.12;
  c.globalAlpha = Math.max(0, Math.min(1, alpha));
  c.translate(cx + dx, cy + dy);
  c.rotate(rot);
  c.scale(sc, sc);
  c.translate(-cx, -cy);
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

  drawSubs(c, t);
  for (const o of state.overlays) {
    if (t < o.start || t >= o.start + o.dur) continue;
    c.save();
    applyEffect(c, o, t - o.start);
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
    c.restore();
    if (state.selected === o.id && !state.exporting) {
      c.strokeStyle = "#d6a84e"; c.lineWidth = 6; c.setLineDash([18, 12]);
      c.strokeRect(...o.box); c.setLineDash([]);
    }
  }
  const tot = total();
  $("time").textContent = `${tc(t)} / ${tc(tot)}`;
  if (!scrubbing) $("scrub").value = tot ? Math.round((t / tot) * 1000) : 0;
  const head = $("tl-head");
  if (head) head.style.left = `${LABEL_W + t * pps}px`;
  if (state.playing) followPlayhead();
}

// ---------- playback ----------

let clockStart = 0, tAtStart = 0, rafId = 0, soundNodes = [], onEnded = null;

function scheduleSounds(fromT) {
  stopSounds();
  for (const snd of state.sounds) {
    const offset = fromT - snd.start;
    if (offset >= snd.dur) continue;
    const src = ctx.createBufferSource();
    src.buffer = snd.buffer;
    const g = ctx.createGain(); g.gain.value = snd.volume;
    src.connect(g).connect(master);
    src.start(ctx.currentTime + Math.max(0, -offset), snd.offset + Math.max(0, offset), snd.dur - Math.max(0, offset));
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
  if (blob.type === "image/svg+xml") {
    const img = new Image();
    img.src = URL.createObjectURL(blob);
    await img.decode();
    return [{ bmp: await createImageBitmap(img, { resizeWidth: img.width * 2, resizeHeight: img.height * 2 }), ms: 100 }];
  }
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
    const o = { id: nextId++, kind: "sticker", label, start: state.t, dur: 2.5, x: 0.5, y: 0.3, w: 0.4, frames, fx: "none",
                loopMs: frames.reduce((s, f) => s + f.ms, 0) };
    state.overlays.push(o); state.selected = o.id;
    renderTimeline(); draw();
  } catch {
    alert(S.stickerFailed);
  }
}

function addText(text) {
  if (!text.trim()) return;
  const o = { id: nextId++, kind: "text", label: text, text, start: state.t, dur: 3, x: 0.5, y: 0.18, w: 0.22, color: "#ffffff", fx: "none" };
  state.overlays.push(o); state.selected = o.id;
  renderTimeline(); draw();
}

async function addSound(source, name, credit = "") {
  const buf = source instanceof Blob ? await source.arrayBuffer() : await (await fetch(source)).arrayBuffer();
  const buffer = await ctx.decodeAudioData(buf);
  state.sounds.push({ id: nextId++, kind: "sound", label: name, start: state.t, buffer, offset: 0,
                      dur: buffer.duration, volume: 0.9, credit });
  state.selected = state.sounds[state.sounds.length - 1].id;
  renderTimeline(); draw();
}

function addInsert(kind, file) {
  const at = baseTimeAt(state.t);
  const ins = { id: nextId++, kind, at, dur: 2, name: file?.name || S.kindInsertBlack, volume: 1 };
  if (kind === "video") {
    const v = el("video", { playsinline: "", preload: "auto" });
    v.src = URL.createObjectURL(file);
    v.addEventListener("loadedmetadata", () => { ins.dur = Math.round(v.duration * 10) / 10; renderTimeline(); draw(); }, { once: true });
    ins.el = v; ins.gain = mediaGain(v, 1);
  } else if (kind === "image") {
    const img = new Image(); img.src = URL.createObjectURL(file); img.onload = draw; ins.el = img;
  }
  state.inserts.push(ins); state.selected = ins.id;
  renderTimeline(); draw();
}

// ---------- pick a ready clip from the site (no download) ----------

const MARK = "<!-- clip-hunter:";
async function loadPicker() {
  const box = $("picker");
  let vods = [], media = [];
  try {
    const [rels, idx] = await Promise.all([
      fetch(`https://api.github.com/repos/${REPO}/releases?per_page=50`).then(r => r.json()),
      fetch("media/index.json", { cache: "no-store" }).then(r => (r.ok ? r.json() : { tags: [] })).catch(() => ({ tags: [] })),
    ]);
    media = idx.tags || [];
    vods = rels.map(rel => {
      const body = rel.body || "", at = body.indexOf(MARK);
      if (at < 0) return null;
      try {
        const meta = JSON.parse(body.slice(at + MARK.length, body.indexOf("-->", at)).trim());
        const assets = Object.fromEntries(rel.assets.map(a => [a.name, a.browser_download_url]));
        return { ...meta, tag: rel.tag_name, assets };
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.tag.localeCompare(a.tag));
  } catch {
    box.replaceChildren(el("p", { class: "muted", text: S.pickNone }));
    return;
  }
  const params = new URLSearchParams(location.hash.slice(1));
  if (params.get("tag") && params.get("name") && media.includes(params.get("tag"))) {
    pickClip(params.get("tag"), params.get("name"));
    return;
  }
  const detail = el("div", { class: "pick-clips" });
  const showVod = v => {
    const ready = media.includes(v.tag);
    const files = [...(v.has_montage ? [{ file: "fragman.mp4", label: S.trailer }] : []),
                   ...v.clips.map(c => ({ file: c.file, label: `${c.start_ts} · ${c.why || ""}` }))];
    detail.replaceChildren(
      el("h3", { text: `${v.date} · ${v.title}` }),
      ready ? null : el("p", { class: "muted small", text: S.pickOld }),
      el("div", { class: "pick-grid" }, files.map(f => el("button", {
        type: "button", class: ready ? "pick-clip" : "pick-clip off", title: f.label,
        onclick: () => (ready ? pickClip(v.tag, f.file) : window.open(v.assets[f.file], "_blank")),
      }, [
        el("video", { src: `${ready ? `media/${v.tag}/${f.file}` : v.assets[f.file]}#t=1`, muted: "", preload: "metadata", playsinline: "" }),
        el("span", { text: f.label }),
      ]))),
    );
    detail.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  box.replaceChildren(
    el("h2", { text: S.pickTitle }), el("p", { class: "muted", text: S.pickHelp }),
    el("div", { class: "pick-vods" }, vods.map(v => el("button", {
      type: "button", class: media.includes(v.tag) ? "pick-vod" : "pick-vod off", onclick: () => showVod(v),
    }, [el("b", { text: v.title }), el("span", { text: `${v.date} · ${fmt(S.clipsCount, { n: v.clips.length })}` })]))),
    detail,
    el("p", { class: "muted pick-or", text: S.pickOr }),
  );
}

async function pickClip(tag, name) {
  $("picker").replaceChildren(el("p", { class: "muted", text: S.pickLoading }));
  try {
    const res = await fetch(`media/${tag}/${name}`);
    if (!res.ok) throw new Error(String(res.status));
    const blob = await res.blob();
    history.replaceState(null, "", `#${new URLSearchParams({ name, tag })}`);
    openBase(new File([blob], name, { type: "video/mp4" }));
  } catch {
    $("picker").replaceChildren(el("p", { class: "muted", text: S.pickFailed }));
  }
}

function openBase(file) {
  const v = el("video", { playsinline: "", preload: "auto" });
  v.src = URL.createObjectURL(file);
  v.addEventListener("loadedmetadata", () => {
    state.base = { video: v, name: file.name, duration: v.duration, ranges: [[0, v.duration]], volume: 1 };
    state.base.gain = mediaGain(v, 1);
    $("open-screen").hidden = true; $("editor").hidden = false;
    $("export-btn").removeAttribute("disabled");
    renderTimeline();
    loadSubs();
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
    renderTimeline(); draw();
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
    renderTimeline(); draw();
  }, { passive: false });
}

// ---------- panels ----------

const TABS = ["Subs", "Library", "Stickers", "Sounds", "Inserts", "Text"];
let currentTab = "Subs";

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
  if (currentTab === "Subs") body.replaceChildren(...subsPanel());
  if (currentTab === "Library") libraryPanel().then(nodes => { if (currentTab === "Library") body.replaceChildren(...nodes); });
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
        const res = await fetch(`https://api.giphy.com/v1/${kind}/search?api_key=${encodeURIComponent(load(GIPHY_KEY))}&q=${encodeURIComponent(q.value)}&limit=30&rating=r&lang=tr`);
        const data = res.ok ? (await res.json()).data : [];
        results.replaceChildren(...data.map(g => {
          const src = g.images.original.webp || g.images.original.url;
          return el("div", { class: "tile" }, [
            el("button", { type: "button", title: g.title, onclick: () => addSticker(src, g.title || "GIF") },
              [el("img", { src: g.images.fixed_width_small.url, alt: "", loading: "lazy" })]),
            saveButton(src, g.title || "GIF", "image"),
          ]);
        }));
      } }, [el("span", { class: "seg" }, segBtns), q, el("button", { class: "btn small", type: "submit", text: S.search })])
    : giphyKeyForm();
  const chips = load(GIPHY_KEY) ? el("div", { class: "chips" }, S.giphyChips.map(word =>
    el("button", { type: "button", text: word, onclick: () => { q.value = word; giphyBlock.requestSubmit(); } }))) : null;

  const brand = el("div", { class: "sticker-grid brand-grid" }, brandSvgs(S.brand.name, S.brand).map((svg, i) => {
    const blob = new Blob([svg], { type: "image/svg+xml" });
    return el("button", { type: "button", title: `${S.brandTitle} ${i + 1}`, onclick: () => addSticker(blob, `${S.brandTitle} ${i + 1}`) },
      [el("img", { src: URL.createObjectURL(blob), alt: "" })]);
  }));
  return [
    el("h4", { text: S.brandTitle }), brand,
    el("h4", { text: S.emoji }), emojiGrid,
    el("h4", { text: S.giphy }), giphyBlock, chips, results,
    el("h4", { text: S.uploadImage }),
    fileButton(S.uploadImage, "image/*", f => { saveMedia(f); addSticker(f, f.name); }),
  ].filter(Boolean);
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
        saveButton(r.url, r.title, "audio", credit),
      ]);
    }));
  } }, [q, el("button", { class: "btn small", type: "submit", text: S.search })]);
  return [
    el("h4", { text: S.soundSearch }), form, list,
    el("h4", { text: S.uploadSound }),
    fileButton(S.uploadSound, "audio/*", f => { saveMedia(f); addSound(f, f.name); }),
  ];
}

function insertPanel() {
  const dur = el("input", { type: "number", min: "0.2", step: "0.1", value: "1" });
  return [
    el("p", { class: "muted small", text: S.insertHelp }),
    el("div", { class: "row-form" }, [fileButton(S.insertVideo, "video/*", f => { saveMedia(f); addInsert("video", f); }, "btn")]),
    el("div", { class: "row-form", style: "margin-top:10px" }, [fileButton(S.insertImage, "image/*", f => { saveMedia(f); addInsert("image", f); })]),
    el("div", { class: "row-form", style: "margin-top:10px" }, [
      dur, el("span", { class: "muted", text: S.seconds }),
      el("button", { class: "btn ghost", type: "button", text: S.insertBlack, onclick: () => {
        addInsert("black"); state.inserts[state.inserts.length - 1].dur = Math.max(0.2, Number(dur.value) || 1);
        renderTimeline(); draw();
      } }),
    ]),
  ];
}

async function loadSubs() {
  const params = new URLSearchParams(location.hash.slice(1));
  const tag = params.get("tag"), name = params.get("name");
  if (tag && name) {
    try {
      const res = await fetch(`https://raw.githubusercontent.com/${REPO}/main/subs/${encodeURIComponent(tag)}/${encodeURIComponent(name)}.json`);
      if (res.ok) {
        const data = await res.json();
        state.subs.cues = data.cues.map(q => ({ s: q.s, e: q.e, t: q.t, p: q.p || 0 }));
        while (state.subs.colors.length < (data.speakers || 1)) state.subs.colors.push("#ffffff");
      }
    } catch { /* no subtitles for this clip */ }
  }
  state.subs.loaded = true;
  if (currentTab === "Subs") renderPanel();
  draw();
}

function subsPanel() {
  const sb = state.subs;
  if (!sb.loaded) return [el("p", { class: "muted", text: S.subsLoading })];
  const speakerCount = Math.max(1, ...sb.cues.map(q => q.p + 1));
  const show = el("label", { class: "check" }, [
    el("input", { type: "checkbox", checked: sb.on ? "" : null, onchange: e => { sb.on = e.target.checked; draw(); } }),
    document.createTextNode(` ${S.subsShow}`),
  ]);
  const colors = el("div", { class: "row-form" }, sb.colors.slice(0, Math.max(speakerCount, 1)).map((col, i) =>
    el("label", { class: "muted small swatch" }, [document.createTextNode(fmt(S.subsSpeaker, { n: i + 1 })),
      el("input", { type: "color", value: col, oninput: e => { sb.colors[i] = e.target.value; draw(); renderCueColors(); } })])));
  const style = el("div", { class: "row-form" }, [
    el("label", { class: "muted small" }, [document.createTextNode(`${S.subsSize} `),
      el("input", { type: "range", min: "0.04", max: "0.12", step: "0.005", value: String(sb.size), oninput: e => { sb.size = Number(e.target.value); draw(); } })]),
    el("label", { class: "muted small" }, [document.createTextNode(`${S.subsPosition} `),
      el("input", { type: "range", min: "0.1", max: "0.92", step: "0.01", value: String(sb.y), oninput: e => { sb.y = Number(e.target.value); draw(); } })]),
  ]);
  const list = el("div", { class: "cue-list" });
  const fillList = () => list.replaceChildren(...sb.cues.map(q => {
    const sel = el("select", { class: "cue-sp", onchange: e => { q.p = Number(e.target.value); renderCueColors(); draw(); } },
      sb.colors.map((col, i) => el("option", { value: String(i), selected: q.p === i ? "" : null, text: String(i + 1) })));
    return el("div", { class: "cue" }, [
      el("button", { class: "btn ghost small", type: "button", text: tc(q.s), title: S.subsJump,
        onclick: () => { const ot = outTimeOf(q.s + 0.01); if (ot !== null) seek(ot); } }),
      el("input", { type: "text", value: q.t, oninput: e => { q.t = e.target.value; draw(); } }),
      sel,
      el("button", { class: "btn ghost small", type: "button", text: "✕", title: S.remove,
        onclick: () => { sb.cues.splice(sb.cues.indexOf(q), 1); fillList(); draw(); } }),
    ]);
  }));
  fillList();
  setTimeout(renderCueColors);
  return [
    show,
    el("p", { class: "muted small", text: sb.cues.length ? S.subsHelp : S.subsNone }),
    sb.cues.length ? el("h4", { text: S.subsSpeakers }) : null, sb.cues.length ? colors : null,
    el("h4", { text: S.subsStyle }), style,
    el("h4", { text: S.subsLines }),
    el("button", { class: "btn ghost small", type: "button", text: `+ ${S.subsAdd}`, onclick: () => {
      const s0 = baseTimeAt(state.t);
      sb.cues.push({ s: s0, e: s0 + 1.5, t: "", p: 0 });
      sb.cues.sort((a, b) => a.s - b.s);
      fillList(); draw();
      const idx = sb.cues.findIndex(q => q.s === s0 && q.t === "");
      list.children[idx]?.querySelector("input")?.focus();
    } }),
    list,
  ].filter(Boolean);
}

function renderCueColors() {
  document.querySelectorAll(".cue-sp").forEach(sel => {
    sel.style.background = state.subs.colors[Number(sel.value)] || "#fff";
  });
}

function textPanel() {
  const input = el("textarea", { rows: "2", placeholder: S.textPlaceholder,
    style: "width:100%;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:10px;padding:8px;font:inherit" });
  return [input, el("button", { class: "btn", type: "button", style: "margin-top:8px", text: S.textAdd,
    onclick: () => { addText(input.value); input.value = ""; } })];
}

// ---------- media library (IndexedDB: survives reloads, stays in this browser) ----------

const LIB_DB = "clip-hunter-media", LIB_STORE = "media";
let libDb = null;
function openLib() {
  if (libDb) return Promise.resolve(libDb);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(LIB_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(LIB_STORE, { keyPath: "id" });
    req.onsuccess = () => { libDb = req.result; resolve(libDb); };
    req.onerror = () => reject(req.error);
  });
}
function libTx(mode, fn) {
  return openLib().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(LIB_STORE, mode);
    const out = fn(tx.objectStore(LIB_STORE));
    tx.oncomplete = () => resolve(out?.result ?? out);
    tx.onerror = () => reject(tx.error);
  }));
}
function mediaKind(file) {
  if (file.type.startsWith("audio")) return "audio";
  if (file.type.startsWith("video")) return "video";
  return "image";
}
async function saveMedia(file, kind = mediaKind(file), credit = "") {
  try {
    navigator.storage?.persist?.();
    await libTx("readwrite", st => st.put({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: file.name, kind, credit, blob: file, added: Date.now() }));
    if (currentTab === "Library") renderPanel();
  } catch { /* private mode or storage blocked: the item is still usable this session */ }
}
async function allMedia() {
  try { return (await libTx("readonly", st => st.getAll())).sort((a, b) => b.added - a.added); } catch { return []; }
}

function useMedia(m) {
  const file = new File([m.blob], m.name, { type: m.blob.type });
  if (m.kind === "audio") addSound(file, m.name, m.credit);
  else if (m.kind === "video") addInsert("video", file);
  else addSticker(file, m.name);
}

async function libraryPanel() {
  const items = await allMedia();
  const upload = el("label", { class: "btn file-btn" }, [el("span", { text: `+ ${S.libraryUpload}` }),
    el("input", { type: "file", multiple: "", accept: "image/*,audio/*,video/*", onchange: async e => {
      for (const f of e.target.files) await saveMedia(f);
      e.target.value = ""; renderPanel();
    } })]);
  const groups = [["image", S.libraryImages], ["audio", S.librarySounds], ["video", S.libraryVideos]];
  const nodes = [el("p", { class: "muted small", text: S.libraryHelp }), upload];
  if (!items.length) nodes.push(el("p", { class: "muted", text: S.libraryEmpty }));
  for (const [kind, title] of groups) {
    const list = items.filter(m => m.kind === kind);
    if (!list.length) continue;
    nodes.push(el("h4", { text: `${title} (${list.length})` }));
    nodes.push(el("div", { class: "lib-grid" }, list.map(m => {
      const url = URL.createObjectURL(m.blob);
      const thumb = kind === "image" ? el("img", { src: url, alt: "" })
        : kind === "video" ? el("video", { src: `${url}#t=0.5`, muted: "", preload: "metadata" })
        : el("div", { class: "lib-audio", text: "♪" });
      return el("div", { class: "lib-item" }, [
        el("button", { type: "button", class: "lib-thumb", title: S.libraryUse, onclick: () => useMedia(m) }, [thumb]),
        el("div", { class: "lib-name", text: m.name }),
        el("div", { class: "lib-actions" }, [
          kind === "audio" ? el("button", { type: "button", class: "btn ghost small", text: "▶", onclick: () => {
            if (previewAudio) previewAudio.pause(); previewAudio = new Audio(url); previewAudio.play();
          } }) : null,
          el("button", { type: "button", class: "btn small", text: S.add, onclick: () => useMedia(m) }),
          el("button", { type: "button", class: "btn ghost small", text: "🗑", title: S.remove, onclick: async () => {
            if (!confirm(fmt(S.libraryDeleteConfirm, { name: m.name }))) return;
            await libTx("readwrite", st => st.delete(m.id)); renderPanel();
          } }),
        ]),
      ]);
    })));
  }
  return nodes;
}

// ---------- timeline (CapCut-style: blocks you drag, trim by the edges, split, delete) ----------

const LABEL_W = 92;      // left column with track names
let pps = 60;            // pixels per second (zoom)
let fitted = false;

function itemById(id) {
  if (typeof id === "string" && id.startsWith("base:")) return { kind: "base", ri: Number(id.slice(5)) };
  return state.overlays.find(o => o.id === id) || state.sounds.find(o => o.id === id) || state.inserts.find(o => o.id === id);
}
function listOf(item) {
  return [state.overlays, state.sounds, state.inserts].find(l => l.includes(item));
}
function itemSpan(item) {
  if (item.kind === "sound") return [item.start, item.start + item.dur];
  return [item.start, item.start + item.dur];
}
// Pack blocks into as few rows as possible (a block goes on the first row where it fits).
function packLanes(items) {
  const lanes = [];
  for (const it of [...items].sort((a, b) => a.start - b.start)) {
    const lane = lanes.find(l => l.end <= it.start + 0.01);
    if (lane) { lane.items.push(it); lane.end = it.start + it.dur; }
    else lanes.push({ items: [it], end: it.start + it.dur });
  }
  return lanes;
}

function renderTimeline() {
  if (!state.base) return;
  const tot = total();
  const scroll = $("tl-scroll");
  if (!fitted && scroll.clientWidth) { pps = Math.max(20, (scroll.clientWidth - LABEL_W - 40) / Math.max(1, tot)); fitted = true; }
  const width = LABEL_W + tot * pps + 120;

  const ruler = el("div", { class: "tl-ruler", style: `width:${width}px` });
  const step = pps > 120 ? 1 : pps > 40 ? 2 : pps > 15 ? 5 : 10;
  for (let t = 0; t <= tot + step; t += step) {
    ruler.append(el("span", { style: `left:${LABEL_W + t * pps}px`, text: tc(t).replace(/\.\d$/, "") }));
  }

  const rows = [];
  const row = (label, cls, blocks) => rows.push(el("div", { class: `tl-row ${cls}`, style: `width:${width}px` },
    [el("div", { class: "tl-label", text: label }), ...blocks]));

  const block = (item, id, start, dur, cls, label, handles = ["l", "r"]) => {
    const b = el("div", {
      class: `tl-block ${cls}${state.selected === id ? " sel" : ""}`,
      style: `left:${LABEL_W + start * pps}px;width:${Math.max(6, dur * pps)}px`,
      title: label,
    }, [
      handles.includes("l") ? el("i", { class: "h l" }) : null,
      el("span", { text: label }),
      handles.includes("r") ? el("i", { class: "h r" }) : null,
    ]);
    b.addEventListener("pointerdown", e => startDrag(e, id, e.target.classList.contains("l") ? "l" : e.target.classList.contains("r") ? "r" : "move"));
    return b;
  };

  const texts = state.overlays.filter(o => o.kind === "text");
  const stickers = state.overlays.filter(o => o.kind === "sticker");
  packLanes(texts).reverse().forEach((lane, i) =>
    row(i ? "" : `T  ${S.kindText}`, "r-text", lane.items.map(o => block(o, o.id, o.start, o.dur, "b-text", o.text))));
  packLanes(stickers).reverse().forEach((lane, i) =>
    row(i ? "" : `★  ${S.kindSticker}`, "r-sticker", lane.items.map(o => block(o, o.id, o.start, o.dur, "b-sticker", o.label))));

  row(`▶  ${S.trackMain}`, "r-main", segments().map(sg => sg.type === "base"
    ? block(null, `base:${sg.ri}`, sg.outStart, sg.outEnd - sg.outStart, "b-base",
        `${state.base.name} · ${tc(sg.from)}–${tc(sg.to)}`,
        [sg.from === state.base.ranges[sg.ri][0] ? "l" : "", sg.to === state.base.ranges[sg.ri][1] ? "r" : ""])
    : block(sg.ins, sg.ins.id, sg.outStart, sg.ins.dur, "b-insert",
        sg.ins.kind === "black" ? S.kindInsertBlack : sg.ins.name, ["r"])));

  if (state.subs.on && state.subs.cues.length) {
    const cues = state.subs.cues.map(q => [q, outTimeOf(q.s + 0.01)]).filter(([, ot]) => ot !== null);
    row(`Aa  ${S.tabSubs}`, "r-subs", cues.map(([q, ot]) => {
      const b = el("div", { class: "tl-cue", style: `left:${LABEL_W + ot * pps}px;width:${Math.max(4, (q.e - q.s) * pps - 2)}px;` +
        `border-color:${state.subs.colors[q.p] || "#fff"}`, title: q.t, text: q.t });
      b.addEventListener("pointerdown", e => { e.stopPropagation(); seek(ot); currentTab = "Subs"; renderTabs(); renderPanel(); });
      return b;
    }));
  }

  packLanes(state.sounds).forEach((lane, i) =>
    row(i ? "" : `♪  ${S.kindSound}`, "r-sound", lane.items.map(o => block(o, o.id, o.start, o.dur, "b-sound", o.label))));

  const inner = $("tl-inner");
  inner.replaceChildren(ruler, ...rows, el("div", { id: "tl-head", class: "tl-head", style: `left:${LABEL_W + state.t * pps}px` }));
  inner.style.width = `${width}px`;
  inner.onpointerdown = e => {
    if (e.target.closest(".tl-block, .tl-cue")) return;
    const r = inner.getBoundingClientRect();
    const toTime = x => Math.max(0, (x - r.left - LABEL_W) / pps);
    state.selected = null;
    seek(toTime(e.clientX));
    renderTimeline(); renderInspector();
    const move = ev => seek(toTime(ev.clientX));
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", () => window.removeEventListener("pointermove", move), { once: true });
  };
  renderInspector();
}

function followPlayhead() {
  const sc = $("tl-scroll");
  const x = LABEL_W + state.t * pps;
  if (x > sc.scrollLeft + sc.clientWidth - 60 || x < sc.scrollLeft + LABEL_W) sc.scrollLeft = x - LABEL_W - 40;
}

function startDrag(e, id, mode) {
  e.stopPropagation();
  e.preventDefault();
  if (state.playing) pause();
  state.selected = id;
  const item = itemById(id);
  if (!item) return;
  const x0 = e.clientX;
  const snap = item.kind === "base" ? [...state.base.ranges[item.ri]]
    : { start: item.start, dur: item.dur, at: item.at, offset: item.offset };
  const r = state.base.ranges;
  const move = ev => {
    const d = (ev.clientX - x0) / pps;
    if (item.kind === "base") {
      const prevEnd = item.ri > 0 ? r[item.ri - 1][1] : 0;
      const nextStart = item.ri < r.length - 1 ? r[item.ri + 1][0] : state.base.duration;
      if (mode === "l") r[item.ri][0] = Math.min(Math.max(prevEnd, snap[0] + d), r[item.ri][1] - 0.3);
      if (mode === "r") r[item.ri][1] = Math.max(Math.min(nextStart, snap[1] + d), r[item.ri][0] + 0.3);
    } else if (item.kind === "video" || item.kind === "image" || item.kind === "black") {
      if (mode === "move") item.at = Math.min(Math.max(0, snap.at + d), state.base.duration);
      if (mode === "r") item.dur = Math.max(0.2, Math.min(snap.dur + d, item.kind === "video" ? (item.el.duration || 999) : 999));
    } else if (item.kind === "sound") {
      if (mode === "move") item.start = Math.max(0, snap.start + d);
      if (mode === "l") {
        const dd = Math.min(Math.max(-snap.offset, d), snap.dur - 0.2);
        item.offset = snap.offset + dd; item.start = Math.max(0, snap.start + dd); item.dur = snap.dur - dd;
      }
      if (mode === "r") item.dur = Math.max(0.2, Math.min(snap.dur + d, item.buffer.duration - item.offset));
    } else {
      if (mode === "move") item.start = Math.max(0, snap.start + d);
      if (mode === "l") { const dd = Math.min(d, snap.dur - 0.2); item.start = Math.max(0, snap.start + dd); item.dur = snap.dur - dd; }
      if (mode === "r") item.dur = Math.max(0.2, snap.dur + d);
    }
    renderTimeline(); draw();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", () => {
    window.removeEventListener("pointermove", move);
    if (state.t > total()) seek(total());
  }, { once: true });
  renderTimeline(); draw();
}

function splitSelected() {
  const id = state.selected;
  const item = itemById(id);
  const t = state.t;
  if (!item) return;
  if (item.kind === "base") {
    const bt = baseTimeAt(t), rr = state.base.ranges[item.ri];
    if (bt - rr[0] < 0.2 || rr[1] - bt < 0.2) return;
    state.base.ranges.splice(item.ri, 1, [rr[0], bt], [bt, rr[1]]);
    state.selected = `base:${item.ri + 1}`;
  } else if (item.start !== undefined && t > item.start + 0.1 && t < item.start + item.dur - 0.1) {
    const cut = t - item.start;
    const copy = { ...item, id: nextId++, start: t, dur: item.dur - cut };
    if (item.kind === "sound") copy.offset = item.offset + cut;
    item.dur = cut;
    listOf(item).push(copy);
    state.selected = copy.id;
  } else return;
  renderTimeline(); draw();
}

function duplicateSelected() {
  const item = itemById(state.selected);
  if (!item || item.kind === "base" || item.start === undefined) return;
  const copy = { ...item, id: nextId++, start: item.start + item.dur };
  listOf(item).push(copy);
  state.selected = copy.id;
  renderTimeline(); draw();
}

function deleteSelected() {
  const item = itemById(state.selected);
  if (!item) return;
  if (item.kind === "base") {
    if (state.base.ranges.length < 2) return; // keep at least one piece of the clip
    state.base.ranges.splice(item.ri, 1);
  } else {
    const list = listOf(item);
    list.splice(list.indexOf(item), 1);
  }
  state.selected = null;
  seek(Math.min(state.t, total()));
  renderTimeline();
}

function renderToolbar() {
  const btn = (icon, label, fn, title) => el("button", { type: "button", class: "tool", title: title || label, onclick: fn },
    [el("b", { text: icon }), el("span", { text: label })]);
  $("tl-toolbar").replaceChildren(
    btn("✂", S.toolSplit, splitSelected, S.toolSplitHint),
    btn("⧉", S.toolDuplicate, duplicateSelected),
    btn("🗑", S.toolDelete, deleteSelected),
    el("span", { class: "tool-gap" }),
    btn("−", "", () => { pps = Math.max(8, pps / 1.4); renderTimeline(); }, S.zoomOut),
    btn("+", "", () => { pps = Math.min(400, pps * 1.4); renderTimeline(); }, S.zoomIn),
  );
}

function slider(label, value, min, max, step, onInput) {
  return el("label", { class: "insp-field" }, [el("span", { text: label }),
    el("input", { type: "range", min, max, step, value: String(value), oninput: e => onInput(Number(e.target.value)) })]);
}

function effectSelect(item) {
  return el("label", { class: "insp-field" }, [el("span", { text: S.effect }),
    el("select", { class: "fx-select", onchange: e => { item.fx = e.target.value; seek(item.start); if (!state.playing) play(); } },
      EFFECTS.map(fx => el("option", { value: fx, selected: (item.fx || "none") === fx ? "" : null, text: S.effects[fx] })))]);
}

function renderInspector() {
  const box = $("tl-inspector");
  const item = itemById(state.selected);
  if (!item) { box.replaceChildren(el("p", { class: "muted small", text: S.inspectorEmpty })); return; }
  const fields = [];
  let title = "";
  if (item.kind === "base") {
    title = S.trackMain;
    fields.push(slider(S.volume, state.base.volume, 0, 1.5, 0.05, v => { state.base.volume = v; state.base.gain.gain.value = v; }));
    fields.push(el("p", { class: "muted small", text: S.inspectorBase }));
  } else if (item.kind === "sticker") {
    title = S.kindSticker;
    fields.push(slider(S.size, item.w, 0.05, 1.2, 0.01, v => { item.w = v; draw(); }));
    fields.push(effectSelect(item));
  } else if (item.kind === "text") {
    title = S.kindText;
    fields.push(el("label", { class: "insp-field wide" }, [el("span", { text: S.kindText }),
      el("input", { type: "text", value: item.text, oninput: e => { item.text = item.label = e.target.value; draw(); } })]));
    fields.push(slider(S.size, item.w, 0.08, 0.5, 0.01, v => { item.w = v; draw(); }));
    fields.push(el("label", { class: "insp-field" }, [el("span", { text: S.color }),
      el("input", { type: "color", value: item.color, oninput: e => { item.color = e.target.value; draw(); } })]));
    fields.push(effectSelect(item));
  } else if (item.kind === "sound") {
    title = `${S.kindSound} · ${item.label}`;
    fields.push(slider(S.volume, item.volume, 0, 1.5, 0.05, v => { item.volume = v; }));
    if (item.credit) fields.push(el("p", { class: "muted small", text: fmt(S.soundCredit, { credit: item.credit }) }));
  } else {
    title = { video: S.kindInsertVideo, image: S.kindInsertImage, black: S.kindInsertBlack }[item.kind];
    if (item.kind === "video") fields.push(slider(S.volume, item.volume, 0, 1.5, 0.05, v => { item.volume = v; item.gain.gain.value = v; }));
  }
  if (item.kind !== "base") fields.push(el("p", { class: "muted small", text: S.inspectorDrag }));
  box.replaceChildren(el("b", { class: "insp-title", text: title }), ...fields);
}


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
    if ((e.key === "Delete" || e.key === "Backspace") && state.selected) { e.preventDefault(); deleteSelected(); }
    if (e.key === "s" || e.key === "S") splitSelected();
  });

  setupCanvas();
  loadPicker();
  renderToolbar();
  renderTabs();
  renderPanel();
}
let scrubbing = false;

main();
