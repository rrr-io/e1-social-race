(() => {
'use strict';
const {request, asRequestError, toast, inlineMessage, fmt, kst, local, duration, labelCells, teamKey, busy} = window.E1;
const admin = document.body.dataset.admin === 'true';
const $ = id => document.getElementById(id);
const REFRESH_MS = 60000;
let frozen = false;
let lastData = null;
let lastLoadedAt = 0;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function cell(row, text, className) { const td = el('td', className, text); row.append(td); return td; }
function emptyRow(tbody, text, columns) { const row = el('tr', 'empty-row'); const td = cell(row, text); td.colSpan = columns; tbody.append(row); }
function options(element, items, label) {
  const previous = element.value; element.replaceChildren();
  for (const item of items) { const option = el('option', null, label(item)); option.value = item.id; element.append(option); }
  if (items.some(item => String(item.id) === previous)) element.value = previous;
}
const kstInput = seconds => new Date((seconds + 9 * 3600) * 1000).toISOString().slice(0, 16);
const now = () => Date.now() / 1000;

// The six E1 teams: the only choices when pairing a team with its creator.
const E1_TEAMS = ['TEAM MCJAKEY', 'TEAM JAYBULL RACING', 'TEAM ALPINOO', 'TEAM HOONRARI', 'TEAM MEOWCEDES', 'TEAM RIKSTON DRIFT'];
const sameTeam = (a, b) => teamKey(a) !== 'other' ? teamKey(a) === teamKey(b) : String(a).toLowerCase() === String(b).toLowerCase();

// Date + time pickers that post one "YYYY-MM-DDTHH:MM" (KST) value. Two small native
// pickers behave better on phones than datetime-local, which iOS renders oddly.
function dateTimeField(labelText, name, hintText) {
  const field = el('div', 'field dt-field');
  field.append(el('span', 'field-label', labelText));
  const hidden = el('input'); hidden.type = 'hidden'; hidden.name = name;
  const row = el('div', 'dt');
  const date = el('input'); date.type = 'date'; date.required = true; date.setAttribute('aria-label', `${labelText}, date`);
  const time = el('input'); time.type = 'time'; time.required = true; time.step = 60; time.setAttribute('aria-label', `${labelText}, time`);
  for (const [input, caption] of [[date, 'Date'], [time, 'Time']]) { const part = el('label', 'dt-part'); part.append(el('span', null, caption), input); row.append(part); }
  const sync = () => { hidden.value = date.value && time.value ? `${date.value}T${time.value.slice(0, 5)}` : ''; };
  for (const input of [date, time]) { input.addEventListener('input', sync); input.addEventListener('change', sync); }
  hidden.setValue = value => { date.value = value ? value.slice(0, 10) : ''; time.value = value ? value.slice(11, 16) : ''; sync(); };
  hidden.setRange = (min, max) => {
    if (min) date.min = min.slice(0, 10); else date.removeAttribute('min');
    if (max) date.max = max.slice(0, 10); else date.removeAttribute('max');
  };
  field.append(hidden, row);
  const hint = el('small', 'field-hint', hintText || ''); if (hintText) field.append(hint);
  field.hint = hint;
  return field;
}
function resetForm(form) {
  form.reset();
  form.querySelectorAll('input[type="hidden"]').forEach(input => { if (input.setValue) input.setValue(''); else if (input.name !== 'post_id') input.value = ''; });
}

// Rules -------------------------------------------------------------------
const PLATFORMS = ['instagram', 'tiktok'];
const PLATFORM_NAME = {instagram: 'Instagram', tiktok: 'TikTok'};
const metricOf = (data, platform) => (data.metrics || {})[platform] || (platform === 'tiktok' ? 'views' : 'likes');
function rulesText(data) {
  return `Instagram ranks creators by likes, TikTok by views. Each leaderboard has its own podium.`;
}

// Header / hero -----------------------------------------------------------
function renderHero(data) {
  const chip = $('state-chip');
  if (!chip) return;
  const t = now();
  let kind = 'accent', label = 'Live · provisional', countdown;
  if (data.state === 'Final') { kind = 'ok'; label = 'Final results'; countdown = data.finalized_at ? `Results published ${kst(data.finalized_at)} KST.` : 'Results are final.'; }
  else if (data.simulation) { kind = 'warn'; label = 'Simulation · not official'; }
  if (!countdown) {
    if (t < data.start) { countdown = `Lights out in ${duration(data.start - t)}`; if (!data.simulation) label = 'Starting soon'; }
    else if (t < data.end) countdown = `Chequered flag in ${duration(data.end - t)}`;
    else { countdown = 'Race closed · final results coming soon'; kind = 'warn'; label = 'Closed · awaiting final check'; }
  }
  chip.className = `chip ${kind}`.trim();
  chip.textContent = label;
  $('countdown').textContent = countdown;
  renderEventNow(data, t);
  renderOverall(data, t);
  renderLeaderTheme(data);
  const observed = (data.entries || []).map(e => e.observed_at).filter(Boolean);
  if ($('latest-line')) $('latest-line').textContent = `Counts are taken daily at 22:00 KST${observed.length ? `; latest ${kst(Math.max(...observed))} KST` : ''}.`;
}

const dayFormat = new Intl.DateTimeFormat('en-GB', {timeZone: 'Asia/Seoul', day: 'numeric', month: 'short'});
const day = seconds => dayFormat.format(new Date(seconds * 1000));

// Which posting event is open right now, or the next one.
function renderEventNow(data, t) {
  const box = $('event-now');
  if (!box) return;
  const events = [...(data.events || [])].sort((a, b) => a.starts - b.starts);
  const live = events.filter(e => e.starts <= t && t <= e.ends);
  const next = events.find(e => e.starts > t);
  const label = box.querySelector('.event-label');
  box.classList.toggle('is-live', live.length > 0);
  let fill = 0;
  if (live.length) {
    const soonest = live.reduce((a, b) => (a.ends <= b.ends ? a : b));
    label.textContent = live.length > 1 ? `${live.length} posting events open` : 'Posting event open';
    $('event-name').textContent = live.map(e => e.name).join(' · ');
    $('event-when').textContent = `Closes in ${duration(soonest.ends - t)} · ${kst(soonest.ends)} KST`;
    fill = (t - soonest.starts) / (soonest.ends - soonest.starts);
  } else if (next && data.state !== 'Final') {
    label.textContent = 'Next posting event';
    $('event-name').textContent = next.name;
    $('event-when').textContent = `Opens in ${duration(next.starts - t)} · ${kst(next.starts)} KST`;
  } else {
    label.textContent = 'Posting events';
    $('event-name').textContent = events.length ? 'All posting events have closed' : 'Schedule coming soon';
    $('event-when').textContent = events.length ? `${events.length} ${events.length === 1 ? 'event' : 'events'} in this Grand Prix` : 'Events appear here once the organisers add them.';
  }
  $('event-fill').style.width = `${Math.round(Math.min(Math.max(fill, 0), 1) * 100)}%`;
}

// Whole Grand Prix: day N of M and a progress bar.
function renderOverall(data, t) {
  if (!$('overall-bar')) return;
  const total = Math.ceil((data.end - data.start) / 86400);
  const share = Math.min(Math.max((t - data.start) / (data.end - data.start), 0), 1);
  let text;
  if (t < data.start) text = `${total} days · starts ${day(data.start)}`;
  else if (t <= data.end) text = `Day ${Math.min(Math.floor((t - data.start) / 86400) + 1, total)} of ${total}`;
  else text = `Finished · ${total} days`;
  $('overall-day').textContent = text;
  $('overall-fill').style.width = `${Math.round(share * 100)}%`;
  $('overall-bar').setAttribute('aria-valuenow', String(Math.round(share * 100)));
  $('overall-bar').setAttribute('aria-valuetext', text);
  $('overall-start').textContent = `${kst(data.start)} KST`;
  $('overall-end').textContent = `${kst(data.end)} KST`;
}

const soleLeader = rows => { const top = (rows || []).filter(r => r.rank === 1 && r.score != null); return top.length === 1 ? top[0] : null; };

// Desktop stays neutral (E1 colours). On phones only one leaderboard is visible,
// so the page takes the colours of that leaderboard's P1 team.
const phone = window.matchMedia('(max-width: 820px)');
const activeBoard = () => document.querySelector('.boards')?.dataset.show || 'instagram';
function renderLeaderTheme(data) {
  if (admin || !data) return;
  const leaders = Object.fromEntries(PLATFORMS.map(p => [p, soleLeader(data.boards?.[p])]));
  const shown = phone.matches ? leaders[activeBoard()] : null;
  const key = shown ? teamKey(shown.team) : 'other';
  if (key !== 'other') document.body.dataset.leader = key; else delete document.body.dataset.leader;
  const chip = $('leader-chip');
  if (chip) {
    if (phone.matches) {
      chip.hidden = !shown;
      if (shown) chip.textContent = `${shown.team} · ${PLATFORM_NAME[activeBoard()]} P1`;
    } else {
      chip.hidden = !leaders.instagram && !leaders.tiktok;
      chip.textContent = PLATFORMS.map(p => leaders[p] ? `${PLATFORM_NAME[p]} P1: ${leaders[p].team}` : null).filter(Boolean).join(' · ');
    }
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(document.body).getPropertyValue('--accent-soft').trim() || '#0a0a0c';
}
phone.addEventListener?.('change', () => renderLeaderTheme(lastData));

// Only show leaderboards that have registered posts. Before any post exists
// on either platform, both stay visible as an empty grid.
function showBoardsWithPosts(data) {
  const boards = document.querySelector('.boards');
  if (!boards || admin) return;
  const live = PLATFORMS.filter(p => (data.entries || []).some(e => e.platform === p));
  const visible = live.length ? live : PLATFORMS;
  for (const platform of PLATFORMS) {
    const board = boards.querySelector(`.board[data-platform="${platform}"]`);
    if (board) board.hidden = !visible.includes(platform);
  }
  boards.classList.toggle('single', visible.length === 1);
  const tabs = document.querySelector('.board-tabs');
  if (tabs) tabs.hidden = visible.length === 1;
  if (!visible.includes(boards.dataset.show)) {
    boards.dataset.show = visible[0];
    document.querySelectorAll('.board-tabs [data-board]').forEach(t => t.setAttribute('aria-selected', String(t.dataset.board === visible[0])));
  }
  const rules = $('rules');
  if (rules && visible.length === 1) rules.textContent = `${PLATFORM_NAME[visible[0]]} ranks creators by ${metricOf(data, visible[0])}. The ${PLATFORM_NAME[PLATFORMS.find(p => p !== visible[0])]} leaderboard appears once its first post is registered.`;
}

// Standings: one timing tower per platform (public) or a table (admin) ----------------
function renderTower(data) {
  for (const platform of PLATFORMS) {
    const tower = $(`tower-${platform}`);
    if (!tower) continue;
    const rows = data.boards?.[platform] || [];
    const leader = soleLeader(rows);
    tower.replaceChildren();
    tower.removeAttribute('aria-busy');
    if (!rows.length) {
      const li = el('li', 'tower-empty');
      li.append(el('strong', null, 'The grid is empty for now'), el('span', null, `${PLATFORM_NAME[platform]} creators appear here once the organisers register them.`));
      tower.append(li);
      continue;
    }
    const unit = metricOf(data, platform);
    for (const row of rows) {
      const li = el('li', 'tower-row');
      li.dataset.team = teamKey(row.team);
      if (row.rank && row.rank <= 3) li.classList.add(`podium-${row.rank}`);
      if (row.score == null) li.classList.add('is-pending');
      li.append(el('span', 'pos', row.rank ? `P${row.rank}` : '—'), el('span', 'team-bar'));
      const who = el('div', 'who');
      who.append(el('strong', null, row.team), el('span', null, `${row.creator || 'Creator to be announced'} · ${row.posts} ${row.posts === 1 ? 'post' : 'posts'}`));
      li.append(who);
      const score = el('div', 'score');
      if (row.score != null) {
        score.append(el('strong', null, fmt(row.score)));
        score.append(el('span', 'gap', leader && row !== leader ? `−${fmt(leader.score - row.score)}` : leader ? `${unit} · leader` : unit));
      } else {
        score.append(el('strong', 'pending', row.posts ? 'Pending' : '—'));
        score.append(el('span', 'gap', row.posts ? `${row.missing} ${row.missing === 1 ? 'post' : 'posts'} awaiting counts` : 'No posts yet'));
      }
      li.append(score);
      const bonus = el('span', 'bonus');
      if (row.bonus_percent) {
        bonus.classList.add('chip', 'accent');
        bonus.textContent = `+${row.bonus_percent}%${row.bonus_points == null ? '' : ` · ${fmt(row.bonus_points)} GP`}`;
        bonus.title = 'Grand Prix bonus preview';
      } else if (row.rank && row.rank <= 3 && row.bonus_percent == null) {
        bonus.classList.add('chip', 'warn'); bonus.textContent = 'Tie';
        bonus.title = 'Tied on the podium: the bonus stays unresolved until a tie-break is agreed.';
      }
      li.append(bonus);
      li.setAttribute('aria-label', `${PLATFORM_NAME[platform]}: ${row.rank ? `position ${row.rank}` : 'not ranked'}, ${row.team}, ${row.creator || ''}, ${row.score != null ? `${fmt(row.score)} ${unit}` : 'score pending'}`);
      tower.append(li);
    }
  }
}

function renderTeamsTable(data) {
  const body = $('teams');
  if (!body) return;
  body.replaceChildren();
  for (const platform of PLATFORMS) {
    for (const row of data.boards?.[platform] || []) {
      const tr = el('tr'); tr.dataset.team = teamKey(row.team);
      cell(tr, `${PLATFORM_NAME[platform]} · ${metricOf(data, platform)}`);
      cell(tr, row.rank ? `P${row.rank}` : '—');
      cell(tr, `${row.team} / ${row.creator || '—'}`);
      cell(tr, fmt(row.posts));
      cell(tr, row.missing ? `Pending (${row.missing} incomplete)` : fmt(row.score));
      cell(tr, row.bonus_percent == null ? '—' : `${row.bonus_percent}%${row.bonus_points == null ? '' : ` · ${fmt(row.bonus_points)} points`}`);
      body.append(tr);
    }
  }
  if (!body.children.length) emptyRow(body, 'No teams registered yet.', 6);
  labelCells(body.closest('table'));
}

// Official posts --------------------------------------------------------------
function syncFilter(select, items, label) {
  if (!select) return;
  const previous = select.value;
  select.replaceChildren(select.options[0] || el('option'));
  for (const item of items) { const option = el('option', null, label(item)); option.value = item.id; select.append(option); }
  select.value = items.some(i => String(i.id) === previous) ? previous : '';
}

function renderEntries(data) {
  const body = $('entries');
  if (!body) return;
  const teamOf = id => data.teams.find(t => t.id === id) || (data.available_teams || []).find(t => t.id === id);
  const eventOf = id => (data.events || []).find(e => e.id === id) || (data.available_events || []).find(e => e.id === id);
  const teamFilter = $('team-filter'), eventFilter = $('event-filter');
  syncFilter(teamFilter, data.teams, t => t.name);
  syncFilter(eventFilter, data.events || [], e => e.name);
  const rankOrder = new Map(data.teams.map((t, i) => [t.id, i]));
  const entries = data.entries
    .filter(e => !teamFilter?.value || String(e.team_id) === teamFilter.value)
    .filter(e => !eventFilter?.value || String(e.event_id) === eventFilter.value)
    .sort((a, b) => (rankOrder.get(a.team_id) ?? 99) - (rankOrder.get(b.team_id) ?? 99) || (eventOf(a.event_id)?.starts || 0) - (eventOf(b.event_id)?.starts || 0) || a.platform.localeCompare(b.platform));
  body.replaceChildren();
  for (const entry of entries) {
    const row = el('tr');
    const team = teamOf(entry.team_id);
    row.dataset.team = teamKey(team?.name);
    const teamCell = cell(row, '', 'team-cell');
    teamCell.append(el('span', 'dot', ''), document.createTextNode(team?.name || 'Unknown team'));
    const creator = team?.creators?.[entry.platform];
    if (creator) teamCell.append(el('small', 'creator', creator));
    cell(row, eventOf(entry.event_id)?.name || 'Unknown event');
    const link = el('a', 'post-link', `${entry.platform === 'tiktok' ? 'TikTok' : entry.platform === 'instagram' ? 'Instagram' : entry.platform} ↗`);
    link.href = entry.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', `Open the ${entry.platform} post of ${team?.name || 'this team'} (new tab)`);
    cell(row, '').append(link);
    for (const key of ['likes', 'comments', 'views']) cell(row, fmt(entry.metrics?.[key]), key === entry.metric ? 'num counted' : 'num');
    cell(row, fmt(entry.score), 'num strong');
    cell(row, entry.observed_at ? kst(entry.observed_at) : '—');
    const source = cell(row, '');
    if (!entry.metrics) { row.classList.add('is-missing'); source.append(el('span', 'chip warn', 'Awaiting counts')); }
    else if (entry.score == null) source.append(el('span', 'chip warn', `${entry.source} · no ${metricOf(data, entry.platform)}`));
    else { source.append(el('span', entry.source === 'manual' ? 'chip accent' : 'chip', entry.source)); if (entry.source !== 'manual') source.classList.add('src-auto'); }
    body.append(row);
  }
  if (!entries.length) emptyRow(body, data.entries.length ? 'No posts match these filters.' : 'No official posts yet. They appear here once registered.', 9);
  const filters = teamFilter?.closest('.filters'); if (filters) filters.hidden = !data.entries.length;
  const count = $('post-count');
  if (count) count.textContent = data.entries.length ? (entries.length === data.entries.length ? `${entries.length}` : `${entries.length} of ${data.entries.length}`) : '';
  labelCells(body.closest('table'));
}

// Load + errors ------------------------------------------------------------------
function showLoadError(error, {stale}) {
  const banner = $('load-banner') || $('message');
  if (!banner) return;
  banner.replaceChildren();
  banner.hidden = false;
  banner.className = `banner ${stale ? 'is-warn' : 'is-error'}`;
  const text = el('div');
  text.append(el('strong', null, stale ? "Couldn't refresh the standings" : error.title));
  text.append(el('p', null, stale ? `${error.message} You're seeing data loaded at ${new Date(lastLoadedAt).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}.` : error.message));
  banner.append(text);
  if (error.retryable || stale) {
    const retry = el('button', 'btn-ghost', 'Try again'); retry.type = 'button';
    retry.addEventListener('click', async () => { busy(retry, true, 'Retrying…'); await refresh(); });
    banner.append(retry);
  }
  if (!lastData) {
    for (const tower of document.querySelectorAll('.tower')) {
      tower.removeAttribute('aria-busy');
      const li = el('li', 'tower-empty');
      li.append(el('strong', null, 'Standings unavailable'), el('span', null, 'They will appear here as soon as the server responds.'));
      tower.replaceChildren(li);
    }
    const body = $('entries');
    if (body) { body.replaceChildren(); emptyRow(body, 'Posts unavailable right now.', 9); }
  }
}
function clearLoadError() {
  const banner = $('load-banner') || $('message');
  if (banner) { banner.hidden = true; banner.replaceChildren(); banner.className = banner.id === 'message' ? '' : 'banner'; }
}

async function load() {
  const data = await request(admin ? '/api/race/admin' : '/api/race');
  lastData = data; lastLoadedAt = Date.now();
  frozen = data.state === 'Final';
  if ($('status')) $('status').textContent = `${data.state} · Opens ${kst(data.start)} KST · Closes ${kst(data.end)} KST`;
  if ($('rules')) $('rules').textContent = rulesText(data);
  showBoardsWithPosts(data);
  renderHero(data); renderTower(data); renderTeamsTable(data); renderEntries(data);
  if ($('refreshed')) $('refreshed').textContent = `Checked for updates at ${new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})} (your time) · refreshes every minute.`;
  if (admin) renderAdmin(data);
  document.dispatchEvent(new CustomEvent('race-loaded', {detail: data}));
  clearLoadError();
}
async function refresh() {
  try { await load(); }
  catch (error) { showLoadError(asRequestError(error), {stale: Boolean(lastData)}); }
}

// Admin --------------------------------------------------------------------------
function renderAdmin(data) {
  const teams = data.available_teams || data.teams;
  renderEvents(data);
  document.querySelectorAll('.team-options').forEach(select => options(select, teams, t => t.name));
  renderRegistration(data);
  renderSetupTeams(data, teams);
  renderTeamSelect(teams);
  const teamName = id => teams.find(t => t.id === id)?.name || 'Unknown';
  const eventName = id => (data.available_events || data.events).find(e => e.id === id)?.name || 'Unknown';
  const entrySelect = $('entry-options');
  options(entrySelect, data.entries, e => `${teamName(e.team_id)} / ${eventName(e.event_id)} / ${e.platform}`);
  if (!data.entries.length) { const option = el('option', null, 'No registered posts yet'); option.value = ''; entrySelect.append(option); }
  const audit = $('audit'); audit.replaceChildren();
  for (const item of data.audit) {
    const details = el('details'), summary = el('summary', null, `${local(item.recorded_at)} · ${item.actor} · ${item.action}`);
    let text; try { text = JSON.stringify(JSON.parse(item.details), null, 2); } catch { text = String(item.details); }
    details.append(summary, el('pre', null, text)); audit.append(details);
  }
  if (!data.audit.length) audit.append(el('p', null, 'No changes recorded yet.'));
  renderChecklist(data, teams);
  if (frozen) document.querySelectorAll('form[data-action] button').forEach(button => { button.disabled = true; });
}

function renderChecklist(data, teams) {
  const list = $('checklist');
  if (!list) return;
  const events = data.available_events || data.events;
  const items = [
    [teams.length > 0 && teams.every(t => PLATFORMS.every(p => t.creators?.[p])), `${teams.length} ${teams.length === 1 ? 'team' : 'teams'}`,
      teams.length ? (n => n ? `${n} missing a creator` : 'Instagram and TikTok creator for each')(teams.filter(t => !PLATFORMS.every(p => t.creators?.[p])).length) : 'Add each team with its Instagram and TikTok creator.', 'teams-heading'],
    [teams.length > 0 && teams.every(t => t.base_points != null), 'GP base points', teams.length ? (n => n ? `${n} ${n === 1 ? 'team' : 'teams'} without base points` : 'Set for every team')(teams.filter(t => t.base_points == null).length) : 'Needed for the bonus preview.', 'scoring-details'],
    [events.length > 0, `${events.length} posting ${events.length === 1 ? 'event' : 'events'}`, events.length ? 'Edit windows below if needed.' : 'Add the scheduled posting events.', 'events-heading'],
    [data.entries.length > 0, `${data.entries.length} registered ${data.entries.length === 1 ? 'post' : 'posts'}`, 'Track posts, then register them.', null],
  ];
  list.replaceChildren(...items.map(([done, title, note, target]) => {
    const li = el('li', done ? 'done' : 'todo');
    li.append(el('span', 'tick', done ? '✓' : '!'));
    const body = el('div');
    const strong = el(target && !done ? 'a' : 'strong', null, title);
    if (target && !done) { strong.href = `#${target}`; strong.addEventListener('click', e => { e.preventDefault(); const t = $(target); if (t.tagName === 'DETAILS') t.open = true; t.scrollIntoView({behavior: 'smooth', block: 'start'}); }); }
    body.append(strong, el('span', null, note));
    li.append(body);
    return li;
  }));
}

function renderRegistration(data) {
  const list = $('registration-list'); list.replaceChildren();
  const teams = data.available_teams || data.teams;
  const posts = data.tracked_posts || [];
  const pending = posts.filter(p => !p.entry_id && ['instagram', 'tiktok'].includes(p.platform));
  const counter = $('register-count'); if (counter) counter.textContent = pending.length ? String(pending.length) : '';
  // Posts waiting for registration first, then registered, then tracking-only.
  const order = p => p.entry_id ? 1 : ['instagram', 'tiktok'].includes(p.platform) ? 0 : 2;
  for (const post of [...posts].sort((a, b) => order(a) - order(b))) {
    const card = el('article', 'registration-card');
    const head = el('div', 'card-head');
    head.append(el('h3', null, post.label || post.title || post.remote_id));
    head.append(el('span', post.entry_id ? 'chip ok' : ['instagram', 'tiktok'].includes(post.platform) ? 'chip warn' : 'chip', post.entry_id ? 'Registered' : ['instagram', 'tiktok'].includes(post.platform) ? 'To register' : 'Tracking only'));
    const link = el('a', null, `Open ${post.platform} post ↗`); link.href = post.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    card.append(head, link);
    if (post.entry_id) {
      card.append(el('p', 'assignment', `${post.assigned_event} · ${post.assigned_team} / ${post.assigned_creator}`));
    } else if (!['instagram', 'tiktok'].includes(post.platform)) {
      card.append(el('p', null, 'Only Instagram and TikTok posts can join the race.'));
    } else {
      const form = el('form'); form.dataset.action = 'register-post'; form.noValidate = false;
      const hidden = el('input'); hidden.type = 'hidden'; hidden.name = 'post_id'; hidden.value = post.id; form.append(hidden);
      const select = (labelText, name, items, label) => {
        const wrapper = el('label', null, labelText);
        const input = el('select'); input.name = name; input.required = true;
        options(input, items, label);
        const blank = el("option", null, `Choose ${labelText.replace(/^\w/, c => c.toLowerCase())}`); blank.value = ''; input.prepend(blank); input.value = '';
        wrapper.append(input); form.append(wrapper); return input;
      };
      const eventSelect = select('Event', 'event_id', data.events, e => `${e.starts < data.start ? '[TEST] ' : ''}${e.name}`);
      const teamSelect = select(`Team / ${PLATFORM_NAME[post.platform]} creator`, 'team_id', teams, t => `${t.name} / ${t.creators?.[post.platform] || `no ${PLATFORM_NAME[post.platform]} creator`}`);
      teams.forEach((t, i) => { if (!t.creators?.[post.platform]) teamSelect.options[i + 1].disabled = true; });
      const publishedField = dateTimeField('Published at (KST)', 'published_at', 'Choose an event to see its publication window.');
      form.append(publishedField);
      const published = publishedField.querySelector('input[type="hidden"]');
      eventSelect.addEventListener('change', () => {
        const selected = data.events.find(e => String(e.id) === eventSelect.value);
        publishedField.hint.textContent = selected ? `Window: ${kst(selected.starts)} – ${kst(selected.ends)} KST` : 'Choose an event to see its publication window.';
        published.setRange(selected && kstInput(selected.starts), selected && kstInput(selected.ends));
      });
      const save = el('button', null, 'Register post'); save.type = 'submit';
      const blocked = !teams.length || !data.events.length;
      save.disabled = frozen || blocked; form.append(save);
      const message = el('p', 'form-message'); message.setAttribute('role', 'status'); form.append(message);
      if (blocked) inlineMessage(message, 'info', 'Create at least one event and one team/creator in Setup first.');
      card.append(form);
    }
    list.append(card);
  }
  if (!posts.length) {
    const empty = el('div', 'empty-panel');
    empty.append(el('strong', null, 'Nothing to register yet'));
    const p = el('p', null, 'Add the post link in ');
    const a = el('a', null, 'Track posts'); a.href = '#monitoring'; p.append(a, document.createTextNode(' first, then come back here.'));
    empty.append(p); list.append(empty);
  }
}

function resetEventForm() {
  const form = $('event-form');
  resetForm(form); form.dataset.action = 'event';
  $('event-form-title').textContent = 'Add posting event';
  $('save-event').textContent = 'Add event';
  $('cancel-event').hidden = true;
}

function resetTeamForm() {
  const form = $('team-form');
  resetForm(form); form.dataset.action = 'team';
  $('team-form-title').textContent = 'Add team & creators';
  $('save-team').textContent = 'Add team';
  $('cancel-team').hidden = true;
  if (lastData) renderTeamSelect(lastData.available_teams || lastData.teams);
}

function startEdit(form, focus) {
  inlineMessage(form.querySelector('.form-message'), 'info', '');
  form.scrollIntoView({block: 'center', behavior: 'smooth'});
  focus.focus({preventScroll: true});
}

function rowActions(row, label, onEdit, onDelete) {
  const box = el('div', 'row-actions');
  const edit = el('button', 'btn-ghost', 'Edit'); edit.type = 'button'; edit.disabled = frozen;
  edit.setAttribute('aria-label', `Edit ${label}`); edit.addEventListener('click', onEdit);
  const remove = el('button', 'btn-ghost danger-text', 'Delete'); remove.type = 'button'; remove.disabled = frozen;
  remove.setAttribute('aria-label', `Delete ${label}`); remove.addEventListener('click', () => onDelete(remove));
  box.append(edit, remove);
  cell(row, '', 'actions-cell').append(box);
}

async function removeRecord(button, action, payload, confirmText, done) {
  if (!confirm(confirmText)) return;
  busy(button, true, 'Deleting…');
  try {
    await request(`/api/race/${action}`, payload);
    toast('success', ...done);
    await load();
    document.dispatchEvent(new Event('race-saved'));
  } catch (error) {
    const problem = asRequestError(error);
    toast('error', problem.title === 'Something went wrong' ? 'Could not delete' : problem.title, problem.message);
  } finally {
    busy(button, false);
    if (button.isConnected) button.disabled = frozen;
  }
}

const postsNote = n => n ? `\n\nIts ${n} registered ${n === 1 ? 'post' : 'posts'} will leave the race. They stay in Track posts with their history, and can be registered again.` : '';

function renderEvents(data) {
  const list = $('event-list'); list.replaceChildren();
  const events = data.available_events || data.events;
  for (const item of events) {
    const row = el('tr');
    cell(row, item.name);
    const typeCell = cell(row, ''); typeCell.append(el('span', item.starts < data.start ? 'chip warn' : 'chip ok', item.starts < data.start ? 'Simulation' : 'Official'));
    cell(row, kst(item.starts)); cell(row, kst(item.ends)); cell(row, fmt(item.post_count));
    rowActions(row, `event ${item.name}`, () => {
      const form = $('event-form');
      form.dataset.action = 'event-update';
      form.elements.event_id.value = item.id;
      form.elements.namedItem('name').value = item.name;
      // The pickers always show KST, whatever the administrator's timezone.
      form.elements.starts.setValue(kstInput(item.starts));
      form.elements.ends.setValue(kstInput(item.ends));
      $('event-form-title').textContent = `Edit “${item.name}”`;
      $('save-event').textContent = 'Save changes';
      $('cancel-event').hidden = false;
      startEdit(form, form.elements.namedItem('name'));
    }, button => removeRecord(button, 'event-delete', {event_id: item.id},
      `Delete the event “${item.name}”?${postsNote(item.post_count)}`,
      ['Event deleted', `“${item.name}” was removed${item.post_count ? ` and ${item.post_count} ${item.post_count === 1 ? 'post was' : 'posts were'} unregistered` : ''}.`]));
    list.append(row);
  }
  if (!events.length) emptyRow(list, 'No events yet. Add your first event with the form below.', 6);
  labelCells(list.closest('table'));
}

function renderSetupTeams(data, teams) {
  const body = $('setup-teams'); body.replaceChildren();
  for (const team of teams) {
    const row = el('tr'); row.dataset.team = teamKey(team.name);
    cell(row, team.name);
    for (const platform of PLATFORMS) { const td = cell(row, team.creators?.[platform] || 'Missing'); if (!team.creators?.[platform]) td.classList.add('missing'); }
    cell(row, team.base_points == null ? 'Not set' : fmt(team.base_points));
    const registered = (data.tracked_posts || []).filter(p => p.entry_id && p.assigned_team === team.name).length;
    const who = `${team.name} (${PLATFORMS.map(p => team.creators?.[p]).filter(Boolean).join(' / ')})`;
    rowActions(row, team.name, () => {
      const form = $('team-form');
      form.dataset.action = 'team-update';
      form.elements.team_id.value = team.id;
      renderTeamSelect(teams);
      $('team-select').value = E1_TEAMS.find(name => sameTeam(name, team.name)) || team.name;
      for (const platform of PLATFORMS) form.elements[platform].value = team.creators?.[platform] || '';
      form.elements.base_points.value = team.base_points ?? '';
      $('team-form-title').textContent = `Edit ${team.name}`;
      $('save-team').textContent = 'Save changes';
      $('cancel-team').hidden = false;
      startEdit(form, form.elements.instagram);
    }, button => removeRecord(button, 'team-delete', {team_id: team.id},
      `Delete ${who} and both its creators?${postsNote(registered)}`,
      ['Team deleted', `${who} was removed${registered ? ` and ${registered} ${registered === 1 ? 'post was' : 'posts were'} unregistered` : ''}.`]));
    body.append(row);
  }
  if (!teams.length) emptyRow(body, 'No teams yet. Pick a team and add its creators with the form below.', 5);
  labelCells(body.closest('table'));
}

// Fixed team list; teams that already have a creator are disabled (except the one being edited).
function renderTeamSelect(teams) {
  const select = $('team-select');
  if (!select) return;
  const editing = $('team-form').elements.team_id.value;
  const previous = select.value;
  const names = [...E1_TEAMS, ...teams.map(t => t.name).filter(n => !E1_TEAMS.some(e => sameTeam(e, n)))];
  const blank = el('option', null, 'Choose a team'); blank.value = '';
  select.replaceChildren(blank);
  for (const name of names) {
    const owner = teams.find(t => sameTeam(t.name, name));
    const option = el('option', null, owner && String(owner.id) !== editing ? `${name} · already set up` : name);
    option.value = name;
    option.disabled = Boolean(owner && String(owner.id) !== editing);
    select.append(option);
  }
  select.value = names.includes(previous) && !select.querySelector(`option[value="${CSS.escape(previous)}"]`)?.disabled ? previous : '';
}

// What to say after each successful save.
function successText(action, payload, data) {
  const team = id => (data?.available_teams || data?.teams || []).find(t => String(t.id) === String(id));
  const event = id => (data?.available_events || data?.events || []).find(e => String(e.id) === String(id));
  switch (action) {
    case 'event': return ['Event added', `“${payload.name}” is ready for registrations.`];
    case 'event-update': return ['Event updated', `Changes to “${payload.name}” were saved.`];
    case 'team': return ['Team added', `${payload.name}: Instagram ${payload.instagram} · TikTok ${payload.tiktok}.`];
    case 'team-update': return ['Team updated', `${payload.name}: Instagram ${payload.instagram} · TikTok ${payload.tiktok}.`];
    case 'base': return ['Base points saved', `${team(payload.team_id)?.name || 'The team'} now has ${fmt(Number(payload.base_points))} base points.`];
    case 'register-post': return ['Post registered', `Assigned to ${team(payload.team_id)?.name || 'the team'} · ${event(payload.event_id)?.name || 'the event'}. Its first race check is scheduled.`];
    case 'manual': return ['Observation saved', payload.final ? 'Certified final counts recorded.' : 'The manual counts were added to the history.'];
    case 'finalize': return ['Results published', 'The final standings are now frozen.'];
    default: return ['Saved', ''];
  }
}

function validate(form) {
  if (form.id === 'event-form' && form.elements.starts.value && form.elements.ends.value && form.elements.ends.value <= form.elements.starts.value) {
    return ['The window must close after it opens.', form.elements.ends.closest('.dt-field').querySelector('input[type="date"]')];
  }
  if (form.dataset.action === 'manual' && !['likes', 'comments', 'views'].some(k => form.elements[k].value !== '')) {
    return ['Enter at least one count: likes, comments or views.', form.elements.likes];
  }
  return null;
}

if (admin) {
  document.querySelectorAll('[data-datetime]').forEach(slot => slot.replaceWith(dateTimeField(slot.dataset.label, slot.dataset.datetime, slot.dataset.hint)));
  $('cancel-event').addEventListener('click', () => { resetEventForm(); inlineMessage($('event-form').querySelector('.form-message'), 'info', ''); });
  $('cancel-team').addEventListener('click', () => { resetTeamForm(); inlineMessage($('team-form').querySelector('.form-message'), 'info', ''); });
  document.addEventListener('submit', async event => {
    const form = event.target;
    if (!form.matches('form[data-action]')) return;
    event.preventDefault();
    const button = form.querySelector('button[type="submit"], button:not([type])');
    let message = form.querySelector('.form-message');
    if (!message) { message = el('p', 'form-message'); message.setAttribute('role', 'status'); form.append(message); }
    const invalid = validate(form);
    if (invalid) { inlineMessage(message, 'error', invalid[0]); invalid[1].focus(); return; }
    const action = form.dataset.action;
    const payload = Object.fromEntries(new FormData(form));
    if (action === 'manual') payload.final = form.elements.final.checked;
    if (action === 'finalize' && !confirm('Freeze and publish the final results? This cannot be undone here.')) return;
    busy(button, true, 'Saving…');
    inlineMessage(message, 'progress', 'Saving…');
    try {
      await request(`/api/race/${action}`, payload);
      const [title, detail] = successText(action, payload, lastData);
      if (form.id === 'event-form') resetEventForm(); else if (form.id === 'team-form') resetTeamForm(); else if (action !== 'register-post') resetForm(form);
      delete form.dataset.touched;
      inlineMessage(message, 'success', `${title}.`);
      toast('success', title, detail);
      await load().catch(error => showLoadError(asRequestError(error), {stale: true}));
      document.dispatchEvent(new Event('race-saved'));
    } catch (error) {
      const problem = asRequestError(error);
      inlineMessage(message, 'error', problem.message);
      if (problem.status === 401) toast('error', problem.title, problem.message);
    } finally {
      busy(button, false);
      if (button) button.disabled = frozen;
    }
  });
  document.addEventListener('posts-changed', () => refresh());
}

// Phone tabs between the two leaderboards.
document.querySelectorAll('.board-tabs [data-board]').forEach(tab => tab.addEventListener('click', () => {
  document.querySelectorAll('.board-tabs [data-board]').forEach(t => t.setAttribute('aria-selected', String(t === tab)));
  const boards = document.querySelector('.boards'); if (boards) boards.dataset.show = tab.dataset.board;
  renderLeaderTheme(lastData);
}));
$('team-filter')?.addEventListener('change', () => lastData && renderEntries(lastData));
$('event-filter')?.addEventListener('change', () => lastData && renderEntries(lastData));

refresh();
if (!admin) {
  let timer = setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
  // Countdown keeps ticking between data refreshes.
  setInterval(() => { if (lastData && !document.hidden) renderHero(lastData); }, 30000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - lastLoadedAt > REFRESH_MS) { refresh(); clearInterval(timer); timer = setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS); }
  });
  addEventListener('online', refresh);
  addEventListener('offline', () => showLoadError(new window.E1.RequestError('You appear to be offline. The standings will refresh when you reconnect.', {title: 'No connection'}), {stale: Boolean(lastData)}));
}
})();
