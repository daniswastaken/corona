// md2pdf.mjs - render a Markdown file (with mermaid blocks) to PDF and/or SVG
// via headless Edge.
//
// Usage:
//   node tools/md2pdf.mjs <in.md> [out.pdf] [flags]
//
// Flags:
//   --paper=A4|A3        sheet size for the diagram pages (default A4)
//   --no-title           omit the document h1, print the graph alone
//   --svg                also write out.svg beside the pdf
//   --strict             exit non-zero if any label overlaps a subgraph title
//   --rank-spacing=N     dagre rank gap (default 50; >=40 avoids title overlaps)
//   --spacing=N          dagre node gap (default 30)
//   --font-size=N        mermaid font px before downscale (default 18)
//
// Requires: Microsoft Edge (headless). Mermaid is vendored to .cache/mermaid.min.js
// on first run, so later runs work offline.
//
// The SVG is written for non-browser consumers too: real <text> instead of
// foreignObject, computed styles baked in as presentation attributes, em-based
// label offsets resolved to user units, explicit width/height, and xmlns.

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, ".cache");
const MERMAID = join(CACHE, "mermaid.min.js");
const MERMAID_URL =
  "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";

const EDGE_CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
];

const escapeHtml = (s) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const inline = (s) =>
  escapeHtml(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|\W)_([^_]+)_(\W|$)/g, "$1<em>$2</em>$3");

// Minimal Markdown subset: ATX headings, fenced code, pipe tables,
// ordered/unordered lists, paragraphs. Enough for engineering notes.
function markdownToHtml(md) {
  const lines = md.split(/\r?\n/);
  const out = [];
  let i = 0;
  const mermaidBlocks = [];

  const flushList = (ordered, items) => {
    const tag = ordered ? "ol" : "ul";
    out.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</${tag}>`);
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced block
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      if (lang.toLowerCase() === "mermaid") {
        mermaidBlocks.push(body.join("\n"));
        const id = mermaidBlocks.length - 1;
        out.push(
          `<section class="diagram-page"><h2 class="diagram-title">Diagram ${id + 1}</h2>` +
            `<div class="diagram" id="d${id}"></div></section>`,
        );
      } else {
        out.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      }
      continue;
    }

    // Heading
    const head = line.match(/^(#{1,6})\s+(.*)$/);
    if (head) {
      out.push(`<h${head[1].length}>${inline(head[2])}</h${head[1].length}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push("<hr />");
      i++;
      continue;
    }

    // Pipe table
    if (/^\s*\|/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      const cells = (row) =>
        row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const headCells = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(
        `<table><thead><tr>${headCells
          .map((c) => `<th>${inline(c)}</th>`)
          .join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`,
      );
      continue;
    }

    // Lists
    const ol = line.match(/^\s*(\d+)\.\s+(.*)$/);
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ol || ul) {
      const ordered = Boolean(ol);
      const items = [];
      const re = ordered ? /^\s*\d+\.\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
      while (i < lines.length) {
        const m = lines[i].match(re);
        if (!m) break;
        items.push(m[1]);
        i++;
      }
      flushList(ordered, items);
      continue;
    }

    // Blank
    if (!line.trim()) {
      i++;
      continue;
    }

    // Paragraph
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*[-*+]\s|\s*\d+\.\s)/.test(lines[i])) {
      para.push(lines[i++]);
    }
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    else i++;
  }

  return {
    html: out.join("\n"),
    mermaidBlocks,
    // A diagram-only document should not waste a portrait page on a lone title:
    // print the whole thing on one landscape sheet instead.
    diagramOnly: !/<(table|ul|ol|pre|p)\b/.test(out.join("\n")),
  };
}

function page(md, mermaidBlocks, opts) {
  const { fontPx, spacing, rankSpacing, titleMargin, paper, usableW, usableH, margin, noTitle, wantSvg } = opts;
  const { html, diagramOnly } = markdownToHtml(md);
  const pageSize = paper === "A3" ? "A3 landscape" : paper === "A4" ? "A4 landscape" : paper;
  const title = (md.match(/^#\s+(.*)$/m) ?? [, "Document"])[1];
  // --no-title: print the graph alone, without the document's h1
  const bodyHtml = noTitle ? html.replace(/^\s*<h1>[\s\S]*?<\/h1>\s*/, "") : html;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  @page { size: ${diagramOnly ? pageSize : "A4"}; margin: ${margin}; }
  * { box-sizing: border-box; }
  body {
    font: 10.5pt/1.5 "Segoe UI", system-ui, sans-serif;
    color: #111; margin: 0; -webkit-print-color-adjust: exact;
  }
  h1 { font-size: 18pt; border-bottom: 2px solid #333; padding-bottom: 4pt; margin: 0 0 10pt; }
  h2 { font-size: 13pt; border-bottom: 1px solid #999; padding-bottom: 2pt; margin: 14pt 0 6pt; }
  h3 { font-size: 11.5pt; margin: 10pt 0 4pt; }
  p { margin: 4pt 0; }
  ul, ol { margin: 4pt 0 4pt 18pt; padding: 0; }
  li { margin: 2pt 0; }
  code { font: 9.5pt Consolas, monospace; background: #f2f2f2; padding: 0 2pt; }
  pre { background: #f7f7f7; border: 1px solid #ddd; padding: 6pt; overflow-x: auto; }
  pre code { background: none; }
  table { border-collapse: collapse; width: 100%; margin: 6pt 0; font-size: 9pt; }
  th, td { border: 1px solid #999; padding: 3pt 5pt; text-align: left; vertical-align: top; }
  th { background: #eee; }
  hr { border: 0; border-top: 1px solid #ccc; margin: 10pt 0; }
  .diagram { text-align: center; }
  /* mermaid emits <svg width="100%" viewBox=...> with no height: let the
     viewBox ratio drive it. Do NOT put the svg in a flex/grid container -
     a percentage width against an indefinite flex base width collapses to 0. */
  .diagram svg {
    display: block;
    width: 100%;
    height: auto;
    max-height: 170mm;
    margin: 0 auto;
  }
  /* Named page: each diagram prints landscape on its own sheet */
  @page diagram { size: ${pageSize}; }
  .diagram-page {
    page: diagram;
    break-before: page;
    break-after: page;
    text-align: center;
  }
  .diagram-only .diagram-page { page: auto; break-before: auto; break-after: auto; }
  /* the document's own h1 already labels a standalone diagram, and the extra
     caption pushes the sheet past one page */
  .diagram-only .diagram-title { display: none; }
  body.diagram-only h1 { margin-bottom: 6pt; }
  .diagram-title { border: 0; margin: 0 0 4pt; font-size: 11pt; color: #444; }
</style>
</head>
<body${diagramOnly ? ' class="diagram-only"' : ""}>
${bodyHtml}
<script src="mermaid.min.js"></script>
<script>
  const FONT_PX = ${fontPx};
  const baseConfig = () => ({
    startOnLoad: false,
    theme: "neutral",
    securityLevel: "strict",
    // NOTE: in Mermaid 11 htmlLabels is a top-level key; flowchart.htmlLabels
    // is deprecated and silently ignored.
    htmlLabels: true,
    flowchart: {
      nodeSpacing: ${spacing},
      rankSpacing: ${rankSpacing},
      titleTopMargin: ${titleMargin},
      padding: 8,
      useMaxWidth: false,
    },
    themeVariables: { fontSize: FONT_PX + "px" },
  });
  const defs = ${JSON.stringify(mermaidBlocks)};

  // Diagram sheets are ${paper} landscape, margins 14mm/12mm. Fit each SVG into
  // what is left after its own headings, rather than trusting a CSS max-height
  // that the print layout will not honour.
  const MM = 96 / 25.4;
  const SHEET_W = ${usableW} * MM;
  const SHEET_H = ${usableH} * MM;
  const SHARED_PAGE = ${diagramOnly};

  function fitToSheet(div) {
    const svg = div.querySelector("svg");
    if (!svg) return null;
    const vb = svg.viewBox && svg.viewBox.baseVal;
    const ratio = vb && vb.height ? vb.width / vb.height : 2;
    const section = div.closest(".diagram-page") || div.parentElement;

    // Height already claimed on this sheet: headings inside the section, plus -
    // when the diagram shares a page with the prose - every other body block.
    let reserved = Math.max(0, section.offsetHeight - div.offsetHeight);
    if (SHARED_PAGE) {
      for (const sib of document.body.children) {
        if (sib === section || sib.tagName === "SCRIPT") continue;
        reserved += sib.offsetHeight + 8;
      }
    }

    const availH = SHEET_H - reserved - 10;
    const scale = Math.min(SHEET_W, availH * ratio) / (vb ? vb.width : SHEET_W);
    const w = (vb ? vb.width : SHEET_W) * scale;
    const h = (vb ? vb.height : SHEET_H) * scale;
    svg.style.maxWidth = "none";
    svg.style.maxHeight = "none";
    svg.style.width = w + "px";
    svg.style.height = h + "px";
    // how many px tall a mermaid fontSize unit actually lands at on the sheet
    const shrink = vb && vb.width ? scale : 1;
    return {
      w: Math.round(w),
      h: Math.round(h),
      nodes: svg.querySelectorAll(".node").length,
      textPx: +(FONT_PX * shrink).toFixed(2),
      collisions: countCollisions(svg),
    };
  }

  // dagre does not reserve room for subgraph titles, so an edge label routed
  // across a cluster boundary can land on top of that cluster's title. Measure
  // it instead of trusting the layout.
  function countCollisions(svg) {
    const box = (el) => el.getBoundingClientRect();
    const hit = (a, b) =>
      a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0 &&
      a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

    const titles = [...svg.querySelectorAll("g.cluster")]
      .map((c) => c.querySelector(".cluster-label"))
      .filter(Boolean)
      .map((l) => ({ el: l, r: box(l), text: (l.textContent || "").trim() }));

    const bad = [];
    const labels = [...svg.querySelectorAll("g.edgeLabel"), ...svg.querySelectorAll(".nodeLabel")].filter(
      (l) => !l.closest("g.cluster"),
    );
    for (const l of labels) {
      const lr = box(l);
      if (!lr.width) continue;
      for (const t of titles) {
        if (hit(lr, t.r)) bad.push(\`"\${(l.textContent || "").trim()}" x "\${t.text}"\`);
      }
    }
    return bad;
  }

  // Mermaid paints the whole diagram from an embedded <style> block, so a
  // consumer without a CSS engine (thumbnailing services, many CAD/plot
  // importers) renders every shape solid black. Bake the resolved values onto
  // the elements as presentation attributes; the stylesheet stays as the
  // higher-priority source where CSS does work, so rendering is unchanged.
  //
  // Only non-default values get written, measured against a bare probe element
  // of the same tag. Two things matter there: an absent fill on an open path
  // falls back to the SVG default of black, so fill:none has to be written
  // explicitly, and a value the element merely *inherits* (visibility:hidden
  // from an ancestor, say) must not be frozen onto it.
  const INLINE_PROPS = [
    "fill", "fill-opacity", "stroke", "stroke-width", "stroke-dasharray",
    "stroke-linecap", "stroke-linejoin", "color", "font-family", "font-size",
    "font-weight", "font-style", "text-anchor", "dominant-baseline",
    "alignment-baseline", "letter-spacing", "stop-color", "stop-opacity",
  ];

  function defaultsFor(tag) {
    if (defaultsFor.cache?.has?.(tag)) return defaultsFor.cache.get(tag);
    if (!defaultsFor.cache) defaultsFor.cache = new Map();
    const probe = document.createElementNS("http://www.w3.org/2000/svg", tag);
    const box = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    box.appendChild(probe);
    document.body.appendChild(box); // no id/class, so mermaid's scoped CSS cannot match
    const cs = getComputedStyle(probe);
    const vals = {};
    for (const prop of INLINE_PROPS) vals[prop] = cs.getPropertyValue(prop);
    box.remove();
    defaultsFor.cache.set(tag, vals);
    return vals;
  }

  // Mermaid positions label rows with em units (y="-0.1em" dy="1.1em"). Browsers
  // resolve those; stricter SVG consumers treat them as zero and stack every
  // line of a label on top of each other. Pin them to user units.
  function resolveEmUnits(root) {
    for (const el of root.querySelectorAll("text, tspan")) {
      const size = parseFloat(getComputedStyle(el).fontSize) || 16;
      for (const attr of ["x", "y", "dx", "dy"]) {
        const val = el.getAttribute(attr);
        if (!val) continue;
        const m = val.match(/^(-?[\\d.]+)em$/);
        if (!m) continue;
        el.setAttribute(attr, String(Math.round(parseFloat(m[1]) * size * 100) / 100));
      }
    }
  }

  function inlineStyles(svgText) {
    const holder = document.createElement("div");
    holder.style.cssText = "position:absolute;left:0;top:0;width:10000px";
    holder.innerHTML = svgText;
    document.body.appendChild(holder);

    const svg = holder.querySelector("svg");
    for (const el of svg.querySelectorAll("*")) {
      if (el.tagName === "style") continue;
      const base = defaultsFor(el.tagName);
      const cs = getComputedStyle(el);
      for (const prop of INLINE_PROPS) {
        const val = cs.getPropertyValue(prop);
        if (!val || val === base[prop]) continue;
        if (el.hasAttribute(prop)) continue; // explicit markup wins
        el.setAttribute(prop, val);
      }
    }
    resolveEmUnits(svg);
    const final = new XMLSerializer().serializeToString(svg);
    holder.remove();
    return final;
  }

  (async () => {
    const report = [];
    mermaid.initialize(baseConfig());
    for (let i = 0; i < defs.length; i++) {
      const { svg } = await mermaid.render("m" + i, defs[i]);
      document.getElementById("d" + i).innerHTML = svg;
    }
    for (let i = 0; i < defs.length; i++) {
      report.push(fitToSheet(document.getElementById("d" + i)));
    }
    document.body.dataset.diagrams = JSON.stringify(report);

    // Standalone SVG wants real <text>, not the HTML labels the PDF uses:
    // foreignObject is invisible to Inkscape, Illustrator and <img> consumers.
    if (${wantSvg}) {
      mermaid.initialize({ ...baseConfig(), htmlLabels: false });
      const out = [];
      for (let i = 0; i < defs.length; i++) {
        const { svg } = await mermaid.render("s" + i, defs[i]);
        out.push(inlineStyles(svg));
      }
      document.body.dataset.svgs = JSON.stringify(out);
    }
    document.title = "READY";
  })().catch((e) => { document.title = "ERROR: " + e.message; console.error(e); });
</script>
</body>
</html>`;
}

function svgPath(pdfPath, index, total) {
  const base = pdfPath.replace(/\.pdf$/i, "");
  return total > 1 ? `${base}-${index + 1}.svg` : `${base}.svg`;
}

// mermaid emits <svg width="100%"> with only a viewBox, which collapses to
// nothing in a non-browser viewer. Give the root explicit pixel dimensions that
// fit the usable box while preserving the viewBox aspect ratio.
function sizeSvg(svg, boxW, boxH) {
  const vb = svg.match(/viewBox="([\d.\s-]+)"/);
  if (!vb) return svg;
  const [, , w, h] = vb[1].trim().split(/\s+/).map(Number);
  if (!w || !h) return svg;
  const scale = Math.min(boxW / w, boxH / h);
  const outW = Math.round(w * scale);
  const outH = Math.round(h * scale);
  return svg
    .replace(/<svg([^>]*)>/, (tag, attrs) => {
      const cleaned = attrs
        .replace(/\s*width="[^"]*"/, "")
        .replace(/\s*height="[^"]*"/, "")
        .replace(/\s*style="[^"]*"/, "");
      // XMLSerializer drops the namespace declaration; every non-browser
      // parser needs it to read the file at all.
      const withNs = /xmlns=/.test(cleaned)
        ? cleaned
        : cleaned.replace(/^(\s*)(\S+)/, '$1$2 xmlns="http://www.w3.org/2000/svg"');
      return `<svg${withNs} width="${outW}" height="${outH}">`;
    })
    .replace("<svg", '<?xml version="1.0" encoding="UTF-8"?>\n<svg');
}

async function ensureMermaid() {
  try {
    await stat(MERMAID);
    return;
  } catch {}
  await mkdir(CACHE, { recursive: true });
  const res = await fetch(MERMAID_URL);
  if (!res.ok) throw new Error(`mermaid download failed: ${res.status}`);
  await writeFile(MERMAID, Buffer.from(await res.arrayBuffer()));
}

function findBrowser() {
  for (const p of EDGE_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  throw new Error("No Chromium browser found (Edge/Chrome).");
}

async function writeHtmlAndCount(mdPath, htmlPath, opts) {
  const md = readFileSync(mdPath, "utf8");
  const { mermaidBlocks } = markdownToHtml(md);
  await writeFile(htmlPath, page(md, mermaidBlocks, opts));
  return { mermaidBlockCount: mermaidBlocks.length };
}

// Usage: node tools/md2pdf.mjs <in.md> [out.pdf] [--paper=A3] [--spacing=18] [--font-size=18]
// Flags may appear anywhere; only non-flag arguments are positional.
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const positional = argv.filter((a) => !a.startsWith("--"));

// --font-size: mermaid font px before the sheet downscale
const fontPx = Number(flag("font-size", 18));
// --spacing: dagre node/rank spacing; smaller = denser = bigger on paper
const spacing = Number(flag("spacing", 30));
// --rank-spacing: vertical gap between ranks. Also the fix for edge labels
//   landing on subgraph titles: dagre does not reserve room for those titles,
//   so a short gap pushes the label straight through the cluster's header.
//   Defaults to 50 rather than the tightest passing value, because the exact
//   threshold moves as the graph is edited.
const rankSpacing = Number(flag("rank-spacing", 50));
// --title-margin: top margin reserved for a subgraph title (mermaid default 25)
const titleMargin = Number(flag("title-margin", 25));
// --paper: bigger sheet = more readable text for dense diagrams
const paper = flag("paper", "A4");
const margin = paper === "A3" ? "16mm 14mm" : "14mm 12mm";
const usableW = paper === "A3" ? 392 : 273;
const usableH = paper === "A3" ? 265 : 182;
// --no-title: omit the document h1 from the printed sheet, graph only
const noTitle = process.argv.includes("--no-title");
// --svg: also write standalone .svg next to the .pdf
const wantSvg = process.argv.includes("--svg");

const mdArg = positional[0] ?? "README.md";
const pdfArg = positional[1] ?? mdArg.replace(/\.md$/i, "") + ".pdf";
const mdPath = resolve(process.cwd(), mdArg);
const pdfPath = resolve(process.cwd(), pdfArg);
const htmlPath = join(CACHE, mdArg.replace(/[\\/]/g, "_") + ".html");

await ensureMermaid();
const { mermaidBlockCount } = await writeHtmlAndCount(mdPath, htmlPath, { fontPx, spacing, rankSpacing, titleMargin, paper, usableW, usableH, margin, noTitle, wantSvg });

// --- render via CDP ---------------------------------------------------------
// `--print-to-pdf` snapshots on a virtual clock, which fires before mermaid's
// async render lands, producing a PDF with an empty diagram. Drive the browser
// over the DevTools protocol instead and print once the page reports READY.

const PORT = 9333 + (process.pid % 200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpTargets(port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error("Browser did not expose a DevTools endpoint");
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      msg.error ? entry.reject(new Error(msg.error.message)) : entry.resolve(msg.result);
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error("CDP socket failed")), { once: true });
    });
    return new Cdp(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

const browser = findBrowser();
const profile = join(CACHE, "edge-profile");
const child = spawn(
  browser,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--remote-debugging-port=" + PORT,
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

let exitCode = 0;
try {
  const cdp = await Cdp.connect(await cdpTargets(PORT));
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.navigate", { url: "file:///" + htmlPath.replace(/\\/g, "/") }, sessionId);

  // Wait for the page's own render-complete signal.
  let status = "";
  for (let i = 0; i < 240; i++) {
    const r = await cdp.send(
      "Runtime.evaluate",
      { expression: "document.title", returnByValue: true },
      sessionId,
    );
    status = r.result?.value ?? "";
    if (status === "READY" || status.startsWith("ERROR")) break;
    await sleep(250);
  }
  if (status !== "READY") throw new Error(`page never became READY (title: "${status}")`);

  const audit = await cdp.send(
    "Runtime.evaluate",
    { expression: "document.body.dataset.diagrams", returnByValue: true },
    sessionId,
  );
  const diagrams = JSON.parse(audit.result.value || "[]");
  if (diagrams.length !== mermaidBlockCount) {
    throw new Error(`expected ${mermaidBlockCount} diagrams, page reported ${diagrams.length}`);
  }
  let overlaps = 0;
  for (const [i, d] of diagrams.entries()) {
    if (!d || !d.nodes) throw new Error(`diagram ${i + 1} rendered empty (${JSON.stringify(d)})`);
    const n = d.collisions?.length ?? 0;
    overlaps += n;
    const collide = n ? `, ${n} OVERLAP: ${d.collisions.join("; ")}` : "";
    console.log(`diagram ${i + 1}: ${d.w}x${d.h}px on sheet, ${d.nodes} nodes, ~${d.textPx}px text${collide}`);
  }
  if (overlaps && process.argv.includes("--strict")) {
    throw new Error(`${overlaps} label/title overlaps (rerun with a larger --rank-spacing)`);
  }

  const { data } = await cdp.send(
    "Page.printToPDF",
    { printBackground: true, preferCSSPageSize: true, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 },
    sessionId,
  );
  await writeFile(pdfPath, Buffer.from(data, "base64"));

  if (wantSvg) {
    const raw = await cdp.send(
      "Runtime.evaluate",
      { expression: "document.body.dataset.svgs || '[]'", returnByValue: true },
      sessionId,
    );
    const svgs = JSON.parse(raw.result.value || "[]");
    if (svgs.length !== mermaidBlockCount) {
      throw new Error(`expected ${mermaidBlockCount} svgs, got ${svgs.length}`);
    }
    // A standalone file has no page furniture, so size straight to the usable box.
    const MM = 96 / 25.4;
    for (const [i, svg] of svgs.entries()) {
      const out = svgPath(pdfPath, i, svgs.length);
      await writeFile(out, sizeSvg(svg, usableW * MM, usableH * MM));
      const { size } = await stat(out);
      console.log(`SVG: ${out} (${Math.round(size / 1024)} KB)`);
    }
  }
  cdp.ws.close();
} catch (err) {
  console.error("render failed:", err.message);
  exitCode = 1;
} finally {
  child.kill();
}

if (exitCode) process.exit(exitCode);
const { size } = await stat(pdfPath);
console.log(`PDF: ${pdfPath} (${Math.round(size / 1024)} KB)`);
