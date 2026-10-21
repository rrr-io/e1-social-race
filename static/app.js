const $ = s => document.querySelector(s);
const fmt = n => n == null ? '—' : new Intl.NumberFormat('en-GB').format(n);
const date = n => n ? new Date(n * 1000).toLocaleString('en-GB') : '—';
const escape = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const states = {queued:'Queued', collecting:'Collecting', ok:'Up to date', partial:'Partial data', error:'Last attempt failed'};
let posts = [];
async function api(path, payload) {
  const response = await fetch(path, payload === undefined ? {} : {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function delta(p, k) {
  const a = p.latest?.[k], b = p.baseline?.[k];
  if (a == null || b == null) return 'Δ unavailable';
  if (p.latest.id === p.baseline.id) return 'First snapshot';
  const d = a - b;
  return `${d >= 0 ? '+' : ''}${fmt(d)} since first snapshot`;
}
function render() {
  $('#total').textContent = posts.length;
  const query = $('#search').value.toLowerCase();
  const platform = $('#platform').value;
  const selected = posts.filter(p => (!platform || p.platform === platform) && `${p.label} ${p.title} ${p.team} ${p.url}`.toLowerCase().includes(query));
  $('#posts').innerHTML = selected.length ? selected.map(p => `<article class="card">
    <div class="card-top"><span class="platform">${escape(p.platform)}</span><span class="badge ${escape(p.status)}">${p.paused ? 'Paused · ' : ''}${escape(states[p.status] || p.status)}</span></div>
    <h3><a href="${escape(p.url)}" target="_blank" rel="noopener noreferrer">${escape(p.label || p.title || p.remote_id)} ↗</a></h3>
    <p class="team">${escape(p.team || 'No team assigned')}</p>
    <div class="metrics">${[['views','Views'],['likes','Likes'],['comments','Comments']].map(([k,t]) => `<div class="metric"><span>${t}</span><strong>${fmt(p.latest?.[k])}</strong><small>${escape(delta(p,k))}</small></div>`).join('')}</div>
    <p class="meta">Latest data: ${date(p.latest?.collected_at)}${p.latest ? ` · ${escape(p.latest.source)}` : ''}<br>Last attempt: ${date(p.last_attempt)}<br>Next check: ${p.paused ? 'paused' : p.status === 'collecting' ? 'in progress' : p.next_check ? date(p.next_check) : 'queued'}</p>
    ${p.error ? `<p class="error-text">${escape(p.error)} ${p.latest ? 'Displayed values are from the last available snapshot.' : ''}</p>` : ''}
    <div class="actions"><button data-action="history" data-id="${p.id}">History</button><a href="/api/posts/${p.id}/export">↓ CSV</a><button data-action="refresh" data-id="${p.id}" ${p.status==='collecting' ? 'disabled' : ''}>Refresh</button><button data-action="pause" data-id="${p.id}">${p.paused?'Resume':'Pause'}</button><button class="delete" data-action="delete" data-id="${p.id}" aria-label="Delete post">×</button></div>
  </article>`).join('') : `<div class="empty"><strong>${posts.length ? 'No results' : 'Your next post starts here.'}</strong>${posts.length ? 'Try changing your filters.' : 'Paste a link above to start tracking its history.'}</div>`;
}
async function reload() {
  const data = await api('/api/posts');
  posts = data.posts;
  $('#interval').textContent = `Every ${data.interval_minutes} minutes`;
  render();
}
function error(e) { $('#message').textContent = e.message; }
$('#add-form').addEventListener('submit', async e => {
  e.preventDefault();
  const button = e.target.querySelector('button'); button.disabled = true;
  try {
    await api('/api/posts', Object.fromEntries(new FormData(e.target)));
    e.target.reset(); $('#message').textContent = 'Post added. The first check is queued.'; await reload();
  } catch(e) { error(e); } finally { button.disabled = false; }
});
$('#posts').addEventListener('click', async e => {
  const b = e.target.closest('button[data-action]'); if (!b) return;
  const {id, action} = b.dataset;
  try {
    if (action === 'history') {
      const history = await api(`/api/posts/${id}/history`);
      const post = posts.find(p => String(p.id) === id);
      $('#history-title').textContent = post.label || post.title || 'Post history';
      $('#history-content').innerHTML = history.length ? `<table><thead><tr><th>Snapshot</th><th>Views</th><th>Likes</th><th>Comments</th><th>Source</th></tr></thead><tbody>${history.slice().reverse().map(r => `<tr><td>${date(r.collected_at)}</td><td>${fmt(r.views)}</td><td>${fmt(r.likes)}</td><td>${fmt(r.comments)}</td><td>${escape(r.source)}</td></tr>`).join('')}</tbody></table>` : '<p>No snapshots available. Check the post status.</p>';
      $('#history').showModal(); return;
    }
    if (action === 'delete' && !confirm('Delete this post and its entire history?')) return;
    b.disabled = true;
    await api(`/api/posts/${id}/${action}`, {});
    $('#message').textContent = action === 'refresh' ? 'Refresh queued.' : '';
    await reload();
  } catch(e) { error(e); b.disabled = false; }
});
$('#close-history').addEventListener('click', () => $('#history').close());
$('#search').addEventListener('input', render);
$('#platform').addEventListener('change', render);
reload().catch(error);
setInterval(() => reload().catch(error), 10000);
