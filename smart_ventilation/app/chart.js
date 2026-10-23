'use strict';

// The humidity chart on Home: how far back it looks, and turning Home
// Assistant's history into lines. 3 hours comes from the app's own readings;
// longer comes from Home Assistant's history (only reading).

const RANGES = [3, 24, 72, 168]; // hours
const DEFAULT_HOURS = 3;
const BUCKETS = 300; // per line: the lowest and highest value per bucket, so a shower peak stays

function hoursOf(v) {
  const n = Number(v);
  return RANGES.includes(n) ? n : DEFAULT_HOURS;
}

// Home Assistant's history rows ({ s, lu } or { state, last_updated }) as
// [{ t, v }], sorted, without values that are not a number.
function parseRows(rows) {
  const out = [];
  for (const row of rows || []) {
    const raw = row.s !== undefined ? row.s : row.state;
    const v = Number(raw);
    const t = row.lu !== undefined ? row.lu * 1000 : Date.parse(row.last_updated || row.last_changed || '');
    if (raw !== '' && raw !== null && Number.isFinite(v) && Number.isFinite(t)) out.push({ t: Math.round(t), v });
  }
  return out.sort((a, b) => a.t - b.t);
}

// At most 2 points per bucket (the lowest and the highest, in time order).
function thin(points, from, to, buckets = BUCKETS) {
  if (points.length <= buckets * 2) return points;
  const size = (to - from) / buckets;
  const out = [];
  let i = 0;
  while (i < points.length) {
    const b = Math.floor((points[i].t - from) / size);
    let lo = points[i];
    let hi = points[i];
    let j = i;
    while (j < points.length && Math.floor((points[j].t - from) / size) === b) {
      if (points[j].v < lo.v) lo = points[j];
      if (points[j].v > hi.v) hi = points[j];
      j++;
    }
    if (lo === hi) out.push(lo);
    else out.push(...(lo.t <= hi.t ? [lo, hi] : [hi, lo]));
    i = j;
  }
  return out;
}

// The value at time t: the last reading at or before t.
function valueAt(points, t) {
  let v = null;
  for (const p of points) {
    if (p.t > t) break;
    v = p.v;
  }
  return v;
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// The reference line: the median of the reference sensors at every time
// one of them changes.
function referenceLine(lists) {
  const times = [...new Set(lists.flatMap((l) => l.map((p) => p.t)))].sort((a, b) => a - b);
  const out = [];
  for (const t of times) {
    const m = median(lists.map((l) => valueAt(l, t)).filter((v) => v !== null));
    if (m !== null) out.push({ t, v: Math.round(m * 10) / 10 });
  }
  return out;
}

// A line for the chart: the value at `from`, then the readings after it.
function line(points, from, to) {
  const start = valueAt(points, from);
  const after = thin(points.filter((p) => p.t > from && p.t <= to), from, to);
  return [[from, start], ...after.map((p) => [p.t, p.v])].filter((p) => p[1] !== null);
}

// Boost and afterrun as coloured bands, from the activity log.
function spans(entries, from, to) {
  const out = [];
  let open = null;
  for (const e of entries) {
    if (e.t <= from) open = e.to === 'boost' || e.to === 'afterrun' ? { state: e.to, from } : null;
  }
  for (const e of entries.filter((x) => x.t > from && x.t <= to)) {
    if (open) { open.to = e.t; out.push(open); open = null; }
    if (e.to === 'boost' || e.to === 'afterrun') open = { state: e.to, from: e.t };
  }
  if (open) { open.to = to; out.push(open); }
  return out;
}

module.exports = { RANGES, DEFAULT_HOURS, BUCKETS, hoursOf, parseRows, thin, valueAt, referenceLine, line, spans };
