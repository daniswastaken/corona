// md2pdf.mjs - render a Markdown file (with mermaid blocks) to PDF and/or SVG
// via headless Edge.
//
// Usage:
//   node tools/md2pdf.mjs <in.md> [out.pdf] [flags]
//
// Flags:
//   --paper=A4|A3        sheet size for the diagram pages (default A4)
//   --orientation=portrait|landscape
//                        page orientation; portrait suits tall top-down graphs
//                        (default landscape)
//   --no-title           omit the document h1, print the graph alone
//   --svg                also write out.svg beside the pdf
//   --only-diagram        PDF is the graph alone on one sheet, no prose pages
//   --align "A,B;C,D"      force those subgraph ids onto one left edge and one width
//   --verbose             also print each subgraph's placed position
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
// Which nodes each mermaid subgraph owns. The rendered SVG keeps nodes in a
// sibling layer with no membership marker, so the only reliable source is the
// definition itself. Returns { SUBCOMGRAPH_ID: ["NODE_ID", ...] }.
// The edges of a mermaid block, as { id, src, dst, label, kind }. Written with
// string operations and no backslashes: the id has to match what mermaid emits
// ("L_SRC_DST_n") so the emitted paths can be found and re-routed.
function blockEdges(block) {
  // Longest first: "<-->" contains "-->", so checking it later would match the
  // tail of it and split the line in the wrong place. "---" is a plain link with
  // no arrowhead, and must be matched before "-->" for the same reason.
  const ARROWS = ["<-.->", "<-->", "-.->", "-->", "---"];
  const edges = [];
  const seen = new Map();
  const nameOf = (s) => s.split("[")[0].trim();

  for (const raw of block.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("%%") || line.startsWith("subgraph") || line === "end") continue;
    if (line.startsWith("graph ") || line.startsWith("flowchart ")) continue;

    let at = -1;
    let arrow = null;
    for (const a of ARROWS) {
      const i = line.indexOf(a);
      if (i >= 0 && (at < 0 || i < at || (i === at && a.length > arrow.length))) {
        at = i;
        arrow = a;
      }
    }
    if (at < 0) continue;

    const src = nameOf(line.slice(0, at));
    let rest = line.slice(at + arrow.length);
    let label = "";
    rest = rest.trim();
    if (rest.startsWith("|")) {
      const close = rest.indexOf("|", 1);
      label = rest.slice(1, close < 0 ? rest.length : close);
      rest = rest.slice(close < 0 ? rest.length : close + 1);
    }
    const dst = nameOf(rest);
    if (!src || !dst) continue;

    const key = src + ">" + dst;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    edges.push({
      id: `L_${src}_${dst}_${n}`,
      src,
      dst,
      label,
      kind: arrow === "---" ? "link" : arrow.includes("-.->") ? "dotted" : "solid",
      both: arrow.startsWith("<"),
    });
  }
  return edges;
}

function clusterMembers(mermaidBlocks) {
  const map = {};
  for (const block of mermaidBlocks) {
    const lines = block.split(/\r?\n/);
    let current = null;
    for (const line of lines) {
      const sub = line.match(/^\s*subgraph\s+(\w+)/);
      if (sub) {
        current = sub[1];
        map[current] = map[current] || [];
        continue;
      }
      if (/^\s*end\s*$/.test(line)) {
        current = null;
        continue;
      }
      if (!current) continue;
      // A bare node declaration: ID["label"] or ID[label], not an edge.
      const node = line.match(/^\s*(\w+)\s*\[/);
      if (node && !line.includes("-->") && !line.includes("-.->")) {
        map[current].push(node[1]);
      }
    }
  }
  return map;
}

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
  const { fontPx, spacing, rankSpacing, titleMargin, paper, usableW, usableH, margin, noTitle, wantSvg, onlyDiagram, alignGroups, clusterMemberMap, edgeMap } = opts;
  const { html, diagramOnly: contentIsDiagramOnly } = markdownToHtml(md);
  const diagramOnly = opts.onlyDiagram || contentIsDiagramOnly;
  const pageSize = sheetName;
  const title = (md.match(/^#\s+(.*)$/m) ?? [, "Document"])[1];
  // --no-title: print the graph alone, without the document's h1
  let bodyHtml = opts.noTitle ? html.replace(/^\s*<h1>[\s\S]*?<\/h1>\s*/, "") : html;
  // --only-diagram: drop every prose block so the PDF is the graph and nothing
  // else, on a single sheet
  if (opts.onlyDiagram) {
    const sections = html.match(/<section class="diagram-page">[\s\S]*?<\/section>/g) ?? [];
    bodyHtml = sections.join("\n");
  }

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

  // Diagram sheets are ${sheetName}, margins ${margin}. Fit each SVG into
  // what is left after its own headings, rather than trusting a CSS max-height
  // that the print layout will not honour.
  const MM = 96 / 25.4;
  const SHEET_W = ${usableW} * MM;
  const SHEET_H = ${usableH} * MM;
  const SHARED_PAGE = ${diagramOnly};
  // subgraph id -> node ids it owns, taken from the mermaid source
  const CLUSTER_MEMBERS = ${JSON.stringify(clusterMemberMap)};
  // per diagram, the edges mermaid emitted, so they can be re-routed after nodes move
  const EDGES = ${JSON.stringify(edgeMap)};

  // Mermaid/dagre derives subgraph boxes from edge geometry alone. There is no
  // way to ask it for "these two blocks the same width" or "line these two up",
  // and hand-tuning edges to fake it only moves the misalignment somewhere
  // else. But its output is regular: one <g class="cluster"> per subgraph with
  // a background <rect> and a title, while nodes and edges live in sibling
  // layers. So square the frames up directly instead of moving the graph -
  // each group of subgraphs is forced onto one shared left edge and one shared
  // width, growing symmetrically around the content dagre already centred.
  // Nodes and edges are untouched, so connectivity survives.
  function alignClusters(svg, groups) {
    const GAP = 26;
    let placedRight = null;
    // mermaid prefixes cluster ids with the render id ("m0-ENERGI"), so match on
    // the trailing name rather than the literal id.
    const clusters = [...svg.querySelectorAll("g.cluster")];
    const find = (name) =>
      clusters.find((g) => {
        const id = g.getAttribute("id") || "";
        return id === name || id.endsWith("-" + name);
      });

    for (const ids of groups) {
      const boxes = [];
      for (const id of ids) {
        const g = find(id);
        const r = g && g.querySelector("rect");
        if (!r) continue;
        boxes.push({
          g, r, name: id,
          x: +r.getAttribute("x"),
          y: +r.getAttribute("y"),
          w: +r.getAttribute("width"),
          h: +r.getAttribute("height"),
        });
      }
      if (boxes.length < 2) continue;

      // Even out the node boxes themselves, not just the frames around them.
      // A node rect can be widened symmetrically about its own centre, which
      // leaves every edge attached exactly where it was - edges terminate at node
      // centres, so nothing detaches. This is what makes the blocks read as
      // evenly filled rather than as a frame with lopsided contents.
      const pad = 14;
      const target = Math.max(
        ...boxes.flatMap((b) => membersOf(svg, b).map((n) => n.right - n.left)),
      );
      for (const b of boxes) {
        for (const n of membersOf(svg, b)) {
          const grow = (target - (n.right - n.left)) / 2;
          if (grow <= 0.5) continue;
          n.shape.setAttribute("x", String(round2(n.x - grow)));
          n.shape.setAttribute("width", String(round2(target)));
        }
      }
      // geometry just changed, so anything measuring nodes must re-read it
      svg.__nodeRects = null;

      // Centre every block's contents in the group's frame. Single-column blocks
      // therefore line up with each other automatically (same width, same centre),
      // while a one-node block under a three-node block sits in the middle rather
      // than hanging off the left edge.
      const edgeList = EDGES[svg.__diagramIndex || 0] || [];
      const spansOf = (b) => {
        const inner = membersOf(svg, b);
        if (!inner.length) return { lo: b.x, hi: b.x + b.w, cx: b.x + b.w / 2 };
        const lo = Math.min(...inner.map((n) => n.left));
        const hi = Math.max(...inner.map((n) => n.right));
        return { lo, hi, cx: (lo + hi) / 2 };
      };
      const spans = boxes.map(spansOf);
      const frameCx = (Math.min(...spans.map((s) => s.lo)) + Math.max(...spans.map((s) => s.hi))) / 2;

      for (const [bi, b] of boxes.entries()) {
        const dx = frameCx - spans[bi].cx;
        if (Math.abs(dx) > 0.5) moveNodes(svg, b, dx);
      }

      // Groups are placed left to right; a group that would land on top of an
      // earlier one is nudged clear instead of being allowed to overlap.
      const mine = boxes.map(spansOf);
      let left = Math.min(...mine.map((s) => s.lo)) - pad;
      let right = Math.max(...mine.map((s) => s.hi)) + pad;
      if (placedRight !== null && left < placedRight + GAP) {
        const shift = placedRight + GAP - left;
        for (const b of boxes) moveNodes(svg, b, shift);
        left += shift;
        right += shift;
      }
      placedRight = right;
      rewiteEdges(svg, edgeList);

      for (const b of boxes) {
        b.r.setAttribute("x", String(round2(left)));
        b.r.setAttribute("width", String(round2(right - left)));
        b.g.removeAttribute("transform");
      }
      for (const b of boxes) placeBlockLabel(b, left, right);
    }
  }

  // Block titles sit at the top-left inside the frame, like a fieldset legend.
  // Mermaid centres them and sizes the group from the text, so a long title on a
  // narrow block spills past both edges. Re-anchor on the left, clamp the group
  // to the frame width, and let the text ellipsize if it still cannot fit.
  function placeBlockLabel(box, left, right) {
    const label = box.g.querySelector("g.cluster-label");
    if (!label) return;
    const inner = label.firstElementChild;
    const outer = inner && inner.querySelector("text");
    const pad = 6;

    label.setAttribute(
      "transform",
      "translate(" + round2(left + pad) + "," + round2(box.y) + ")",
    );
    if (outer) {
      for (const t of outer.querySelectorAll("tspan")) t.setAttribute("text-anchor", "start");
    }
    // Measure after re-anchoring, then shrink to the frame if it overflows.
    const w = label.getBBox ? label.getBBox().width : 0;
    const avail = right - left - pad * 2;
    if (w > avail && w > 0) {
      const scale = avail / w;
      inner.setAttribute("transform", "scale(" + round2(scale) + ",1)");
      // A scaled transform shifts the origin, so correct for it.
      label.setAttribute(
        "transform",
        "translate(" + round2(left + pad) + "," + round2(box.y) + ")",
      );
      inner.style.transformOrigin = "0 0";
    } else if (inner.hasAttribute("transform")) {
      inner.removeAttribute("transform");
    }
  }

  // Slide one block's nodes sideways. Only the <g> translate changes, so a node
  // keeps its internal geometry and its edges are re-routed afterwards.
  function moveNodes(svg, box, dx) {
    for (const name of CLUSTER_MEMBERS[box.name] || []) {
      for (const g of svg.querySelectorAll("g.node")) {
        const id = g.getAttribute("id") || "";
        if (id.split("-flowchart-")[1]?.replace(/-[0-9]+$/, "") !== name) continue;
        const tr = g.getAttribute("transform") || "";
        const nums = tr.slice(tr.indexOf("(") + 1, tr.lastIndexOf(")")).split(",");
        const ox = parseFloat(nums[0]) || 0;
        const oy = parseFloat(nums[1]) || 0;
        g.setAttribute("transform", "translate(" + round2(ox + dx) + "," + round2(oy) + ")");
      }
    }
    svg.__nodeRects = null;
  }

  // Re-draw every edge between the nodes' current boxes. Anchors are chosen on
  // the box border the edge leaves from and arrives at, and the curve is a plain
  // cubic, which is what dagre emits for a top-down graph anyway.
  function rewiteEdges(svg, edges) {
    if (!edges || !edges.length) return;
    const rects = nodeRects(svg);
    for (const e of edges) {
      const path = svg.querySelector('path[data-id="' + e.id + '"]');
      const a = rects.get(e.src);
      const b = rects.get(e.dst);
      if (!path || !a || !b) continue;

      // An undirected link ("---") is a relationship, not a command, so it joins
      // the two boxes side by side. Routing it top-to-bottom instead would run
      // the line straight through whichever node sits between them.
      const side = !e.kind || e.kind === "link";

      const sameColumn = Math.abs(a.cx - b.cx) < 2;
      let mid;
      if (side && !sameColumn) {
        const rightward = b.cx > a.cx;
        const x1 = rightward ? a.right : a.left;
        const x2 = rightward ? b.left : b.right;
        const y = round2((a.cy + b.cy) / 2);
        const midX = round2((x1 + x2) / 2);
        path.setAttribute(
          "d",
          "M" + round2(x1) + "," + round2(a.cy) +
            "C" + midX + "," + round2(a.cy) + " " + midX + "," + round2(b.cy) +
            " " + round2(x2) + "," + round2(b.cy),
        );
        mid = { x: midX, y };
      } else if (sameColumn) {
        const down = b.top > a.top;
        const y1 = down ? a.bottom : a.top;
        const y2 = down ? b.top : b.bottom;
        const x = round2((a.cx + b.cx) / 2);
        path.setAttribute("d", "M" + x + "," + round2(y1) + "L" + x + "," + round2(y2));
        mid = { x, y: (y1 + y2) / 2 };
      } else {
        const down = b.cy > a.cy;
        const y1 = down ? a.bottom : a.top;
        const y2 = down ? b.top : b.bottom;
        const x1 = round2(a.cx);
        const x2 = round2(b.cx);
        const midY = round2((y1 + y2) / 2);
        path.setAttribute(
          "d",
          "M" + x1 + "," + round2(y1) + "C" + x1 + "," + midY + " " + x2 + "," + midY +
            " " + x2 + "," + round2(y2),
        );
        // cubic midpoint at t=0.5 is (P0 + 3P1 + 3P2 + P3) / 8
        mid = { x: (x1 + 3 * x1 + 3 * x2 + x2) / 8, y: (y1 + 3 * midY + 3 * midY + y2) / 8 };
      }

      const label = svg.querySelector('g.label[data-id="' + e.id + '"]');
      if (label) {
        // Mermaid positions a label on the wrapping g.edgeLabel and leaves the
        // inner g.label at identity. Writing the offset to both stacks them, so
        // the position goes on the wrapper and the inner one is reset.
        const holder = label.closest("g.edgeLabel") || label;
        holder.setAttribute("transform", "translate(" + round2(mid.x) + "," + round2(mid.y) + ")");
        if (holder !== label) label.setAttribute("transform", "translate(0,0)");
      }
    }
  }


  // Node positions in viewBox units, keyed by the node's mermaid name.
  function nodeRects(svg) {
    const out = new Map();
    for (const g of svg.querySelectorAll("g.node")) {
      const shape = g.querySelector("rect,circle,ellipse,polygon");
      if (!shape) continue;
      // Nodes sit in a sibling layer positioned by a translate on the wrapping
      // <g>, so the shape's own x/y are local to that group.
      // Parsed with string ops rather than a regex on purpose. This whole block
      // sits inside a JS template literal, where a single backslash is an escape
      // sequence: /translate\(\s*.../ silently becomes /translate(s*(-d.]+).../
      // and the node lookup below comes back empty. No backslashes, no surprises.
      const tr = g.getAttribute("transform") || "";
      const nums = tr.slice(tr.indexOf("(") + 1, tr.lastIndexOf(")")).split(",");
      const ox = parseFloat(nums[0]) || 0;
      const oy = parseFloat(nums[1]) || 0;
      const b = shape.getBBox();
      // Ids look like "m0-flowchart-SURYA-0": strip the prefix and the trailing
      // index, leaving the name as written in the mermaid source.
      const id = g.getAttribute("id") || "";
      const name = (id.split("-flowchart-")[1] || "").replace(/-[0-9]+$/, "");
      out.set(name, {
        left: ox + b.x,
        right: ox + b.x + b.width,
        top: oy + b.y,
        bottom: oy + b.y + b.height,
        cx: ox + b.x + b.width / 2,
        cy: oy + b.y + b.height / 2,
        x: b.x,
        shape,
      });
    }
    return out;
  }

  function membersOf(svg, box) {
    const rects = svg.__nodeRects || (svg.__nodeRects = nodeRects(svg));
    const names = CLUSTER_MEMBERS[box.name] || [];
    const out = [];
    for (const n of names) {
      const r = rects.get(n);
      if (r) out.push(r);
    }
    return out;
  }

  const round2 = (n) => Math.round(n * 100) / 100;

  // Moving the frames can push content outside the original viewBox, which
  // would silently crop it. Re-derive the viewBox from what is actually drawn.
  function reframe(svg, pad = 8) {
    let box;
    try {
      box = svg.getBBox();
    } catch {
      return;
    }
    if (!box || !box.width || !box.height) return;
    svg.setAttribute(
      "viewBox",
      [box.x - pad, box.y - pad, box.width + pad * 2, box.height + pad * 2]
        .map(round2)
        .join(" "),
    );
  }

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
      clusters: clusterBoxes(svg),
      nodesList: nodeBoxes(svg),
    };
  }

  // Every node's rendered size, in viewBox units. Used to check that sibling
  // nodes inside one block come out the same size instead of eyeballing it.
  function nodeBoxes(svg) {
    const vb = svg.viewBox && svg.viewBox.baseVal;
    const sx = vb && vb.width ? svg.getBoundingClientRect().width / vb.width : 1;
    const originX = () => svg.getBoundingClientRect().left;
    return [...svg.querySelectorAll("g.node")]
      .map((g) => {
        const shape = g.querySelector("rect,circle,ellipse,polygon,path");
        const r = (shape || g).getBoundingClientRect();
        const gr = g.getBoundingClientRect();
        const label = [...(g.querySelectorAll("tspan") || [])]
          .map((t) => (t.textContent || "").trim())
          .filter(Boolean)
          .join(" / ")
          .slice(0, 34) || (g.id || "?").slice(0, 34);
        return {
          name: label,
          x: Math.round((gr.left - originX()) / sx),
          w: Math.round(r.width / sx), h: Math.round(r.height / sx),
        };
      })
      .sort((a, b) => b.w - a.w);
  }

  // Where each subgraph actually landed, in viewBox units. dagre picks cluster
  // placement from declaration order and edge geometry, so block layout is not
  // something to eyeball - measure it.
  function clusterBoxes(svg) {
    const vb = svg.viewBox && svg.viewBox.baseVal;
    const sx = vb && vb.width ? svg.getBoundingClientRect().width / vb.width : 1;
    const originX = svg.getBoundingClientRect().left;
    const originY = svg.getBoundingClientRect().top;
    return [...svg.querySelectorAll("g.cluster")]
      .map((c) => {
        const label = c.querySelector(".cluster-label");
        const r = c.getBoundingClientRect();
        return {
          name: (label?.textContent || "?").trim().replace(/[ ]+/g, " ").slice(0, 28),
          x: Math.round((r.left - originX) / sx),
          y: Math.round((r.top - originY) / sx),
          w: Math.round(r.width / sx),
          h: Math.round(r.height / sx),
        };
      })
      .sort((a, b) => a.y - b.y || a.x - b.x);
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
      const div = document.getElementById("d" + i);
      const svg = div.querySelector("svg");
      alignClusters(svg, ${JSON.stringify(alignGroups)});
      if (${JSON.stringify(alignGroups)}.length) reframe(svg);
      report.push(fitToSheet(div));
    }
    document.body.dataset.diagrams = JSON.stringify(report);

    // Standalone SVG wants real <text>, not the HTML labels the PDF uses:
    // foreignObject is invisible to Inkscape, Illustrator and <img> consumers.
    if (${wantSvg}) {
      mermaid.initialize({ ...baseConfig(), htmlLabels: false });
      const out = [];
      for (let i = 0; i < defs.length; i++) {
        const { svg } = await mermaid.render("s" + i, defs[i]);
        // same block alignment as the printed sheet, so the two agree
        // Must be in the document: getBBox() returns zeroes on a detached SVG,
        // which silently turns the block-sizing pass into a no-op.
        const holder = document.createElement("div");
        holder.style.cssText = "position:absolute;left:-99999px;top:0;width:10000px";
        holder.innerHTML = svg;
        document.body.appendChild(holder);
        const el = holder.querySelector("svg");
        alignClusters(el, ${JSON.stringify(alignGroups)});
        if (${JSON.stringify(alignGroups)}.length) reframe(el);
        out.push(inlineStyles(holder.innerHTML));
        holder.remove();
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
  const clusterMemberMap = clusterMembers(mermaidBlocks);
  const edgeMap = mermaidBlocks.map((b) => blockEdges(b));
  await writeFile(htmlPath, page(md, mermaidBlocks, { ...opts, clusterMemberMap, edgeMap }));
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
// --orientation: portrait suits tall top-down graphs, landscape suits wide ones
const orientation = flag("orientation", "landscape");
if (orientation !== "portrait" && orientation !== "landscape") {
  throw new Error(`--orientation must be portrait or landscape, got "${orientation}"`);
}

// Usable print area per sheet, in mm, after the page margins.
const SHEETS = {
  "A4 landscape": { w: 273, h: 182, margin: "14mm 12mm" },
  "A4 portrait": { w: 186, h: 269, margin: "14mm 12mm" },
  "A3 landscape": { w: 392, h: 265, margin: "16mm 14mm" },
  "A3 portrait": { w: 269, h: 388, margin: "16mm 14mm" },
};
const sheetName = `${paper} ${orientation}`;
const sheet = SHEETS[sheetName];
if (!sheet) throw new Error(`--paper must be A4 or A3, got "${paper}"`);
const { margin, usableW, usableH } = { margin: sheet.margin, usableW: sheet.w, usableH: sheet.h };
// --align "A,B;C,D": force each comma-separated group of subgraph ids onto one
//   shared left edge and one shared width. Ids are the mermaid subgraph names,
//   e.g. --align "ENERGI,CORONA;MASUKAN,KENDALI". Mermaid has no option for
//   this, so it is applied to the emitted frames after layout.
const alignGroups = (flag("align", "") || "")
  .split(";")
  .map((g) => g.split(",").map((s) => s.trim()).filter(Boolean))
  .filter((g) => g.length > 1);
// --no-title: omit the document h1 from the printed sheet, graph only
const noTitle = process.argv.includes("--no-title");
// --only-diagram: PDF is the graph alone, one sheet, no prose pages
const onlyDiagram = process.argv.includes("--only-diagram");
// --svg: also write standalone .svg next to the .pdf
const wantSvg = process.argv.includes("--svg");

const mdArg = positional[0] ?? "README.md";
const pdfArg = positional[1] ?? mdArg.replace(/\.md$/i, "") + ".pdf";
const mdPath = resolve(process.cwd(), mdArg);
const pdfPath = resolve(process.cwd(), pdfArg);
const htmlPath = join(CACHE, mdArg.replace(/[\\/]/g, "_") + ".html");

await ensureMermaid();
const { mermaidBlockCount } = await writeHtmlAndCount(mdPath, htmlPath, { fontPx, spacing, rankSpacing, titleMargin, paper, usableW, usableH, margin, noTitle, wantSvg, onlyDiagram, alignGroups });

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
  let verbose = process.argv.includes("--verbose");
  for (const [i, d] of diagrams.entries()) {
    if (!d || !d.nodes) throw new Error(`diagram ${i + 1} rendered empty (${JSON.stringify(d)})`);
    const n = d.collisions?.length ?? 0;
    overlaps += n;
    const collide = n ? `, ${n} OVERLAP: ${d.collisions.join("; ")}` : "";
    console.log(`diagram ${i + 1}: ${d.w}x${d.h}px on sheet, ${d.nodes} nodes, ~${d.textPx}px text${collide}`);
    if (verbose) {
      for (const c of d.clusters ?? []) {
        console.log(`    cluster ${String(c.x).padStart(5)},${String(c.y).padStart(5)}  ${c.w}x${c.h}  ${c.name}`);
      }
      for (const n of d.nodesList ?? []) {
        console.log(`    node    x=${String(n.x).padStart(5)}  ${String(n.w).padStart(4)}x${String(n.h).padStart(3)}  ${n.name}`);
      }
    }
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
