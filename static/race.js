(() => {
'use strict';
let frozen = false;
const admin = document.body.dataset.admin === 'true';
const $ = id => document.getElementById(id);
const fmt = value => value == null ? '—' : Number(value).toLocaleString('en-US');
const date = value => value ? new Intl.DateTimeFormat('en-GB', {timeZone:'Asia/Seoul', dateStyle:'medium', timeStyle:'short'}).format(new Date(value * 1000)) : 'No observation';
function cell(row, text) { const td = document.createElement('td'); td.textContent = text; row.append(td); return td; }
function options(element, items, label) {
  const previous = element.value; element.replaceChildren();
  for (const item of items) { const option = document.createElement('option'); option.value = item.id; option.textContent = label(item); element.append(option); }
  if (items.some(item => String(item.id) === previous)) element.value = previous;
}
async function load() {
  const response = await fetch(admin ? '/api/race/admin' : '/api/race');
  if (!response.ok) throw new Error('Could not load the race. Check authentication or try again.');
  const data = await response.json();
  frozen = data.state === 'Final';
  $('status').textContent = `${data.state} · Opens ${date(data.start)} · Closes ${date(data.end)}`;
  $('rules').textContent = data.weights ? `Score = ${data.weights.likes} × likes + ${data.weights.comments} × comments + ${data.weights.views} × views. Podium: 2% / 1% / 1% of the team’s Grand Prix base points. Ties remain unresolved.` : 'Rankings will appear after the administrator confirms the engagement formula.';
  $('teams').replaceChildren(); $('entries').replaceChildren();
  for (const team of data.teams) {
    const row = document.createElement('tr');
    for (const text of [fmt(team.rank), `${team.name} / ${team.representative}`, fmt(team.posts), team.missing ? `Pending (${team.missing} incomplete)` : fmt(team.score), team.bonus_percent == null ? '—' : `${team.bonus_percent}%${team.bonus_points == null ? '' : ` · ${fmt(team.bonus_points)} points`}`]) cell(row, text);
    $('teams').append(row);
  }
  const teamName = id => data.teams.find(t => t.id === id)?.name || 'Unknown';
  const eventName = id => data.events.find(e => e.id === id)?.name || 'Unknown';
  for (const entry of data.entries) {
    const row = document.createElement('tr'); cell(row, teamName(entry.team_id)); cell(row, eventName(entry.event_id));
    const link = document.createElement('a'); link.href = entry.url; link.textContent = entry.platform; link.target = '_blank'; link.rel = 'noopener noreferrer'; cell(row, '').append(link);
    for (const key of ['likes','comments','views']) cell(row, fmt(entry.metrics?.[key]));
    cell(row, fmt(entry.score)); cell(row, date(entry.observed_at)); cell(row, entry.source || 'Awaiting counts'); $('entries').append(row);
  }
  if (!data.teams.length) { const row = document.createElement('tr'); cell(row, 'No teams registered yet.'); $('teams').append(row); }
  if (!data.entries.length) { const row = document.createElement('tr'); cell(row, 'No official posts yet.'); $('entries').append(row); }
  if (admin) {
    renderEvents(data);
    document.querySelectorAll('.team-options').forEach(el => options(el, data.available_teams || data.teams, t => t.name));
    renderRegistration(data);
    $('setup-teams').replaceChildren();
    for (const team of data.available_teams || data.teams) { const row = document.createElement('tr'); cell(row, team.name); cell(row, team.representative); $('setup-teams').append(row); }
    options($('entry-options'), data.entries, e => `${teamName(e.team_id)} / ${eventName(e.event_id)} / ${e.platform}`);
    $('audit').replaceChildren();
    for (const item of data.audit) { const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = `${date(item.recorded_at)} · ${item.actor} · ${item.action}`; const pre = document.createElement('pre'); pre.textContent = JSON.stringify(JSON.parse(item.details), null, 2); details.append(summary, pre); $('audit').append(details); }
    if (data.state === 'Final') document.querySelectorAll('form button').forEach(button => { button.disabled = true; });
  }
}
function renderRegistration(data) {
  const list = $('registration-list'); list.replaceChildren();
  const teams = data.available_teams || data.teams;
  for (const post of data.tracked_posts || []) {
    const card = document.createElement('article'); card.className = 'registration-card';
    const heading = document.createElement('h3'); heading.textContent = post.label || post.title || post.remote_id;
    const link = document.createElement('a'); link.href = post.url; link.textContent = `Open ${post.platform} post ↗`; link.target = '_blank'; link.rel = 'noopener noreferrer';
    card.append(heading, link);
    if (post.entry_id) {
      const status = document.createElement('p'); status.className = 'assignment';
      status.textContent = `Registered · ${post.assigned_event} · ${post.assigned_team} / ${post.assigned_creator}`;
      card.append(status);
    } else if (!['instagram', 'tiktok'].includes(post.platform)) {
      const status = document.createElement('p'); status.textContent = 'Tracking only — this platform is not eligible for the race.'; card.append(status);
    } else {
      const form = document.createElement('form'); form.dataset.action = 'register-post';
      const hidden = document.createElement('input'); hidden.type = 'hidden'; hidden.name = 'post_id'; hidden.value = post.id; form.append(hidden);
      function select(labelText, name, items, label) {
        const wrapper = document.createElement('label'); wrapper.textContent = labelText;
        const input = document.createElement('select'); input.name = name; input.required = true;
        options(input, items, label);
        const blank = document.createElement('option'); blank.value = ''; blank.textContent = `Choose ${labelText.toLowerCase()}`; input.prepend(blank); input.value = '';
        wrapper.append(input); form.append(wrapper); return input;
      }
      const eventSelect = select('Event', 'event_id', data.events, e => `${e.starts < data.start ? '[TEST] ' : ''}${e.name}`);
      select('Team / creator', 'team_id', teams, t => `${t.name} / ${t.representative}`);
      const hint = document.createElement('p'); hint.textContent = 'Select an event to see its publication window.'; form.append(hint);
      const label = document.createElement('label'); label.textContent = 'Published at (KST)';
      const published = document.createElement('input'); published.type = 'datetime-local'; published.name = 'published_at'; published.required = true;
      label.append(published); form.append(label);
      eventSelect.addEventListener('change', () => {
        const selected = data.events.find(e => String(e.id) === eventSelect.value);
        hint.textContent = selected ? `Publication window: ${date(selected.starts)} – ${date(selected.ends)} KST` : 'Select an event to see its publication window.';
        for (const [attribute, key] of [['min', 'starts'], ['max', 'ends']]) {
          if (selected) published.setAttribute(attribute, new Date((selected[key] + 9 * 3600) * 1000).toISOString().slice(0, 16));
          else published.removeAttribute(attribute);
        }
      });
      const save = document.createElement('button'); save.type = 'submit'; save.textContent = 'Register post'; save.disabled = frozen || !teams.length || !data.events.length; form.append(save);
      if (!teams.length || !data.events.length) { const hint = document.createElement('p'); hint.textContent = 'Create an event and a team/creator in Setup first.'; form.append(hint); }
      card.append(form);
    }
    list.append(card);
  }
  if (!data.tracked_posts?.length) { const empty = document.createElement('p'); empty.textContent = 'No tracked posts yet. Add a link and name in Track posts first.'; list.append(empty); }
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
    const row = document.createElement('tr');
    for (const text of [item.name, item.starts < data.start ? 'Simulation' : 'Official', date(item.starts), date(item.ends), fmt(item.post_count)]) cell(row, text);
    const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Edit'; button.disabled = frozen;
    button.setAttribute('aria-label', `Edit event ${item.name}`);
    button.addEventListener('click', () => {
      const form = $('event-form');
      form.dataset.action = 'event-update';
      form.elements.event_id.value = item.id;
      form.elements.namedItem('name').value = item.name;
      // datetime-local must show KST regardless of the administrator's timezone.
      form.elements.starts.value = new Date((item.starts + 9 * 3600) * 1000).toISOString().slice(0, 16);
      form.elements.ends.value = new Date((item.ends + 9 * 3600) * 1000).toISOString().slice(0, 16);
      $('event-form-title').textContent = 'Edit posting event';
      $('save-event').textContent = 'Save changes';
      $('cancel-event').hidden = false;
      form.querySelector('.form-message').textContent = '';
      form.scrollIntoView({block: 'center'}); form.elements.namedItem('name').focus();
    });
    cell(row, '').append(button); list.append(row);
  }
  if (!events.length) { const row = document.createElement('tr'); const td = cell(row, 'No events yet. Add your first event below.'); td.colSpan = 6; list.append(row); }
}
if (admin) $('cancel-event').addEventListener('click', () => { resetEventForm(); $('event-form').querySelector('.form-message').textContent = ''; });
document.addEventListener('submit', async event => {
  const form = event.target;
  if (!form.matches('form[data-action]')) return;
  event.preventDefault(); const button = form.querySelector('button'); button.disabled = true;
  let message = form.querySelector('.form-message');
  if (!message) { message = document.createElement('p'); message.className = 'form-message'; message.setAttribute('role', 'status'); form.append(message); }
  message.textContent = 'Saving…';
  try {
    const payload = Object.fromEntries(new FormData(form));
    if (form.dataset.action === 'manual') payload.final = form.elements.final.checked;
    const response = await fetch(`/api/race/${form.dataset.action}`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
    const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Save failed.');
    message.textContent = 'Saved successfully.';
    if (form.id === 'event-form') resetEventForm();
    $('message').textContent = 'Saved successfully.'; await load(); document.dispatchEvent(new Event('race-saved'));
  } catch (error) { message.textContent = error.message; $('message').textContent = error.message; }
  finally { button.disabled = frozen; }
});
if (admin) document.addEventListener('posts-changed', () => load().catch(error => { $('message').textContent = error.message; }));
load().catch(error => { $('message').textContent = error.message; });
if (!admin) setInterval(() => load().catch(() => { $('message').textContent = 'Refresh failed. Showing previously loaded data.'; }), 60000);

})();
