(() => {
'use strict';
const {request, asRequestError, toast, fmt, busy, labelCells} = window.E1;
const $ = s => document.querySelector(s);
const token = location.pathname.split('/').pop();
const API = `/api/collab-report/${encodeURIComponent(token)}`;
const TILES = [['valid', 'Valid proofs', 'primary'], ['files', 'Files received'], ['duplicate', 'Duplicates'], ['manual', 'To verify'],
  ['not_enhypen', 'Not ENHYPEN'], ['not_partner', 'Wrong partner image'], ['rejected', 'Rejected']];
const COUNTS = ['files', 'duplicate', 'not_enhypen', 'not_partner', 'manual', 'rejected'];
const niceDay = d => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', {day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'});

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

async function load() {
  let body;
  try { body = await request(API); }
  catch (error) {
    const e = asRequestError(error);
    if (e.status === 404) { $('#gone-text').textContent = e.message; $('#gone').hidden = false; $('#content').hidden = true; return; }
    throw error;
  }
  $('#title').textContent = body.fandom;
  document.title = `${body.fandom} · collab report`;
  const n = body.days.length;
  $('#subtitle').textContent = n ? `${n} day${n === 1 ? '' : 's'} of proofs, ${n === 1 ? niceDay(body.first) : `from ${niceDay(body.first)} to ${niceDay(body.last)}`}.` : 'No proofs yet.';
  const tiles = $('#tiles'); tiles.replaceChildren();
  for (const [key, label, extra] of TILES) {
    const tile = el('div', `tile${extra ? ' ' + extra : ''}`); tile.append(el('strong', null, fmt(body.totals[key])), el('span', null, label)); tiles.append(tile);
  }
  const rows = $('#days-body'); rows.replaceChildren();
  for (const d of [...body.days].reverse()) {
    const tr = el('tr');
    tr.append(el('td', null, niceDay(d.day)));
    const valid = el('td', 'num'); valid.append(el('strong', null, fmt(d.valid))); tr.append(valid);
    for (const k of COUNTS) tr.append(el('td', 'num', fmt(d[k])));
    const open = el('td'), link = el('button', 'btn-ghost', 'Open'); link.type = 'button';
    link.setAttribute('aria-label', `Open the report of ${niceDay(d.day)}`);
    link.addEventListener('click', () => window.open(`/report/${encodeURIComponent(d.report)}`, '_blank', 'noopener,noreferrer'));
    open.append(link); tr.append(open);
    rows.append(tr);
  }
  if (!n) { const tr = el('tr'); const td = el('td', 'muted', 'No proofs uploaded yet.'); td.colSpan = 9; tr.append(td); rows.append(tr); }
  else {
    const tr = el('tr', 'total'); tr.append(el('td', null, 'Total'), el('td', 'num', fmt(body.totals.valid)));
    for (const k of COUNTS) tr.append(el('td', 'num', fmt(body.totals[k])));
    tr.append(el('td')); rows.append(tr);
  }
  labelCells($('#days-table'));
  $('#content').hidden = false;
}

$('#refresh').addEventListener('click', async () => {
  const b = $('#refresh'); busy(b, true, 'Refreshing…');
  try { await load(); } catch (e) { const x = asRequestError(e); toast('error', x.title, x.message); } finally { busy(b, false); b.disabled = false; }
});
$('#csv').addEventListener('click', () => { location.href = `${API}/export.csv`; });
load().catch(e => { const x = asRequestError(e); toast('error', x.title, x.message); });
})();
