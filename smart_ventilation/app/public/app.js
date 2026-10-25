'use strict';

// Smart Ventilation page. Plain JavaScript, no framework.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const res = await fetch(path.replace(/^\//, ''), {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.body = body;
    throw err;
  }
  return body;
}

const STATE_LABEL = { idle: 'Normal', boost: 'Boost', afterrun: 'Afterrun', fault: 'Sensor problem', off: 'Off' };
const LEVEL_LABEL = { idle: 'rest', boost: 'boost', afterrun: 'afterrun', restricted: 'restricted' };

function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

function clock(t) {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmt(v, unit = '') {
  return v === null || v === undefined ? '–' : `${v}${unit}`;
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

let tab = 'home';
let sub = 'actuators';
let suggestNotes = [];

$$('#main-nav .tab').forEach((b) => b.addEventListener('click', () => {
  tab = b.dataset.tab;
  $$('#main-nav .tab').forEach((x) => x.classList.toggle('active', x === b));
  ['home', 'activity', 'settings'].forEach((t) => { $(`#tab-${t}`).hidden = t !== tab; });
  $('#settings-nav').hidden = tab !== 'settings';
  render();
}));
$$('#settings-nav .subtab').forEach((b) => b.addEventListener('click', () => {
  sub = b.dataset.sub;
  $$('#settings-nav .subtab').forEach((x) => x.classList.toggle('active', x === b));
  renderSettings();
}));

function goTo(t, s) {
  if (s) sub = s;
  $(`#main-nav .tab[data-tab="${t}"]`).click();
  if (s) $(`#settings-nav .subtab[data-sub="${s}"]`).click();
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

let status = null;

function topStatus() {
  if (!status) return;
  const parts = [];
  parts.push(status.connected ? `Connected to Home Assistant ${esc(status.haVersion || '')}` : `<span style="color:var(--bad)">Not connected${status.error ? ': ' + esc(status.error) : ''}</span>`);
  if (status.night) parts.push('night mode');
  parts.push(`v${esc(status.version)}`);
  $('#top-status').innerHTML = parts.join(' · ');
  const chip = $('#mode-chip');
  const live = status.mode === 'live';
  chip.textContent = live ? 'Live' : 'Dry-run';
  chip.className = `chip ${live ? 'live' : 'warn'}`;
  chip.title = live ? 'Live control is on: the app sets the actuators marked live.' : 'Live control is off: the app only shows advice. It never changes your fan or valves.';
}

async function renderHome() {
  try {
    status = await api('/api/status');
  } catch (err) {
    $('#tab-home').innerHTML = `<div class="card">Could not load: ${esc(err.message)}</div>`;
    return;
  }
  topStatus();
  const el = $('#tab-home');
  if (!status.configured) {
    el.innerHTML = `<div class="card"><h2>Welcome</h2>
      <p>Set up in three steps:</p>
      <ol><li>Add the fan and valves under <b>Actuators</b>.</li>
      <li>Add a zone per room (shower, bathroom) under <b>Zones</b>: its humidity sensor and which actuators it uses.</li>
      <li>Optionally choose reference sensors in other rooms under <b>General</b>.</li></ol>
      <p class="muted small">At first the app only shows what it would do (dry-run). When you trust it, turn on <b>Live control</b> under General.</p>
      <button class="primary" id="go-setup">Go to Settings</button></div>`;
    $('#go-setup').onclick = () => goTo('settings', 'actuators');
    return;
  }
  const live = status.mode === 'live';
  const banner = live
    ? `<div class="card small live-on"><b>Live control is on.</b> The app sets the actuators marked live. Your own automations for these fans and valves should be off, or they work against each other.</div>`
    : `<div class="card small"><b>Dry-run.</b> The app follows your sensors and shows what it <i>would</i> set. Nothing is sent to the fan or valves, so your current automations keep working. <a href="#" id="go-live">Live control</a> is under Settings › General.</div>`;
  const zones = status.zones.map(zoneCard).join('');
  const acts = `<div class="card"><h2>${live ? 'Actuators' : 'Actuators: advice'}</h2>${status.actuators.map(actRow).join('') || '<div class="muted">No actuators yet.</div>'}</div>`;
  el.innerHTML = banner + zones + acts;
  const goLive = $('#go-live');
  if (goLive) goLive.onclick = (e) => { e.preventDefault(); goTo('settings', 'general'); };
  for (const z of status.zones) drawChart(z.id);
}

function zoneCard(z) {
  const f = z.figures;
  const icon = z.state === 'boost' ? '<span class="spin">✻</span>' : z.state === 'fault' ? '!' : '✻';
  const since = z.state === 'boost' && z.boostStart ? `boosting for ${ago(z.boostStart)}` : `since ${clock(z.since)}`;
  return `<div class="card">
    <div class="row">
      <div class="icon ${z.state}">${icon}</div>
      <div style="flex:1;min-width:0"><h2 style="margin:0">${esc(z.name)}</h2><div class="muted small">${esc(z.reason)}</div></div>
      <span class="chip ${z.state}">${STATE_LABEL[z.state] || z.state}</span>
    </div>
    <div class="figures">
      <div class="figure"><span>Humidity</span><b>${fmt(f.humidity, '%')}</b></div>
      <div class="figure"><span>Baseline${f.baselineFrozen ? ' (frozen)' : ''}</span><b>${fmt(f.baseline, '%')}</b></div>
      <div class="figure"><span>Rise in window</span><b>${f.rise === null ? '–' : (f.rise >= 0 ? '+' : '') + f.rise}</b></div>
      ${f.reference !== null ? `<div class="figure"><span>Reference</span><b>${fmt(f.reference, '%')}</b></div>` : ''}
      ${f.temperature !== null ? `<div class="figure"><span>Temperature</span><b>${fmt(f.temperature, ' °C')}</b></div>` : ''}
      <div class="figure"><span>Showers today</span><b>${z.showersToday}</b></div>
    </div>
    ${devicesRow(z)}
    <div class="muted small">${since}</div>
    <div class="chart-head"><span class="small muted">${RANGE_TITLE[chartHours]}</span>${rangeButtons()}</div>
    <svg class="chart" id="chart-${esc(z.id)}" viewBox="0 0 600 170" role="img" aria-label="Humidity, ${RANGE_TITLE[chartHours].toLowerCase()}"></svg>
    <div class="legend"><span><i style="background:var(--accent)"></i>humidity</span><span><i style="background:var(--muted)"></i>reference</span>${chartHours === 3 ? '<span><i style="background:var(--warning)"></i>baseline</span>' : ''}<span><i style="background:rgba(var(--rgb-accent),.3);height:8px"></i>boost</span><span><i style="background:rgba(var(--rgb-good),.3);height:8px"></i>afterrun</span></div>
  </div>`;
}

// The zone's own fan and valves: the position now, and where the app sets it
// (or would set it) when that is different.
function devicesRow(z) {
  const list = z.devices || [];
  if (!list.length) return '<div class="muted small" style="margin:4px 0">No fan or valve linked to this zone. Link them under Settings › Zones.</div>';
  const target = status.mode === 'live' ? 'to' : 'advice';
  return `<div class="figures devices">${list.map((d) => {
    const moving = d.advised !== null && String(d.current) !== String(d.advised);
    return `<div class="figure device ${d.level === 'boost' ? 'boost' : d.level === 'afterrun' ? 'afterrun' : ''}">
      <span>${esc(d.name)}</span><b>${fmt(d.current, d.unit)}</b>
      ${moving ? `<span>${target} ${fmt(d.advised, d.unit)}</span>` : ''}</div>`;
  }).join('')}</div>`;
}

// What Live control did with this actuator, in one short line.
function liveLine(a) {
  const c = a.control;
  if (!c) return 'Live · waiting for the first value';
  if (c.gaveUp) return `<span style="color:var(--bad)">Live · the device did not follow after ${c.tries} tries. The app tries again at the next change.</span>`;
  if (c.done) return c.tries ? '<span class="ok">Live · set ✓</span>' : '<span class="ok">Live · already at this value</span>';
  if (c.error) return `<span style="color:var(--bad)">Live · could not set: ${esc(c.error)}</span> (try ${c.tries} of ${status.maxTries})`;
  return `Live · sent, waiting for the device (try ${c.tries} of ${status.maxTries})`;
}

function actRow(a) {
  const unit = a.unit;
  const cmd = a.command ? `<code>${esc(a.command.service)} ${esc(JSON.stringify(a.command.data))}</code>` : '';
  const same = a.current !== null && String(a.current) === String(a.advised);
  const live = status.mode === 'live';
  const foot = a.live ? `<div class="small" style="margin-top:4px">${liveLine(a)}</div>`
    : cmd ? `<div class="small" style="margin-top:4px">${live ? 'Not live (advice only). Would send: ' : 'Would send: '}${cmd}</div>` : '';
  return `<div class="act">
    <div class="row wrap"><b>${esc(a.name)}</b><span class="muted small">${esc(a.entity || 'no entity')}</span><span class="spacer"></span>
      <span class="small">now ${fmt(a.current, unit)} → ${a.live ? 'target' : 'advice'} <b>${fmt(a.advised, unit)}</b></span>
      ${a.level ? `<span class="chip ${a.level === 'boost' ? 'boost' : a.level === 'afterrun' ? 'afterrun' : ''}">${LEVEL_LABEL[a.level] || a.level}</span>` : ''}</div>
    <div class="muted small">${esc(a.why)}${same && !a.live ? ' · already at this value' : ''}</div>
    ${foot}
  </div>`;
}

// How far back the chart looks: one choice for all zones, kept in this browser.
const RANGES = [[3, '3 h'], [24, '24 h'], [72, '3 days'], [168, '7 days']];
const RANGE_TITLE = { 3: 'Last 3 hours', 24: 'Last 24 hours', 72: 'Last 3 days', 168: 'Last 7 days' };
let chartHours = 3;
try {
  const saved = Number(localStorage.getItem('sv-chart-hours'));
  if (RANGE_TITLE[saved]) chartHours = saved;
} catch { /* private window */ }

function rangeButtons() {
  return `<div class="range" role="group" aria-label="How far back">${RANGES.map(([h, label]) =>
    `<button type="button" data-hours="${h}" aria-pressed="${h === chartHours}">${label}</button>`).join('')}</div>`;
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('.range button[data-hours]');
  if (!b || Number(b.dataset.hours) === chartHours) return;
  chartHours = Number(b.dataset.hours);
  try { localStorage.setItem('sv-chart-hours', String(chartHours)); } catch { /* private window */ }
  renderHome();
});

const dayLabel = (t) => new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric' });

async function drawChart(zoneId) {
  const svg = document.getElementById(`chart-${zoneId}`);
  if (!svg) return;
  let c;
  try { c = await api(`/api/chart?zone=${encodeURIComponent(zoneId)}&hours=${chartHours}`); } catch (err) {
    svg.innerHTML = `<text x="300" y="90" text-anchor="middle" fill="currentColor" opacity=".6" font-size="13">${esc(err.message)}</text>`;
    return;
  }
  // Labels stay about 11 px on screen, also on a narrow phone.
  const fs = Math.min(24, Math.max(11, 11 * 600 / (svg.clientWidth || 600)));
  const W = 600, H = 170 + fs, L = 12 + fs * 2.6, R = 8, T = 8, B = 10 + fs * 1.2;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const values = [...c.humidity, ...c.reference].map((p) => p[1]);
  if (c.baseline !== null) values.push(c.baseline);
  if (!values.length) { svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="currentColor" opacity=".6" font-size="13">No readings yet</text>`; return; }
  // Four even steps of a whole number of points.
  const ticks = 4;
  let lo = Math.floor(Math.min(...values) - 2);
  const stepSize = Math.max(2, Math.ceil((Math.max(...values) + 2 - lo) / ticks));
  const hi = lo + stepSize * ticks;
  const X = (t) => L + (t - c.from) / (c.to - c.from) * (W - L - R);
  const Y = (v) => T + (hi - v) / (hi - lo) * (H - T - B);
  const step = (pts) => {
    if (!pts.length) return '';
    let d = `M${X(pts[0][0]).toFixed(1)} ${Y(pts[0][1]).toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) d += `H${X(pts[i][0]).toFixed(1)}V${Y(pts[i][1]).toFixed(1)}`;
    return d + `H${X(c.to).toFixed(1)}`;
  };
  let out = '';
  for (const s of c.spans) {
    const color = s.state === 'boost' ? 'rgba(var(--rgb-accent),.18)' : 'rgba(var(--rgb-good),.16)';
    out += `<rect x="${X(s.from).toFixed(1)}" y="${T}" width="${Math.max(1, X(s.to) - X(s.from)).toFixed(1)}" height="${H - T - B}" style="fill:${color}"/>`;
  }
  for (let i = 0; i <= ticks; i++) {
    const v = lo + stepSize * i;
    out += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" style="stroke:var(--grid)"/><text x="${L - 6}" y="${Y(v) + fs / 3}" text-anchor="end" font-size="${fs.toFixed(1)}" style="fill:var(--muted)">${v}%</text>`;
  }
  const hours = Math.round((c.to - c.from) / 3600000);
  if (hours <= 3) {
    for (let h = 0; h <= 3; h++) {
      const t = c.to - (3 - h) * 3600000;
      out += `<text x="${X(t)}" y="${H - 6}" text-anchor="${h === 0 ? 'start' : h === 3 ? 'end' : 'middle'}" font-size="${fs.toFixed(1)}" style="fill:var(--muted)">${h === 3 ? 'now' : clock(t)}</text>`;
    }
  } else {
    // 24 hours: a label every 6 hours. More days: one per day at midnight,
    // with a faint line (3 days on a wide screen: also at noon).
    const every = hours <= 24 ? 6 : (hours <= 72 && svg.clientWidth >= 500 ? 12 : 24);
    const first = new Date(c.from);
    first.setMinutes(0, 0, 0);
    for (let t = first.getTime() + 3600000; t < c.to; t += 3600000) {
      const h = new Date(t).getHours();
      if (h % every) continue;
      const x = X(t);
      if (x < L + fs * 1.5 || x > W - R - fs * 1.5) continue;
      const day = hours > 24 && h === 0;
      if (day) out += `<line x1="${x}" x2="${x}" y1="${T}" y2="${H - B}" style="stroke:var(--grid)"/>`;
      out += `<text x="${x}" y="${H - 6}" text-anchor="middle" font-size="${fs.toFixed(1)}" style="fill:var(--muted)">${day ? esc(dayLabel(t)) : clock(t)}</text>`;
    }
  }
  if (c.baseline !== null) out += `<line x1="${L}" x2="${W - R}" y1="${Y(c.baseline)}" y2="${Y(c.baseline)}" style="stroke:var(--warning)" stroke-dasharray="5 4"/>`;
  if (c.reference.length) out += `<path d="${step(c.reference)}" fill="none" style="stroke:var(--muted)" stroke-width="1.5"/>`;
  if (c.humidity.length) out += `<path d="${step(c.humidity)}" fill="none" style="stroke:var(--accent)" stroke-width="2.2"/>`;
  svg.innerHTML = out;
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

async function renderActivity() {
  const el = $('#tab-activity');
  let log;
  try { log = await api('/api/log'); } catch (err) { el.innerHTML = `<div class="card">Could not load: ${esc(err.message)}</div>`; return; }
  if (!log.length) { el.innerHTML = '<div class="card muted">Nothing happened yet.</div>'; return; }
  const items = log.map((e) => {
    const when = `${new Date(e.t).toLocaleDateString([], { day: 'numeric', month: 'short' })} ${clock(e.t)}`;
    if (e.type === 'zone') {
      return `<div class="log-item"><div class="row wrap"><span class="chip ${e.to}">${STATE_LABEL[e.to] || e.to}</span><b>${esc(e.name)}</b><span class="spacer"></span><span class="muted small">${when}</span></div>
        <div class="small">${esc(e.reason)}${e.humidity !== null && e.humidity !== undefined ? ` · humidity ${e.humidity}%` : ''}</div></div>`;
    }
    if (e.type === 'advice') {
      return `<div class="log-item"><div class="row wrap"><b>${esc(e.name)}</b><span class="small">would be set to <b>${esc(e.value)}</b> (${LEVEL_LABEL[e.level] || esc(e.level)})</span><span class="spacer"></span><span class="muted small">${when}</span></div>
        <div class="muted small">${esc(e.why)}</div></div>`;
    }
    if (e.type === 'sent') {
      const what = e.ok ? `set to <b>${esc(e.value)}</b>` : `<span style="color:var(--bad)">could not set <b>${esc(e.value)}</b></span>`;
      return `<div class="log-item"><div class="row wrap"><span class="chip live">Live</span><b>${esc(e.name)}</b><span class="small">${what} (${LEVEL_LABEL[e.level] || esc(e.level)})${e.tries > 1 ? `, try ${e.tries}` : ''}</span><span class="spacer"></span><span class="muted small">${when}</span></div>
        <div class="muted small">${esc(e.why)}${e.ok ? '' : ` · ${esc(e.error)}`}</div></div>`;
    }
    if (e.type === 'gave-up') {
      return `<div class="log-item"><div class="row wrap"><span class="chip fault">Live</span><b>${esc(e.name)}</b><span class="spacer"></span><span class="muted small">${when}</span></div>
        <div class="small">${esc(e.reason)}</div></div>`;
    }
    return `<div class="log-item"><div class="row"><span class="muted small">${esc(e.reason || e.type)}</span><span class="spacer"></span><span class="muted small">${when}</span></div></div>`;
  }).join('');
  el.innerHTML = `<div class="card"><h2>Activity</h2><p class="muted small">Zone changes, what the app set (Live) and what it would set (advice). Newest first.</p>${items}</div>`;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

let draft = null;
let ents = null;
let dirty = false;

const ZONE_DEFAULTS = { riseThreshold: 8, riseWindowMin: 5, absoluteTrigger: 85, stopMargin: 3, minBoostMin: 5, maxBoostMin: 60, afterrunMin: 5, baselineWindowMin: 60, confirmWithTemperature: false, temperatureRise: 1 };

let dash = null; // dashboard controls status (from /api/status)

async function loadSettings() {
  [draft, ents, dash] = await Promise.all([api('/api/settings'), api('/api/entities').catch(() => ({})), loadDash()]);
  dirty = false;
}

async function loadDash() {
  try { return (await api('/api/status')).dashboard || null; } catch { return null; }
}

// The helper on the dashboard that sets this zone setting, if it exists.
function lockedBy(zoneId, field) {
  const list = dash && dash.locked && dash.locked[zoneId];
  const hit = list && list.find((x) => x.field === field);
  return hit ? hit.entity_id : null;
}

function meta(entityId) {
  for (const list of Object.values(ents || {})) {
    const m = list.find((x) => x.entity_id === entityId);
    if (m) return m;
  }
  return null;
}

// Entity picker: a text field with our own search list. (The browser's
// <datalist> shows nothing in the Home Assistant phone app.)
function datalists() { return ''; }

function picker(kind, value, attrs, placeholder) {
  const m = value ? meta(value) : null;
  const note = value ? (m ? esc(m.name) + (m.state !== undefined ? ` · now ${esc(m.state)}${m.unit ? ' ' + esc(m.unit) : ''}` : '') : '<span style="color:var(--bad)">not found in Home Assistant</span>') : 'Tap and type to search';
  return `<div class="picker" data-kind="${esc(kind)}"><input value="${esc(value || '')}" placeholder="${esc(placeholder || 'Search entity…')}" autocomplete="off" autocapitalize="off" spellcheck="false" ${attrs}><div class="picker-list" hidden></div></div><div class="hint">${note}</div>`;
}

function pickerMatches(kind, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (m) => words.every((w) => `${m.entity_id} ${m.name}`.toLowerCase().includes(w));
  // Reference sensors: humidity sensors that are not a zone sensor and not chosen yet.
  const skip = kind === 'reference' ? new Set([...draft.general.references, ...draft.zones.map((z) => z.humidity)]) : new Set();
  const base = kind === 'reference' ? 'humidity' : kind;
  const own = ((ents && ents[base]) || []).filter((m) => !skip.has(m.entity_id) && hit(m));
  // Not in the usual list (for example a humidity sensor without a device
  // class)? Then look in all sensors.
  if ((base === 'humidity' || base === 'temperature') && own.length < 5 && words.length) {
    const ids = new Set([...own.map((m) => m.entity_id), ...skip]);
    return { own, other: ((ents && ents.sensor) || []).filter((m) => !ids.has(m.entity_id) && hit(m)) };
  }
  return { own, other: [] };
}

function bindPickers(root) {
  $$('.picker', root).forEach((box) => {
    const input = $('input', box);
    const list = $('.picker-list', box);
    const option = (m) => `<button type="button" class="picker-opt" data-id="${esc(m.entity_id)}"><span>${esc(m.name)}</span><small>${esc(m.entity_id)}${m.state !== undefined ? ` · ${esc(m.state)}${m.unit ? ' ' + esc(m.unit) : ''}` : ''}</small></button>`;
    const show = () => {
      const { own, other } = pickerMatches(box.dataset.kind, input.value === input.defaultValue ? '' : input.value);
      const LIMIT = 40;
      let html = own.slice(0, LIMIT).map(option).join('');
      if (other.length) html += `<div class="picker-head">Other sensors</div>${other.slice(0, LIMIT).map(option).join('')}`;
      if (!html) html = `<div class="picker-head">${box.dataset.kind === 'reference' && !input.value ? 'No other humidity sensors: the ones in your zones and the ones already chosen are left out' : 'Nothing found'}</div>`;
      if (own.length + other.length > 2 * LIMIT) html += '<div class="picker-head">Type more to narrow the list</div>';
      list.innerHTML = html;
      list.hidden = false;
    };
    input.addEventListener('focus', show);
    input.addEventListener('input', show);
    input.addEventListener('blur', () => setTimeout(() => { list.hidden = true; }, 150));
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') list.hidden = true; });
    list.addEventListener('pointerdown', (e) => {
      const btn = e.target.closest('.picker-opt');
      if (!btn) return;
      e.preventDefault();
      input.value = btn.dataset.id;
      list.hidden = true;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
}

function markDirty() {
  dirty = true;
  $('#save-msg').innerHTML = '<b>Unsaved changes</b> · press Save settings to keep them';
  showDirty();
}

// The save bar turns orange while there are unsaved changes.
function showDirty() {
  $('#save-bar').classList.toggle('dirty', dirty);
  $('#discard-btn').hidden = !dirty;
  if (window.unsavedGuard) unsavedGuard.update();
}

function renderSettings() {
  if (!draft) return;
  const el = $('#settings-body');
  $('#save-bar').hidden = sub === 'diag';
  const start = draft.actuators.length === 0 && draft.zones.length === 0 && sub !== 'diag' ? startCard() : '';
  // general still shows its own page below the start card
  if (start && sub !== 'general') el.innerHTML = datalists() + start;
  else if (sub === 'zones') el.innerHTML = datalists() + zonesView();
  else if (sub === 'actuators') el.innerHTML = datalists() + notesCard() + actuatorsView();
  else if (sub === 'general') el.innerHTML = datalists() + start + generalView();
  else el.innerHTML = diagView();
  bind();
}

// Shown while nothing is set up yet.
function startCard() {
  return `<div class="card"><h2>Set up in three steps</h2>
    <ol>
      <li><b>Actuators</b>: your ventilation unit (fan) and a valve per room, with the percentage for rest, boost and afterrun.</li>
      <li><b>Zones</b>: one per room (Shower, Bathroom): its humidity sensor and which fan and valve it uses.</li>
      <li><b>General</b> (optional): reference sensors in other rooms, night mode.</li>
    </ol>
    <p class="small">The app can make a first proposal from the entities in Home Assistant. Nothing is saved until you press <b>Save settings</b>.</p>
    <button class="primary" data-act="suggest">Suggest a set-up</button>
    <button class="secondary" data-act="add-act">+ Add actuator by hand</button></div>`;
}

// What the proposal guessed, shown until the settings are saved.
function notesCard() {
  if (!suggestNotes.length) return '';
  return `<div class="card small"><b>Proposal filled in. Check it, then press Save settings.</b><ul>${suggestNotes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>`;
}

function num(label, key, value, min, max, step, hint) {
  return `<div class="field"><label>${label}</label><input type="number" data-k="${key}" value="${esc(value)}" min="${min}" max="${max}" step="${step}">${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
}

function zonesView() {
  // A setting with a helper on the dashboard is set there, not here.
  const zn = (z, label, key, min, max, step, hint) => {
    const by = z.id ? lockedBy(z.id, key) : null;
    if (!by) return num(label, key, z[key], min, max, step, hint);
    return `<div class="field"><label>${label}</label><input type="number" value="${esc(z[key])}" disabled><div class="hint">Set on your dashboard: <code>${esc(by)}</code></div></div>`;
  };
  const zones = draft.zones.map((z, i) => `<div class="card" data-zone="${i}">
    <div class="row"><h2 style="margin:0;flex:1">${esc(z.name)}</h2><label class="check"><input type="checkbox" data-k="enabled" ${z.enabled !== false ? 'checked' : ''}>On</label><button class="danger" data-act="del-zone">Remove</button></div>
    <div class="grid2">
      <div class="field"><label>Name</label><input data-k="name" value="${esc(z.name)}" maxlength="40"></div>
      <div class="field"><label>Humidity sensor</label>${picker('humidity', z.humidity, 'data-k="humidity"')}</div>
      <div class="field"><label>Temperature sensor (optional)</label>${picker('temperature', z.temperature, 'data-k="temperature"')}</div>
    </div>
    <div class="field"><label>Actuators of this zone</label>
      ${draft.actuators.length ? draft.actuators.map((a) => `<label class="check"><input type="checkbox" data-zact="${esc(a.id)}" ${z.actuators.includes(a.id) ? 'checked' : ''}>${esc(a.name)} <span class="muted small">&nbsp;${esc(a.entity || '')}</span></label>`).join('') : '<div class="hint">Add actuators first (Settings › Actuators).</div>'}
      <div class="hint">A fan in more zones is shared: it gets the highest level any zone asks for.</div>
    </div>
    <details><summary>Detection and timing</summary>
      <div class="grid3">
        ${zn(z, 'Rise trigger (points)', 'riseThreshold', 1, 50, 0.5, 'Humidity rise that counts as a shower')}
        ${num('Within (min)', 'riseWindowMin', z.riseWindowMin, 1, 30, 1)}
        ${zn(z, 'Absolute trigger (%)', 'absoluteTrigger', 40, 100, 1, 'Safety net if the rise is missed')}
        ${zn(z, 'Stop margin (points)', 'stopMargin', 0, 20, 0.5, 'Stop at baseline + this')}
        ${num('Minimum boost (min)', 'minBoostMin', z.minBoostMin, 0, 60, 1)}
        ${zn(z, 'Maximum boost (min)', 'maxBoostMin', 5, 240, 1)}
        ${zn(z, 'Afterrun (min)', 'afterrunMin', 0, 60, 1)}
        ${num('Baseline window (min)', 'baselineWindowMin', z.baselineWindowMin, 15, 120, 5, 'Normal level = median over this time')}
        ${num('Temperature rise (°C)', 'temperatureRise', z.temperatureRise, 0.1, 10, 0.1)}
      </div>
      <label class="check"><input type="checkbox" data-k="confirmWithTemperature" ${z.confirmWithTemperature ? 'checked' : ''}>Only count a rise as a shower when the temperature also rises</label>
    </details>
  </div>`).join('');
  return `${zones || '<div class="card muted">No zones yet. Add one per room, for example Shower and Bathroom.</div>'}
    <button class="secondary" data-act="add-zone">+ Add zone</button>`;
}

function levelInput(a, level, label, optional) {
  const m = a.entity ? meta(a.entity) : null;
  const v = a[level];
  const empty = optional ? '<option value="">not used</option>' : '';
  if (a.type === 'switch') {
    return `<div class="field"><label>${label}</label><select data-k="${level}">${empty}${['on', 'off'].map((o) => `<option ${v === o ? 'selected' : ''}>${o}</option>`).join('')}</select></div>`;
  }
  const opts = a.type === 'select' ? (m && m.options) || [] : a.type === 'fan' && a.fanMode === 'preset' ? (m && m.presets) || [] : null;
  if (opts) {
    return `<div class="field"><label>${label}</label><select data-k="${level}">${empty}${opts.map((o) => `<option ${v === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}${v && !opts.includes(v) ? `<option selected>${esc(v)}</option>` : ''}</select></div>`;
  }
  const min = m && Number.isFinite(m.min) ? m.min : 0;
  const max = m && Number.isFinite(m.max) ? m.max : 100;
  const step = (m && m.step) || 1;
  return `<div class="field"><label>${label}</label><input type="number" data-k="${level}" value="${esc(v)}" min="${min}" max="${max}" step="${step}" placeholder="${optional ? 'not used' : ''}"></div>`;
}

function actuatorsView() {
  const list = draft.actuators.map((a, i) => {
    const m = a.entity ? meta(a.entity) : null;
    const presets = a.type === 'fan' && m && m.presets && m.presets.length;
    const range = m && Number.isFinite(m.min) && a.type !== 'select' && a.type !== 'switch' && !(a.type === 'fan' && a.fanMode === 'preset') ? `Range ${m.min}–${m.max}, step ${m.step}` : '';
    return `<div class="card" data-act-i="${i}">
      <div class="row"><h2 style="margin:0;flex:1">${esc(a.name)}</h2><button class="danger" data-act="del-act">Remove</button></div>
      <div class="grid3">
        <div class="field"><label>Name</label><input data-k="name" value="${esc(a.name)}" maxlength="40"></div>
        <div class="field"><label>Type</label><select data-k="type">${[['fan', 'Fan (ventilation unit)'], ['number', 'Number (valve, %)'], ['select', 'Select (fixed modes)'], ['switch', 'Switch (on/off)']].map(([v, l]) => `<option value="${v}" ${a.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label>Entity</label>${picker(a.type, a.entity, 'data-k="entity"', `Search ${a.type}…`)}</div>
      </div>
      ${a.type === 'fan' ? `<div class="field"><label>Control by</label><select data-k="fanMode"><option value="percentage" ${a.fanMode !== 'preset' ? 'selected' : ''}>Percentage</option><option value="preset" ${a.fanMode === 'preset' ? 'selected' : ''} ${presets ? '' : 'disabled'}>Preset${presets ? '' : ' (this fan has none)'}</option></select></div>` : ''}
      <h3>Levels${range ? ` <span class="muted small">· ${range}</span>` : ''}</h3>
      <div class="grid3">
        ${levelInput(a, 'idle', 'Rest')}
        ${levelInput(a, 'boost', 'Boost')}
        ${levelInput(a, 'afterrun', 'Afterrun')}
        ${levelInput(a, 'restricted', 'While another zone boosts', true)}
        ${a.type === 'number' || (a.type === 'fan' && a.fanMode !== 'preset') ? levelInput(a, 'multiBoost', 'When more zones boost', true) + levelInput(a, 'nightMax', 'Night maximum', true) : ''}
      </div>
      <label class="check"><input type="checkbox" data-k="live" ${a.live !== false ? 'checked' : ''}>Live: the app may set this one when Live control is on</label>
      <div class="hint">${draft.general.liveControl ? 'Live control is on (General).' : 'Live control is off (General): the app only shows advice for now.'} Untick to keep this one on advice only.</div>
      ${a.type !== 'fan' ? '<div class="hint">"While another zone boosts": close this valve partly (for example 0–25%) so the air comes from the wet room. Leave it empty to keep it at rest.</div>' : '<div class="hint">For a fan, leave "While another zone boosts" empty: a fan shared by more zones simply follows the highest demand.</div>'}
      ${a.type === 'number' || (a.type === 'fan' && a.fanMode !== 'preset') ? '<div class="hint">"When more zones boost" (optional, meant for a shared fan): the value when two or more of its zones boost at the same time, for example 80 while one zone alone uses 75. Not lower than boost. Leave it empty to use boost.</div>' : ''}
    </div>`;
  }).join('');
  return `${list || '<div class="card muted">No actuators yet. Add the ventilation unit (a fan) and a valve per room.</div>'}
    <button class="secondary" data-act="add-act">+ Add actuator</button>`;
}

function generalView() {
  const g = draft.general;
  return `${liveCard()}<div class="card"><h2>Reference sensors</h2>
      <p class="muted small">Optional. Humidity sensors in other rooms. The app uses their median to ignore weather (the whole house getting humid) and to know when the bathroom is back to normal.</p>
      <div class="refs">${g.references.map((r, i) => `<span class="chip">${esc((meta(r) || {}).name || r)} <button data-act="del-ref" data-i="${i}" aria-label="Remove">✕</button></span>`).join('') || '<span class="muted small">None chosen.</span>'}</div>
      <div class="row"><div style="flex:1">${picker('reference', '', 'id="ref-new"', 'Search humidity sensor…')}</div><button class="secondary" data-act="add-ref">Add</button></div>
    </div>
    <div class="card"><h2>Night</h2>
      <label class="check"><input type="checkbox" data-g="nightEnabled" ${g.nightEnabled ? 'checked' : ''}>Use the night maximum of the actuators during this time</label>
      <div class="grid2">
        <div class="field"><label>From</label><input type="time" data-g="nightStart" value="${esc(g.nightStart)}"></div>
        <div class="field"><label>Until</label><input type="time" data-g="nightEnd" value="${esc(g.nightEnd)}"></div>
      </div>
    </div>
    ${dashboardCard()}
    <div class="card"><h2>Sensors</h2>
      ${num('Sensor timeout (min)', 'sensorTimeoutMin', g.sensorTimeoutMin, 5, 720, 5, 'No reading for this long counts as a sensor problem: the zone goes back to rest.').replace('data-k=', 'data-g=')}
    </div>`;
}

// Live control: off by default; then the app only shows advice.
function liveCard() {
  const g = draft.general;
  const n = draft.actuators.filter((a) => a.entity && a.live !== false).length;
  return `<div class="card${g.liveControl ? ' live-on' : ''}"><h2>Live control</h2>
    <label class="check"><input type="checkbox" data-g="liveControl" ${g.liveControl ? 'checked' : ''}>Let the app set the fan and valves</label>
    <p class="muted small">Off: the app only shows what it would set (dry-run). On: it sets the actuators marked <b>Live</b> (${n} now): when a shower starts, during afterrun and back to rest. It only sends a value when it changes, so a change by hand stays until the next shower. If a device does not follow, it tries 3 times and then stops and notes it in Activity.</p>
    <p class="small"><b>Before you turn it on:</b> turn off your own automations or blueprints for these fans and valves, or they work against each other.</p>
    <p class="muted small">Turning it off, unticking Live on an actuator, or stopping the app (for example for an update) sets what the app moved back to rest.</p>
  </div>`;
}

// Dashboard controls: helpers in a YAML package that the app writes.
function dashboardCard() {
  const g = draft.general;
  const d = dash || {};
  const loc = d.location || {};
  let body = '';
  if (g.dashboardHelpers) {
    if (!loc.ok && loc.problem === 'no-packages') {
      body += `<p class="small"><b>One step first:</b> packages are not on in Home Assistant yet. Add these lines to <code>configuration.yaml</code> (for example with the File editor app), restart Home Assistant, then come back here:</p>
        <pre class="code">${esc(d.snippet)}</pre>
        <p class="hint">Is there already a <code>homeassistant:</code> line? Then add only the <code>packages:</code> line under it.</p>`;
    } else if (!loc.ok) {
      body += `<p class="small" style="color:var(--bad)">${esc(loc.detail || 'The Home Assistant config folder cannot be used.')}</p>`;
    } else {
      body += `<p class="small">The app writes <code>${esc(loc.dir)}/smart_ventilation.yaml</code> and nothing else.</p>`;
      if (d.file && d.file.error) body += `<p class="small" style="color:var(--bad)">${esc(d.file.error)}</p>`;
      if (!d.enabled) body += '<p class="small"><b>Press Save settings</b> to make the file.</p>';
      else if (d.found < d.expected) {
        body += `<p class="small"><b>${d.found} of ${d.expected} helpers are in Home Assistant.</b> Load the new ones once: <b>Developer tools → YAML</b> → reload <b>Input numbers</b>, <b>Input selects</b> and <b>Input buttons</b> (or restart Home Assistant).</p>`;
      } else {
        body += `<p class="small ok">✓ All ${d.expected} helpers are in Home Assistant. Put them on a dashboard; changes there are used right away.</p>`;
      }
      if (d.enabled && (d.entities || []).length) {
        body += `<details><summary>Entities for your dashboard</summary>${d.entities.map((e) => `<h3>${esc(e.name)}</h3><div class="small"><code>${esc(e.mode)}</code> Auto / Off<br><code>${esc(e.boost)}</code> boost now<br>${e.numbers.map((n) => `<code>${esc(n.entity_id)}</code> ${esc(n.name)}`).join('<br>')}</div>`).join('')}</details>`;
      }
    }
  }
  return `<div class="card"><h2>Dashboard controls</h2>
    <label class="check"><input type="checkbox" data-g="dashboardHelpers" ${g.dashboardHelpers ? 'checked' : ''}>Make helpers in Home Assistant, to set the app from a dashboard</label>
    <p class="muted small">Per zone: a mode (Auto / Off), a "boost now" button, and the rise trigger, safety net, stop margin, maximum boost and afterrun. The app only reads them; a change on the dashboard is used right away and kept after a restart. Turning this off removes the file.</p>
    ${body}</div>`;
}

function diagView() {
  return `<div class="card"><h2>Diagnostics</h2>
    <p class="small">A file with the settings, the current state, the recent readings and the app log. Attach it to a bug report on GitHub.</p>
    <a class="primary" style="display:inline-block;text-decoration:none" href="api/diagnostics">Download diagnostics</a></div>`;
}

function readInput(inp) {
  if (inp.type === 'checkbox') return inp.checked;
  if (inp.type === 'number') return inp.value === '' ? '' : Number(inp.value);
  return inp.value.trim();
}

function bind() {
  const el = $('#settings-body');
  $$('[data-zone]', el).forEach((card) => {
    const z = draft.zones[Number(card.dataset.zone)];
    $$('[data-k]', card).forEach((inp) => inp.addEventListener('change', () => {
      z[inp.dataset.k] = readInput(inp) === '' && ['humidity', 'temperature'].includes(inp.dataset.k) ? null : readInput(inp);
      markDirty();
      if (['humidity', 'temperature', 'name'].includes(inp.dataset.k)) renderSettings();
    }));
    $$('[data-zact]', card).forEach((inp) => inp.addEventListener('change', () => {
      const id = inp.dataset.zact;
      z.actuators = inp.checked ? [...new Set([...z.actuators, id])] : z.actuators.filter((x) => x !== id);
      markDirty();
    }));
    $('[data-act="del-zone"]', card).onclick = () => { draft.zones.splice(Number(card.dataset.zone), 1); markDirty(); renderSettings(); };
  });
  $$('[data-act-i]', el).forEach((card) => {
    const a = draft.actuators[Number(card.dataset.actI)];
    $$('[data-k]', card).forEach((inp) => inp.addEventListener('change', () => {
      const k = inp.dataset.k;
      a[k] = readInput(inp);
      if (k === 'type') {
        a.entity = null;
        a.fanMode = 'percentage';
        for (const l of ['idle', 'boost', 'afterrun', 'restricted', 'nightMax', 'multiBoost']) a[l] = '';
        if (a.type === 'switch') { a.idle = 'off'; a.boost = 'on'; a.afterrun = 'on'; }
      }
      if (k === 'entity' && a.entity === '') a.entity = null;
      if (k === 'fanMode') for (const l of ['idle', 'boost', 'afterrun', 'restricted', 'nightMax', 'multiBoost']) a[l] = '';
      markDirty();
      if (['type', 'entity', 'fanMode', 'name'].includes(k)) renderSettings();
    }));
    $('[data-act="del-act"]', card).onclick = () => {
      const id = a.id;
      draft.actuators.splice(Number(card.dataset.actI), 1);
      for (const z of draft.zones) z.actuators = z.actuators.filter((x) => x !== id);
      markDirty();
      renderSettings();
    };
  });
  $$('[data-g]', el).forEach((inp) => inp.addEventListener('change', () => {
    draft.general[inp.dataset.g] = readInput(inp);
    markDirty();
    if (['dashboardHelpers', 'liveControl'].includes(inp.dataset.g)) renderSettings();
  }));
  const addZone = $('[data-act="add-zone"]', el);
  if (addZone) addZone.onclick = () => {
    const names = ['Shower', 'Bathroom', 'Toilet', 'Laundry'];
    const name = names.find((n) => !draft.zones.some((z) => z.name === n)) || `Zone ${draft.zones.length + 1}`;
    draft.zones.push({ name, enabled: true, humidity: null, temperature: null, actuators: draft.actuators.filter((a) => a.type === 'fan').map((a) => a.id), ...ZONE_DEFAULTS });
    markDirty();
    renderSettings();
  };
  const sug = $('[data-act="suggest"]', el);
  if (sug) sug.onclick = async () => {
    sug.disabled = true;
    try {
      const r = await api('/api/suggest');
      draft = r.settings;
      suggestNotes = r.notes || [];
      markDirty();
      sub = 'actuators';
      $$('#settings-nav .subtab').forEach((x) => x.classList.toggle('active', x.dataset.sub === sub));
    } catch (err) {
      suggestNotes = [`Could not make a proposal: ${err.message}`];
    }
    renderSettings();
  };
  $$('[data-act="add-act"]', el).forEach((addAct) => addAct.onclick = () => {
    const hasFan = draft.actuators.some((a) => a.type === 'fan');
    const id = `act_${Date.now().toString(36)}`;
    draft.actuators.push(hasFan
      ? { id, name: `Valve ${draft.actuators.length}`, type: 'number', entity: null, fanMode: 'percentage', idle: '', boost: 100, afterrun: '', restricted: 10, nightMax: '', multiBoost: '' }
      : { id, name: 'Ventilation unit', type: 'fan', entity: null, fanMode: 'percentage', idle: 10, boost: 75, afterrun: 50, restricted: '', nightMax: '', multiBoost: '' });
    markDirty();
    sub = 'actuators';
    $$('#settings-nav .subtab').forEach((x) => x.classList.toggle('active', x.dataset.sub === sub));
    renderSettings();
  });
  const addRef = $('[data-act="add-ref"]', el);
  if (addRef) addRef.onclick = () => {
    const v = $('#ref-new').value.trim();
    if (v && !draft.general.references.includes(v)) { draft.general.references.push(v); markDirty(); }
    renderSettings();
  };
  const refNew = $('#ref-new', el);
  if (refNew) refNew.addEventListener('change', () => { if (meta(refNew.value.trim())) addRef.onclick(); });
  bindPickers(el);
  $$('[data-act="del-ref"]', el).forEach((b) => { b.onclick = () => { draft.general.references.splice(Number(b.dataset.i), 1); markDirty(); renderSettings(); }; });
}

$('#save-btn').addEventListener('click', async () => {
  const msg = $('#save-msg');
  msg.innerHTML = '<span class="muted">Saving…</span>';
  try {
    const r = await api('/api/settings', { method: 'POST', body: JSON.stringify(draft) });
    draft = r.settings;
    dirty = false;
    suggestNotes = [];
    dash = await loadDash();
    msg.innerHTML = '<span class="ok">Saved.</span>';
    renderSettings();
    showDirty();
    unsavedGuard.writeDone(true);
  } catch (err) {
    const list = (err.body && err.body.errors) || [err.message];
    msg.innerHTML = `<b style="color:var(--bad)">Not saved:</b><ul class="errors">${list.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`;
    unsavedGuard.writeDone(false, list[0]);
  }
});

// ---------------------------------------------------------------------------

async function render() {
  if (tab === 'home') return renderHome();
  if (tab === 'activity') return renderActivity();
  if (tab === 'settings') {
    if (!draft || !dirty) {
      try { await loadSettings(); } catch (err) { $('#settings-body').innerHTML = `<div class="card">Could not load: ${esc(err.message)}</div>`; return; }
    }
    renderSettings();
  }
}

render();
setInterval(() => { if (tab === 'home') renderHome(); }, 10000);
// Settings › General: follow the helpers appearing in Home Assistant after a reload.
setInterval(async () => {
  if (tab !== 'settings' || sub !== 'general' || !draft || !draft.general.dashboardHelpers) return;
  const before = JSON.stringify(dash);
  dash = await loadDash();
  const typing = document.activeElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName);
  if (JSON.stringify(dash) !== before && !typing) renderSettings();
}, 5000);
// Leaving Settings with unsaved changes asks first (save, discard or stay),
// also when leaving the app. The shared guard is in unsaved.js.
unsavedGuard.init({ nav: '#main-nav .tab' });
$('#discard-btn').addEventListener('click', () => discardSettings());
unsavedGuard.addSource({
  name: 'Settings',
  bar: false, // Settings has its own save bar
  root: () => $('#tab-settings'),
  isDirty: () => dirty,
  save: () => $('#save-btn').click(),
  discard: () => discardSettings(),
});

// Throw away the changes: back to the saved settings.
async function discardSettings() {
  dirty = false;
  suggestNotes = [];
  $('#save-msg').innerHTML = '';
  showDirty();
  await loadSettings();
  renderSettings();
}
