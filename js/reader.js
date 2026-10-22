// Read a vector PDF in the browser: every visible path on page 1 with stroke width, colour, fill and PDF layer,
// grouped by line style and layer. A port of the old pipeline/extract.py, so the groups and counts match it:
// linework outside its clip window (viewports) or painted over by a later white fill (title blocks, masks) is cut
// away, and each cut is checked against a render of the page, because a white fill inside a transparency group or
// soft mask may not hide anything. Coordinates are PDF points, y down from the top-left of the page.
import * as pdfjs from '../vendor/pdfjs/pdf.min.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
const { OPS, AnnotationMode } = pdfjs;

const EPS = 1e-4;
const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const near = (a, b) => Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS;
const WHITE = c => !!c && c.every(v => v > 0.99);
const bboxOf = pts => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; } return [x0, y0, x1, y1]; };
const meet = (a, b) => !a ? b : !b ? a : [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
const rgb = c => c ? [c[0] / 255, c[1] / 255, c[2] / 255] : null;
const r2 = v => Math.round(v * 100) / 100, r3 = v => Math.round(v * 1000) / 1000;
// give the page a moment to repaint the progress bar (a MessageChannel isn't slowed down in background tabs like
// setTimeout is), at most every 50 ms
let lastYield = 0;
const chan = new MessageChannel(), waiting = [];          // one long-lived channel: a throwaway one can be garbage-collected
chan.port1.onmessage = () => waiting.shift()?.();
export const yieldNow = () => new Promise(r => { waiting.push(r); chan.port2.postMessage(0); });
const breathe = () => { if (performance.now() - lastYield < 50) return null; lastYield = performance.now(); return yieldNow(); };

/** A path's line style key: stroke width, stroke colour (or none), filled. */
export const styleKey = p => `${r3(p.w)}|${p.col ? p.col.map(r2).join(',') : '-'}|${p.fill ? 1 : 0}`;
export const hexcol = c => c ? '#' + c.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('') : null;

function bez(p0, p1, p2, p3, n = 16) {
  const out = [];
  for (let i = 1; i <= n; i++) { const t = i / n, u = 1 - t;
    out.push([u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
              u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]]); }
  return out;
}

/** Walk the page's operator list like a renderer and collect every stroked or filled path. */
function walk(ops, view, ocName) {
  const paths = [], masks = [];
  let gs = { ctm: view, lw: 1, stroke: [0, 0, 0], fill: [0, 0, 0], ca: 1, clip: null };
  const stack = [], marked = [], skip = [];       // skip: group depths whose content is a soft mask, not drawing
  let runs = [], cur = null, start = null, pendingClip = false, closeFlag = false, seq = 0, moved = false;
  let lastFill = null;                             // the fill just painted, in case the same shape is stroked next
  const flush = () => { if (cur && cur.length >= 2) runs.push(cur); cur = null; };
  const to = (pt, newRun) => {                     // add a point; a moveTo onto the current end continues the run
    if (newRun) { moved = true; if (cur && near(cur[cur.length - 1], pt)) return; flush(); cur = [pt]; start = pt; return; }
    if (!cur) { cur = [pt]; start = pt; moved = false; return; }
    // like MuPDF: a zero-length step is dropped, except straight after a move (that's how CAD draws a dot)
    if (near(cur[cur.length - 1], pt) && !moved) return;
    cur.push(pt); moved = false;
  };
  const layer = () => { for (let i = marked.length - 1; i >= 0; i--) if (marked[i]) return marked[i]; return ''; };
  const paint = (type, closing, evenOdd) => {
    if (closing && cur && cur.length >= 2 && !near(cur[cur.length - 1], start)) cur.push(start);
    if (closing) closeFlag = true;
    flush();
    const these = runs; runs = []; const closedPath = closeFlag; closeFlag = false;
    if (pendingClip) { const all = these.flat(); if (all.length) gs.clip = meet(gs.clip, bboxOf(all)); pendingClip = false; }
    const prev = lastFill; lastFill = null;
    if (type === 'n' || skip.length || !these.length) return;
    const s = type.includes('s'), f = type.includes('f');
    const det = Math.abs(gs.ctm[0] * gs.ctm[3] - gs.ctm[1] * gs.ctm[2]);
    const w = s ? gs.lw * Math.sqrt(det) : 0, col = s ? gs.stroke : null, fill = f ? gs.fill : null;
    // like MuPDF: a fill followed straight away by a stroke of the same shape is one filled-and-outlined path
    if (type === 's' && prev && prev.runs.length === these.length && prev.runs.every((r, k) => r.length === these[k].length && r.every((q, m) => near(q, these[k][m])))) {
      for (let k = prev.from; k < paths.length; k++) { paths[k].w = w; paths[k].col = col; paths[k].closed ||= closedPath; }
      return;
    }
    const n = seq++, from = paths.length;
    if (WHITE(fill) && gs.ca > 0.99) {
      const rings = these.filter(r => r.length >= 3);
      if (rings.length) masks.push({ seq: n, rings, evenOdd, clip: gs.clip, bbox: meet(bboxOf(rings.flat()), gs.clip) });
    }
    for (const r of these) {
      const closed = closedPath || (r.length > 3 && near(r[0], r[r.length - 1]));
      paths.push({ pts: r, w, col, fill, closed, layer: layer(), seq: n, sc: gs.clip });
    }
    if (type === 'f') lastFill = { runs: these, from };
  };
  const { fnArray, argsArray } = ops;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i], a = argsArray[i];
    switch (fn) {
      case OPS.save: stack.push({ ...gs }); break;
      case OPS.restore: if (stack.length) gs = stack.pop(); break;
      case OPS.transform: gs.ctm = mul(gs.ctm, a); break;
      case OPS.setLineWidth: gs.lw = a[0]; break;
      case OPS.setGState: for (const [k, v] of a[0]) { if (k === 'LW') gs.lw = v; if (k === 'ca') gs.ca = v; } break;
      case OPS.setStrokeRGBColor: gs.stroke = rgb(a); break;
      case OPS.setFillRGBColor: gs.fill = rgb(a); break;
      case OPS.setStrokeTransparent: case OPS.setStrokeColorN: gs.stroke = null; break;
      case OPS.setFillTransparent: case OPS.setFillColorN: gs.fill = null; break;
      case OPS.beginMarkedContent: marked.push(null); break;
      case OPS.beginMarkedContentProps: {
        const [tag, props] = a; let name = null;
        if (tag === 'OC' && props) name = ocName(props.type === 'OCMD' ? props.ids?.[0] : props.id) || null;
        marked.push(name); break;
      }
      case OPS.endMarkedContent: marked.pop(); break;
      case OPS.beginGroup: stack.push({ ...gs }); if (a[0]?.smask || skip.length) skip.push(true); break;
      case OPS.endGroup: if (stack.length) gs = stack.pop(); if (skip.length) skip.pop(); break;
      case OPS.paintFormXObjectBegin: {
        stack.push({ ...gs }); const [m, bb] = a;
        if (m) gs.ctm = mul(gs.ctm, m);
        if (bb) gs.clip = meet(gs.clip, bboxOf([[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]]].map(([x, y]) => apply(gs.ctm, x, y))));
        break;
      }
      case OPS.paintFormXObjectEnd: if (stack.length) gs = stack.pop(); break;
      case OPS.constructPath: {
        const [o, c] = a; let j = 0, last = cur ? cur[cur.length - 1] : null;
        const P = (x, y) => apply(gs.ctm, x, y);
        for (const op of o) {
          if (op === OPS.moveTo) { last = P(c[j++], c[j++]); to(last, true); }
          else if (op === OPS.lineTo) { last = P(c[j++], c[j++]); to(last, false); }
          else if (op === OPS.curveTo || op === OPS.curveTo2 || op === OPS.curveTo3) {
            let c1, c2, e;
            if (op === OPS.curveTo) { c1 = P(c[j], c[j + 1]); c2 = P(c[j + 2], c[j + 3]); e = P(c[j + 4], c[j + 5]); j += 6; }
            else if (op === OPS.curveTo2) { c1 = last; c2 = P(c[j], c[j + 1]); e = P(c[j + 2], c[j + 3]); j += 4; }
            else { c1 = P(c[j], c[j + 1]); c2 = e = P(c[j + 2], c[j + 3]); j += 4; }
            if (!cur) to(last, true);
            for (const q of bez(last, c1, c2, e)) to(q, false);
            last = e;
          } else if (op === OPS.rectangle) {
            const x = c[j++], y = c[j++], w = c[j++], h = c[j++];
            flush(); const r = [P(x, y), P(x + w, y), P(x + w, y + h), P(x, y + h)]; r.push(r[0]); runs.push(r);
            last = r[0]; cur = null;
          } else if (op === OPS.closePath) {
            if (cur && cur.length >= 2 && !near(cur[cur.length - 1], start)) cur.push(start);
            closeFlag = true; last = start;
          }
        }
        break;
      }
      case OPS.clip: case OPS.eoClip: pendingClip = true; break;
      case OPS.endPath: paint('n'); break;
      case OPS.stroke: paint('s'); break;
      case OPS.closeStroke: paint('s', true); break;
      case OPS.fill: paint('f'); break;
      case OPS.eoFill: paint('f', false, true); break;
      case OPS.fillStroke: paint('fs'); break;
      case OPS.eoFillStroke: paint('fs', false, true); break;
      case OPS.closeFillStroke: paint('fs', true); break;
      case OPS.closeEOFillStroke: paint('fs', true, true); break;
    }
  }
  return { paths, masks };
}

// ---- geometry for the cuts: split each segment where it crosses a clip edge or a mask edge, keep the visible bits
const inRing = (x, y, r) => { let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  } return c; };
const inBox = (x, y, b) => x >= b[0] - 1e-3 && y >= b[1] - 1e-3 && x <= b[2] + 1e-3 && y <= b[3] + 1e-3;
const inMask = (x, y, m) => {
  if (m.clip && !inBox(x, y, m.clip)) return false;
  if (m.evenOdd) { let k = 0; for (const r of m.rings) if (inRing(x, y, r)) k++; return k % 2 === 1; }
  for (const r of m.rings) if (inRing(x, y, r)) return true;
  return false;
};
const boxRing = b => [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]];
function crossings(p, q, ring, ts) {                 // segment-parameter t of every crossing with a ring's edges
  const dx = q[0] - p[0], dy = q[1] - p[1];
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i], b = ring[i + 1], ex = b[0] - a[0], ey = b[1] - a[1], den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((a[0] - p[0]) * ey - (a[1] - p[1]) * ex) / den, u = ((a[0] - p[0]) * dy - (a[1] - p[1]) * dx) / den;
    if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
  }
}
/** Pieces of a polyline that stay visible; `hidden(x, y)` says whether a point is cut away. */
export function keepVisible(pts, hidden, edges) {
  const pieces = []; let cur = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i], q = pts[i + 1], ts = [0, 1];
    for (const r of edges) crossings(p, q, r, ts);
    ts.sort((x, y) => x - y);
    for (let k = 0; k < ts.length - 1; k++) {
      const t0 = ts[k], t1 = ts[k + 1]; if (t1 - t0 < 1e-9) continue;
      const tm = (t0 + t1) / 2, at = t => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
      const mid = at(tm);
      if (hidden(mid[0], mid[1])) { if (cur) { if (cur.length >= 2) pieces.push(cur); cur = null; } continue; }
      const a = at(t0), b = at(t1);
      if (!cur) cur = [a]; else if (!near(cur[cur.length - 1], a)) { if (cur.length >= 2) pieces.push(cur); cur = [a]; }
      cur.push(b);
    }
  }
  if (cur && cur.length >= 2) pieces.push(cur);
  return pieces;
}
const polyLen = pts => { let s = 0; for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return s; };
function samples(pts, n) {                           // n points evenly spaced along a polyline
  const L = polyLen(pts), out = []; let i = 0, acc = 0;
  for (let k = 0; k < n; k++) {
    const d = L * k / (n - 1);
    while (i < pts.length - 2 && acc + Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) < d) { acc += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); i++; }
    const p = pts[i], q = pts[i + 1], sl = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1, t = Math.min(1, Math.max(0, (d - acc) / sl));
    out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
  }
  return out;
}

async function inkMap(page, PW, PH) {
  // grey render of the page (dark pixels = ink), 3x3 dilated; capped at 16 Mpx so every browser can draw it
  const Z = Math.min(4, 8000 / Math.max(PW, PH), Math.sqrt(16e6 / (PW * PH)));
  const vp = page.getViewport({ scale: Z }), W = Math.ceil(vp.width), H = Math.ceil(vp.height);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  await page.render({ canvasContext: ctx, viewport: vp, annotationMode: AnnotationMode.DISABLE }).promise;
  const d = ctx.getImageData(0, 0, W, H).data, a = new Uint8Array(W * H), b = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) a[i] = 0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2] < 253 ? 1 : 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; b[i] = a[i] | (y > 0 && a[i - W]) | (y < H - 1 && a[i + W]); }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; a[i] = b[i] | (x > 0 && b[i - 1]) | (x < W - 1 && b[i + 1]); }
  return { Z, W, H, ink: a };
}

class Grid {                                           // bucket boxes so lookups only test what's nearby
  constructor(bounds, n = 64) { this.b = bounds; this.n = n; this.cells = new Map();
    this.sx = n / Math.max(1e-9, bounds[2] - bounds[0]); this.sy = n / Math.max(1e-9, bounds[3] - bounds[1]); }
  range(b) { const n = this.n, c = v => Math.max(0, Math.min(n - 1, Math.floor(v)));
    return [c((b[0] - this.b[0]) * this.sx), c((b[1] - this.b[1]) * this.sy), c((b[2] - this.b[0]) * this.sx), c((b[3] - this.b[1]) * this.sy)]; }
  add(b, item) { const [i0, j0, i1, j1] = this.range(b);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const k = i * this.n + j; (this.cells.get(k) || this.cells.set(k, []).get(k)).push(item); } }
  query(b) { const [i0, j0, i1, j1] = this.range(b), out = new Set();
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (const it of this.cells.get(i * this.n + j) || []) out.add(it); return out; }
}

/**
 * Read page 1 of a PDF (ArrayBuffer). onStep(fraction, label) reports progress.
 * Returns { name, PW, PH, pages, paths: [{pts, w, col, fill, closed, layer}], styles, layers, clip, zoom, size,
 *           previewUrl, warnings, pathStyle: Int32Array, pathLayer: Int32Array, pick(x, y, r) }.
 */
export async function readPdf(buf, onStep = () => {}) {
  const T = {}, t0 = performance.now(), lap = k => { T[k] = Math.round(performance.now() - t0); };
  onStep(0.02, 'Opening the PDF');
  const pdf = await pdfjs.getDocument({ data: buf, isEvalSupported: false }).promise;
  const page = await pdf.getPage(1), vp1 = page.getViewport({ scale: 1 });
  const PW = vp1.width, PH = vp1.height;
  const occ = await pdf.getOptionalContentConfig();
  const ocName = id => { try { return id ? occ.getGroup(id)?.name : null; } catch { return null; } };
  onStep(0.08, 'Reading vector data');
  const ops = await page.getOperatorList({ annotationMode: AnnotationMode.DISABLE });
  onStep(0.45, 'Reading vector data');
  lap('operators'); const { paths, masks } = walk(ops, vp1.transform, ocName); lap('walk');

  // cut away what clip windows and later white masks hide; untouched paths are kept exactly as they were
  const grid = masks.length ? new Grid([0, 0, PW, PH]) : null;
  masks.forEach(m => m.bbox[2] >= m.bbox[0] && m.bbox[3] >= m.bbox[1] && grid.add(m.bbox, m));
  let ink = null; const vis = [];
  for (let k = 0; k < paths.length; k++) {
    const pause = breathe(); if (pause) { onStep(0.45 + 0.3 * k / paths.length, 'Checking what’s visible'); await pause; }
    const p = paths[k], bb = bboxOf(p.pts), sc = p.sc;
    const outside = sc && !(bb[0] >= sc[0] - 1e-3 && bb[1] >= sc[1] - 1e-3 && bb[2] <= sc[2] + 1e-3 && bb[3] <= sc[3] + 1e-3);
    const hit = grid ? [...grid.query(bb)].filter(m => m.seq > p.seq && m.bbox[0] <= bb[2] && m.bbox[2] >= bb[0] && m.bbox[1] <= bb[3] && m.bbox[3] >= bb[1]) : [];
    if (!outside && !hit.length) { vis.push(p); continue; }
    const hidden = (x, y) => (sc && !inBox(x, y, sc)) || hit.some(m => inMask(x, y, m));
    const edges = [...(sc ? [boxRing(sc)] : []), ...hit.flatMap(m => [...m.rings, ...(m.clip ? [boxRing(m.clip)] : [])])];
    const pieces = keepVisible(p.pts, hidden, edges);
    if (pieces.length === 1 && pieces[0].length === p.pts.length && pieces[0].every((q, i) => near(q, p.pts[i]))) { vis.push(p); continue; }
    // 'visible' if most of the removed part still has ink on the page (the mask didn't really hide it)
    if (!ink) { const a = performance.now(); ink = await inkMap(page, PW, PH); T.inkRender = Math.round(performance.now() - a); }
    const n = Math.max(2, Math.floor(polyLen(p.pts) * ink.Z / 1.5)); let gone = 0, inked = 0;
    for (const [x, y] of samples(p.pts, n)) {
      if (!hidden(x, y)) continue; gone++;
      const X = Math.floor(x * ink.Z), Y = Math.floor(y * ink.Z);
      if (X >= 0 && Y >= 0 && X < ink.W && Y < ink.H && ink.ink[Y * ink.W + X]) inked++;
    }
    if (!gone || inked / gone >= 0.5) { vis.push(p); continue; }
    for (const c of pieces) vis.push({ ...p, pts: c, closed: false });
  }
  lap('cuts'); onStep(0.78, 'Sorting line styles and layers');
  // drop what can't be seen or picked usefully: page-wide horizontal rules, white masks, invisible white lines
  const keep = vis.filter(p => {
    const [x0, y0, x1, y1] = bboxOf(p.pts);
    if (x1 - x0 > 0.95 * PW && y1 - y0 < 1) return false;
    if (WHITE(p.fill) && !(p.col && p.w > 0 && !WHITE(p.col))) return false;
    if ((WHITE(p.col) || !p.col) && !p.fill) return false;   // white or colourless (transparent) line: nothing to see
    return true;
  });
  for (const p of keep) { if (WHITE(p.fill)) p.fill = null; delete p.sc; delete p.seq; }
  if (!keep.length) throw new Error('No vector data in this PDF. It looks like a scan or an image. Ask for a PDF exported from CAD or Vectorworks.');

  // groups to pick from: line styles (always) and PDF layers (when the PDF has them), most paths first
  const sCount = new Map(), lCount = new Map();
  for (const p of keep) { const k = styleKey(p); sCount.set(k, (sCount.get(k) || 0) + 1); if (p.layer) lCount.set(p.layer, (lCount.get(p.layer) || 0) + 1); }
  const sOrder = [...sCount].sort((a, b) => b[1] - a[1]).map(e => e[0]);
  const lOrder = [...lCount.keys()].sort((a, b) => lCount.get(b) - lCount.get(a) || (a < b ? -1 : a > b ? 1 : 0));
  const sId = new Map(sOrder.map((k, i) => [k, i])), lId = new Map(lOrder.map((l, i) => [l, i]));
  const styles = sOrder.map((k, i) => { const p = keep.find(q => styleKey(q) === k);
    return { id: `s${i}`, key: k, n: sCount.get(k), width: r3(p.w), color: hexcol(p.col), filled: !!p.fill }; });
  const layers = lOrder.map((l, i) => ({ id: `l${i}`, name: l, n: lCount.get(l) }));
  const pathStyle = Int32Array.from(keep, p => sId.get(styleKey(p))), pathLayer = Int32Array.from(keep, p => p.layer ? lId.get(p.layer) : -1);

  // plan preview: the drawn area plus 5 pt, longest side 2400 px
  lap('groups'); onStep(0.85, 'Drawing the preview');
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of keep) { const b = bboxOf(p.pts); x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); }
  x0 = Math.max(Math.floor(x0 - 5), 0); y0 = Math.max(Math.floor(y0 - 5), 0); x1 = Math.min(Math.ceil(x1 + 5), PW); y1 = Math.min(Math.ceil(y1 + 5), PH);
  const zoom = 2400 / Math.max(x1 - x0, y1 - y0), W = Math.round((x1 - x0) * zoom), H = Math.round((y1 - y0) * zoom);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: zoom, offsetX: -x0 * zoom, offsetY: -y0 * zoom }), annotationMode: AnnotationMode.DISABLE }).promise;
  const previewUrl = URL.createObjectURL(await new Promise(r => cv.toBlob(r, 'image/png')));

  // nearest line to a click: segments bucketed in a grid
  lap('preview'); const segGrid = new Grid([x0, y0, x1, y1], 128);
  keep.forEach((p, i) => { for (let k = 0; k < p.pts.length - 1; k++) { const a = p.pts[k], b = p.pts[k + 1];
    segGrid.add([Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])], i * 65536 + Math.min(k, 65535)); } });
  const pick = (x, y, r) => {
    let best = -1, bd = Math.max(r, 0.5);
    for (const code of segGrid.query([x - bd, y - bd, x + bd, y + bd])) {
      const i = Math.floor(code / 65536), k = code % 65536, a = keep[i].pts[k], b = keep[i].pts[k + 1];
      const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy, t = L ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L)) : 0;
      const d = Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy); if (d <= bd) { bd = d; best = i; }
    }
    return best < 0 ? null : { style: `s${pathStyle[best]}`, layer: pathLayer[best] >= 0 ? `l${pathLayer[best]}` : null };
  };
  lap('pick index'); onStep(1, 'Ready');
  const warnings = pdf.numPages > 1 ? [`This PDF has ${pdf.numPages} pages. Only page 1 is used.`] : [];
  pdf.destroy();
  return { timing: T, masks: masks.length, PW, PH, paths: keep, styles, layers, clip: [x0, y0, x1, y1], zoom, size: [W, H], previewUrl, warnings, pathStyle, pathLayer, pick };
}
