// Gallery for clip-hunter. Data comes from this repo's GitHub Releases:
// each release is one stream, its assets are the videos, and its body carries
// a JSON block written by scripts/publish.py.
//
// Views (hash routing): ""            -> list of streams
//                       "#<tag>"      -> one stream, trailer tab
//                       "#<tag>/clips"-> one stream, clips tab

const MARK = "<!-- clip-hunter:";
const FALLBACK_REPO = "ineedmorewine/clip-hunter";
const WORKFLOW = "clip-hunter.yml";
const TOKEN_KEY = "clip-hunter-token";
const API = "https://api.github.com";

let S = {};
let vods = [];

// ---------- helpers ----------

function repo() {
  const host = location.hostname;
  const seg = location.pathname.split("/").filter(Boolean)[0];
  if (host.endsWith(".github.io") && seg) return `${host.split(".")[0]}/${seg}`;
  return FALLBACK_REPO;
}

function fmt(template, values) {
  return (template || "").replace(/\{(\w+)\}/g, (_, k) => values[k] ?? "");
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
}

function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}

function setToken(value) {
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* storage unavailable: token just isn't remembered */ }
}

async function gh(path, options = {}) {
  const headers = { Accept: "application/vnd.github+json", ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${API}${path}`, { ...options, headers });
}

function timeAgo(iso) {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return S.justNow;
  if (min < 60) return fmt(S.minutesAgo, { n: min });
  const h = Math.round(min / 60);
  if (h < 24) return fmt(S.hoursAgo, { n: h });
  return fmt(S.daysAgo, { n: Math.round(h / 24) });
}

// ---------- data ----------

function parseRelease(rel) {
  const body = rel.body || "";
  const at = body.indexOf(MARK);
  if (at < 0) return null;
  const end = body.indexOf("-->", at);
  try {
    const meta = JSON.parse(body.slice(at + MARK.length, end).trim());
    const assets = Object.fromEntries((rel.assets || []).map(a => [a.name, a.browser_download_url]));
    return { ...meta, tag: rel.tag_name, assets, created: rel.created_at };
  } catch {
    return null;
  }
}

async function loadVods() {
  const res = await gh(`/repos/${repo()}/releases?per_page=100`);
  if (res.status === 403 || res.status === 429) throw new Error("rate");
  if (!res.ok) throw new Error(String(res.status));
  vods = (await res.json()).map(parseRelease).filter(Boolean)
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.created.localeCompare(a.created));
}

// ---------- refresh (runs the GitHub workflow) ----------

async function latestRun() {
  const res = await gh(`/repos/${repo()}/actions/workflows/${WORKFLOW}/runs?per_page=1`);
  if (!res.ok) return null;
  return (await res.json()).workflow_runs?.[0] || null;
}

function renderRefreshStatus(run) {
  const box = document.getElementById("refresh-status");
  if (!box || !run) return;
  if (run.status !== "completed") {
    box.textContent = fmt(S.refreshRunning, { t: timeAgo(run.run_started_at || run.created_at) });
    box.className = "refresh-status busy";
  } else {
    box.textContent = fmt(S.lastCheck, { t: timeAgo(run.updated_at) });
    box.className = "refresh-status";
  }
}

let pollTimer = null;
function watchRun() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const run = await latestRun();
    renderRefreshStatus(run);
    if (run && run.status === "completed") {
      clearInterval(pollTimer);
      document.getElementById("refresh-btn")?.removeAttribute("disabled");
      await loadVods().catch(() => {});
      route();
    }
  }, getToken() ? 30000 : 90000);  // unauthenticated API calls are limited to 60/hour
}

async function startRefresh() {
  if (!getToken()) { showTokenPanel(); return; }
  const btn = document.getElementById("refresh-btn");
  btn.setAttribute("disabled", "");
  const current = await latestRun();
  if (current && current.status !== "completed") {
    renderRefreshStatus(current);
    watchRun();
    return;
  }
  const res = await gh(`/repos/${repo()}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "main", inputs: { vod_url: "" } }),
  });
  const box = document.getElementById("refresh-status");
  if (res.status === 204) {
    box.textContent = S.refreshStarted;
    box.className = "refresh-status busy";
    setTimeout(async () => renderRefreshStatus(await latestRun()), 8000);
    watchRun();
  } else {
    btn.removeAttribute("disabled");
    box.className = "refresh-status error";
    box.textContent = res.status === 401 || res.status === 403 || res.status === 404 ? S.tokenRejected : S.refreshFailed;
    if (res.status === 401) setToken("");
  }
}

function showTokenPanel() {
  const panel = document.getElementById("token-panel");
  panel.hidden = false;
  panel.querySelector("input")?.focus();
}

function tokenPanel() {
  const input = el("input", { type: "password", placeholder: S.tokenPlaceholder, autocomplete: "off",
                              "aria-label": S.tokenPlaceholder });
  const link = `https://github.com/settings/personal-access-tokens/new?name=clip-hunter-site&description=${encodeURIComponent(S.tokenDescription)}&target_name=${repo().split("/")[0]}&expires_in=none&actions=write`;
  return el("div", { id: "token-panel", class: "token-panel", hidden: "" }, [
    el("h2", { text: S.tokenTitle }),
    el("ol", {}, [
      el("li", {}, [el("a", { href: link, target: "_blank", rel: "noopener", text: S.tokenStep1 })]),
      el("li", { text: S.tokenStep2 }),
      el("li", { text: S.tokenStep3 }),
      el("li", { text: S.tokenStep4 }),
    ]),
    el("p", { class: "muted", text: S.tokenNote }),
    el("form", { class: "token-form", onsubmit: e => {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) return;
      setToken(v);
      document.getElementById("token-panel").hidden = true;
      startRefresh();
    } }, [input, el("button", { class: "btn", type: "submit", text: S.tokenSave })]),
  ]);
}

// ---------- views ----------

function video(src, extra = {}) {
  // preload=metadata shows the first frame without downloading the whole file.
  return el("video", { src: `${src}#t=0.1`, controls: "", preload: "metadata", playsinline: "", ...extra });
}

function clipCard(clip, url, tag) {
  const chip = clip.verified
    ? el("span", { class: "chip ai", text: S.pickedByAI })
    : el("span", { class: "chip", text: S.pickedByLaughter });
  return el("article", { class: "card" }, [
    video(url),
    el("div", { class: "info" }, [
      el("div", { class: "row" }, [
        clip.kind === "oyun" ? el("span", { class: "chip play", text: S.kindPlay }) : null,
        el("span", { class: "ts", text: `${S.atStream} ${clip.start_ts}` }),
        el("span", { text: fmt(S.seconds, { n: clip.seconds }) }),
        el("span", { text: fmt(S.score, { n: clip.score }) }),
        chip,
      ]),
      el("p", { class: "why", text: clip.why }),
      clip.quote ? el("p", { class: "quote", text: `“${clip.quote}”` }) : null,
      el("div", { class: "btn-row" }, [
        el("a", { class: "btn", href: url, download: clip.file, text: `↓ ${S.download}` }),
        el("a", { class: "btn ghost", href: `editor.html#${new URLSearchParams({ name: clip.file, url, tag })}`, text: `✎ ${S.edit}` }),
      ]),
    ]),
  ]);
}

function streamCard(vod) {
  const clips = (vod.clips || []).filter(c => vod.assets[c.file]);
  const preview = vod.assets["fragman.mp4"] || (clips[0] && vod.assets[clips[0].file]);
  return el("a", { class: "stream", href: `#${vod.tag}` }, [
    preview ? el("video", { src: `${preview}#t=1`, preload: "metadata", muted: "", playsinline: "",
                            tabindex: "-1", "aria-hidden": "true" }) : el("div", { class: "noprev" }),
    el("div", { class: "stream-info" }, [
      el("span", { class: "stream-date", text: vod.date }),
      el("span", { class: "stream-title", text: vod.title }),
      el("span", { class: "muted", text: [fmt(S.clipsCount, { n: clips.length }),
                                           vod.assets["fragman.mp4"] ? S.withTrailer : ""].filter(Boolean).join(" ") }),
    ]),
  ]);
}

function listView() {
  if (!vods.length) return [el("p", { class: "status", text: S.empty })];
  return [el("div", { class: "streams" }, vods.map(streamCard))];
}

function detailView(vod, tab) {
  const clips = (vod.clips || []).filter(c => vod.assets[c.file]);
  const trailerUrl = vod.assets["fragman.mp4"];
  if (!trailerUrl) tab = "clips";

  const tabs = el("div", { class: "tabs", role: "tablist" }, [
    trailerUrl ? el("a", { href: `#${vod.tag}`, role: "tab", "aria-selected": String(tab !== "clips"),
                           class: tab !== "clips" ? "tab on" : "tab", text: S.trailer }) : null,
    el("a", { href: `#${vod.tag}/clips`, role: "tab", "aria-selected": String(tab === "clips"),
              class: tab === "clips" ? "tab on" : "tab", text: `${S.clips} (${clips.length})` }),
  ]);

  let body;
  if (tab === "clips") {
    body = el("div", { class: "grid" }, clips.map(c => clipCard(c, vod.assets[c.file], vod.tag)));
  } else {
    const total = (vod.montage || []).reduce((s, m) => s + (m.seconds || 0), 0);
    body = el("div", { class: "trailer" }, [
      el("div", {}, [video(trailerUrl),
        el("div", { class: "btn-row", style: "margin-top:12px" }, [
          el("a", { class: "btn", href: trailerUrl, download: "fragman.mp4", text: `↓ ${S.download}` }),
          el("a", { class: "btn ghost", href: `editor.html#${new URLSearchParams({ name: "fragman.mp4", url: trailerUrl, tag: vod.tag })}`,
                    text: `✎ ${S.edit}` }),
        ])]),
      el("div", {}, [
        el("h3", { text: fmt(S.trailerParts, { n: (vod.montage || []).length, s: total }) }),
        el("ol", {}, (vod.montage || []).map(m =>
          el("li", {}, [el("b", { text: m.start_ts }), document.createTextNode(` — ${m.why}`)]))),
      ]),
    ]);
  }

  return [
    el("a", { class: "back", href: "#", text: `← ${S.allStreams}` }),
    el("div", { class: "detail-head" }, [
      el("span", { class: "stream-date", text: vod.date }),
      el("h2", { class: "detail-title", text: vod.title }),
    ]),
    tabs,
    body,
  ];
}

function route() {
  const app = document.getElementById("app");
  const [tag, tab] = decodeURIComponent(location.hash.slice(1)).split("/");
  const vod = tag && vods.find(v => v.tag === tag);
  document.querySelectorAll("video").forEach(v => v.pause());
  app.replaceChildren(...(vod ? detailView(vod, tab) : listView()));
  window.scrollTo(0, 0);
}

// Only one video plays at a time.
document.addEventListener("play", e => {
  document.querySelectorAll("video").forEach(v => { if (v !== e.target) v.pause(); });
}, true);

async function main() {
  S = await (await fetch("strings.tr.json")).json();
  document.title = S.pageTitle;
  document.querySelectorAll("[data-s]").forEach(n => { n.textContent = S[n.dataset.s] ?? ""; });

  const bar = document.getElementById("refresh-bar");
  bar.append(
    el("button", { id: "refresh-btn", class: "btn", type: "button", onclick: startRefresh, text: `↻ ${S.refresh}` }),
    el("span", { id: "refresh-status", class: "refresh-status" }),
  );
  document.getElementById("token-slot").append(tokenPanel());

  try {
    await loadVods();
  } catch (err) {
    document.getElementById("app").replaceChildren(
      el("p", { class: "status", text: err.message === "rate" ? S.rateLimit : S.error }));
    return;
  }
  route();
  window.addEventListener("hashchange", route);

  const run = await latestRun();
  renderRefreshStatus(run);
  if (run && run.status !== "completed") {
    document.getElementById("refresh-btn").setAttribute("disabled", "");
    watchRun();
  }
}

main();
