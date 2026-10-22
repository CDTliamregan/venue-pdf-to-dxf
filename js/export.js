// The picked linework as a DXF: exactly the lines in the chosen layers / line styles, after crop and erase.
// One layer, VENUE_LINES, PDF points, y up. Nothing is filled or cleaned up. A port of the old pipeline/lines_dxf.py
// and preview_dxf.py; the preview is drawn by reading the DXF text back, so it always shows what's in the file.
import { keepVisible } from './reader.js';
import { HEAD, TAIL } from './dxf-template.js';

const boxRing = b => [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]];
const inBox = (x, y, b) => x >= b[0] && y >= b[1] && x <= b[2] && y <= b[3];
const fmt = v => (Math.round(v * 1e6) / 1e6).toString();

/** Polylines to export: [{pts: [[x, y], ...] (PDF points, y down), closed}] */
export function pickedLines(doc, { styles = [], layers = [], crop = null, erase = [] }) {
  const sIdx = new Set(styles.map(id => +id.slice(1))), lIdx = new Set(layers.map(id => +id.slice(1)));
  const edges = [...(crop ? [boxRing(crop)] : []), ...erase.map(boxRing)];
  const hidden = (x, y) => (crop && !inBox(x, y, crop)) || erase.some(b => inBox(x, y, b));
  const out = [];
  doc.paths.forEach((p, i) => {
    if (!(sIdx.has(doc.pathStyle[i]) || (doc.pathLayer[i] >= 0 && lIdx.has(doc.pathLayer[i]))) || p.pts.length < 2) return;
    if (!edges.length) { out.push({ pts: p.pts, closed: p.closed }); return; }
    const pieces = keepVisible(p.pts, hidden, edges);
    const whole = pieces.length === 1 && pieces[0].length === p.pts.length;
    for (const c of pieces) out.push({ pts: c, closed: p.closed && whole });
  });
  return out;
}

/** DXF R2010 text (same layout as ezdxf, which Vectorworks imports): one layer VENUE_LINES (colour 7), closed or open
 *  LWPOLYLINEs, real $EXTMIN / $EXTMAX. */
export function writeDxf(lines, PH) {
  const ents = []; let handle = 0x1000;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const { pts, closed } of lines) {
    let q = pts.map(([x, y]) => [x, PH - y]);
    if (closed && q.length > 2) { const a = q[0], b = q[q.length - 1]; if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) q = q.slice(0, -1); }
    if (q.length < 2) continue;
    ents.push('  0', 'LWPOLYLINE', '  5', (handle++).toString(16).toUpperCase(), '330', '17', '100', 'AcDbEntity', '  8', 'VENUE_LINES',
      ' 62', '7', '100', 'AcDbPolyline', ' 90', String(q.length), ' 70', closed ? '1' : '0');
    for (const [x, y] of q) {
      ents.push(' 10', fmt(x), ' 20', fmt(y));
      if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
    }
  }
  if (!ents.length) { x0 = y0 = x1 = y1 = 0; }
  const head = HEAD.replace('{HANDSEED}', handle.toString(16).toUpperCase())
    .replace('{EXTMIN_X}', fmt(x0)).replace('{EXTMIN_Y}', fmt(y0)).replace('{EXTMAX_X}', fmt(x1)).replace('{EXTMAX_Y}', fmt(y1));
  return head + (ents.length ? ents.join('\n') + '\n' : '') + TAIL;
}

/** Read the LWPOLYLINEs back out of DXF text written above. */
export function readDxf(text) {
  const t = text.split(/\r?\n/), lines = []; let cur = null, inEnt = false, x = 0;
  for (let i = 0; i + 1 < t.length; i += 2) {
    const code = t[i].trim(), v = t[i + 1].trim();
    if (code === '0') { if (cur) lines.push(cur); cur = v === 'LWPOLYLINE' ? { pts: [], closed: false } : null; inEnt = !!cur; }
    else if (inEnt && code === '70') cur.closed = (+v & 1) === 1;
    else if (inEnt && code === '10') x = +v;
    else if (inEnt && code === '20') cur.pts.push([x, +v]);
  }
  if (cur) lines.push(cur);
  return lines;
}

/** PNG preview of the DXF's lines: thin black on white, y up, longest side 2400 px. Returns {url, summary}. */
export async function previewDxf(text) {
  const lines = readDxf(text).filter(l => l.pts.length >= 2);
  if (!lines.length) throw new Error('The DXF has no lines.');
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of lines) for (const [x, y] of l.pts) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  const M = 0.02 * Math.max(x1 - x0, y1 - y0), Z = 2400 / (Math.max(x1 - x0, y1 - y0) + 2 * M);
  const cv = document.createElement('canvas'); cv.width = Math.round((x1 - x0 + 2 * M) * Z); cv.height = Math.round((y1 - y0 + 2 * M) * Z);
  const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.beginPath();
  for (const l of lines) {
    l.pts.forEach(([x, y], k) => { const X = (x - x0 + M) * Z, Y = (y1 + M - y) * Z; k ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
    if (l.closed) ctx.closePath();
  }
  ctx.stroke();
  const url = URL.createObjectURL(await new Promise(r => cv.toBlob(r, 'image/png')));
  const n = lines.length, c = lines.filter(l => l.closed).length;
  return { url, summary: `${n.toLocaleString()} line${n === 1 ? '' : 's'}, ${c.toLocaleString()} closed` };
}
