(() => {
'use strict';
const {request, asRequestError, toast, fmt, labelCells, busy} = window.E1;
const $ = s => document.querySelector(s);
const PAGE = 10, LANES = 4, KNOWN_BATCH = 1000;
const IMAGE = /\.(png|jpe?g|webp|gif|bmp|heic|heif)$/i;
const JUNK = /(^|\/)(__MACOSX|\.[^/]+)(\/|$)/;
const SLOT_WORD = ['first', 'second'];
const where = slots => slots.map(i => SLOT_WORD[i]).join(' or ');
const COUNTS = ['files', 'duplicate', 'not_enhypen', 'not_partner', 'manual', 'rejected'];
const TILES = [['valid', 'Valid proofs', 'primary'], ['files', 'Files received'], ['duplicate', 'Duplicates'], ['not_enhypen', 'Not ENHYPEN'],
  ['not_partner', 'Wrong partner image'], ['manual', 'To review'], ['rejected', 'Rejected']];
let data = {submissions: [], refs: [], collabs: []}, offset = 0, running = false, stopping = false;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
const chip = (cls, text) => el('span', `chip ${cls}`, text);
const localToday = () => new Date().toLocaleDateString('en-CA');
// busy(button, false) only restores the label: the button must be re-enabled here.
function release(button) { busy(button, false); button.disabled = false; }
function fail(error) { const e = asRequestError(error); toast('error', e.title, e.message); }

// ---------------------------------------------------------------- tabs
const tabs = [...document.querySelectorAll('[role="tab"]')];
function activate() {
  const hash = location.hash.slice(1);
  const selected = tabs.some(t => t.dataset.tab === hash) ? hash : 'setup';
  tabs.forEach(tab => {
    const active = tab.dataset.tab === selected;
    tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
    document.getElementById(tab.getAttribute('aria-controls')).hidden = !active;
    if (active) tab.scrollIntoView({block: 'nearest', inline: 'nearest'});
  });
}
tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => { location.hash = tab.dataset.tab; });
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].focus(); tabs[next].click();
  });
});
addEventListener('hashchange', activate);

// ---------------------------------------------------------------- file pickers
function bindPicker(input, note, empty, describe) {
  const refresh = () => {
    const text = input.files.length ? describe([...input.files]) : empty;
    note.textContent = text; input.closest('.picker').classList.toggle('has-files', input.files.length > 0 && text !== empty);
  };
  input.addEventListener('change', refresh);
  return refresh;
}
const imagesIn = files => files.filter(f => IMAGE.test(f.name) && !JUNK.test(f.webkitRelativePath || f.name));
const refreshFolder = bindPicker($('#folder'), $('#folder-note'), 'No folder selected', files => {
  const n = imagesIn(files).length, root = (files[0].webkitRelativePath || '').split('/')[0];
  return n ? `${fmt(n)} images in “${root}”` : `No images found in “${root}”`;
});
const refreshFiles = bindPicker($('#files'), $('#files-note'), 'No images selected', files => {
  const n = imagesIn(files).length; return n ? `${fmt(n)} image${n === 1 ? '' : 's'} selected` : 'No images selected';
});

// ---------------------------------------------------------------- data
async function loadSummary() {
  data = await request('/api/collab/summary');
  $('#ocr-banner').hidden = data.ocr_available;
  renderRefs(data.refs);
  renderCollabs(data.collabs);
  renderRecap();
}

function sumCounts(rows) {
  const total = {valid: 0, files: 0, duplicate: 0, not_enhypen: 0, not_partner: 0, manual: 0, rejected: 0};
  for (const s of rows) for (const k of Object.keys(total)) total[k] += s[k];
  return total;
}

// ---------------------------------------------------------------- recap
// A private link to the report of one batch: the requester sees the numbers and the doubtful and rejected proofs, and can approve or reject them.
const reportUrl = token => `${location.origin}/report/${token}`;
async function copyLink(text) {
  try { await navigator.clipboard.writeText(text); toast('success', 'Link copied', 'Send it to whoever sent this batch.'); }
  catch { prompt('Copy this link', text); }
}
function runCell(s) {
  const td = el('td', 'run-actions');
  const csv = (label, kind) => { const b = el('button', 'btn-ghost', label); b.type = 'button'; b.addEventListener('click', () => { location.href = `/api/collab/export.csv?kind=${kind}&run=${s.id}`; }); return b; };
  const card = el('button', 'btn-ghost', 'Card'); card.type = 'button';
  card.setAttribute('aria-label', `Download the share card of ${s.fandom}, ${s.day}`);
  card.addEventListener('click', () => downloadCard(s, card));
  td.append(card, ' ', csv('Stats CSV', 'stats'), ' ', csv('Report CSV', 'full'), ' ', shareCell(s));
  return td;
}
function shareCell(s) {
  const td = el('span');
  const main = el('button', 'btn-ghost', s.share_token ? 'Copy link' : 'Make link'); main.type = 'button';
  main.addEventListener('click', async () => {
    main.disabled = true;
    try {
      const token = s.share_token || (await request(`/api/collab/submissions/${s.id}/share`, {})).token;
      await copyLink(reportUrl(token)); if (!s.share_token) await loadSummary();
    } catch (e) { fail(e); } finally { main.disabled = false; }
  });
  td.append(main);
  if (s.share_token) {
    const stop = el('button', 'btn-ghost', 'Stop sharing'); stop.type = 'button';
    stop.addEventListener('click', async () => {
      if (!confirm(`Stop sharing the report of ${s.fandom} (${s.day})? The link stops working at once.`)) return;
      try { await request(`/api/collab/submissions/${s.id}/share/revoke`, {}); await loadSummary(); } catch (e) { fail(e); }
    });
    td.append(' ', stop);
  }
  return td;
}

function renderRecap() {
  const select = $('#recap-day'), previous = select.value;
  const days = [...new Set(data.submissions.map(s => s.day))].sort().reverse();
  select.replaceChildren(new Option('All dates', ''), ...days.map(d => new Option(d, d)));
  select.value = days.includes(previous) ? previous : '';
  const rows = data.submissions.filter(s => !select.value || s.day === select.value);
  const total = sumCounts(rows);
  const tiles = $('#tiles'); tiles.replaceChildren();
  for (const [key, label, extra] of TILES) {
    const tile = el('div', `tile${extra ? ' ' + extra : ''}`); tile.append(el('strong', null, fmt(total[key])), el('span', null, label)); tiles.append(tile);
  }
  const body = $('#summary-body'); body.replaceChildren();
  for (const s of rows) {
    const tr = el('tr');
    tr.append(el('td', null, s.fandom));
    const valid = el('td', 'num'); valid.append(el('strong', null, fmt(s.valid))); tr.append(valid);
    tr.append(el('td', null, s.day));
    for (const k of COUNTS) tr.append(el('td', 'num', fmt(s[k])));
    tr.append(runCell(s));
    body.append(tr);
  }
  if (!rows.length) {
    const tr = el('tr'); const td = el('td', 'muted', 'No proofs uploaded yet.'); td.colSpan = 10; tr.append(td); body.append(tr);
  } else {
    const tr = el('tr', 'total'); tr.append(el('td', null, 'Total'), el('td', 'num', fmt(total.valid)), el('td'));
    for (const k of COUNTS) tr.append(el('td', 'num', fmt(total[k])));
    tr.append(el('td'));
    body.append(tr);
  }
  labelCells($('#summary-table'));
}
$('#recap-day').addEventListener('change', renderRecap);
const exportUrl = kind => `/api/collab/export.csv?kind=${kind}&day=${encodeURIComponent($('#recap-day').value)}`;
$('#csv-summary').addEventListener('click', () => { location.href = exportUrl('summary'); });
$('#csv-full').addEventListener('click', () => { location.href = exportUrl('full'); });

// ---------------------------------------------------------------- share cards (one image per collab)
const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const MAX_DAYS = 6;
const logo = new Image(); logo.src = '/e1-logo.png';
const logoReady = new Promise(resolve => { logo.onload = logo.onerror = resolve; });
const niceDay = d => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', {day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'}).toUpperCase();


async function downloadCard(s, button) {
  busy(button, true, 'Creating…');
  try {
    await logoReady;
    const blob = await new Promise((resolve, reject) => drawCard({fandom: s.fandom, valid: s.valid, days: [{day: s.day, valid: s.valid}]}, s.day)
      .toBlob(b => b ? resolve(b) : reject(new Error('The browser could not create the image')), 'image/png'));
    const link = el('a'); link.href = URL.createObjectURL(blob);
    link.download = `enhypen-proofs-${slugOf(s.fandom)}-${s.day}.png`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  } catch (e) { fail(e); }
  finally { release(button); }
}
const slugOf = name => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'collab';

function fitText(ctx, text, width, size, weight) {
  let s = size; ctx.font = `${weight} ${s}px ${SANS}`;
  while (ctx.measureText(text).width > width && s > size * 0.55) { s -= 1; ctx.font = `${weight} ${s}px ${SANS}`; }
  let t = text;
  while (t.length > 1 && ctx.measureText(t).width > width) t = t.slice(0, -1);
  return t === text ? t : `${t}…`;
}
const spaced = (ctx, px) => { if ('letterSpacing' in ctx) ctx.letterSpacing = `${px}px`; };

function drawCard(r, day) {
  const W = 1080, PAD = 84, shown = r.days.slice(-MAX_DAYS), list = !day && r.days.length > 1;
  const H = 1080 + (list ? shown.length * 52 + 40 : 0), scale = 2;
  const canvas = document.createElement('canvas'); canvas.width = W * scale; canvas.height = H * scale;
  const ctx = canvas.getContext('2d'); ctx.scale(scale, scale); ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#0a0a0c'; ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W, 0, 0, W, 0, 900); glow.addColorStop(0, 'rgba(255,122,26,0.26)'); glow.addColorStop(1, 'rgba(255,122,26,0)');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#ff7a1a'; ctx.fillRect(0, 0, W, 12);
  if (logo.naturalWidth) ctx.drawImage(logo, PAD, 70, 130, 130 * logo.naturalHeight / logo.naturalWidth);
  ctx.textAlign = 'left'; ctx.fillStyle = '#ff7a1a'; ctx.font = `700 26px ${SANS}`; spaced(ctx, 5);
  ctx.fillText('MAMA 2026 · VOTING PROOFS', PAD, 330); spaced(ctx, 0);
  ctx.fillStyle = '#f2f2f4'; ctx.fillText(fitText(ctx, r.fandom, W - 2 * PAD, 76, 800), PAD, 420);
  ctx.fillStyle = '#a3a3ad'; ctx.font = `600 40px ${SANS}`; ctx.fillText('× ENHYPEN', PAD, 482);
  ctx.font = `900 ${r.valid >= 100000 ? 190 : 230}px ${SANS}`; ctx.fillStyle = '#ff7a1a';
  ctx.fillText(fmt(r.valid), PAD - 6, 700);
  ctx.fillStyle = '#f2f2f4'; ctx.font = `700 40px ${SANS}`; ctx.fillText(`valid proof${r.valid === 1 ? '' : 's'}`, PAD, 806);
  ctx.fillStyle = '#ff9a4d'; ctx.font = `700 34px ${SANS}`; ctx.fillText(day ? niceDay(day) : r.days.length > 1 ? `${niceDay(r.days[0].day)} – ${niceDay(r.days[r.days.length - 1].day)}` : niceDay(r.days[0].day), PAD, 862);
  let y = 940;
  if (list) {
    ctx.strokeStyle = '#2a2a33'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(PAD, y - 22); ctx.lineTo(W - PAD, y - 22); ctx.stroke();
    for (const d of shown) {
      ctx.textAlign = 'left'; ctx.fillStyle = '#a3a3ad'; ctx.font = `500 28px ${SANS}`; ctx.fillText(niceDay(d.day), PAD, y + 20);
      ctx.textAlign = 'right'; ctx.fillStyle = '#f2f2f4'; ctx.font = `700 30px ${SANS}`; ctx.fillText(fmt(d.valid), W - PAD, y + 20);
      y += 52;
    }
    if (r.days.length > shown.length) { ctx.textAlign = 'left'; ctx.fillStyle = '#7a7a85'; ctx.font = `500 22px ${SANS}`; ctx.fillText(`+ ${r.days.length - shown.length} earlier days`, PAD, y + 14); }
  }
  ctx.textAlign = 'left'; ctx.fillStyle = '#7a7a85'; ctx.font = `500 24px ${SANS}`;
  ctx.fillText('Unique Mnet Plus certificates, verified one by one.', PAD, H - 64);
  return canvas;
}

// ---------------------------------------------------------------- references
function refFigure(r) {
  const fig = el('figure');
  const img = el('img'); img.src = `/api/collab/refs/${r.id}/image`; img.alt = `Reference: ${r.label}`;
  const del = el('button', 'btn-ghost', '×'); del.type = 'button'; del.title = 'Remove reference'; del.setAttribute('aria-label', `Remove reference ${r.label}`);
  del.addEventListener('click', async () => {
    if (!confirm('Remove this reference? Later uploads will no longer be compared with it.')) return;
    try { await request(`/api/collab/refs/${r.id}/delete`, {}); await loadSummary(); } catch (e) { fail(e); }
  });
  fig.append(img, el('figcaption', null, r.label), del);
  return fig;
}
function renderRefs(refs) {
  const box = $('#refs'); box.replaceChildren();
  if (!refs.length) box.append(el('p', 'muted', 'No reference yet. Add at least one correct certificate to start verifying.'));
  for (const r of refs) box.append(refFigure(r));
}
async function sendRef(file, query) {
  const res = await fetch(`/api/collab/ref?${query}`, {method: 'POST', body: file, headers: {'Content-Type': 'application/octet-stream'}});
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}
$('#ref-file').addEventListener('change', async event => {
  const files = [...event.target.files]; event.target.value = '';
  for (const file of files) {
    try { await sendRef(file, `label=${encodeURIComponent($('#ref-label').value.trim())}`); }
    catch (e) { toast('error', 'Reference not added', `${file.name}: ${e.message}`); }
  }
  $('#ref-label').value = '';
  await loadSummary().catch(fail);
});

// ---------------------------------------------------------------- collabs
function renderCollabs(collabs) {
  const box = $('#collabs'), select = $('#collab'), previous = select.value;
  box.replaceChildren(); select.replaceChildren();
  if (!collabs.length) {
    box.append(el('p', 'muted', 'No collab yet. Add the first one below.'));
    select.append(new Option('Add a collab first', '')); select.disabled = true;
  } else select.disabled = false;
  for (const c of collabs) {
    const needsPartner = c.slots.length > 0;
    select.append(new Option(c.name, c.name));
    const card = el('article', 'collab-card');
    card.append(el('h3', null, c.name), el('p', 'rule', needsPartner
      ? `${c.name} image in the ${where(c.slots)} position, ENHYPEN last.` : 'ENHYPEN as the last image (no partner image).'));
    if (needsPartner) {
      const refs = el('div', 'refs');
      if (!c.refs.length) refs.append(el('p', 'muted', 'No reference yet: add a sample certificate before uploading.'));
      for (const r of c.refs) refs.append(refFigure(r));
      card.append(refs);
      const add = el('div', 'add-ref');
      const picker = el('label', 'picker compact'), file = el('input'); file.type = 'file'; file.accept = 'image/*';
      const note = el('span', 'picker-note', 'No file selected');
      picker.append(file, el('span', 'picker-btn', 'Choose sample'), note);
      bindPicker(file, note, 'No file selected', files => files[0].name);
      const slotLabel = el('label', null, `In the sample, ${c.name} is the`), slot = el('select');
      for (const i of c.slots) slot.append(new Option(`${SLOT_WORD[i][0].toUpperCase()}${SLOT_WORD[i].slice(1)} image`, String(i)));
      slotLabel.append(slot);
      const button = el('button', null, 'Add reference'); button.type = 'button';
      button.addEventListener('click', async () => {
        if (!file.files.length) return toast('error', 'Choose a sample certificate', 'Select a full certificate screenshot first.');
        busy(button, true, 'Adding…');
        try { await sendRef(file.files[0], `collab=${c.id}&slot=${slot.value}`); await loadSummary(); }
        catch (e) { toast('error', 'Reference not added', e.message); }
        finally { release(button); }
      });
      add.append(picker, slotLabel, button); card.append(add);
    }
    const remove = el('button', 'btn-ghost remove', 'Remove collab'); remove.type = 'button';
    remove.addEventListener('click', async () => {
      if (!confirm(`Remove the collab "${c.name}" and its reference images?`)) return;
      try { await request(`/api/collab/collabs/${c.id}/delete`, {}); await loadSummary(); } catch (e) { fail(e); }
    });
    card.append(remove); box.append(card);
  }
  if ([...select.options].some(o => o.value === previous)) select.value = previous;
  updateHint();
}
function updateHint() {
  const c = data.collabs.find(x => x.name === $('#collab').value);
  $('#collab-hint').textContent = !c ? '' : c.slots.length ? `Checks: ${c.name} image in the ${where(c.slots)} position, ENHYPEN last.` : 'Checks: ENHYPEN as the last image.';
}
$('#collab').addEventListener('change', updateHint);
$('#collab-form').addEventListener('submit', async event => {
  event.preventDefault();
  const value = $('#collab-slots').value, slots = value === '' ? [] : value.split(',').map(Number);
  try { await request('/api/collab/collabs/create', {name: $('#collab-name').value, slots}); $('#collab-name').value = ''; await loadSummary(); }
  catch (e) { fail(e); }
});

// ---------------------------------------------------------------- upload run
function collect() {
  const fandom = $('#collab').value, items = [];
  for (const file of $('#files').files) {
    if (!IMAGE.test(file.name)) continue;
    items.push({file, name: file.name, fandom, key: `${fandom}|${file.name}|${file.size}|${file.lastModified}`});
  }
  for (const file of $('#folder').files) {
    const path = file.webkitRelativePath || file.name;
    if (JUNK.test(path) || !IMAGE.test(file.name)) continue;
    items.push({file, name: path.split('/').slice(1).join('/') || file.name, fandom, key: `${fandom}|${path}|${file.size}|${file.lastModified}`});
  }
  return items;
}

async function send(item, day) {
  const query = `fandom=${encodeURIComponent(item.fandom)}&day=${encodeURIComponent(day)}&name=${encodeURIComponent(item.name)}&key=${encodeURIComponent(item.key)}`;
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (stopping) throw new Error('Stopped');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 120000);
    try {
      const res = await fetch(`/api/collab/upload?${query}`, {method: 'POST', body: item.file, headers: {'Content-Type': 'application/octet-stream'}, signal: controller.signal});
      const body = await res.json().catch(() => ({}));
      if (res.ok) return body;
      const error = new Error(body.error || `HTTP ${res.status}`);
      if (res.status < 500 && res.status !== 429) { error.final = true; throw error; }  // 4xx: retrying cannot help
      lastError = error;
    } catch (e) {
      if (e.final) throw e;
      lastError = e.name === 'AbortError' ? new Error('Timed out') : e;
    } finally { clearTimeout(timer); }
    await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
  }
  throw lastError;
}

async function skipKnown(items) {
  const known = new Set();
  for (let i = 0; i < items.length; i += KNOWN_BATCH) {
    const keys = items.slice(i, i + KNOWN_BATCH).map(x => x.key);
    (await request('/api/collab/known', {keys})).known.forEach(k => known.add(k));
  }
  return items.filter(x => !known.has(x.key));
}

function setRunning(on) {
  running = on; stopping = false;
  $('#start').disabled = on; $('#stop').hidden = !on;
  window.onbeforeunload = on ? () => 'Verification is still running.' : null;
}

$('#upload-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (running) return;
  const day = $('#proofs-date').value;
  if (!$('#collab').value) return toast('error', 'Collab missing', 'Choose the collab these proofs belong to before starting.');
  if (!day) return toast('error', 'Date missing', 'Enter the date the votes refer to.');
  const all = collect();
  if (!all.length) return toast('error', 'No images found', 'Choose a folder or some screenshots first.');
  setRunning(true);
  let items;
  try { items = await skipKnown(all); } catch (e) { setRunning(false); return fail(e); }
  const skipped = all.length - items.length;
  const stats = {done: 0, valid: 0, duplicate: 0, not_enhypen: 0, not_partner: 0, manual: 0, failed: 0};
  const errors = [], start = Date.now();
  $('#run').hidden = false;
  const draw = () => {
    const pct = items.length ? stats.done / items.length * 100 : 100;
    $('#run-fill').style.width = `${pct}%`; $('#run-bar').setAttribute('aria-valuenow', String(Math.round(pct)));
    const rate = stats.done / Math.max((Date.now() - start) / 1000, 1), left = items.length - stats.done;
    $('#run-text').textContent = `${fmt(stats.done)} of ${fmt(items.length)} files · ${rate.toFixed(1)} per second` +
      (running && stats.done ? ` · about ${E1.duration(left / rate)} left` : '') + (skipped ? ` · ${fmt(skipped)} already processed, skipped` : '');
    $('#run-chips').replaceChildren(
      chip('ok', `${fmt(stats.valid)} valid`), chip('warn', `${fmt(stats.manual)} to review`),
      chip('err', `${fmt(stats.duplicate)} duplicates`), chip('err', `${fmt(stats.not_enhypen)} not ENHYPEN`),
      chip('err', `${fmt(stats.not_partner)} wrong partner image`), ...(stats.failed ? [chip('err', `${fmt(stats.failed)} failed`)] : []));
    $('#run-errors').replaceChildren(...errors.slice(-8).map(t => el('li', null, t)));
  };
  const timer = setInterval(draw, 400);
  let next = 0;
  const lane = async () => {
    while (!stopping) {
      const item = items[next++];
      if (!item) return;
      try { const r = await send(item, day); stats[r.status] = (stats[r.status] || 0) + 1; }
      catch (e) { if (e.message === 'Stopped') return; stats.failed++; errors.push(`${item.name}: ${e.message}`); if (/Authentication required/i.test(e.message)) stopping = true; }
      stats.done++;
    }
  };
  await Promise.all(Array.from({length: LANES}, lane));
  clearInterval(timer); draw();
  const wasStopped = stopping;
  setRunning(false);
  $('#run-text').textContent += wasStopped ? ' · Stopped. Pick the same files again to continue.' : ' · Done.';
  if (!wasStopped) { $('#folder').value = ''; $('#files').value = ''; refreshFolder(); refreshFiles(); }
  toast(stats.failed ? 'error' : 'success', wasStopped ? 'Verification stopped' : 'Verification finished',
    `${fmt(stats.valid)} valid, ${fmt(stats.manual)} to review${stats.failed ? `, ${fmt(stats.failed)} failed (pick the files again to retry them)` : ''}.`);
  offset = 0;
  await Promise.all([loadSummary(), loadQueue()]).catch(fail);
});
$('#stop').addEventListener('click', () => { stopping = true; $('#run-text').textContent = 'Stopping after the files in progress…'; });

// ---------------------------------------------------------------- review
const KIND_NOTES = {
  manual: 'Proofs the system could not verify with certainty: correct the ID if needed, then accept or reject. A one-character-different ID needs a second click to confirm it is a different certificate.',
  groups: 'Proofs rejected because the last image is not ENHYPEN (another group, or ENHYPEN in another position). If the system got one wrong, read or type the ID and accept it; otherwise confirm it to clear it from this list. The status stays "not ENHYPEN" in the recap.',
  partner: 'Proofs rejected because the collab\'s own image is missing or in the wrong position. If the system got one wrong, read or type the ID and accept it; otherwise confirm it to clear it from this list. The status stays "wrong partner image" in the recap.',
};
let kind = 'manual', pollTimer = null;

async function loadQueue() {
  const body = await request(`/api/collab/queue?kind=${kind}&offset=${offset}&limit=${PAGE}`);
  if (!body.items.length && offset > 0) { offset = Math.max(0, offset - PAGE); return loadQueue(); }
  const all = body.counts.manual + body.counts.groups + body.counts.partner;
  $('#review-count').textContent = all ? fmt(all) : '';
  document.querySelectorAll('#review-kinds button').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.kind === kind));
    b.querySelector('.seg-count').textContent = body.counts[b.dataset.kind] ? fmt(body.counts[b.dataset.kind]) : '';
  });
  $('#review-note').textContent = KIND_NOTES[kind];
  renderOcrNotice(body.retry_pending);
  $('#page-info').textContent = body.total ? `${offset + 1}–${offset + body.items.length} of ${fmt(body.total)}` : '';
  $('#prev').disabled = offset === 0; $('#next').disabled = offset + PAGE >= body.total;
  $('.pager').hidden = body.total <= PAGE;
  const box = $('#queue'); box.replaceChildren();
  if (!body.items.length) box.append(el('p', 'muted', 'Nothing to review here.'));
  for (const item of body.items) box.append(proofCard(item));
}
document.querySelectorAll('#review-kinds button').forEach(b => b.addEventListener('click', () => {
  if (kind === b.dataset.kind) return;
  kind = b.dataset.kind; offset = 0; loadQueue().catch(fail);
}));

// Proofs the checker may judge differently now can be checked again, in the background: every list has its own button.
const RETRY_TEXT = {
  manual: n => `${fmt(n)} proof${n === 1 ? ' is' : 's are'} here because the ID could not be read, an image was unclear or the layout was not recognised`,
  groups: n => `${fmt(n)} proof${n === 1 ? ' was' : 's were'} rejected as another group: the ENHYPEN image may be recognised now`,
  partner: n => `${fmt(n)} proof${n === 1 ? ' was' : 's were'} rejected for the partner image: it may be recognised now`,
};
function renderOcrNotice(pending, job) {
  const box = $('#ocr-notice'), button = $('#reread');
  box.hidden = !pending && !(job && job.running);
  if (box.hidden) return;
  $('#ocr-notice-title').textContent = job && job.running
    ? `Checking again… ${fmt(job.done)} of ${fmt(job.total)}`
    : RETRY_TEXT[kind](pending);
  $('#ocr-notice-text').textContent = 'Each proof is checked again from its stored image with the current checker (ENHYPEN image, partner image and ID). Proofs that now pass are counted or marked as duplicates; the ones that still fail stay here.';
  let bar = box.querySelector('progress');
  if (job && job.running) {
    if (!bar) { bar = el('progress'); box.append(bar); }
    bar.max = Math.max(1, job.total); bar.value = job.done;
  } else if (bar) bar.remove();
  button.disabled = Boolean(job && job.running);
}
$('#reread').addEventListener('click', async () => {
  try { await request('/api/collab/reprocess/start', {kind}); } catch (e) { return fail(e); }
  pollReprocess();
});
function pollReprocess() {
  clearTimeout(pollTimer);
  request('/api/collab/reprocess').then(async job => {
    if (job.running) {
      renderOcrNotice(0, job); pollTimer = setTimeout(pollReprocess, 1500); return;
    }
    await Promise.all([loadSummary(), loadQueue()]);
    if (job.error) return toast('error', 'Checking again stopped', job.error);
    const r = job.result;
    if (r) toast('success', 'Checked again', `${fmt(r.valid)} now valid, ${fmt(r.duplicate)} duplicates, ${fmt(r.near)} similar to a counted ID, ${fmt(r.review)} moved to the verify list, ${fmt(r.unchanged)} unchanged.`);
  }).catch(fail);
}

function proofCard(item) {
  const flagged = item.status !== 'manual';
  const card = el('article', 'proof');
  if (item.has_image) {
    const img = el('img'); img.src = `/api/collab/proofs/${item.id}/image`; img.alt = `Certificate ${item.file_name}`;
    img.addEventListener('click', () => img.classList.toggle('zoom')); card.append(img);
  } else card.append(el('div', 'none', 'No preview'));
  const body = el('div', 'proof-body');
  body.append(el('h3', null, item.fandom), el('p', 'muted', `${item.file_name} · ${item.day}`), el('p', 'reason', item.reason));
  const label = el('label', null, 'Certificate ID'), input = el('input');
  input.value = item.cert_id || ''; input.maxLength = 16; input.autocomplete = 'off'; input.spellcheck = false;
  label.append(input);
  const msg = el('p', 'proof-msg'); msg.setAttribute('role', 'status');
  const ok = el('button', null, 'Valid ENHYPEN proof'), no = el('button', 'btn-ghost', flagged ? 'Confirm: not valid' : 'Reject');
  ok.type = no.type = 'button';
  const row = el('div', 'id-row'); row.append(label);
  if (item.has_image) {  // reads the ID again on request: correcting a nearly right ID is easier than typing it all (and some proofs have none yet)
    const read = el('button', 'btn-ghost', 'Read ID from image'); read.type = 'button';
    read.addEventListener('click', async () => {
      busy(read, true, 'Reading…'); msg.textContent = '';
      try {
        const r = await request(`/api/collab/proofs/${item.id}/read`, {});
        if (r.cert_id) { input.value = r.cert_id; input.dispatchEvent(new Event('input')); }
        msg.className = 'proof-msg warn';
        msg.textContent = !r.cert_id ? 'The ID could not be read: type it from the image.' : r.confident ? 'ID read: check it against the image.' : 'The readings were not sure: check every character against the image.';
      } catch (e) { msg.className = 'proof-msg'; msg.textContent = asRequestError(e).message; }
      finally { release(read); }
    });
    row.append(read);
  }
  let confirming = false;
  input.addEventListener('input', () => { confirming = false; ok.textContent = 'Valid ENHYPEN proof'; });
  ok.addEventListener('click', async () => {
    busy(ok, true, 'Saving…');
    try {
      const r = await request(`/api/collab/proofs/${item.id}/approve`, {cert_id: input.value, confirm_similar: confirming});
      if (r.needs_confirmation) { confirming = true; msg.className = 'proof-msg warn'; msg.textContent = r.message; ok.textContent = 'Confirm: different certificate'; return; }
      await Promise.all([loadSummary(), loadQueue()]);
    } catch (e) { msg.className = 'proof-msg'; msg.textContent = asRequestError(e).message; }
    finally { release(ok); }
  });
  no.addEventListener('click', async () => {
    busy(no, true, 'Saving…');
    try { await request(`/api/collab/proofs/${item.id}/${flagged ? 'keep' : 'reject'}`, {}); await Promise.all([loadSummary(), loadQueue()]); }
    catch (e) { msg.className = 'proof-msg'; msg.textContent = asRequestError(e).message; }
    finally { release(no); }
  });
  const actions = el('div', 'proof-actions'); actions.append(ok, no);
  body.append(row, actions, msg); card.append(body);
  return card;
}
$('#prev').addEventListener('click', () => { offset = Math.max(0, offset - PAGE); loadQueue().catch(fail); });
$('#next').addEventListener('click', () => { offset += PAGE; loadQueue().catch(fail); });

// ---------------------------------------------------------------- Google Drive import (the server downloads and checks the images)
let drivePoll = null;
function drawDrive(job) {
  $('#drive-off').hidden = job.configured;
  $('#drive-start').disabled = !job.configured || job.running; $('#drive-stop').hidden = !job.running;
  const shown = job.running || job.phase === 'done' || job.phase === 'stopped';
  $('#drive-run').hidden = !shown && !job.error;
  if ($('#drive-run').hidden) return;
  const pct = job.total ? job.done / job.total * 100 : job.phase === 'listing' ? 0 : 100;
  $('#drive-fill').style.width = `${pct}%`; $('#drive-bar').setAttribute('aria-valuenow', String(Math.round(pct)));
  const rate = job.done / Math.max((Date.now() / 1000 - job.started), 1);
  let text = job.phase === 'listing' ? `Reading the Drive folder… ${fmt(job.found)} images found`
    : `${job.fandom} · ${job.day}: ${fmt(job.done)} of ${fmt(job.total)} files · ${rate.toFixed(1)} per second` + (job.running && job.done ? ` · about ${E1.duration((job.total - job.done) / rate)} left` : '') +
      (job.skipped ? ` · ${fmt(job.skipped)} already processed, skipped` : '');
  if (job.stopping && job.running) text += ' · Stopping…';
  else if (job.phase === 'done') text += job.error ? '' : ' · Done.';
  else if (job.phase === 'stopped') text += ' · Stopped. Import the same link again to continue.';
  if (job.error) text = `${text ? text + ' · ' : ''}${job.error}`;
  $('#drive-text').textContent = text;
  const c = job.counts || {};
  $('#drive-chips').replaceChildren(chip('ok', `${fmt(c.valid || 0)} valid`), chip('warn', `${fmt(c.manual || 0)} to review`), chip('err', `${fmt(c.duplicate || 0)} duplicates`),
    chip('err', `${fmt(c.not_enhypen || 0)} not ENHYPEN`), chip('err', `${fmt(c.not_partner || 0)} wrong partner image`), ...(job.failed ? [chip('err', `${fmt(job.failed)} failed`)] : []));
  $('#drive-errors').replaceChildren(...job.errors.map(t => el('li', null, t)));
}
async function refreshDrive() {
  clearTimeout(drivePoll);
  const job = await request('/api/collab/import');
  drawDrive(job);
  if (job.running) drivePoll = setTimeout(() => refreshDrive().catch(() => {}), 1500);
  else if (job.phase) { offset = 0; Promise.all([loadSummary(), loadQueue()]).catch(() => {}); }
}
$('#drive-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!$('#collab').value) return toast('error', 'Collab missing', 'Choose the collab these proofs belong to before starting.');
  if (!$('#proofs-date').value) return toast('error', 'Date missing', 'Enter the date the votes refer to.');
  try { drawDrive(await request('/api/collab/import/start', {url: $('#drive-url').value, fandom: $('#collab').value, day: $('#proofs-date').value})); }
  catch (e) { return fail(e); }
  drivePoll = setTimeout(() => refreshDrive().catch(fail), 1000);
});
$('#drive-stop').addEventListener('click', async () => {
  try { drawDrive(await request('/api/collab/import/stop', {})); } catch (e) { fail(e); }
});

// ---------------------------------------------------------------- start
$('#proofs-date').value = localToday(); $('#proofs-date').max = localToday();
activate();
Promise.all([loadSummary(), loadQueue()]).then(() => { request('/api/collab/reprocess').then(j => j.running && pollReprocess()).catch(() => {}); refreshDrive().catch(() => {});
  if (!location.hash && data.refs.length && data.collabs.length) location.hash = 'upload';  // setup is done: go straight to uploading
}).catch(fail);
})();
