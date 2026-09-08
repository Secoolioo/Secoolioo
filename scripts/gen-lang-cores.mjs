#!/usr/bin/env node
// gen-lang-cores.mjs
// Renders assets/langs.svg -- language distribution as glowing reactor cores / radial gauges.
// Plain ESM, Node 20+, zero npm dependencies.

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

const USER = process.env.PROFILE_USER || 'secoolioo';
const TOKEN = process.env.GITHUB_TOKEN || '';
const OUT = process.env.OUT || path.join(process.cwd(), 'assets/langs.svg');

const API = 'https://api.github.com';
const TIMEOUT_MS = 15000;
const MAX_REPOS_FOR_LANGS = 8;
const MAX_REQUESTS = 12; // hard budget so we never hammer the rate limit
const TOP_N = 6;

const C = {
  bg: '#030806',
  panel: '#06110c',
  grid: '#0d2a1c',
  dim: '#0b7a3f',
  mid: '#16d67a',
  bright: '#4dffa6',
  head: '#ccffe5',
  cyan: '#22d3ee',
  magenta: '#ff2e88',
  amber: '#ffb020'
};

const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace";

// geometry (all maths done here, only plain numbers reach the SVG)
const W = 900;
const H = 340;
const COLS = 3;
const ROWS = 2;
const CELL_W = 280;
const CELL_H = 146;
const GRID_X = Math.round((W - COLS * CELL_W) / 2); // 30
const GRID_Y = 46;
const RING_R = 44;
const RING_SW = 9;
const RING_CY_OFF = 58; // ring centre, relative to cell top
const CIRC = 2 * Math.PI * RING_R; // 276.4601...

const CYCLE_S = 10; // full loop
const FILL_S = 1.5; // fill duration
const FILL_STOP_PCT = (FILL_S / CYCLE_S) * 100; // 15
const STAGGER_S = 0.22;

const GLOW_DURS = [3.7, 4.3, 5.1, 4.9, 6.1, 5.7];
const GLOW_BEGINS = [-1.1, -2.3, -0.7, -3.1, -1.9, -2.7];
const TICK_DURS = [23, 27, 31, 25, 29, 33];

const FALLBACK_LANGS = [
  { name: 'TypeScript', bytes: 412340 },
  { name: 'Python', bytes: 298120 },
  { name: 'JavaScript', bytes: 186900 },
  { name: 'Go', bytes: 97450 },
  { name: 'Shell', bytes: 41220 },
  { name: 'CSS', bytes: 23880 }
];

let requestsLeft = MAX_REQUESTS;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function headers() {
  const h = {
    'User-Agent': 'secoolioo-profile',
    Accept: 'application/vnd.github+json'
  };
  if (TOKEN) h.Authorization = 'Bearer ' + TOKEN;
  return h;
}

function warn(msg) {
  process.stderr.write('[gen-lang-cores] ' + msg + '\n');
}

// remove C0/C1 control characters (they are illegal in XML text nodes)
function stripControlChars(str) {
  let out = '';
  for (const ch of String(str)) {
    const code = ch.codePointAt(0);
    if (code < 32 || code === 127) continue;
    out += ch;
  }
  return out;
}

function escapeXml(value) {
  const raw = value === null || value === undefined ? '' : String(value);
  const cleaned = stripControlChars(raw);
  return cleaned
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function truncate(str, max) {
  const s = String(str || '');
  if (s.length <= max) return s;
  return s.slice(0, Math.max(1, max - 1)) + '.';
}

// round to at most `digits` decimals and drop trailing zeros
function num(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return String(Number(n.toFixed(digits)));
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024 * 1024) return num(n / (1024 * 1024 * 1024), 1) + ' GB';
  if (n >= 1024 * 1024) return num(n / (1024 * 1024), 1) + ' MB';
  if (n >= 1024) return num(n / 1024, 1) + ' KB';
  return n + ' B';
}

// ---------------------------------------------------------------------------
// network
// ---------------------------------------------------------------------------

async function getJson(url) {
  if (requestsLeft <= 0) {
    warn('request budget exhausted, skipping ' + url);
    return null;
  }
  requestsLeft -= 1;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: headers(), signal: controller.signal });
    if (!res.ok) {
      warn('HTTP ' + res.status + ' for ' + url);
      return null;
    }
    return await res.json();
  } catch (err) {
    warn('request failed for ' + url + ': ' + (err && err.message ? err.message : err));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRepos(user) {
  const url = API + '/users/' + encodeURIComponent(user) + '/repos?per_page=100&sort=updated';
  const data = await getJson(url);
  if (!Array.isArray(data)) return [];
  return data.filter((r) => r && typeof r === 'object');
}

function pickTopRepos(repos) {
  const own = repos.filter((r) => !r.fork);
  const pool = own.length > 0 ? own : repos;
  return pool
    .slice()
    .sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0))
    .slice(0, MAX_REPOS_FOR_LANGS);
}

async function sumLanguageBytes(user, repos) {
  const totals = new Map();
  let ok = 0;

  for (const repo of repos) {
    const name = repo && repo.name ? String(repo.name) : '';
    if (!name) continue;
    const url =
      API + '/repos/' + encodeURIComponent(user) + '/' + encodeURIComponent(name) + '/languages';
    const data = await getJson(url);
    if (!data || typeof data !== 'object') continue;
    ok += 1;
    for (const [lang, bytes] of Object.entries(data)) {
      const n = Number(bytes);
      if (!Number.isFinite(n) || n <= 0) continue;
      totals.set(lang, (totals.get(lang) || 0) + n);
    }
  }

  return { totals, ok };
}

// fallback: approximate bytes from the repo.language field weighted by repo size (KB)
function histogramFromRepos(repos) {
  const totals = new Map();
  for (const repo of repos) {
    const lang = repo && repo.language ? String(repo.language) : '';
    if (!lang) continue;
    const kb = Number(repo.size) || 0;
    const bytes = Math.max(1024, kb * 1024);
    totals.set(lang, (totals.get(lang) || 0) + bytes);
  }
  return totals;
}

function toRanked(totals) {
  const entries = [...totals.entries()]
    .map(([name, bytes]) => ({ name, bytes }))
    .filter((e) => e.bytes > 0);
  const grand = entries.reduce((sum, e) => sum + e.bytes, 0);
  if (grand <= 0) return [];
  return entries
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, TOP_N)
    .map((e) => ({ name: e.name, bytes: e.bytes, pct: (e.bytes / grand) * 100 }));
}

async function collectLanguages() {
  let source = 'languages-api';

  const repos = await fetchRepos(USER);
  if (repos.length === 0) {
    warn('no repos available -> using fixed fallback language set');
    return { langs: rankFallback(), source: 'fallback-fixed' };
  }

  const top = pickTopRepos(repos);
  const { totals, ok } = await sumLanguageBytes(USER, top);

  let ranked = toRanked(totals);
  if (ok === 0 || ranked.length === 0) {
    warn('languages endpoint gave nothing (ok=' + ok + ') -> repo.language histogram');
    source = 'repo-language-histogram';
    ranked = toRanked(histogramFromRepos(repos));
  }

  if (ranked.length === 0) {
    warn('histogram empty too -> using fixed fallback language set');
    return { langs: rankFallback(), source: 'fallback-fixed' };
  }

  return { langs: ranked, source };
}

function rankFallback() {
  const totals = new Map(FALLBACK_LANGS.map((l) => [l.name, l.bytes]));
  return toRanked(totals);
}

// ---------------------------------------------------------------------------
// svg building
// ---------------------------------------------------------------------------

function gaugeGeometry(index) {
  const col = index % COLS;
  const row = Math.floor(index / COLS);
  const cellX = GRID_X + col * CELL_W;
  const cellY = GRID_Y + row * CELL_H;
  const cx = cellX + CELL_W / 2;
  const cy = cellY + RING_CY_OFF;
  return { col, row, cellX, cellY, cx, cy };
}

function defsBlock(langs) {
  const frames = [];
  const classes = [];

  langs.forEach((lang, i) => {
    const frac = lang.pct > 0 ? Math.min(1, Math.max(0.02, lang.pct / 100)) : 0;
    const target = CIRC * (1 - frac);
    frames.push(
      '@keyframes fill' +
        i +
        '{' +
        '0%{stroke-dashoffset:' +
        num(CIRC, 2) +
        '}' +
        num(FILL_STOP_PCT, 2) +
        '%{stroke-dashoffset:' +
        num(target, 2) +
        '}' +
        '100%{stroke-dashoffset:' +
        num(target, 2) +
        '}}'
    );
    // negative delay pre-rolls into the long hold, so frame 0 already looks finished
    const delay = -(CYCLE_S - 0.5 - i * STAGGER_S);
    classes.push(
      '.v' +
        i +
        '{animation:fill' +
        i +
        ' ' +
        CYCLE_S +
        's cubic-bezier(.22,.9,.25,1) infinite;animation-delay:' +
        num(delay, 2) +
        's}'
    );
  });

  const css = [
    '.ring{fill:none;stroke-linecap:round}',
    '.t{font-family:' + MONO + '}',
    ...frames,
    ...classes,
    '@keyframes beat{0%{opacity:.35}50%{opacity:1}100%{opacity:.35}}',
    '.beat{animation:beat 3.7s ease-in-out infinite;animation-delay:-1.4s}'
  ].join('');

  return [
    '  <defs>',
    '    <linearGradient id="core" x1="0" y1="0" x2="1" y2="1">',
    '      <stop offset="0%" stop-color="' + C.bright + '"/>',
    '      <stop offset="55%" stop-color="' + C.mid + '"/>',
    '      <stop offset="100%" stop-color="' + C.cyan + '"/>',
    '    </linearGradient>',
    '    <pattern id="dots" width="24" height="28" patternUnits="userSpaceOnUse">',
    '      <circle cx="6" cy="7" r="1" fill="' + C.grid + '"/>',
    '      <circle cx="18" cy="21" r="1" fill="' + C.grid + '"/>',
    '      <path d="M0 14 L24 14" stroke="' + C.grid + '" stroke-width="0.4" opacity="0.35"/>',
    '    </pattern>',
    '    <filter id="soft" x="-75%" y="-75%" width="250%" height="250%">',
    '      <feGaussianBlur stdDeviation="7"/>',
    '    </filter>',
    '    <style><![CDATA[' + css + ']]></style>',
    '  </defs>'
  ].join('\n');
}

function gaugeBlock(lang, i) {
  const g = gaugeGeometry(i);
  const cx = num(g.cx, 2);
  const cy = num(g.cy, 2);
  const pctLabel = Math.round(lang.pct) + '%';
  const nameLabel = truncate(String(lang.name).toUpperCase(), 14);
  const bytesLabel = formatBytes(lang.bytes);

  const glowDur = GLOW_DURS[i % GLOW_DURS.length];
  const glowBegin = GLOW_BEGINS[i % GLOW_BEGINS.length];
  const tickDur = TICK_DURS[i % TICK_DURS.length];
  const tickTo = i % 2 === 0 ? 360 : -360;

  const lines = [];
  lines.push('  <g>');

  // pulsing glow disc
  lines.push(
    '    <circle cx="' +
      cx +
      '" cy="' +
      cy +
      '" r="46" fill="' +
      C.bright +
      '" opacity="0.09" filter="url(#soft)">'
  );
  lines.push(
    '      <animate attributeName="r" values="42;54;42" dur="' +
      glowDur +
      's" begin="' +
      glowBegin +
      's" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.5;1" keySplines="0.4 0 0.6 1;0.4 0 0.6 1"/>'
  );
  lines.push(
    '      <animate attributeName="opacity" values="0.06;0.20;0.06" dur="' +
      glowDur +
      's" begin="' +
      glowBegin +
      's" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.5;1" keySplines="0.4 0 0.6 1;0.4 0 0.6 1"/>'
  );
  lines.push('    </circle>');

  // slow rotating tick ring
  lines.push(
    '    <circle cx="' +
      cx +
      '" cy="' +
      cy +
      '" r="56" fill="none" stroke="' +
      C.grid +
      '" stroke-width="1" stroke-dasharray="2 8" opacity="0.85">'
  );
  lines.push(
    '      <animateTransform attributeName="transform" type="rotate" from="0 ' +
      cx +
      ' ' +
      cy +
      '" to="' +
      tickTo +
      ' ' +
      cx +
      ' ' +
      cy +
      '" dur="' +
      tickDur +
      's" begin="-' +
      num(tickDur / 3 + i, 2) +
      's" repeatCount="indefinite"/>'
  );
  lines.push('    </circle>');

  // inner panel disc
  lines.push(
    '    <circle cx="' + cx + '" cy="' + cy + '" r="36" fill="' + C.panel + '" opacity="0.9"/>'
  );

  // background ring
  lines.push(
    '    <circle class="ring" cx="' +
      cx +
      '" cy="' +
      cy +
      '" r="' +
      RING_R +
      '" stroke="' +
      C.grid +
      '" stroke-width="' +
      RING_SW +
      '"/>'
  );

  // value ring (rotated -90deg so it starts at 12 o'clock)
  lines.push(
    '    <circle class="ring v' +
      i +
      '" cx="' +
      cx +
      '" cy="' +
      cy +
      '" r="' +
      RING_R +
      '" stroke="url(#core)" stroke-width="' +
      RING_SW +
      '" stroke-dasharray="' +
      num(CIRC, 2) +
      '" stroke-dashoffset="' +
      num(CIRC, 2) +
      '" transform="rotate(-90 ' +
      cx +
      ' ' +
      cy +
      ')"/>'
  );

  // labels
  lines.push(
    '    <text class="t" x="' +
      cx +
      '" y="' +
      num(g.cy + 7, 2) +
      '" text-anchor="middle" font-size="20" fill="' +
      C.head +
      '">' +
      escapeXml(pctLabel) +
      '</text>'
  );
  lines.push(
    '    <text class="t" x="' +
      cx +
      '" y="' +
      num(g.cy + 68, 2) +
      '" text-anchor="middle" font-size="12" letter-spacing="1.5" fill="' +
      C.mid +
      '">' +
      escapeXml(nameLabel) +
      '</text>'
  );
  lines.push(
    '    <text class="t" x="' +
      cx +
      '" y="' +
      num(g.cy + 83, 2) +
      '" text-anchor="middle" font-size="10" fill="' +
      C.dim +
      '">' +
      escapeXml(bytesLabel) +
      '</text>'
  );

  lines.push('  </g>');
  return lines.join('\n');
}

function buildSvg(langs, source) {
  const parts = [];

  parts.push(
    '<svg xmlns="http://www.w3.org/2000/svg" width="' +
      W +
      '" height="' +
      H +
      '" viewBox="0 0 ' +
      W +
      ' ' +
      H +
      '" role="img" aria-label="Top languages by bytes">'
  );
  parts.push(defsBlock(langs));

  // background
  parts.push('  <rect x="0" y="0" width="' + W + '" height="' + H + '" fill="' + C.bg + '"/>');
  parts.push(
    '  <rect x="0" y="0" width="' + W + '" height="' + H + '" fill="url(#dots)" opacity="0.55"/>'
  );
  parts.push(
    '  <rect x="8" y="8" width="' +
      (W - 16) +
      '" height="' +
      (H - 16) +
      '" fill="none" stroke="' +
      C.grid +
      '" stroke-width="1" rx="6"/>'
  );

  // header
  parts.push('  <circle class="beat" cx="28" cy="27" r="4" fill="' + C.bright + '"/>');
  parts.push(
    '  <text class="t" x="42" y="31" font-size="13" letter-spacing="1" fill="' +
      C.dim +
      '">' +
      escapeXml('LANG.CORES // by bytes') +
      '</text>'
  );
  parts.push(
    '  <text class="t" x="' +
      (W - 24) +
      '" y="31" text-anchor="end" font-size="11" letter-spacing="1" fill="' +
      C.grid +
      '">' +
      escapeXml('@' + truncate(USER, 20) + ' / ' + source.toUpperCase()) +
      '</text>'
  );
  parts.push(
    '  <path d="M24 40 L' + (W - 24) + ' 40" stroke="' + C.grid + '" stroke-width="1"/>'
  );

  langs.forEach((lang, i) => {
    parts.push(gaugeBlock(lang, i));
  });

  parts.push('</svg>');
  return parts.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  let langs = [];
  let source = 'fallback-fixed';

  try {
    const result = await collectLanguages();
    langs = result.langs;
    source = result.source;
  } catch (err) {
    warn('unexpected error while collecting data: ' + (err && err.message ? err.message : err));
    langs = rankFallback();
    source = 'fallback-fixed';
  }

  if (!Array.isArray(langs) || langs.length === 0) {
    warn('no language data at all -> fixed fallback');
    langs = rankFallback();
    source = 'fallback-fixed';
  }

  // always render exactly TOP_N cells; pad with quiet placeholders if needed
  while (langs.length < TOP_N) {
    langs.push({ name: '---', bytes: 0, pct: 0 });
  }
  langs = langs.slice(0, TOP_N);

  const svg = buildSvg(langs, source);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, svg, 'utf8');

  const summary = langs
    .filter((l) => l.bytes > 0)
    .map((l) => l.name + ' ' + Math.round(l.pct) + '%')
    .join(', ');
  console.log(
    'langs.svg written: ' + OUT + ' (' + svg.length + ' bytes, source=' + source + ') -> ' + summary
  );
}

main().catch((err) => {
  // absolute last resort: still emit a valid SVG and exit 0
  warn('fatal: ' + (err && err.message ? err.message : err));
  try {
    const svg = buildSvg(rankFallback(), 'fallback-fixed');
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, svg, 'utf8');
    console.log('langs.svg written (emergency fallback): ' + OUT);
  } catch (inner) {
    warn('could not write fallback svg: ' + (inner && inner.message ? inner.message : inner));
  }
  process.exit(0);
});
