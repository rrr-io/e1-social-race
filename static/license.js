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
  ctx.strokeStyle = 'rgba(255,255,255,.05)'; ctx.lineWidth = 1.5;
  for (let i = 0; i < 36; i++) { const a = i / 36 * Math.PI * 2; ctx.beginPath(); ctx.moveTo(PW * .85, PH * .3); ctx.lineTo(PW * .85 + Math.cos(a) * 2000, PH * .3 + Math.sin(a) * 2000); ctx.stroke(); }
  // Slot for the lanyard.
  roundRect(ctx, PW / 2 - 75, 26, 150, 22, 11); ctx.fillStyle = '#000'; ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.14)'; ctx.lineWidth = 2; ctx.stroke();
}
function passFoil(ctx) {
  // A still holographic band for the downloaded image (the 3D view has a moving one).
  ctx.save(); ctx.globalCompositeOperation = 'color-dodge'; ctx.globalAlpha = .3;
  const g = ctx.createLinearGradient(0, PH * .15, PW, PH * .6);
  [[.18, 'rgba(0,0,0,0)'], [.3, '#ff4fd855'], [.38, '#ffd76a55'], [.46, '#5dffc255'], [.54, '#55c8ff55'], [.62, '#b07cff55'], [.74, 'rgba(0,0,0,0)']].forEach(([o, col]) => g.addColorStop(o, col));
  ctx.fillStyle = g; ctx.fillRect(0, 0, PW, PH); ctx.restore();
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
function drawPassFront(ctx, v) {
  const c = v.team?.color || '#9a9ca6';
  ctx.save(); passBase(ctx, c);
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = c; ctx.fillRect(56, 98, 44, 6);
  ctx.fillStyle = '#d4d5db'; ctx.font = font(22, 700); spaced(ctx, 'ENHYPEN MAMA GRAND PRIX', 116, 108, 4);
  if (v.team) {
    const tag = v.team.member.toUpperCase();
    ctx.font = `italic ${font(22, 900)}`; const w = ctx.measureText(tag).width + 36;
    roundRect(ctx, PW - 56 - w, 82, w, 40, 20); ctx.fillStyle = c; ctx.fill();
    ctx.fillStyle = '#111'; ctx.fillText(tag, PW - 56 - w + 18, 110);
  }
  ctx.fillStyle = '#9a9ca6'; ctx.font = font(30, 600); spaced(ctx, 'CERTIFICATE OF', 56, 176, 6);
  ctx.fillStyle = '#fff'; ctx.font = font(62, 700); ctx.fillText('PARTICIPATION', 54, 236);
  // Clear sleeve with the crew licence.
  const sx = 48, sy = 278, sw = PW - 96, inner = sw - 36, ih = inner * CH / CW, sh = ih + 36;
  roundRect(ctx, sx, sy, sw, sh, 30);
  const sg = ctx.createLinearGradient(sx, sy, sx + sw, sy + sh); sg.addColorStop(0, 'rgba(255,255,255,.12)'); sg.addColorStop(.4, 'rgba(255,255,255,.03)'); sg.addColorStop(1, 'rgba(255,255,255,.08)');
  ctx.fillStyle = sg; ctx.fill(); ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.lineWidth = 2; ctx.stroke();
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 36; ctx.shadowOffsetY = 16;
  ctx.drawImage(licence, sx + 18, sy + 18, inner, ih); ctx.restore();
  ctx.save(); roundRect(ctx, sx + 18, sy + 18, inner, ih, 22); ctx.clip();
  const gl = ctx.createLinearGradient(sx, sy, sx + sw, sy + sh); gl.addColorStop(.3, 'rgba(255,255,255,0)'); gl.addColorStop(.42, 'rgba(255,255,255,.16)'); gl.addColorStop(.52, 'rgba(255,255,255,0)');
  ctx.fillStyle = gl; ctx.fillRect(sx, sy, sw, sh); ctx.restore();
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
  let bx = PW - 356, seed = [...no].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7) >>> 0;
  ctx.fillStyle = '#e8e8ee';
  while (bx < PW - 60) { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; const w = 2 + (seed % 3) * 2; ctx.fillRect(bx, PH - 124, w, 72); bx += w + 3 + ((seed >>> 8) % 3) * 2; }
  passFoil(ctx); ctx.restore(); passEdge(ctx, c);
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
  AWARDS.forEach(([title, sub, grand], i) => {
    const x = 56, y = 630 + i * 136, bw = PW - 112, bh = 116;
    roundRect(ctx, x, y, bw, bh, 20);
    ctx.fillStyle = grand ? 'rgba(227,180,74,.16)' : 'rgba(255,255,255,.05)'; ctx.fill();
    ctx.strokeStyle = grand ? 'rgba(227,180,74,.6)' : 'rgba(255,255,255,.11)'; ctx.lineWidth = 2; ctx.stroke();
    const cx = x + 62, cy = y + bh / 2;
    ctx.beginPath(); ctx.arc(cx, cy, 34, 0, Math.PI * 2);
    if (grand) { const g = ctx.createLinearGradient(cx - 34, cy - 34, cx + 34, cy + 34); g.addColorStop(0, '#ffe28a'); g.addColorStop(1, '#c9962c'); ctx.fillStyle = g; ctx.fill(); }
    else { ctx.fillStyle = hexA(c, .16); ctx.fill(); ctx.strokeStyle = hexA(c, .6); ctx.stroke(); }
    trophy(ctx, cx, cy + 1, 36, grand ? '#3a2a00' : c);
    ctx.fillStyle = '#fff'; ctx.font = font(30, 700); ctx.fillText(title, x + 124, y + 52);
    ctx.fillStyle = '#a9abb4'; ctx.font = font(20, 700); spaced(ctx, sub, x + 124, y + 84, 3);
  });
  ctx.textAlign = 'center';
  ctx.fillStyle = '#d4d5db'; ctx.font = font(34, 400); ctx.fillText('We crossed the line together.', PW / 2, 1098);
  ctx.fillStyle = '#fff'; ctx.font = font(34, 700); ctx.fillText('Six teams. One ENHYPEN.', PW / 2, 1144);
  ctx.textAlign = 'left';
  passFoil(ctx); ctx.restore(); passEdge(ctx, c);
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
let paintId = 0;
async function paint() {
  const v = values(), id = ++paintId;
  const art = v.level ? await design(v.level) : null;
  if (id !== paintId) return;   // a newer change is already being drawn
  const lctx = licence.getContext('2d');
  lctx.setTransform(SCALE, 0, 0, SCALE, 0, 0); lctx.clearRect(0, 0, CW, CH); drawLicence(lctx, v, art);
  for (const [canvas, draw] of [[front, drawPassFront], [back, drawPassBack]]) {
    const ctx = canvas.getContext('2d');
    ctx.setTransform(PSCALE, 0, 0, PSCALE, 0, 0); ctx.clearRect(0, 0, PW, PH);
    draw(ctx, v);
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
  const renderer = new THREE.WebGLRenderer({antialias: true, alpha: true, preserveDrawingBuffer: false});
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  stage.append(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, .1, 100);
  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(2, 3, 6); scene.add(key);
  const glint = new THREE.PointLight(0xffffff, 6, 12, 1.5); glint.position.set(0, 0, 3); scene.add(glint);

  const W = 1.8, H = W * PH / PW, D = .03, R = W * PRADIUS / PW;
  const shape = roundedShape(W, H, R);
  const card = new THREE.Group(); scene.add(card);
  const sideGeo = new THREE.ExtrudeGeometry(shape, {depth: D, bevelEnabled: false, curveSegments: 12});
  sideGeo.translate(0, 0, -D / 2);
  const edge = new THREE.MeshStandardMaterial({color: 0x3a3d45, metalness: .85, roughness: .3});
  card.add(new THREE.Mesh(sideGeo, [new THREE.MeshBasicMaterial({visible: false}), edge]));

  const tex = canvas => { const t = new THREE.CanvasTexture(canvas); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = renderer.capabilities.getMaxAnisotropy(); return t; };
  const frontTex = tex(front), backTex = tex(back);
  const face = faceGeometry(shape, W, H);
  const frontMesh = new THREE.Mesh(face, new THREE.MeshStandardMaterial({map: frontTex, roughness: .42, metalness: .12}));
  frontMesh.position.z = D / 2 + .0006; card.add(frontMesh);
  const backMesh = new THREE.Mesh(face, new THREE.MeshStandardMaterial({map: backTex, roughness: .5, metalness: .1}));
  backMesh.rotation.y = Math.PI; backMesh.position.z = -D / 2 - .0006; card.add(backMesh);

  // Holographic foil: a rainbow that moves with the viewing angle.
  const holo = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: {uStrength: {value: .35}, uTime: {value: 0}},
    vertexShader: `varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform float uStrength; uniform float uTime; varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      vec3 rainbow(float t){ return .5 + .5 * cos(6.28318 * (t + vec3(0.0, .33, .67))); }
      void main(){
        float f = dot(vN, vV);
        float t = vUv.x * .9 + vUv.y * .45 + (1.0 - f) * 3.2 + vN.x * 1.5 - vN.y * 1.2;
        float band = smoothstep(.0, .6, sin(t * 6.28318 * .8) * .5 + .5);
        float rim = pow(1.0 - f, 1.4);
        float a = uStrength * (.18 + .82 * rim) * (.45 + .55 * band);
        gl_FragColor = vec4(rainbow(t) * a, a);
      }`,
  });
  const holoMesh = new THREE.Mesh(face, holo); holoMesh.position.z = D / 2 + .0012; card.add(holoMesh);

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
    renderer.render(scene, camera);
    if (state.spin?.onFrame) state.spin.onFrame();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  return {
    renderer, scene, camera, card, state,
    update(v) {
      frontTex.needsUpdate = true; backTex.needsUpdate = true;
      // Foil: subtle on the ladder, stronger on prestige levels; light designs need less to stay readable.
      const dark = v.level && INK[code(v.level)][2] === 'dark';
      holo.uniforms.uStrength.value = !v.level ? .25 : (v.level.tier === 'star' ? .55 : v.level.tier === 'flag' ? .4 : .22) * (dark ? 1 : .55);
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
if (!logo.complete) await new Promise(r => { logo.onload = logo.onerror = r; });
try { view = createView(); } catch { view = createFlatView(); }
paint();
