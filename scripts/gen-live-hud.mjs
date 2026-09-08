#!/usr/bin/env node
/**
 * gen-live-hud.mjs
 *
 * Generates assets/live.svg -- a 1200x420 "mission control" HUD for the
 * GitHub profile README.
 *
 * Zero dependencies. Node 20+. Never throws: on any network failure it emits
 * a valid, good looking SVG built from fallback data and exits 0.
 *
 *   node scripts/gen-live-hud.mjs
 *
 * env:
 *   GITHUB_TOKEN  optional, enables GraphQL contribution count + higher limits
 *   PROFILE_USER  optional, defaults to 'secoolioo'
 *   OUT           optional, absolute/relative output path
 */

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

const USER = process.env.PROFILE_USER || 'secoolioo';
const TOKEN = process.env.GITHUB_TOKEN || '';
const OUT = process.env.OUT || path.join(process.cwd(), 'assets/live.svg');
const TIMEOUT_MS = 15000;

const API = 'https://api.github.com';

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

const MONO =
  "ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace";

// canvas
const W = 1200;
const H = 420;

// panel
const PANEL_X = 8;
const PANEL_Y = 8;
const PANEL_W = W - 16; // 1184
const PANEL_H = H - 16; // 404

// content gutters
const L = 32; // left content edge
const R = 1168; // right content edge
const CONTENT_W = R - L; // 1136

// header
const HEAD_BASE = 42;
const HEAD_RULE_Y = 54;

// tiles
const TILE_Y = 64;
const TILE_H = 86;
const TILE_GAP = 16;

// section headers
const SEC_BASE = 176;

// language bars (left column)
const BAR_ROW_TOP = 194;
const BAR_ROW_STEP = 32;
const BAR_NAME_X = L;
const BAR_TRACK_X = 160;
const BAR_TRACK_W = 340;
const BAR_TRACK_H = 10;
const BAR_PCT_X = 512;

// right column
const RC_X = 600;
const RC_W = R - RC_X; // 568
const TERM_Y = 188;
const TERM_H = 124;
const TERM_LINE_TOP = 210;
const TERM_LINE_STEP = 21;
const COMMIT_Y = 322;
const COMMIT_H = 44;
const COMMIT_BASE = 348;

// footer
const FOOT_BASE = 382;
const BUS_Y = 396;

// animation timing
const CYCLE = 12; // seconds, shared master loop
const RAMP = 1.6; // seconds, count-up ramp
const STEPS = 14; // stacked <text> elements per stat tile

// ---------------------------------------------------------------------------
// tiny helpers
// ---------------------------------------------------------------------------

/** XML-escape every interpolated string. Always. */
function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Strip control chars, collapse whitespace, hard-truncate, then escape. */
function safeText(value, maxLen) {
  let s = String(value == null ? '' : value);
  s = Array.from(s)
    .map((ch) => {
      const code = ch.codePointAt(0);
      const isControl = code < 32 || (code >= 127 && code <= 159);
      return isControl ? ' ' : ch;
    })
    .join('');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > maxLen) s = s.slice(0, Math.max(0, maxLen - 1)) + '…';
  return escapeXml(s);
}

/** Locale-independent thousands separator. */
function fmtNum(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function round(n, digits = 2) {
  const f = Math.pow(10, digits);
  return Math.round(Number(n) * f) / f;
}

/** Approximate advance width of a monospace glyph. */
function charW(fontSize) {
  return fontSize * 0.6;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

// ---------------------------------------------------------------------------
// network
// ---------------------------------------------------------------------------

function headers() {
  const h = {
    'User-Agent': 'secoolioo-profile',
    Accept: 'application/vnd.github+json',
  };
  if (TOKEN) h.Authorization = 'Bearer ' + TOKEN;
  return h;
}

async function fetchJson(url, init = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      headers: { ...headers(), ...(init.headers || {}) },
      signal: ac.signal,
    });
    if (!res.ok) {
      throw new Error('HTTP ' + res.status + ' ' + res.statusText);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function getUser(user) {
  return fetchJson(API + '/users/' + encodeURIComponent(user));
}

async function getRepos(user) {
  return fetchJson(
    API + '/users/' + encodeURIComponent(user) + '/repos?per_page=100&sort=updated'
  );
}

async function getEvents(user) {
  return fetchJson(
    API + '/users/' + encodeURIComponent(user) + '/events/public?per_page=100'
  );
}

async function getContributions(user) {
  if (!TOKEN) return null;
  const query =
    'query($login:String!){user(login:$login){contributionsCollection{contributionCalendar{totalContributions}}}}';
  const data = await fetchJson(API + '/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { login: user } }),
  });
  const total =
    data &&
    data.data &&
    data.data.user &&
    data.data.user.contributionsCollection &&
    data.data.user.contributionsCollection.contributionCalendar
      ? data.data.user.contributionsCollection.contributionCalendar
          .totalContributions
      : null;
  return typeof total === 'number' ? total : null;
}

// ---------------------------------------------------------------------------
// data assembly
// ---------------------------------------------------------------------------

function fallbackData() {
  return {
    user: USER,
    followers: 128,
    following: 42,
    publicRepos: 37,
    since: '2019-04',
    stars: 412,
    forks: 96,
    languages: [
      { name: 'TypeScript', count: 14 },
      { name: 'JavaScript', count: 9 },
      { name: 'Python', count: 6 },
      { name: 'Go', count: 4 },
      { name: 'Shell', count: 3 },
    ],
    topRepo: { name: 'signal-deck', stars: 128 },
    recent: [
      'signal-deck',
      'matrix-hud',
      'edge-router',
      'dotfiles',
      'notes-engine',
    ],
    pushEvents: 64,
    lastCommit: 'chore: refresh profile telemetry pipeline',
    contributions: null,
    degraded: [],
  };
}

function buildLanguageHistogram(repos) {
  const hist = new Map();
  for (const repo of repos) {
    const lang = repo && repo.language;
    if (!lang) continue;
    hist.set(lang, (hist.get(lang) || 0) + 1);
  }
  return [...hist.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 5);
}

function extractLastCommit(events) {
  for (const ev of events) {
    if (!ev || ev.type !== 'PushEvent') continue;
    const commits = ev.payload && ev.payload.commits;
    if (!Array.isArray(commits) || commits.length === 0) continue;
    const msg = commits[0] && commits[0].message;
    if (!msg) continue;
    return String(msg).split('\n')[0];
  }
  return null;
}

async function collectData() {
  const data = fallbackData();
  data.user = USER;

  // --- profile ---
  try {
    const u = await getUser(USER);
    data.followers = Number(u.followers) || 0;
    data.following = Number(u.following) || 0;
    data.publicRepos = Number(u.public_repos) || 0;
    data.since = String(u.created_at || '').slice(0, 7) || data.since;
  } catch (err) {
    data.degraded.push('users');
    console.error('[fallback] /users/' + USER + ': ' + err.message);
  }

  // --- repos ---
  try {
    const repos = await getRepos(USER);
    if (!Array.isArray(repos)) throw new Error('unexpected repos payload');

    let stars = 0;
    let forks = 0;
    let top = { name: '', stars: -1 };
    for (const repo of repos) {
      stars += Number(repo.stargazers_count) || 0;
      forks += Number(repo.forks_count) || 0;
      const s = Number(repo.stargazers_count) || 0;
      if (s > top.stars) top = { name: String(repo.name || ''), stars: s };
    }
    data.stars = stars;
    data.forks = forks;

    const langs = buildLanguageHistogram(repos);
    if (langs.length > 0) data.languages = langs;

    if (top.stars >= 0 && top.name) data.topRepo = top;

    const recent = repos.slice(0, 5).map((r) => String(r.name || '')).filter(Boolean);
    if (recent.length > 0) data.recent = recent;
  } catch (err) {
    data.degraded.push('repos');
    console.error('[fallback] /users/' + USER + '/repos: ' + err.message);
  }

  // --- events ---
  try {
    const events = await getEvents(USER);
    if (!Array.isArray(events)) throw new Error('unexpected events payload');
    data.pushEvents = events.filter((e) => e && e.type === 'PushEvent').length;
    const msg = extractLastCommit(events);
    if (msg) data.lastCommit = msg;
  } catch (err) {
    data.degraded.push('events');
    console.error('[fallback] /users/' + USER + '/events/public: ' + err.message);
  }

  // --- graphql contributions ---
  try {
    const total = await getContributions(USER);
    data.contributions = total;
    if (total === null && !TOKEN) {
      console.error('[fallback] graphql: no GITHUB_TOKEN, hiding COMMITS/YR tile');
    }
  } catch (err) {
    data.contributions = null;
    data.degraded.push('graphql');
    console.error('[fallback] graphql contributions: ' + err.message);
  }

  return data;
}

// ---------------------------------------------------------------------------
// count-up maths (done in Node, plain numbers emitted into the SVG)
// ---------------------------------------------------------------------------

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * STEPS values: index 0 == 0, index STEPS-1 == final, eased in between.
 */
function countUpValues(finalValue) {
  const final = Math.max(0, Math.round(Number(finalValue) || 0));
  const last = STEPS - 1;
  const out = [];
  for (let i = 0; i < last; i++) {
    const t = i / last;
    out.push(Math.round(final * easeOutCubic(t)));
  }
  out.push(final);
  return out;
}

/**
 * One @keyframes block per step index. The percentages depend only on the
 * index, so all tiles share the same 14 keyframe definitions.
 */
function countUpKeyframes() {
  const last = STEPS - 1;
  const slice = RAMP / last; // seconds each ramp frame is visible
  const lines = [];
  for (let i = 0; i < last; i++) {
    const a = round(((i * slice) / CYCLE) * 100, 4);
    const b = round((((i + 1) * slice) / CYCLE) * 100, 4);
    if (i === 0) {
      lines.push(
        '@keyframes cu' + i + '{0%{opacity:1}' + b + '%{opacity:0}100%{opacity:0}}'
      );
    } else {
      lines.push(
        '@keyframes cu' +
          i +
          '{0%{opacity:0}' +
          a +
          '%{opacity:1}' +
          b +
          '%{opacity:0}100%{opacity:0}}'
      );
    }
  }
  const hold = round((RAMP / CYCLE) * 100, 4);
  lines.push(
    '@keyframes cu' + last + '{0%{opacity:0}' + hold + '%{opacity:1}100%{opacity:1}}'
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// svg pieces
// ---------------------------------------------------------------------------

function buildDefs() {
  return `  <defs>
    <clipPath id="panelClip">
      <rect x="${PANEL_X}" y="${PANEL_Y}" width="${PANEL_W}" height="${PANEL_H}" rx="14"/>
    </clipPath>
    <pattern id="dots" width="18" height="18" patternUnits="userSpaceOnUse">
      <circle cx="1.5" cy="1.5" r="1" fill="${C.grid}"/>
    </pattern>
    <linearGradient id="scanA" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${C.bright}" stop-opacity="0"/>
      <stop offset="0.5" stop-color="${C.bright}" stop-opacity="0.06"/>
      <stop offset="1" stop-color="${C.bright}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="scanB" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${C.cyan}" stop-opacity="0"/>
      <stop offset="0.5" stop-color="${C.cyan}" stop-opacity="0.045"/>
      <stop offset="1" stop-color="${C.cyan}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="barGrad" gradientUnits="userSpaceOnUse" x1="${BAR_TRACK_X}" y1="0" x2="${BAR_TRACK_X + BAR_TRACK_W}" y2="0">
      <stop offset="0" stop-color="${C.bright}"/>
      <stop offset="1" stop-color="${C.cyan}"/>
    </linearGradient>
    <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="3.2" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
    <filter id="glowSoft" x="-80%" y="-80%" width="260%" height="260%">
      <feGaussianBlur stdDeviation="2" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>`;
}

function buildStyle() {
  return `  <style><![CDATA[
    text { font-family: ${MONO}; }
    .cu {
      animation-duration: ${CYCLE}s;
      animation-iteration-count: infinite;
      animation-timing-function: steps(1, end);
      animation-fill-mode: both;
    }
    .d0 { animation-delay: -3.0s; }
    .d1 { animation-delay: -3.4s; }
    .d2 { animation-delay: -3.9s; }
    .d3 { animation-delay: -4.3s; }
    .d4 { animation-delay: -4.8s; }
${countUpKeyframes()
  .split('\n')
  .map((l) => '    ' + l)
  .join('\n')}

    @keyframes pulse { 0% { opacity: 1 } 50% { opacity: .25 } 100% { opacity: 1 } }
    .dot { animation: pulse 1.6s ease-in-out infinite; }

    @keyframes brk { 0% { opacity: .22 } 50% { opacity: .9 } 100% { opacity: .22 } }
    .br { fill: none; stroke: ${C.mid}; stroke-width: 2; animation: brk 3.7s ease-in-out infinite; }
    .br0 { animation-delay: -0.4s; }
    .br1 { animation-delay: -1.3s; }
    .br2 { animation-delay: -2.3s; }
    .br3 { animation-delay: -3.1s; }

    @keyframes sigin {
      0%   { opacity: 0; transform: translateX(-18px) }
      7%   { opacity: 1; transform: translateX(0) }
      100% { opacity: 1; transform: translateX(0) }
    }
    .sig { animation: sigin ${CYCLE}s cubic-bezier(.16,1,.3,1) infinite; }
    .g0 { animation-delay: -7.40s; }
    .g1 { animation-delay: -7.62s; }
    .g2 { animation-delay: -7.84s; }
    .g3 { animation-delay: -8.06s; }
    .g4 { animation-delay: -8.28s; }

    @keyframes blink { 0% { opacity: 1 } 50% { opacity: 1 } 51% { opacity: 0 } 100% { opacity: 0 } }
    .cur { animation: blink 1.1s steps(1, end) infinite; }

    @keyframes flick { 0% { opacity: .55 } 43% { opacity: .8 } 71% { opacity: .45 } 100% { opacity: .55 } }
    .flick { animation: flick 5.1s ease-in-out infinite; }
  ]]></style>`;
}

function buildBackdrop() {
  return `  <rect x="0" y="0" width="${W}" height="${H}" fill="${C.bg}"/>
  <rect x="${PANEL_X}" y="${PANEL_Y}" width="${PANEL_W}" height="${PANEL_H}" rx="14" fill="${C.panel}" stroke="${C.grid}" stroke-width="1"/>
  <g clip-path="url(#panelClip)">
    <rect x="${PANEL_X}" y="${PANEL_Y}" width="${PANEL_W}" height="${PANEL_H}" fill="url(#dots)" opacity="0.6"/>
    <rect x="${PANEL_X}" y="0" width="${PANEL_W}" height="96" fill="url(#scanA)">
      <animateTransform attributeName="transform" type="translate" from="0 -96" to="0 ${H}" dur="7.3s" begin="-3.1s" repeatCount="indefinite"/>
    </rect>
    <rect x="${PANEL_X}" y="0" width="${PANEL_W}" height="52" fill="url(#scanB)">
      <animateTransform attributeName="transform" type="translate" from="0 -52" to="0 ${H}" dur="11.9s" begin="-5.7s" repeatCount="indefinite"/>
    </rect>
  </g>
  <rect x="${PANEL_X + 6}" y="${PANEL_Y + 6}" width="${PANEL_W - 12}" height="${PANEL_H - 12}" rx="10" fill="none" stroke="${C.grid}" stroke-width="1" opacity="0.55"/>
  <g class="br br0"><path d="M 22 46 L 22 22 L 46 22"/></g>
  <g class="br br1"><path d="M ${W - 46} 22 L ${W - 22} 22 L ${W - 22} 46"/></g>
  <g class="br br2"><path d="M ${W - 22} ${H - 46} L ${W - 22} ${H - 22} L ${W - 46} ${H - 22}"/></g>
  <g class="br br3"><path d="M 46 ${H - 22} L 22 ${H - 22} L 22 ${H - 46}"/></g>`;
}

function buildHeader(data, stamp) {
  const title = 'SYS://github.com/' + data.user;
  const dateW = stamp.length * charW(12);
  const pillW = 74;
  const pillX = round(R - dateW - 16 - pillW, 1);
  const pillY = 27;
  const pillH = 21;

  return `  <text x="${L}" y="${HEAD_BASE}" font-size="13" fill="${C.dim}" letter-spacing="0.6">${safeText(
    title,
    54
  )}</text>
  <g>
    <rect x="${pillX}" y="${pillY}" width="${pillW}" height="${pillH}" rx="10.5" fill="#04120b" stroke="${C.grid}"/>
    <circle class="dot" cx="${pillX + 15}" cy="${pillY + pillH / 2}" r="3.6" fill="${C.bright}" filter="url(#glowSoft)"/>
    <text x="${pillX + 26}" y="${pillY + 14.5}" font-size="11" fill="${C.bright}" letter-spacing="1.2">LIVE</text>
  </g>
  <text x="${R}" y="${HEAD_BASE}" font-size="12" fill="${C.dim}" text-anchor="end">${safeText(
    stamp,
    24
  )}</text>
  <line x1="${L}" y1="${HEAD_RULE_Y}" x2="${R}" y2="${HEAD_RULE_Y}" stroke="${C.grid}" stroke-width="1"/>`;
}

function tileDefs(data) {
  const tiles = [
    { label: 'FOLLOWERS', value: data.followers },
    { label: 'REPOS', value: data.publicRepos },
    { label: 'STARS', value: data.stars },
    { label: 'FORKS', value: data.forks },
  ];
  if (typeof data.contributions === 'number') {
    tiles.push({ label: 'COMMITS/YR', value: data.contributions });
  }
  return tiles;
}

function buildTiles(tiles) {
  const n = tiles.length;
  const tileW = round((CONTENT_W - TILE_GAP * (n - 1)) / n, 2);
  const parts = [];

  tiles.forEach((tile, i) => {
    const x = round(L + i * (tileW + TILE_GAP), 2);
    const values = countUpValues(tile.value);
    const numX = round(x + 16, 2);
    const numY = TILE_Y + 66;

    const stack = values
      .map((v, s) => {
        const cls = 'cu d' + (i % 5);
        return `      <text class="${cls}" style="animation-name:cu${s}" x="${numX}" y="${numY}" font-size="40" fill="${C.bright}">${escapeXml(
          fmtNum(v)
        )}</text>`;
      })
      .join('\n');

    parts.push(`    <g>
      <rect x="${x}" y="${TILE_Y}" width="${tileW}" height="${TILE_H}" rx="10" fill="${C.bg}" stroke="${C.grid}"/>
      <rect x="${x}" y="${TILE_Y}" width="3" height="${TILE_H}" rx="1.5" fill="${
      i % 2 === 0 ? C.mid : C.cyan
    }" opacity="0.55"/>
      <text x="${numX}" y="${TILE_Y + 24}" font-size="11" fill="${C.dim}" letter-spacing="1.6">${safeText(
      tile.label,
      18
    )}</text>
      <g filter="url(#glow)">
${stack}
      </g>
    </g>`);
  });

  return `  <g>
${parts.join('\n')}
  </g>`;
}

function buildLangBars(languages) {
  const total = languages.reduce((sum, l) => sum + l.count, 0) || 1;
  const rows = languages.slice(0, 5).map((lang, i) => {
    const top = BAR_ROW_TOP + i * BAR_ROW_STEP;
    const pct = (lang.count / total) * 100;
    const fillW = round(clamp((pct / 100) * BAR_TRACK_W, 4, BAR_TRACK_W), 2);
    const trackY = top + 2;
    const nameY = top + 11;
    // slide the ramp inside the 12s loop; negative begin pre-rolls to the hold
    const begin = round(-(8.2 - i * 0.18), 2);
    const rampEnd = round(1.4 / CYCLE, 5);

    return `    <g>
      <text x="${BAR_NAME_X}" y="${nameY}" font-size="12" fill="${C.mid}">${safeText(
      lang.name,
      15
    )}</text>
      <rect x="${BAR_TRACK_X}" y="${trackY}" width="${BAR_TRACK_W}" height="${BAR_TRACK_H}" rx="5" fill="${C.grid}"/>
      <rect x="${BAR_TRACK_X}" y="${trackY}" width="${fillW}" height="${BAR_TRACK_H}" rx="5" fill="url(#barGrad)">
        <animate attributeName="width" values="0;${fillW};${fillW}" keyTimes="0;${rampEnd};1" calcMode="spline" keySplines="0.16 0.9 0.3 1;0 0 1 1" dur="${CYCLE}s" begin="${begin}s" repeatCount="indefinite"/>
      </rect>
      <text x="${BAR_PCT_X}" y="${nameY}" font-size="11" fill="${C.head}">${escapeXml(
      pct.toFixed(1) + '%'
    )}</text>
    </g>`;
  });

  return `  <g>
    <text x="${L}" y="${SEC_BASE}" font-size="11" fill="${C.dim}" letter-spacing="1.8">// LANGUAGE DISTRIBUTION</text>
${rows.join('\n')}
  </g>`;
}

function buildSignal(data) {
  const names = data.recent.slice(0, 5);
  const lines = names.map((name, i) => {
    const y = TERM_LINE_TOP + i * TERM_LINE_STEP;
    return `    <g class="sig g${i}">
      <text x="${RC_X + 16}" y="${y}" font-size="12" fill="${C.dim}">▸</text>
      <text x="${RC_X + 34}" y="${y}" font-size="12" fill="${C.mid}">${safeText(
      name,
      46
    )}</text>
    </g>`;
  });

  const label = 'last commit:';
  const msgX = round(RC_X + 16 + label.length * charW(11) + 9, 1);
  const msgRaw = String(data.lastCommit || '').split('\n')[0];
  const msg = safeText(msgRaw, 58);
  const msgLen = Math.min(58, msgRaw.replace(/\s+/g, ' ').trim().length);
  const curX = round(msgX + msgLen * charW(12) + 4, 1);

  return `  <g>
    <text x="${RC_X}" y="${SEC_BASE}" font-size="11" fill="${C.dim}" letter-spacing="1.8">// RECENT SIGNAL</text>
    <rect x="${RC_X}" y="${TERM_Y}" width="${RC_W}" height="${TERM_H}" rx="8" fill="${C.bg}" stroke="${C.grid}"/>
    <rect class="flick" x="${RC_X}" y="${TERM_Y}" width="${RC_W}" height="1" fill="${C.mid}" opacity="0.55"/>
${lines.join('\n')}
    <rect x="${RC_X}" y="${COMMIT_Y}" width="${RC_W}" height="${COMMIT_H}" rx="8" fill="${C.bg}" stroke="${C.grid}"/>
    <text x="${RC_X + 16}" y="${COMMIT_BASE}" font-size="11" fill="${C.dim}">${escapeXml(
    label
  )}</text>
    <text x="${msgX}" y="${COMMIT_BASE}" font-size="12" fill="${C.cyan}">${msg}</text>
    <rect class="cur" x="${curX}" y="${COMMIT_BASE - 10}" width="7" height="13" fill="${C.cyan}" opacity="0.9"/>
  </g>`;
}

function buildFooter(data) {
  const topRepo = safeText(data.topRepo.name || '-', 22);
  const foot =
    'PUSH_EVENTS:' +
    fmtNum(data.pushEvents) +
    '   ·   FOLLOWING:' +
    fmtNum(data.following) +
    '   ·   SINCE:' +
    data.since +
    '   ·   TOP_REPO:';

  return `  <g>
    <text x="${L}" y="${FOOT_BASE}" font-size="10" fill="${C.dim}" letter-spacing="0.8">${safeText(
    foot,
    96
  )}<tspan fill="${C.mid}">${topRepo}</tspan><tspan fill="${C.amber}"> ★${escapeXml(
    fmtNum(data.topRepo.stars)
  )}</tspan></text>
    <text x="${R}" y="${FOOT_BASE}" font-size="10" fill="${C.grid}" text-anchor="end" letter-spacing="0.8">${
    data.degraded.length > 0
      ? '<tspan fill="' +
        C.magenta +
        '">DEGRADED:' +
        safeText(data.degraded.join(','), 28) +
        '</tspan>'
      : 'ALL SYSTEMS NOMINAL'
  }</text>
    <line x1="${L}" y1="${BUS_Y}" x2="${R}" y2="${BUS_Y}" stroke="${C.grid}" stroke-width="1"/>
    <line x1="${L}" y1="${BUS_Y}" x2="${R}" y2="${BUS_Y}" stroke="${C.mid}" stroke-width="1.6" stroke-dasharray="2 6 20 6" opacity="0.75">
      <animate attributeName="stroke-dashoffset" from="0" to="-34" dur="1.9s" repeatCount="indefinite"/>
    </line>
    <line x1="${L}" y1="${BUS_Y + 3}" x2="${R}" y2="${BUS_Y + 3}" stroke="${C.cyan}" stroke-width="1" stroke-dasharray="1 11" opacity="0.4">
      <animate attributeName="stroke-dashoffset" from="0" to="-24" dur="4.3s" repeatCount="indefinite"/>
    </line>
  </g>`;
}

// ---------------------------------------------------------------------------
// document
// ---------------------------------------------------------------------------

function buildSvg(data, stamp) {
  const tiles = tileDefs(data);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="GitHub activity HUD">
  <title>${safeText('github.com/' + data.user + ' live HUD', 80)}</title>
${buildDefs()}
${buildStyle()}
${buildBackdrop()}
${buildHeader(data, stamp)}
${buildTiles(tiles)}
${buildLangBars(data.languages)}
${buildSignal(data)}
${buildFooter(data)}
</svg>
`;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  let data;
  try {
    data = await collectData();
  } catch (err) {
    console.error('[fallback] full dataset: ' + err.message);
    data = fallbackData();
    data.degraded.push('all');
  }

  const stamp = new Date().toISOString().slice(0, 16) + 'Z';

  let svg;
  try {
    svg = buildSvg(data, stamp);
  } catch (err) {
    console.error('[fallback] render failed, using static fallback: ' + err.message);
    const fb = fallbackData();
    fb.degraded.push('render');
    svg = buildSvg(fb, stamp);
  }

  const outPath = path.resolve(OUT);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, svg, 'utf8');

  const tileCount = tileDefs(data).length;
  console.log(
    `live.svg written -> ${outPath} (${svg.length}b, ${tileCount} tiles, ` +
      `${data.languages.length} langs, stars=${data.stars}, forks=${data.forks}, ` +
      `contrib=${data.contributions === null ? 'n/a' : data.contributions}, ` +
      `degraded=${data.degraded.length ? data.degraded.join(',') : 'none'})`
  );
}

main().catch((err) => {
  // absolute last resort: still emit something valid, still exit 0
  console.error('[fallback] fatal: ' + (err && err.message));
  try {
    const outPath = path.resolve(OUT);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(
      outPath,
      buildSvg(fallbackData(), new Date().toISOString().slice(0, 16) + 'Z'),
      'utf8'
    );
    console.log('live.svg written -> ' + outPath + ' (static fallback)');
  } catch (inner) {
    console.error('[fallback] could not write output: ' + (inner && inner.message));
  }
  process.exit(0);
});
