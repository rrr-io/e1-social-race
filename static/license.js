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
  rikston: {name: 'Rikston Drift', member: 'Team Ni-ki', color: '#4cd964'},
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

function values() {
  const username = form.elements.username.value.trim().replace(/^@/, '');
  const team = TEAMS[form.elements.team.value] || null;
  const level = LEVELS[Number(form.elements.level.value)] || null;
  return {username, team, level, complete: Boolean(username && team && form.elements.level.value !== '')};
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

function drawLicence(ctx, v, art) {
  ctx.save();
  roundRect(ctx, 0, 0, CW, CH, RADIUS); ctx.clip();
  if (art) ctx.drawImage(art, 0, 0, CW, CH); else drawPlaceholder(ctx);
  // Holder: same place and size as "Your Name / Your Team" on the designs.
  const [ink, sub] = v.level ? INK[code(v.level)] : ['#ffffff', '#c0c4cd'];
  ctx.textBaseline = 'alphabetic';
  const name = v.username || 'Your Name';
  ctx.fillStyle = ink; ctx.globalAlpha = v.username ? 1 : .35;
  fit(ctx, name, 900, 81, 700); ctx.fillText(name, 88, 386);
  const team = v.team ? `${v.team.name} - ${v.team.member}` : 'Your Team';
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
function passBase(ctx, c) {
  roundRect(ctx, 0, 0, PW, PH, PRADIUS); ctx.clip();
  let g = ctx.createLinearGradient(0, 0, PW * .6, PH);
  g.addColorStop(0, '#1c1e24'); g.addColorStop(.6, '#0d0e11'); g.addColorStop(1, '#0d0e11');
  ctx.fillStyle = g; ctx.fillRect(0, 0, PW, PH);
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
  const c = v.team?.color || '#9a9ca6';
  ctx.save(); passBase(ctx, c);
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
  let y = wrapText(ctx, [
    {text: 'This certifies that ', color: '#c9cad0', weight: 400}, {text: name, color: '#fff', weight: 700},
    {text: ' raced with ', color: '#c9cad0', weight: 400}, {text: v.team ? `${v.team.name} · ${v.team.member}` : 'your team', color: c, weight: 700},
    {text: ' in the ENHYPEN MAMA Grand Prix 2026, reaching the ', color: '#c9cad0', weight: 400},
    {text: v.level ? v.level.name : 'your', color: '#fff', weight: 700}, {text: ' crew licence.', color: '#c9cad0', weight: 400},
  ], 56, sy + sh + 66, PW - 112, 44);
  // Access zones.
  let zx = 56; y += 40;
  for (const z of ['PIT', 'GRID', 'PADDOCK', 'GARAGE']) {
    ctx.font = `italic ${font(24, 900)}`; const w = ctx.measureText(z).width + 40;
    roundRect(ctx, zx, y, w, 46, 10); ctx.fillStyle = hexA(c, .14); ctx.fill(); ctx.strokeStyle = hexA(c, .7); ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = c; ctx.fillText(z, zx + 20, y + 32); zx += w + 12;
  }
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
function trophy(ctx, x, y, s, color) {
  ctx.save(); ctx.translate(x - s / 2, y - s / 2); ctx.scale(s / 48, s / 48); ctx.fillStyle = color;
  ctx.fill(new Path2D('M14 6h20v4h7v4c0 6-4 10-9.4 10.8A10 10 0 0 1 26 30.6V36h6v4H16v-4h6v-5.4a10 10 0 0 1-5.6-5.8C11 24 7 20 7 14v-4h7zm0 8h-3c0 3.4 1.6 5.8 4 6.6A13 13 0 0 1 14 18zm20 0v4c0 .9-.1 1.8-.3 2.6 2.4-.8 4-3.2 4-6.6z'));
  ctx.fillRect(13, 40, 22, 3); ctx.restore();
}
function drawPassBack(ctx, v) {
  const c = v.team?.color || '#9a9ca6';
  ctx.save(); passBase(ctx, c);
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
  ctx.fillStyle = '#d4d5db'; ctx.font = font(32, 400); ctx.fillText('We crossed the line together.', PW / 2, 1080);
  ctx.fillStyle = '#fff'; ctx.font = font(32, 700); ctx.fillText('Six teams. One ENHYPEN.', PW / 2, 1124);
  ctx.textAlign = 'left';
  ctx.restore(); passEdge(ctx, c);
}
const issued = new Intl.DateTimeFormat('en-GB', {timeZone: 'Asia/Seoul', day: '2-digit', month: 'short', year: 'numeric'}).format(new Date()).toUpperCase();
function licenceNumber(v) {
  let h = 2166136261;
  for (const ch of `${(v.username || '').toLowerCase()}|${v.team?.name || ''}`) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return `E1-26-${String(h % 10000).padStart(4, '0')}${'ABCDEFGHJKLMNPRSTUVWXYZ'[(h >>> 14) % 23]}`;
}

const licence = document.createElement('canvas'); licence.width = CW * SCALE; licence.height = CH * SCALE;
const front = document.createElement('canvas'); front.width = PW * PSCALE; front.height = PH * PSCALE;
const back = document.createElement('canvas'); back.width = PW * PSCALE; back.height = PH * PSCALE;
const frontBase = document.createElement('canvas'); frontBase.width = front.width; frontBase.height = front.height;
// Where the licence sits on the pass (logical pass pixels), shared by the 2D drawing and the 3D plate.
const SLOT = (() => { const sx = 48, sy = 278, inner = PW - 96 - 36; return {x: sx + 18, y: sy + 18, w: inner, h: inner * CH / CW}; })();
// Emboss: bright print (text, logo, zones, barcode) becomes a bump map, so it stands out in 3D.
const HS = .5;
const frontHeight = document.createElement('canvas'); frontHeight.width = PW * PSCALE * HS; frontHeight.height = PH * PSCALE * HS;
const backHeight = document.createElement('canvas'); backHeight.width = frontHeight.width; backHeight.height = frontHeight.height;
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
  const art = v.level ? await design(v.level) : null;
  if (id !== paintId) return;   // a newer change is already being drawn
  const lctx = licence.getContext('2d');
  lctx.setTransform(SCALE, 0, 0, SCALE, 0, 0); lctx.clearRect(0, 0, CW, CH); drawLicence(lctx, v, art);
  for (const [canvas, draw, arg] of [[front, drawPassFront, true], [frontBase, drawPassFront, false], [back, drawPassBack]]) {
    const ctx = canvas.getContext('2d');
    ctx.setTransform(PSCALE, 0, 0, PSCALE, 0, 0); ctx.clearRect(0, 0, PW, PH);
    draw(ctx, v, arg);
  }
  if (view?.renderer) { heightFrom(frontBase, frontHeight); heightFrom(back, backHeight); }
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
  const renderer = new THREE.WebGLRenderer({antialias: true, alpha: true, preserveDrawingBuffer: false});
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
  const licMesh = new THREE.Mesh(faceGeometry(licShape, lw, lh), new THREE.MeshPhysicalMaterial({map: licTex, roughness: .55, clearcoat: .7, clearcoatRoughness: .05, envMapIntensity: .25, toneMapped: false}));
  licMesh.position.z = ld + lb + .0004; plate.add(licMesh);
  card.add(plate);
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
    holo.uniforms.uTime.value = t;
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
    renderer.render(scene, camera);
    if (state.spin?.onFrame) state.spin.onFrame();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  return {
    renderer, scene, camera, card, state,
    update(v) {
      frontTex.needsUpdate = true; backTex.needsUpdate = true; licTex.needsUpdate = true; frontBump.needsUpdate = true; backBump.needsUpdate = true;
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
  if (!v.username) { inlineMessage(message, 'error', 'Add your username first.'); form.elements.username.focus(); return null; }
  if (!v.team) { inlineMessage(message, 'error', 'Choose your team.'); form.elements.team.focus(); return null; }
  if (!v.level) { inlineMessage(message, 'error', 'Choose your crew licence level.'); form.elements.level.focus(); return null; }
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
$('lic-flip').addEventListener('click', () => view?.flip());

// Video: a second renderer at 1080 x 1350 records one full turn of the card.
function videoType() {
  for (const type of ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm']) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(type)) return type;
  }
  return null;
}
function videoBackground(v) {
  const c = document.createElement('canvas'); c.width = 1080; c.height = 1350;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0b0c0f'; ctx.fillRect(0, 0, 1080, 1350);
  const g = ctx.createRadialGradient(540, 620, 0, 540, 620, 820);
  g.addColorStop(0, hexA(v.team.color, .32)); g.addColorStop(1, hexA(v.team.color, 0));
  ctx.fillStyle = g; ctx.fillRect(0, 0, 1080, 1350);
  ctx.textAlign = 'center'; ctx.fillStyle = '#8d8f99'; ctx.font = font(24, 700);
  ctx.fillText('ENHYPEN MAMA GRAND PRIX · SEASON 2026', 540, 1300); ctx.textAlign = 'left';
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
let recording = false;
$('lic-video').addEventListener('click', async () => {
  const v = ready(); if (!v || !view?.renderer || recording) return;
  const type = videoType();
  if (!type) { toast('error', 'Video not supported here', 'This browser cannot record video. Try Safari or Chrome.'); return; }
  recording = true;
  const button = $('lic-video'); const label = button.textContent;
  button.disabled = true; button.textContent = 'Recording…';
  const canvas = document.createElement('canvas'); canvas.width = 1080; canvas.height = 1350;
  canvas.style.cssText = 'position:fixed;left:-99999px;top:0;width:1080px;height:1350px';
  document.body.append(canvas);
  const rec = new THREE.WebGLRenderer({canvas, antialias: true, preserveDrawingBuffer: true});
  rec.setPixelRatio(1); rec.setSize(1080, 1350, false); rec.outputColorSpace = THREE.SRGBColorSpace;
  const cam = new THREE.PerspectiveCamera(30, 1080 / 1350, .1, 100); cam.position.set(0, -.12, 6.6);
  const bg = videoBackground(v);
  const chunks = [];
  const recorder = new MediaRecorder(canvas.captureStream(30), {mimeType: type, videoBitsPerSecond: 8_000_000});
  recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise(resolve => { recorder.onstop = resolve; });
  const draw = () => { view.scene.background = bg; rec.render(view.scene, cam); view.scene.background = null; };
  view.state.spin = {start: performance.now() + 400, duration: 4000, onFrame: draw};
  recorder.start(250);
  await new Promise(r => setTimeout(r, 4800));
  recorder.stop(); await done;
  view.state.spin = null; view.state.ry = view.state.try = view.state.base = -.35 + Math.round((view.state.base + .35) / Math.PI) * Math.PI; view.state.last = performance.now();
  rec.dispose(); canvas.remove(); bg.dispose();
  const ext = type.startsWith('video/mp4') ? 'mp4' : 'webm';
  download(new Blob(chunks, {type: type.split(';')[0]}), `emgp26-certificate-${slug(v)}.${ext}`);
  toast('success', 'Video saved', ext === 'webm' ? 'Saved as WEBM: if Instagram refuses it, record it again from Safari or a recent Chrome.' : 'Find it in your downloads or Photos.');
  button.disabled = false; button.textContent = label; recording = false;
});

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
