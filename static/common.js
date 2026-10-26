// Shared helpers for the public leaderboard and the admin workspace:
// requests with readable errors, toasts, number/date formatting, responsive tables.
(() => {
'use strict';

const TIMEOUT_MS = 15000;

class RequestError extends Error {
  constructor(message, {title = 'Something went wrong', status = 0, retryable = true} = {}) {
    super(message);
    this.name = 'RequestError';
    this.title = title;
    this.status = status;
    this.retryable = retryable;
  }
}

function fromStatus(status, serverMessage) {
  if (status === 401) return new RequestError('Your admin session has expired. Reload the page to sign in again.', {title: 'Sign-in required', status, retryable: false});
  if (status === 403) return new RequestError(serverMessage || 'This action is not allowed from this address.', {title: 'Not allowed', status, retryable: false});
  if (status === 404) return new RequestError(serverMessage || 'This item no longer exists. Reload the page to see the latest data.', {title: 'Not found', status, retryable: false});
  if (status === 409) return new RequestError(serverMessage || 'This conflicts with an existing record.', {title: 'Already exists', status, retryable: false});
  if (status === 429) return new RequestError(serverMessage || 'Too many attempts. Wait a few minutes and try again.', {title: 'Please wait', status});
  if (status === 400 || status === 415) return new RequestError(serverMessage || 'Some of the details are not valid. Check the form and try again.', {title: 'Check the details', status, retryable: false});
  if (status === 502 || status === 503 || status === 504) return new RequestError('The server is restarting or temporarily unavailable. Try again in a minute.', {title: 'Server unavailable', status});
  if (status >= 500) return new RequestError('The server ran into a problem. Try again; if it keeps happening, check the server logs.', {title: 'Server error', status});
  return new RequestError(serverMessage || `Unexpected response (HTTP ${status}).`, {status});
}

// fetch wrapper: JSON in/out, timeout, and errors people can act on.
async function request(path, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const options = {signal: controller.signal, headers: {Accept: 'application/json'}};
  if (payload !== undefined) {
    options.method = 'POST';
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(payload);
  }
  let response;
  try {
    response = await fetch(path, options);
  } catch (error) {
    if (error.name === 'AbortError') throw new RequestError('The server took too long to respond. Try again in a moment.', {title: 'Request timed out'});
    if (!navigator.onLine) throw new RequestError('You appear to be offline. Reconnect and try again.', {title: 'No connection'});
    throw new RequestError('Could not reach the server. Check your connection and try again.', {title: 'Connection problem'});
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  const type = response.headers.get('Content-Type') || '';
  if (type.includes('application/json')) {
    try { data = await response.json(); } catch { data = null; }
  }
  if (!response.ok) throw fromStatus(response.status, data && typeof data.error === 'string' ? data.error : '');
  if (data === null) throw new RequestError('The server sent an unexpected response. Reload the page and try again.', {title: 'Unexpected response', status: response.status});
  return data;
}

function asRequestError(error) {
  return error instanceof RequestError ? error : new RequestError(error && error.message ? error.message : 'Unexpected error. Reload the page and try again.');
}

// Toasts ---------------------------------------------------------------
let region;
function toastRegion() {
  if (region) return region;
  region = document.createElement('div');
  region.className = 'toast-region';
  region.setAttribute('aria-live', 'polite');
  region.setAttribute('aria-relevant', 'additions');
  document.body.append(region);
  return region;
}

function toast(kind, title, message, {timeout} = {}) {
  const item = document.createElement('div');
  item.className = `toast toast-${kind}`;
  item.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const body = document.createElement('div');
  const strong = document.createElement('strong'); strong.textContent = title; body.append(strong);
  if (message) { const p = document.createElement('p'); p.textContent = message; body.append(p); }
  const close = document.createElement('button');
  close.type = 'button'; close.className = 'toast-close'; close.setAttribute('aria-label', 'Dismiss'); close.textContent = '×';
  const remove = () => item.remove();
  close.addEventListener('click', remove);
  item.append(body, close);
  toastRegion().append(item);
  const wait = timeout ?? (kind === 'error' ? 0 : 4500);
  if (wait) setTimeout(remove, wait);
  while (region.children.length > 3) region.firstElementChild.remove();
  return item;
}

// Inline alert inside a container (forms, panels). kind: error | success | info | progress
function inlineMessage(element, kind, text) {
  if (!element) return;
  element.textContent = text || '';
  element.className = element.className.replace(/\bis-(error|success|info|progress)\b/g, '').trim();
  if (text) element.classList.add(`is-${kind}`);
}

// Formatting -------------------------------------------------------------
const numberFormat = new Intl.NumberFormat('en-GB');
const fmt = value => value == null ? '—' : numberFormat.format(value);
const kstFormat = new Intl.DateTimeFormat('en-GB', {timeZone: 'Asia/Seoul', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'});
const kst = value => value ? kstFormat.format(new Date(value * 1000)) : '—';
const localFormat = new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short'});
const local = value => value ? localFormat.format(new Date(value * 1000)) : '—';

function duration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${Math.max(m, 1)}m`;
}

// Copies each column header into data-label so tables can become cards on phones.
function labelCells(table) {
  if (!table) return;
  const heads = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
  table.classList.add('stack-table');
  for (const row of table.querySelectorAll('tbody tr')) {
    [...row.children].forEach((td, i) => { if (heads[i] && !td.hasAttribute('colspan')) td.dataset.label = heads[i]; });
  }
}

// The six E1 teams, matched by exact name ("TEAM " prefix, case and spacing ignored).
const TEAM_KEYS = {mcjakey: 'mcjakey', jaybullracing: 'jaybull', alpinoo: 'alpinoo', hoonrari: 'hoonrari', meowcedes: 'meowcedes', rikstondrift: 'rikston'};
function teamKey(name) {
  const plain = String(name || '').toLowerCase().replace(/[^a-z]/g, '').replace(/^team/, '');
  return TEAM_KEYS[plain] || 'other';
}

function busy(button, on, label) {
  if (!button) return;
  if (on) {
    button.dataset.idleLabel = button.textContent;
    if (label) button.textContent = label;
    button.disabled = true; button.setAttribute('aria-busy', 'true');
  } else {
    if (button.dataset.idleLabel) button.textContent = button.dataset.idleLabel;
    button.removeAttribute('aria-busy');
  }
}

window.E1 = {request, RequestError, asRequestError, toast, inlineMessage, fmt, kst, local, duration, labelCells, teamKey, busy};
})();
