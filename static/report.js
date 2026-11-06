(() => {
'use strict';
const {request, asRequestError, toast, fmt, busy} = window.E1;
const $ = s => document.querySelector(s);
const token = location.pathname.split('/').pop();
const API = `/api/report/${encodeURIComponent(token)}`;
const PAGE = 10;
const TILES = [['valid', 'Valid proofs', 'primary'], ['files', 'Files received'], ['duplicate', 'Duplicates'], ['manual', 'To verify'],
  ['not_enhypen', 'Not ENHYPEN'], ['not_partner', 'Wrong partner image'], ['rejected', 'Rejected']];
const NOTES = {
  manual: 'The system could not verify these with certainty. Check the ID against the image (correct it if needed), then accept or reject. An ID one character different from a counted one needs a second click to confirm it is a different certificate.',
  groups: 'Rejected because the last image is not ENHYPEN. If the system got one wrong, read or type the ID and accept it; otherwise confirm it to clear it from this list.',
  partner: 'Rejected because the collab\'s own image is missing or in the wrong position. If the system got one wrong, read or type the ID and accept it; otherwise confirm it to clear it from this list.',
  rejected: 'Proofs that were rejected and confirmed. This list is for reference.',
};
let kind = 'manual', offset = 0;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function release(button) { busy(button, false); button.disabled = false; }
function fail(error) { const e = asRequestError(error); toast('error', e.title, e.message); }

async function load() {
  let body;
  try { body = await request(`${API}?kind=${kind}&offset=${offset}&limit=${PAGE}`); }
  catch (error) {
    const e = asRequestError(error);
    if (e.status === 404) { $('#gone-text').textContent = e.message; $('#gone').hidden = false; $('#lists').hidden = true; $('#tiles').replaceChildren(); return; }
    throw error;
  }
  if (!body.items.length && offset > 0) { offset = Math.max(0, offset - PAGE); return load(); }
  $('#title').textContent = body.fandom;
  document.title = `${body.fandom} · proofs report`;
  $('#subtitle').textContent = `Proofs dated ${body.day}. Only this batch is shown here.`;
  const tiles = $('#tiles'); tiles.replaceChildren();
  for (const [key, label, extra] of TILES) {
    const tile = el('div', `tile${extra ? ' ' + extra : ''}`); tile.append(el('strong', null, fmt(body.counts[key])), el('span', null, label)); tiles.append(tile);
  }
  $('#lists').hidden = false;
  document.querySelectorAll('#kinds button').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.kind === kind));
    b.querySelector('.seg-count').textContent = body.lists[b.dataset.kind] ? fmt(body.lists[b.dataset.kind]) : '';
  });
  $('#note').textContent = NOTES[kind];
  $('#page-info').textContent = body.total ? `${offset + 1}–${offset + body.items.length} of ${fmt(body.total)}` : '';
  $('#prev').disabled = offset === 0; $('#next').disabled = offset + PAGE >= body.total;
  $('.pager').hidden = body.total <= PAGE;
  const box = $('#queue'); box.replaceChildren();
  if (!body.items.length) box.append(el('p', 'muted', 'Nothing here.'));
  for (const item of body.items) box.append(proofCard(item));
}

function proofCard(item) {
  const flagged = item.status === 'not_enhypen' || item.status === 'not_partner';
  const readonly = kind === 'rejected';
  const card = el('article', 'proof');
  if (item.has_image) {
    const img = el('img'); img.src = `${API}/proofs/${item.id}/image`; img.alt = `Certificate ${item.file_name}`; img.loading = 'lazy';
    img.addEventListener('click', () => img.classList.toggle('zoom')); card.append(img);
  } else card.append(el('div', 'none', 'No preview'));
  const body = el('div', 'proof-body');
  body.append(el('h3', null, item.file_name), el('p', 'reason', item.reason));
  card.append(body);
  if (readonly) { if (item.cert_id) body.append(el('p', 'muted', `ID ${item.cert_id}`)); return card; }
  const label = el('label', null, 'Certificate ID'), input = el('input');
  input.value = item.cert_id || ''; input.maxLength = 16; input.autocomplete = 'off'; input.spellcheck = false;
  label.append(input);
  const msg = el('p', 'proof-msg'); msg.setAttribute('role', 'status');
  const ok = el('button', null, 'Valid ENHYPEN proof'), no = el('button', 'btn-ghost', flagged ? 'Confirm: not valid' : 'Reject');
  ok.type = no.type = 'button';
  const row = el('div', 'id-row'); row.append(label);
  if (item.has_image) {
    const read = el('button', 'btn-ghost', 'Read ID from image'); read.type = 'button';
    read.addEventListener('click', async () => {
      busy(read, true, 'Reading…'); msg.textContent = '';
      try {
        const r = await request(`${API}/proofs/${item.id}/read`, {});
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
      const r = await request(`${API}/proofs/${item.id}/approve`, {cert_id: input.value, confirm_similar: confirming});
      if (r.needs_confirmation) { confirming = true; msg.className = 'proof-msg warn'; msg.textContent = r.message; ok.textContent = 'Confirm: different certificate'; return; }
      await load();
    } catch (e) { msg.className = 'proof-msg'; msg.textContent = asRequestError(e).message; }
    finally { release(ok); }
  });
  no.addEventListener('click', async () => {
    busy(no, true, 'Saving…');
    try { await request(`${API}/proofs/${item.id}/${flagged ? 'keep' : 'reject'}`, {}); await load(); }
    catch (e) { msg.className = 'proof-msg'; msg.textContent = asRequestError(e).message; }
    finally { release(no); }
  });
  const actions = el('div', 'proof-actions'); actions.append(ok, no);
  body.append(row, actions, msg);
  return card;
}

document.querySelectorAll('#kinds button').forEach(b => b.addEventListener('click', () => {
  if (kind === b.dataset.kind) return;
  kind = b.dataset.kind; offset = 0; load().catch(fail);
}));
$('#prev').addEventListener('click', () => { offset = Math.max(0, offset - PAGE); load().catch(fail); });
$('#next').addEventListener('click', () => { offset += PAGE; load().catch(fail); });
$('#refresh').addEventListener('click', () => load().catch(fail));
$('#csv').addEventListener('click', () => { location.href = `${API}/export.csv`; });
load().catch(fail);
})();
