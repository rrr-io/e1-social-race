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
  $('#review-count').textContent = String(data.submissions.reduce((n, s) => n + s.manual, 0) || '');
}

function sumCounts(rows) {
  const total = {valid: 0, files: 0, duplicate: 0, not_enhypen: 0, not_partner: 0, manual: 0, rejected: 0};
  for (const s of rows) for (const k of Object.keys(total)) total[k] += s[k];
  return total;
}

// ---------------------------------------------------------------- recap
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
    body.append(tr);
  }
  if (!rows.length) {
    const tr = el('tr'); const td = el('td', 'muted', 'No proofs uploaded yet.'); td.colSpan = 9; tr.append(td); body.append(tr);
  } else {
    const tr = el('tr', 'total'); tr.append(el('td', null, 'Total'), el('td', 'num', fmt(total.valid)), el('td'));
    for (const k of COUNTS) tr.append(el('td', 'num', fmt(total[k])));
    body.append(tr);
  }
  labelCells($('#summary-table'));
}
$('#recap-day').addEventListener('change', renderRecap);
const exportUrl = kind => `/api/collab/export.csv?kind=${kind}&day=${encodeURIComponent($('#recap-day').value)}`;
$('#csv-summary').addEventListener('click', () => { location.href = exportUrl('summary'); });
$('#csv-full').addEventListener('click', () => { location.href = exportUrl('full'); });

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
        finally { busy(button, false); }
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

// ---------------------------------------------------------------- manual review
async function loadQueue() {
  const body = await request(`/api/collab/queue?offset=${offset}&limit=${PAGE}`);
  if (!body.items.length && offset > 0) { offset = Math.max(0, offset - PAGE); return loadQueue(); }
  $('#review-count').textContent = body.total ? String(body.total) : '';
  $('#page-info').textContent = body.total ? `${offset + 1}–${offset + body.items.length} of ${fmt(body.total)}` : '';
  $('#prev').disabled = offset === 0; $('#next').disabled = offset + PAGE >= body.total;
  $('.pager').hidden = body.total <= PAGE;
  const box = $('#queue'); box.replaceChildren();
  if (!body.items.length) box.append(el('p', 'muted', 'Nothing to review.'));
  for (const item of body.items) box.append(proofCard(item));
}

function proofCard(item) {
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
  const ok = el('button', null, 'Valid ENHYPEN proof'), no = el('button', 'btn-ghost', 'Reject');
  ok.type = no.type = 'button';
  let confirming = false;
  input.addEventListener('input', () => { confirming = false; ok.textContent = 'Valid ENHYPEN proof'; msg.textContent = ''; });
  ok.addEventListener('click', async () => {
    busy(ok, true, 'Saving…');
    try {
      const r = await request(`/api/collab/proofs/${item.id}/approve`, {cert_id: input.value, confirm_similar: confirming});
      if (r.needs_confirmation) { confirming = true; msg.className = 'proof-msg warn'; msg.textContent = r.message; ok.textContent = 'Confirm: different certificate'; return; }
      await Promise.all([loadSummary(), loadQueue()]);
    } catch (e) { msg.className = 'proof-msg'; msg.textContent = asRequestError(e).message; }
    finally { busy(ok, false); }
  });
  no.addEventListener('click', async () => {
    busy(no, true, 'Saving…');
    try { await request(`/api/collab/proofs/${item.id}/reject`, {}); await Promise.all([loadSummary(), loadQueue()]); }
    catch (e) { msg.className = 'proof-msg'; msg.textContent = asRequestError(e).message; }
    finally { busy(no, false); }
  });
  const actions = el('div', 'proof-actions'); actions.append(ok, no);
  body.append(label, actions, msg); card.append(body);
  return card;
}
$('#prev').addEventListener('click', () => { offset = Math.max(0, offset - PAGE); loadQueue().catch(fail); });
$('#next').addEventListener('click', () => { offset += PAGE; loadQueue().catch(fail); });

// ---------------------------------------------------------------- start
$('#proofs-date').value = localToday(); $('#proofs-date').max = localToday();
activate();
Promise.all([loadSummary(), loadQueue()]).then(() => {
  if (!location.hash && data.refs.length && data.collabs.length) location.hash = 'upload';  // setup is done: go straight to uploading
}).catch(fail);
})();
