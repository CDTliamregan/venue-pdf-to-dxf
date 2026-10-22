// The page: upload a vector PDF, pick layers or line styles on the plan, crop / erase, export a DXF.
// Everything runs in the browser (reader.js reads the PDF, export.js writes the DXF); nothing is uploaded anywhere.
import { readPdf } from './reader.js';
import { pickedLines, writeDxf, previewDxf } from './export.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let meta = null, name = 'venue', tool = 'pick', zoom = 1, hoverGid = null, busy = false;
const st = { sel: new Set(), crop: null, erase: [] };
const lines = {};                        // gid -> svg path data (built on demand)
const urls = [];                         // object URLs to free when a new PDF comes in
const keepUrl = u => (urls.push(u), u);
const tick = () => new Promise(r => setTimeout(r, 30));   // let the progress bar repaint

// ---------------- upload
const drop = $('drop');
['dragover', 'dragenter'].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(e => drop.addEventListener(e, () => drop.classList.remove('over')));
drop.addEventListener('drop', ev => { ev.preventDefault(); if (ev.dataTransfer.files[0]) upload(ev.dataTransfer.files[0]); });
$('pdf').addEventListener('change', e => e.target.files[0] && upload(e.target.files[0]));
$('change').onclick = () => { ['s2', 's3', 's4', 'filebar'].forEach(s => $(s).classList.add('hidden')); closeOverlay(); $('s1').classList.remove('hidden'); $('pdf').value = ''; $('upmsg').innerHTML = ''; };
const openOverlay = () => $('ov').classList.remove('hidden'), closeOverlay = () => $('ov').classList.add('hidden');
$('ovclose').onclick = closeOverlay;
$('ov').addEventListener('mousedown', ev => { if (ev.target === $('ov')) closeOverlay(); });

function problem(e) { console.error(e); $('apimsg').innerHTML = `<div class="msg err">${esc(e.message || e)}</div>`; }

async function upload(file) {
  if (!/\.pdf$/i.test(file.name)) { $('upmsg').innerHTML = `<div class="msg err">${esc(file.name)} isn’t a PDF.</div>`; return; }
  if (busy) return; busy = true;
  ['s2', 's3', 's4'].forEach(s => $(s).classList.add('hidden')); closeOverlay(); $('apimsg').innerHTML = '';
  $('upmsg').innerHTML = `<div class="upprog"><div class="row"><span><span class="lbl">Opening</span>… <span class="fn">${esc(file.name)}</span></span><span class="pct">0%</span></div>`
    + `<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"><div></div></div></div>`;
  const U = $('upmsg'), show = (f, label) => {
    const p = 100 * f; U.querySelector('.bar > div').style.width = p + '%'; U.querySelector('.bar').setAttribute('aria-valuenow', Math.floor(p));
    U.querySelector('.pct').textContent = Math.floor(p) + '%'; if (label) U.querySelector('.lbl').textContent = label;
  };
  drop.classList.add('busy');
  let doc;
  try { doc = await readPdf(await file.arrayBuffer(), show); }
  catch (e) {
    const msg = e?.name === 'InvalidPDFException' ? 'That file couldn’t be opened as a PDF.'
      : e?.name === 'PasswordException' ? 'This PDF is password protected. Export it again without a password.'
      : e?.message || 'Couldn’t read the vector data in this PDF.';
    console.error(e); $('upmsg').innerHTML = `<div class="msg err">${esc(msg)}</div>`; return;
  } finally { drop.classList.remove('busy'); busy = false; }
  await new Promise(res => setTimeout(res, 250));
  while (urls.length) URL.revokeObjectURL(urls.pop());
  keepUrl(doc.previewUrl);
  meta = doc; name = file.name.replace(/\.pdf$/i, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'venue';
  for (const k in lines) delete lines[k];
  Object.assign(st, { sel: new Set(), crop: null, erase: [] });
  meta.groups = {}; for (const s of doc.styles) meta.groups[s.id] = s; for (const l of doc.layers) meta.groups[l.id] = l;
  $('upmsg').innerHTML = ''; $('s1').classList.add('hidden');
  $('fname').textContent = `${file.name} · ${doc.paths.length.toLocaleString()} line${doc.paths.length === 1 ? '' : 's'}`; $('filebar').classList.remove('hidden');
  $('upwarn').innerHTML = doc.warnings.map(w => `<div class="msg warn">${esc(w)}</div>`).join('');
  $('marks').setAttribute('viewBox', `0 0 ${doc.size[0]} ${doc.size[1]}`);
  $('layerbox').classList.toggle('hidden', !doc.layers.length); $('lsearch').value = '';
  $('dim').checked = false;
  renderLists(); $('s2').classList.remove('hidden'); setTool('pick');
  $('preview').onload = () => setZoom(1, true);
  $('preview').src = doc.previewUrl;
  update();
}

// ---------------- lists
const swatch = s => s.filled ? `<i style="height:11px;background:${s.color || '#888'}"></i>` : `<i style="background:${s.color || '#000'};height:${Math.max(1, Math.min(6, s.width * 4))}px"></i>`;
// a fill's stroke width only matters when it also has an outline
const gname = g => g.name !== undefined ? g.name
  : g.filled ? ['Fill', g.width && g.color && `${g.width} pt outline`, g.color].filter(Boolean).join(' · ')
  : `${g.width} pt · ${g.color || 'no colour'}`;
function renderLists() {
  const q = $('lsearch').value.trim().toLowerCase();
  const item = (g, inner) => `<label class="${st.sel.has(g.id) ? 'sel' : ''}" data-gid="${g.id}"><input type="checkbox" ${st.sel.has(g.id) ? 'checked' : ''}>${inner}<span class="n">${g.n.toLocaleString()}</span></label>`;
  $('layers').innerHTML = meta.layers.filter(l => !q || l.name.toLowerCase().includes(q)).map(l => item(l, `<span class="nm" title="${esc(l.name)}">${esc(l.name)}</span>`)).join('');
  $('styles').innerHTML = meta.styles.map(s => item(s, `<span class="sw">${swatch(s)}</span><span class="nm">${esc(gname(s))}</span>`)).join('');
  $('lcount').textContent = meta.layers.length ? `${meta.layers.length}` : ''; $('scount').textContent = `${meta.styles.length}`;
  document.querySelectorAll('.list label').forEach(el => {
    const gid = el.dataset.gid;
    el.querySelector('input').addEventListener('change', e => toggle(gid, e.target.checked));
    el.addEventListener('mouseenter', () => { hoverGid = gid; need(gid).then(update); });
    el.addEventListener('mouseleave', () => { if (hoverGid === gid) { hoverGid = null; update(); } });
  });
}
$('lsearch').addEventListener('input', renderLists);
function toggle(gid, on) { on ? st.sel.add(gid) : st.sel.delete(gid); need(gid).then(update); renderLists(); update(); }
// simplified polylines of one group (s<n> = line style, l<n> = PDF layer), for highlighting on the plan
function simplify(pts, tol) {                     // Douglas-Peucker
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1; const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop(), [ax, ay] = pts[i], [bx, by] = pts[j], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
    let best = -1, bd = tol;
    for (let k = i + 1; k < j; k++) { const [x, y] = pts[k], d = L ? Math.abs(dy * (x - ax) - dx * (y - ay)) / L : Math.hypot(x - ax, y - ay); if (d > bd) { bd = d; best = k; } }
    if (best >= 0) { keep[best] = 1; stack.push([i, best], [best, j]); }
  }
  return pts.filter((_, k) => keep[k]);
}
async function need(gid) {
  if (lines[gid]) return;
  const kind = gid[0], n = +gid.slice(1), idx = kind === 's' ? meta.pathStyle : meta.pathLayer, out = [];
  meta.paths.forEach((p, i) => {
    if (idx[i] !== n || p.pts.length < 2) return;
    const q = p.pts.length > 4 ? simplify(p.pts, 0.15) : p.pts;
    out.push('M' + q.map(([x, y]) => toPx(x, y).map(v => v.toFixed(1)).join(' ')).join('L'));
  });
  lines[gid] = out.join('');
}

// ---------------- coordinates (PDF points, y down) <-> preview pixels
const toPx = (x, y) => [(x - meta.clip[0]) * meta.zoom, (y - meta.clip[1]) * meta.zoom];
function evPt(ev) {
  const img = $('preview'), b = img.getBoundingClientRect();
  const px = (ev.clientX - b.left) * img.naturalWidth / b.width, py = (ev.clientY - b.top) * img.naturalHeight / b.height;
  return [meta.clip[0] + px / meta.zoom, meta.clip[1] + py / meta.zoom];
}
const ptPerScreenPx = () => { const img = $('preview'); return img.naturalWidth / img.getBoundingClientRect().width / meta.zoom; };

// ---------------- zoom (wheel around the pointer, buttons, keys) and pan
const V = $('viewer');
function setZoom(z, fit, cx, cy) {
  const P = $('plan'); cx = cx ?? V.clientWidth / 2; cy = cy ?? V.clientHeight / 2;
  const fx = (V.scrollLeft + cx - P.offsetLeft) / P.offsetWidth, fy = (V.scrollTop + cy - P.offsetTop) / P.offsetHeight;
  if (fit) {                                           // fit the whole sheet in the viewer
    const img = $('preview'); const ar = img.naturalHeight / img.naturalWidth || 1;
    z = Math.min(1, (V.clientHeight - 4) / (V.clientWidth * ar));
  }
  zoom = Math.max(0.2, Math.min(24, z)); P.style.width = (zoom * 100) + '%';
  if (!fit) { V.scrollLeft = P.offsetLeft + fx * P.offsetWidth - cx; V.scrollTop = P.offsetTop + fy * P.offsetHeight - cy; } else { V.scrollLeft = 0; V.scrollTop = 0; }
  $('zoomv').textContent = Math.round(zoom * 100) + '%';
}
V.addEventListener('wheel', ev => {
  if (!meta) return; ev.preventDefault(); const b = V.getBoundingClientRect();
  setZoom(zoom * Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0018)), false, ev.clientX - b.left, ev.clientY - b.top);
}, { passive: false });
$('zin').onclick = () => setZoom(zoom * 1.4); $('zout').onclick = () => setZoom(zoom / 1.4); $('zfit').onclick = () => setZoom(1, true);

// ---------------- tools
const HINTS = {
  pick: 'Click a line to grab its whole layer (or its line style if the PDF has no layers). Click again to drop it. Drag to move around, scroll to zoom.',
  pan: 'Drag to move around. Scroll to zoom.',
  crop: 'Draw a box around the venue. Anything outside it (title block, notes, logos) gets left out.',
  erase: 'Draw boxes over anything you don’t want: booths, seating, staging, furniture. Add as many as you like.',
};
document.querySelectorAll('[data-tool]').forEach(b => b.onclick = () => setTool(b.dataset.tool));
function setTool(t) {
  tool = t; document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  V.classList.toggle('pick', t === 'pick'); V.classList.toggle('pan', t === 'pan'); V.classList.toggle('box', t === 'crop' || t === 'erase');
  $('hint').textContent = HINTS[t]; update();
}
let space = false;
window.addEventListener('keydown', ev => {
  if (!$('ov').classList.contains('hidden')) { if (ev.key === 'Escape') closeOverlay(); return; }
  if (!meta || $('s2').classList.contains('hidden') || ev.target.tagName === 'INPUT') return;
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'z') { ev.preventDefault(); if (st.erase.length) { st.erase.pop(); update(); flash('Undid the last erase box.'); } return; }
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.code === 'Space') { space = true; V.classList.add('pan'); ev.preventDefault(); }
  const k = ev.key.toLowerCase();
  if (k === '+' || k === '=') setZoom(zoom * 1.4); if (k === '-') setZoom(zoom / 1.4); if (k === '0') setZoom(1, true);
  if (k === 'p') setTool('pick'); if (k === 'h') setTool('pan'); if (k === 'c') setTool('crop'); if (k === 'e') setTool('erase');
  if (k === 'escape') setTool('pick');
});
window.addEventListener('keyup', ev => { if (ev.code === 'Space') { space = false; V.classList.toggle('pan', tool === 'pan'); } });

let drag = null;   // {mode: 'pan'|'box'|'click', x, y, sl, st, a, b}; in Select a press is a 'click' until it moves, then it pans
V.addEventListener('mousedown', ev => {
  if (!meta || ev.button > 1) return; ev.preventDefault();
  const panning = tool === 'pan' || space || ev.button === 1;
  drag = { mode: panning ? 'pan' : tool === 'pick' ? 'click' : 'box', x: ev.clientX, y: ev.clientY, sl: V.scrollLeft, st: V.scrollTop, a: evPt(ev), b: null };
  if (panning) V.classList.add('panning');
});
window.addEventListener('mousemove', ev => {
  if (!drag) return;
  if (drag.mode === 'click' && Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) > 5) { drag.mode = 'pan'; V.classList.add('panning'); }
  if (drag.mode === 'pan') { V.scrollLeft = drag.sl - (ev.clientX - drag.x); V.scrollTop = drag.st - (ev.clientY - drag.y); return; }
  if (tool === 'crop' || tool === 'erase') { drag.b = evPt(ev); update(); }
});
window.addEventListener('mouseup', async ev => {
  if (!drag) return; const d = drag; drag = null; V.classList.remove('panning');
  if (d.mode === 'pan') return;
  const b = evPt(ev), moved = Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > 5;
  if ((tool === 'crop' || tool === 'erase') && moved) {
    const r = [Math.min(d.a[0], b[0]), Math.min(d.a[1], b[1]), Math.max(d.a[0], b[0]), Math.max(d.a[1], b[1])].map(v => +v.toFixed(2));
    tool === 'crop' ? st.crop = r : st.erase.push(r); update(); return;
  }
  if (!moved && tool === 'pick') {
    const j = { hit: meta.pick(d.a[0], d.a[1], 8 * ptPerScreenPx()) };
    if (!j.hit) { flash('Nothing there. Zoom in and click right on a line.'); return; }
    const gid = j.hit.layer && meta.layers.length ? j.hit.layer : j.hit.style;
    toggle(gid, !st.sel.has(gid));
    flash(`${st.sel.has(gid) ? 'Added' : 'Removed'}: ${gname(meta.groups[gid])}`);
    const el = document.querySelector(`.list label[data-gid="${gid}"]`); if (el) el.scrollIntoView({ block: 'nearest' });
  }
});
let flashT = null;
function flash(t) { $('hint').textContent = t; clearTimeout(flashT); flashT = setTimeout(() => { $('hint').textContent = HINTS[tool]; }, 2500); }

$('clearcrop').onclick = () => { st.crop = null; update(); };
$('undoerase').onclick = () => { st.erase.pop(); update(); };
$('clearerase').onclick = () => { st.erase = []; update(); };
$('dim').addEventListener('change', update);

// ---------------- overlay + status
function update() {
  if (!meta) return;
  const W = meta.size[0], H = meta.size[1], svg = [];
  if ($('dim').checked) svg.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#fff" fill-opacity=".8"/>`);
  for (const gid of st.sel) if (lines[gid]) svg.push(`<path d="${lines[gid]}" fill="none" stroke="var(--sel)" stroke-width="2" vector-effect="non-scaling-stroke"/>`);
  if (hoverGid && lines[hoverGid]) svg.push(`<path d="${lines[hoverGid]}" fill="none" stroke="var(--hover)" stroke-width="3" vector-effect="non-scaling-stroke" opacity=".8"/>`);
  const rect = (r, attrs) => { const [x0, y0] = toPx(r[0], r[1]), [x1, y1] = toPx(r[2], r[3]); return `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" ${attrs}/>`; };
  if (st.crop) {
    const [x0, y0] = toPx(st.crop[0], st.crop[1]), [x1, y1] = toPx(st.crop[2], st.crop[3]);
    svg.push(`<path d="M0 0H${W}V${H}H0Z M${x0} ${y0}V${y1}H${x1}V${y0}Z" fill="#000" fill-opacity=".25" fill-rule="evenodd"/>`);
    svg.push(rect(st.crop, `fill="none" stroke="var(--crop)" stroke-width="2" vector-effect="non-scaling-stroke" stroke-dasharray="6 4"`));
  }
  for (const r of st.erase) svg.push(rect(r, `fill="var(--erase)" fill-opacity=".28" stroke="var(--erase)" stroke-width="1.5" vector-effect="non-scaling-stroke"`));
  if (drag && drag.mode === 'box' && drag.b) {
    const r = [Math.min(drag.a[0], drag.b[0]), Math.min(drag.a[1], drag.b[1]), Math.max(drag.a[0], drag.b[0]), Math.max(drag.a[1], drag.b[1])];
    svg.push(rect(r, `fill="none" stroke="${tool === 'crop' ? 'var(--crop)' : 'var(--erase)'}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-dasharray="4 3"`));
  }
  $('marks').innerHTML = svg.join('');
  const nL = [...st.sel].filter(g => g[0] === 'l').length, nS = st.sel.size - nL;
  const paths = [...st.sel].reduce((a, g) => a + meta.groups[g].n, 0);
  $('selsum').innerHTML = st.sel.size
    ? `<span>Exporting <b>${[nL && `${nL} layer${nL > 1 ? 's' : ''}`, nS && `${nS} line style${nS > 1 ? 's' : ''}`].filter(Boolean).join(' + ')}</b> · ${paths.toLocaleString()} lines</span><button class="link" id="clearsel" style="margin-left:auto">Clear</button>`
    : '<span>Nothing picked yet. Click a line on the plan, or tick a layer or style below.</span>';
  if ($('clearsel')) $('clearsel').onclick = () => { st.sel.clear(); renderLists(); update(); };
  const fmt = v => v.toFixed(1);
  $('cropst').textContent = st.crop ? `Crop: ${fmt(st.crop[2] - st.crop[0])} × ${fmt(st.crop[3] - st.crop[1])} pt.` : 'No crop, using the full sheet.';
  $('cropst').classList.toggle('set', !!st.crop);
  $('erasest').textContent = st.erase.length ? `${st.erase.length} erase box${st.erase.length > 1 ? 'es' : ''}.` : 'Nothing erased.';
  $('clearcrop').disabled = !st.crop; $('undoerase').disabled = $('clearerase').disabled = !st.erase.length;
  $('buildmsg').innerHTML = st.sel.size ? '' : '<div class="hint" style="margin:0 0 8px">Pick at least one layer or line style first.</div>';
  $('go').disabled = !st.sel.size;
}

// ---------------- build + progress
const STEPS = ['Writing the DXF', 'Drawing the preview'];
function progress(f, step, state) {
  $('bar').style.width = 100 * f + '%'; $('barwrap').setAttribute('aria-valuenow', Math.floor(100 * f)); $('pct').textContent = Math.floor(100 * f) + '%';
  $('steps').innerHTML = STEPS.map((s, i) => `<li class="${i < step || state === 'done' ? 'done' : i === step && state === 'running' ? 'now' : ''}">${esc(s)}</li>`).join('');
  $('stepname').textContent = state === 'done' ? 'Done' : state === 'error' ? 'Export failed' : STEPS[step] + '…';
}
$('go').onclick = async () => {
  if (!meta || !st.sel.size) return;
  $('go').disabled = true; $('s4').classList.add('hidden'); $('err').innerHTML = ''; $('apimsg').innerHTML = '';
  $('s3').classList.remove('hidden'); openOverlay(); $('ov').querySelector('.sheet').scrollTop = 0;
  let step = 0;
  try {
    progress(0.05, 0, 'running'); await tick();
    const sel = [...st.sel];
    const picked = pickedLines(meta, { styles: sel.filter(g => g[0] === 's'), layers: sel.filter(g => g[0] === 'l'), crop: st.crop, erase: st.erase });
    if (!picked.length) throw new Error('Nothing left to export: the crop and erase boxes cover every picked line.');
    const dxf = writeDxf(picked, meta.PH);
    step = 1; progress(0.6, 1, 'running'); await tick();
    const prev = await previewDxf(dxf);                // drawn from the DXF text itself
    const dl = keepUrl(URL.createObjectURL(new Blob([dxf], { type: 'application/dxf' })));
    $('dl').href = dl; $('dl').setAttribute('download', `${name}_LINES.dxf`);
    $('check').src = keepUrl(prev.url);
    $('summary').innerHTML = `<div class="msg ok">${esc(prev.summary)}. It’s in PDF points, so scale it in Vectorworks.</div>`;
    progress(1, 2, 'done');
    $('s3').classList.add('hidden'); $('s4').classList.remove('hidden'); openOverlay();
  } catch (e) {
    console.error(e); progress(0, step, 'error');
    $('err').innerHTML = `<div class="msg err">${esc(e.message || e)}</div>`;
  } finally { $('go').disabled = !st.sel.size; }
};
$('back').onclick = closeOverlay;
