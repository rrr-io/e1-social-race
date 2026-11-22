// EMGP26 certificate: draws the pass (front + back) and the crew licence on 2D canvases, shows the pass as a real 3D
// object with three.js (drag / flip / phone motion, holographic foil) and exports the
// front as PNG and a 4-second spin as video. Everything happens in the browser.
import * as THREE from '/vendor/three.module.min.js';

const {inlineMessage, toast} = window.E1 || {inlineMessage: () => {}, toast: () => {}};
const $ = id => document.getElementById(id);
const form = $('lic-form');
const stage = $('lic-3d');
const message = $('lic-message');

// Data ---------------------------------------------------------------------------
const TEAMS = {
  jaybull: {name: 'Jaybull Racing', member: 'Team Jay', color: '#ffd23f'},
  mcjakey: {name: 'McJakey', member: 'Team Jake', color: '#ff8a1f'},
  hoonrari: {name: 'Hoonrari', member: 'Team Sunghoon', color: '#ff4b4b'},
  alpinoo: {name: 'Alpinoo', member: 'Team Sunoo', color: '#ff7eb6'},
  meowcedes: {name: 'Meowcedes', member: 'Team Jungwon', color: '#2ee6c5'},
  rikston: {name: 'Rikston Drift', member: 'Team Ni-ki', color: '#13804f'},   // bottle green
  independent: {name: 'Independent Crew', member: '', color: '#3b82f6'},
  staff: {name: 'EMGP Admin', member: '', color: '#9a9ca6'},           // the organisers: own finish, no licence
  crew: {name: 'EMGP Staff', member: '', color: '#9a9ca6'},            // staff (e.g. Paddock Announcers): like the admins, a step apart
};
const CLASSIC = '#9a9ca6';   // the default (no team) colour, for who prefers it to the team colour
// More than one role in the list ("Co-Team Captain; Social Media Creator"): the first is the main one.
const roleList = v => (v.role || '').split(/\s*(?:;|\||\/|\+|&|·)\s*/).filter(Boolean);
const teamLabel = (team, sep) => team.member ? `${team.name}${sep}${team.member}` : team.name;
// Coordinator roles from the E1 glossary: what each one did, shown under the role on the certificate.
const ROLES = {
  'Team Manager': 'Team management', 'Team Captain': 'Leader', 'Co-Team Captain': 'Co-leader', 'Race Engineer': 'Race strategist',
  'Social Media Creator': 'Social Grid Race',
  'Paddock Announcer': 'EMGP Radio · Announcements',
  'Circuit Operations': 'Admin team', 'Admin Media Crew': 'Admin team · Media', 'Race Control': 'Admin team · Race direction',
  'E1 System Steward': 'Race steward · Voting proof checker', 'Manual Steward': 'Race steward · Proof encoder & checker', 'Media Crew': 'Race steward · Media',
};
// The progression ladder and the prestige distinctions of e1.ensite.org.
const LEVELS = [
  ['Paddock Rookie', 0], ['Race Ready', 5], ['Fast Lane', 10], ['Pit Lane Pro', 20], ['Redline Ace', 25],
  ['Paddock Icon', 50], ['Circuit Storm', 75], ['E1 Elite', 100], ['Diamond Crew', 150], ['All-Star', 200],
  ['Hall of Fame', 250, 'flag'], ['Grand Prix Legend', 500, 'flag'], ['E1 Titan', 750, 'flag'], ['E1 Immortal', 1000, 'flag'],
  ['E1 Eternal', 5000, 'star'], ['Supersonic Vanguard', 10000, 'star'], ['Hyperdrive Elite', 25000, 'star'], ['E1 Singularity', 50000, 'star'],
].map(([name, points, tier], index) => ({name, points, tier: tier || 'ladder', index}));

const levelSelect = $('lic-level');
for (const [label, tier] of [['Progression ladder', 'ladder'], ['Prestige distinctions', 'flag'], ['', 'star']]) {
  const group = tier === 'star' ? levelSelect.lastElementChild : document.createElement('optgroup');
  if (tier !== 'star') { group.label = label; levelSelect.append(group); }
  for (const level of LEVELS.filter(l => l.tier === tier)) {
    const option = document.createElement('option');
    option.value = String(level.index);
    option.textContent = `${level.name} · ${level.points.toLocaleString('en-GB')} pts`;
    group.append(option);
  }
}

// The crew list (server side): once it is loaded, a crew member only picks the username and the rest comes from it.
let crewLoaded = false, picked = null, shownName = '';   // shownName: an X handle chosen instead of the username
function values() {
  const username = shownName ? `@${shownName}` : (picked ? picked.username : form.elements.username.value).trim().replace(/^@/, '');
  const base = TEAMS[form.elements.team.value] || null;
  // "Classic" colour: the same team, in neutral silver instead of the team colour.
  const team = base && form.elements.color?.value === 'classic' ? {...base, color: CLASSIC} : base;
  const level = form.elements.level.value === '' ? null : LEVELS[Number(form.elements.level.value)] || null;
  const role = picked?.role || '', donor = Boolean(picked?.donor), tier = {staff: 'admin', crew: 'staff'}[form.elements.team.value] || '', staff = Boolean(tier);
  // Creators and donors who did not race: no level, a licence of their own.
  const special = !staff && picked && !picked.level ? (roleList({role}).includes('Social Media Creator') ? 'creator' : donor ? 'supporter' : null) : null;
  return {username, key: picked?.username || username, team, level, role, donor, staff, tier, special, complete: Boolean(username && team && (level || staff || special) && (!crewLoaded || picked))};
}

// 2D card drawing ------------------------------------------------------------------
const CW = 1600, CH = 900, SCALE = 2, RADIUS = 52;
const FONT = '"Titillium Web", system-ui, sans-serif';
const RED = '#e10600';
const font = (size, weight) => `${weight} ${size}px ${FONT}`;
const logo = new Image();
logo.src = '/e1-logo.png';
const qr = new Image();
qr.src = '/e1-qr.png';

function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }
function fit(ctx, text, maxWidth, size, weight, min = 0.55) {
  let s = size;
  ctx.font = font(s, weight);
  while (ctx.measureText(text).width > maxWidth && s > size * min) { s -= 2; ctx.font = font(s, weight); }
  return s;
}
function spaced(ctx, text, x, y, spacing) {
  for (const ch of text) { ctx.fillText(ch, x, y); x += ctx.measureText(ch).width + spacing; }
}
function background(ctx, v, cx, cy) {
  const g = ctx.createRadialGradient(CW * .3, CH * .25, 0, CW * .3, CH * .25, CW);
  g.addColorStop(0, '#24272d'); g.addColorStop(1, '#0d0e11');
  ctx.fillStyle = g; ctx.fillRect(0, 0, CW, CH);
  // Radial lines and rings: the motif of the E1 crew licence.
  ctx.strokeStyle = 'rgba(255,255,255,.09)'; ctx.lineWidth = 1.6;
  for (let i = 0; i < 36; i++) {
    const a = i / 36 * Math.PI * 2 + .05;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * 2400, cy + Math.sin(a) * 2400); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(255,255,255,.34)'; ctx.lineWidth = 2;
  for (const r of [210, 158, 106, 54]) { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke(); }
  if (v.level?.tier === 'star') {
    // Prestige stars: a violet glow, like the Hyperdrive cards.
    const p = ctx.createRadialGradient(CW, CH, 0, CW, CH, CW * .9);
    p.addColorStop(0, 'rgba(120,70,170,.35)'); p.addColorStop(1, 'rgba(120,70,170,0)');
    ctx.fillStyle = p; ctx.fillRect(0, 0, CW, CH);
  }
}
function drawLogo(ctx, x, y, h, alpha = 1) {
  if (!logo.complete || !logo.naturalWidth) return;
  ctx.globalAlpha = alpha;
  ctx.drawImage(logo, x, y, h * logo.naturalWidth / logo.naturalHeight, h);
  ctx.globalAlpha = 1;
}

// The 18 licence designs (static/licences/NN.png, 1600 x 900, name and team left blank):
// colours of the holder's name and team on each design, and whether it is a dark design.
const INK = {
  '01': ['#20242b', '#565b62'], '02': ['#20242b', '#565b62'], '03': ['#20242b', '#565b62'], '04': ['#20242b', '#565b62'],
  '05': ['#20242b', '#565b62'], '06': ['#20242b', '#565b62'], '07': ['#20242b', '#565b62'], '08': ['#20242b', '#565b62'],
  '09': ['#20242b', '#565b62'], '10': ['#ffffff', '#f2d4d2', 'dark'], '11': ['#20242b', '#565b62'], '12': ['#20242b', '#565b62'],
  '13': ['#20242b', '#565b62'], '14': ['#ffffff', '#e5e5e5', 'dark'], '15': ['#202c33', '#455e68'], '16': ['#f1faff', '#b6d3ea', 'dark'],
  '17': ['#fff4fc', '#d8bdd8', 'dark'], '18': ['#f8f9fb', '#c0c4cd', 'dark'],
};
const designs = {};
const code = level => String(level.index + 1).padStart(2, '0');
function design(level) {
  const key = code(level);
  if (!designs[key]) {
    designs[key] = new Promise(resolve => {
      const img = new Image();
      img.onload = () => resolve(img); img.onerror = () => resolve(null);
      img.src = `/licences/${key}.png`;
    });
  }
  return designs[key];
}

function drawPlaceholder(ctx) {
  // No level chosen yet: a neutral card that says what to do.
  const g = ctx.createLinearGradient(0, 0, CW, CH);
  g.addColorStop(0, '#1d2026'); g.addColorStop(1, '#0d0e11');
  ctx.fillStyle = g; ctx.fillRect(0, 0, CW, CH);
  ctx.fillStyle = RED; ctx.fillRect(52, 126, 56, 7);
  ctx.fillStyle = '#e9e9ee'; ctx.font = font(27, 700); spaced(ctx, 'ENHYPEN MAMA GRAND PRIX', 132, 139, 3);
  ctx.fillStyle = '#fff'; ctx.font = font(84, 700); ctx.textAlign = 'right'; ctx.fillText('CREW LICENCE', CW - 92, 158); ctx.textAlign = 'left';
  ctx.fillStyle = '#5d6069'; ctx.font = font(84, 700); ctx.fillText('CHOOSE YOUR LEVEL', 90, 612);
  drawLogo(ctx, 1250, 726, 104, .5);
}

// Admin pass: what the organisers carry in the sleeve instead of a crew licence (same size).
// Inspired by paddock credentials: matte black, a coloured frame and corner tab (red for Race Control,
// white for the other admins: never a team colour), an art-deco double line over a chevron parquet,
// a holographic serial sticker and the role in large type.
// Admin: red frame for Race Control, white for the others. Radio (staff): dark violet. Never a team colour.
const adminFrame = v => v.tier === 'staff' ? {c: '#33195c', ink: '#fff'} : v.role === 'Race Control' ? {c: '#e10600', ink: '#fff'} : {c: '#eef0f4', ink: '#111214'};
const TIER = {admin: {pass: 'ADMIN PASS', tab: 'ADMIN', team: 'EMGP ADMIN TEAM', group: 'Admin team', video: 'EMGP Admin Team'},
              staff: {pass: 'RADIO PASS', tab: 'RADIO', team: 'EMGP RADIO', group: 'EMGP Radio team', video: 'EMGP Radio'}};
const tierText = v => TIER[v.tier] || TIER.admin;
const DECO = [[0, 640], [840, 640], [990, 790], [CW, 790]];
const AB = 18, TAB = {w: 128, y: 470, r: 26};   // frame width; side tab (one raised piece with the frame)
function decoLine(ctx, dy) { ctx.beginPath(); DECO.forEach(([x, y], i) => i ? ctx.lineTo(x, y + dy) : ctx.moveTo(x, y + dy)); }
function panelPath(ctx) {
  // The recessed black panel: inside the frame, minus the side tab (bevelled corner where they meet).
  const x0 = AB, y0 = AB, x1 = CW - AB, y1 = CH - AB, r = RADIUS - AB, tx = x1 - TAB.w;
  ctx.beginPath(); ctx.moveTo(x0 + r, y0); ctx.lineTo(x1 - r, y0); ctx.quadraticCurveTo(x1, y0, x1, y0 + r);
  ctx.lineTo(x1, TAB.y); ctx.lineTo(tx + TAB.r, TAB.y); ctx.lineTo(tx, TAB.y + TAB.r);   // bevelled corner
  ctx.lineTo(tx, y1); ctx.lineTo(x0 + r, y1); ctx.quadraticCurveTo(x0, y1, x0, y1 - r);
  ctx.lineTo(x0, y0 + r); ctx.quadraticCurveTo(x0, y0, x0 + r, y0); ctx.closePath();
}
// Radio pass: the step goes up instead of down, over a diamond lattice instead of the parquet.
const RADIO_DECO = [[0, 740], [700, 740], [860, 580], [CW, 580]];
function radioLine(ctx, dy) { ctx.beginPath(); RADIO_DECO.forEach(([x, y], i) => i ? ctx.lineTo(x, y + dy) : ctx.moveTo(x, y + dy)); }
function radioWaves(ctx, colour) {
  ctx.save(); ctx.beginPath(); RADIO_DECO.forEach(([x, y], i) => i ? ctx.lineTo(x, y + 26) : ctx.moveTo(x, y + 26));
  ctx.lineTo(CW, CH); ctx.lineTo(0, CH); ctx.closePath(); ctx.clip();
  ctx.strokeStyle = colour; ctx.lineWidth = 2.2;
  const d = 46;   // diamonds: two sets of diagonals, with a dot in every other diamond
  for (let k = -CH; k < CW + CH; k += d) {
    ctx.beginPath(); ctx.moveTo(k, 500); ctx.lineTo(k + CH, 500 + CH); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(k, 500); ctx.lineTo(k - CH, 500 + CH); ctx.stroke();
  }
  ctx.fillStyle = colour;
  for (let y = 500 + d / 2; y < CH; y += d) for (let x = ((y - 500) / d % 2 ? d / 2 : 0); x < CW; x += d) { ctx.beginPath(); ctx.arc(x, y, 2.6, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
}
const passPattern = (ctx, v, colour) => v.tier === 'staff' ? radioWaves(ctx, colour) : parquet(ctx, colour);
const passLine = (ctx, v, dy) => v.tier === 'staff' ? radioLine(ctx, dy) : decoLine(ctx, dy);
function parquet(ctx, colour) {
  // Chevron parquet below the deco line.
  ctx.save(); ctx.beginPath(); DECO.forEach(([x, y], i) => i ? ctx.lineTo(x, y + 26) : ctx.moveTo(x, y + 26)); ctx.lineTo(CW, CH); ctx.lineTo(0, CH); ctx.closePath(); ctx.clip();
  ctx.strokeStyle = colour; ctx.lineWidth = 2.2;
  const W = 58, H = 44;
  for (let c = 0; c * W < CW; c++) {
    const x0 = c * W;
    ctx.beginPath(); ctx.moveTo(x0, 600); ctx.lineTo(x0, CH); ctx.stroke();
    for (let y = 560 + (c % 2) * H / 2; y < CH + W; y += H) {
      ctx.beginPath();
      if (c % 2) { ctx.moveTo(x0, y + W); ctx.lineTo(x0 + W, y); } else { ctx.moveTo(x0, y); ctx.lineTo(x0 + W, y + W); }
      ctx.stroke();
    }
  }
  ctx.restore();
}
function adminRole(ctx, v) {
  const words = (v.role || 'Admin').toUpperCase().split(' '), lines = words.length > 1 ? [words.slice(0, -1).join(' '), words.at(-1)] : words;
  let size = 96; ctx.font = font(size, 700);
  while (Math.max(...lines.map(l => ctx.measureText(l).width)) > 1000 && size > 64) { size -= 4; ctx.font = font(size, 700); }
  return {lines, size};
}
function drawStaffPass(ctx, v) {
  const f = adminFrame(v);
  ctx.save(); roundRect(ctx, 0, 0, CW, CH, RADIUS); ctx.clip();
  // Frame and tab: one raised piece, lit from the top left.
  ctx.fillStyle = f.c; ctx.fillRect(0, 0, CW, CH);
  const lit = ctx.createLinearGradient(0, 0, CW, CH); lit.addColorStop(0, 'rgba(255,255,255,.28)'); lit.addColorStop(.5, 'rgba(255,255,255,0)'); lit.addColorStop(1, 'rgba(0,0,0,.28)');
  ctx.fillStyle = lit; ctx.fillRect(0, 0, CW, CH);
  // Panel, recessed: dark fill, then an inner shadow along its edge and a light lip on the frame.
  ctx.save(); ctx.translate(-1.5, -1.5); panelPath(ctx); ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,.45)'; ctx.stroke(); ctx.restore();
  ctx.save(); panelPath(ctx); ctx.clip();
  const g = ctx.createLinearGradient(0, 0, CW, CH); g.addColorStop(0, '#17181c'); g.addColorStop(1, '#08090a');
  ctx.fillStyle = g; ctx.fillRect(0, 0, CW, CH);
  passPattern(ctx, v, 'rgba(220,224,232,.16)');
  ctx.lineWidth = 2.5; ctx.strokeStyle = 'rgba(230,233,238,.75)'; passLine(ctx, v, 0); ctx.stroke(); passLine(ctx, v, 14); ctx.stroke();
  ctx.shadowColor = 'rgba(0,0,0,.9)'; ctx.shadowBlur = 22; ctx.shadowOffsetX = 5; ctx.shadowOffsetY = 6;
  panelPath(ctx); ctx.lineWidth = 16; ctx.strokeStyle = '#000'; ctx.stroke();
  ctx.restore();
  // Header: E1 and the event.
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  if (logo.complete && logo.naturalWidth) { const h = 92, w = h * logo.naturalWidth / logo.naturalHeight; ctx.drawImage(logo, 82, 66, w, h); }
  ctx.fillStyle = '#c9ccd3'; ctx.font = font(22, 700); spaced(ctx, 'ENHYPEN MAMA GRAND PRIX 2026', 84, 200, 5);
  // Holographic serial sticker.
  const sw = 330, sh = 100, sx = CW - AB - 60 - sw, sy = 62;
  const holo = ctx.createLinearGradient(sx, sy, sx + sw, sy + sh);
  ['#d9dce3', '#f3e6ff', '#d8f3ff', '#fff6d6', '#e6e8ee', '#ffe0ef', '#d9dce3'].forEach((col, i, a) => holo.addColorStop(i / (a.length - 1), col));
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 3; roundRect(ctx, sx, sy, sw, sh, 10); ctx.fillStyle = holo; ctx.fill(); ctx.restore();
  let seed = 3; const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < 240; i++) { ctx.fillStyle = `rgba(255,255,255,${.4 + rnd() * .6})`; ctx.fillRect(sx + rnd() * sw, sy + rnd() * sh, 1.3, 1.3); }
  ctx.fillStyle = '#3a3550'; ctx.font = font(19, 700); spaced(ctx, tierText(v).pass, sx + 24, sy + 38, 4);
  ctx.font = font(32, 700); spaced(ctx, licenceNumber(v), sx + 24, sy + 80, 3);
  // Role on two lines in polished chrome; then the holder's name, large.
  const {lines, size} = adminRole(ctx, v);
  lines.forEach((l, i) => {
    const y = 316 + i * size * .95;
    ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillText(l, 80, y + 4);
    ctx.fillStyle = chromeFill(ctx, y - size * .74, y); ctx.fillText(l, 78, y);
  });
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  const name = v.username || 'Your Name';
  ctx.fillStyle = '#fff'; fit(ctx, name, 760, 92, 700); ctx.fillText(name, 80, 534);
  ctx.fillStyle = '#9da1ab'; ctx.font = font(24, 600); spaced(ctx, tierText(v).team, 86, 600, 4);
  // ADMIN on the tab.
  ctx.save(); ctx.translate(CW - AB - TAB.w / 2 + 22, CH - 74); ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.font = `italic ${font(72, 700)}`; ctx.fillText(tierText(v).tab, 2, 3);
  ctx.fillStyle = f.ink; ctx.fillText(tierText(v).tab, 0, 0);
  ctx.restore();
  ctx.restore();
}
// Height map for the 3D admin pass: frame and tab raised, panel lower, engraved lines.
function drawStaffRelief(ctx, v) {
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, CW, CH);
  panelPath(ctx); ctx.fillStyle = '#7a7a7a'; ctx.fill();
  ctx.save(); panelPath(ctx); ctx.clip();
  passPattern(ctx, v, '#d0d0d0'); ctx.lineWidth = 3; ctx.strokeStyle = '#d0d0d0'; passLine(ctx, v, 0); ctx.stroke(); passLine(ctx, v, 14); ctx.stroke();
  // The role, raised, so the chrome letters catch the light in 3D.
  const {lines, size} = adminRole(ctx, v); ctx.fillStyle = '#fff'; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  lines.forEach((l, i) => ctx.fillText(l, 78, 316 + i * size * .95));
  ctx.restore();
}
// Creator / supporter licence: the base crew licence layout (paper, red bar, car badge) with their own
// title and a reference to what they did instead of a level, and team-colour stripes.
const SPECIAL = {
  creator: {title: 'CREATOR LICENCE', line: 'SOCIAL MEDIA CREATOR', foot: 'SOCIAL GRID RACE · 2026'},
  supporter: {title: 'SUPPORTER LICENCE', line: 'CAMPAIGN SUPPORTER', foot: 'EMGP CAMPAIGN · 2026'},
};
async function baseArt() { return design(LEVELS[0]); }
function drawSpecialLicence(ctx, v, base) {
  const k = SPECIAL[v.special], c = v.team?.color || '#9a9ca6';
  ctx.save(); roundRect(ctx, 0, 0, CW, CH, RADIUS); ctx.clip();
  ctx.fillStyle = '#eeeae3'; ctx.fillRect(0, 0, CW, CH);   // the paper of the base design
  // The car badge of the crew licences (bottom right of the base design).
  if (base) ctx.drawImage(base, 1120, 690, 440, 190, 1120, 690, 440, 190);
  // Team-colour stripes where the level motif would be.
  ctx.save(); ctx.translate(1240, 0); ctx.transform(1, 0, -.75, 1, 0, 0);
  [[600, 64], [690, 64], [780, 22]].forEach(([x, w]) => { ctx.fillStyle = c; ctx.fillRect(x - 600 + 330, 360, w, 250); });
  ctx.restore();
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  ctx.fillStyle = RED; ctx.fillRect(52, 126, 56, 7);
  ctx.fillStyle = '#26282e'; ctx.font = font(27, 700); spaced(ctx, 'ENHYPEN MAMA GRAND PRIX', 132, 139, 3);
  ctx.fillStyle = '#1d1f24'; fit(ctx, k.title, 860, 84, 700); ctx.textAlign = 'right'; ctx.fillText(k.title, CW - 92, 158); ctx.textAlign = 'left';
  const name = v.username || 'Your Name';
  ctx.fillStyle = '#1d1f24'; fit(ctx, name, 900, 81, 700); ctx.fillText(name, 88, 386);
  ctx.fillStyle = '#5a5d66'; fit(ctx, teamLabel(v.team, ' - '), 900, 46, 600); ctx.fillText(teamLabel(v.team, ' - '), 89, 463);
  ctx.fillStyle = '#1d1f24'; fit(ctx, k.line, 980, 84, 700); ctx.fillText(k.line, 90, 612);
  ctx.fillStyle = 'rgba(30,32,38,.25)'; ctx.fillRect(90, 758, 1050, 2);
  ctx.fillStyle = '#26282e'; ctx.font = font(38, 700); ctx.fillText(k.foot, 90, 822);
  ctx.restore();
}
function drawLicence(ctx, v, art) {
  if (v.staff) return drawStaffPass(ctx, v);
  if (v.special) return drawSpecialLicence(ctx, v, art);
  ctx.save();
  roundRect(ctx, 0, 0, CW, CH, RADIUS); ctx.clip();
  if (art) ctx.drawImage(art, 0, 0, CW, CH); else drawPlaceholder(ctx);
  // Holder: same place and size as "Your Name / Your Team" on the designs.
  const [ink, sub] = v.level ? INK[code(v.level)] : ['#ffffff', '#c0c4cd'];
  ctx.textBaseline = 'alphabetic';
  const name = v.username || 'Your Name';
  ctx.fillStyle = ink; ctx.globalAlpha = v.username ? 1 : .35;
  fit(ctx, name, 900, 81, 700); ctx.fillText(name, 88, 386);
  const team = v.team ? teamLabel(v.team, ' - ') : 'Your Team';
  ctx.fillStyle = sub; ctx.globalAlpha = v.team ? 1 : .5;
  fit(ctx, team, 900, 46, 600); ctx.fillText(team, 89, 463);
  ctx.globalAlpha = 1;
  ctx.restore();
}

// The certificate: a paddock-pass style card (portrait) in the team colour, with the
// crew licence in a clear sleeve on the front and the ENHYPEN MAMA 2026 awards on the back.
const PW = 820, PH = 1200, PSCALE = 2.5, PRADIUS = 42;
const AWARDS = [   // 2026 MAMA Awards, Kyocera Dome Osaka
  ["Fans' Choice Male Top 10", 'BONSANG'],
  ['Favorite MCD Stage', 'WITH MNET PLUS'],
  ["Fans' Choice of the Year", 'GRAND PRIZE · DAESANG · WITH VISA', 'grand'],
];
// Finishes the user can choose: the moving foil in 3D and a still version for the PNG.
const FINISHES = {   // 3D only: the downloaded PNG stays clean
  none: {mode: 3, strength: .25},
  holo: {mode: 0, strength: .5},
  galaxy: {mode: 4, strength: 1.0},
  stardust: {mode: 5, strength: 1.6},
  aurora: {mode: 6, strength: .55},
  prism: {mode: 1, strength: .6},
  gold: {mode: 2, strength: .55},
};
const hexA = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
// The admin certificate has its own finish, so it never looks like a team card.
const ADMIN_LOOKS = {
  graphite: {accent: '#9a9ca6', base: ['#1c1e24', '#0d0e11']},
  carbon: {accent: '#d9dce3', base: ['#16171b', '#050506'], weave: true},
  champagne: {accent: '#cdb98f', base: ['#1f1c17', '#0c0b09']},
};
let ADMIN_LOOK = 'carbon';
const adminLook = () => ADMIN_LOOKS[window.__adminLook] || ADMIN_LOOKS[ADMIN_LOOK];
function carbonWeave(ctx) {
  // Carbon fibre twill: 2x2 woven tows, each with a soft sheen.
  const t = document.createElement('canvas'); t.width = t.height = 24; const g = t.getContext('2d');
  for (const [x, y, horiz] of [[0, 0, true], [12, 0, false], [0, 12, false], [12, 12, true]]) {
    const gr = horiz ? g.createLinearGradient(0, y, 0, y + 12) : g.createLinearGradient(x, 0, x + 12, 0);
    gr.addColorStop(0, 'rgba(255,255,255,.015)'); gr.addColorStop(.5, 'rgba(255,255,255,.075)'); gr.addColorStop(1, 'rgba(0,0,0,.25)');
    g.fillStyle = gr; g.fillRect(x, y, 12, 12);
  }
  ctx.save(); ctx.rotate(Math.PI / 4); ctx.fillStyle = ctx.createPattern(t, 'repeat'); ctx.fillRect(-PH, -PH, PH * 3, PH * 3); ctx.restore();
}
function passBase(ctx, c, v) {
  roundRect(ctx, 0, 0, PW, PH, PRADIUS); ctx.clip();
  const look = v?.staff ? (v.tier === 'staff' ? ADMIN_LOOKS.graphite : adminLook()) : null, [b0, b1] = look ? look.base : ['#1c1e24', '#0d0e11'];
  let g = ctx.createLinearGradient(0, 0, PW * .6, PH);
  g.addColorStop(0, b0); g.addColorStop(.6, b1); g.addColorStop(1, b1);
  ctx.fillStyle = g; ctx.fillRect(0, 0, PW, PH);
  if (look?.weave) carbonWeave(ctx);
  for (const [x, y, r, a] of [[PW * .9, 0, 900, .6], [0, PH, 700, .32]]) {
    g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, hexA(c, a)); g.addColorStop(1, hexA(c, 0));
    ctx.fillStyle = g; ctx.fillRect(0, 0, PW, PH);
  }
  certificateTexture(ctx, c);
  // Slot for the lanyard.
  roundRect(ctx, PW / 2 - 75, 26, 150, 22, 11); ctx.fillStyle = '#000'; ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.14)'; ctx.lineWidth = 2; ctx.stroke();
}
// Security-print texture: paper grain, a guilloche frame with microtext, like a real certificate.
let grain = null;
function grainPattern(ctx) {
  if (!grain) {
    const g = document.createElement('canvas'); g.width = g.height = 256;
    const gx = g.getContext('2d'), img = gx.createImageData(256, 256);
    let seed = 7;
    for (let i = 0; i < img.data.length; i += 4) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const v = seed >>> 24; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
    }
    gx.putImageData(img, 0, 0); grain = g;
  }
  return ctx.createPattern(grain, 'repeat');
}
function guillocheBand(ctx, x, y, w, h, color, waves, phase) {
  // Interlaced sine ribbons along a straight band.
  ctx.strokeStyle = color; ctx.lineWidth = .9;
  const horizontal = w > h, len = horizontal ? w : h, depth = horizontal ? h : w;
  for (let k = 0; k < 6; k++) {
    ctx.beginPath();
    for (let t = 0; t <= len; t += 2) {
      const off = depth / 2 + Math.sin(t / len * Math.PI * 2 * waves + k * Math.PI / 3 + phase) * depth * .42;
      const px = horizontal ? x + t : x + off, py = horizontal ? y + off : y + t;
      t ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.stroke();
  }
}
function certificateTexture(ctx, c) {
  // A faint starry sky, the theme of the 2026 MAMA Awards.
  let seed = 2026;
  const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < 260; i++) {
    const x = rnd() * PW, y = rnd() * PH, r = rnd() < .92 ? .5 + rnd() * .8 : 1.3 + rnd() * 1.1, a = .12 + rnd() * .4;
    ctx.fillStyle = `rgba(255,255,255,${a})`; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    if (r > 1.8) { ctx.strokeStyle = `rgba(255,255,255,${a * .5})`; ctx.lineWidth = .6; ctx.beginPath(); ctx.moveTo(x - r * 3, y); ctx.lineTo(x + r * 3, y); ctx.moveTo(x, y - r * 3); ctx.lineTo(x, y + r * 3); ctx.stroke(); }
  }
  // Paper grain.
  ctx.save(); ctx.globalAlpha = .05; ctx.globalCompositeOperation = 'overlay';
  ctx.fillStyle = grainPattern(ctx); ctx.scale(.5, .5); ctx.fillRect(0, 0, PW * 2, PH * 2); ctx.restore();
}
function seal(ctx, x, y, r, c) {
  // Embossed rosette seal.
  ctx.save(); ctx.translate(x, y);
  const g = ctx.createRadialGradient(-r * .3, -r * .3, 0, 0, 0, r);
  g.addColorStop(0, hexA(c, .55)); g.addColorStop(1, hexA(c, .18));
  ctx.beginPath();
  for (let i = 0; i <= 64; i++) { const a = i / 64 * Math.PI * 2, rr = r * (i % 2 ? .93 : 1); ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); }
  ctx.fillStyle = g; ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = .8;
  for (let k = 0; k < 18; k++) { ctx.beginPath(); for (let i = 0; i <= 120; i++) { const a = i / 120 * Math.PI * 2, rr = r * .72 + Math.sin(a * 9 + k * .35) * r * .12; ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); } ctx.stroke(); }
  ctx.beginPath(); ctx.arc(0, 0, r * .5, 0, Math.PI * 2); ctx.fillStyle = 'rgba(10,10,14,.75)'; ctx.fill();
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = font(r * .36, 900); ctx.fillText('E1', 0, -r * .05);
  ctx.font = font(r * .13, 700); ctx.fillText('2026', 0, r * .27);
  ctx.restore();
}
function passEdge(ctx, c) {
  roundRect(ctx, 1.5, 1.5, PW - 3, PH - 3, PRADIUS); ctx.strokeStyle = hexA(c, .55); ctx.lineWidth = 3; ctx.stroke();
}
function wrapText(ctx, parts, x, y, maxWidth, lineHeight) {
  // parts: [{text, color, weight}], wrapped word by word.
  const words = [];
  for (const part of parts) for (const w of part.text.split(/(\s+)/)) if (w) words.push({...part, text: w});
  let cx = x;
  for (const w of words) {
    ctx.font = font(30, w.weight);
    const width = ctx.measureText(w.text).width;
    if (/^\s+$/.test(w.text)) { if (cx > x) cx += width; continue; }
    if (cx + width > x + maxWidth && cx > x) { cx = x; y += lineHeight; }
    ctx.fillStyle = w.color; ctx.fillText(w.text, cx, y); cx += width;
  }
  return y;
}
function drawPassFront(ctx, v, withLicence = true) {
  const c = v.staff ? (v.tier === 'staff' ? ADMIN_LOOKS.graphite : adminLook()).accent : v.team?.color || '#9a9ca6';
  ctx.save(); passBase(ctx, c, v);
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = c; ctx.fillRect(56, 98, 44, 6);
  ctx.fillStyle = '#d4d5db'; ctx.font = font(22, 700); spaced(ctx, 'ENHYPEN MAMA GRAND PRIX', 116, 108, 4);
  if (logo.complete && logo.naturalWidth) { const h = 62, w = h * logo.naturalWidth / logo.naturalHeight; ctx.drawImage(logo, PW - 64 - w, 150, w, h); }
  ctx.fillStyle = '#9a9ca6'; ctx.font = font(30, 600); spaced(ctx, 'CERTIFICATE OF', 56, 176, 6);
  ctx.fillStyle = '#fff'; ctx.font = font(62, 700); ctx.fillText('PARTICIPATION', 54, 236);
  // Clear sleeve with the crew licence.
  const sx = 48, sy = 278, sw = PW - 96, inner = sw - 36, ih = inner * CH / CW, sh = ih + 36;
  roundRect(ctx, sx, sy, sw, sh, 30);
  const sg = ctx.createLinearGradient(sx, sy, sx + sw, sy + sh); sg.addColorStop(0, 'rgba(255,255,255,.12)'); sg.addColorStop(.4, 'rgba(255,255,255,.03)'); sg.addColorStop(1, 'rgba(255,255,255,.08)');
  ctx.fillStyle = sg; ctx.fill(); ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.lineWidth = 2; ctx.stroke();
  if (!withLicence) {
    // 3D view: the licence is a separate raised plate; leave a recess for it.
    roundRect(ctx, sx + 18, sy + 18, inner, ih, 22); ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fill();
  } else {
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 36; ctx.shadowOffsetY = 16;
  ctx.drawImage(licence, sx + 18, sy + 18, inner, ih); ctx.restore();
  ctx.save(); roundRect(ctx, sx + 18, sy + 18, inner, ih, 22); ctx.clip();
  const gl = ctx.createLinearGradient(sx, sy, sx + sw, sy + sh); gl.addColorStop(.3, 'rgba(255,255,255,0)'); gl.addColorStop(.42, 'rgba(255,255,255,.16)'); gl.addColorStop(.52, 'rgba(255,255,255,0)');
  ctx.fillStyle = gl; ctx.fillRect(sx, sy, sw, sh); ctx.restore();
  }
  // Statement.
  const name = v.username || 'your username';
  let y = v.staff ? wrapText(ctx, [
    {text: 'This certifies that ', color: '#c9cad0', weight: 400}, {text: name, color: '#fff', weight: 700},
    {text: ' ran the ENHYPEN MAMA Grand Prix 2026 as part of the ', color: '#c9cad0', weight: 400},
    {text: tierText(v).group, color: '#fff', weight: 700}, {text: '.', color: '#c9cad0', weight: 400},
  ], 56, sy + sh + 66, PW - 112, 44) : v.special ? wrapText(ctx, [
    {text: 'This certifies that ', color: '#c9cad0', weight: 400}, {text: name, color: '#fff', weight: 700},
    {text: ' supported the ENHYPEN MAMA Grand Prix 2026 as ', color: '#c9cad0', weight: 400},
    {text: v.special === 'creator' ? 'a Social Media Creator' : 'a campaign supporter', color: '#fff', weight: 700},
    {text: v.special === 'creator' ? ' for ' : ' of ', color: '#c9cad0', weight: 400}, {text: teamLabel(v.team, ' · '), color: c, weight: 700},
    {text: '.', color: '#c9cad0', weight: 400},
  ], 56, sy + sh + 66, PW - 112, 44) : wrapText(ctx, [
    {text: 'This certifies that ', color: '#c9cad0', weight: 400}, {text: name, color: '#fff', weight: 700},
    {text: ' raced with ', color: '#c9cad0', weight: 400}, {text: v.team ? teamLabel(v.team, ' · ') : 'your team', color: c, weight: 700},
    {text: ' in the ENHYPEN MAMA Grand Prix 2026, reaching the ', color: '#c9cad0', weight: 400},
    {text: v.level ? v.level.name : 'your', color: '#fff', weight: 700}, {text: ' crew licence.', color: '#c9cad0', weight: 400},
  ], 56, sy + sh + 66, PW - 112, 44);
  if (v.role) {
    // Coordinators: the role in chrome lettering (real metal letters in 3D).
    roleSlot = {x: 56, y: y + 30};
    drawRoleBlock(ctx, v, roleSlot.y, withLicence);
  } else {
    roleSlot = null;
    // Access zones.
    let zx = 56; y += 40;
    for (const z of ['PIT', 'GRID', 'PADDOCK', 'GARAGE']) {
      ctx.font = `italic ${font(24, 900)}`; const w = ctx.measureText(z).width + 40;
      roundRect(ctx, zx, y, w, 46, 10); ctx.fillStyle = hexA(c, .14); ctx.fill(); ctx.strokeStyle = hexA(c, .7); ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = c; ctx.fillText(z, zx + 20, y + 32); zx += w + 12;
    }
  }
  // Donors: a holographic supporter sticker on the corner (its own holo sticker in 3D).
  if (v.donor && withLicence) drawSticker(ctx, STICKER.x, STICKER.y, STICKER.r, 'print');
  // Certificate number, date, barcode.
  const no = licenceNumber(v);
  ctx.fillStyle = '#8d8f99'; ctx.font = font(20, 700);
  spaced(ctx, 'CERTIFICATE NO.', 56, PH - 120, 3);
  ctx.fillStyle = '#fff'; spaced(ctx, no, 56, PH - 86, 4);
  ctx.fillStyle = '#8d8f99'; spaced(ctx, `ISSUED ${issued} · KST`, 56, PH - 52, 3);
  // QR code to e1.ensite.org, where the crew uploaded their votes and earned their licences.
  if (qr.complete && qr.naturalWidth) {
    const q = 104, qx = PW - 56 - q, qy = PH - 52 - q;
    ctx.drawImage(qr, qx, qy, q, q);
    ctx.textAlign = 'right'; ctx.fillStyle = '#8d8f99'; ctx.font = font(18, 700);
    ctx.fillText('SCAN TO REVISIT THE RACE', qx - 18, PH - 54);
    ctx.fillStyle = '#d4d5db'; ctx.font = font(20, 600); ctx.fillText('Every vote counted.', qx - 18, PH - 112); ctx.fillText('Every licence earned.', qx - 18, PH - 86);
    ctx.textAlign = 'left';
  }
  ctx.restore(); passEdge(ctx, c);
}
let roleSlot = null;
function sparkle(ctx, x, y, r, a = 1) {
  // A four-point star glint.
  ctx.save(); ctx.translate(x, y); ctx.globalAlpha = a;
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r * .45); g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, r * .45, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.beginPath();
  for (let i = 0; i < 8; i++) { const a2 = i * Math.PI / 4, rr = i % 2 ? r * .1 : r; ctx.lineTo(Math.cos(a2) * rr, Math.sin(a2) * rr); }
  ctx.fill(); ctx.restore();
}
function chromeFill(ctx, y0, y1) {
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  [[0, '#ffffff'], [.4, '#dfe2e8'], [.52, '#8a8f99'], [.6, '#cfd3da'], [.82, '#f7f8fa'], [1, '#a5aab3']].forEach(([o, col]) => g.addColorStop(o, col));
  return g;
}
const spacedWidth = (ctx, t, sp) => [...t].reduce((a, ch) => a + ctx.measureText(ch).width + sp, -sp);
// The role title in chrome: top of the 60 px band at y (logical pixels). Returns its width.
const ROLE_SIZE = 38, ROLE_SP = 5;
function drawRoleTitle(ctx, x, y, v) {
  const title = roleList(v)[0].toUpperCase();
  let size = ROLE_SIZE; ctx.font = font(size, 700);
  while (spacedWidth(ctx, title, ROLE_SP) > PW - 112 && size > 24) { size -= 2; ctx.font = font(size, 700); }
  ctx.save(); ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(0,0,0,.55)'; spaced(ctx, title, x, y + 47, ROLE_SP);          // soft drop
  ctx.fillStyle = chromeFill(ctx, y + 47 - size * .74, y + 47); spaced(ctx, title, x, y + 45, ROLE_SP);
  const w = spacedWidth(ctx, title, ROLE_SP), more = roleList(v).slice(1);
  if (more.length) {
    // Second role: also in chrome, a step smaller, on its own line ("& SOCIAL MEDIA CREATOR").
    const second = `& ${more.join(' & ')}`.toUpperCase();
    let s2 = 30; ctx.font = font(s2, 700);
    while (spacedWidth(ctx, second, 4) > PW - 112 && s2 > 20) { s2 -= 2; ctx.font = font(s2, 700); }
    ctx.fillStyle = 'rgba(0,0,0,.55)'; spaced(ctx, second, x, y + 92, 4);
    ctx.fillStyle = chromeFill(ctx, y + 92 - s2 * .74, y + 92); spaced(ctx, second, x, y + 90, 4);
  }
  ctx.restore();
  return w;
}
function drawRoleBlock(ctx, v, y, withTitle) {
  // CREW ROLE ——— (hairline) / TITLE / description: quiet, engraved-certificate style.
  const roles = roleList(v), c = v.team?.color || '#9a9ca6';
  // Two roles: both in chrome (the second a step smaller), then the description of the main one.
  const desc = (ROLES[roles[0]] ?? '').toUpperCase();
  const label = roles.length > 1 ? 'CREW ROLES' : 'CREW ROLE';
  ctx.save(); ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  ctx.fillStyle = c; ctx.font = font(14, 700); spaced(ctx, label, 56, y + 12, 4);
  const end = v.donor ? STICKER.x - STICKER.r - 40 : PW - 56;   // keep clear of the supporter sticker
  const lx = 56 + spacedWidth(ctx, label, 4) + 16, line = ctx.createLinearGradient(lx, 0, end, 0);
  line.addColorStop(0, 'rgba(230,233,238,.55)'); line.addColorStop(1, 'rgba(230,233,238,0)');
  ctx.fillStyle = line; ctx.fillRect(lx, y + 7, end - lx, 1.2);
  if (desc) { ctx.fillStyle = '#a9adb6'; ctx.font = font(14, 600); spaced(ctx, desc, 56, y + (roles.length > 1 ? 136 : 92), 3); }
  ctx.restore();
  if (withTitle) {
    const w = drawRoleTitle(ctx, 54, y + 18, v);
    ctx.save(); sparkle(ctx, 54 + w - 6, y + 32, 15, .95); ctx.restore();
  }
}
// Supporter sticker (donors): holographic foil above the QR code, with an embossed laurel wreath and star.
const STICKER = {x: PW - 56 - 52, y: PH - 52 - 104 - 26 - 46, r: 46};
function wreath(ctx, r) {
  // Laurel: two branches of leaves around a five-point star.
  for (const side of [-1, 1]) {
    ctx.save(); ctx.scale(side, 1);
    ctx.beginPath(); ctx.arc(0, 0, r * .4, Math.PI * .6, Math.PI * 1.32); ctx.lineWidth = r * .028; ctx.stroke();
    for (let i = 0; i < 6; i++) {
      const a = Math.PI * .64 + i * Math.PI * .125, px = Math.cos(a) * r * .4, py = Math.sin(a) * r * .4;
      ctx.save(); ctx.translate(px, py); ctx.rotate(a + Math.PI * .5 + .5);
      ctx.beginPath(); ctx.ellipse(0, -r * .07, r * .04, r * .085, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    }
    ctx.restore();
  }
  ctx.beginPath();
  for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * .11 : r * .25; ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); }
  ctx.closePath(); ctx.fill();
}
function stickerMarks(ctx, r, color) {
  // Rings, ring text and the wreath, in one colour (used for the ink, the emboss and the 3D bump).
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.1;
  for (const rr of [r * .86, r * .57]) { ctx.beginPath(); ctx.arc(0, 0, rr, 0, Math.PI * 2); ctx.stroke(); }
  ctx.font = font(r * .19, 700); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const ring = 'CAMPAIGN SUPPORTER ★ EMGP 2026 ★ ', step = Math.PI * 2 / ring.length;
  [...ring].forEach((ch, i) => { ctx.save(); ctx.rotate(-Math.PI / 2 + i * step); ctx.translate(0, -r * .715); ctx.fillText(ch, 0, 0); ctx.restore(); });
  wreath(ctx, r);
}
function drawSticker(ctx, x, y, r, mode) {
  // mode: 'print' (flat PNG, with a shadow), 'texture' (3D colour map), 'height' (3D bump: marks raised).
  ctx.save(); ctx.translate(x, y); ctx.rotate(-.12);
  const edge = () => { ctx.beginPath(); for (let i = 0; i <= 96; i++) { const a = i / 96 * Math.PI * 2, rr = r * (1 - .03 * (1 + Math.cos(a * 24))); ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); } ctx.closePath(); };
  if (mode === 'height') {
    edge(); ctx.fillStyle = '#7a7a7a'; ctx.fill(); stickerMarks(ctx, r, '#fff'); ctx.restore(); return;
  }
  if (mode === 'print') { ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 12; ctx.shadowOffsetY = 4; edge(); ctx.fillStyle = '#ddd'; ctx.fill(); ctx.restore(); }
  edge(); ctx.save(); ctx.clip();
  // Holographic foil: a conic rainbow with glitter; the 3D sticker moves it with the light.
  const g = ctx.createConicGradient(.6, 0, 0);
  ['#e9dcff', '#cfe6ff', '#d9fbea', '#fbf1d2', '#f6dbe9', '#dcd8ff', '#cdeff8', '#e9dcff'].forEach((col, i, a) => g.addColorStop(i / (a.length - 1), col));
  ctx.fillStyle = g; ctx.fillRect(-r, -r, r * 2, r * 2);
  const sheen = ctx.createLinearGradient(-r, -r, r, r); sheen.addColorStop(.3, 'rgba(255,255,255,0)'); sheen.addColorStop(.5, 'rgba(255,255,255,.6)'); sheen.addColorStop(.7, 'rgba(255,255,255,0)');
  ctx.fillStyle = sheen; ctx.fillRect(-r, -r, r * 2, r * 2);
  let seed = 11; const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < 200; i++) { ctx.fillStyle = `rgba(255,255,255,${.3 + rnd() * .7})`; ctx.fillRect(-r + rnd() * r * 2, -r + rnd() * r * 2, 1.1, 1.1); }
  ctx.restore();
  // Embossed marks: shadow below-right, highlight above-left, a soft face on top.
  ctx.save(); ctx.translate(.9, 1.1); stickerMarks(ctx, r, 'rgba(60,52,92,.55)'); ctx.restore();
  ctx.save(); ctx.translate(-.7, -.8); stickerMarks(ctx, r, 'rgba(255,255,255,.95)'); ctx.restore();
  stickerMarks(ctx, r, 'rgba(150,140,185,.55)');
  ctx.restore();
}
// Donor certificate: a separate card, licence-sized (1600 x 900), for crew members who donated to the campaign.
const DONOR_THANKS = 'Thank you for fuelling our race. Your support kept the crew running, vote after vote, and helped carry ENHYPEN all the way to the Daesang.';
// Team logos (round badges), shown on the donor certificate.
const teamLogos = Object.fromEntries(['jaybull', 'mcjakey', 'hoonrari', 'alpinoo', 'meowcedes', 'rikston'].map(k => {
  const img = new Image(); img.onload = () => { if (picked?.donor) paint(); }; img.src = `/teams/${k}.png`; return [k, img];
}));
const teamKey = team => Object.keys(TEAMS).find(k => TEAMS[k].name === team?.name);
function shade(hex, f) {   // darker team colour for text on paper (yellow and pink are unreadable as they are)
  const n = parseInt(hex.slice(1), 16), m = c => Math.round(c * f);
  return `rgb(${m(n >> 16)},${m((n >> 8) & 255)},${m(n & 255)})`;
}
function filigree(ctx, W, H, color) {
  // Security-paper guilloche: fine waves across the sheet and a rosette behind the name.
  ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = .7;
  for (let k = 0; k < 26; k++) {
    ctx.beginPath();
    for (let x = 0; x <= W; x += 6) { const y = 40 + k * (H - 80) / 25 + Math.sin(x / 70 + k * .6) * 9 + Math.sin(x / 23 + k) * 2.5; x ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.stroke();
  }
  ctx.translate(W / 2, H / 2 + 10);
  for (let k = 0; k < 36; k++) {
    ctx.beginPath();
    for (let i = 0; i <= 720; i++) { const a = i / 720 * Math.PI * 2, r = 250 + Math.sin(a * 12 + k * Math.PI / 18) * 34 + Math.sin(a * 5 - k * .3) * 10; ctx.lineTo(Math.cos(a) * r * 1.5, Math.sin(a) * r); }
    ctx.stroke();
  }
  ctx.restore();
}
function inkLogo(ctx, img, x, y, h, color) {
  // The white E1 logo, recoloured for paper.
  if (!img.complete || !img.naturalWidth) return;
  const w = h * img.naturalWidth / img.naturalHeight, c = document.createElement('canvas'); c.width = w * 3; c.height = h * 3;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0, c.width, c.height); g.globalCompositeOperation = 'source-in'; g.fillStyle = color; g.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(c, x - w / 2, y, w, h);
}
function drawDonorCard(ctx, v) {
  const c = v.team?.color || '#6b6e78', ink = shade(c, v.team && ['#ffd23f', '#ff7eb6', '#2ee6c5'].includes(c) ? .62 : .82), W = CW, H = CH, mid = W / 2;
  ctx.save();
  roundRect(ctx, 0, 0, W, H, RADIUS); ctx.clip();
  // Paper: warm white to light grey, with a filigree.
  const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#fbfaf7'); g.addColorStop(1, '#e9e9ec');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  filigree(ctx, W, H, 'rgba(40,44,56,.055)');
  ctx.save(); ctx.globalAlpha = .035; ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = grainPattern(ctx); ctx.fillRect(0, 0, W, H); ctx.restore();
  // Frame: team colour, then a hairline.
  roundRect(ctx, 30, 30, W - 60, H - 60, RADIUS - 22); ctx.lineWidth = 3; ctx.strokeStyle = c; ctx.stroke();
  roundRect(ctx, 42, 42, W - 84, H - 84, RADIUS - 32); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(30,32,40,.25)'; ctx.stroke();
  // Text, centred.
  const centre = (text, y, sp) => { const w = spacedWidth(ctx, text, sp); spaced(ctx, text, mid - w / 2, y, sp); };
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  inkLogo(ctx, logo, mid, 82, 48, '#16181d');
  ctx.fillStyle = '#6b6e78'; ctx.font = font(20, 700); centre('ENHYPEN MAMA GRAND PRIX 2026', 180, 6);
  ctx.fillStyle = '#16181d'; ctx.font = font(72, 700); centre('DONOR CERTIFICATE', 262, 7);
  ctx.fillStyle = c; ctx.fillRect(mid - 40, 290, 80, 4);
  ctx.fillStyle = '#6b6e78'; ctx.font = font(19, 700); centre('PRESENTED TO', 356, 5);
  const name = v.username || 'your username';
  fit(ctx, name, 1000, 66, 700); ctx.fillStyle = '#16181d'; ctx.textAlign = 'center'; ctx.fillText(name, mid, 436);
  ctx.fillStyle = ink; ctx.font = font(28, 700); ctx.fillText(v.team ? teamLabel(v.team, ' · ') : 'your team', mid, 482);
  ctx.fillStyle = '#4a4d56'; ctx.font = font(26, 400);
  const lines = []; let line = '';
  for (const word of DONOR_THANKS.split(' ')) { const test = line ? `${line} ${word}` : word; if (ctx.measureText(test).width > 980 && line) { lines.push(line); line = word; } else line = test; }
  lines.push(line); lines.forEach((l, i) => ctx.fillText(l, mid, 556 + i * 40));
  ctx.fillStyle = '#7d808a'; ctx.font = font(16, 700); ctx.textAlign = 'left';
  centre(`NO. ${licenceNumber(v)}-S · ISSUED ${issued} · KST`, H - 92, 3);
  ctx.restore();
  // Team badge (bottom left) and the supporter seal (bottom right), small, like stamps.
  const by = H - 150, bs = 64;
  const img = teamLogos[teamKey(v.team)];
  if (img?.complete && img.naturalWidth) {
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.25)'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 3;
    ctx.drawImage(img, 170 - bs, by - bs, bs * 2, bs * 2); ctx.restore();
  } else if (v.team) {   // Independent Crew: the E1 mark in a team-colour disc
    ctx.save(); ctx.beginPath(); ctx.arc(170, by, bs, 0, Math.PI * 2); ctx.fillStyle = c; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.stroke(); ctx.restore();
    if (logo.complete && logo.naturalWidth) { const h = 34, w = h * logo.naturalWidth / logo.naturalHeight; ctx.drawImage(logo, 170 - w / 2, by - h / 2, w, h); }
  }
  drawSticker(ctx, W - 170, by, bs, 'print');
}
function trophy(ctx, x, y, s, color) {
  ctx.save(); ctx.translate(x - s / 2, y - s / 2); ctx.scale(s / 48, s / 48); ctx.fillStyle = color;
  ctx.fill(new Path2D('M14 6h20v4h7v4c0 6-4 10-9.4 10.8A10 10 0 0 1 26 30.6V36h6v4H16v-4h6v-5.4a10 10 0 0 1-5.6-5.8C11 24 7 20 7 14v-4h7zm0 8h-3c0 3.4 1.6 5.8 4 6.6A13 13 0 0 1 14 18zm20 0v4c0 .9-.1 1.8-.3 2.6 2.4-.8 4-3.2 4-6.6z'));
  ctx.fillRect(13, 40, 22, 3); ctx.restore();
}
function drawPassBack(ctx, v) {
  const c = v.staff ? (v.tier === 'staff' ? ADMIN_LOOKS.graphite : adminLook()).accent : v.team?.color || '#9a9ca6';
  ctx.save(); passBase(ctx, c, v);
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  if (logo.complete && logo.naturalWidth) { const h = 110, w = h * logo.naturalWidth / logo.naturalHeight; ctx.drawImage(logo, (PW - w) / 2, 106, w, h); }
  ctx.fillStyle = '#fff'; ctx.font = font(74, 700); ctx.fillText('ENHYPEN', PW / 2, 312); ctx.fillText('MAMA GRAND PRIX', PW / 2, 384);
  ctx.fillStyle = '#9a9ca6'; ctx.font = font(26, 700); ctx.textAlign = 'left';
  const season = 'SEASON 2026 · FAN-MADE'; let w = [...season].reduce((a, ch) => a + ctx.measureText(ch).width + 8, -8); spaced(ctx, season, (PW - w) / 2, 440, 8);
  ctx.fillStyle = c; ctx.fillRect(PW / 2 - 30, 492, 60, 6);
  ctx.fillStyle = '#d4d5db'; ctx.font = font(24, 700); w = [...'2026 MAMA AWARDS'].reduce((a, ch) => a + ctx.measureText(ch).width + 6, -6); spaced(ctx, '2026 MAMA AWARDS', (PW - w) / 2, 556, 6);
  ctx.fillStyle = '#8d8f99'; ctx.font = font(20, 700); w = [...'KYOCERA DOME OSAKA'].reduce((a, ch) => a + ctx.measureText(ch).width + 4, -4); spaced(ctx, 'KYOCERA DOME OSAKA', (PW - w) / 2, 590, 4);
  // Awards as an engraved plaque: hairline dividers, the Daesang last in gold foil.
  ctx.textAlign = 'center';
  const gold = ctx.createLinearGradient(PW / 2 - 260, 0, PW / 2 + 260, 0);
  gold.addColorStop(0, '#b8862b'); gold.addColorStop(.35, '#ffe9a8'); gold.addColorStop(.6, '#e3b44a'); gold.addColorStop(1, '#a8771f');
  const rows = [[650, 0], [770, 1], [910, 2]];
  rows.forEach(([y, i]) => {
    const [title, sub, grand] = AWARDS[i];
    if (i) { // divider: line · diamond · line
      ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(PW / 2 - 150, y - 58); ctx.lineTo(PW / 2 - 14, y - 58); ctx.moveTo(PW / 2 + 14, y - 58); ctx.lineTo(PW / 2 + 150, y - 58); ctx.stroke();
      ctx.save(); ctx.translate(PW / 2, y - 58); ctx.rotate(Math.PI / 4); ctx.fillStyle = grand ? '#e3b44a' : c; ctx.fillRect(-5, -5, 10, 10); ctx.restore();
    }
    ctx.fillStyle = grand ? '#e3b44a' : c; ctx.font = font(18, 700);
    const sw = [...sub].reduce((a, ch) => a + ctx.measureText(ch).width + 4, -4);
    ctx.textAlign = 'left'; spaced(ctx, sub, (PW - sw) / 2, y, 4); ctx.textAlign = 'center';
    ctx.fillStyle = grand ? gold : '#fff'; ctx.font = font(grand ? 52 : 38, 700);
    ctx.fillText(grand ? title.toUpperCase() : title, PW / 2, y + (grand ? 58 : 46));
  });
  ctx.textAlign = 'center';
  ctx.fillStyle = '#d4d5db'; ctx.font = font(34, 400); ctx.fillText('Different Colors.', PW / 2, 1080);
  ctx.fillStyle = '#fff'; ctx.font = font(34, 700); ctx.fillText('Same finish line.', PW / 2, 1126);
  ctx.textAlign = 'left';
  ctx.restore(); passEdge(ctx, c);
}
const issued = new Intl.DateTimeFormat('en-GB', {timeZone: 'Asia/Seoul', day: '2-digit', month: 'short', year: 'numeric'}).format(new Date()).toUpperCase();
function licenceNumber(v) {
  let h = 2166136261;
  for (const ch of `${(v.key || '').toLowerCase()}|${v.team?.name || ''}`) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return `E1-26-${String(h % 10000).padStart(4, '0')}${'ABCDEFGHJKLMNPRSTUVWXYZ'[(h >>> 14) % 23]}`;
}

const licence = document.createElement('canvas'); licence.width = CW * SCALE; licence.height = CH * SCALE;
const donorCard = document.createElement('canvas'); donorCard.width = CW * SCALE; donorCard.height = CH * SCALE;
const staffRelief = document.createElement('canvas'); staffRelief.width = CW / 2; staffRelief.height = CH / 2;
const licHeight = document.createElement('canvas'); licHeight.width = CW / 2; licHeight.height = CH / 2;
const front = document.createElement('canvas'); front.width = PW * PSCALE; front.height = PH * PSCALE;
const back = document.createElement('canvas'); back.width = PW * PSCALE; back.height = PH * PSCALE;
const frontBase = document.createElement('canvas'); frontBase.width = front.width; frontBase.height = front.height;
// The role plate of the coordinators, drawn on its own for the 3D metal plate.
const ROLE_W = PW - 112, ROLE_H = 104;   // room for a second role
const STICK = 2 * STICKER.r + 8;
const stickerCanvas = document.createElement('canvas'); stickerCanvas.width = stickerCanvas.height = STICK * PSCALE;
const stickerRelief = document.createElement('canvas'); stickerRelief.width = stickerRelief.height = STICK * PSCALE;
const stickerHeight = document.createElement('canvas'); stickerHeight.width = stickerHeight.height = STICK * PSCALE;
const roleCanvas = document.createElement('canvas'); roleCanvas.width = ROLE_W * PSCALE; roleCanvas.height = ROLE_H * PSCALE;
// Where the licence sits on the pass (logical pass pixels), shared by the 2D drawing and the 3D plate.
const SLOT = (() => { const sx = 48, sy = 278, inner = PW - 96 - 36; return {x: sx + 18, y: sy + 18, w: inner, h: inner * CH / CW}; })();
// Emboss: bright print (text, logo, zones, barcode) becomes a bump map, so it stands out in 3D.
const HS = .5;
const frontHeight = document.createElement('canvas'); frontHeight.width = PW * PSCALE * HS; frontHeight.height = PH * PSCALE * HS;
const backHeight = document.createElement('canvas'); backHeight.width = frontHeight.width; backHeight.height = frontHeight.height;
const roleHeight = document.createElement('canvas'); roleHeight.width = roleCanvas.width; roleHeight.height = roleCanvas.height;
function heightFrom(src, dst) {
  const ctx = dst.getContext('2d', {willReadFrequently: true});
  ctx.clearRect(0, 0, dst.width, dst.height); ctx.drawImage(src, 0, 0, dst.width, dst.height);
  const img = ctx.getImageData(0, 0, dst.width, dst.height), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const l = (.2126 * d[i] + .7152 * d[i + 1] + .0722 * d[i + 2]) / 255;
    const h = Math.max(0, Math.min(1, (l - .5) / .3)) * 255;
    d[i] = d[i + 1] = d[i + 2] = h; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  ctx.filter = 'blur(1.2px)'; ctx.drawImage(dst, 0, 0); ctx.filter = 'none';
  // Height -> normal map (Sobel).
  const h = ctx.getImageData(0, 0, dst.width, dst.height).data, w = dst.width, hh = dst.height;
  const out = ctx.createImageData(w, hh), o = out.data, k = 3.2;
  const at = (x, y) => h[((Math.min(hh - 1, Math.max(0, y)) * w) + Math.min(w - 1, Math.max(0, x))) * 4] / 255;
  for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
    const dx = (at(x + 1, y) - at(x - 1, y)) * k, dy = (at(x, y + 1) - at(x, y - 1)) * k;
    const len = Math.hypot(dx, dy, 1), i = (y * w + x) * 4;
    o[i] = (-dx / len * .5 + .5) * 255; o[i + 1] = (dy / len * .5 + .5) * 255; o[i + 2] = (1 / len * .5 + .5) * 255; o[i + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
}
let paintId = 0;
async function paint() {
  const v = values(), id = ++paintId;
  const art = v.level ? await design(v.level) : v.special ? await baseArt() : null;
  if (id !== paintId) return;   // a newer change is already being drawn
  const lctx = licence.getContext('2d');
  lctx.setTransform(SCALE, 0, 0, SCALE, 0, 0); lctx.clearRect(0, 0, CW, CH); drawLicence(lctx, v, art);
  $('lic-donor').hidden = !v.donor;
  // Staff: no crew licence to download, and their card is always in the default colour.
  $('lic-licence').hidden = v.staff; $('lic-color').hidden = v.staff;
  if (v.donor) { const dctx = donorCard.getContext('2d'); dctx.setTransform(SCALE, 0, 0, SCALE, 0, 0); dctx.clearRect(0, 0, CW, CH); drawDonorCard(dctx, v); }
  for (const [canvas, draw, arg] of [[front, drawPassFront, true], [frontBase, drawPassFront, false], [back, drawPassBack]]) {
    const ctx = canvas.getContext('2d');
    ctx.setTransform(PSCALE, 0, 0, PSCALE, 0, 0); ctx.clearRect(0, 0, PW, PH);
    draw(ctx, v, arg);
  }
  if (v.role) {
    const rctx = roleCanvas.getContext('2d');
    rctx.setTransform(PSCALE, 0, 0, PSCALE, 0, 0); rctx.clearRect(0, 0, ROLE_W, ROLE_H);
    drawRoleTitle(rctx, 0, 0, v);
  }
  if (v.donor) {
    const sctx = stickerCanvas.getContext('2d');
    sctx.setTransform(PSCALE, 0, 0, PSCALE, 0, 0); sctx.clearRect(0, 0, STICK, STICK);
    drawSticker(sctx, STICK / 2, STICK / 2, STICKER.r, 'texture');
    const hctx = stickerRelief.getContext('2d');
    hctx.setTransform(PSCALE, 0, 0, PSCALE, 0, 0); hctx.fillStyle = '#000'; hctx.fillRect(0, 0, STICK, STICK);
    drawSticker(hctx, STICK / 2, STICK / 2, STICKER.r, 'height');
    if (view?.renderer) heightFrom(stickerRelief, stickerHeight);
  }
  if (view?.renderer) {
    heightFrom(frontBase, frontHeight); heightFrom(back, backHeight); if (v.role) heightFrom(roleCanvas, roleHeight);
    if (v.staff) { const rc = staffRelief.getContext('2d'); rc.setTransform(.5, 0, 0, .5, 0, 0); drawStaffRelief(rc, v); heightFrom(staffRelief, licHeight); }
  }
  view?.update(v);
}

// 3D view ---------------------------------------------------------------------------
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
let view = null;

function roundedShape(w, h, r) {
  const s = new THREE.Shape(), x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}
function faceGeometry(shape, w, h) {
  const g = new THREE.ShapeGeometry(shape, 12);
  const pos = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / w + .5, pos.getY(i) / h + .5);
  return g;
}

function createView() {
  const renderer = new THREE.WebGLRenderer({antialias: true, alpha: true, preserveDrawingBuffer: true});
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  stage.append(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, .1, 100);
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  // A small studio for reflections: softboxes the glossy laminate and the edges reflect.
  const studio = new THREE.Scene(); studio.background = new THREE.Color(0x07080a);
  const box = (w, h, x, y, z, color, intensity) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide}));
    m.position.set(x, y, z); m.lookAt(0, 0, 0); studio.add(m);
  };
  box(6, 1.2, 0, 5, 3, 0xffffff, 3); box(1.2, 5, -6, 0, 2, 0xffffff, 1.6); box(1.2, 5, 6, 1, 2, 0xffe8d0, 1.4); box(8, 1, 0, -5, 4, 0x9fb4ff, .6);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(studio, .04).texture;
  scene.add(new THREE.AmbientLight(0xffffff, .55));
  const key = new THREE.DirectionalLight(0xffffff, 1.1); key.position.set(2, 3, 6); scene.add(key);
  const glint = new THREE.PointLight(0xffffff, 5, 12, 1.5); glint.position.set(0, 0, 3); scene.add(glint);

  const W = 1.8, H = W * PH / PW, D = .026, B = .007, R = W * PRADIUS / PW;
  const shape = roundedShape(W, H, R);
  const card = new THREE.Group(); scene.add(card);
  // Thick laminated card with rounded (bevelled) edges that catch the light.
  const sideGeo = new THREE.ExtrudeGeometry(roundedShape(W - 2 * B, H - 2 * B, R - B), {depth: D, bevelEnabled: true, bevelThickness: B, bevelSize: B, bevelSegments: 4, curveSegments: 16});
  sideGeo.translate(0, 0, -D / 2);
  const edge = new THREE.MeshPhysicalMaterial({color: 0x2a2c33, metalness: .6, roughness: .25, clearcoat: 1, clearcoatRoughness: .1});
  card.add(new THREE.Mesh(sideGeo, [new THREE.MeshBasicMaterial({visible: false}), edge]));

  const tex = canvas => { const t = new THREE.CanvasTexture(canvas); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = renderer.capabilities.getMaxAnisotropy(); return t; };
  const frontTex = tex(frontBase), backTex = tex(back), licTex = tex(licence);
  const frontBump = new THREE.CanvasTexture(frontHeight), backBump = new THREE.CanvasTexture(backHeight);
  const face = faceGeometry(shape, W, H);
  // Printed faces under a glossy clear coat (reflects the studio when the card turns).
  const faceMat = (map, normalMap) => new THREE.MeshPhysicalMaterial({map, normalMap, normalScale: new THREE.Vector2(2.4, 2.4), clearcoatNormalMap: normalMap, clearcoatNormalScale: new THREE.Vector2(1.2, 1.2), roughness: .45, metalness: 0, clearcoat: 1, clearcoatRoughness: .06, envMapIntensity: .7});
  const faceZ = D / 2 + B + .0006;
  const frontMesh = new THREE.Mesh(face, faceMat(frontTex, frontBump)); frontMesh.position.z = faceZ; card.add(frontMesh);
  const backMesh = new THREE.Mesh(face, faceMat(backTex, backBump)); backMesh.rotation.y = Math.PI; backMesh.position.z = -faceZ; card.add(backMesh);
  // The crew licence: its own raised, glossy plate inside the sleeve.
  const lw = SLOT.w / PW * W, lh = SLOT.h / PH * H, lr = 22 / PW * W, ld = .0025, lb = .0018;
  const licShape = roundedShape(lw, lh, lr);
  const plate = new THREE.Group();
  plate.position.set((SLOT.x + SLOT.w / 2) / PW * W - W / 2, H / 2 - (SLOT.y + SLOT.h / 2) / PH * H, faceZ + lb);
  const plateSide = new THREE.ExtrudeGeometry(roundedShape(lw - 2 * lb, lh - 2 * lb, lr - lb), {depth: ld, bevelEnabled: true, bevelThickness: lb, bevelSize: lb, bevelSegments: 3, curveSegments: 12});
  plate.add(new THREE.Mesh(plateSide, new THREE.MeshPhysicalMaterial({color: 0x1a1b20, roughness: .3, clearcoat: 1, clearcoatRoughness: .08})));
  const licBump = new THREE.CanvasTexture(licHeight);
  const licMesh = new THREE.Mesh(faceGeometry(licShape, lw, lh), new THREE.MeshPhysicalMaterial({map: licTex, roughness: .55, clearcoat: .7, clearcoatRoughness: .05, envMapIntensity: .25, toneMapped: false}));
  licMesh.position.z = ld + lb + .0004; plate.add(licMesh);
  card.add(plate);
  // The role: chrome letters that mirror the studio, with a glint travelling across them.
  const rw = ROLE_W / PW * W, rh = ROLE_H / PH * H;
  const roleTex = tex(roleCanvas), roleBump = new THREE.CanvasTexture(roleHeight);
  const rolePlate = new THREE.Group(); rolePlate.visible = false;
  const roleGeo = new THREE.PlaneGeometry(rw, rh);
  rolePlate.add(new THREE.Mesh(roleGeo, new THREE.MeshPhysicalMaterial({
    map: roleTex, transparent: true, alphaTest: .05, normalMap: roleBump, normalScale: new THREE.Vector2(2, 2), metalness: 1, roughness: .14,
    iridescence: .35, iridescenceIOR: 1.6, clearcoat: 1, clearcoatRoughness: .03,
    emissive: 0xffffff, emissiveMap: roleTex, emissiveIntensity: .3, envMapIntensity: 2,
  })));
  const glintMat = mask => new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: {uTime: {value: 0}, uMask: {value: mask}},
    vertexShader: `varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform float uTime; uniform sampler2D uMask; varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){
        float m = texture2D(uMask, vUv).a;
        vec2 tilt = vV.xy - vN.xy;
        float p = fract(uTime / 3.6);
        float x = vUv.x + (vUv.y - .5) * .3 - (p * 2.6 - .8) + tilt.x * .9;
        float a = (exp(-x * x * 260.0) * 1.1 + exp(-x * x * 18.0) * .25) * m;
        gl_FragColor = vec4(vec3(1.0, .98, .95) * a, a);
      }`,
  });
  const roleShine = new THREE.Mesh(roleGeo, glintMat(roleTex)); roleShine.position.z = .0003; rolePlate.add(roleShine);
  card.add(rolePlate);
  // Supporter sticker: holographic foil whose rainbow shifts with the viewing angle.
  const sr = STICK / PW * W;
  const stickerTex = tex(stickerCanvas), stickerBump = new THREE.CanvasTexture(stickerHeight);
  const sticker = new THREE.Group(); sticker.visible = false;
  const stickGeo = new THREE.PlaneGeometry(sr, sr);
  sticker.add(new THREE.Mesh(stickGeo, new THREE.MeshPhysicalMaterial({
    map: stickerTex, normalMap: stickerBump, normalScale: new THREE.Vector2(2.2, 2.2), transparent: true, alphaTest: .05, metalness: .55, roughness: .22, iridescence: 1, iridescenceIOR: 1.9,
    iridescenceThicknessRange: [120, 900], clearcoat: 1, clearcoatRoughness: .04, emissive: 0xffffff, emissiveMap: stickerTex, emissiveIntensity: .35,
  })));
  const stickerHolo = new THREE.Mesh(stickGeo, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: {uTime: {value: 0}, uMask: {value: stickerTex}},
    vertexShader: `varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform float uTime; uniform sampler2D uMask; varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      vec3 rainbow(float t){ return .5 + .5 * cos(6.28318 * (t + vec3(0.0, .33, .67))); }
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main(){
        float m = texture2D(uMask, vUv).a;
        vec2 tilt = vV.xy - vN.xy, d = vUv - .5;
        float t = atan(d.y, d.x) / 6.28318 + length(d) * 1.4 + tilt.x * 2.2 - tilt.y * 1.6 + uTime * .05;
        vec2 cell = floor(vUv * 90.0);
        float sp = step(.97, hash(cell)) * pow(max(0.0, sin(hash(cell + 3.1) * 40.0 + tilt.x * 30.0 + tilt.y * 22.0)), 8.0);
        float a = (.32 + sp) * m;
        gl_FragColor = vec4(mix(rainbow(t), vec3(1.0), sp) * a, a);
      }`,
  }));
  stickerHolo.position.z = .0003; sticker.add(stickerHolo);
  sticker.position.set(STICKER.x / PW * W - W / 2, H / 2 - STICKER.y / PH * H, faceZ + .0012);
  card.add(sticker);
  // Soft shadow on an invisible floor behind the card: it shifts and blurs as the card turns.
  const sh = document.createElement('canvas'); sh.width = sh.height = 256;
  const shx = sh.getContext('2d'), sg = shx.createRadialGradient(128, 128, 0, 128, 128, 128);
  sg.addColorStop(0, 'rgba(0,0,0,.55)'); sg.addColorStop(.6, 'rgba(0,0,0,.18)'); sg.addColorStop(1, 'rgba(0,0,0,0)');
  shx.fillStyle = sg; shx.fillRect(0, 0, 256, 256);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(W * 1.5, H * 1.25), new THREE.MeshBasicMaterial({map: new THREE.CanvasTexture(sh), transparent: true, depthWrite: false}));
  shadow.position.set(0, -.12, -.9); scene.add(shadow);

  // Holographic foil: a rainbow that moves with the viewing angle.
  const holo = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: {uStrength: {value: .5}, uTime: {value: 0}, uMode: {value: 0}},
    vertexShader: `varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform float uStrength; uniform float uTime; uniform int uMode; varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      vec3 rainbow(float t){ return .5 + .5 * cos(6.28318 * (t + vec3(0.0, .33, .67))); }
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
      float fbm(vec2 p){ float v = 0.0, a = .5; for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= .5; } return v; }
      float stars(vec2 p, float th){ vec2 c = floor(p), f = fract(p) - .5; float h = hash(c);
        if (h < th) return 0.0; vec2 o = vec2(hash(c + 1.7), hash(c + 3.1)) - .5; return smoothstep(.12, .0, length(f - o * .6)) * (h - th) / (1.0 - th) * 2.0; }
      void main(){
        float f = dot(vN, vV);
        vec2 tilt = vec2(vV.x - vN.x, vV.y - vN.y);
        float rim = pow(1.0 - f, 1.3);
        vec3 col; float a;
        if (uMode == 0) {          // holographic: rainbow bands + glitter that twinkles with the angle
          float t = vUv.x * .8 + vUv.y * .5 + tilt.x * 2.6 - tilt.y * 2.0;
          float band = smoothstep(.15, .85, sin(t * 6.28318 * .9) * .5 + .5);
          vec2 cell = floor(vUv * vec2(160.0, 234.0));
          float sp = step(.985, hash(cell)) * pow(max(0.0, sin(hash(cell + 3.1) * 40.0 + tilt.x * 30.0 + tilt.y * 22.0)), 8.0);
          col = rainbow(t) ; a = uStrength * ((.15 + .85 * rim) * (.35 + .65 * band)) + sp * .9;
        } else if (uMode == 1) {   // prism: fine diffraction grating split into spectra
          float g = sin((vUv.x + vUv.y) * 900.0) * .5 + .5;
          float t = (vUv.x - vUv.y) * 1.5 + tilt.x * 4.0 + tilt.y * 3.0;
          col = rainbow(t + g * .15); a = uStrength * (.25 + .75 * rim) * (.4 + .6 * g) * smoothstep(.0, .5, abs(sin(t * 3.14159)));
        } else if (uMode == 2) {   // gold foil: a warm specular sweep
          float s = exp(-pow((vUv.x * .7 + vUv.y * .5 - .6 - tilt.x * 1.6 + tilt.y * 1.2) * 4.0, 2.0));
          col = mix(vec3(.89, .70, .29), vec3(1.0, .95, .78), s); a = uStrength * (.12 + .88 * s);
        } else if (uMode == 4) {   // galaxy: a nebula that drifts with the angle, with stars
          vec2 q = vUv * vec2(1.0, 1.46) * 2.4 + tilt * 1.4;
          float n = fbm(q + fbm(q * 1.7 + uTime * .03));
          vec3 neb = mix(vec3(.20, .10, .55), vec3(.95, .30, .75), smoothstep(.35, .75, n));
          neb = mix(neb, vec3(.25, .75, 1.0), smoothstep(.62, .9, fbm(q * 2.3 - 4.0)));
          float st = stars(vUv * vec2(120.0, 175.0) + tilt * 8.0, .975);
          col = neb + st; a = uStrength * (.3 + .7 * smoothstep(.25, .75, n)) + st;
        } else if (uMode == 5) {   // stardust: three layers of stars at different depths (parallax)
          float st = 0.0;
          for (int l = 0; l < 3; l++) {
            float d = float(l + 1);
            st += stars(vUv * vec2(55.0, 80.0) * d + tilt * 14.0 / d + d * 7.0, .975 - .006 * d) * (1.2 / d)
                  * (.6 + .4 * sin(uTime * (1.5 + d) + d * 3.0 + vUv.x * 40.0));
          }
          col = vec3(.85, .9, 1.0); a = uStrength * st + .05 * rim;
        } else if (uMode == 6) {   // aurora: soft flowing curtains of green and violet
          float y = vUv.y + .08 * sin(vUv.x * 6.0 + uTime * .4 + tilt.x * 4.0) + tilt.y * .6;
          float c1 = exp(-pow((y - .72) * 7.0, 2.0)), c2 = exp(-pow((y - .48 + .05 * sin(vUv.x * 9.0 - uTime * .3)) * 9.0, 2.0));
          float rays = .6 + .4 * fbm(vec2(vUv.x * 18.0 + tilt.x * 6.0, uTime * .1));
          col = vec3(.2, 1.0, .65) * c1 + vec3(.65, .35, 1.0) * c2; a = uStrength * (c1 + c2) * rays;
        } else {                   // none: only a soft sheen
          float s = exp(-pow((vUv.x - .5 - tilt.x * 1.5) * 3.0, 2.0)); col = vec3(1.0); a = uStrength * .35 * s;
        }
        gl_FragColor = vec4(col * a, a);
      }`,
  });
  const holoMesh = new THREE.Mesh(face, holo); holoMesh.position.z = faceZ + .0006; card.add(holoMesh);

  // Interaction: drag to turn, flip, phone motion, idle sway.
  const state = {ry: -.35, rx: .12, try: -.35, trx: .12, base: -.35, flip: 0, dragging: false, last: 0, vx: 0, motion: null, spin: null};
  let px = 0, py = 0;
  const el = renderer.domElement;
  el.addEventListener('pointerdown', e => { state.dragging = true; px = e.clientX; py = e.clientY; state.last = performance.now(); el.setPointerCapture(e.pointerId); });
  el.addEventListener('pointermove', e => {
    const box = el.getBoundingClientRect();
    glint.position.set(((e.clientX - box.left) / box.width - .5) * 5, -((e.clientY - box.top) / box.height - .5) * 3, 3);
    if (!state.dragging) return;
    const dx = e.clientX - px, dy = e.clientY - py; px = e.clientX; py = e.clientY;
    state.try += dx * .01; state.trx = Math.max(-.6, Math.min(.6, state.trx + dy * .006));
    state.vx = dx * .01; state.last = performance.now();
  });
  const end = () => { if (!state.dragging) return; state.dragging = false; state.try += state.vx * 8; state.base = state.try; state.vx = 0; state.last = performance.now(); };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);

  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Keep the whole card in view, also when it is turned.
    const fitW = 2.5 / camera.aspect, fitH = 3.1;
    camera.position.set(0, 0, Math.max(fitW, fitH) / (2 * Math.tan(THREE.MathUtils.degToRad(15))));
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(stage); resize();

  const clock = new THREE.Clock();
  function frame() {
    const dt = Math.min(clock.getDelta(), .05), t = clock.elapsedTime;
    holo.uniforms.uTime.value = t; roleShine.material.uniforms.uTime.value = t; stickerHolo.material.uniforms.uTime.value = t;
    if (state.spin) {
      // Recording: a fixed full turn.
      const p = Math.max(0, Math.min((performance.now() - state.spin.start) / state.spin.duration, 1));
      const e = p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      card.rotation.set(.12 + Math.sin(p * Math.PI * 2) * .06, -.35 + e * Math.PI * 2, 0);
    } else {
      const idle = !state.dragging && performance.now() - state.last > 2500 && !state.motion && !reduced;
      if (idle) { state.try += (state.base + Math.sin(t * .6) * .3 - state.try) * dt * 1.2; state.trx += (.12 + Math.sin(t * .9) * .06 - state.trx) * dt * 1.2; }
      if (state.motion && !state.dragging) { state.try = state.base + state.motion.x; state.trx = state.motion.y; }
      state.ry += (state.try - state.ry) * Math.min(dt * 8, 1);
      state.rx += (state.trx - state.rx) * Math.min(dt * 8, 1);
      card.rotation.set(state.rx, state.ry, 0);
    }
    // Float and shadow follow the card.
    card.position.y = reduced ? 0 : Math.sin(t * 1.3) * .025;
    const turn = Math.abs(Math.cos(card.rotation.y));
    shadow.position.x = -Math.sin(card.rotation.y) * .35;
    shadow.position.y = -.14 - card.position.y * 1.5 + card.rotation.x * .2;
    shadow.scale.set(.35 + .65 * turn, 1, 1);
    shadow.material.opacity = .55 + .45 * turn;
    scene.background = state.rec?.background || null;
    renderer.render(scene, state.rec?.camera || camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  return {
    renderer, scene, camera, card, state,
    resize,
    update(v) {
      frontTex.needsUpdate = true; backTex.needsUpdate = true; licTex.needsUpdate = true; frontBump.needsUpdate = true; backBump.needsUpdate = true;
      // Admin pass: the E1 is raised in 3D too.
      const lm = licMesh.material, bump = v.staff ? licBump : null;
      if (lm.normalMap !== bump) { lm.normalMap = bump; lm.normalScale.set(.9, .9); lm.needsUpdate = true; }
      if (bump) licBump.needsUpdate = true;
      rolePlate.visible = Boolean(v.role && roleSlot);
      if (rolePlate.visible) {
        roleTex.needsUpdate = true; roleBump.needsUpdate = true;
        rolePlate.position.set((54 + ROLE_W / 2) / PW * W - W / 2, H / 2 - (roleSlot.y + 18 + ROLE_H / 2) / PH * H, faceZ + .001);
      }
      sticker.visible = Boolean(v.donor);
      if (sticker.visible) { stickerTex.needsUpdate = true; stickerBump.needsUpdate = true; }
      // Foil: subtle on the ladder, stronger on prestige levels; light designs need less to stay readable.
      const finish = FINISHES[form.elements.finish?.value] || FINISHES.none;
      holo.uniforms.uMode.value = finish.mode;
      holo.uniforms.uStrength.value = finish.strength * (v.level?.tier === 'star' ? 1.15 : 1);
    },
    flip() { state.base += Math.PI; state.try += Math.PI; state.last = performance.now(); },
    setMotion(m) { state.motion = m; },
  };
}

// Fallback without WebGL: the flat front with a CSS tilt.
function createFlatView() {
  stage.classList.add('flat');
  const shown = document.createElement('canvas'); shown.width = front.width; shown.height = front.height;
  stage.append(shown);
  stage.addEventListener('pointermove', e => {
    const box = stage.getBoundingClientRect();
    shown.style.setProperty('--ry', `${((e.clientX - box.left) / box.width - .5) * 22}deg`);
    shown.style.setProperty('--rx', `${(.5 - (e.clientY - box.top) / box.height) * 16}deg`);
  });
  $('lic-video').hidden = true; $('lic-flip').hidden = true; $('lic-video-hint').hidden = true;
  $('lic-hint').textContent = 'Your browser cannot show the 3D card, here is the front.';
  return {update() { shown.getContext('2d').drawImage(front, 0, 0); }, flip() {}, setMotion() {}};
}

// Export ------------------------------------------------------------------------------
function ready() {
  const v = values();
  if (crewLoaded && !picked) { inlineMessage(message, 'error', v.username ? 'Pick your username from the list.' : 'Add your username first.'); form.elements.username.focus(); return null; }
  if (!v.username) { inlineMessage(message, 'error', 'Add your username first.'); form.elements.username.focus(); return null; }
  if (!v.team) { inlineMessage(message, 'error', 'Choose your team.'); form.elements.team.focus(); return null; }
  if (!v.level && !v.staff && !v.special) { inlineMessage(message, 'error', 'Choose your crew licence level.'); form.elements.level.focus(); return null; }
  inlineMessage(message, 'info', '');
  return v;
}
const slug = v => v.username.replace(/[^\w.-]+/g, '_').slice(0, 30) || 'crew';
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
$('lic-download').addEventListener('click', () => {
  const v = ready(); if (!v) return;
  front.toBlob(blob => {
    if (!blob) { toast('error', 'Could not create the image', 'Try again, or use another browser.'); return; }
    download(blob, `emgp26-certificate-${slug(v)}.png`);
    toast('success', 'Certificate saved', 'Find it in your downloads or Photos.');
  }, 'image/png');
});
$('lic-licence').addEventListener('click', () => {
  const v = ready(); if (!v) return;
  licence.toBlob(blob => {
    if (!blob) { toast('error', 'Could not create the image', 'Try again, or use another browser.'); return; }
    download(blob, `emgp26-crew-licence-${slug(v)}.png`);
    toast('success', 'Crew licence saved', 'Find it in your downloads or Photos.');
  }, 'image/png');
});
$('lic-donor').addEventListener('click', () => {
  const v = ready(); if (!v || !v.donor) return;
  donorCard.toBlob(blob => {
    if (!blob) { toast('error', 'Could not create the image', 'Try again, or use another browser.'); return; }
    download(blob, `emgp26-donor-certificate-${slug(v)}.png`);
    toast('success', 'Donor certificate saved', 'Thank you for supporting the campaign!');
  }, 'image/png');
});
$('lic-flip').addEventListener('click', () => view?.flip());

// Video: a second renderer at 1080 x 1350 records one full turn of the card.
function videoType() {
  for (const type of ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm']) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(type)) return type;
  }
  return null;
}
// Video formats: the spin is framed for where it will be posted.
const FORMATS = {
  story: {w: 1080, h: 1920, fill: .5, label: 'Story · Reel · TikTok'},
  post: {w: 1080, h: 1350, fill: .745, label: 'Instagram post'},
  square: {w: 1080, h: 1080, fill: .7, label: 'X post'},
};
function videoBackground(v, f) {
  const {w, h} = f, c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d'), col = v.team.color;
  ctx.fillStyle = '#0b0c0f'; ctx.fillRect(0, 0, w, h);
  let g = ctx.createRadialGradient(w / 2, h * .5, 0, w / 2, h * .5, Math.max(w, h) * .65);
  g.addColorStop(0, hexA(col, .34)); g.addColorStop(1, hexA(col, 0));
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  // Starry sky.
  let seed = 7;
  const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < w * h / 3500; i++) { ctx.fillStyle = `rgba(255,255,255,${.15 + rnd() * .5})`; ctx.beginPath(); ctx.arc(rnd() * w, rnd() * h, .6 + rnd() * 1.4, 0, Math.PI * 2); ctx.fill(); }
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  const mid = w / 2, label = (text, y, size, weight, color, sp = 0) => {
    ctx.font = font(size, weight); ctx.fillStyle = color;
    const tw = [...text].reduce((a, ch) => a + ctx.measureText(ch).width + sp, -sp);
    ctx.textAlign = 'left'; spaced(ctx, text, mid - tw / 2, y, sp); ctx.textAlign = 'center';
  };
  const who = `${v.username} · ${teamLabel(v.team, ' · ')}`;
  if (f === FORMATS.story) {
    // Top and bottom bands, clear of the platform UI.
    // Text stays inside the platforms' safe area; the card sits between, with room to breathe.
    if (logo.complete && logo.naturalWidth) { const lh = 58, lw = lh * logo.naturalWidth / logo.naturalHeight; ctx.drawImage(logo, mid - lw / 2, 236, lw, lh); }
    label('ENHYPEN MAMA GRAND PRIX 2026', 350, 30, 700, '#d4d5db', 5);
    label('CERTIFICATE OF PARTICIPATION', 394, 24, 600, '#9a9ca6', 6);
    label(v.username, 1532, 60, 700, '#fff');
    label(v.staff ? `${tierText(v).video} · ${v.role}` : `${teamLabel(v.team, ' · ')} · ${v.level ? v.level.name : SPECIAL[v.special]?.line || ''}`, 1584, 30, 600, col);
    label('Different Colors. Same finish line.', 1636, 26, 400, '#c9cad0');
  } else if (f === FORMATS.square) {
    label(who, h - 64, 30, 700, '#fff');
    label('ENHYPEN MAMA GRAND PRIX 2026', 64, 24, 700, '#9a9ca6', 5);
  } else {
    label('ENHYPEN MAMA GRAND PRIX · SEASON 2026', h - 50, 24, 700, '#8d8f99');
  }
  ctx.textAlign = 'left';
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
let recording = false;
async function recordSpin(v, f) {
  // Records the on-screen renderer itself (one WebGL context: no second shader compile),
  // resized to the video format for a few seconds behind a "Recording" overlay.
  const type = videoType();
  if (!type) throw new Error('unsupported');
  recording = true;
  const r = view.renderer, ratio = r.getPixelRatio();
  stage.classList.add('recording');
  const cam = new THREE.PerspectiveCamera(30, f.w / f.h, .1, 100);
  cam.position.set(0, -.04, 2.634 / (f.fill * 2 * Math.tan(THREE.MathUtils.degToRad(15))));
  const bg = videoBackground(v, f);
  r.setPixelRatio(1); r.setSize(f.w, f.h, false);
  view.state.rec = {camera: cam, background: bg};
  const chunks = [];
  try {
    const recorder = new MediaRecorder(r.domElement.captureStream(30), {mimeType: type, videoBitsPerSecond: 8_000_000});
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise(resolve => { recorder.onstop = resolve; });
    await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
    view.state.spin = {start: performance.now() + 400, duration: 4000};
    recorder.start(250);
    await new Promise(res => setTimeout(res, 4800));
    recorder.stop(); await done;
  } finally {
    view.state.spin = null; view.state.rec = null;
    view.state.ry = view.state.try = view.state.base = -.35 + Math.round((view.state.base + .35) / Math.PI) * Math.PI; view.state.last = performance.now();
    r.setPixelRatio(ratio); view.resize(); bg.dispose();
    stage.classList.remove('recording');
    recording = false;
  }
  const ext = type.startsWith('video/mp4') ? 'mp4' : 'webm';
  return {blob: new Blob(chunks, {type: type.split(';')[0]}), ext};
}
$('lic-video').addEventListener('click', async () => {
  const v = ready(); if (!v || !view?.renderer || recording) return;
  const button = $('lic-video'), label = button.textContent;
  button.disabled = true; button.textContent = 'Recording…';
  try {
    const {blob, ext} = await recordSpin(v, FORMATS.post);
    download(blob, `emgp26-certificate-${slug(v)}.${ext}`);
    toast('success', 'Video saved', ext === 'webm' ? 'Saved as WEBM: if Instagram refuses it, record it again from Safari or a recent Chrome.' : 'Find it in your downloads or Photos.');
  } catch { toast('error', 'Video not supported here', 'This browser cannot record video. Try Safari or Chrome.'); recording = false; }
  button.disabled = false; button.textContent = label;
});

// Share: record the spin framed for the chosen platform, then hand it to the share sheet.
// Recording takes a few seconds, longer than browsers allow between a tap and sharing,
// so the share sheet opens with a second tap ("Share now").
const shareBox = $('lic-share');
let shared = null;
shareBox?.addEventListener('click', async e => {
  const button = e.target.closest('button[data-format]'); if (!button) return;
  const v = ready(); if (!v || !view?.renderer) return;
  const f = FORMATS[button.dataset.format];
  if (shared?.button === button) {
    const file = new File([shared.blob], `emgp26-certificate-${slug(v)}-${button.dataset.format}.${shared.ext}`, {type: shared.blob.type});
    if (navigator.canShare?.({files: [file]})) {
      try { await navigator.share({files: [file], title: 'My EMGP26 certificate', text: 'I raced for ENHYPEN during ENHYPEN MAMA Grand Prix to bring home the Daesang. #EMGP2026 #ENHYPEN'}); }
      catch (err) { if (err?.name !== 'AbortError') { download(shared.blob, file.name); toast('info', 'Saved instead', 'Sharing was not possible, the video is in your downloads.'); } }
    } else {
      download(shared.blob, file.name);
      toast('success', 'Video saved', `Post it from your gallery as ${f.label}.`);
    }
    return;
  }
  if (recording) return;
  shareBox.querySelectorAll('button[data-format]').forEach(b => { b.disabled = true; b.classList.remove('ready'); b.querySelector('small').textContent = FORMATS[b.dataset.format].hint; });
  button.querySelector('small').textContent = 'Preparing…';
  try {
    const {blob, ext} = await recordSpin(v, f);
    shared = {button, blob, ext};
    button.classList.add('ready'); button.querySelector('small').textContent = 'Ready · tap to share';
  } catch { toast('error', 'Video not supported here', 'This browser cannot record video. Try Safari or Chrome.'); recording = false; shared = null; }
  shareBox.querySelectorAll('button[data-format]').forEach(b => { b.disabled = false; });
});
form.addEventListener('input', () => { if (!shared) return; shared.button.classList.remove('ready'); shared.button.querySelector('small').textContent = FORMATS[shared.button.dataset.format].hint; shared = null; });
FORMATS.story.hint = '9:16'; FORMATS.post.hint = '4:5'; FORMATS.square.hint = '1:1';

// Embed: an iframe with only the 3D pass, for personal sites, Carrd, Notion…
const FINISH_KEYS = Object.keys(FINISHES);
function embedUrl(v) {
  const look = {finish: form.elements.finish.value, ...(form.elements.color.value === 'classic' ? {color: 'classic'} : {})};
  const q = new URLSearchParams(picked ? {id: picked.id, ...(shownName ? {name: shownName} : {}), ...look}
    : {u: v.username, team: form.elements.team.value, level: String(v.level.index + 1), ...look});
  return `${location.origin}/crew-license/embed?${q}`;
}
$('lic-embed')?.addEventListener('click', () => {
  const v = ready(); if (!v) return;
  const box = $('lic-embed-box'); box.hidden = false;
  const code = `<iframe src="${embedUrl(v)}" width="360" height="480" style="border:0;max-width:100%" loading="lazy" allow="gyroscope; accelerometer" title="EMGP26 certificate of ${v.username}"></iframe>`;
  $('lic-embed-code').value = code; $('lic-embed-code').select();
});
$('lic-embed-copy')?.addEventListener('click', async () => {
  const field = $('lic-embed-code');
  try { await navigator.clipboard.writeText(field.value); toast('success', 'Embed code copied', 'Paste it into your site, Carrd or Notion (embed block).'); }
  catch { field.select(); toast('info', 'Copy the code', 'Select the code and copy it.'); }
});
// Nickname search in the crew list ----------------------------------------------------
const userInput = form.elements.username, suggest = $('lic-suggest');
let results = [], active = -1, searchId = 0, searchTimer = 0;
const entryNote = e => e.note ? ` (${e.note})` : '';
function pick(e) {
  picked = e;
  userInput.value = e.username;
  form.elements.team.value = e.team;
  form.elements.level.value = String(e.level - 1);
  closeSuggest();
  nameChoice(e.x || []);
  // Donors start with the holographic finish (unless a finish was chosen).
  if (e.donor && !finishChosen) form.elements.finish.value = 'holo';
}
let finishChosen = false;
form.elements.finish.addEventListener('change', () => { finishChosen = true; });
// Name on the certificate: the E1 username, or one of the X handles in the crew list.
const nameBox = $('lic-name');
function nameChoice(handles, chosen = '') {
  const own = picked.username.replace(/^@/, '').toLowerCase();
  const options = handles.filter(h => h.toLowerCase() !== own);
  shownName = options.includes(chosen) ? chosen : '';
  nameBox.querySelectorAll('label').forEach(l => l.remove());
  for (const [value, text] of [['', picked.username.replace(/^@/, '')], ...options.map(h => [h, `@${h}`])]) {
    const label = document.createElement('label'), input = document.createElement('input'), span = document.createElement('span');
    input.type = 'radio'; input.name = 'shown'; input.value = value; input.checked = value === shownName;
    span.textContent = text; label.append(input, span); nameBox.append(label);
  }
  nameBox.hidden = !options.length;
}
nameBox.addEventListener('input', e => { if (e.target.name === 'shown') shownName = e.target.value; });  // before the form's input listener repaints
async function pickFromList(e) {
  pick(e); paint();
  // The X handles and the supporter badge come with the single entry.
  try { const r = await fetch(`/api/crew?id=${encodeURIComponent(e.id)}`); if (r.ok && picked?.id === e.id) { pick(await r.json()); paint(); } } catch { /* username only */ }
}
function closeSuggest() { suggest.hidden = true; active = -1; userInput.setAttribute('aria-expanded', 'false'); userInput.removeAttribute('aria-activedescendant'); }
function showSuggest(list, query) {
  results = list; active = -1; suggest.replaceChildren();
  if (!list.length) {
    const li = document.createElement('li'); li.className = 'empty';
    li.textContent = query ? 'No crew member with this name. Check the spelling of your E1 username or X handle.' : '';
    suggest.append(li);
  }
  list.forEach((e, i) => {
    const li = document.createElement('li'); li.id = `lic-opt-${i}`; li.setAttribute('role', 'option'); li.dataset.index = i;
    const name = document.createElement('b'); name.textContent = e.username;
    const meta = document.createElement('small'); meta.textContent = [e.via ? `@${e.via}` : '', entryNote(e).trim()].filter(Boolean).join(' ');
    li.style.setProperty('--team', TEAMS[e.team].color); li.append(name, meta);
    suggest.append(li);
  });
  suggest.hidden = false; userInput.setAttribute('aria-expanded', 'true');
}
function highlight(i) {
  active = (i + results.length) % results.length;
  suggest.querySelectorAll('li[role=option]').forEach((li, k) => li.setAttribute('aria-selected', String(k === active)));
  userInput.setAttribute('aria-activedescendant', `lic-opt-${active}`);
  suggest.children[active]?.scrollIntoView({block: 'nearest'});
}
async function search() {
  const query = userInput.value.trim().replace(/^@/, ''), id = ++searchId;
  if (!query) { closeSuggest(); return; }
  try {
    const r = await fetch(`/api/crew?q=${encodeURIComponent(query)}`);
    const data = await r.json();
    if (id === searchId && document.activeElement === userInput) showSuggest(data.results || [], query);
  } catch { /* offline: keep typing */ }
}
userInput.addEventListener('input', e => {
  if (!crewLoaded) return;
  if (picked) { picked = null; shownName = ''; nameBox.hidden = true; form.elements.team.value = ''; form.elements.level.value = ''; }
  clearTimeout(searchTimer); searchTimer = setTimeout(search, 140);
});
userInput.addEventListener('focus', () => { if (crewLoaded && !picked && userInput.value.trim()) search(); });
userInput.addEventListener('keydown', e => {
  if (suggest.hidden || !results.length) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); highlight(active + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(active - 1); }
  else if (e.key === 'Enter') { e.preventDefault(); const r = results[active >= 0 ? active : 0]; if (r && (active >= 0 || results.length === 1)) pickFromList(r); }
  else if (e.key === 'Escape') closeSuggest();
});
suggest.addEventListener('pointerdown', e => {
  const li = e.target.closest('li[role=option]'); if (!li) return;
  e.preventDefault(); pickFromList(results[Number(li.dataset.index)]);
});
userInput.addEventListener('blur', () => setTimeout(closeSuggest, 120));
try {
  const r = await fetch('/api/crew');
  crewLoaded = r.ok && (await r.json()).loaded === true;
} catch { crewLoaded = false; }
// Without the list (not uploaded yet), the team and licence are chosen by hand as before.
$('lic-manual').hidden = crewLoaded;
if (!crewLoaded) { $('lic-user-hint').textContent = 'Your username on e1.ensite.org.'; userInput.placeholder = 'e.g. awannv'; userInput.removeAttribute('role'); }

const embedMode = location.pathname.endsWith('/embed');
if (embedMode) {
  // Fill the form from the link and show only the card.
  document.body.classList.add('embed');
  const q = new URLSearchParams(location.search);
  if (FINISH_KEYS.includes(q.get('finish'))) { form.elements.finish.value = q.get('finish'); finishChosen = true; }
  if (q.get('color') === 'classic') form.elements.color.value = 'classic';
  if (q.get('id')) {
    // From the crew list: name, team, licence and role are the ones on the list.
    try { const r = await fetch(`/api/crew?id=${encodeURIComponent(q.get('id'))}`); if (r.ok) { pick(await r.json()); nameChoice(picked.x || [], q.get('name') || ''); } } catch { /* empty card */ }
  } else {
    form.elements.username.value = (q.get('u') || '').slice(0, 24);
    if (TEAMS[q.get('team')]) form.elements.team.value = q.get('team');
    const lv = Number(q.get('level')); if (lv >= 1 && lv <= LEVELS.length) form.elements.level.value = String(lv - 1);
  }
}

// Phone motion (iOS asks for permission after a tap) ---------------------------------
function onOrientation(e) {
  if (e.beta == null || e.gamma == null) return;
  view?.setMotion({x: Math.max(-.6, Math.min(.6, e.gamma / 45)), y: Math.max(-.5, Math.min(.5, (e.beta - 45) / 70))});
}
if (!reduced && matchMedia('(pointer: coarse)').matches && 'DeviceOrientationEvent' in window) {
  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    const b = $('lic-tilt'); b.hidden = false;
    b.addEventListener('click', async () => {
      try { if (await DeviceOrientationEvent.requestPermission() === 'granted') { addEventListener('deviceorientation', onOrientation); b.hidden = true; } } catch { /* stays drag-only */ }
    });
  } else {
    addEventListener('deviceorientation', onOrientation);
  }
}

// Start --------------------------------------------------------------------------------
form.addEventListener('input', paint);
form.addEventListener('submit', e => e.preventDefault());
await Promise.all(['400', '600', '700'].map(w => document.fonts.load(`${w} 40px "Titillium Web"`))).catch(() => {});
await Promise.all([logo, qr].map(img => img.complete ? null : new Promise(r => { img.onload = img.onerror = r; })));
try { view = createView(); } catch { view = createFlatView(); }
paint();
