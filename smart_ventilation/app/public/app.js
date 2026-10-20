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
let sub = 'zones';

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
      <p class="muted small">This version is a dry-run: it shows what it would do, and never changes your fan or valves.</p>
      <button class="primary" id="go-setup">Go to Settings</button></div>`;
    $('#go-setup').onclick = () => goTo('settings', 'actuators');
    return;
  }
  const dry = `<div class="card small"><b>Dry-run.</b> The app follows your sensors and shows what it <i>would</i> set. Nothing is sent to the fan or valves, so your current automations keep working.</div>`;
  const zones = status.zones.map(zoneCard).join('');
  const acts = `<div class="card"><h2>Actuators: advice</h2>${status.actuators.map(actRow).join('') || '<div class="muted">No actuators yet.</div>'}</div>`;
  el.innerHTML = dry + zones + acts;
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
    <div class="muted small">${since}</div>
    <svg class="chart" id="chart-${esc(z.id)}" viewBox="0 0 600 170" role="img" aria-label="Humidity of the last 3 hours"></svg>
    <div class="legend"><span><i style="background:var(--accent)"></i>humidity</span><span><i style="background:var(--muted)"></i>reference</span><span><i style="background:var(--warning)"></i>baseline</span><span><i style="background:rgba(var(--rgb-accent),.3);height:8px"></i>boost</span><span><i style="background:rgba(var(--rgb-good),.3);height:8px"></i>afterrun</span></div>
  </div>`;
}

function actRow(a) {
  const unit = a.unit;
  const cmd = a.command ? `<code>${esc(a.command.service)} ${esc(JSON.stringify(a.command.data))}</code>` : '';
  const same = a.current !== null && String(a.current) === String(a.advised);
  return `<div class="act">
    <div class="row wrap"><b>${esc(a.name)}</b><span class="muted small">${esc(a.entity || 'no entity')}</span><span class="spacer"></span>
      <span class="small">now ${fmt(a.current, unit)} → advice <b>${fmt(a.advised, unit)}</b></span>
      ${a.level ? `<span class="chip ${a.level === 'boost' ? 'boost' : a.level === 'afterrun' ? 'afterrun' : ''}">${LEVEL_LABEL[a.level] || a.level}</span>` : ''}</div>
    <div class="muted small">${esc(a.why)}${same ? ' · already at this value' : ''}</div>
    ${cmd ? `<div class="small" style="margin-top:4px">Would send: ${cmd}</div>` : ''}
  </div>`;
}

async function drawChart(zoneId) {
  const svg = document.getElementById(`chart-${zoneId}`);
  if (!svg) return;
  let c;
  try { c = await api(`/api/chart?zone=${encodeURIComponent(zoneId)}`); } catch { return; }
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
  for (let h = 0; h <= 3; h++) {
    const t = c.to - (3 - h) * 3600000;
    out += `<text x="${X(t)}" y="${H - 6}" text-anchor="${h === 0 ? 'start' : h === 3 ? 'end' : 'middle'}" font-size="${fs.toFixed(1)}" style="fill:var(--muted)">${h === 3 ? 'now' : clock(t)}</text>`;
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
    return `<div class="log-item"><div class="row"><span class="muted small">${esc(e.reason || e.type)}</span><span class="spacer"></span><span class="muted small">${when}</span></div></div>`;
  }).join('');
  el.innerHTML = `<div class="card"><h2>Activity</h2><p class="muted small">Zone changes and the values the app would set (dry-run). Newest first.</p>${items}</div>`;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

let draft = null;
let ents = null;
let dirty = false;

const ZONE_DEFAULTS = { riseThreshold: 8, riseWindowMin: 5, absoluteTrigger: 85, stopMargin: 3, minBoostMin: 5, maxBoostMin: 60, afterrunMin: 5, baselineWindowMin: 60, confirmWithTemperature: false, temperatureRise: 1 };

async function loadSettings() {
  [draft, ents] = await Promise.all([api('/api/settings'), api('/api/entities').catch(() => ({}))]);
  dirty = false;
}

function meta(entityId) {
  for (const list of Object.values(ents || {})) {
    const m = list.find((x) => x.entity_id === entityId);
    if (m) return m;
  }
  return null;
}

function datalists() {
  return Object.entries(ents || {}).map(([kind, list]) =>
    `<datalist id="dl-${kind}">${list.map((m) => `<option value="${esc(m.entity_id)}">${esc(m.name)}</option>`).join('')}</datalist>`).join('');
}

function picker(kind, value, attrs, placeholder) {
  const m = value ? meta(value) : null;
  const note = value ? (m ? esc(m.name) + (m.state !== undefined ? ` · now ${esc(m.state)}${m.unit ? ' ' + esc(m.unit) : ''}` : '') : '<span style="color:var(--bad)">not found in Home Assistant</span>') : 'Type to search';
  return `<input list="dl-${kind}" value="${esc(value || '')}" placeholder="${esc(placeholder || 'Search entity…')}" autocomplete="off" ${attrs}><div class="hint">${note}</div>`;
}

function markDirty() {
  dirty = true;
  $('#save-msg').innerHTML = '<span class="muted">Unsaved changes</span>';
}

function renderSettings() {
  if (!draft) return;
  const el = $('#settings-body');
  $('#save-bar').hidden = sub === 'diag';
  if (sub === 'zones') el.innerHTML = datalists() + zonesView();
  else if (sub === 'actuators') el.innerHTML = datalists() + actuatorsView();
  else if (sub === 'general') el.innerHTML = datalists() + generalView();
  else el.innerHTML = diagView();
  bind();
}

function num(label, key, value, min, max, step, hint) {
  return `<div class="field"><label>${label}</label><input type="number" data-k="${key}" value="${esc(value)}" min="${min}" max="${max}" step="${step}">${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
}

function zonesView() {
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
        ${num('Rise trigger (points)', 'riseThreshold', z.riseThreshold, 1, 50, 0.5, 'Humidity rise that counts as a shower')}
        ${num('Within (min)', 'riseWindowMin', z.riseWindowMin, 1, 30, 1)}
        ${num('Absolute trigger (%)', 'absoluteTrigger', z.absoluteTrigger, 40, 100, 1, 'Safety net if the rise is missed')}
        ${num('Stop margin (points)', 'stopMargin', z.stopMargin, 0, 20, 0.5, 'Stop at baseline + this')}
        ${num('Minimum boost (min)', 'minBoostMin', z.minBoostMin, 0, 60, 1)}
        ${num('Maximum boost (min)', 'maxBoostMin', z.maxBoostMin, 5, 240, 1)}
        ${num('Afterrun (min)', 'afterrunMin', z.afterrunMin, 0, 60, 1)}
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
        ${a.type === 'number' || (a.type === 'fan' && a.fanMode !== 'preset') ? levelInput(a, 'nightMax', 'Night maximum', true) : ''}
      </div>
      ${a.type !== 'fan' ? '<div class="hint">"While another zone boosts": close this valve partly (for example 0–25%) so the air comes from the wet room. Leave it empty to keep it at rest.</div>' : '<div class="hint">For a fan, leave "While another zone boosts" empty: a fan shared by more zones simply follows the highest demand.</div>'}
    </div>`;
  }).join('');
  return `${list || '<div class="card muted">No actuators yet. Add the ventilation unit (a fan) and a valve per room.</div>'}
    <button class="secondary" data-act="add-act">+ Add actuator</button>`;
}

function generalView() {
  const g = draft.general;
  return `<div class="card"><h2>Reference sensors</h2>
      <p class="muted small">Optional. Humidity sensors in other rooms. The app uses their median to ignore weather (the whole house getting humid) and to know when the bathroom is back to normal.</p>
      <div class="refs">${g.references.map((r, i) => `<span class="chip">${esc((meta(r) || {}).name || r)} <button data-act="del-ref" data-i="${i}" aria-label="Remove">✕</button></span>`).join('') || '<span class="muted small">None chosen.</span>'}</div>
      <div class="row"><div style="flex:1">${picker('humidity', '', 'id="ref-new"')}</div><button class="secondary" data-act="add-ref">Add</button></div>
    </div>
    <div class="card"><h2>Night</h2>
      <label class="check"><input type="checkbox" data-g="nightEnabled" ${g.nightEnabled ? 'checked' : ''}>Use the night maximum of the actuators during this time</label>
      <div class="grid2">
        <div class="field"><label>From</label><input type="time" data-g="nightStart" value="${esc(g.nightStart)}"></div>
        <div class="field"><label>Until</label><input type="time" data-g="nightEnd" value="${esc(g.nightEnd)}"></div>
      </div>
    </div>
    <div class="card"><h2>Sensors</h2>
      ${num('Sensor timeout (min)', 'sensorTimeoutMin', g.sensorTimeoutMin, 5, 720, 5, 'No reading for this long counts as a sensor problem: the zone goes back to rest.').replace('data-k=', 'data-g=')}
    </div>`;
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
        for (const l of ['idle', 'boost', 'afterrun', 'restricted', 'nightMax']) a[l] = '';
        if (a.type === 'switch') { a.idle = 'off'; a.boost = 'on'; a.afterrun = 'on'; }
      }
      if (k === 'entity' && a.entity === '') a.entity = null;
      if (k === 'fanMode') for (const l of ['idle', 'boost', 'afterrun', 'restricted', 'nightMax']) a[l] = '';
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
  $$('[data-g]', el).forEach((inp) => inp.addEventListener('change', () => { draft.general[inp.dataset.g] = readInput(inp); markDirty(); }));
  const addZone = $('[data-act="add-zone"]', el);
  if (addZone) addZone.onclick = () => {
    const names = ['Shower', 'Bathroom', 'Toilet', 'Laundry'];
    const name = names.find((n) => !draft.zones.some((z) => z.name === n)) || `Zone ${draft.zones.length + 1}`;
    draft.zones.push({ name, enabled: true, humidity: null, temperature: null, actuators: draft.actuators.filter((a) => a.type === 'fan').map((a) => a.id), ...ZONE_DEFAULTS });
    markDirty();
    renderSettings();
  };
  const addAct = $('[data-act="add-act"]', el);
  if (addAct) addAct.onclick = () => {
    const hasFan = draft.actuators.some((a) => a.type === 'fan');
    const id = `act_${Date.now().toString(36)}`;
    draft.actuators.push(hasFan
      ? { id, name: `Valve ${draft.actuators.length}`, type: 'number', entity: null, fanMode: 'percentage', idle: '', boost: 100, afterrun: '', restricted: 10, nightMax: '' }
      : { id, name: 'Ventilation unit', type: 'fan', entity: null, fanMode: 'percentage', idle: 10, boost: 75, afterrun: 50, restricted: '', nightMax: '' });
    markDirty();
    renderSettings();
  };
  const addRef = $('[data-act="add-ref"]', el);
  if (addRef) addRef.onclick = () => {
    const v = $('#ref-new').value.trim();
    if (v && !draft.general.references.includes(v)) { draft.general.references.push(v); markDirty(); }
    renderSettings();
  };
  $$('[data-act="del-ref"]', el).forEach((b) => { b.onclick = () => { draft.general.references.splice(Number(b.dataset.i), 1); markDirty(); renderSettings(); }; });
}

$('#save-btn').addEventListener('click', async () => {
  const msg = $('#save-msg');
  msg.innerHTML = '<span class="muted">Saving…</span>';
  try {
    const r = await api('/api/settings', { method: 'POST', body: JSON.stringify(draft) });
    draft = r.settings;
    dirty = false;
    msg.innerHTML = '<span class="ok">Saved.</span>';
    renderSettings();
  } catch (err) {
    const list = (err.body && err.body.errors) || [err.message];
    msg.innerHTML = `<b style="color:var(--bad)">Not saved:</b><ul class="errors">${list.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`;
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
window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
