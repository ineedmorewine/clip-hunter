// Gallery for clip-hunter. Data comes from this repo's GitHub Releases:
// each release is one stream, its assets are the videos, and its body carries
// a JSON block written by scripts/publish.py.

const MARK = "<!-- clip-hunter:";
const FALLBACK_REPO = "ineedmorewine/clip-hunter";

function repoFromLocation() {
  const host = location.hostname;
  const seg = location.pathname.split("/").filter(Boolean)[0];
  if (host.endsWith(".github.io") && seg) return `${host.split(".")[0]}/${seg}`;
  return FALLBACK_REPO;
}

function fmt(template, values) {
  return template.replace(/\{(\w+)\}/g, (_, k) => values[k] ?? "");
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") node.textContent = v;
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
}

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

function video(src) {
  // preload=metadata shows the first frame without downloading the whole file.
  return el("video", { src: `${src}#t=0.1`, controls: "", preload: "metadata", playsinline: "" });
}

function clipCard(clip, url, S) {
  const chip = clip.verified
    ? el("span", { class: "chip ai", text: S.pickedByAI })
    : el("span", { class: "chip", text: S.pickedByLaughter });
  return el("article", { class: "card" }, [
    video(url),
    el("div", { class: "info" }, [
      el("div", { class: "row" }, [
        el("span", { class: "ts", text: `${S.atStream} ${clip.start_ts}` }),
        el("span", { text: fmt(S.seconds, { n: clip.seconds }) }),
        el("span", { text: fmt(S.score, { n: clip.score }) }),
        chip,
      ]),
      el("p", { class: "why", text: clip.why }),
      clip.quote ? el("p", { class: "quote", text: `“${clip.quote}”` }) : null,
      el("a", { class: "btn", href: url, download: clip.file, text: `↓ ${S.download}` }),
    ]),
  ]);
}

function vodSection(vod, S, open) {
  const clips = (vod.clips || []).filter(c => vod.assets[c.file]);
  const trailerUrl = vod.has_montage ? vod.assets["fragman.mp4"] : null;
  const meta = [vod.date, fmt(S.clipsCount, { n: clips.length }), trailerUrl ? S.withTrailer : ""]
    .filter(Boolean).join(" · ");

  const body = el("div", { class: "vod-body" });
  if (trailerUrl) {
    const total = (vod.montage || []).reduce((s, m) => s + (m.seconds || 0), 0);
    const list = el("ol", {}, (vod.montage || []).map(m =>
      el("li", {}, [el("b", { text: m.start_ts }), document.createTextNode(` — ${m.why}`)])));
    body.append(
      el("h3", { text: `${S.trailer} · ${fmt(S.trailerParts, { n: (vod.montage || []).length, s: total })}` }),
      el("div", { class: "trailer" }, [
        el("div", {}, [video(trailerUrl),
          el("a", { class: "btn", href: trailerUrl, download: "fragman.mp4", text: `↓ ${S.download}`,
                    style: "margin-top:10px" })]),
        list,
      ]),
    );
  }
  if (clips.length) {
    body.append(el("h3", { text: S.clips }),
      el("div", { class: "grid" }, clips.map(c => clipCard(c, vod.assets[c.file], S))));
  }
  return el("details", { class: "vod", id: vod.tag, open: open || location.hash === `#${vod.tag}` }, [
    el("summary", {}, [el("span", { class: "vod-title", text: vod.title }), el("span", { class: "vod-meta", text: meta })]),
    body,
  ]);
}

// Only one video plays at a time.
document.addEventListener("play", e => {
  document.querySelectorAll("video").forEach(v => { if (v !== e.target) v.pause(); });
}, true);

async function main() {
  const S = await (await fetch("strings.tr.json")).json();
  document.title = S.pageTitle;
  document.querySelectorAll("[data-s]").forEach(n => { n.textContent = S[n.dataset.s] ?? ""; });
  const app = document.getElementById("app");

  let releases;
  try {
    const res = await fetch(`https://api.github.com/repos/${repoFromLocation()}/releases?per_page=100`);
    if (res.status === 403 || res.status === 429) throw new Error("rate");
    if (!res.ok) throw new Error(String(res.status));
    releases = await res.json();
  } catch (err) {
    app.replaceChildren(el("p", { class: "status", text: err.message === "rate" ? S.rateLimit : S.error }));
    return;
  }

  // A re-processed stream can exist twice for a while; keep the newest copy.
  const newest = new Map();
  for (const v of releases.map(parseRelease).filter(Boolean)) {
    const key = `${v.date}|${v.title}`;
    if (!newest.has(key) || v.created > newest.get(key).created) newest.set(key, v);
  }
  const vods = [...newest.values()]
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.created.localeCompare(a.created));
  if (!vods.length) {
    app.replaceChildren(el("p", { class: "status", text: S.empty }));
    return;
  }
  app.replaceChildren(...vods.map((v, i) => vodSection(v, S, i === 0)));
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
}

main();
