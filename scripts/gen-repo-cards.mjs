#!/usr/bin/env node
// gen-repo-cards.mjs
// Renders the account's real repositories as a grid of animated "pin" cards.
// Replaces github-readme-stats pin cards (rate-limited, frequently broken).
//
// Output: assets/repos.svg  (1200 x 620 for a full 2x3 grid; height shrinks if
//         fewer repos are available)
// Node 20+, ESM, zero npm dependencies.

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const USER = process.env.PROFILE_USER || 'Secoolioo';
const TOKEN = process.env.GITHUB_TOKEN || '';
const OUT = process.env.OUT || path.join(process.cwd(), 'assets/repos.svg');

const WIDTH = 1200;

const MARGIN = 20;
const HEADER_Y = 60; // first card row starts here
const CARD_W = 570;
const CARD_H = 176;
const GUTTER = 20; // horizontal: 2*570 + 20 = 1160, centred in 1200 -> margin 20
// Vertical rhythm is derived, not copied from the horizontal gutter: the canvas is
// 620 tall and 60 + 3*176 + 2*20 + 20 would be 648, which clipped the bottom row.
const GUTTER_Y = 14;
const BOTTOM_PAD = 4;
const COLS = 2;
const ROWS = 3;
const MAX_CARDS = COLS * ROWS;

const FULL_HEIGHT = HEADER_Y + ROWS * CARD_H + (ROWS - 1) * GUTTER_Y + BOTTOM_PAD; // 620

const FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace";
const MONO_RATIO = 0.6; // approximate advance width of a mono glyph

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

const LANG_COLORS = {
  Python: '#3572A5',
  Java: '#b07219',
  JavaScript: '#f1e05a',
  TypeScript: '#3178c6',
  HTML: '#e34c26',
  CSS: '#563d7c',
  Shell: '#89e051',
  'C#': '#178600',
  'C++': '#f34b7d',
  C: '#555555',
  Go: '#00ADD8',
  Rust: '#dea584',
  PowerShell: '#012456',
  Batchfile: '#C1F12E',
  Ruby: '#701516',
  PHP: '#4F5D95',
  Kotlin: '#A97BFF',
  Swift: '#F05138',
  Dart: '#00B4AB',
  Lua: '#000080',
  Vue: '#41b883',
  SCSS: '#c6538c',
  Dockerfile: '#384d54',
  Makefile: '#427819',
  Jupyter: '#DA5B0B',
  'Jupyter Notebook': '#DA5B0B',
  Markdown: '#083fa1',
  Vim: '#199f4b',
  'Vim Script': '#199f4b',
  Astro: '#ff5a03',
  Svelte: '#ff3e00',
  Zig: '#ec915c',
  Elixir: '#6e4a7e',
  Haskell: '#5e5086',
  Perl: '#0298c3',
  R: '#198CE7',
  Scala: '#c22d40',
  SQL: '#e38c00',
  TeX: '#3D6117',
  YAML: '#cb171e',
  JSON: '#292929',
  Assembly: '#6E4C13',
  'Objective-C': '#438eff',
};
const LANG_DEFAULT = '#16d67a';

// per-card scan-line durations, deliberately irregular
const SCAN_DUR = [6.1, 7.3, 8.9, 5.7, 9.7, 6.7];
// per-card accent bar pulse durations, also irregular
const BAR_DUR = [3.7, 4.3, 5.1, 4.7, 3.9, 5.9];
// per-card corner bracket pulse durations
const BRACKET_DUR = [4.1, 5.3, 3.8, 6.2, 4.9, 5.5];

const ENTRANCE_CYCLE = 18; // seconds; long hold so the README does not flash
const ENTRANCE_STAGGER = 0.16;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function escapeXml(value, max = 200) {
  const raw = String(value == null ? '' : value);
  const clean = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, max);
  return clean
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// plain number, at most 2 decimals — no expressions ever land in the SVG
function n(value) {
  const r = Math.round(Number(value) * 100) / 100;
  return Number.isFinite(r) ? String(r) : '0';
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// deterministic PRNG so reruns are byte-stable (no Date-based drawing values)
function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(hashString(USER));

// approximate rendered width of a mono string
function textWidth(str, fontSize) {
  return String(str).length * fontSize * MONO_RATIO;
}

function maxChars(pxWidth, fontSize) {
  return Math.max(1, Math.floor(pxWidth / (fontSize * MONO_RATIO)));
}

function truncate(str, limit) {
  const s = String(str == null ? '' : str);
  if (s.length <= limit) return s;
  if (limit <= 1) return s.slice(0, 1);
  return `${s.slice(0, limit - 1)}…`;
}

// wrap onto at most `maxLines` lines of `width` chars; ellipsise the overflow
function wrapText(str, width, maxLines) {
  const words = String(str == null ? '' : str).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let cur = '';
  for (const word of words) {
    const piece = cur ? `${cur} ${word}` : word;
    if (piece.length <= width) {
      cur = piece;
      continue;
    }
    if (cur) lines.push(cur);
    if (lines.length >= maxLines) {
      cur = '';
      break;
    }
    // a single word longer than the line: hard-split it
    let rest = word;
    while (rest.length > width && lines.length < maxLines) {
      lines.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    cur = rest.length > width ? '' : rest;
    if (lines.length >= maxLines) {
      cur = '';
      break;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length > maxLines) lines.length = maxLines;

  // did anything get dropped? then ellipsise the final line
  const kept = lines.join(' ').replace(/\s+/g, ' ').trim();
  const whole = words.join(' ');
  if (kept.length < whole.length && lines.length) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = truncate(`${last} …`, width);
  }
  return lines;
}

function daysAgo(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const diff = Date.now() - t;
  return Math.max(0, Math.floor(diff / 86400000));
}

function agoLabel(iso) {
  const d = daysAgo(iso);
  if (d == null) return 'updated recently';
  if (d === 0) return 'updated today';
  if (d === 1) return 'updated 1 day ago';
  if (d < 365) return `updated ${d} days ago`;
  const y = Math.floor(d / 365);
  return y === 1 ? 'updated 1 year ago' : `updated ${y} years ago`;
}

function langColor(lang) {
  if (!lang) return LANG_DEFAULT;
  return LANG_COLORS[lang] || LANG_DEFAULT;
}

function compactCount(value) {
  const v = Number(value) || 0;
  if (v < 1000) return String(v);
  if (v < 1000000) return `${(v / 1000).toFixed(v < 10000 ? 1 : 0)}k`;
  return `${(v / 1000000).toFixed(1)}M`;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const FALLBACK_REPOS = [
  {
    name: 'dotfiles',
    description: 'Personal shell, editor and terminal configuration, bootstrapped by a single script.',
    language: 'Shell',
    stargazers_count: 24,
    forks_count: 3,
    pushed_at: new Date(Date.now() - 2 * 86400000).toISOString(),
    topics: ['dotfiles', 'zsh', 'neovim'],
  },
  {
    name: 'profile-forge',
    description: 'Dependency-free Node generators that render animated SVG panels for a GitHub profile README.',
    language: 'JavaScript',
    stargazers_count: 18,
    forks_count: 2,
    pushed_at: new Date(Date.now() - 5 * 86400000).toISOString(),
    topics: ['svg', 'readme', 'automation'],
  },
  {
    name: 'pipeline-lab',
    description: 'Small data pipelines and scheduling experiments built on plain Python and SQLite.',
    language: 'Python',
    stargazers_count: 12,
    forks_count: 1,
    pushed_at: new Date(Date.now() - 9 * 86400000).toISOString(),
    topics: ['python', 'etl', 'sqlite'],
  },
  {
    name: 'ts-toolbelt',
    description: 'Typed helpers and runtime guards used across my TypeScript side projects.',
    language: 'TypeScript',
    stargazers_count: 9,
    forks_count: 0,
    pushed_at: new Date(Date.now() - 16 * 86400000).toISOString(),
    topics: ['typescript', 'utilities'],
  },
  {
    name: 'winops-scripts',
    description: 'PowerShell automation for provisioning, inventory and routine Windows maintenance.',
    language: 'PowerShell',
    stargazers_count: 6,
    forks_count: 2,
    pushed_at: new Date(Date.now() - 27 * 86400000).toISOString(),
    topics: ['powershell', 'windows', 'automation'],
  },
  {
    name: 'algo-notes',
    description: null,
    language: 'Java',
    stargazers_count: 4,
    forks_count: 1,
    pushed_at: new Date(Date.now() - 48 * 86400000).toISOString(),
    topics: ['algorithms', 'notes'],
  },
];

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'secoolioo-profile',
        Accept: 'application/vnd.github+json',
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function loadRepos() {
  const url = `https://api.github.com/users/${encodeURIComponent(USER)}/repos?per_page=100&sort=updated`;
  try {
    const data = await fetchJson(url);
    if (!Array.isArray(data) || !data.length) throw new Error('empty repo list');
    const repos = data
      .filter((r) => r && !r.fork && !r.private)
      .map((r) => ({
        name: String(r.name || 'repo'),
        description: r.description == null ? null : String(r.description),
        language: r.language == null ? null : String(r.language),
        stargazers_count: Number(r.stargazers_count) || 0,
        forks_count: Number(r.forks_count) || 0,
        pushed_at: String(r.pushed_at || r.updated_at || ''),
        topics: Array.isArray(r.topics) ? r.topics.map(String) : [],
      }));
    if (!repos.length) throw new Error('no non-fork repos');
    repos.sort((a, b) => {
      if (b.stargazers_count !== a.stargazers_count) {
        return b.stargazers_count - a.stargazers_count;
      }
      return (Date.parse(b.pushed_at) || 0) - (Date.parse(a.pushed_at) || 0);
    });
    return { repos: repos.slice(0, MAX_CARDS), total: repos.length, live: true };
  } catch (err) {
    process.stderr.write(`[fallback] repos for "${USER}": ${err && err.message ? err.message : err}\n`);
    return { repos: FALLBACK_REPOS.slice(0, MAX_CARDS), total: FALLBACK_REPOS.length, live: false };
  }
}

// ---------------------------------------------------------------------------
// Glyphs
// ---------------------------------------------------------------------------

// hand-drawn book / repo glyph, 14x14 local coordinates
function repoGlyph(x, y, color) {
  return [
    `<g transform="translate(${n(x)},${n(y)})" fill="none" stroke="${color}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">`,
    '<path d="M2.2 2.1 C2.2 1.3 2.9 0.9 3.7 0.9 L11.4 0.9 L11.4 10.2 L3.7 10.2 C2.9 10.2 2.2 10.6 2.2 11.4 Z"/>',
    '<path d="M2.2 11.4 C2.2 12.4 3.0 13.0 3.9 13.0 L11.4 13.0 L11.4 10.4"/>',
    '<path d="M4.4 3.4 L9.2 3.4"/>',
    '<path d="M4.4 5.6 L8.1 5.6"/>',
  ].join('') + '</g>';
}

// 5-point star, ~11px tall, drawn around (x, y) as the top-left of its box
function starGlyph(x, y, color) {
  const pts = [];
  const cx = 5.5;
  const cy = 5.4;
  const rOuter = 5.2;
  const rInner = 2.1;
  for (let i = 0; i < 10; i += 1) {
    const r = i % 2 === 0 ? rOuter : rInner;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push(`${n(cx + r * Math.cos(a))},${n(cy + r * Math.sin(a))}`);
  }
  return `<polygon transform="translate(${n(x)},${n(y)})" points="${pts.join(' ')}" fill="${color}" opacity="0.9"/>`;
}

// fork glyph: 3 small circles joined by 2 lines, ~11x12
function forkGlyph(x, y, color) {
  return [
    `<g transform="translate(${n(x)},${n(y)})" stroke="${color}" stroke-width="1.2" fill="none" stroke-linecap="round">`,
    '<path d="M2.6 3.6 L2.6 6.4 C2.6 7.3 3.3 7.8 4.2 7.8 L6.8 7.8 C7.7 7.8 8.4 7.3 8.4 6.4 L8.4 3.6"/>',
    '<path d="M5.5 7.9 L5.5 9.0"/>',
    `<circle cx="2.6" cy="2.3" r="1.5" fill="${color}" stroke="none"/>`,
    `<circle cx="8.4" cy="2.3" r="1.5" fill="${color}" stroke="none"/>`,
    `<circle cx="5.5" cy="10.3" r="1.5" fill="${color}" stroke="none"/>`,
    '</g>',
  ].join('');
}

// ---------------------------------------------------------------------------
// Card renderer
// ---------------------------------------------------------------------------

function renderCard(repo, index, x, y) {
  const accent = langColor(repo.language);
  const parts = [];
  const clipId = `cardclip${index}`;
  const scanId = `scangrad${index}`;

  const padL = 18;
  const padR = 16;
  const innerW = CARD_W - padL - padR;

  // NOTE: the outer <g> carries the position. The inner <g> carries the CSS
  // entrance animation, because a CSS `transform` overrides an SVG transform
  // ATTRIBUTE on the same element — animating the positioned group directly
  // would collapse every card onto the origin.
  parts.push(`<g transform="translate(${n(x)},${n(y)})"><g class="card c${index}">`);

  // ---- panel -------------------------------------------------------------
  parts.push(
    `<rect x="0" y="0" width="${n(CARD_W)}" height="${n(CARD_H)}" rx="10" fill="${C.panel}" stroke="${C.grid}" stroke-width="1"/>`
  );

  // ---- left accent bar (pulsing opacity, per-card rate) -------------------
  parts.push(
    `<rect x="0" y="8" width="3" height="${n(CARD_H - 16)}" rx="1.5" fill="${accent}">` +
      `<animate attributeName="opacity" values="0.95;0.35;0.95" dur="${n(BAR_DUR[index % BAR_DUR.length])}s" ` +
      `begin="-${n(index * 0.63)}s" repeatCount="indefinite" calcMode="spline" ` +
      `keyTimes="0;0.5;1" keySplines="0.4 0 0.2 1;0.4 0 0.2 1"/></rect>`
  );

  // ---- corner bracket (top-right), pulsing -------------------------------
  const bx = CARD_W - 12;
  parts.push(
    `<path d="M${n(bx - 16)} 12 L${n(bx)} 12 L${n(bx)} 28" fill="none" stroke="${C.mid}" ` +
      `stroke-width="1.4" stroke-linecap="round">` +
      `<animate attributeName="opacity" values="0.85;0.2;0.85" dur="${n(BRACKET_DUR[index % BRACKET_DUR.length])}s" ` +
      `begin="-${n(index * 0.41 + 0.2)}s" repeatCount="indefinite"/></path>`
  );

  // ---- repo icon + name --------------------------------------------------
  const iconX = padL;
  const iconY = 24;
  parts.push(repoGlyph(iconX, iconY, C.dim));

  const nameSize = 19;
  const nameX = iconX + 22;
  // name must not run into the corner bracket
  const nameAvail = CARD_W - nameX - 40;
  const nameText = truncate(repo.name, maxChars(nameAvail, nameSize));
  parts.push(
    `<text x="${n(nameX)}" y="${n(iconY + 12)}" font-family="${FONT}" font-size="${n(nameSize)}" ` +
      `font-weight="bold" fill="${C.bright}">${escapeXml(nameText, 80)}</text>`
  );

  // ---- description -------------------------------------------------------
  const topicsAll = (Array.isArray(repo.topics) ? repo.topics : []).slice(0, 3);
  const descSize = 12.5;
  const descLineH = 17;
  // with no chips to fill the middle band, drop the copy so the card does not
  // read as a big empty hole between the title and the footer
  const descY0 = topicsAll.length ? 64 : 80;
  if (repo.description && repo.description.trim()) {
    const lines = wrapText(repo.description.trim(), 62, 2);
    lines.forEach((line, i) => {
      parts.push(
        `<text x="${n(padL)}" y="${n(descY0 + i * descLineH)}" font-family="${FONT}" ` +
          `font-size="${n(descSize)}" fill="${C.mid}" opacity="0.92">${escapeXml(line, 90)}</text>`
      );
    });
  } else {
    parts.push(
      `<text x="${n(padL)}" y="${n(descY0)}" font-family="${FONT}" font-size="${n(descSize)}" ` +
        `fill="${C.dim}" font-style="italic" opacity="0.9">no description</text>`
    );
  }

  // ---- topic chips -------------------------------------------------------
  const chipSize = 10;
  const chipH = 17;
  const chipY = 105;
  const chipPad = 7;
  let chipX = padL;
  for (const topicRaw of topicsAll) {
    const label = truncate(String(topicRaw), 18);
    const w = Math.round(textWidth(label, chipSize) + chipPad * 2);
    if (chipX + w > padL + innerW) break;
    parts.push(
      `<rect x="${n(chipX)}" y="${n(chipY)}" width="${n(w)}" height="${n(chipH)}" rx="3" ` +
        `fill="${C.dim}" fill-opacity="0.14" stroke="${C.dim}" stroke-width="1"/>`
    );
    parts.push(
      `<text x="${n(chipX + chipPad)}" y="${n(chipY + 12)}" font-family="${FONT}" ` +
        `font-size="${n(chipSize)}" fill="${C.bright}">${escapeXml(label, 24)}</text>`
    );
    chipX += w + 8;
  }

  // ---- footer row --------------------------------------------------------
  const footY = 148;
  const footSize = 11;
  const langName = repo.language ? truncate(repo.language, 16) : 'unknown';
  let fx = padL;

  parts.push(`<circle cx="${n(fx + 4.5)}" cy="${n(footY - 3.5)}" r="4.5" fill="${accent}"/>`);
  fx += 9 + 7;
  parts.push(
    `<text x="${n(fx)}" y="${n(footY)}" font-family="${FONT}" font-size="${n(footSize)}" ` +
      `fill="${C.mid}">${escapeXml(langName, 24)}</text>`
  );
  fx += textWidth(langName, footSize) + 20;

  const starText = compactCount(repo.stargazers_count);
  parts.push(starGlyph(fx, footY - 9.5, C.amber));
  fx += 11 + 5;
  parts.push(
    `<text x="${n(fx)}" y="${n(footY)}" font-family="${FONT}" font-size="${n(footSize)}" ` +
      `fill="${C.mid}">${escapeXml(starText, 10)}</text>`
  );
  fx += textWidth(starText, footSize) + 18;

  const forkText = compactCount(repo.forks_count);
  parts.push(forkGlyph(fx, footY - 10.5, C.dim));
  fx += 11 + 5;
  parts.push(
    `<text x="${n(fx)}" y="${n(footY)}" font-family="${FONT}" font-size="${n(footSize)}" ` +
      `fill="${C.mid}">${escapeXml(forkText, 10)}</text>`
  );

  const agoSize = 10.5;
  const ago = agoLabel(repo.pushed_at);
  parts.push(
    `<text x="${n(CARD_W - padR)}" y="${n(footY)}" text-anchor="end" font-family="${FONT}" ` +
      `font-size="${n(agoSize)}" fill="${C.dim}">${escapeXml(ago, 40)}</text>`
  );

  // ---- scan line (clipped to the card) -----------------------------------
  const scanDur = SCAN_DUR[index % SCAN_DUR.length];
  parts.push(
    `<g clip-path="url(#${clipId})">` +
      `<rect x="1" y="0" width="${n(CARD_W - 2)}" height="1" fill="${C.bright}" opacity="0.35">` +
      `<animate attributeName="y" values="0;${n(CARD_H - 1)}" dur="${n(scanDur)}s" ` +
      `begin="-${n((index * 1.37) % scanDur)}s" repeatCount="indefinite"/></rect></g>`
  );

  parts.push('</g></g>');

  const defs =
    `<clipPath id="${clipId}"><rect x="0" y="0" width="${n(CARD_W)}" height="${n(CARD_H)}" rx="10"/></clipPath>`;

  return { body: parts.join(''), defs, scanId };
}

// ---------------------------------------------------------------------------
// SVG assembly
// ---------------------------------------------------------------------------

function buildSvg(repos, totalRepos, live) {
  const count = repos.length;
  const rowsUsed = Math.max(1, Math.ceil(count / COLS));
  const height = HEADER_Y + rowsUsed * CARD_H + (rowsUsed - 1) * GUTTER_Y + BOTTOM_PAD;

  const gridW = COLS * CARD_W + (COLS - 1) * GUTTER;
  const x0 = Math.round((WIDTH - gridW) / 2);

  const defs = [];
  const cards = [];

  for (let i = 0; i < count; i += 1) {
    const row = Math.floor(i / COLS);
    const isLastRow = row === rowsUsed - 1;
    const inRow = isLastRow ? count - row * COLS : COLS;
    // centre a partial final row so there is never an empty hole
    const rowW = inRow * CARD_W + (inRow - 1) * GUTTER;
    const rowX0 = inRow === COLS ? x0 : Math.round((WIDTH - rowW) / 2);
    const col = i - row * COLS;
    const cx = rowX0 + col * (CARD_W + GUTTER);
    const cy = HEADER_Y + row * (CARD_H + GUTTER_Y);
    const card = renderCard(repos[i], i, cx, cy);
    defs.push(card.defs);
    cards.push(card.body);
  }

  const totalStars = repos.reduce((sum, r) => sum + (Number(r.stargazers_count) || 0), 0);

  // ---- header ------------------------------------------------------------
  const headSize = 13;
  const headY = 30;
  const leftLabel = '// REPOSITORIES';
  const rightLabel = `${totalRepos} public / ${totalStars} stars`;

  const header = [
    `<text x="${n(x0)}" y="${n(headY)}" font-family="${FONT}" font-size="${n(headSize)}" ` +
      `fill="${C.dim}" letter-spacing="1.4">${escapeXml(leftLabel, 40)}</text>`,
    `<text x="${n(WIDTH - x0)}" y="${n(headY)}" text-anchor="end" font-family="${FONT}" ` +
      `font-size="${n(headSize)}" fill="${C.dim}" letter-spacing="1.1">${escapeXml(rightLabel, 60)}</text>`,
  ].join('');

  // ---- animated rule under the header ------------------------------------
  const ruleY = 42;
  const ruleW = WIDTH - x0 * 2;
  const rule = [
    `<rect x="${n(x0)}" y="${n(ruleY)}" width="${n(ruleW)}" height="1" fill="${C.grid}"/>`,
    `<rect x="${n(x0)}" y="${n(ruleY - 1)}" width="${n(ruleW)}" height="3" fill="url(#pulseGrad)" opacity="0.9"/>`,
  ].join('');

  const pulseGrad = [
    '<linearGradient id="pulseGrad" x1="0" y1="0" x2="1" y2="0" gradientUnits="objectBoundingBox">',
    `<stop offset="0" stop-color="${C.mid}" stop-opacity="0"/>`,
    `<stop offset="0.5" stop-color="${C.bright}" stop-opacity="0.95"/>`,
    `<stop offset="1" stop-color="${C.mid}" stop-opacity="0"/>`,
    '<animate attributeName="x1" values="-0.45;1;-0.45" dur="7.3s" begin="-2.1s" repeatCount="indefinite"/>',
    '<animate attributeName="x2" values="0;1.45;0" dur="7.3s" begin="-2.1s" repeatCount="indefinite"/>',
    '</linearGradient>',
  ].join('');

  // ---- faint background grid (deterministic, from the seeded PRNG) --------
  const specks = [];
  for (let i = 0; i < 26; i += 1) {
    const sx = Math.round(rand() * (WIDTH - 8)) + 4;
    const sy = Math.round(rand() * (height - 8)) + 4;
    const dur = 3.7 + Math.round(rand() * 60) / 10;
    const delay = Math.round(rand() * 90) / 10;
    specks.push(
      `<rect x="${n(sx)}" y="${n(sy)}" width="1.5" height="1.5" fill="${C.dim}" opacity="0.22">` +
        `<animate attributeName="opacity" values="0.22;0.02;0.22" dur="${n(dur)}s" ` +
        `begin="-${n(delay)}s" repeatCount="indefinite"/></rect>`
    );
  }

  // ---- entrance animation CSS -------------------------------------------
  // A long cycle that plays once at the start and then holds; frame 0 is fully
  // visible because every card carries a negative delay past its own ramp.
  const rampEnd = 0.9 / ENTRANCE_CYCLE; // fraction of the cycle used by the motion
  const holdStart = Math.round(rampEnd * 10000) / 100; // percent
  const css = [
    '<style>',
    '.card{animation-name:cardIn;animation-duration:' + n(ENTRANCE_CYCLE) + 's;',
    'animation-iteration-count:infinite;animation-timing-function:cubic-bezier(.22,.9,.28,1);',
    'animation-fill-mode:both;}',
    '@keyframes cardIn{',
    '0%{opacity:0;transform:translateY(10px);}',
    n(holdStart) + '%{opacity:1;transform:translateY(0);}',
    '100%{opacity:1;transform:translateY(0);}',
    '}',
    // pre-roll each card past its own ramp so a static first frame looks finished
    ...repos.map((_, i) => `.c${i}{animation-delay:-${n(ENTRANCE_CYCLE - 1.4 - i * ENTRANCE_STAGGER)}s;}`),
    '</style>',
  ].join('');

  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const footerNote = live ? `sync ${stamp} UTC` : `cached ${stamp} UTC`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(WIDTH)}" height="${n(height)}" ` +
      `viewBox="0 0 ${n(WIDTH)} ${n(height)}" role="img" aria-label="Pinned repositories">`,
    `<title>${escapeXml(USER, 60)} repositories</title>`,
    `<defs>${pulseGrad}${defs.join('')}</defs>`,
    css,
    `<rect x="0" y="0" width="${n(WIDTH)}" height="${n(height)}" fill="${C.bg}"/>`,
    specks.join(''),
    header,
    rule,
    // the stamp lives in the 18px band between the rule and the first card row,
    // so it can never overlap a card
    `<text x="${n(WIDTH - x0)}" y="55" text-anchor="end" font-family="${FONT}" ` +
      `font-size="9" fill="${C.grid}">${escapeXml(footerNote, 40)}</text>`,
    cards.join(''),
    '</svg>',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { repos, total, live } = await loadRepos();
  const svg = buildSvg(repos, total, live);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, svg, 'utf8');
  process.stdout.write(`wrote ${OUT} (${svg.length} bytes, ${repos.length} cards)\n`);
}

main().catch((err) => {
  process.stderr.write(`[fallback] fatal: ${err && err.message ? err.message : err}\n`);
  try {
    const svg = buildSvg(FALLBACK_REPOS.slice(0, MAX_CARDS), FALLBACK_REPOS.length, false);
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, svg, 'utf8');
    process.stdout.write(`wrote ${OUT} (fallback)\n`);
  } catch (e) {
    process.stderr.write(`[fallback] could not write: ${e && e.message ? e.message : e}\n`);
  }
  process.exit(0);
});
