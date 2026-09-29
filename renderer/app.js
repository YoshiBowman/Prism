'use strict';

// ── State ────────────────────────────────────────────────────────────────────

const state = {
  connected: false,
  bridge: null,
  artnetRunning: false,
  lights: [],
  settings: {},
  pairing: false,
  rebooting: false,
  dmxActive: false,
  selectedId: null,     // Patch inspector
  activeScene: null,    // Control rail highlight
};

// Per-universe DMX frame cache — keyed by universe number, updated on artnet:dmx-update
const dmxByUniverse = {};

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function inTextField(el) {
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

// ── Toast ─────────────────────────────────────────────────────────────────────

function toast(message, type = 'info') {
  const stack = $('toast-stack');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

const TAB_ALIASES = { lights: 'patch', monitor: 'log', bridge: 'setup', settings: 'setup' };
const tabs   = document.querySelectorAll('.tab');
const panels = document.querySelectorAll('.panel');
let currentTab = 'setup';

function showTab(name) {
  name = TAB_ALIASES[name] || name;
  currentTab = name;
  tabs.forEach(t   => t.classList.toggle('active', t.dataset.tab === name));
  panels.forEach(p => p.classList.toggle('active', p.id === `panel-${name}`));
  document.querySelectorAll('.tab-actions').forEach(a => a.classList.toggle('active', a.dataset.for === name));

  if (name === 'patch' && state.connected) refreshLights();
  if (name === 'setup') refreshSettings();
  if (name === 'log') loadEventLog();
  if (name === 'control') {
    // Landing here before the lights have loaded (e.g. restored last tab on
    // launch) — fetch them so the grid isn't empty.
    if (state.connected && state.lights.length === 0) refreshLights();
    buildControlCards(state.lights);
    loadScenes();
    refreshControlSwatches();
  }
}

tabs.forEach(t => t.addEventListener('click', () => {
  showTab(t.dataset.tab);
  window.hue.saveSettings({ lastTab: t.dataset.tab });
}));

document.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => {
  showTab(b.dataset.goto);
  window.hue.saveSettings({ lastTab: b.dataset.goto });
}));

// ── Universe / light helpers ─────────────────────────────────────────────────

function protocol() { return (state.settings && state.settings.protocol) || 'artnet'; }

function defaultUniverse() {
  const cfg = state.settings || {};
  return protocol() === 'sacn' ? (cfg.sacnUniverse ?? 1) : (cfg.universe ?? 0);
}

function lightUniverse(light) {
  return light.dmx?.universe ?? light.customAddress?.universe ?? defaultUniverse();
}

function channelNames(light) {
  return light.dmx ? light.dmx.labels.map(l => l.split(':')[1]) : [];
}

const MODE_INFO = {
  rgb: { short: 'RGB',  title: 'Color',         seg: 'RGB · 3' },
  ct:  { short: 'I·CT', title: 'Tunable white', seg: 'I·CT · 2' },
  dim: { short: 'I',    title: 'Dimmer',        seg: 'I · 1' },
};
const CH_CLASS = { R: 'm-r', G: 'm-g', B: 'm-b', Int: 'm-i', Bri: 'm-i', CT: 'm-ct' };
const CH_LABEL = { R: 'Red', G: 'Green', B: 'Blue', Int: 'Int', Bri: 'Int', CT: 'CT' };

function isColorLight(light) {
  // Hue types: "Extended color light", "Color light", "Color temperature light", "Dimmable light"
  return !light.type || /^(extended )?color light$/i.test(light.type.trim());
}

function isUnreachable(light) {
  return !!(light.state && light.state.reachable === false);
}

function hexToRgb(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Incoming DMX values for a light's footprint (zeros when nothing received)
function dmxValues(light) {
  if (!light.dmx) return [];
  const buf = dmxByUniverse[lightUniverse(light)] || [];
  const off = light.dmx.start - 1;
  const out = [];
  for (let j = 0; j < light.dmx.channels; j++) out.push(buf[off + j] || 0);
  return out;
}

// DMX values → full-intensity color [r,g,b] plus intensity k (0..1).
// Mirrors main: 'ct' channel 0 = cold (153 mireds) … 255 = warm (500).
function colorFromDmx(light, vals) {
  const mode = light.dmx?.mode || 'rgb';
  if (mode === 'rgb') {
    const max = Math.max(vals[0] || 0, vals[1] || 0, vals[2] || 0);
    if (!max) return { c: [0, 0, 0], k: 0 };
    return { c: [vals[0], vals[1], vals[2]].map(v => (v * 255) / max), k: max / 255 };
  }
  const k = (vals[0] || 0) / 255;
  if (mode === 'ct') {
    const w = (vals[1] || 0) / 255;
    return { c: [222 + 33 * w, 232 - 52 * w, 255 - 148 * w], k };
  }
  return { c: [255, 214, 170], k };
}

function colorFromControl(s) {
  if (!s) return { c: [0, 0, 0], k: 0 };
  return { c: hexToRgb(s.rgb || '#ffcc66'), k: s.on ? (s.bri || 0) / 100 : 0 };
}

function cssColor({ c, k }) {
  if (!k) return null;
  const s = Math.max(0.2, k);
  return `rgb(${c.map(v => Math.round(v * s)).join(', ')})`;
}

// What a light is actually doing right now: DMX when a signal is live and the
// light is patched in, otherwise the last manual/bridge state.
function liveColor(light) {
  if (signalLive() && !light.disabled && light.dmx) return colorFromDmx(light, dmxValues(light));
  return colorFromControl(controlState[light.id]);
}

// ── Ambient background ───────────────────────────────────────────────────────
// Fixtures in rig order are bucketed left→right; each bucket's color is the
// level-weighted mix of its lights, blended into the dark base by `ambient`.

const BASE = [15, 16, 18];
let ambientQueued = false;

function scheduleAmbient() {
  if (ambientQueued) return;
  ambientQueued = true;
  requestAnimationFrame(() => { ambientQueued = false; paintAmbient(); });
}

function paintAmbient() {
  const app = $('app');
  const strength = (state.settings.ambient ?? 45) / 100;
  const lights = state.connected
    ? state.lights.filter(l => !l.disabled && !isUnreachable(l)).map(liveColor)
    : [];
  if (!lights.length || strength === 0) { app.style.backgroundImage = 'none'; return; }

  const N = 5;
  const stops = [];
  for (let i = 0; i < N; i++) {
    const chunk = lights.filter((_, j) => Math.floor((j * N) / lights.length) === i);
    let w = 0, r = 0, g = 0, b = 0;
    for (const l of chunk) { w += l.k; r += l.c[0] * l.k; g += l.c[1] * l.k; b += l.c[2] * l.k; }
    const col = w > 0 ? [r / w, g / w, b / w] : BASE;
    const m = strength * (chunk.length ? Math.min(1, w / chunk.length) : 0);
    stops.push(`rgb(${col.map((v, j) => Math.round(BASE[j] + (v - BASE[j]) * m)).join(', ')})`);
  }
  app.style.backgroundImage =
    'linear-gradient(180deg, rgba(15,16,18,0) 0%, rgba(15,16,18,0.5) 50%, rgba(15,16,18,0.92) 100%), ' +
    `linear-gradient(90deg, ${stops.join(', ')})`;
}

// ── Status strip ─────────────────────────────────────────────────────────────

function protoLabel(p = protocol()) {
  return p === 'sacn' ? 'sACN' : p === 'both' ? 'Art-Net + sACN' : 'Art-Net';
}

function setDot(el, kind) {
  el.className = 'dot' + (kind ? ` dot-${kind}` : '') + (kind === 'warn' ? ' pulse' : '');
}

function paintBridgeStatus() {
  const dot = $('sb-bridge-dot'), val = $('sb-bridge-value');
  if (state.rebooting)      { setDot(dot, 'warn'); val.textContent = 'Restarting…'; }
  else if (state.pairing)   { setDot(dot, 'warn'); val.textContent = 'Pairing…'; }
  else if (state.connected) { setDot(dot, 'ok');   val.textContent = state.bridge || 'Connected'; }
  else                      { setDot(dot, 'bad');  val.textContent = 'Not connected'; }
  val.classList.toggle('bad', !state.connected && !state.pairing && !state.rebooting);
}

function paintInputStatus() {
  const cfg = state.settings || {};
  const p = protocol();
  $('sb-input-label').textContent = p === 'both'
    ? `Art-Net ${cfg.universe ?? 0} · sACN ${cfg.sacnUniverse ?? 1}`
    : `${protoLabel(p)} U${defaultUniverse()}`;

  const dot = $('sb-input-dot'), val = $('sb-input-value');
  if (!state.artnetRunning)  { setDot(dot, null); val.textContent = 'Off'; }
  else if (signalLive())     { setDot(dot, 'ok'); val.textContent = packetRate ? `${packetRate} Hz` : 'Receiving'; }
  else if (lastPacketMs)     { setDot(dot, 'bad'); val.textContent = 'Signal lost'; }
  else                       { setDot(dot, null); val.textContent = 'Listening · no signal'; }

  const btn = $('btn-listen');
  btn.setAttribute('aria-checked', String(!!state.artnetRunning));
  btn.disabled = state.rebooting && !state.artnetRunning;
}

function paintFixtureHealth() {
  const dot = $('sb-fixtures-dot'), val = $('sb-fixtures-value');
  if (!state.connected || state.lights.length === 0) { setDot(dot, null); val.textContent = '—'; val.classList.remove('bad'); return; }
  const down = state.lights.filter(l => !l.disabled && isUnreachable(l)).length;
  setDot(dot, down ? 'bad' : 'ok');
  val.textContent = down ? `${down} not responding` : 'All responding';
  val.classList.toggle('bad', down > 0);
}

// ── Listener ─────────────────────────────────────────────────────────────────

async function listenerStart() {
  const res = await window.hue.startArtnet();
  if (!res.success) toast(`Listener failed: ${res.message || ''}`, 'error');
}

async function listenerStop() {
  await window.hue.stopArtnet();
  setListenerRunning(false);
}

function setListenerRunning(running, error) {
  state.artnetRunning = !!running;
  if (error) toast(`${protoLabel()} listener error`, 'error');
  paintInputStatus();
}

$('btn-listen').addEventListener('click', () => (state.artnetRunning ? listenerStop() : listenerStart()));
window.hue.on('artnet:status', ({ running, error }) => setListenerRunning(running, error));

// ── Blackout + keyboard ──────────────────────────────────────────────────────

async function blackout() {
  for (const light of state.lights) { const s = controlState[light.id]; if (s) s.on = false; }
  persistControlState();
  repaintAllTiles();
  await window.hue.allLightsOff().catch(() => {});
}
$('btn-blackout').addEventListener('click', blackout);

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); blackout(); return; }
  if (mod && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    if (currentTab !== 'patch') showTab('patch');
    $('patch-filter').focus();
    $('patch-filter').select();
    return;
  }
  if (e.key === 'Escape') {
    closeModalsOnEscape();
    if (currentTab === 'control') clearSelection();
    return;
  }
  if (inTextField(document.activeElement)) return;

  if (currentTab === 'control' && !state.dmxActive) {
    if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAll(); return; }
    if (!mod && /^[1-9]$/.test(e.key)) {
      const name = Object.keys(scenesCache)[Number(e.key) - 1];
      if (name) { e.preventDefault(); applyScene(name); }
    }
  }
  if (currentTab === 'patch' && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    const rows = [...patchRows.querySelectorAll('.prow:not([hidden])')];
    if (!rows.length) return;
    e.preventDefault();
    let i = rows.findIndex(r => r.dataset.id === String(state.selectedId));
    i = e.key === 'ArrowDown' ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
    selectFixture(rows[i].dataset.id);
    rows[i].focus();
  }
});

// ── Bridge (Setup tab) ───────────────────────────────────────────────────────

const bridgeList       = $('bridge-list');
const pairCountdown    = $('pair-countdown');
const pairMessage      = $('pair-message');
const pairTimerBar     = $('pair-timer-bar');
const pairStepVerify   = $('pair-step-verify');
const pairStepLink     = $('pair-step-link');
const manualIpInput    = $('manual-ip');

function setPairDialogVisible(v) { $('pair-modal-overlay').hidden = !v; }

function setBridgeStatus(connected, bridge, connecting) {
  state.connected = connected;
  state.bridge    = bridge;
  state.pairing   = !!connecting && state.pairing;
  $('bridge-status-dot').className = 'dot ' + (connecting ? 'dot-warn pulse' : connected ? 'dot-ok' : 'dot-bad');
  $('bridge-status-text').textContent = connecting ? 'Connecting…'
    : connected ? `Connected to ${bridge}` : 'Not connected';
  $('btn-disconnect').hidden = !connected;
  $('discover-block').hidden = connected;
  $('btn-scan').disabled = !!connecting;
  $('btn-reboot-bridge').disabled = !connected || state.rebooting;
  paintBridgeStatus();
  paintFixtureHealth();
  scheduleAmbient();
}

const scanProgressWrap  = $('scan-progress-wrap');
const scanProgressBar   = $('scan-progress-bar');
const scanProgressLabel = $('scan-progress-label');

window.hue.on('bridge:found', (bridge) => {
  const placeholder = bridgeList.querySelector('.empty');
  if (placeholder) placeholder.remove();
  bridgeList.appendChild(buildBridgeItem(bridge));
});

window.hue.on('bridge:scan-progress', ({ phase, completed, total, subnets }) => {
  const steps = {
    saved: [3,  'Checking the last known bridge address…'],
    arp:   [10, 'Checking the ARP cache for Hue bridges…'],
    ssdp:  [20, 'Sending UPnP/SSDP discovery on all interfaces…'],
    mdns:  [30, 'Searching via mDNS…'],
  };
  if (steps[phase]) {
    scanProgressBar.style.width = `${steps[phase][0]}%`;
    scanProgressLabel.textContent = steps[phase][1];
  } else {
    scanProgressBar.style.width = `${30 + Math.round((completed / total) * 70)}%`;
    scanProgressLabel.textContent = `Scanning ${subnets.map(s => s + '.0/24').join(', ')} — ${completed}/${total} hosts`;
  }
});

$('btn-show-subnets').addEventListener('click', async () => {
  const preview = $('subnet-preview');
  const subnets = await window.hue.getScanSubnets();
  const extra   = parseExtraSubnet();
  const all     = extra ? [...new Set([...subnets, extra])] : subnets;
  preview.hidden = false;
  preview.textContent = `Will scan: ${all.map(s => s + '.0/24').join(', ') || 'none'}`;
});

function parseExtraSubnet() {
  const raw   = $('extra-subnet').value.trim();
  if (!raw) return null;
  const parts = raw.replace(/\/\d+$/, '').split('.');
  return parts.length >= 3 ? parts.slice(0, 3).join('.') : null;
}

function setScanRunning(running) {
  $('btn-scan').hidden        = running;
  $('btn-cancel-scan').hidden = !running;
  scanProgressWrap.hidden     = !running;
}

$('btn-cancel-scan').addEventListener('click', () => {
  window.hue.cancelScan();
  setScanRunning(false);
  scanProgressLabel.textContent = 'Scan cancelled';
  scanProgressWrap.hidden = false;
});

$('btn-scan').addEventListener('click', async () => {
  bridgeList.innerHTML = '<div class="empty">Scanning — bridges appear here as they are found…</div>';
  scanProgressBar.style.width   = '0%';
  scanProgressLabel.textContent = 'Starting scan…';
  setScanRunning(true);

  const res = await window.hue.discoverBridges($('discover-nic').value, parseExtraSubnet() ? [parseExtraSubnet()] : []);

  setScanRunning(false);
  scanProgressBar.style.width = '100%';

  if (!res.success) {
    bridgeList.innerHTML = `<div class="empty">Scan error: ${esc(res.error)}</div>`;
    scanProgressWrap.hidden = true;
    return;
  }
  const count = res.bridges.length;
  scanProgressWrap.hidden = false;
  scanProgressLabel.textContent = count > 0 ? `Scan complete — ${count} bridge${count !== 1 ? 's' : ''} found` : 'Scan complete';
  if (count === 0 && !bridgeList.querySelector('.bridge-item')) {
    bridgeList.innerHTML = `<div class="empty">No bridges found. The scan only reaches subnets this computer can see — a bridge on another VLAN won't announce itself. If you know its IP, connect by IP below, or add its subnet above and scan again.</div>`;
  }
});

function buildBridgeItem(b) {
  const div = document.createElement('div');
  div.className = 'bridge-item';
  div.innerHTML = `
    <div class="bi-info"><div class="bi-name">${esc(b.name || 'Hue Bridge')}</div><div class="bi-ip">${esc(b.ip)}</div></div>
    <button class="btn btn-primary btn-sm">Connect</button>`;
  div.querySelector('button').addEventListener('click', () => startPair(b.ip));
  return div;
}

$('btn-manual-connect').addEventListener('click', () => {
  const ip = manualIpInput.value.trim();
  if (ip) startPair(ip);
});
manualIpInput.addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-manual-connect').click(); });

function onConnected(name) {
  setPairDialogVisible(false);
  state.pairing = false;
  window.hue.bridgeStatus().then(s => setBridgeStatus(true, s.bridge));
  bridgeList.innerHTML = '';
  scanProgressWrap.hidden = true;
  manualIpInput.value = '';
  toast(name ? `Connected to ${name}` : 'Bridge paired — loading lights…', 'success');
  showTab('patch');
}

async function startPair(ip) {
  if (state.pairing) return;
  state.pairing = true;
  setBridgeStatus(false, null, true);

  $('pair-verify-label').innerHTML = `Checking bridge at <span class="mono">${esc(ip)}</span>…`;
  pairStepVerify.hidden = false;
  pairStepLink.hidden   = true;
  pairMessage.textContent = '';
  setPairDialogVisible(true);

  const verify = await window.hue.verifyBridge(ip);
  if (!verify.success) {
    state.pairing = false;
    setPairDialogVisible(false);
    setBridgeStatus(false, null, false);
    toast(`No bridge at ${ip} — check the address`, 'error');
    return;
  }
  if (verify.autoConnected) {
    setBridgeStatus(true, ip);
    onConnected(verify.name || ip);
    return;
  }

  $('pair-bridge-name').textContent = verify.name + (verify.bridgeid ? ` (${verify.bridgeid.slice(-6)})` : '');
  pairStepVerify.hidden = true;
  pairStepLink.hidden   = false;
  pairCountdown.textContent = '30';
  pairTimerBar.style.width  = '100%';
  await window.hue.startPair(ip);
}

window.hue.on('bridge:pair-event', (event) => {
  if (event.type === 'waiting') {
    pairCountdown.textContent = event.remaining;
    pairTimerBar.style.width  = `${Math.round((event.remaining / 30) * 100)}%`;
    pairMessage.textContent   = '';
  } else if (event.type === 'success') {
    setBridgeStatus(true, state.bridge || '');
    onConnected();
  } else if (event.type === 'error') {
    state.pairing = false;
    setPairDialogVisible(false);
    setBridgeStatus(false, null, false);
    toast(`Pairing failed: ${event.message}`, 'error');
  } else if (event.type === 'timeout') {
    state.pairing = false;
    pairStepLink.hidden   = true;
    pairStepVerify.hidden = false;
    $('pair-verify-label').textContent = 'Timed out — the link button wasn\'t pressed. Try again.';
    setBridgeStatus(false, null, false);
    toast('Timed out — press the link button within 30 s, then retry', 'error');
  }
});

function cancelPairing() {
  state.pairing = false;
  setPairDialogVisible(false);
  setBridgeStatus(false, null, false);
}
$('btn-cancel-pair').addEventListener('click', cancelPairing);

$('btn-disconnect').addEventListener('click', async () => {
  await window.hue.disconnect();
  setBridgeStatus(false, null, false);
  state.lights = [];
  renderPatch();
  buildControlCards([]);
  toast('Disconnected from bridge', 'info');
});

function closeModalsOnEscape() {
  if (!$('reboot-modal-overlay').hidden) $('reboot-modal-overlay').hidden = true;
  if (!$('pair-modal-overlay').hidden) cancelPairing();
}

// ── Bridge restart (reboot) flow ─────────────────────────────────────────────

const bridgeCard       = $('bridge-card');
const rebootPanel      = $('reboot-status-panel');
const rebootTitle      = $('reboot-status-title');
const rebootMsg        = $('reboot-status-msg');
const rebootManualBtn  = $('btn-reboot-manual');
const rebootCancelLink = $('reboot-cancel-link');
const offlineBanner    = $('offline-banner');
const rebootModal      = $('reboot-modal-overlay');

let rebootElapsedTimer = null;
let rebootStartedAt    = 0;

function showBridgeConnectionUI() { bridgeCard.hidden = false; rebootPanel.hidden = true; }
function showRebootStatusUI() {
  bridgeCard.hidden = true;
  rebootPanel.hidden = false;
  rebootManualBtn.hidden = true;
  rebootCancelLink.hidden = false;
}
function stopRebootElapsedTicker() {
  if (rebootElapsedTimer) { clearInterval(rebootElapsedTimer); rebootElapsedTimer = null; }
}
function exitRebootUI() {
  state.rebooting = false;
  stopRebootElapsedTicker();
  offlineBanner.hidden = true;
  showBridgeConnectionUI();
  paintBridgeStatus();
  paintInputStatus();
}

$('btn-reboot-bridge').addEventListener('click', async () => {
  let dmxActive = false;
  try { dmxActive = await window.hue.dmxIsActive(); } catch {}
  $('reboot-modal-dmx-warn').hidden = !dmxActive;
  rebootModal.hidden = false;
});
$('btn-reboot-cancel').addEventListener('click', () => { rebootModal.hidden = true; });
$('btn-reboot-confirm').addEventListener('click', async () => {
  rebootModal.hidden = true;
  const res = await window.hue.rebootBridge();
  if (!res || !res.success) toast(`Restart failed: ${(res && res.error) || 'unknown error'}`, 'error');
  // Success path is driven by the bridge:reboot-* events below.
});

rebootCancelLink.addEventListener('click', async () => {
  await window.hue.cancelReboot().catch(() => {});
  exitRebootUI();
  setBridgeStatus(false, state.bridge, false);
  toast('Bridge restart cancelled', 'info');
});

rebootManualBtn.addEventListener('click', async () => {
  rebootMsg.textContent = 'Reconnecting…';
  rebootManualBtn.disabled = true;
  const res = await window.hue.connectSaved().catch(() => ({ success: false }));
  rebootManualBtn.disabled = false;
  if (res && res.success) {
    exitRebootUI();
    setBridgeStatus(true, res.bridge || state.bridge, false);
    refreshLights();
    toast('Bridge back online', 'success');
  } else {
    rebootMsg.textContent = 'No bridge at the saved address. Try scanning for it.';
  }
});

let rebootPhaseTitle = 'Restarting bridge…';
let rebootPhaseMsg   = 'Sending restart command…';
function paintRebootStatus() {
  const s = Math.round((Date.now() - rebootStartedAt) / 1000);
  rebootTitle.textContent = rebootPhaseTitle;
  rebootMsg.textContent   = `${rebootPhaseMsg} (${s}s)`;
}

window.hue.on('bridge:reboot-started', () => {
  state.rebooting = true;
  rebootStartedAt = Date.now();
  showRebootStatusUI();
  offlineBanner.hidden = false;
  $('btn-reboot-bridge').disabled = true;
  rebootPhaseTitle = 'Restarting bridge…';
  rebootPhaseMsg   = 'Waiting for the bridge to go offline';
  paintRebootStatus();
  paintBridgeStatus();
  paintInputStatus();
  toast('Bridge restarting — reconnecting automatically', 'warn');
  stopRebootElapsedTicker();
  rebootElapsedTimer = setInterval(paintRebootStatus, 1000);
});

window.hue.on('bridge:reboot-reconnecting', ({ attempt, phase }) => {
  const phases = {
    'going-offline':     ['Restarting bridge…', 'Waiting for the bridge to go offline'],
    'offline-confirmed': ['Bridge went offline', 'Waiting for it to come back online'],
    'reconnecting':      ['Reconnecting…', `Bridge is back — reconnecting (attempt ${attempt})`],
  };
  [rebootPhaseTitle, rebootPhaseMsg] = phases[phase] || ['Waiting for bridge…', 'Waiting for it to come back online'];
  paintRebootStatus();
});

window.hue.on('bridge:reboot-complete', ({ elapsed, didReboot, connected }) => {
  stopRebootElapsedTicker();
  rebootCancelLink.hidden = true;
  offlineBanner.hidden = true;
  if (didReboot) {
    rebootTitle.textContent = 'Bridge reconnected';
    rebootMsg.textContent   = `Restarted and reconnected after ${elapsed}s.`;
    toast('Bridge back online', 'success');
  } else {
    rebootTitle.textContent = 'Bridge did not restart';
    rebootMsg.textContent   = 'It never went offline — this firmware may not support remote restart. Still connected; power-cycle it by hand if needed.';
    toast('Bridge did not appear to restart', 'warn');
  }
  setBridgeStatus(!!connected, state.bridge, false);
  setTimeout(() => {
    exitRebootUI();
    if (state.connected) refreshLights();
  }, didReboot ? 3000 : 6000);
});

window.hue.on('bridge:reboot-timeout', () => {
  stopRebootElapsedTicker();
  state.rebooting = false;
  rebootTitle.textContent = 'Reconnect timed out';
  rebootMsg.textContent   = 'The bridge did not come back at its saved address. Try scanning for it.';
  rebootManualBtn.hidden = false;
  offlineBanner.hidden = true;
  paintBridgeStatus();
  paintInputStatus();
  toast('Bridge reconnect timed out — connect manually', 'error');
});

window.hue.on('bridge:auto-connect', async ({ connected, bridge }) => {
  await refreshSettings();
  setBridgeStatus(connected, bridge, false);
  if (connected) {
    bridgeList.innerHTML = '';
    scanProgressWrap.hidden = true;
    toast(`Connected to ${bridge}`, 'success');
    const saved = TAB_ALIASES[state.settings.lastTab] || state.settings.lastTab;
    showTab(saved && saved !== 'setup' ? saved : 'patch');
  }
});

window.hue.on('bridge:unreachable', () => toast('Bridge not responding — check the connection or re-scan in Setup', 'error'));
window.hue.on('bridge:reachable',   () => toast('Bridge connection restored', 'success'));

// ── Per-bulb reachability ────────────────────────────────────────────────────

function setLightReachableUI(id, reachable) {
  const light = state.lights.find(l => String(l.id) === String(id));
  if (light) {
    if (!light.state) light.state = {};
    light.state.reachable = reachable;
  }
  renderPatch();
  const tile = controlGrid.querySelector(`[data-light-id="${id}"]`);
  if (tile && light) paintTile(tile, light);
  paintFixtureHealth();
  scheduleAmbient();
  return light;
}

window.hue.on('bulb-unreachable', ({ id }) => {
  const light = setLightReachableUI(id, false);
  toast(`"${light ? light.name : `Light ${id}`}" not responding — auto-recovery on`, 'warn');
});
window.hue.on('bulb-recovered', ({ id }) => {
  const light = setLightReachableUI(id, true);
  toast(`"${light ? light.name : `Light ${id}`}" back online`, 'success');
});

// ── Patch ────────────────────────────────────────────────────────────────────

const patchRows = $('patch-rows');
const inspector = $('inspector');
let dragSrc = null;

$('btn-refresh-lights').addEventListener('click', refreshLights);
$('patch-filter').addEventListener('input', applyPatchFilter);

async function refreshLights() {
  if (!state.connected) { renderPatch(); return; }
  try {
    const res = await window.hue.getLights();
    state.lights = res.lights || [];
  } catch (err) {
    console.error('[refreshLights]', err);
    toast(`Couldn't load lights: ${err.message}`, 'error');
    return;
  }
  renderPatch();
  buildControlCards(state.lights);
  paintFixtureHealth();
  scheduleAmbient();
}

// Overlapping footprints among patched (non-parked) fixtures in the same universe
function findOverlaps() {
  const out = {};
  const active = state.lights.filter(l => l.dmx && !l.disabled);
  for (const a of active) {
    const aEnd = a.dmx.start + a.dmx.channels - 1;
    for (const b of active) {
      if (a === b || lightUniverse(a) !== lightUniverse(b)) continue;
      const bEnd = b.dmx.start + b.dmx.channels - 1;
      if (a.dmx.start <= bEnd && b.dmx.start <= aEnd) { out[a.id] = b; break; }
    }
  }
  return out;
}

function renderPatch() {
  if (!state.connected) {
    patchRows.innerHTML = '<div class="empty">Connect to a bridge in Setup to load your lights.</div>';
    inspector.innerHTML = '<div class="empty">Select a fixture to inspect its patch and incoming values.</div>';
    $('patch-summary').textContent = '';
    return;
  }
  if (state.lights.length === 0) {
    patchRows.innerHTML = '<div class="empty">No lights on this bridge yet. Use Find lights to add bulbs — make sure they are powered on.</div>';
    renderInspector();
    $('patch-summary').textContent = '';
    return;
  }

  const overlaps = findOverlaps();
  patchRows.innerHTML = '';
  for (const light of state.lights) patchRows.appendChild(buildPatchRow(light, overlaps[light.id]));
  applyPatchFilter();

  // Summary
  const byU = {};
  for (const l of state.lights) if (l.dmx && !l.disabled) byU[lightUniverse(l)] = (byU[lightUniverse(l)] || 0) + l.dmx.channels;
  const parked = state.lights.filter(l => l.disabled).length;
  $('patch-summary').textContent = [
    `${state.lights.length} fixture${state.lights.length !== 1 ? 's' : ''}`,
    ...Object.keys(byU).sort((a, b) => a - b).map(u => `U${u}: ${byU[u]} ch`),
    `${parked} parked`,
  ].join('  ·  ');

  if (state.selectedId == null || !state.lights.some(l => String(l.id) === String(state.selectedId))) {
    state.selectedId = state.lights[0].id;
  }
  markSelectedRow();
  renderInspector();
  updatePatchLive();
}

function buildPatchRow(light, overlapWith) {
  const row = document.createElement('div');
  row.className = 'prow' + (light.disabled ? ' parked' : '');
  row.dataset.id = light.id;
  row.draggable = true;
  row.tabIndex = 0;

  const dmx = light.dmx;
  const names = channelNames(light);
  const mode = MODE_INFO[dmx?.mode || 'rgb'];
  const custom = !!light.customAddress;
  const range = dmx ? (dmx.channels > 1 ? `${dmx.start}–${dmx.start + dmx.channels - 1}` : `${dmx.start}`) : '—';

  let statusCls = '', statusDot = 'ok', statusText = 'OK';
  if (light.disabled)           { statusCls = 'muted'; statusDot = null;  statusText = 'Parked'; }
  else if (overlapWith)         { statusCls = 'bad';   statusDot = 'bad'; statusText = `Overlaps #${overlapWith.id}`; }
  else if (isUnreachable(light)) { statusCls = 'bad';  statusDot = 'bad'; statusText = 'No response'; }

  row.innerHTML = `
    <span class="c-id p-id">${esc(light.id)}</span>
    <span class="c-name p-name-wrap"><span class="swatch"></span><span class="p-name">${esc(light.name)}</span></span>
    <span class="c-type p-type"><b>${mode.short}</b><i>${dmx ? dmx.channels : '–'}ch</i></span>
    <span class="c-patch p-patch${custom ? ' custom' : ''}" title="${custom ? 'Custom patch' : 'Sequential patch'}">${dmx ? `${lightUniverse(light)}/${dmx.start}` : '—'}</span>
    <span class="c-range p-range">${range}</span>
    <span class="c-out p-out"><span class="meters">${names.map(n => `<span class="meter ${CH_CLASS[n] || 'm-i'}"></span>`).join('')}</span><span class="p-int">—</span></span>
    <span class="c-status p-status ${statusCls}"><span class="dot${statusDot ? ' dot-' + statusDot : ''}"></span>${esc(statusText)}</span>
    <label class="c-park"><input type="checkbox" ${light.disabled ? 'checked' : ''} aria-label="Park ${esc(light.name)}"></label>`;

  row.addEventListener('click', (e) => {
    if (e.target.closest('.c-park')) return;
    selectFixture(light.id);
  });
  row.addEventListener('keydown', (e) => {
    if (e.target !== row) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectFixture(light.id); }
  });

  // Park = excluded from the DMX mapping (keeps its last state)
  row.querySelector('.c-park input').addEventListener('change', async () => {
    await window.hue.toggleDisabled(light.id);
    refreshLights();
  });

  // Drag-and-drop reorder — sets the sequential patch order
  row.addEventListener('dragstart', (e) => { dragSrc = row; row.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
  row.addEventListener('dragend',   () => { row.classList.remove('dragging'); patchRows.querySelectorAll('.drag-over').forEach(r => r.classList.remove('drag-over')); });
  row.addEventListener('dragover',  (e) => { e.preventDefault(); if (dragSrc && dragSrc !== row) row.classList.add('drag-over'); });
  row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
  row.addEventListener('drop', async (e) => {
    e.preventDefault();
    row.classList.remove('drag-over');
    if (!dragSrc || dragSrc === row) return;
    const rows = [...patchRows.querySelectorAll('.prow')];
    if (rows.indexOf(dragSrc) < rows.indexOf(row)) row.after(dragSrc); else row.before(dragSrc);
    const order = [...patchRows.querySelectorAll('.prow')].map(r => Number(r.dataset.id));
    await window.hue.setLightOrder(order);
    await refreshLights();
  });

  return row;
}

function applyPatchFilter() {
  const q = $('patch-filter').value.trim().toLowerCase();
  patchRows.querySelectorAll('.prow').forEach(row => {
    const light = state.lights.find(l => String(l.id) === row.dataset.id);
    row.hidden = !!q && !(light && (light.name.toLowerCase().includes(q) || String(light.id) === q));
  });
}

function selectFixture(id) {
  state.selectedId = id;
  markSelectedRow();
  renderInspector();
  updatePatchLive();
}

function markSelectedRow() {
  patchRows.querySelectorAll('.prow').forEach(r => r.classList.toggle('selected', r.dataset.id === String(state.selectedId)));
}

function renderInspector() {
  const light = state.lights.find(l => String(l.id) === String(state.selectedId));
  if (!light) {
    inspector.innerHTML = '<div class="empty">Select a fixture to inspect its patch and incoming values.</div>';
    return;
  }
  const dmx = light.dmx;
  const mode = dmx?.mode || 'rgb';
  const customCh   = light.customAddress?.channel  ?? null;
  const customUniv = light.customAddress?.universe ?? null;
  const overlap = findOverlaps()[light.id];
  const univ = lightUniverse(light);
  const end = dmx ? dmx.start + dmx.channels - 1 : null;
  const model = light.productname || light.type || 'Hue light';

  let note = '', noteBad = false;
  if (light.disabled) note = 'Parked — ignores DMX and keeps its last state.';
  else if (!dmx) note = 'Not patched.';
  else if (overlap) { note = `Channels ${dmx.start}–${end} overlap #${overlap.id} ${overlap.name}. Move one of them.`; noteBad = true; }
  else note = `Uses channels ${dmx.start}${dmx.channels > 1 ? '–' + end : ''} · ${dmx.channels} ch · ${light.customAddress ? 'custom patch' : 'sequential'}`;
  if (!isColorLight(light) && mode === 'rgb') note += ' White-only bulb — I·CT or I fits it better.';

  inspector.innerHTML = `
    <div class="insp-sec insp-head">
      <span class="insp-swatch" id="insp-swatch"></span>
      <div class="insp-title">
        <input class="insp-name" id="insp-name" value="${esc(light.name)}" aria-label="Fixture name" spellcheck="false">
        <span class="insp-sub">Hue light ${esc(light.id)} · ${esc(model)}</span>
      </div>
    </div>
    ${isUnreachable(light) && !light.disabled ? '<div class="insp-alert"><strong>No response</strong> from this bulb. Auto-recovery keeps retrying.</div>' : ''}
    <div class="insp-sec">
      <div class="insp-row-head">
        <span class="section-label">Patch</span>
        ${light.customAddress ? '<button class="link" id="insp-clear">Back to sequential</button>' : ''}
      </div>
      <div class="field-pair">
        <label class="field"><span class="field-label">Universe</span>
          <input class="input mono" id="insp-univ" type="number" min="0" max="63999" value="${univ}"></label>
        <label class="field"><span class="field-label">Address</span>
          <input class="input mono${overlap ? ' bad' : ''}" id="insp-addr" type="number" min="1" max="512" value="${dmx ? dmx.start : ''}"></label>
      </div>
      <div class="field">
        <span class="field-label">Mode</span>
        <div class="seg" role="group" aria-label="DMX mode">
          ${Object.entries(MODE_INFO).map(([k, m]) => `<button data-mode="${k}" class="${k === mode ? 'active' : ''}" aria-pressed="${k === mode}" title="${m.title}">${m.seg}</button>`).join('')}
        </div>
      </div>
      <div class="insp-note${noteBad ? ' bad' : ''}">${esc(note)}</div>
    </div>
    <div class="insp-sec">
      <div class="insp-row-head"><span class="section-label">Incoming</span><span class="hint mono">0–255</span></div>
      ${channelNames(light).map((n, j) => `
        <div class="chan"><span class="chan-label">${CH_LABEL[n] || n}</span>
          <span class="chan-bar"><span class="chan-fill ${CH_CLASS[n] || 'm-i'}" data-ch="${j}"></span></span>
          <span class="chan-val" data-ch="${j}">0</span></div>`).join('')}
    </div>
    <div class="insp-sec">
      <div class="insp-row-head"><span class="section-label">Universe ${univ}</span><span class="hint" id="insp-used"></span></div>
      <div class="umap" id="insp-umap" aria-hidden="true"></div>
      <div class="legend">
        <span><i style="background:var(--accent)"></i>This fixture</span>
        <span><i style="background:#6B7078"></i>Patched</span>
        <span><i style="background:var(--bad)"></i>Overlap</span>
      </div>
    </div>
    <div class="insp-sec">
      <div class="row"><button class="btn btn-danger" id="insp-delete">Remove from bridge</button></div>
    </div>`;

  // Universe map
  const cells = new Array(512).fill('');
  const inUniv = state.lights.filter(l => l.dmx && !l.disabled && lightUniverse(l) === univ);
  let used = 0;
  for (const l of inUniv) {
    used += l.dmx.channels;
    for (let c = l.dmx.start; c < l.dmx.start + l.dmx.channels && c <= 512; c++) {
      cells[c - 1] = cells[c - 1] ? 'u-clash' : 'u-used';
    }
  }
  if (dmx && !light.disabled) {
    for (let c = dmx.start; c <= Math.min(512, end); c++) if (cells[c - 1] !== 'u-clash') cells[c - 1] = 'u-self';
  }
  $('insp-umap').innerHTML = cells.map(c => `<span${c ? ` class="${c}"` : ''}></span>`).join('');
  $('insp-used').textContent = `${used} of 512 used`;

  // Rename
  const nameEl = $('insp-name');
  const rename = async () => {
    const newName = nameEl.value.trim();
    if (!newName || newName === light.name) { nameEl.value = light.name; return; }
    const res = await window.hue.renameLight(light.id, newName);
    if (res.success) {
      light.name = newName;
      const rowName = patchRows.querySelector(`.prow[data-id="${light.id}"] .p-name`);
      if (rowName) rowName.textContent = newName;
      buildControlCards(state.lights);
      toast(`Renamed to "${newName}"`, 'success');
    } else {
      nameEl.value = light.name;
      toast(`Rename failed: ${res.error || ''}`, 'error');
    }
  };
  nameEl.addEventListener('keydown', e => { if (e.key === 'Enter') nameEl.blur(); if (e.key === 'Escape') { nameEl.value = light.name; nameEl.blur(); } });
  nameEl.addEventListener('blur', rename);

  // Patch — a field only becomes an override when it differs from what the
  // sequential patch / default universe would give it.
  const savePatch = async () => {
    const u  = parseInt($('insp-univ').value);
    const ch = parseInt($('insp-addr').value);
    const universe = isNaN(u)  ? customUniv : (customUniv == null && u === defaultUniverse() ? null : u);
    const channel  = isNaN(ch) ? customCh   : (customCh == null && dmx && ch === dmx.start ? null : Math.max(1, Math.min(512, ch)));
    await window.hue.setLightAddress(light.id, { channel, universe });
    refreshLights();
  };
  $('insp-univ').addEventListener('change', savePatch);
  $('insp-addr').addEventListener('change', savePatch);
  const clear = $('insp-clear');
  if (clear) clear.addEventListener('click', async () => { await window.hue.setLightAddress(light.id, null); refreshLights(); });

  // Mode (DMX personality)
  inspector.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', async () => {
    if (b.dataset.mode === mode) return;
    const res = await window.hue.setLightMode(light.id, b.dataset.mode);
    if (res && res.success) {
      toast(`"${light.name}" set to ${MODE_INFO[res.mode]?.title || res.mode}`, 'success');
      refreshLights(); // footprint changed — every sequential address after it shifts
    } else {
      toast('Mode change failed', 'error');
    }
  }));

  // Remove (two clicks)
  const del = $('insp-delete');
  let delTimer = null;
  del.addEventListener('click', async () => {
    if (del.classList.contains('confirming')) {
      clearTimeout(delTimer);
      const res = await window.hue.deleteLight(light.id);
      if (res.success) {
        toast(`"${light.name}" removed from the bridge`, 'info');
        state.selectedId = null;
        refreshLights();
      } else {
        toast(`Remove failed: ${res.error || ''}`, 'error');
      }
      return;
    }
    del.classList.add('confirming');
    del.textContent = 'Click again to remove';
    delTimer = setTimeout(() => { del.classList.remove('confirming'); del.textContent = 'Remove from bridge'; }, 3000);
  });
}

// Live meters, swatches and inspector bars — cheap per-frame updates
function updatePatchLive() {
  if (currentTab !== 'patch' || !state.lights.length) return;
  const live = signalLive();
  for (const light of state.lights) {
    const row = patchRows.querySelector(`.prow[data-id="${light.id}"]`);
    if (!row) continue;
    const vals = live && !light.disabled ? dmxValues(light) : dmxValues(light).map(() => 0);
    row.querySelectorAll('.meter').forEach((m, j) => { m.style.height = `${Math.max(2, Math.round(((vals[j] || 0) / 255) * 16))}px`; });
    const names = channelNames(light);
    const iIdx = names.indexOf('Int');
    const iv = iIdx >= 0 ? vals[iIdx] : Math.max(0, ...vals);
    row.querySelector('.p-int').textContent = light.disabled ? '—' : (live ? `${Math.round((iv / 255) * 100)}%` : '—');
    row.querySelector('.swatch').style.background = cssColor(liveColor(light)) || '#2A2D31';

    if (String(light.id) === String(state.selectedId)) {
      const sw = $('insp-swatch');
      if (sw) sw.style.background = cssColor(liveColor(light)) || '#2A2D31';
      inspector.querySelectorAll('.chan-fill').forEach(f => { f.style.width = `${((vals[f.dataset.ch] || 0) / 255) * 100}%`; });
      inspector.querySelectorAll('.chan-val').forEach(v => { v.textContent = vals[v.dataset.ch] || 0; });
    }
  }
}

// ── Light discovery (Find lights) ────────────────────────────────────────────

let discoveryTimer     = null;
let discoveryPollCount = 0;

$('btn-find-lights').addEventListener('click', startDiscovery);
$('btn-discovery-done').addEventListener('click', async () => {
  clearInterval(discoveryTimer);
  discoveryTimer = null;
  $('lights-discovery').hidden = true;
  await refreshLights();
});

async function startDiscovery() {
  if (!state.connected) { toast('Connect to a bridge first', 'error'); return; }

  const discoveryEl = $('lights-discovery');
  const resultsEl   = $('discovery-results');
  const statusEl    = $('discovery-status-text');
  const spinnerEl   = $('discovery-spinner');

  clearInterval(discoveryTimer);
  discoveryTimer     = null;
  discoveryPollCount = 0;
  resultsEl.innerHTML = '';
  statusEl.textContent = 'Searching for new lights (about 40 s)…';
  spinnerEl.hidden = false;
  discoveryEl.hidden = false;

  const res = await window.hue.searchNewLights();
  if (!res.success) {
    toast(`Search failed: ${res.error || ''}`, 'error');
    discoveryEl.hidden = true;
    return;
  }

  const seenIds = new Set();

  function buildDiscoveryItem(found) {
    const item = document.createElement('div');
    item.className = 'discovery-row';
    item.innerHTML = `
      <input class="input" value="${esc(found.name)}" aria-label="Name for light ${esc(found.id)}">
      <span class="hint mono">ID ${esc(found.id)}</span>
      <button class="btn btn-sm btn-primary">Add</button>`;
    const nameInput = item.querySelector('input');
    const addBtn    = item.querySelector('button');

    addBtn.addEventListener('click', async () => {
      addBtn.disabled = true;
      addBtn.textContent = 'Adding…';
      const newName = nameInput.value.trim();
      if (newName && newName !== found.name) {
        const r = await window.hue.renameLight(found.id, newName);
        if (r.success) found.name = newName;
      }
      // A reused bridge id may carry an old fixture's tile state; drop it so
      // the tile re-initialises from the real bulb.
      delete controlState[found.id];
      delete controlState[String(found.id)];
      if (state.settings && state.settings.lightStates) {
        delete state.settings.lightStates[found.id];
        delete state.settings.lightStates[String(found.id)];
      }
      const r = await window.hue.addLight(found.id);
      if (r && r.success) {
        item.classList.add('added');
        nameInput.disabled = true;
        addBtn.replaceWith(Object.assign(document.createElement('span'), { className: 'added-tag', textContent: 'Added' }));
        toast(`Added "${found.name}"`, 'success');
        await refreshLights();
      } else {
        addBtn.disabled = false;
        addBtn.textContent = 'Add';
        toast(`Add failed: ${(r && r.error) || ''}`, 'error');
      }
    });
    return item;
  }

  async function pollForNewLights() {
    discoveryPollCount++;
    const r = await window.hue.getNewLights();
    if (!r.success) return;
    for (const found of r.lights) {
      if (seenIds.has(found.id)) continue;
      seenIds.add(found.id);
      resultsEl.appendChild(buildDiscoveryItem(found));
    }
    if (!r.scanning || discoveryPollCount >= 14) {
      clearInterval(discoveryTimer);
      discoveryTimer = null;
      spinnerEl.hidden = true;
      statusEl.textContent = seenIds.size > 0
        ? `Found ${seenIds.size} new light${seenIds.size !== 1 ? 's' : ''}. Add the ones you want, then Done.`
        : 'No new lights found. Make sure the bulb is powered on and near the bridge.';
    }
  }

  discoveryTimer = setInterval(pollForNewLights, 3000);
  setTimeout(pollForNewLights, 4000);
}

// ── DMX input ────────────────────────────────────────────────────────────────

let lastPacketMs = 0;
let packetCount  = 0;
let packetRate   = 0;
let liveQueued   = false;

function signalLive() { return state.artnetRunning && lastPacketMs && Date.now() - lastPacketMs < 2000; }

window.hue.on('artnet:dmx-update', (dmx, universe) => {
  const univ = universe ?? defaultUniverse();
  dmxByUniverse[univ] = dmx;
  const wasLive = signalLive();
  lastPacketMs = Date.now();
  packetCount++;
  universeSeenAt[univ] = lastPacketMs;
  if (!wasLive) { paintInputStatus(); paintSignalRow(); }

  if (liveQueued) return;
  liveQueued = true;
  requestAnimationFrame(() => {
    liveQueued = false;
    updatePatchLive();
    if (state.dmxActive) paintTilesFromDmx();
    paintAmbient();
  });
});

const universeSeenAt = {}; // universe → last packet time, for the Log signal row

function liveUniverses() {
  const now = Date.now();
  return Object.keys(universeSeenAt).filter(u => now - universeSeenAt[u] < 2000).map(Number).sort((a, b) => a - b);
}

// Once a second: packet rate, signal-lost detection, Log tab signal row
setInterval(() => {
  packetRate = packetCount;
  packetCount = 0;
  paintInputStatus();
  paintSignalRow();
  if (lastPacketMs && !signalLive()) { updatePatchLive(); scheduleAmbient(); }
}, 1000);

// ── Update banner ────────────────────────────────────────────────────────────

const updateBanner       = $('update-banner');
const updateBannerText   = $('update-banner-text');
const updateProgressWrap = $('update-progress-wrap');
const updateProgressBar  = $('update-progress-bar');
const btnUpdateDownload  = $('btn-update-download');
const btnUpdateInstall   = $('btn-update-install');

window.hue.on('update:available', ({ version }) => {
  updateBannerText.textContent = `Update available · v${version}`;
  updateBanner.hidden = false;
});
window.hue.on('update:progress', ({ percent }) => {
  updateProgressWrap.hidden = false;
  updateProgressBar.style.width = `${percent}%`;
  updateBannerText.textContent = `Downloading · ${percent}%`;
  btnUpdateDownload.hidden = true;
});
window.hue.on('update:downloaded', () => {
  updateBannerText.textContent = 'Update ready';
  updateProgressWrap.hidden = true;
  btnUpdateInstall.hidden = false;
  btnUpdateDownload.hidden = true;
});
window.hue.on('update:error', ({ message }) => {
  updateBannerText.textContent = 'Update available';
  updateProgressWrap.hidden = true;
  btnUpdateDownload.hidden = false;
  btnUpdateDownload.disabled = false;
  btnUpdateDownload.textContent = 'Download';
  toast(`Update failed: ${message}`, 'error');
});
btnUpdateDownload.addEventListener('click', () => {
  btnUpdateDownload.disabled = true;
  btnUpdateDownload.textContent = 'Downloading…';
  window.hue.downloadUpdate();
});
btnUpdateInstall.addEventListener('click', () => window.hue.installUpdate());
$('btn-update-dismiss').addEventListener('click', () => { updateBanner.hidden = true; });

// ── Control ──────────────────────────────────────────────────────────────────

const PALETTE = [
  { hex: '#ffb46b', name: 'Warm white' },
  { hex: '#ffe0b3', name: 'Soft white' },
  { hex: '#f2f4ff', name: 'Cool white' },
  { hex: '#ff4d3e', name: 'Red' },
  { hex: '#ff9500', name: 'Amber' },
  { hex: '#ffd60a', name: 'Yellow' },
  { hex: '#30d158', name: 'Green' },
  { hex: '#0a84ff', name: 'Blue' },
  { hex: '#bf5af2', name: 'Violet' },
];

const controlGrid    = $('control-grid');
const panelControl   = $('panel-control');
const controlState   = {}; // { lightId: { on, rgb, bri } } — persisted to config
const selectedLights = new Set();
let lastClickedId    = null;

const persistControlState = debounce(() => {
  window.hue.saveSettings({ lightStates: { ...controlState } });
}, 1500);

async function sendLightState(lightId, s) {
  persistControlState();
  updateMasterStatus();
  scheduleAmbient();
  if (!s.on) { await window.hue.setLightState(lightId, { on: false }); return; }
  await window.hue.setLightState(lightId, { on: true, rgb: s.rgb, bri: s.bri });
}

function setFader(el, pct, fill) {
  el.style.setProperty('--pct', `${pct}%`);
  if (fill) el.style.setProperty('--fill', fill);
}

// Paint a tile from its control state (or, while DMX owns the rig, from DMX)
function paintTile(tile, light) {
  const s = controlState[light.id];
  if (!s) return;
  const down = isUnreachable(light);
  tile.classList.toggle('unreachable', down);
  tile.classList.toggle('off', !s.on);
  tile.querySelector('.tile-swatch').style.background = s.on && !down ? s.rgb : '#2A2D31';
  tile.querySelector('.tile-level').textContent = down ? '—' : s.on ? `${s.bri}%` : 'Off';
  tile.querySelector('.switch-btn').setAttribute('aria-pressed', String(!!s.on));
  const fader = tile.querySelector('.fader');
  fader.hidden = down;
  tile.querySelector('.tile-down').hidden = !down;
  if (document.activeElement !== fader) fader.value = s.bri;
  setFader(fader, s.bri, s.on ? s.rgb : '#4A4E55');
}

function paintTilesFromDmx() {
  for (const light of state.lights) {
    const tile = controlGrid.querySelector(`[data-light-id="${light.id}"]`);
    if (!tile || light.disabled) continue;
    const col = colorFromDmx(light, dmxValues(light));
    const css = cssColor(col);
    const pct = Math.round(col.k * 100);
    tile.classList.toggle('off', !css);
    tile.querySelector('.tile-swatch').style.background = css || '#2A2D31';
    tile.querySelector('.tile-level').textContent = css ? `${pct}%` : 'Off';
    tile.querySelector('.switch-btn').setAttribute('aria-pressed', String(!!css));
    const fader = tile.querySelector('.fader');
    if (fader) { fader.value = Math.max(1, pct); setFader(fader, pct, css ? `rgb(${col.c.map(Math.round).join(',')})` : '#4A4E55'); }
  }
}

function repaintAllTiles() {
  for (const light of state.lights) {
    const tile = controlGrid.querySelector(`[data-light-id="${light.id}"]`);
    if (tile) paintTile(tile, light);
  }
  updateMasterStatus();
  updateSelectionBar();
  scheduleAmbient();
}

function buildControlCards(lights) {
  if (!lights || lights.length === 0) {
    controlGrid.innerHTML = '<div class="empty">Connect to a bridge and load lights first.</div>';
    clearSelection();
    updateMasterStatus();
    return;
  }
  controlGrid.innerHTML = '';
  const saved = (state.settings && state.settings.lightStates) || {};
  for (const id of [...selectedLights]) if (!lights.some(l => String(l.id) === id)) selectedLights.delete(id);

  for (const light of lights) {
    if (!controlState[light.id]) {
      controlState[light.id] = saved[light.id] || {
        on:  light.state?.on ?? true,
        rgb: '#ffcc66',
        bri: Math.round(((light.state?.bri ?? 254) / 254) * 100),
      };
    }
    const s = controlState[light.id];

    const tile = document.createElement('div');
    tile.className = 'tile' + (selectedLights.has(String(light.id)) ? ' selected' : '');
    tile.dataset.lightId = light.id;
    tile.innerHTML = `
      <button class="tile-hit" aria-label="Select ${esc(light.name)}" aria-pressed="${selectedLights.has(String(light.id))}"></button>
      <div class="tile-head">
        <span class="tile-swatch"></span>
        <span class="tile-name" title="${esc(light.name)}">${esc(light.name)}</span>
        <button class="switch-btn" aria-label="${esc(light.name)} power" aria-pressed="false"><span class="switch"><span class="switch-thumb"></span></span></button>
      </div>
      <div class="tile-value"><span class="tile-level">—</span><span class="tile-kind">${isColorLight(light) ? 'Color' : 'White'}</span></div>
      <div class="tile-foot">
        <input type="range" min="1" max="100" value="${s.bri}" class="fader" aria-label="${esc(light.name)} level">
        <span class="tile-down" hidden><span class="dot dot-bad"></span>No response · retrying</span>
      </div>`;

    tile.querySelector('.tile-hit').addEventListener('click', (e) => onTileClick(light, e));

    tile.querySelector('.switch-btn').addEventListener('click', () => {
      if (isUnreachable(light)) return;
      s.on = !s.on;
      state.activeScene = null;
      paintTile(tile, light);
      paintSceneActive();
      sendLightState(light.id, s);
    });

    // Level — dragging while off turns the light on
    const sendBri = debounce(() => sendLightState(light.id, s), 80);
    tile.querySelector('.fader').addEventListener('input', (e) => {
      s.bri = parseInt(e.target.value);
      s.on = true;
      state.activeScene = null;
      paintTile(tile, light);
      paintSceneActive();
      sendBri();
    });

    controlGrid.appendChild(tile);
    paintTile(tile, light);
  }
  updateMasterStatus();
  updateSelectionBar();
  if (state.dmxActive) paintTilesFromDmx();
}

// Pull fresh bridge state so tiles reflect reality (skipped while DMX owns the rig)
async function refreshControlSwatches() {
  if (!state.connected || state.dmxActive) return;
  const res = await window.hue.getLights();
  if (!res || !res.lights) return;
  for (const fresh of res.lights) {
    const light = state.lights.find(l => String(l.id) === String(fresh.id));
    const s = controlState[fresh.id];
    if (!light || !s || !fresh.state) continue;
    light.state = fresh.state;
    s.on = !!fresh.state.on;
    if (fresh.state.bri != null) s.bri = Math.max(1, Math.round((fresh.state.bri / 254) * 100));
  }
  repaintAllTiles();
  paintFixtureHealth();
}

// ── Selection ────────────────────────────────────────────────────────────────

function onTileClick(light, e) {
  const id = String(light.id);
  if (e.shiftKey && lastClickedId != null) {
    const ids = state.lights.map(l => String(l.id));
    const a = ids.indexOf(lastClickedId), b = ids.indexOf(id);
    for (const x of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) selectedLights.add(x);
  } else if (selectedLights.has(id)) {
    selectedLights.delete(id);
  } else {
    selectedLights.add(id);
  }
  lastClickedId = id;
  paintSelection();
}

function paintSelection() {
  controlGrid.querySelectorAll('.tile').forEach(t => {
    const on = selectedLights.has(String(t.dataset.lightId));
    t.classList.toggle('selected', on);
    t.querySelector('.tile-hit').setAttribute('aria-pressed', String(on));
  });
  updateSelectionBar();
}

function selectAll() {
  for (const l of state.lights) if (!isUnreachable(l)) selectedLights.add(String(l.id));
  paintSelection();
}

function clearSelection() {
  selectedLights.clear();
  lastClickedId = null;
  paintSelection();
}

$('btn-select-all').addEventListener('click', selectAll);
$('btn-sel-clear').addEventListener('click', clearSelection);

function eachSelected(fn) {
  for (const id of selectedLights) {
    const light = state.lights.find(l => String(l.id) === id);
    if (!light || isUnreachable(light)) continue;
    const s = controlState[light.id];
    if (s) fn(light, s);
  }
}

// Color / level on a selection turn it on — acting on a selection is an
// explicit "light these up" intent.
const selPalette = buildPalette((hex) => {
  eachSelected((l, s) => { s.rgb = hex; s.on = true; sendLightState(l.id, s); });
  state.activeScene = null;
  paintSceneActive();
  repaintAllTiles();
});
$('sel-palette').replaceWith(selPalette);
selPalette.id = 'sel-palette';

const selBri = $('sel-bri');
const sendSelBri = debounce(() => {
  eachSelected((l, s) => sendLightState(l.id, s));
}, 120);
selBri.addEventListener('input', () => {
  const v = parseInt(selBri.value);
  eachSelected((l, s) => { s.bri = v; s.on = true; });
  state.activeScene = null;
  paintSceneActive();
  repaintAllTiles();
  sendSelBri();
});
$('btn-sel-on').addEventListener('click', () => { eachSelected((l, s) => { s.on = true; sendLightState(l.id, s); }); repaintAllTiles(); });
$('btn-sel-off').addEventListener('click', () => { eachSelected((l, s) => { s.on = false; sendLightState(l.id, s); }); repaintAllTiles(); });

function updateSelectionBar() {
  const live = [];
  eachSelected((l, s) => live.push(s));
  const n = live.length;
  $('selection-bar').classList.toggle('disabled', n === 0);
  $('sel-title').textContent = n ? `${n} selected` : 'Nothing selected';
  $('btn-sel-clear').hidden = n === 0;
  $('sel-hint').hidden = n > 0;
  if (n) {
    const avg = Math.round(live.reduce((t, s) => t + s.bri, 0) / n);
    if (document.activeElement !== selBri) selBri.value = avg;
    setFader(selBri, avg, 'var(--text)');
    $('sel-bri-val').textContent = `${avg}%`;
    const colors = new Set(live.map(s => String(s.rgb).toLowerCase()));
    selPalette.setActive(colors.size === 1 ? [...colors][0] : null);
  } else {
    setFader(selBri, 0);
    $('sel-bri-val').textContent = '—';
    selPalette.setActive(null);
  }
}

function buildPalette(onPick) {
  const el = document.createElement('div');
  el.className = 'palette';
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', 'Color');
  const chips = [];
  for (const { hex, name } of PALETTE) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.title = name;
    b.setAttribute('aria-label', name);
    b.style.background = hex;
    b.dataset.hex = hex;
    b.addEventListener('click', () => onPick(hex));
    chips.push(b);
    el.appendChild(b);
  }
  const custom = document.createElement('label');
  custom.className = 'chip chip-custom';
  custom.title = 'Custom color';
  custom.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><input type="color" aria-label="Custom color">';
  const input = custom.querySelector('input');
  input.addEventListener('input', () => onPick(input.value));
  el.appendChild(custom);

  el.setActive = (hex) => {
    let matched = false;
    for (const c of chips) {
      const on = !!hex && c.dataset.hex === String(hex).toLowerCase();
      c.classList.toggle('active', on);
      matched = matched || on;
    }
    custom.classList.toggle('active', !!hex && !matched);
    if (hex && !matched) input.value = hex;
  };
  return el;
}

// ── Master ───────────────────────────────────────────────────────────────────

const masterBri = $('master-bri');

function updateMasterStatus() {
  const total = state.lights.length;
  const on = state.lights.filter(l => controlState[l.id]?.on).length;
  $('master-status').textContent = total === 0 ? '' : on === 0 ? 'All off' : on === total ? `All ${total} on` : `${on} of ${total} on`;
}

function eachControllableLight(fn) {
  for (const light of state.lights) {
    if (isUnreachable(light)) continue;
    const s = controlState[light.id];
    if (s) fn(light, s);
  }
}

$('btn-all-on').addEventListener('click', () => {
  eachControllableLight((light, s) => { s.on = true; sendLightState(light.id, s); });
  state.activeScene = null;
  paintSceneActive();
  repaintAllTiles();
});
$('btn-all-off').addEventListener('click', blackout);

// The master fader scales lights that are ON — All on/off change power, so the
// room fader can't blind-fire fixtures that were deliberately dark.
const sendMasterBri = debounce(() => {
  eachControllableLight((light, s) => { if (s.on) sendLightState(light.id, s); });
}, 120);
masterBri.addEventListener('input', () => {
  const v = parseInt(masterBri.value);
  $('master-bri-val').textContent = `${v}%`;
  setFader(masterBri, v);
  eachControllableLight((light, s) => { if (s.on) s.bri = v; });
  repaintAllTiles();
  sendMasterBri();
});
setFader(masterBri, 100);

// All-off fired from elsewhere (Companion, panic endpoint) — mirror it
window.hue.on('lights:all-off', ({ source } = {}) => {
  for (const light of state.lights) { const s = controlState[light.id]; if (s) s.on = false; }
  persistControlState();
  state.activeScene = null;
  paintSceneActive();
  repaintAllTiles();
  if (source && source !== 'control tab') toast(`All lights off (${source})`, 'warn');
});

// DMX takeover — lock manual control while DMX owns the rig
window.hue.on('dmx:takeover-change', ({ active }) => {
  const wasActive = state.dmxActive;
  state.dmxActive = active;
  $('dmx-override-banner').hidden = !active;
  $('dmx-override-info').textContent = `${protoLabel()} is driving the rig. Manual control returns 2 s after the last packet.`;
  panelControl.classList.toggle('dmx-live', active);
  if (active) paintTilesFromDmx();
  // Tiles showed DMX values — pull fresh state so they reflect reality again
  if (wasActive && !active) refreshControlSwatches();
});

window.hue.on('companion:preset-applied', () => refreshControlSwatches());

// ── Scenes ───────────────────────────────────────────────────────────────────

let scenesCache = {}; // { name: [ { id, on, rgb, bri } ] }
const sceneList = $('scene-list');

function syncTilesFromScene(name) {
  for (const entry of scenesCache[name] || []) {
    const s = controlState[entry.id];
    if (!s) continue;
    s.on = !!entry.on;
    if (entry.rgb)         s.rgb = entry.rgb;
    if (entry.bri != null) s.bri = entry.bri;
  }
  repaintAllTiles();
  persistControlState();
}

function snapshotCurrentLook() {
  return state.lights.filter(l => controlState[l.id]).map(l => ({ id: l.id, ...controlState[l.id] }));
}

async function applyScene(name) {
  const res = await window.hue.applyScene(name);
  if (res.success) {
    state.activeScene = name;
    paintSceneActive();
    syncTilesFromScene(name);
  } else {
    toast(`Scene failed: ${(res.errors || []).join(', ')}`, 'error');
  }
}

function paintSceneActive() {
  sceneList.querySelectorAll('.scene').forEach(b => {
    const on = b.dataset.name === state.activeScene;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

function armButton(btn, label, onConfirm) {
  let t = null;
  const original = btn.textContent;
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const tools = btn.closest('.scene-tools');
    if (btn.classList.contains('confirming')) {
      clearTimeout(t);
      btn.classList.remove('confirming');
      tools.classList.remove('armed');
      await onConfirm();
      return;
    }
    tools.querySelectorAll('.confirming').forEach(b => b.classList.remove('confirming'));
    btn.classList.add('confirming');
    btn.textContent = label;
    tools.classList.add('armed');
    t = setTimeout(() => { btn.classList.remove('confirming'); btn.textContent = original; tools.classList.remove('armed'); }, 2500);
  });
}

async function loadScenes() {
  scenesCache = await window.hue.getScenes() || {};
  sceneList.innerHTML = '';
  const names = Object.keys(scenesCache);
  if (!names.length) {
    sceneList.innerHTML = '<div class="empty">No scenes yet. Set up a look, then Save look.</div>';
    return;
  }

  names.forEach((name, i) => {
    const entries = scenesCache[name] || [];
    const lit = entries.filter(e => e.on && e.rgb);
    const colors = [...new Set(lit.map(e => String(e.rgb).toLowerCase()))].slice(0, 6);
    const onCount = entries.filter(e => e.on).length;

    const wrap = document.createElement('div');
    wrap.className = 'scene-row';
    wrap.innerHTML = `
      <button class="scene" data-name="${esc(name)}" aria-pressed="false">
        <span class="scene-key">${i < 9 ? i + 1 : ''}</span>
        <span class="scene-body">
          <span class="scene-top">
            <span class="scene-name" title="${esc(name)}">${esc(name)}</span>
            <span class="scene-meta">${entries.length ? (onCount ? `${onCount} of ${entries.length} on` : 'all off') : 'empty'}</span>
          </span>
          <span class="scene-chips">${(colors.length ? colors : ['#2A2D31']).map(c => `<span style="background:${esc(c)}"></span>`).join('')}</span>
        </span>
      </button>
      <div class="scene-tools">
        <button class="upd" title="Overwrite with the current look">Update</button>
        <button class="danger del" title="Delete scene">Delete</button>
      </div>`;
    wrap.querySelector('.scene').addEventListener('click', () => applyScene(name));
    armButton(wrap.querySelector('.upd'), 'Overwrite?', async () => {
      await window.hue.saveScene(name, snapshotCurrentLook());
      toast(`Scene "${name}" updated`, 'success');
      await loadScenes();
    });
    armButton(wrap.querySelector('.del'), 'Delete?', async () => {
      await window.hue.deleteScene(name);
      if (state.activeScene === name) state.activeScene = null;
      toast(`Scene "${name}" deleted`, 'info');
      await loadScenes();
    });
    sceneList.appendChild(wrap);
  });
  paintSceneActive();
}

$('btn-save-scene').addEventListener('click', () => {
  if (sceneList.querySelector('.scene-new')) { sceneList.querySelector('.scene-new input').focus(); return; }
  const box = document.createElement('div');
  box.className = 'scene-new';
  box.innerHTML = '<input class="input" placeholder="Scene name, then Enter" aria-label="New scene name">';
  sceneList.prepend(box);
  const inp = box.querySelector('input');
  inp.focus();
  inp.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') { box.remove(); return; }
    if (e.key !== 'Enter') return;
    const name = inp.value.trim();
    if (!name) { box.remove(); return; }
    const existed = Object.prototype.hasOwnProperty.call(scenesCache, name);
    await window.hue.saveScene(name, snapshotCurrentLook());
    state.activeScene = name;
    toast(`Scene "${name}" ${existed ? 'updated' : 'saved'}`, 'success');
    await loadScenes();
  });
  inp.addEventListener('blur', () => setTimeout(() => box.remove(), 150));
});

// ── Log ──────────────────────────────────────────────────────────────────────

const eventLogList = $('event-log-list');

function paintSignalRow() {
  const dot = $('monitor-signal-dot'), label = $('monitor-signal-label'), age = $('monitor-signal-age');
  if (signalLive()) {
    setDot(dot, 'ok');
    label.textContent = `Receiving · ${packetRate} Hz`;
    age.textContent = '';
  } else if (lastPacketMs) {
    setDot(dot, 'bad');
    label.textContent = 'Signal lost';
    age.textContent = `last packet ${((Date.now() - lastPacketMs) / 1000).toFixed(0)} s ago`;
  } else {
    setDot(dot, null);
    label.textContent = state.artnetRunning ? 'Listening · no signal yet' : 'Input off';
    age.textContent = '';
  }
  const us = liveUniverses();
  $('monitor-universe-label').textContent = us.length
    ? `${protoLabel()} · Universe${us.length > 1 ? 's' : ''} ${us.join(', ')}`
    : `${protoLabel()} · Universe ${defaultUniverse()}`;
}

function fmtLogTime(t) { return new Date(t).toTimeString().slice(0, 8); }

function appendLogEntry(e, newestFirst = true) {
  const div = document.createElement('div');
  div.className = `log-entry log-${e.type || 'info'}`;
  div.innerHTML = '<span class="log-time"></span><span class="log-msg"></span>';
  div.querySelector('.log-time').textContent = fmtLogTime(e.t);
  div.querySelector('.log-msg').textContent  = e.message;
  if (newestFirst) eventLogList.prepend(div); else eventLogList.appendChild(div);
  while (eventLogList.children.length > 200) eventLogList.lastChild.remove();
}

async function loadEventLog() {
  const entries = await window.hue.getEventLog().catch(() => []);
  eventLogList.innerHTML = '';
  if (!entries || entries.length === 0) {
    eventLogList.innerHTML = '<div class="empty">No events yet</div>';
    return;
  }
  for (const e of entries.slice().reverse()) appendLogEntry(e, false);
}

window.hue.on('log:event', (e) => {
  const placeholder = eventLogList.querySelector('.empty');
  if (placeholder) placeholder.remove();
  appendLogEntry(e);
});

window.hue.on('sacn:diag', ({ rawCount, lastUniverse, configured, watched, lastSize }) => {
  const bar = $('sacn-diag-bar'), text = $('sacn-diag-text');
  if (protocol() === 'artnet') { bar.hidden = true; return; }
  bar.hidden = false;
  bar.className = 'diag';
  if (rawCount === 0) {
    text.textContent = 'sACN: no UDP packets on port 5568 yet';
  } else if (lastUniverse === null) {
    text.textContent = `sACN: ${rawCount} packets received but none were valid E1.31 (last: ${lastSize} bytes)`;
  } else if (!new Set(watched || [configured]).has(lastUniverse)) {
    bar.className = 'diag mismatch';
    text.textContent = `sACN: receiving universe ${lastUniverse}, but Prism listens on ${configured}. Set the sACN universe in Setup to ${lastUniverse}.`;
  } else {
    bar.className = 'diag ok';
    text.textContent = `sACN: receiving · universe${watched && watched.length > 1 ? 's ' + watched.join(', ') : ' ' + configured} · ${rawCount} packets`;
  }
});

// ── Setup: interfaces + settings ─────────────────────────────────────────────

async function loadNicSelectors(savedIp) {
  const ifaces = await window.hue.getNetworkInterfaces();
  for (const id of ['discover-nic', 's-nic']) {
    const sel  = $(id);
    const prev = sel.value;
    sel.innerHTML = '';
    for (const iface of ifaces) {
      const opt = document.createElement('option');
      opt.value = iface.ip;
      opt.textContent = iface.label;
      sel.appendChild(opt);
    }
    const target = (id === 's-nic' && savedIp) ? savedIp : prev;
    if ([...sel.options].some(o => o.value === target)) sel.value = target;
  }
}
$('btn-refresh-nics-discover').addEventListener('click', () => loadNicSelectors());
$('btn-refresh-nics-settings').addEventListener('click', () => loadNicSelectors(state.settings.host));

function updateMulticastHint() {
  const u = parseInt($('s-sacn-universe').value) || 1;
  $('sacn-multicast-group').textContent = `239.255.${(u >> 8) & 0xff}.${u & 0xff}`;
}

async function refreshSettings() {
  const cfg = await window.hue.getSettings();
  state.settings = cfg;

  await loadNicSelectors(cfg.host);
  $('s-protocol').value       = cfg.protocol ?? 'artnet';
  $('s-address').value        = cfg.dmxAddress ?? 1;
  $('s-universe').value       = cfg.universe ?? 0;
  $('s-sacn-universe').value  = cfg.sacnUniverse ?? 1;
  $('s-sacn-multicast').checked = cfg.sacnMulticast !== false;
  $('s-transition').value     = cfg.transition === 'channel' ? 'channel' : (cfg.transition ?? 100);
  const amb = cfg.ambient ?? 45;
  $('s-ambient').value = amb;
  $('s-ambient-val').textContent = `${amb}%`;
  setFader($('s-ambient'), amb);
  window.hue.getLoginItem().then(on => { $('s-login-item').checked = !!on; }).catch(() => {});
  updateMulticastHint();

  const status = await window.hue.artnetStatus();
  setListenerRunning(status.running);
  scheduleAmbient();
}

// Input settings save as you change them; a running listener restarts to apply
const saveInputSettings = debounce(async () => {
  const transRaw = $('s-transition').value.trim();
  const updates = {
    protocol:      $('s-protocol').value,
    dmxAddress:    parseInt($('s-address').value)      || 1,
    universe:      parseInt($('s-universe').value)     || 0,
    sacnUniverse:  parseInt($('s-sacn-universe').value) || 1,
    sacnMulticast: $('s-sacn-multicast').checked,
    host:          $('s-nic').value || '0.0.0.0',
    transition:    transRaw === 'channel' ? 'channel' : (parseInt(transRaw) || 100),
  };
  await window.hue.saveSettings(updates);
  state.settings = { ...state.settings, ...updates };
  paintInputStatus();
  if (state.artnetRunning) {
    await window.hue.stopArtnet();
    await window.hue.startArtnet();
    toast('Input settings saved — listener restarted', 'success');
  } else {
    toast('Input settings saved', 'success');
  }
  if (state.connected) refreshLights();
}, 400);

['s-protocol', 's-nic', 's-universe', 's-sacn-universe', 's-sacn-multicast', 's-address', 's-transition']
  .forEach(id => $(id).addEventListener('change', saveInputSettings));
$('s-sacn-universe').addEventListener('input', updateMulticastHint);

$('s-ambient').addEventListener('input', () => {
  const v = parseInt($('s-ambient').value);
  state.settings.ambient = v;
  $('s-ambient-val').textContent = `${v}%`;
  setFader($('s-ambient'), v);
  scheduleAmbient();
});
$('s-ambient').addEventListener('change', () => window.hue.saveSettings({ ambient: state.settings.ambient }));

$('s-login-item').addEventListener('change', () => {
  window.hue.setLoginItem($('s-login-item').checked).catch(() => {});
});

$('btn-export-show').addEventListener('click', async () => {
  const res = await window.hue.exportShow().catch(() => null);
  if (res && res.success) toast('Show profile exported', 'success');
  else if (res && !res.canceled) toast(`Export failed: ${res.error || ''}`, 'error');
});

$('btn-import-show').addEventListener('click', async () => {
  const res = await window.hue.importShow().catch(() => null);
  if (res && res.success) {
    toast(res.connected ? 'Show imported — bridge connected' : 'Show imported', 'success');
    await refreshSettings();
    setBridgeStatus(!!res.connected, state.settings.bridge || null, false);
    if (res.connected) refreshLights();
  } else if (res && !res.canceled) {
    toast(`Import failed: ${res.error || ''}`, 'error');
  }
});

// ── Init ─────────────────────────────────────────────────────────────────────

setBridgeStatus(false, null, false);
showTab('setup'); // bridge:auto-connect moves to the last tab once connected
