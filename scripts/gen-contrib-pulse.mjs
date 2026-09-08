#!/usr/bin/env node
/**
 * gen-contrib-pulse.mjs
 * ---------------------
 * Renders the GitHub contribution calendar of PROFILE_USER as a medical
 * EKG / oscilloscope trace ("the heartbeat of the account") into an
 * animated, dependency-free SVG suitable for embedding via <img> in a
 * GitHub README.
 *
 * Output: assets/pulse.svg  (1200 x 240)
 *
 * Zero npm dependencies. Node 20+. Never throws: on any network/parse
 * failure it falls back to a deterministic synthetic series and still
 * writes a valid SVG (exit code 0).
 */

import fs from 'node:fs';
import path from 'node:path';

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

const USER = process.env.PROFILE_USER || 'secoolioo';
const TOKEN = process.env.GITHUB_TOKEN || '';
const OUT_PATH = process.env.OUT || path.join(process.cwd(), 'assets/pulse.svg');

const NET_TIMEOUT_MS = 15000;
const DAYS = 365;

/* Canvas geometry -------------------------------------------------- */

const W = 1200;
const H = 240;

const PANEL_X = 16;
const PANEL_Y = 12;
const PANEL_W = W - 2 * PANEL_X;
const PANEL_H = 216;

const GX0 = 60;   // graph area left
const GX1 = 1160; // graph area right
const GY0 = 40;   // graph area top
const GY1 = 190;  // graph area bottom

const BASE = GY1 - 6;      // EKG baseline (184)
const TOP = GY0 + 8;       // highest a spike may reach (48)
const AMP = BASE - TOP;    // 136 px of usable amplitude
const MIN_AMP = 7;         // a single contribution still shows a blip
const SLOT = (GX1 - GX0) / DAYS;

/* Animation timing (irregular on purpose, nothing in lockstep) ------ */

const CYCLE = 11.3;                                 // full loop
const DRAW = 6.5;                                   // draw-on duration
const DRAW_F = round4(DRAW / CYCLE);                // 0.5752
const HOLD_F = round4(Math.min(DRAW_F + 0.12, 0.99));
const PREROLL = '-8.4s';                            // frame 0 = finished trace

/* Palette ---------------------------------------------------------- */

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

const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace";
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function round4(v) {
  return Math.round(v * 10000) / 10000;
}

/** Format a number for SVG output: max 2 decimals, no trailing zeros. */
function num(v) {
  if (!Number.isFinite(v)) return '0';
  const r = Math.round(v * 100) / 100;
  return String(r);
}

/** Strip control characters and hard-truncate. */
function clean(value, maxLen = 64) {
  let s = value === null || value === undefined ? '' : String(value);
  s = Array.from(s)
    .map((ch) => {
      const code = ch.charCodeAt(0);
      const isControl = code < 32 || code === 127 || (code >= 128 && code <= 159);
      return isControl ? ' ' : ch;
    })
    .join('');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > maxLen) s = s.slice(0, maxLen - 1) + '…';
  return s;
}

/** XML-escape every interpolated string. */
function escapeXml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Escaped + cleaned in one step. */
function txt(value, maxLen = 64) {
  return escapeXml(clean(value, maxLen));
}

/** Deterministic PRNG so the fallback image is stable between runs. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isoDay(dateObj) {
  return dateObj.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ *
 * Data acquisition
 * ------------------------------------------------------------------ */

const GRAPHQL_QUERY = `query($login:String!){
  user(login:$login){
    contributionsCollection{
      contributionCalendar{
        totalContributions
        weeks{ contributionDays{ date contributionCount } }
      }
    }
  }
}`;

/**
 * Fetch the real contribution calendar. Returns an array of
 * { date, count } or null on any problem.
 */
async function fetchCalendar(login, token) {
  if (!token) {
    console.error('[pulse] no GITHUB_TOKEN -> GraphQL unavailable, using synthetic series');
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NET_TIMEOUT_MS);

  try {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'User-Agent': 'secoolioo-profile',
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
      },
      body: JSON.stringify({ query: GRAPHQL_QUERY, variables: { login } }),
    });

    if (!res.ok) {
      console.error('[pulse] GraphQL HTTP ' + res.status + ' -> falling back');
      return null;
    }

    const json = await res.json();
    if (json && json.errors && json.errors.length) {
      console.error('[pulse] GraphQL error: ' + clean(json.errors[0].message, 120));
      return null;
    }

    const cal =
      json &&
      json.data &&
      json.data.user &&
      json.data.user.contributionsCollection &&
      json.data.user.contributionsCollection.contributionCalendar;

    if (!cal || !Array.isArray(cal.weeks)) {
      console.error('[pulse] unexpected GraphQL shape -> falling back');
      return null;
    }

    const days = [];
    for (const week of cal.weeks) {
      if (!week || !Array.isArray(week.contributionDays)) continue;
      for (const day of week.contributionDays) {
        if (!day || typeof day.date !== 'string') continue;
        const count = Number(day.contributionCount);
        days.push({ date: day.date.slice(0, 10), count: Number.isFinite(count) ? count : 0 });
      }
    }

    if (days.length < 30) {
      console.error('[pulse] too few days returned (' + days.length + ') -> falling back');
      return null;
    }

    return days.slice(-DAYS);
  } catch (err) {
    console.error('[pulse] fetch failed: ' + clean(err && err.message ? err.message : err, 120));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Plausible 365-day series: weekday-heavy, weekend-light, a few
 * streak bursts, plenty of quiet days.
 */
function synthesizeCalendar() {
  const random = mulberry32(0x5ec001 ^ DAYS);
  const today = new Date();
  const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const dayMs = 86400000;

  // Pick three burst windows spread over the year.
  const bursts = [];
  for (let b = 0; b < 3; b++) {
    const start = Math.floor(random() * (DAYS - 30)) + 10;
    const len = 5 + Math.floor(random() * 10);
    bursts.push({ start, end: start + len });
  }

  const days = [];
  for (let i = 0; i < DAYS; i++) {
    const stamp = end - (DAYS - 1 - i) * dayMs;
    const d = new Date(stamp);
    const weekday = d.getUTCDay(); // 0 = Sunday
    const weekend = weekday === 0 || weekday === 6;

    let count;
    if (weekend) {
      count = random() < 0.74 ? 0 : 1 + Math.floor(random() * 3);
    } else {
      count = random() < 0.38 ? 0 : 1 + Math.floor(random() * 7);
    }

    for (const burst of bursts) {
      if (i >= burst.start && i < burst.end) {
        count += 8 + Math.floor(random() * 18);
        break;
      }
    }

    // Rare monster day.
    if (random() < 0.012) count += 20 + Math.floor(random() * 25);

    days.push({ date: isoDay(d), count });
  }

  return days;
}

/** Pad / trim to exactly DAYS entries, oldest first. */
function normalizeSeries(days) {
  const out = days.slice(-DAYS);
  if (out.length === DAYS) return out;

  const dayMs = 86400000;
  const firstStamp = Date.parse(out.length ? out[0].date + 'T00:00:00Z' : isoDay(new Date()) + 'T00:00:00Z');
  const missing = DAYS - out.length;
  const pad = [];
  for (let i = missing; i > 0; i--) {
    pad.push({ date: isoDay(new Date(firstStamp - i * dayMs)), count: 0 });
  }
  return pad.concat(out);
}

/* ------------------------------------------------------------------ *
 * Geometry / trace construction
 * ------------------------------------------------------------------ */

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

/**
 * Spike amplitude for one day. The gamma (> 1) keeps ordinary days as
 * small blips so the busy days still read as distinct beats instead of
 * merging into one solid wall.
 */
function spikeHeight(count, cap) {
  const ratio = Math.min(count, cap) / cap;
  const shaped = Math.pow(ratio, 1.55);
  return MIN_AMP + shaped * (AMP - MIN_AMP);
}

/**
 * Turn the daily counts into an EKG polyline.
 * Zero days emit a flat baseline segment; active days emit a
 * Q-dip / R-spike / S-undershoot complex whose height scales with the count.
 */
function buildTrace(days, cap) {
  const points = [[GX0, BASE]];

  const push = (x, y) => {
    const last = points[points.length - 1];
    if (Math.abs(last[0] - x) < 0.001 && Math.abs(last[1] - y) < 0.001) return;
    points.push([x, y]);
  };

  for (let i = 0; i < days.length; i++) {
    const x0 = GX0 + i * SLOT;
    const count = days[i].count;

    if (count <= 0) {
      push(x0 + SLOT, BASE);
      continue;
    }

    const h = spikeHeight(count, cap);
    const dip = Math.min(h * 0.07, 5);
    const under = Math.min(h * 0.05, 4);

    push(x0 + SLOT * 0.36, BASE);
    push(x0 + SLOT * 0.44, BASE + dip);
    push(x0 + SLOT * 0.50, BASE - h);
    push(x0 + SLOT * 0.57, BASE + under);
    push(x0 + SLOT * 0.66, BASE);
    push(x0 + SLOT, BASE);
  }

  push(GX1, BASE);
  return points;
}

function pointsToPath(points) {
  const parts = ['M ' + num(points[0][0]) + ' ' + num(points[0][1]) + ' L'];
  for (let i = 1; i < points.length; i++) {
    parts.push(num(points[i][0]) + ' ' + num(points[i][1]));
  }
  return parts.join(' ');
}

function cumulativeLengths(points) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    const dx = points[i][0] - points[i - 1][0];
    const dy = points[i][1] - points[i - 1][1];
    cum.push(cum[i - 1] + Math.hypot(dx, dy));
  }
  return cum;
}

/** x coordinate of the point that sits `target` px along the polyline. */
function xAtLength(points, cum, target) {
  const last = cum.length - 1;
  if (target <= 0) return points[0][0];
  if (target >= cum[last]) return points[last][0];

  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= target) lo = mid;
    else hi = mid;
  }
  const span = cum[hi] - cum[lo];
  const t = span > 0 ? (target - cum[lo]) / span : 0;
  return points[lo][0] + (points[hi][0] - points[lo][0]) * t;
}

/** Sample x at N evenly spaced arc-length fractions (for the sweep line). */
function sampleSweepXs(points, cum, samples) {
  const total = cum[cum.length - 1];
  const xs = [];
  for (let i = 0; i < samples; i++) {
    xs.push(xAtLength(points, cum, (i / (samples - 1)) * total));
  }
  return xs;
}

/** Month boundaries inside the window, for grid separators + labels. */
function monthTicks(days) {
  const ticks = [];
  for (let i = 1; i < days.length; i++) {
    const date = days[i].date;
    if (date.slice(8, 10) !== '01') continue;
    const monthIdx = parseInt(date.slice(5, 7), 10) - 1;
    if (monthIdx < 0 || monthIdx > 11) continue;
    const x = GX0 + i * SLOT;
    if (x < GX0 + 12 || x > GX1 - 12) continue;
    ticks.push({ x, label: MONTHS[monthIdx] });
  }
  return ticks;
}

function peakIndex(days) {
  let best = 0;
  for (let i = 1; i < days.length; i++) {
    if (days[i].count > days[best].count) best = i;
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * SVG assembly
 * ------------------------------------------------------------------ */

function buildDefs(traceLength) {
  return [
    '<defs>',
    '<filter id="glow" x="-25%" y="-60%" width="150%" height="220%">',
    '<feGaussianBlur stdDeviation="2.2" result="b"/>',
    '<feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>',
    '</filter>',
    '<filter id="dotGlow" x="-300%" y="-300%" width="700%" height="700%">',
    '<feGaussianBlur stdDeviation="3.4" result="b"/>',
    '<feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>',
    '</filter>',
    '<linearGradient id="areaFill" gradientUnits="userSpaceOnUse" x1="0" y1="' + num(TOP) + '" x2="0" y2="' + num(GY1) + '">',
    '<stop offset="0" stop-color="' + C.mid + '" stop-opacity="0.22"/>',
    '<stop offset="1" stop-color="' + C.mid + '" stop-opacity="0"/>',
    '</linearGradient>',
    '<clipPath id="graphClip">',
    '<rect x="' + num(GX0) + '" y="' + num(GY0) + '" width="' + num(GX1 - GX0) + '" height="' + num(GY1 - GY0) + '"/>',
    '</clipPath>',
    '<!-- trace length ' + num(traceLength) + ' px -->',
    '</defs>',
  ].join('');
}

function buildGrid(ticks) {
  const out = [];
  out.push('<g opacity="0.9">');
  out.push('<animate attributeName="opacity" values="0.78;1;0.86;0.78" keyTimes="0;0.35;0.7;1" dur="5.1s" begin="-2.3s" repeatCount="indefinite"/>');

  for (let y = GY0; y <= GY1; y += 30) {
    out.push('<line x1="' + num(GX0) + '" y1="' + num(y) + '" x2="' + num(GX1) + '" y2="' + num(y) +
      '" stroke="' + C.grid + '" stroke-width="1"/>');
  }

  for (const tick of ticks) {
    out.push('<line x1="' + num(tick.x) + '" y1="' + num(GY0) + '" x2="' + num(tick.x) + '" y2="' + num(GY1) +
      '" stroke="' + C.grid + '" stroke-width="1"/>');
    out.push('<text x="' + num(tick.x + 4) + '" y="' + num(GY1 + 13) + '" font-family="' + MONO +
      '" font-size="10" fill="' + C.dim + '">' + txt(tick.label, 3) + '</text>');
  }

  out.push('<line x1="' + num(GX0) + '" y1="' + num(BASE) + '" x2="' + num(GX1) + '" y2="' + num(BASE) +
    '" stroke="' + C.dim + '" stroke-width="1" stroke-opacity="0.35"/>');
  out.push('</g>');
  return out.join('');
}

function buildTraceLayers(tracePath, areaPath, traceLength) {
  const len = num(traceLength);
  const out = [];

  // Faint static ghost so the panel never looks empty.
  out.push('<path d="' + tracePath + '" fill="none" stroke="' + C.dim +
    '" stroke-width="1" stroke-opacity="0.16" stroke-linejoin="round"/>');

  // Area fill, fades in once the draw-on has finished.
  out.push('<path d="' + areaPath + '" fill="url(#areaFill)" stroke="none" opacity="0">');
  out.push('<animate attributeName="opacity" values="0;0;1;1" keyTimes="0;' + DRAW_F + ';' + HOLD_F +
    ';1" dur="' + CYCLE + 's" begin="' + PREROLL + '" repeatCount="indefinite"/>');
  out.push('</path>');

  // The trace itself, drawn on by animating stroke-dashoffset.
  out.push('<path id="trace" d="' + tracePath + '" fill="none" stroke="' + C.bright +
    '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" filter="url(#glow)" stroke-dasharray="' +
    len + ' ' + len + '" stroke-dashoffset="' + len + '">');
  out.push('<animate attributeName="stroke-dashoffset" values="' + len + ';0;0" keyTimes="0;' + DRAW_F +
    ';1" dur="' + CYCLE + 's" begin="' + PREROLL + '" calcMode="linear" repeatCount="indefinite"/>');
  out.push('</path>');

  return out.join('');
}

function buildScanner(sweepXs) {
  const out = [];
  const samples = sweepXs.length;

  // Vertical sweep line, arc-length matched to the scanner dot.
  const values = [];
  const keyTimes = [];
  for (let i = 0; i < samples; i++) {
    values.push(num(sweepXs[i] - GX0) + ' 0');
    keyTimes.push(round4((i / (samples - 1)) * DRAW_F));
  }
  values.push(num(sweepXs[samples - 1] - GX0) + ' 0');
  keyTimes.push(1);

  out.push('<g opacity="0.55">');
  out.push('<animate attributeName="opacity" values="0.55;0.55;0.12;0.12" keyTimes="0;' + DRAW_F + ';' +
    HOLD_F + ';1" dur="' + CYCLE + 's" begin="' + PREROLL + '" repeatCount="indefinite"/>');
  out.push('<line x1="' + num(GX0) + '" y1="' + num(GY0) + '" x2="' + num(GX0) + '" y2="' + num(GY1) +
    '" stroke="' + C.mid + '" stroke-width="1" stroke-opacity="0.4">');
  out.push('<animateTransform attributeName="transform" type="translate" values="' + values.join(';') +
    '" keyTimes="' + keyTimes.join(';') + '" dur="' + CYCLE + 's" begin="' + PREROLL +
    '" calcMode="linear" repeatCount="indefinite"/>');
  out.push('</line>');
  out.push('</g>');

  // Scanner dot riding the leading edge of the trace.
  out.push('<g>');
  out.push('<animate attributeName="opacity" values="1;1;0.3;0.3" keyTimes="0;' + DRAW_F + ';' + HOLD_F +
    ';1" dur="' + CYCLE + 's" begin="' + PREROLL + '" repeatCount="indefinite"/>');
  out.push('<circle r="4" cx="0" cy="0" fill="' + C.head + '" filter="url(#dotGlow)"/>');
  out.push('<animateMotion dur="' + CYCLE + 's" begin="' + PREROLL +
    '" repeatCount="indefinite" calcMode="linear" keyPoints="0;1;1" keyTimes="0;' + DRAW_F + ';1" rotate="0">');
  out.push('<mpath xlink:href="#trace" href="#trace"/>');
  out.push('</animateMotion>');
  out.push('</g>');

  return out.join('');
}

function buildPeakMarker(peak) {
  if (!peak) return '';
  const out = [];
  const anchorRight = peak.x > 930;
  const labelX = anchorRight ? peak.x - 8 : peak.x + 8;
  const anchor = anchorRight ? 'end' : 'start';
  const labelY = Math.max(GY0 + 10, peak.y - 8);

  out.push('<g>');
  out.push('<circle cx="' + num(peak.x) + '" cy="' + num(peak.y) + '" r="3.5" fill="none" stroke="' + C.cyan +
    '" stroke-width="1.2" opacity="0.9">');
  out.push('<animate attributeName="r" values="3;7;3" dur="3.7s" begin="-1.9s" repeatCount="indefinite"/>');
  out.push('<animate attributeName="opacity" values="0.95;0.15;0.95" dur="3.7s" begin="-1.9s" repeatCount="indefinite"/>');
  out.push('</circle>');
  out.push('<text x="' + num(labelX) + '" y="' + num(labelY) + '" text-anchor="' + anchor +
    '" font-family="' + MONO + '" font-size="9" fill="' + C.cyan + '" opacity="0.75">' +
    txt('PEAK ' + peak.count, 16) + '</text>');
  out.push('</g>');
  return out.join('');
}

function buildReadout(avgPerDay) {
  const boxX = 1004;
  const boxY = 46;
  const boxW = 156;
  const boxH = 60;
  const cx = boxX + boxW / 2;

  return [
    '<g>',
    '<rect x="' + num(boxX) + '" y="' + num(boxY) + '" width="' + num(boxW) + '" height="' + num(boxH) +
      '" rx="4" fill="' + C.panel + '" fill-opacity="0.9" stroke="' + C.grid + '" stroke-width="1"/>',
    '<text x="' + num(cx) + '" y="' + num(boxY + 33) + '" text-anchor="middle" font-family="' + MONO +
      '" font-size="26" fill="' + C.bright + '" letter-spacing="1">' + txt(avgPerDay, 8) + '</text>',
    '<animate attributeName="opacity" values="1;0.82;1;1" keyTimes="0;0.08;0.16;1" dur="4.3s" begin="-3.1s" repeatCount="indefinite"/>',
    '<text x="' + num(cx) + '" y="' + num(boxY + 50) + '" text-anchor="middle" font-family="' + MONO +
      '" font-size="10" fill="' + C.dim + '" letter-spacing="2">AVG/DAY</text>',
    '</g>',
  ].join('');
}

function buildFooter(total, live, rangeFrom, rangeTo) {
  const label = live ? 'LIVE' : 'SIMULATED';
  const labelColor = live ? C.mid : C.amber;
  const charW = 7.2; // 12px monospace advance width, good enough for layout
  const labelW = label.length * charW;
  const dotX = GX1 - labelW - 12;
  const y = 224;

  const out = [];
  out.push('<line x1="' + num(GX0) + '" y1="209" x2="' + num(GX1) + '" y2="209" stroke="' + C.grid + '" stroke-width="1"/>');
  out.push('<text x="' + num(GX0) + '" y="' + num(y) + '" font-family="' + MONO + '" font-size="12" fill="' + C.dim + '">' +
    txt('CONTRIB.EKG // ' + total + ' events / 365d', 60) + '</text>');
  out.push('<text x="' + num(GX1) + '" y="' + num(y) + '" text-anchor="end" font-family="' + MONO +
    '" font-size="12" fill="' + labelColor + '" letter-spacing="1">' + txt(label, 16) + '</text>');
  out.push('<circle cx="' + num(dotX) + '" cy="' + num(y - 4) + '" r="3.2" fill="' + labelColor + '">');
  out.push('<animate attributeName="opacity" values="1;0.12;1" dur="2.9s" begin="-1.1s" repeatCount="indefinite"/>');
  out.push('</circle>');
  out.push('<text x="' + num(GX1) + '" y="30" text-anchor="end" font-family="' + MONO + '" font-size="10" fill="' + C.dim +
    '" opacity="0.75">' + txt(rangeFrom + '  →  ' + rangeTo, 40) + '</text>');
  return out.join('');
}

function buildSvg(model) {
  const parts = [];

  parts.push('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ' +
    'width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" ' +
    'aria-label="' + txt('Contribution EKG for ' + model.user, 80) + '">');

  parts.push('<title>' + txt('CONTRIB.EKG // ' + model.user, 80) + '</title>');
  parts.push(buildDefs(model.traceLength));

  // Opaque background + panel.
  parts.push('<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="' + C.bg + '"/>');
  parts.push('<rect x="' + num(PANEL_X) + '" y="' + num(PANEL_Y) + '" width="' + num(PANEL_W) + '" height="' + num(PANEL_H) +
    '" rx="6" fill="' + C.panel + '" stroke="' + C.grid + '" stroke-width="1"/>');

  // Header.
  parts.push('<text x="' + num(GX0) + '" y="30" font-family="' + MONO + '" font-size="10" fill="' + C.dim +
    '" letter-spacing="2">' + txt('CONTRIBUTION RHYTHM · ' + model.user, 60) + '</text>');

  parts.push(buildGrid(model.ticks));

  parts.push('<g clip-path="url(#graphClip)">');
  parts.push(buildTraceLayers(model.tracePath, model.areaPath, model.traceLength));
  parts.push(buildPeakMarker(model.peak));
  parts.push(buildScanner(model.sweepXs));
  parts.push('</g>');

  parts.push(buildReadout(model.avgPerDay));
  parts.push(buildFooter(model.total, model.live, model.rangeFrom, model.rangeTo));

  parts.push('</svg>');
  return parts.join('\n');
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  let live = true;
  let days = await fetchCalendar(USER, TOKEN);

  if (!days) {
    live = false;
    days = synthesizeCalendar();
  }

  days = normalizeSeries(days);

  const counts = days.map((d) => d.count);
  const total = counts.reduce((a, b) => a + b, 0);
  const maxCount = counts.reduce((a, b) => Math.max(a, b), 0);

  // Clamp the top at ~p95 so one huge day cannot flatten the rest.
  const p95 = percentile(counts, 0.95);
  const cap = Math.max(1, p95 > 0 ? p95 : maxCount);

  const points = buildTrace(days, cap);
  const cum = cumulativeLengths(points);
  const traceLength = Math.max(1, cum[cum.length - 1]);

  const tracePath = pointsToPath(points);
  const areaPath = tracePath + ' L ' + num(GX1) + ' ' + num(GY1) + ' L ' + num(GX0) + ' ' + num(GY1) + ' Z';

  const sweepXs = sampleSweepXs(points, cum, 49);

  const pIdx = peakIndex(days);
  const peak = days[pIdx].count > 0
    ? {
        x: GX0 + pIdx * SLOT + SLOT * 0.5,
        y: BASE - spikeHeight(days[pIdx].count, cap),
        count: days[pIdx].count,
      }
    : null;

  const model = {
    user: USER,
    live,
    total,
    avgPerDay: (total / DAYS).toFixed(1),
    tracePath,
    areaPath,
    traceLength,
    sweepXs,
    ticks: monthTicks(days),
    peak,
    rangeFrom: days[0].date,
    rangeTo: days[days.length - 1].date,
  };

  const svg = buildSvg(model);

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, svg, 'utf8');

  console.log(
    'pulse.svg written: ' + OUT_PATH +
    ' | ' + (live ? 'LIVE' : 'SIMULATED') +
    ' | ' + total + ' contributions / ' + DAYS + 'd' +
    ' | avg ' + model.avgPerDay + '/day' +
    ' | peak ' + maxCount +
    ' | cap(p95) ' + cap +
    ' | path ' + Math.round(traceLength) + 'px' +
    ' | ' + svg.length + ' bytes'
  );
}

main().catch((err) => {
  // Absolute last resort: never leave the README with a broken image.
  console.error('[pulse] unexpected failure: ' + clean(err && err.stack ? err.stack : err, 300));
  try {
    const fallback = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">',
      '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="' + C.bg + '"/>',
      '<rect x="16" y="12" width="' + num(PANEL_W) + '" height="' + num(PANEL_H) + '" rx="6" fill="' + C.panel +
        '" stroke="' + C.grid + '"/>',
      '<line x1="60" y1="120" x2="1160" y2="120" stroke="' + C.dim + '" stroke-width="2"/>',
      '<text x="60" y="224" font-family="' + MONO + '" font-size="12" fill="' + C.amber + '">CONTRIB.EKG // FLATLINE</text>',
      '</svg>',
    ].join('\n');
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, fallback, 'utf8');
    console.log('pulse.svg written (minimal fallback): ' + OUT_PATH);
  } catch (writeErr) {
    console.error('[pulse] could not write fallback: ' + clean(writeErr && writeErr.message, 200));
  }
  process.exit(0);
});
