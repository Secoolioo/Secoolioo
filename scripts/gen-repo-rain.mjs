#!/usr/bin/env node
// gen-repo-rain.mjs
// Matrix digital rain whose glyph columns are built from real GitHub repo names,
// languages and topics. Emits a static, dependency-free, animated SVG for a README.
//
// Output: assets/rain-repos.svg  (1200 x 300)
// Node 20+, ESM, zero npm dependencies.

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const USER = process.env.PROFILE_USER || 'secoolioo';
const TOKEN = process.env.GITHUB_TOKEN || '';
const OUT = process.env.OUT || path.join(process.cwd(), 'assets/rain-repos.svg');

const WIDTH = 1200;
const HEIGHT = 300;

const COLS = 52;
const COL_STEP = 23;
const COL_X0 = 6;

const GLYPH_SIZE = 14;
const LINE_STEP = 18;
const MIN_GLYPHS = 10;
const MAX_GLYPHS = 16;

const NAMED_COLUMNS = 10; // columns that spell a real repo name instead of noise
const FADE = 40; // px of top/bottom bleed

const FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace";

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
  amber: '#ffb020',
};

const KATAKANA = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ'.split('');
const DIGITS = '0123456789'.split('');

const FALLBACK_TOKENS = [
  'MATRIX', 'RUST', 'PYTHON', 'DOCKER', 'K8S', 'NEOVIM', 'LINUX', 'GO', 'TS', 'хофа',
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function escapeXml(value) {
  const raw = String(value == null ? '' : value);
  // strip control characters, then hard-truncate
  const clean = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 120);
  return clean
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// round to at most 2 decimals and emit a plain number (no expressions in the SVG)
function n(value) {
  const r = Math.round(Number(value) * 100) / 100;
  return Number.isFinite(r) ? String(r) : '0';
}

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

function hashString(text) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// mulberry32 — tiny, deterministic PRNG so output is stable across runs
function makeRandom(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(list, random) {
  if (list.length === 0) return '0';
  return list[Math.floor(random() * list.length) % list.length];
}

function hexToRgb(hex) {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

function lerpColor(hexA, hexB, t) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  const k = clamp(t, 0, 1);
  const r = Math.round(a.r + (b.r - a.r) * k);
  const g = Math.round(a.g + (b.g - a.g) * k);
  const bl = Math.round(a.b + (b.b - a.b) * k);
  return '#' + [r, g, bl].map((v) => v.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function fetchRepos(user, token) {
  const url =
    'https://api.github.com/users/' +
    encodeURIComponent(user) +
    '/repos?per_page=100&sort=updated';

  const headers = {
    'User-Agent': 'secoolioo-profile',
    Accept: 'application/vnd.github+json',
    ...(token ? { Authorization: 'Bearer ' + token } : {}),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText);
    const json = await res.json();
    if (!Array.isArray(json)) throw new Error('unexpected payload shape');
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeRepos(raw) {
  const repos = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const name = typeof item.name === 'string' ? item.name.slice(0, 40) : '';
    if (!name) continue;
    repos.push({
      name,
      language: typeof item.language === 'string' ? item.language.slice(0, 24) : '',
      topics: Array.isArray(item.topics)
        ? item.topics.filter((t) => typeof t === 'string').slice(0, 8).map((t) => t.slice(0, 24))
        : [],
      stars: Number.isFinite(item.stargazers_count) ? item.stargazers_count : 0,
    });
  }
  return repos;
}

function fallbackRepos() {
  return FALLBACK_TOKENS.map((token, i) => ({
    name: token,
    language: token,
    topics: [],
    stars: FALLBACK_TOKENS.length - i,
  }));
}

// Token pool: whole short tokens (languages, topics, short repo names) plus
// every character of every repo name, salted with katakana and digits.
function buildPool(repos) {
  const tokens = [];
  const chars = [];

  for (const repo of repos) {
    for (const ch of repo.name) {
      if (ch.trim()) chars.push(ch);
    }
    if (repo.name.length <= 8) tokens.push(repo.name.toUpperCase());
    if (repo.language) tokens.push(repo.language.toUpperCase());
    for (const topic of repo.topics) {
      if (topic.length <= 10) tokens.push(topic.toUpperCase());
    }
  }

  for (const token of FALLBACK_TOKENS) tokens.push(token);

  const uniqueTokens = [...new Set(tokens.filter(Boolean))];
  for (const token of uniqueTokens) {
    for (const ch of token) {
      if (ch.trim()) chars.push(ch);
    }
  }

  const salted = chars.concat(KATAKANA, KATAKANA, DIGITS);
  return { tokens: uniqueTokens, chars: salted };
}

// ---------------------------------------------------------------------------
// Column layout (all geometry resolved in Node)
// ---------------------------------------------------------------------------

function buildColumns(repos, pool, random) {
  // brightest columns spell the most-starred repositories
  const byStars = repos
    .slice()
    .sort((a, b) => b.stars - a.stars || a.name.localeCompare(b.name))
    .map((r) => r.name);

  const namedIndexes = new Set();
  // names cycle if the account has fewer repos than named columns
  const wanted = byStars.length > 0 ? Math.min(NAMED_COLUMNS, COLS) : 0;
  let guard = 0;
  while (namedIndexes.size < wanted && guard < 500) {
    guard++;
    const idx = Math.floor(random() * COLS);
    // keep named columns from clumping together
    if (namedIndexes.has(idx) || namedIndexes.has(idx - 1) || namedIndexes.has(idx + 1)) continue;
    namedIndexes.add(idx);
  }

  const columns = [];
  let nameCursor = 0;

  for (let i = 0; i < COLS; i++) {
    const x = i * COL_STEP + COL_X0;
    const isNamed = namedIndexes.has(i);

    let glyphs = [];
    if (isNamed) {
      const repoName = byStars[nameCursor % byStars.length] || 'MATRIX';
      nameCursor++;
      const nameChars = [...repoName].filter((ch) => ch.trim()).slice(0, MAX_GLYPHS);
      const padCount = Math.max(0, MIN_GLYPHS - nameChars.length);
      for (let p = 0; p < padCount; p++) {
        glyphs.push({ ch: pick(KATAKANA, random), real: false });
      }
      for (const ch of nameChars) {
        glyphs.push({ ch, real: true });
      }
    } else {
      const count = MIN_GLYPHS + Math.floor(random() * (MAX_GLYPHS - MIN_GLYPHS + 1));
      for (let g = 0; g < count; g++) {
        glyphs.push({ ch: pick(pool.chars, random), real: false });
      }
    }

    if (glyphs.length > MAX_GLYPHS) glyphs = glyphs.slice(glyphs.length - MAX_GLYPHS);

    const stackHeight = (glyphs.length - 1) * LINE_STEP;
    const startY = -(stackHeight + 24);
    const endY = HEIGHT + 24;
    const duration = 5 + random() * 9; // 5s .. 14s, irregular
    const delay = -(random() * 12); // negative pre-roll: t=0 is a full field

    columns.push({
      index: i,
      x,
      isNamed,
      glyphs,
      stackHeight,
      startY,
      endY,
      duration,
      delay,
    });
  }

  return columns;
}

function glyphStyle(column, glyphIndex) {
  const last = column.glyphs.length - 1;
  const t = last > 0 ? glyphIndex / last : 1; // 0 = tail, 1 = head (leading edge)
  const isHead = glyphIndex === last;
  const glyph = column.glyphs[glyphIndex];

  if (glyph.real) {
    return {
      fill: C.head,
      opacity: clamp(0.5 + 0.5 * t, 0, 1),
      head: isHead,
    };
  }

  let fill;
  if (isHead) fill = C.head;
  else if (t > 0.86) fill = C.bright;
  else if (t > 0.6) fill = lerpColor(C.mid, C.bright, (t - 0.6) / 0.26);
  else fill = lerpColor(C.dim, C.mid, t / 0.6);

  const opacity = clamp(0.05 + 0.95 * Math.pow(t, 2.1), 0, 1);
  return { fill, opacity, head: isHead };
}

// ---------------------------------------------------------------------------
// SVG assembly
// ---------------------------------------------------------------------------

function buildStyle(columns) {
  const lines = [];

  lines.push('.col{animation-timing-function:linear;animation-iteration-count:infinite}');
  lines.push('.g{font-size:' + GLYPH_SIZE + 'px;text-anchor:middle}');
  lines.push('.hd{filter:url(#glow)}');

  // per-glyph flicker variants (every 5th glyph gets one)
  lines.push('@keyframes fk0{0%,100%{fill-opacity:1}42%{fill-opacity:.14}58%{fill-opacity:.92}}');
  lines.push('@keyframes fk1{0%,100%{fill-opacity:.95}30%{fill-opacity:.2}64%{fill-opacity:1}}');
  lines.push('@keyframes fk2{0%,100%{fill-opacity:1}22%{fill-opacity:.35}70%{fill-opacity:.1}}');
  lines.push('.f0{animation:fk0 3.7s linear infinite}');
  lines.push('.f1{animation:fk1 4.3s linear infinite}');
  lines.push('.f2{animation:fk2 5.1s linear infinite}');
  lines.push('.f3{animation:fk0 6.7s linear infinite}');
  lines.push('.f4{animation:fk1 2.9s linear infinite}');
  lines.push('.f5{animation:fk2 8.3s linear infinite}');

  lines.push('@keyframes pulse{0%,100%{opacity:.45}50%{opacity:.68}}');
  lines.push('.tag{animation:pulse 9.4s ease-in-out infinite}');

  for (const col of columns) {
    lines.push(
      '@keyframes k' +
        col.index +
        '{from{transform:translateY(' +
        n(col.startY) +
        'px)}to{transform:translateY(' +
        n(col.endY) +
        'px)}}'
    );
    lines.push(
      '.c' +
        col.index +
        '{animation-name:k' +
        col.index +
        ';animation-duration:' +
        n(col.duration) +
        's;animation-delay:' +
        n(col.delay) +
        's}'
    );
  }

  return '  <style>\n    ' + lines.join('\n    ') + '\n  </style>';
}

function buildDefs(columns) {
  const parts = [];

  parts.push('  <defs>');
  parts.push(
    '    <filter id="glow" x="-80%" y="-80%" width="260%" height="260%">' +
      '<feGaussianBlur stdDeviation="1.8" result="b"/>' +
      '<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>' +
      '</filter>'
  );
  parts.push(
    '    <linearGradient id="fadeTop" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="' + C.bg + '" stop-opacity="1"/>' +
      '<stop offset="0.55" stop-color="' + C.bg + '" stop-opacity="0.55"/>' +
      '<stop offset="1" stop-color="' + C.bg + '" stop-opacity="0"/>' +
      '</linearGradient>'
  );
  parts.push(
    '    <linearGradient id="fadeBottom" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="' + C.bg + '" stop-opacity="0"/>' +
      '<stop offset="0.45" stop-color="' + C.bg + '" stop-opacity="0.55"/>' +
      '<stop offset="1" stop-color="' + C.bg + '" stop-opacity="1"/>' +
      '</linearGradient>'
  );
  parts.push(
    '    <linearGradient id="vign" x1="0" y1="0" x2="1" y2="0">' +
      '<stop offset="0" stop-color="' + C.bg + '" stop-opacity="0.85"/>' +
      '<stop offset="0.12" stop-color="' + C.bg + '" stop-opacity="0"/>' +
      '<stop offset="0.88" stop-color="' + C.bg + '" stop-opacity="0"/>' +
      '<stop offset="1" stop-color="' + C.bg + '" stop-opacity="0.85"/>' +
      '</linearGradient>'
  );
  parts.push('  </defs>');

  return parts.join('\n');
}

function buildGrid() {
  const lines = [];
  for (let x = 100; x < WIDTH; x += 100) {
    lines.push(
      '    <line x1="' + n(x) + '" y1="0" x2="' + n(x) + '" y2="' + HEIGHT +
        '" stroke="' + C.grid + '" stroke-width="1" opacity="0.35"/>'
    );
  }
  for (let y = 60; y < HEIGHT; y += 60) {
    lines.push(
      '    <line x1="0" y1="' + n(y) + '" x2="' + WIDTH + '" y2="' + n(y) +
        '" stroke="' + C.grid + '" stroke-width="1" opacity="0.22"/>'
    );
  }
  return lines.join('\n');
}

function buildColumnMarkup(columns) {
  const out = [];

  for (const col of columns) {
    out.push('    <g class="col c' + col.index + '">');
    for (let g = 0; g < col.glyphs.length; g++) {
      const style = glyphStyle(col, g);
      const y = g * LINE_STEP;
      const classes = ['g'];
      if (style.head) classes.push('hd');
      if (g % 5 === 0) classes.push('f' + ((col.index + g) % 6));
      out.push(
        '      <text class="' + classes.join(' ') + '" x="' + n(col.x) + '" y="' + n(y) +
          '" fill="' + style.fill + '" opacity="' + n(style.opacity) + '">' +
          escapeXml(col.glyphs[g].ch) +
          '</text>'
      );
    }
    out.push('    </g>');
  }

  return out.join('\n');
}

function buildSvg(columns, user) {
  const label = 'R E P O S I T O R Y   S T R E A M';

  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + WIDTH + '" height="' + HEIGHT +
      '" viewBox="0 0 ' + WIDTH + ' ' + HEIGHT + '" role="img" aria-label="Matrix rain of ' +
      escapeXml(user) + ' repository names" font-family="' + FONT + '">',
    '  <title>' + escapeXml(user) + ' repository stream</title>',
    buildDefs(columns),
    buildStyle(columns),
    '  <rect x="0" y="0" width="' + WIDTH + '" height="' + HEIGHT + '" fill="' + C.bg + '"/>',
    '  <rect x="0" y="0" width="' + WIDTH + '" height="' + HEIGHT + '" fill="' + C.panel +
      '" opacity="0.6"/>',
    '  <g>',
    buildGrid(),
    '  </g>',
    '  <g>',
    buildColumnMarkup(columns),
    '  </g>',
    '  <rect x="0" y="0" width="' + WIDTH + '" height="' + FADE + '" fill="url(#fadeTop)"/>',
    '  <rect x="0" y="' + (HEIGHT - FADE) + '" width="' + WIDTH + '" height="' + FADE +
      '" fill="url(#fadeBottom)"/>',
    '  <rect x="0" y="0" width="' + WIDTH + '" height="' + HEIGHT + '" fill="url(#vign)"/>',
    '  <text class="tag" x="594" y="158" text-anchor="middle" font-size="15" letter-spacing="12" ' +
      'fill="' + C.dim + '" opacity="0.55">' + escapeXml(label) + '</text>',
    '</svg>',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  let repos = [];
  let source = 'github';

  try {
    const raw = await fetchRepos(USER, TOKEN);
    repos = normalizeRepos(raw);
    if (repos.length === 0) throw new Error('no repositories returned');
  } catch (error) {
    source = 'fallback';
    console.error('[rain] repo fetch failed, using fallback token pool: ' + (error && error.message));
    repos = fallbackRepos();
  }

  const random = makeRandom(hashString(USER + '::rain'));
  const pool = buildPool(repos);
  const columns = buildColumns(repos, pool, random);
  const svg = buildSvg(columns, USER);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, svg, 'utf8');

  const namedCount = columns.filter((c) => c.isNamed).length;
  console.log(
    '[rain] ' + OUT + ' written (' + WIDTH + 'x' + HEIGHT + ') source=' + source +
      ' repos=' + repos.length + ' columns=' + columns.length +
      ' named=' + namedCount + ' pool=' + pool.chars.length + ' bytes=' + svg.length
  );
}

main().catch((error) => {
  // last-resort guard: never fail the workflow, never leave a broken image
  console.error('[rain] unexpected failure: ' + (error && error.stack ? error.stack : error));
  try {
    const random = makeRandom(hashString(USER + '::rain'));
    const repos = fallbackRepos();
    const pool = buildPool(repos);
    const columns = buildColumns(repos, pool, random);
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, buildSvg(columns, USER), 'utf8');
    console.log('[rain] ' + OUT + ' written from emergency fallback');
  } catch (writeError) {
    console.error('[rain] could not write fallback svg: ' + (writeError && writeError.message));
  }
  process.exit(0);
});
