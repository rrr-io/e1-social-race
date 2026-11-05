(() => {
'use strict';
const {request, asRequestError, toast, fmt, labelCells, busy} = window.E1;
const $ = s => document.querySelector(s);
const PAGE = 10, LANES = 4, KNOWN_BATCH = 1000;
const IMAGE = /\.(png|jpe?g|webp|gif|bmp|heic|heif)$/i;
const JUNK = /(^|\/)(__MACOSX|\.[^/]+)(\/|$)/;
let offset = 0, queueTotal = 0, running = false, stopping = false;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
const chip = (cls, text) => el('span', `chip ${cls}`, text);

// ---------------------------------------------------------------- summary & references
const COUNTS = ['files', 'duplicate', 'not_enhypen', 'not_partner', 'manual', 'rejected'];
const SLOT_WORD = ['first', 'second'];
const where = slots => slots.map(i => SLOT_WORD[i]).join(' or ');

async function loadSummary() {
  const data = await request('/api/collab/summary');
  $('#ocr-banner').hidden = data.ocr_available;
  renderRefs(data.refs);
  renderCollabs(data.collabs);
  const body = $('#summary-body');
  body.replaceChildren();
  const total = {valid: 0, files: 0, duplicate: 0, not_enhypen: 0, not_partner: 0, manual: 0, rejected: 0};
  for (const s of data.submissions) {
    const tr = el('tr');
    tr.append(el('td', null, s.fandom));
    const valid = el('td', 'num'); valid.append(el('strong', null, fmt(s.valid))); tr.append(valid);
    tr.append(el('td', null, s.day));
    for (const k of COUNTS) tr.append(el('td', 'num', fmt(s[k])));
    for (const k of Object.keys(total)) total[k] += s[k];
    body.append(tr);
  }
  if (!data.submissions.length) {
    const tr = el('tr'); const td = el('td', 'muted', 'No proofs uploaded yet.'); td.colSpan = 9; tr.append(td); body.append(tr);
  } else {
    const tr = el('tr', 'total'); tr.append(el('td', null, 'Total'));
    tr.append(el('td', 'num', fmt(total.valid)), el('td'));
    for (const k of COUNTS) tr.append(el('td', 'num', fmt(total[k])));
    body.append(tr);
  }
  labelCells($('#summary-table'));
}

// ---------------------------------------------------------------- collabs
function renderCollabs(collabs) {
  const box = $('#collabs'), select = $('#collab'), previous = select.value;
  box.replaceChildren(); select.replaceChildren();
  if (!collabs.length) {
    box.append(el('p', 'muted', 'No collab yet. Add the first one below.'));
    select.append(new Option('Add a collab first', '')); select.disabled = true; $('#collab-hint').textContent = '';
  } else select.disabled = false;
  for (const c of collabs) {
    const needsPartner = c.slots.length > 0;
    select.append(new Option(c.name, c.name));
    const card = el('article', 'collab-card');
    card.append(el('h3', null, c.name), el('p', 'rule', needsPartner
      ? `${c.name} image in the ${where(c.slots)} position, ENHYPEN last.` : 'ENHYPEN as the last image (no partner image).'));
    if (needsPartner) {
      const refs = el('div', 'refs');
      if (!c.refs.length) refs.append(el('p', 'muted', 'No reference yet: add a sample certificate below before uploading.'));
      for (const r of c.refs) refs.append(refFigure(r, `/api/collab/refs/${r.id}/image`));
      card.append(refs);
      const add = el('div', 'add-ref');
      const file = el('input'); file.type = 'file'; file.accept = 'image/*';
      const fileLabel = el('label', null, 'Sample certificate'); fileLabel.append(file);
      const slot = el('select');
      for (const i of c.slots) slot.append(new Option(`${SLOT_WORD[i][0].toUpperCase()}${SLOT_WORD[i].slice(1)} image`, String(i)));
      const slotLabel = el('label', null, `In the sample, ${c.name} is the`); slotLabel.append(slot);
      const button = el('button', 'btn-ghost', 'Add reference'); button.type = 'button';
      button.addEventListener('click', async () => {
        if (!file.files.length) return toast('error', 'Choose a sample certificate', 'Select a full certificate screenshot first.');
        busy(button, true, 'Adding…');
        try { await sendRef(file.files[0], `collab=${c.id}&slot=${slot.value}`); await loadSummary(); }
        catch (e) { toast('error', 'Reference not added', e.message); }
        finally { busy(button, false); }
      });
      add.append(fileLabel, slotLabel, button); card.append(add);
    }
    const remove = el('button', 'btn-ghost remove', 'Remove collab'); remove.type = 'button';
    remove.addEventListener('click', async () => {
      if (!confirm(`Remove the collab "${c.name}" and its reference images?`)) return;
      try { await request(`/api/collab/collabs/${c.id}/delete`, {}); await loadSummary(); } catch (e) { fail(e); }
    });
    card.append(remove); box.append(card);
  }
  if ([...select.options].some(o => o.value === previous)) select.value = previous;
  updateHint(collabs);
  select.onchange = () => updateHint(collabs);
}

function updateHint(collabs) {
  const c = collabs.find(x => x.name === $('#collab').value);
  $('#collab-hint').textContent = !c ? '' : c.slots.length ? `Checks: ${c.name} image in the ${where(c.slots)} position and ENHYPEN last.` : 'Checks: ENHYPEN as the last image.';
}

$('#collab-form').addEventListener('submit', async event => {
  event.preventDefault();
  const slots = $('#collab-slots').value === '' ? [] : $('#collab-slots').value.split(',').map(Number);
  try { await request('/api/collab/collabs/create', {name: $('#collab-name').value, slots}); $('#collab-name').value = ''; await loadSummary(); }
  catch (e) { fail(e); }
});

async function sendRef(file, query) {
  const res = await fetch(`/api/collab/ref?${query}`, {method: 'POST', body: file, headers: {'Content-Type': 'application/octet-stream'}});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function refFigure(r, src) {
  const fig = el('figure');
  const img = el('img'); img.src = src; img.alt = `Reference: ${r.label}`;
  const del = el('button', 'btn-ghost', '×'); del.type = 'button'; del.title = 'Remove reference'; del.setAttribute('aria-label', `Remove reference ${r.label}`);
  del.addEventListener('click', async () => {
    if (!confirm('Remove this reference? Later uploads will no longer be compared with it.')) return;
    try { await request(`/api/collab/refs/${r.id}/delete`, {}); await loadSummary(); } catch (e) { fail(e); }
  });
  fig.append(img, el('figcaption', null, r.label), del);
  return fig;
}

function renderRefs(refs) {
  const box = $('#refs');
  box.replaceChildren();
  if (!refs.length) box.append(el('p', 'muted', 'No reference yet. Upload at least one correct certificate to start verifying.'));
  for (const r of refs) box.append(refFigure(r, `/api/collab/refs/${r.id}/image`));
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

function fail(error) { const e = asRequestError(error); toast('error', e.title, e.message); }

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

async function send(item) {
  const query = `fandom=${encodeURIComponent(item.fandom)}&name=${encodeURIComponent(item.name)}&key=${encodeURIComponent(item.key)}`;
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (stopping) throw new Error('Stopped');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 120000);
    try {
      const res = await fetch(`/api/collab/upload?${query}`, {method: 'POST', body: item.file, headers: {'Content-Type': 'application/octet-stream'}, signal: controller.signal});
      const data = await res.json().catch(() => ({}));
      if (res.ok) return data;
      const error = new Error(data.error || `HTTP ${res.status}`);
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
  const all = collect();
  if (!all.length) return toast('error', 'No images found', 'Select a folder or some screenshots first.');
  if (all.some(x => !x.fandom)) return toast('error', 'Collab missing', 'Choose the collab these proofs belong to before starting.');
  setRunning(true);
  let items;
  try { items = await skipKnown(all); } catch (e) { setRunning(false); return fail(e); }
  const skipped = all.length - items.length;
  const stats = {done: 0, valid: 0, duplicate: 0, not_enhypen: 0, manual: 0, failed: 0};
  const errors = [], start = Date.now();
  $('#run').hidden = false;
  const draw = () => {
    const pct = items.length ? stats.done / items.length * 100 : 100;
    $('#run-fill').style.width = `${pct}%`; $('#run-bar').setAttribute('aria-valuenow', String(Math.round(pct)));
    const rate = stats.done / Math.max((Date.now() - start) / 1000, 1), left = items.length - stats.done;
    $('#run-text').textContent = `${fmt(stats.done)} of ${fmt(items.length)} files · ${rate.toFixed(1)} per second` +
      (running && stats.done ? ` · about ${E1.duration(left / rate)} left` : '') + (skipped ? ` · ${fmt(skipped)} already processed, skipped` : '');
    const chips = $('#run-chips'); chips.replaceChildren(
      chip('ok', `${fmt(stats.valid)} valid`), chip('warn', `${fmt(stats.manual)} manual review`),
      chip('err', `${fmt(stats.duplicate)} duplicates`), chip('err', `${fmt(stats.not_enhypen)} not ENHYPEN`),
      ...(stats.failed ? [chip('err', `${fmt(stats.failed)} failed`)] : []));
    const list = $('#run-errors'); list.replaceChildren(...errors.slice(-8).map(t => el('li', null, t)));
  };
  const timer = setInterval(draw, 400);
  let next = 0;
  const lane = async () => {
    while (!stopping) {
      const item = items[next++];
      if (!item) return;
      try { const r = await send(item); stats[r.status] = (stats[r.status] || 0) + 1; }
      catch (e) { if (e.message === 'Stopped') return; stats.failed++; errors.push(`${item.name}: ${e.message}`); if (/Authentication required/i.test(e.message)) stopping = true; }
      stats.done++;
    }
  };
  await Promise.all(Array.from({length: LANES}, lane));
  clearInterval(timer); draw();
  const wasStopped = stopping;
  setRunning(false);
  $('#run-text').textContent += wasStopped ? ' · Stopped. Select the same files again to continue.' : ' · Done.';
  if (!wasStopped) { $('#folder').value = ''; $('#files').value = ''; }
  toast(stats.failed ? 'error' : 'success', wasStopped ? 'Verification stopped' : 'Verification finished',
    `${fmt(stats.valid)} valid, ${fmt(stats.manual)} for manual review${stats.failed ? `, ${fmt(stats.failed)} failed (select the files again to retry them)` : ''}.`);
  offset = 0;
  await Promise.all([loadSummary(), loadQueue()]).catch(fail);
});
$('#stop').addEventListener('click', () => { stopping = true; $('#run-text').textContent = 'Stopping after the files in progress…'; });

// ---------------------------------------------------------------- manual review
async function loadQueue() {
  const data = await request(`/api/collab/queue?offset=${offset}&limit=${PAGE}`);
  queueTotal = data.total;
  if (!data.items.length && offset > 0) { offset = Math.max(0, offset - PAGE); return loadQueue(); }
  $('#queue-count').textContent = data.total ? String(data.total) : '';
  $('#page-info').textContent = data.total ? `${offset + 1}–${offset + data.items.length} of ${fmt(data.total)}` : '';
  $('#prev').disabled = offset === 0; $('#next').disabled = offset + PAGE >= data.total;
  $('.pager').hidden = data.total <= PAGE;
  const box = $('#queue'); box.replaceChildren();
  if (!data.items.length) box.append(el('p', 'muted', 'Nothing to review manually.'));
  for (const item of data.items) box.append(proofCard(item));
}

function proofCard(item) {
  const card = el('article', 'proof');
  if (item.has_image) {
    const img = el('img'); img.src = `/api/collab/proofs/${item.id}/image`; img.alt = `Certificate ${item.file_name}`;
    img.addEventListener('click', () => img.classList.toggle('zoom')); card.append(img);
  } else card.append(el('div', 'none', 'No preview'));
  const body = el('div', 'proof-body');
  body.append(el('h3', null, item.fandom), el('p', 'muted', `${item.file_name} · ${item.day}`), el('p', 'reason', item.reason));
  const label = el('label', null, 'Certificate ID'); const input = el('input'); input.value = item.cert_id || ''; input.maxLength = 16; input.autocomplete = 'off'; input.spellcheck = false;
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
$('#csv-summary').addEventListener('click', () => { location.href = '/api/collab/export.csv?kind=summary'; });
$('#csv-full').addEventListener('click', () => { location.href = '/api/collab/export.csv?kind=full'; });

Promise.all([loadSummary(), loadQueue()]).catch(fail);
})();
