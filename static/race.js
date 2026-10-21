'use strict';
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
    document.querySelectorAll('.team-options').forEach(el => options(el, data.teams, t => t.name));
    options($('event-options'), data.events, e => e.name);
    options($('entry-options'), data.entries, e => `${teamName(e.team_id)} / ${eventName(e.event_id)} / ${e.platform}`);
    $('audit').replaceChildren();
    for (const item of data.audit) { const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = `${date(item.recorded_at)} · ${item.actor} · ${item.action}`; const pre = document.createElement('pre'); pre.textContent = JSON.stringify(JSON.parse(item.details), null, 2); details.append(summary, pre); $('audit').append(details); }
    if (data.state === 'Final') document.querySelectorAll('form button').forEach(button => { button.disabled = true; });
  }
}
document.querySelectorAll('form[data-action]').forEach(form => form.addEventListener('submit', async event => {
  event.preventDefault(); const button = form.querySelector('button'); button.disabled = true;
  try {
    const payload = Object.fromEntries(new FormData(form));
    if (form.dataset.action === 'manual') payload.final = form.elements.final.checked;
    const response = await fetch(`/api/race/${form.dataset.action}`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
    const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Save failed.');
    $('message').textContent = 'Saved successfully.'; await load();
  } catch (error) { $('message').textContent = error.message; }
  finally { button.disabled = false; }
}));
load().catch(error => { $('message').textContent = error.message; });
if (!admin) setInterval(() => load().catch(() => { $('message').textContent = 'Refresh failed. Showing previously loaded data.'; }), 60000);
