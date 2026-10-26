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

// Rules -------------------------------------------------------------------
function rulesText(weights) {
  if (!weights) return 'Rankings appear once the organisers confirm the scoring formula.';
  const names = {likes: ['like', 'likes'], comments: ['comment', 'comments'], views: ['view', 'views']};
  const parts = Object.entries(names).filter(([k]) => weights[k]).map(([k, [one]]) => `${fmt(weights[k])} ${weights[k] === 1 ? 'pt' : 'pts'} per ${one}`);
  const ignored = Object.entries(names).filter(([k]) => !weights[k]).map(([, [, many]]) => many);
  return `Score: ${parts.join(' · ')}${ignored.length ? ` · ${ignored.join(' and ')} don't count` : ''}.`;
}

// Header / hero -----------------------------------------------------------
function renderHero(data) {
  const chip = $('state-chip');
  if (!chip) return;
  const t = now();
  let kind = 'accent', label = 'Live · provisional', countdown;
  if (data.state === 'Final') { kind = 'ok'; label = 'Final results'; countdown = data.finalized_at ? `Results published ${kst(data.finalized_at)} KST.` : 'Results are final.'; }
  else if (data.simulation) { kind = 'warn'; label = 'Simulation · not official'; }
  else if (!data.weights) { kind = ''; label = 'Awaiting scoring rules'; }
  if (!countdown) {
    if (t < data.start) { countdown = `Lights out in ${duration(data.start - t)}`; if (!data.simulation && data.weights) label = 'Starting soon'; }
    else if (t < data.end) countdown = `Chequered flag in ${duration(data.end - t)}`;
    else { countdown = 'Race closed · final results coming soon'; if (data.weights) { kind = 'warn'; label = 'Closed · awaiting final check'; } }
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

// The page wears the colours of the sole P1 team; ties and empty grids keep E1 orange.
function renderLeaderTheme(data) {
  if (admin) return;
  const leaders = (data.teams || []).filter(team => team.rank === 1 && team.score != null);
  const leader = leaders.length === 1 ? leaders[0] : null;
  const key = leader ? teamKey(leader.name) : 'other';
  if (leader && key !== 'other') document.body.dataset.leader = key; else delete document.body.dataset.leader;
  const chip = $('leader-chip');
  if (chip) {
    chip.hidden = !leader;
    if (leader) { chip.textContent = `${leader.name} in P1`; chip.title = `The page uses ${leader.name}'s colours while they lead`; }
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(document.body).getPropertyValue('--accent-soft').trim() || '#0a0a0c';
}

// Standings: timing tower (public) or table (admin) ------------------------
function renderTower(data) {
  const tower = $('tower');
  if (!tower) return;
  tower.replaceChildren();
  tower.removeAttribute('aria-busy');
  if (!data.teams.length) {
    const li = el('li', 'tower-empty');
    li.append(el('strong', null, 'The grid is empty for now'), el('span', null, 'Teams appear here as soon as the organisers register them.'));
    tower.append(li);
    return;
  }
  const leader = data.teams.find(t => t.rank === 1 && t.score != null);
  for (const team of data.teams) {
    const li = el('li', 'tower-row');
    li.dataset.team = teamKey(team.name);
    if (team.rank && team.rank <= 3) li.classList.add(`podium-${team.rank}`);
    if (team.score == null) li.classList.add('is-pending');
    li.append(el('span', 'pos', team.rank ? `P${team.rank}` : '—'), el('span', 'team-bar'));
    const who = el('div', 'who');
    who.append(el('strong', null, team.name), el('span', null, `${team.representative} · ${team.posts} ${team.posts === 1 ? 'post' : 'posts'}`));
    li.append(who);
    const score = el('div', 'score');
    if (team.score != null) {
      score.append(el('strong', null, fmt(team.score)));
      const gap = leader && team !== leader ? `−${fmt(leader.score - team.score)}` : leader ? 'Leader' : '';
      score.append(el('span', 'gap', gap));
    } else {
      score.append(el('strong', 'pending', 'Pending'));
      score.append(el('span', 'gap', !data.weights ? 'No formula yet' : team.posts ? `${team.missing} ${team.missing === 1 ? 'post' : 'posts'} awaiting counts` : 'No posts yet'));
    }
    li.append(score);
    const bonus = el('span', 'bonus');
    if (team.bonus_percent) {
      bonus.classList.add('chip', 'accent');
      bonus.textContent = `+${team.bonus_percent}%${team.bonus_points == null ? '' : ` · ${fmt(team.bonus_points)} GP`}`;
      bonus.title = 'Grand Prix bonus preview';
    } else if (team.rank && team.rank <= 3 && team.bonus_percent == null) {
      bonus.classList.add('chip', 'warn'); bonus.textContent = 'Tie';
      bonus.title = 'Tied on the podium: the bonus stays unresolved until a tie-break is agreed.';
    }
    li.append(bonus);
    li.setAttribute('aria-label', `${team.rank ? `Position ${team.rank}` : 'Not ranked'}, ${team.name}, ${team.score != null ? `${fmt(team.score)} points` : 'score pending'}`);
    tower.append(li);
  }
}

function renderTeamsTable(data) {
  const body = $('teams');
  if (!body) return;
  body.replaceChildren();
  for (const team of data.teams) {
    const row = el('tr');
    cell(row, team.rank ? `P${team.rank}` : '—');
    cell(row, `${team.name} / ${team.representative}`);
    cell(row, fmt(team.posts));
    cell(row, team.missing ? `Pending (${team.missing} incomplete)` : fmt(team.score));
    cell(row, team.bonus_percent == null ? '—' : `${team.bonus_percent}%${team.bonus_points == null ? '' : ` · ${fmt(team.bonus_points)} points`}`);
    body.append(row);
  }
  if (!data.teams.length) emptyRow(body, 'No teams registered yet.', 5);
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
    cell(row, eventOf(entry.event_id)?.name || 'Unknown event');
    const link = el('a', 'post-link', `${entry.platform === 'tiktok' ? 'TikTok' : entry.platform === 'instagram' ? 'Instagram' : entry.platform} ↗`);
    link.href = entry.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', `Open the ${entry.platform} post of ${team?.name || 'this team'} (new tab)`);
    cell(row, '').append(link);
    for (const key of ['likes', 'comments', 'views']) cell(row, fmt(entry.metrics?.[key]), 'num');
    cell(row, fmt(entry.score), 'num strong');
    cell(row, entry.observed_at ? kst(entry.observed_at) : '—');
    const source = cell(row, '');
    if (!entry.metrics) { row.classList.add('is-missing'); source.append(el('span', 'chip warn', 'Awaiting counts')); }
    else if (entry.score == null && data.weights) source.append(el('span', 'chip warn', `${entry.source} · incomplete`));
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
    const tower = $('tower');
    if (tower) {
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
  if ($('rules')) $('rules').textContent = rulesText(data.weights);
  renderHero(data); renderTower(data); renderTeamsTable(data); renderEntries(data);
  if ($('refreshed')) $('refreshed').textContent = `Checked for updates at ${new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})} (your time) · refreshes every minute.`;
  if (admin) renderAdmin(data);
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
  const setupTeams = $('setup-teams'); setupTeams.replaceChildren();
  for (const team of teams) { const row = el('tr'); row.dataset.team = teamKey(team.name); cell(row, team.name); cell(row, team.representative); cell(row, team.base_points == null ? 'Not set' : fmt(team.base_points)); setupTeams.append(row); }
  if (!teams.length) emptyRow(setupTeams, 'No teams yet. Add the first team with the form below.', 3);
  labelCells(setupTeams.closest('table'));
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
  const weightsForm = document.querySelector('form[data-action="weights"]');
  if (weightsForm && data.weights && !weightsForm.dataset.touched) for (const k of ['likes', 'comments', 'views']) weightsForm.elements[k].value = data.weights[k];
  renderChecklist(data, teams);
  if (frozen) document.querySelectorAll('form button').forEach(button => { button.disabled = true; });
}

function renderChecklist(data, teams) {
  const list = $('checklist');
  if (!list) return;
  const events = data.available_events || data.events;
  const items = [
    [Boolean(data.weights), data.weights ? 'Scoring rules confirmed' : 'Confirm the scoring rules', data.weights ? rulesText(data.weights) : 'Rankings stay hidden until you do.', 'scoring-details'],
    [teams.length > 0, `${teams.length} ${teams.length === 1 ? 'team' : 'teams'}`, teams.length ? (n => n ? `${n} without GP base points` : 'All have GP base points')(teams.filter(t => t.base_points == null).length) : 'Add each team and its representative.', 'teams-heading'],
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
  if (!data.weights && $('scoring-details')) $('scoring-details').open = true;
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
        const blank = el('option', null, `Choose ${labelText.toLowerCase()}`); blank.value = ''; input.prepend(blank); input.value = '';
        wrapper.append(input); form.append(wrapper); return input;
      };
      const eventSelect = select('Event', 'event_id', data.events, e => `${e.starts < data.start ? '[TEST] ' : ''}${e.name}`);
      select('Team / creator', 'team_id', teams, t => `${t.name} / ${t.representative}`);
      const label = el('label', null, 'Published at (KST)');
      const published = el('input'); published.type = 'datetime-local'; published.name = 'published_at'; published.required = true;
      const hint = el('small', 'field-hint', 'Choose an event to see its publication window.');
      label.append(published, hint); form.append(label);
      eventSelect.addEventListener('change', () => {
        const selected = data.events.find(e => String(e.id) === eventSelect.value);
        hint.textContent = selected ? `Window: ${kst(selected.starts)} – ${kst(selected.ends)} KST` : 'Choose an event to see its publication window.';
        for (const [attribute, key] of [['min', 'starts'], ['max', 'ends']]) {
          if (selected) published.setAttribute(attribute, kstInput(selected[key])); else published.removeAttribute(attribute);
        }
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
  form.reset(); form.dataset.action = 'event';
  $('event-form-title').textContent = 'Add posting event';
  $('save-event').textContent = 'Add event';
  $('cancel-event').hidden = true;
}

function renderEvents(data) {
  const list = $('event-list'); list.replaceChildren();
  const events = data.available_events || data.events;
  for (const item of events) {
    const row = el('tr');
    cell(row, item.name);
    const typeCell = cell(row, ''); typeCell.append(el('span', item.starts < data.start ? 'chip warn' : 'chip ok', item.starts < data.start ? 'Simulation' : 'Official'));
    cell(row, kst(item.starts)); cell(row, kst(item.ends)); cell(row, fmt(item.post_count));
    const button = el('button', 'btn-ghost', 'Edit'); button.type = 'button'; button.disabled = frozen;
    button.setAttribute('aria-label', `Edit event ${item.name}`);
    button.addEventListener('click', () => {
      const form = $('event-form');
      form.dataset.action = 'event-update';
      form.elements.event_id.value = item.id;
      form.elements.namedItem('name').value = item.name;
      // datetime-local must show KST regardless of the administrator's timezone.
      form.elements.starts.value = kstInput(item.starts);
      form.elements.ends.value = kstInput(item.ends);
      $('event-form-title').textContent = `Edit “${item.name}”`;
      $('save-event').textContent = 'Save changes';
      $('cancel-event').hidden = false;
      inlineMessage(form.querySelector('.form-message'), 'info', '');
      form.scrollIntoView({block: 'center', behavior: 'smooth'}); form.elements.namedItem('name').focus({preventScroll: true});
    });
    cell(row, '').append(button); list.append(row);
  }
  if (!events.length) emptyRow(list, 'No events yet. Add your first event with the form below.', 6);
  labelCells(list.closest('table'));
}

// What to say after each successful save.
function successText(action, payload, data) {
  const team = id => (data?.available_teams || data?.teams || []).find(t => String(t.id) === String(id));
  const event = id => (data?.available_events || data?.events || []).find(e => String(e.id) === String(id));
  switch (action) {
    case 'event': return ['Event added', `“${payload.name}” is ready for registrations.`];
    case 'event-update': return ['Event updated', `Changes to “${payload.name}” were saved.`];
    case 'team': return ['Team added', `${payload.name} / ${payload.representative} can now be picked when registering posts.`];
    case 'weights': return ['Scoring rules confirmed', 'The standings now use the new formula.'];
    case 'base': return ['Base points saved', `${team(payload.team_id)?.name || 'The team'} now has ${fmt(Number(payload.base_points))} base points.`];
    case 'register-post': return ['Post registered', `Assigned to ${team(payload.team_id)?.name || 'the team'} · ${event(payload.event_id)?.name || 'the event'}. Its first race check is scheduled.`];
    case 'manual': return ['Observation saved', payload.final ? 'Certified final counts recorded.' : 'The manual counts were added to the history.'];
    case 'finalize': return ['Results published', 'The final standings are now frozen.'];
    default: return ['Saved', ''];
  }
}

function validate(form) {
  if (form.id === 'event-form' && form.elements.starts.value && form.elements.ends.value && form.elements.ends.value <= form.elements.starts.value) {
    return ['The window must close after it opens.', form.elements.ends];
  }
  if (form.dataset.action === 'manual' && !['likes', 'comments', 'views'].some(k => form.elements[k].value !== '')) {
    return ['Enter at least one count: likes, comments or views.', form.elements.likes];
  }
  return null;
}

if (admin) {
  $('cancel-event').addEventListener('click', () => { resetEventForm(); inlineMessage($('event-form').querySelector('.form-message'), 'info', ''); });
  document.querySelector('form[data-action="weights"]')?.addEventListener('input', event => { event.currentTarget.dataset.touched = '1'; });
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
      if (form.id === 'event-form') resetEventForm(); else if (action !== 'register-post') form.reset();
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
