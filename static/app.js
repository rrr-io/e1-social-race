(() => {
'use strict';
const {request, asRequestError, toast, inlineMessage, fmt, local, labelCells, busy} = window.E1;
const $ = s => document.querySelector(s);
const states = {queued: 'Queued', collecting: 'Collecting…', ok: 'Up to date', partial: 'Partial data', error: 'Last check failed'};
const POLL_MS = 10000;
let posts = [];
let loaded = false;
let pollFailing = false;

const needsAttention = p => p.status === 'error' || p.status === 'partial';

function delta(p, k) {
  const a = p.latest?.[k], b = p.baseline?.[k];
  if (a == null || b == null) return 'No change data';
  if (p.latest.id === p.baseline.id) return 'First snapshot';
  const d = a - b;
  return `${d >= 0 ? '+' : ''}${fmt(d)} since first`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function card(p) {
  const article = el('article', `card${needsAttention(p) ? ' needs-attention' : ''}${p.paused ? ' is-paused' : ''}`);
  const top = el('div', 'card-top');
  top.append(el('span', 'platform', p.platform));
  top.append(el('span', `badge ${p.status}`, `${p.paused ? 'Paused · ' : ''}${states[p.status] || p.status}`));
  article.append(top);
  const h3 = el('h3'); const link = el('a', null, `${p.label || p.title || p.remote_id} ↗`);
  link.href = p.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; h3.append(link); article.append(h3);
  const metrics = el('div', 'metrics');
  for (const [k, t] of [['views', 'Views'], ['likes', 'Likes'], ['comments', 'Comments']]) {
    const m = el('div', 'metric'); m.append(el('span', null, t), el('strong', null, fmt(p.latest?.[k])), el('small', null, delta(p, k))); metrics.append(m);
  }
  article.append(metrics);
  if (p.error) {
    const box = el('div', 'card-error');
    box.append(el('strong', null, 'Last check failed'));
    box.append(el('p', null, `${p.error}${p.latest ? ' The numbers above are from the last successful snapshot.' : ''}`));
    article.append(box);
  }
  const meta = el('p', 'meta');
  const next = p.paused ? 'paused' : p.status === 'collecting' ? 'in progress' : p.next_check ? local(p.next_check) : 'queued';
  meta.textContent = `Latest data: ${local(p.latest?.collected_at)}${p.latest ? ` · ${p.latest.source}` : ''} · Last attempt: ${local(p.last_attempt)} · Next check: ${next}`;
  article.append(meta);
  const actions = el('div', 'actions');
  const button = (action, text, extra = {}) => {
    const b = el('button', extra.className || null, text); b.type = 'button'; b.dataset.action = action; b.dataset.id = p.id;
    if (extra.label) b.setAttribute('aria-label', extra.label);
    if (extra.disabled) b.disabled = true;
    actions.append(b); return b;
  };
  button('history', 'History');
  const csv = el('a', null, '↓ CSV'); csv.href = `/api/posts/${p.id}/export`; csv.setAttribute('download', ''); actions.append(csv);
  button('refresh', 'Refresh', {disabled: p.status === 'collecting'});
  button('pause', p.paused ? 'Resume' : 'Pause');
  button('delete', 'Delete', {className: 'delete', label: `Delete ${p.label || 'post'}`});
  article.append(actions);
  return article;
}

function render() {
  if (!loaded) return;
  $('#total').textContent = posts.length;
  const attention = posts.filter(needsAttention).length;
  const badge = $('#attention-count'); if (badge) badge.textContent = attention ? String(attention) : '';
  const query = $('#search').value.trim().toLowerCase();
  const platform = $('#platform').value;
  const status = $('#status-filter').value;
  const selected = posts.filter(p => (!platform || p.platform === platform)
    && (!status || (status === 'attention' ? needsAttention(p) : p.paused))
    && `${p.label} ${p.title} ${p.team} ${p.url}`.toLowerCase().includes(query));
  const list = $('#posts');
  list.removeAttribute('aria-busy');
  if (!selected.length) {
    const empty = el('div', 'empty');
    if (posts.length) {
      empty.append(el('strong', null, 'No posts match'), el('span', null, 'Try a different search or clear the filters.'));
      const clear = el('button', 'btn-ghost', 'Clear filters'); clear.type = 'button';
      clear.addEventListener('click', () => { $('#search').value = ''; $('#platform').value = ''; $('#status-filter').value = ''; render(); });
      empty.append(clear);
    } else {
      empty.append(el('strong', null, 'No posts tracked yet'), el('span', null, 'Paste an Instagram or TikTok link above to start collecting its counts.'));
    }
    list.replaceChildren(empty);
    return;
  }
  // Problems first so they are not buried in a long list.
  selected.sort((a, b) => needsAttention(b) - needsAttention(a));
  list.replaceChildren(...selected.map(card));
}

function setTrackerMessage(kind, text) { inlineMessage($('#tracker-message'), kind, text); }

async function reload() {
  const data = await request('/api/posts');
  posts = data.posts; loaded = true;
  $('#interval').textContent = `every ${data.interval_minutes} minutes`;
  if (pollFailing) { pollFailing = false; setTrackerMessage('info', ''); toast('success', 'Back online', 'Post data is updating again.'); }
  render();
}

function pollError(error) {
  const problem = asRequestError(error);
  if (!loaded) {
    const list = $('#posts'); list.removeAttribute('aria-busy');
    const empty = el('div', 'empty is-error');
    empty.append(el('strong', null, problem.title), el('span', null, problem.message));
    const retry = el('button', 'btn-ghost', 'Try again'); retry.type = 'button';
    retry.addEventListener('click', () => { busy(retry, true, 'Retrying…'); reload().catch(pollError); });
    empty.append(retry);
    list.replaceChildren(empty);
    return;
  }
  if (!pollFailing) {
    pollFailing = true;
    setTrackerMessage('error', `${problem.title}: ${problem.message} Showing the last loaded data; retrying automatically.`);
  }
}

$('#add-form').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.target, button = form.querySelector('button');
  busy(button, true, 'Adding…');
  setTrackerMessage('progress', '');
  try {
    const payload = Object.fromEntries(new FormData(form));
    await request('/api/posts', payload);
    form.reset();
    document.dispatchEvent(new Event('posts-changed'));
    setTrackerMessage('success', `“${payload.label}” is now tracked. The first check is queued — register it in the Register tab when it's an official race post.`);
    toast('success', 'Post added', 'The first check is queued.');
    await reload().catch(pollError);
  } catch (error) {
    setTrackerMessage('error', asRequestError(error).message);
    form.elements.url.focus();
  } finally { busy(button, false); button.disabled = false; }
});

$('#posts').addEventListener('click', async e => {
  const b = e.target.closest('button[data-action]'); if (!b) return;
  const {id, action} = b.dataset;
  const post = posts.find(p => String(p.id) === id);
  const name = post?.label || post?.title || 'this post';
  try {
    if (action === 'history') {
      busy(b, true, 'Loading…');
      const history = await request(`/api/posts/${id}/history`);
      $('#history-title').textContent = name;
      const content = $('#history-content');
      if (history.length) {
        const table = el('table'), head = el('thead'), body = el('tbody'), hr = el('tr');
        for (const h of ['Snapshot', 'Views', 'Likes', 'Comments', 'Source']) hr.append(el('th', null, h));
        head.append(hr);
        for (const r of history.slice().reverse()) {
          const tr = el('tr');
          for (const v of [local(r.collected_at), fmt(r.views), fmt(r.likes), fmt(r.comments), r.source]) tr.append(el('td', null, v));
          body.append(tr);
        }
        table.append(head, body); content.replaceChildren(table); labelCells(table);
      } else {
        content.replaceChildren(el('p', 'empty-note', 'No snapshots yet. Check the post status: the first check may still be queued or may have failed.'));
      }
      $('#history').showModal();
      return;
    }
    if (action === 'delete' && !confirm(`Delete “${name}” and its entire history? This cannot be undone.`)) return;
    busy(b, true, action === 'delete' ? 'Deleting…' : action === 'refresh' ? 'Queuing…' : 'Saving…');
    await request(`/api/posts/${id}/${action}`, {});
    if (action === 'delete') document.dispatchEvent(new Event('posts-changed'));
    const done = {refresh: ['Refresh queued', `“${name}” will be checked in a moment.`], pause: [post?.paused ? 'Tracking resumed' : 'Tracking paused', `“${name}”`], delete: ['Post deleted', `“${name}” and its history were removed.`]}[action];
    if (done) toast('success', ...done);
    await reload().catch(pollError);
  } catch (error) {
    const problem = asRequestError(error);
    toast('error', problem.title, problem.message);
  } finally {
    busy(b, false);
    if (b.isConnected) b.disabled = false;
  }
});

$('#close-history').addEventListener('click', () => $('#history').close());
$('#history').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });
$('#search').addEventListener('input', render);
$('#platform').addEventListener('change', render);
$('#status-filter').addEventListener('change', render);
reload().catch(pollError);
setInterval(() => { if (!document.hidden) reload().catch(pollError); }, POLL_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) reload().catch(pollError); });
document.addEventListener('race-saved', () => reload().catch(pollError));
})();
