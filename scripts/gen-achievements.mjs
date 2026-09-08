#!/usr/bin/env node
/**
 * gen-achievements.mjs
 *
 * Generates assets/achievements.svg -- a 1200x260 "service record" ribbon of
 * hex medals for the GitHub profile README. Self hosted replacement for
 * github-profile-trophy + streak-stats.
 *
 * Zero dependencies. Node 20+. Never throws: on any network failure it emits a
 * valid SVG built from fallback data, logs '[fallback] ...' to stderr, exit 0.
 *
 *   node scripts/gen-achievements.mjs
 *
 * env:
 *   GITHUB_TOKEN  optional, enables the GraphQL contribution calendar (streaks)
 *   PROFILE_USER  optional, defaults to 'Secoolioo'
 *   OUT           optional, output path (default <cwd>/assets/achievements.svg)
 */

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

const USER = process.env.PROFILE_USER || 'Secoolioo';
const TOKEN = process.env.GITHUB_TOKEN || '';
const OUT = process.env.OUT || path.join(process.cwd(), 'assets/achievements.svg');
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

// ---------------------------------------------------------------------------
// layout (all maths done here, plain numbers emitted)
// ---------------------------------------------------------------------------

const W = 1200;
const H = 260;

const PAD = 8;
const L = 32; // left content edge
const R = 1168; // right content edge

const HEAD_BASE = 30;
const HEAD_RULE_Y = 45;

const PITCH_MIN = 150; // horizontal distance between medal centres
const PITCH_MAX = 190; // widened when fewer medals, so the row is not lost in space
const HEX_R = 52; // outer hex circumradius
const RING_R = 58; // rotating dashed ring circumradius
const INNER_R = 42.8; // inner hex (~8px perpendicular inset)
const CY = 132; // medal centre line

const ICON_DY = -20; // icon centre relative to CY
const VALUE_DY = 14; // value baseline relative to CY
const LABEL_DY = 65; // label baseline relative to CY

const RULE_Y = 226;
const FOOT_BASE = 244;

// ring dash geometry: perimeter 6*R, split into whole dash periods so the
// stroke-dashoffset animation loops seamlessly.
const RING_PERIM = 6 * RING_R; // 348
const RING_SEGS = 29;
const RING_DASH = RING_PERIM / (2 * RING_SEGS); // 6

// count-up animation
const STEPS = 12;
const CYCLE = 14; // seconds, full loop
const RAMP = 1.5; // seconds spent counting up

const RING_DUR = [9.1, 11.3, 13.7, 10.1, 12.9, 8.7, 14.3];
const CU_DELAY = [-7.0, -7.6, -8.3, -6.4, -9.1, -5.8, -10.2];
const WIRE_DUR = [2.9, 3.7, 4.3, 3.1, 5.1, 3.4];

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

function round(n, d = 2) {
  const f = Math.pow(10, d);
  return Math.round((Number(n) || 0) * f) / f;
}

function escapeXml(s) {
  return String(s == null ? '' : s)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Truncate to maxChars (mono ~0.60em per char) then XML-escape. */
function safeText(s, maxChars) {
  let v = String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  if (v.length > maxChars) v = v.slice(0, Math.max(1, maxChars - 1)) + '…';
  return escapeXml(v);
}

function fmtNum(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v >= 100000) return Math.round(v / 1000) + 'k';
  if (v >= 10000) return (v / 1000).toFixed(0) + 'k';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
  return String(v);
}

/** Deterministic PRNG seeded from the user name (keeps reruns byte-stable). */
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rnd() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = mulberry32(hashStr(USER.toLowerCase()));
// pre-roll a handful so the first values are well mixed
for (let i = 0; i < 8; i++) rnd();

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------

/** Flat-top hexagon: vertices at 0,60,...,300 degrees. */
function hexPoints(cx, cy, r) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i);
    pts.push(round(cx + r * Math.cos(a)) + ',' + round(cy + r * Math.sin(a)));
  }
  return pts.join(' ');
}

function starPoints(ro, ri) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? ro : ri;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push(round(r * Math.cos(a)) + ',' + round(r * Math.sin(a)));
  }
  return pts.join(' ');
}

// ---------------------------------------------------------------------------
// network
// ---------------------------------------------------------------------------

function ghHeaders() {
  return {
    'User-Agent': 'secoolioo-profile',
    Accept: 'application/vnd.github+json',
    ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}),
  };
}

async function getJson(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: ghHeaders(), signal: ac.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    return await res.json();
  } catch (err) {
    process.stderr.write('[fallback] GET failed: ' + (err && err.message) + '\n');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function postGraphql(query, variables) {
  if (!TOKEN) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for graphql');
    const json = await res.json();
    if (json && json.errors && json.errors.length) {
      throw new Error(String(json.errors[0].message || 'graphql error'));
    }
    return json;
  } catch (err) {
    process.stderr.write(
      '[fallback] GraphQL failed: ' + (err && err.message) + '\n'
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// streaks
// ---------------------------------------------------------------------------

/**
 * days: [{date:'YYYY-MM-DD', count:n}] ascending.
 * current = consecutive days with count>0 ending today (today may still be
 * empty, in which case we start from yesterday). longest = longest run > 0.
 */
function computeStreaks(days) {
  let current = 0;
  let longest = 0;
  let run = 0;
  for (let i = 0; i < days.length; i++) {
    if (days[i].count > 0) {
      run++;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  let i = days.length - 1;
  if (i >= 0 && days[i].count === 0) i--; // today not counted yet
  for (; i >= 0; i--) {
    if (days[i].count > 0) current++;
    else break;
  }
  return { current, longest };
}

// ---------------------------------------------------------------------------
// data
// ---------------------------------------------------------------------------

const FALLBACK = {
  createdAt: '2019-04-12',
  repos: 42,
  followers: 57,
  following: 38,
  stars: 128,
  forks: 34,
  languages: 11,
  contributions: 1284,
  current: 12,
  longest: 63,
};

async function collect() {
  const data = {
    user: USER,
    createdAt: FALLBACK.createdAt,
    repos: FALLBACK.repos,
    followers: FALLBACK.followers,
    following: FALLBACK.following,
    stars: FALLBACK.stars,
    forks: FALLBACK.forks,
    languages: FALLBACK.languages,
    contributions: 0,
    current: 0,
    longest: 0,
    hasStreaks: false,
    simulated: false,
    newestPush: '',
    oldestRepo: '',
  };

  const profile = await getJson(API + '/users/' + encodeURIComponent(USER));
  if (profile && typeof profile === 'object' && profile.login) {
    if (typeof profile.created_at === 'string') {
      data.createdAt = profile.created_at.slice(0, 10);
    }
    if (Number.isFinite(profile.public_repos)) data.repos = profile.public_repos;
    if (Number.isFinite(profile.followers)) data.followers = profile.followers;
    if (Number.isFinite(profile.following)) data.following = profile.following;
  } else {
    data.simulated = true;
    process.stderr.write('[fallback] using fallback profile data\n');
  }

  const repos = await getJson(
    API +
      '/users/' +
      encodeURIComponent(USER) +
      '/repos?per_page=100&sort=pushed&type=owner'
  );
  if (Array.isArray(repos) && repos.length) {
    let stars = 0;
    let forks = 0;
    const langs = new Set();
    let newest = '';
    let oldest = '';
    for (const r of repos) {
      if (!r || r.fork === true) continue;
      stars += Number(r.stargazers_count) || 0;
      forks += Number(r.forks_count) || 0;
      if (typeof r.language === 'string' && r.language) langs.add(r.language);
      if (typeof r.pushed_at === 'string') {
        if (!newest || r.pushed_at > newest) newest = r.pushed_at;
      }
      if (typeof r.created_at === 'string') {
        if (!oldest || r.created_at < oldest) oldest = r.created_at;
      }
    }
    data.stars = stars;
    data.forks = forks;
    data.languages = langs.size;
    data.newestPush = newest ? newest.slice(0, 10) : '';
    data.oldestRepo = oldest ? oldest.slice(0, 10) : '';
  } else {
    data.simulated = true;
    process.stderr.write('[fallback] using fallback repo aggregates\n');
  }

  if (TOKEN) {
    const q =
      'query($login:String!){user(login:$login){contributionsCollection{' +
      'contributionCalendar{totalContributions weeks{contributionDays{date contributionCount}}}}}}';
    const res = await postGraphql(q, { login: USER });
    const cal =
      res &&
      res.data &&
      res.data.user &&
      res.data.user.contributionsCollection &&
      res.data.user.contributionsCollection.contributionCalendar;
    if (cal && Array.isArray(cal.weeks)) {
      const days = [];
      for (const wk of cal.weeks) {
        if (!wk || !Array.isArray(wk.contributionDays)) continue;
        for (const d of wk.contributionDays) {
          if (!d || typeof d.date !== 'string') continue;
          days.push({ date: d.date, count: Number(d.contributionCount) || 0 });
        }
      }
      days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      const st = computeStreaks(days);
      data.contributions = Number(cal.totalContributions) || 0;
      data.current = st.current;
      data.longest = st.longest;
      data.hasStreaks = true;
    } else {
      data.contributions = FALLBACK.contributions;
      data.current = FALLBACK.current;
      data.longest = FALLBACK.longest;
      data.hasStreaks = true;
      data.simulated = true;
      process.stderr.write('[fallback] using fallback streak data\n');
    }
  } else {
    process.stderr.write(
      '[fallback] no GITHUB_TOKEN: streak medals omitted, row re-centred\n'
    );
  }

  return data;
}

// ---------------------------------------------------------------------------
// count-up maths
// ---------------------------------------------------------------------------

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function countUpValues(finalValue) {
  const final = Math.max(0, Math.round(Number(finalValue) || 0));
  const last = STEPS - 1;
  const out = [];
  for (let i = 0; i < last; i++) {
    out.push(Math.round(final * easeOutCubic(i / last)));
  }
  out.push(final);
  return out;
}

/** cu0..cu{STEPS-1}: opacity switches, percentages depend only on the index. */
function countUpKeyframes() {
  const last = STEPS - 1;
  const slice = RAMP / last;
  const lines = [];
  for (let i = 0; i < last; i++) {
    const a = round(((i * slice) / CYCLE) * 100, 4);
    const b = round((((i + 1) * slice) / CYCLE) * 100, 4);
    if (i === 0) {
      lines.push('@keyframes cu0{0%{opacity:1}' + b + '%{opacity:0}100%{opacity:0}}');
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
  const start = round(((last * slice) / CYCLE) * 100, 4);
  lines.push(
    '@keyframes cu' + last + '{0%{opacity:0}' + start + '%{opacity:1}100%{opacity:1}}'
  );
  return lines;
}

// ---------------------------------------------------------------------------
// icons (16-ish px, drawn around local 0,0)
// ---------------------------------------------------------------------------

function iconMarkup(kind) {
  const s = 'fill="none" stroke="' + C.bright + '" stroke-width="1.5" ' +
    'stroke-linecap="round" stroke-linejoin="round"';
  switch (kind) {
    case 'star':
      return (
        '<polygon points="' +
        starPoints(7.6, 3.2) +
        '" fill="' +
        C.bright +
        '" opacity="0.92"/>'
      );
    case 'fork':
      return (
        '<g ' + s + '>' +
        '<circle cx="-5.5" cy="-5" r="2.1"/>' +
        '<circle cx="5.5" cy="-5" r="2.1"/>' +
        '<circle cx="0" cy="6" r="2.1"/>' +
        '<path d="M-5.5,-2.9 L-5.5,0.4 L5.5,0.4 L5.5,-2.9"/>' +
        '<path d="M0,0.4 L0,3.9"/>' +
        '</g>'
      );
    case 'book':
      return (
        '<g ' + s + '>' +
        '<path d="M-6.4,-7 L4.4,-7 A2,2 0 0 1 6.4,-5 L6.4,6.2 A2,2 0 0 1 4.4,8.2 ' +
        'L-4.4,8.2 A2,2 0 0 1 -6.4,6.2 Z"/>' +
        '<path d="M-6.4,4.4 L4.4,4.4"/>' +
        '<path d="M-2.6,-7 L-2.6,4.4"/>' +
        '</g>'
      );
    case 'person':
      return (
        '<g ' + s + '>' +
        '<circle cx="0" cy="-3.6" r="3.3"/>' +
        '<path d="M-6.6,7.4 C-6.6,2.6 -3.6,0.6 0,0.6 C3.6,0.6 6.6,2.6 6.6,7.4"/>' +
        '</g>'
      );
    case 'code':
      return (
        '<g ' + s + '>' +
        '<path d="M-3.2,-6.4 L-7.6,0 L-3.2,6.4"/>' +
        '<path d="M3.2,-6.4 L7.6,0 L3.2,6.4"/>' +
        '<path d="M1.3,-6.6 L-1.3,6.6" opacity="0.6"/>' +
        '</g>'
      );
    case 'flame':
      return (
        '<path d="M0,-8 C3.1,-4.4 5.4,-2.4 5.4,1.1 A5.4,5.4 0 0 1 -5.4,1.1 ' +
        'C-5.4,-0.9 -4.2,-2.4 -3.1,-3.6 C-3.1,-1.4 -2.1,-0.4 -1.1,-0.4 ' +
        'C-0.1,-2.4 -1.1,-5.4 0,-8 Z" fill="' + C.bright + '" opacity="0.92"/>'
      );
    case 'calendar':
      return (
        '<g ' + s + '>' +
        '<rect x="-6.6" y="-5" width="13.2" height="12.6" rx="1.6"/>' +
        '<path d="M-6.6,-1.2 L6.6,-1.2"/>' +
        '<path d="M-3.4,-7.4 L-3.4,-3.4"/>' +
        '<path d="M3.4,-7.4 L3.4,-3.4"/>' +
        '<path d="M-3.4,2.4 L-0.6,2.4"/>' +
        '</g>'
      );
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// SVG pieces
// ---------------------------------------------------------------------------

function buildDefs() {
  return `  <defs>
    <filter id="mglow" x="-70%" y="-70%" width="240%" height="240%">
      <feGaussianBlur stdDeviation="2.6" result="b"/>
      <feMerge>
        <feMergeNode in="b"/>
        <feMergeNode in="b"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
    <filter id="iglow" x="-80%" y="-80%" width="260%" height="260%">
      <feGaussianBlur stdDeviation="1.5" result="b"/>
      <feMerge>
        <feMergeNode in="b"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
    <radialGradient id="mcore" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${C.mid}" stop-opacity="0.16"/>
      <stop offset="70%" stop-color="${C.mid}" stop-opacity="0.04"/>
      <stop offset="100%" stop-color="${C.mid}" stop-opacity="0"/>
    </radialGradient>
  </defs>`;
}

function buildStyle() {
  const cu = countUpKeyframes()
    .map((l) => '    ' + l)
    .join('\n');
  const delays = CU_DELAY.map(
    (d, i) => '    .d' + i + ' { animation-delay: ' + d.toFixed(2) + 's; }'
  ).join('\n');
  return `  <style><![CDATA[
    text { font-family: ${MONO}; }
    .cu {
      animation-duration: ${CYCLE}s;
      animation-iteration-count: infinite;
      animation-timing-function: steps(1, end);
      animation-fill-mode: both;
    }
${delays}
${cu}

    @keyframes blip { 0% { opacity: 1 } 46% { opacity: 1 } 47% { opacity: .12 } 100% { opacity: .12 } }
    .blip { animation: blip 2.3s steps(1, end) infinite; }

    @keyframes breathe { 0% { opacity: .38 } 50% { opacity: .78 } 100% { opacity: .38 } }
    .br { animation: breathe 5.3s ease-in-out infinite; }
    .b0 { animation-delay: -0.4s } .b1 { animation-delay: -1.1s }
    .b2 { animation-delay: -1.9s } .b3 { animation-delay: -2.6s }
    .b4 { animation-delay: -3.3s } .b5 { animation-delay: -4.1s }
    .b6 { animation-delay: -4.8s }

    @keyframes flick { 0% { opacity: .74 } 37% { opacity: 1 } 68% { opacity: .62 } 100% { opacity: .74 } }
    .fl { animation: flick 6.7s ease-in-out infinite; }
  ]]></style>`;
}

function buildHeader(data) {
  const since = safeText('member since ' + data.createdAt, 32);
  const left = '// SERVICE RECORD';
  const dotX = 1162;
  return `  <g>
    <text x="${L}" y="${HEAD_BASE}" font-size="12" fill="${C.dim}" letter-spacing="1.6">${escapeXml(
    left
  )}</text>
    <text x="${dotX - 14}" y="${HEAD_BASE}" font-size="12" fill="${C.dim}" letter-spacing="0.8" text-anchor="end">${since}</text>
    <circle class="blip" cx="${dotX}" cy="${HEAD_BASE - 4}" r="3.4" fill="${C.mid}"/>
    <line x1="${L}" y1="${HEAD_RULE_Y}" x2="${R}" y2="${HEAD_RULE_Y}" stroke="${C.grid}" stroke-width="1" opacity="0.85"/>
    <line x1="${L}" y1="${HEAD_RULE_Y}" x2="${L + 96}" y2="${HEAD_RULE_Y}" stroke="${C.mid}" stroke-width="1.4" opacity="0.55"/>
  </g>`;
}

function buildMedal(medal, i, cx) {
  const dur = RING_DUR[i % RING_DUR.length];
  const values = countUpValues(medal.value);
  const cls = 'cu d' + (i % CU_DELAY.length);

  const stack = values
    .map(
      (v, s) =>
        `        <text class="${cls}" style="animation-name:cu${s}" x="${cx}" y="${
          CY + VALUE_DY
        }" font-size="26" fill="${C.head}" text-anchor="middle">${escapeXml(
          fmtNum(v)
        )}</text>`
    )
    .join('\n');

  // deterministic per-medal ring phase so the rings are visibly out of sync
  const phase = round(rnd() * RING_PERIM, 2);

  return `    <g>
      <polygon points="${hexPoints(cx, CY, HEX_R - 2)}" fill="url(#mcore)"/>
      <polygon points="${hexPoints(cx, CY, HEX_R)}" fill="${C.panel}" stroke="${
    C.mid
  }" stroke-width="1.6" stroke-opacity="0.55"/>
      <polygon points="${hexPoints(cx, CY, INNER_R)}" fill="none" stroke="${
    C.grid
  }" stroke-width="1.2"/>
      <polygon class="br b${i % 7}" points="${hexPoints(cx, CY, RING_R)}" fill="none"
        stroke="${C.mid}" stroke-width="1.1"
        stroke-dasharray="${RING_DASH} ${RING_DASH}" stroke-dashoffset="${phase}">
        <animate attributeName="stroke-dashoffset" from="${phase}" to="${round(
    phase + RING_PERIM,
    2
  )}" dur="${dur}s" repeatCount="indefinite"/>
      </polygon>
      <g transform="translate(${cx},${CY + ICON_DY})" filter="url(#iglow)">
${'        ' + iconMarkup(medal.icon)}
      </g>
      <g filter="url(#mglow)">
${stack}
      </g>
      <text x="${cx}" y="${
    CY + LABEL_DY
  }" font-size="10.5" fill="${C.mid}" letter-spacing="2" text-anchor="middle" dx="1">${safeText(
    medal.label,
    16
  )}</text>
    </g>`;
}

function buildWire(i, xa, xb) {
  const dur = WIRE_DUR[i % WIRE_DUR.length];
  return `    <g>
      <line x1="${xa}" y1="${CY}" x2="${xb}" y2="${CY}" stroke="${C.grid}" stroke-width="1.2" stroke-dasharray="3 3"/>
      <circle cx="${xa}" cy="${CY}" r="2.1" fill="${C.bright}">
        <animate attributeName="cx" values="${xa};${xb}" dur="${dur}s" repeatCount="indefinite"/>
        <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.18;0.82;1" dur="${dur}s" repeatCount="indefinite"/>
      </circle>
    </g>`;
}

/** Faint lead-in rail from the panel edge into the first / last medal. */
function buildRail(xa, xb, dir) {
  if (xb - xa < 24) return '';
  const capX = dir < 0 ? xa : xb;
  const tickX = dir < 0 ? round(xa + 14) : round(xb - 14);
  return `    <g opacity="0.7">
      <line x1="${xa}" y1="${CY}" x2="${xb}" y2="${CY}" stroke="${C.grid}" stroke-width="1.2" stroke-dasharray="4 5">
        <animate attributeName="stroke-dashoffset" values="0;${dir < 0 ? -27 : 27}" dur="7.9s" repeatCount="indefinite"/>
      </line>
      <rect x="${round(capX - 2.5)}" y="${CY - 7}" width="5" height="14" fill="none" stroke="${C.dim}" stroke-width="1.1"/>
      <line x1="${tickX}" y1="${CY - 5}" x2="${tickX}" y2="${CY + 5}" stroke="${C.grid}" stroke-width="1.1"/>
    </g>`;
}

function buildFooter(data) {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ') + 'Z';
  const lang = data.newestPush ? 'last push ' + data.newestPush : 'archive nominal';
  const leftTxt = safeText('gen ' + stamp + '  //  ' + lang, 52);
  const sim = data.simulated
    ? `    <text x="${R}" y="${FOOT_BASE}" font-size="9.5" fill="${C.amber}" letter-spacing="1.6" text-anchor="end" opacity="0.9">SIMULATED</text>`
    : `    <text x="${R}" y="${FOOT_BASE}" font-size="9.5" fill="${C.dim}" letter-spacing="1.6" text-anchor="end" opacity="0.75">LIVE DATA</text>`;
  return `  <g>
    <line class="fl" x1="${L}" y1="${RULE_Y}" x2="${R}" y2="${RULE_Y}" stroke="${C.grid}" stroke-width="1.2" stroke-dasharray="6 6">
      <animate attributeName="stroke-dashoffset" values="0;-48" dur="6.3s" repeatCount="indefinite"/>
    </line>
    <text x="${L}" y="${FOOT_BASE}" font-size="9.5" fill="${C.dim}" letter-spacing="1.2" opacity="0.6">${leftTxt}</text>
${sim}
  </g>`;
}

// ---------------------------------------------------------------------------
// assemble
// ---------------------------------------------------------------------------

function medalsFor(data) {
  const list = [
    { label: 'STARS', value: data.stars, icon: 'star' },
    { label: 'FORKS', value: data.forks, icon: 'fork' },
    { label: 'REPOS', value: data.repos, icon: 'book' },
    { label: 'FOLLOWERS', value: data.followers, icon: 'person' },
    { label: 'LANGUAGES', value: data.languages, icon: 'code' },
  ];
  if (data.hasStreaks) {
    list.push({ label: 'CURRENT STREAK', value: data.current, icon: 'flame' });
    list.push({ label: 'LONGEST STREAK', value: data.longest, icon: 'calendar' });
  }
  return list;
}

function buildSvg(data) {
  const medals = medalsFor(data);
  const n = medals.length;
  const pitch = round(
    Math.min(PITCH_MAX, Math.max(PITCH_MIN, (R - L) / Math.max(1, n))),
    2
  );
  const rowW = n * pitch;
  const startCx = round((W - rowW) / 2 + pitch / 2, 2);
  const centres = [];
  for (let i = 0; i < n; i++) centres.push(round(startCx + i * pitch, 2));

  const wires = [];
  for (let i = 0; i < n - 1; i++) {
    wires.push(buildWire(i, round(centres[i] + RING_R + 3), round(centres[i + 1] - RING_R - 3)));
  }
  wires.push(buildRail(L, round(centres[0] - RING_R - 3), -1));
  wires.push(buildRail(round(centres[n - 1] + RING_R + 3), R, 1));

  const medalMarkup = medals.map((m, i) => buildMedal(m, i, centres[i])).join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="GitHub service record for ${escapeXml(
    data.user
  )}">
${buildDefs()}
${buildStyle()}
  <rect x="0" y="0" width="${W}" height="${H}" fill="${C.bg}"/>
  <rect x="${PAD}" y="${PAD}" width="${W - PAD * 2}" height="${
    H - PAD * 2
  }" rx="10" fill="${C.panel}" stroke="${C.grid}" stroke-width="1"/>
${buildHeader(data)}
  <g>
${wires.join('\n')}
  </g>
  <g>
${medalMarkup}
  </g>
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
    data = await collect();
  } catch (err) {
    process.stderr.write('[fallback] collect failed: ' + (err && err.message) + '\n');
    data = {
      user: USER,
      ...FALLBACK,
      hasStreaks: false,
      simulated: true,
      newestPush: '',
      oldestRepo: '',
    };
  }

  let svg;
  try {
    svg = buildSvg(data);
  } catch (err) {
    process.stderr.write('[fallback] render failed: ' + (err && err.message) + '\n');
    svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
      `<rect width="${W}" height="${H}" fill="${C.bg}"/>` +
      `<text x="${W / 2}" y="${H / 2}" font-family="${MONO}" font-size="16" fill="${
        C.amber
      }" text-anchor="middle">// SERVICE RECORD UNAVAILABLE</text></svg>\n`;
  }

  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, svg, 'utf8');
    process.stdout.write('wrote ' + OUT + ' (' + Buffer.byteLength(svg) + ' bytes)\n');
  } catch (err) {
    process.stderr.write('[fallback] write failed: ' + (err && err.message) + '\n');
  }
  process.exit(0);
}

main();
