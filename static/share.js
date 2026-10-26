// Admin "Share image": draws the current race status on a canvas and exports a PNG.
(() => {
'use strict';
const {toast, teamKey, kst} = window.E1;
const $ = id => document.getElementById(id);
const canvas = $('share-canvas');
if (!canvas) return;

const TEAM_COLORS = {mcjakey: '#ff8a1f', jaybull: '#ffd23f', alpinoo: '#ff7eb6', hoonrari: '#ff4b4b', meowcedes: '#2ee6c5', rikston: '#4cd964', other: '#8a8a96'};
const INK = {mcjakey: '#1f0e00', jaybull: '#241c00', alpinoo: '#2a0716', hoonrari: '#260404', meowcedes: '#032520', rikston: '#04230b', other: '#111'};
const E1_ORANGE = '#ff7a1a';
const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const MONO = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';
const FORMATS = {square: [1080, 1080], story: [1080, 1920], landscape: [1600, 900]};
const MAX_ROWS = 8;

let data = null;

// Helpers -------------------------------------------------------------------
const font = (size, weight = 700, family = SANS, italic = false) => `${italic ? 'italic ' : ''}${weight} ${Math.round(size)}px ${family}`;
const alpha = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
const fmt = n => new Intl.NumberFormat('en-GB').format(n);
const dayFmt = new Intl.DateTimeFormat('en-GB', {timeZone: 'Asia/Seoul', day: 'numeric', month: 'short'});
const day = s => dayFmt.format(new Date(s * 1000)).toUpperCase();

function fit(ctx, text, maxWidth, size, weight, family = SANS, italic = false, min = 0.55) {
  let s = size;
  ctx.font = font(s, weight, family, italic);
  while (ctx.measureText(text).width > maxWidth && s > size * min) { s -= 1; ctx.font = font(s, weight, family, italic); }
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}
function rrect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }
function spaced(ctx, text, x, y, spacing, align = 'left') {
  if ('letterSpacing' in ctx) { ctx.letterSpacing = `${spacing}px`; ctx.textAlign = align; ctx.fillText(text, x, y); ctx.letterSpacing = '0px'; return; }
  ctx.textAlign = align; ctx.fillText(text, x, y);
}

function options() {
  const form = $('share-form');
  return {
    format: form.elements.format.value,
    theme: form.elements.theme.value,
    kicker: form.elements.kicker.value.trim(),
    scores: form.elements.scores.checked,
    gaps: form.elements.gaps.checked,
    bonus: form.elements.bonus.checked,
    reps: form.elements.reps.checked,
  };
}

// Race facts ------------------------------------------------------------------
function facts(d, now) {
  const teams = d.teams || [];
  const leaders = teams.filter(t => t.rank === 1 && t.score != null);
  const leader = leaders.length === 1 ? leaders[0] : null;
  const total = Math.ceil((d.end - d.start) / 86400);
  let dayLabel, dayValue;
  if (d.state === 'Final') { dayLabel = 'FINAL'; dayValue = 'RESULTS'; }
  else if (now < d.start) { dayLabel = 'LIGHTS OUT'; dayValue = day(d.start); }
  else if (now > d.end) { dayLabel = 'RACE'; dayValue = 'CLOSED'; }
  else { dayLabel = 'DAY'; dayValue = `${Math.min(Math.floor((now - d.start) / 86400) + 1, total)}/${total}`; }
  const events = [...(d.events || [])].sort((a, b) => a.starts - b.starts);
  const live = events.filter(e => e.starts <= now && now <= e.ends);
  const next = events.find(e => e.starts > now);
  let eventLine;
  if (live.length) eventLine = `${live.map(e => e.name).join(' · ')} — open until ${kst(Math.min(...live.map(e => e.ends)))} KST`;
  else if (next && d.state !== 'Final') eventLine = `Next: ${next.name} — opens ${kst(next.starts)} KST`;
  else if (events.length) eventLine = 'All posting events closed';
  else eventLine = 'Posting events coming soon';
  const observed = (d.entries || []).map(e => e.observed_at).filter(Boolean);
  const status = d.state === 'Final' ? 'FINAL RESULTS' : d.simulation ? 'SIMULATION' : !d.weights ? 'AWAITING RULES' : now < d.start ? 'PRE-RACE' : now > d.end ? 'AWAITING FINAL CHECK' : 'PROVISIONAL';
  return {teams, leader, total, dayLabel, dayValue, eventLine, status,
    progress: Math.min(Math.max((now - d.start) / (d.end - d.start), 0), 1),
    asOf: observed.length ? `Counts as of ${kst(Math.max(...observed))} KST` : `Generated ${kst(now)} KST`};
}

// Layouts -----------------------------------------------------------------------
function layout(format, W, H) {
  const s = W / 1080;
  if (format === 'landscape') {
    const sl = H / 900;
    return {s: sl, pad: 64 * sl, header: 64 * sl, hero: {x: 64 * sl, y: 190 * sl, w: 560 * sl, big: 150 * sl},
      rows: {x: 680 * sl, y: 150 * sl, w: W - 680 * sl - 64 * sl, bottom: H - 150 * sl, maxH: 96 * sl},
      bar: {x: 64 * sl, y: H - 104 * sl, w: W - 128 * sl}, footer: H - 52 * sl};
  }
  if (format === 'story') {
    return {s, pad: 72 * s, header: 120 * s, hero: {x: 72 * s, y: 330 * s, w: W - 144 * s, big: 210 * s},
      rows: {x: 72 * s, y: 720 * s, w: W - 144 * s, bottom: H - 300 * s, maxH: 140 * s},
      bar: {x: 72 * s, y: H - 220 * s, w: W - 144 * s}, footer: H - 120 * s};
  }
  return {s, pad: 64 * s, header: 64 * s, hero: {x: 64 * s, y: 196 * s, w: W - 128 * s, big: 132 * s},
    rows: {x: 64 * s, y: 410 * s, w: W - 128 * s, bottom: H - 158 * s, maxH: 86 * s},
    bar: {x: 64 * s, y: H - 112 * s, w: W - 128 * s}, footer: H - 52 * s};
}

// Drawing -------------------------------------------------------------------------
function background(ctx, W, H, accent, L) {
  ctx.fillStyle = '#08080a'; ctx.fillRect(0, 0, W, H);
  // Faint grid, like a timing screen.
  ctx.strokeStyle = 'rgba(255,255,255,0.035)'; ctx.lineWidth = 1;
  const step = 48 * L.s;
  for (let x = 0; x < W; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y < H; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  // Glow.
  const glow = ctx.createRadialGradient(W * 0.85, -H * 0.05, 0, W * 0.85, -H * 0.05, Math.max(W, H) * 0.75);
  glow.addColorStop(0, alpha(accent, 0.38)); glow.addColorStop(1, alpha(accent, 0));
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
  // Vignette at the bottom.
  const fade = ctx.createLinearGradient(0, H * 0.6, 0, H);
  fade.addColorStop(0, 'rgba(8,8,10,0)'); fade.addColorStop(1, 'rgba(8,8,10,0.85)');
  ctx.fillStyle = fade; ctx.fillRect(0, H * 0.6, W, H * 0.4);
}

function header(ctx, W, L, accent, ink, f) {
  const s = L.s, y = L.header;
  // Skewed E1 badge.
  ctx.save(); ctx.translate(L.pad, y); ctx.transform(1, 0, -0.18, 1, 0, 0);
  ctx.fillStyle = accent; rrect(ctx, 6 * s, 0, 84 * s, 58 * s, 10 * s); ctx.fill();
  ctx.fillStyle = ink; ctx.font = font(36 * s, 900, SANS, true); ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  ctx.fillText('E1', 48 * s, 30 * s); ctx.restore();
  ctx.textBaseline = 'middle'; ctx.fillStyle = '#f4f4f6'; ctx.font = font(28 * s, 800);
  spaced(ctx, 'SOCIAL GRID RACE', L.pad + 112 * s, y + 29 * s, 4 * s);
  // Status pill on the right.
  ctx.font = font(20 * s, 800);
  const label = f.status;
  const tw = ('letterSpacing' in ctx ? ctx.measureText(label).width + label.length * 2 * s : ctx.measureText(label).width);
  const pw = tw + 64 * s, ph = 44 * s, px = W - L.pad - pw, py = y + 7 * s;
  ctx.fillStyle = '#0d0d10'; rrect(ctx, px, py, pw, ph, ph / 2); ctx.fill();
  ctx.fillStyle = alpha(accent, 0.16); ctx.fill();
  ctx.strokeStyle = alpha(accent, 0.6); ctx.lineWidth = 2 * s; ctx.stroke();
  ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(px + 22 * s, py + ph / 2, 6 * s, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#f4f4f6'; spaced(ctx, label, px + 38 * s, py + ph / 2 + 1, 2 * s);
}

function hero(ctx, L, accent, f, o) {
  const s = L.s, {x, y, w, big} = L.hero;
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  ctx.fillStyle = accent; ctx.font = font(24 * s, 800);
  spaced(ctx, (o.kicker || 'ENHYPEN MAMA GRAND PRIX').toUpperCase(), x, y, 5 * s);
  // "DAY 6/12": label and value share a baseline, value huge.
  const baseline = y + big * 0.98;
  ctx.fillStyle = alpha('#ffffff', 0.55);
  ctx.font = font(big * 0.34, 900, SANS, true);
  ctx.fillText(f.dayLabel, x, baseline);
  const labelW = ctx.measureText(f.dayLabel).width + 18 * s;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(fit(ctx, f.dayValue, w - labelW, big, 900, SANS, true), x + labelW, baseline);
  // Event line.
  ctx.fillStyle = '#b4b4be';
  const line = fit(ctx, f.eventLine, w, 26 * s, 600);
  ctx.fillText(line, x, baseline + Math.max(50 * s, big * 0.34));
}

function rows(ctx, L, accent, ink, f, o) {
  const s = L.s, R = L.rows;
  const teams = f.teams.slice(0, MAX_ROWS);
  const extra = f.teams.length - teams.length;
  const gap = 10 * s;
  if (!teams.length) {
    ctx.fillStyle = '#9a9aa6'; ctx.font = font(30 * s, 700); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('Teams will appear here once registered.', R.x, R.y + 60 * s);
    return;
  }
  const h = Math.min(R.maxH, (R.bottom - R.y - gap * (teams.length - 1) - (extra ? 30 * s : 0)) / teams.length);
  const leaderScore = f.leader?.score;
  teams.forEach((t, i) => {
    const y = R.y + i * (h + gap);
    const color = TEAM_COLORS[teamKey(t.name)];
    const isP1 = t.rank === 1 && t.score != null;
    // Row background.
    if (isP1) {
      const g = ctx.createLinearGradient(R.x, 0, R.x + R.w, 0);
      g.addColorStop(0, alpha(accent, 0.34)); g.addColorStop(0.55, 'rgba(22,22,27,1)');
      rrect(ctx, R.x, y, R.w, h, 14 * s); ctx.fillStyle = '#16161b'; ctx.fill();
      ctx.fillStyle = g;
    } else ctx.fillStyle = '#16161b';
    rrect(ctx, R.x, y, R.w, h, 14 * s); ctx.fill();
    ctx.strokeStyle = isP1 ? alpha(accent, 0.75) : 'rgba(255,255,255,0.07)'; ctx.lineWidth = (isP1 ? 2.5 : 1.5) * s; ctx.stroke();
    // Position block.
    const pw = h * 0.95;
    ctx.save(); rrect(ctx, R.x, y, R.w, h, 14 * s); ctx.clip();
    ctx.fillStyle = isP1 ? accent : t.rank && t.rank <= 3 ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.04)';
    ctx.beginPath(); ctx.moveTo(R.x, y); ctx.lineTo(R.x + pw + h * 0.18, y); ctx.lineTo(R.x + pw - h * 0.18, y + h); ctx.lineTo(R.x, y + h); ctx.closePath(); ctx.fill();
    ctx.restore();
    ctx.fillStyle = isP1 ? ink : '#f4f4f6'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = font(h * 0.42, 900, MONO, true);
    ctx.fillText(t.rank ? `P${t.rank}` : '—', R.x + pw * 0.48, y + h / 2 + 1);
    // Team colour bar.
    const bx = R.x + pw + h * 0.14;
    ctx.fillStyle = color; rrect(ctx, bx, y + h * 0.2, 7 * s, h * 0.6, 4 * s); ctx.fill();
    // Score block (right).
    const right = R.x + R.w - 26 * s;
    let scoreW = 0;
    ctx.textAlign = 'right';
    if (o.scores || t.score == null) {
      const showGap = o.gaps && t.score != null;
      const scoreY = showGap ? y + h * 0.42 : y + h / 2;
      if (t.score != null) { ctx.fillStyle = '#ffffff'; ctx.font = font(h * 0.40, 800, MONO); ctx.fillText(fmt(t.score), right, scoreY); }
      else { ctx.fillStyle = '#ffc547'; ctx.font = font(h * 0.30, 800); ctx.fillText('PENDING', right, y + h / 2); }
      scoreW = ctx.measureText(t.score != null ? fmt(t.score) : 'PENDING').width;
      if (showGap) {
        ctx.fillStyle = isP1 ? accent : '#8a8a96'; ctx.font = font(h * 0.21, 700, MONO);
        ctx.fillText(isP1 ? 'LEADER' : leaderScore != null ? `−${fmt(leaderScore - t.score)}` : '', right, y + h * 0.75);
      }
    } else if (o.gaps && t.score != null) {
      ctx.fillStyle = isP1 ? accent : '#c4c4cc'; ctx.font = font(h * 0.30, 800, MONO);
      const g = isP1 ? 'LEADER' : leaderScore != null ? `−${fmt(leaderScore - t.score)}` : '';
      ctx.fillText(g, right, y + h / 2); scoreW = ctx.measureText(g).width;
    }
    // Bonus chip.
    let chipW = 0;
    if (o.bonus && t.bonus_percent) {
      const text = `+${t.bonus_percent}% GP`;
      ctx.font = font(h * 0.2, 800); const tw = ctx.measureText(text).width;
      chipW = tw + 28 * s; const cx = right - scoreW - 22 * s - chipW, ch = h * 0.36;
      ctx.fillStyle = alpha(accent, 0.18); rrect(ctx, cx, y + (h - ch) / 2, chipW, ch, ch / 2); ctx.fill();
      ctx.fillStyle = accent; ctx.textAlign = 'center'; ctx.fillText(text, cx + chipW / 2, y + h / 2 + 1);
      chipW += 22 * s;
    }
    // Name + representative.
    const nx = bx + 26 * s, maxName = right - scoreW - chipW - 30 * s - nx;
    ctx.textAlign = 'left'; ctx.fillStyle = '#ffffff';
    const showRep = o.reps && h > 60 * s;
    const name = fit(ctx, t.name.toUpperCase(), maxName, h * 0.34, 900, SANS, true);
    ctx.fillText(name, nx, showRep ? y + h * 0.40 : y + h / 2 + 1);
    if (showRep) {
      ctx.fillStyle = '#9a9aa6';
      ctx.fillText(fit(ctx, t.representative, maxName, h * 0.21, 600), nx, y + h * 0.72);
    }
  });
  if (extra) {
    ctx.fillStyle = '#8a8a96'; ctx.font = font(20 * s, 700); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(`+ ${extra} more ${extra === 1 ? 'team' : 'teams'}`, R.x, R.y + teams.length * (h + gap) + 8 * s);
  }
}

function progress(ctx, W, L, accent, f, d) {
  const s = L.s, {x, y, w} = L.bar, h = 12 * s;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(255,255,255,0.08)'; rrect(ctx, x, y, w, h, h / 2); ctx.fill();
  if (f.progress > 0) {
    const g = ctx.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, alpha(accent, 0.55)); g.addColorStop(1, accent);
    ctx.fillStyle = g; rrect(ctx, x, y, Math.max(w * f.progress, h), h, h / 2); ctx.fill();
  }
  // Chequered flag at the finish.
  const cell = 7 * s, fx = x + w - cell * 4, fy = y - cell * 4 - 10 * s;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) { ctx.fillStyle = (r + c) % 2 ? '#08080a' : '#f4f4f6'; ctx.fillRect(fx + c * cell, fy + r * cell, cell, cell); }
  ctx.font = font(18 * s, 800); ctx.fillStyle = '#9a9aa6';
  ctx.textAlign = 'left'; spaced(ctx, `${day(d.start)} · 18:00 KST`, x, y - 16 * s, 1.5 * s);
  ctx.textAlign = 'right'; spaced(ctx, `${day(d.end)} · 23:59 KST`, x + w - cell * 4 - 14 * s, y - 16 * s, 1.5 * s, 'right');
}

function footer(ctx, W, L, f) {
  const s = L.s;
  ctx.textBaseline = 'alphabetic'; ctx.font = font(20 * s, 700); ctx.fillStyle = '#d4d4da'; ctx.textAlign = 'left';
  ctx.fillText(location.host || 'e1-social-race.rrriooo.com', L.pad, L.footer);
  ctx.textAlign = 'right'; ctx.fillStyle = '#8a8a96'; ctx.font = font(18 * s, 600);
  ctx.fillText(`${f.asOf} · fan-made`, W - L.pad, L.footer);
}

function draw() {
  if (!data) return;
  const o = options();
  const [W, H] = FORMATS[o.format] || FORMATS.square;
  canvas.width = W; canvas.height = H;
  canvas.dataset.format = o.format;
  const ctx = canvas.getContext('2d');
  const now = Date.now() / 1000;
  const f = facts(data, now);
  const key = o.theme === 'leader' && f.leader ? teamKey(f.leader.name) : o.theme !== 'leader' && o.theme !== 'e1' ? o.theme : null;
  const accent = key && key !== 'other' ? TEAM_COLORS[key] : E1_ORANGE;
  const ink = key && key !== 'other' ? INK[key] : '#1a0d02';
  const L = layout(o.format, W, H);
  background(ctx, W, H, accent, L);
  header(ctx, W, L, accent, ink, f);
  hero(ctx, L, accent, f, o);
  rows(ctx, L, accent, ink, f, o);
  progress(ctx, W, L, accent, f, data);
  footer(ctx, W, L, f);
  $('share-meta').textContent = `${W} × ${H} px · ${f.teams.length} ${f.teams.length === 1 ? 'team' : 'teams'} · ${f.asOf}`;
}

function filename() {
  const o = options();
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return `e1-social-grid-race-${stamp}-${o.format}.png`;
}

function toBlob() {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The browser could not create the image.')), 'image/png'));
}

$('share-form').addEventListener('input', draw);
$('share-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!data) { toast('error', 'No data yet', 'Wait for the race data to load, then try again.'); return; }
  try {
    draw();
    const url = URL.createObjectURL(await toBlob());
    const link = document.createElement('a');
    link.href = url; link.download = filename(); document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast('success', 'Image downloaded', filename());
  } catch (error) {
    toast('error', 'Download failed', error.message);
  }
});

const copy = $('share-copy');
if (copy) {
  copy.hidden = !(navigator.clipboard && window.ClipboardItem);
  copy.addEventListener('click', async () => {
    try {
      draw();
      await navigator.clipboard.write([new ClipboardItem({'image/png': toBlob()})]);
      toast('success', 'Image copied', 'Paste it straight into a post or a chat.');
    } catch (error) {
      toast('error', 'Copy failed', 'Your browser blocked clipboard access. Use Download instead.');
    }
  });
}

document.addEventListener('race-loaded', event => { data = event.detail; draw(); });
// Redraw when the tab becomes visible so "Day N" and the event are current.
addEventListener('hashchange', () => { if (location.hash === '#share') draw(); });
})();
