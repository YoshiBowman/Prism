'use strict';

// ── State ────────────────────────────────────────────────────────────────────

const state = {
  connected: false,
  bridge: null,
  artnetRunning: false,
  lights: [],
  settings: {},
  pairing: false,
};

// Per-universe DMX frame cache — keyed by universe number, updated on artnet:dmx-update
const dmxByUniverse = {};

// ── Tabs ─────────────────────────────────────────────────────────────────────

const tabs   = document.querySelectorAll('.tab');
const panels = document.querySelectorAll('.panel');

function showTab(name) {
  tabs.forEach(t   => t.classList.toggle('active', t.dataset.tab === name));
  panels.forEach(p => p.classList.toggle('active', p.id === `panel-${name}`));
  if (name === 'lights'   && state.connected) refreshLights();
  if (name === 'settings') refreshSettings();
  if (name === 'monitor'  && state.lights.length > 0) buildMonitorCards(state.lights);
  if (name === 'control') { buildControlCards(state.lights); loadScenes(); refreshControlSwatches(); }
}

tabs.forEach(t => t.addEventListener('click', () => {
  showTab(t.dataset.tab);
  window.hue.saveSettings({ lastTab: t.dataset.tab });
}));

// ── Toast ─────────────────────────────────────────────────────────────────────

function toast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── Listener bar (always-visible protocol / universe / start / stop) ──────────

const lbProtocol      = document.getElementById('lb-protocol');
const lbArtnetUniverse = document.getElementById('lb-artnet-universe');
const lbSacnUniverse   = document.getElementById('lb-sacn-universe');
const lbArtnetField    = document.getElementById('lb-artnet-field');
const lbSacnField      = document.getElementById('lb-sacn-field');
const lbStart          = document.getElementById('lb-start');
const lbStop           = document.getElementById('lb-stop');
const lbStatus         = document.getElementById('lb-status');
const lbLabel          = document.getElementById('lb-label');

function updateListenerBarVisibility(protocol) {
  lbArtnetField.style.display = (protocol === 'sacn')   ? 'none' : '';
  lbSacnField.style.display   = (protocol === 'artnet') ? 'none' : '';
}

lbProtocol.addEventListener('change', () => updateListenerBarVisibility(lbProtocol.value));

// Keep listener bar ↔ settings universes in sync
lbArtnetUniverse.addEventListener('input', () => {
  document.getElementById('s-universe').value = lbArtnetUniverse.value;
  refreshEffectivePatch();
});
lbSacnUniverse.addEventListener('input', () => {
  document.getElementById('s-sacn-universe').value = lbSacnUniverse.value;
  updateMulticastHint();
  refreshEffectivePatch();
});

async function listenerBarStart() {
  // Save current values before starting
  const proto       = lbProtocol.value;
  const artnetUniv  = parseInt(lbArtnetUniverse.value) || 0;
  const sacnUniv    = parseInt(lbSacnUniverse.value)   || 1;

  await window.hue.saveSettings({ protocol: proto, universe: artnetUniv, sacnUniverse: sacnUniv });
  state.settings.protocol      = proto;
  state.settings.universe      = artnetUniv;
  state.settings.sacnUniverse  = sacnUniv;

  const res = await window.hue.startArtnet();
  if (!res.success) toast(`Listener failed: ${res.message || ''}`, 'error');
}

async function listenerBarStop() {
  await window.hue.stopArtnet();
  setListenerRunning(false);
}

function setListenerRunning(running, error) {
  state.artnetRunning = running;
  lbStart.disabled = running;
  lbStop.disabled  = !running;
  lbStatus.className = error ? 'error' : running ? 'running' : '';

  const proto = lbProtocol.value || (state.settings && state.settings.protocol) || 'artnet';
  const protoLabel = proto === 'sacn' ? 'sACN' : proto === 'both' ? 'Art-Net + sACN' : 'Art-Net';
  lbLabel.textContent = error ? `${protoLabel}: Error` : running ? `${protoLabel}: Active` : 'Stopped';

  // Keep titlebar badge in sync
  updateArtnetBadge(running, error);
}

lbStart.addEventListener('click', listenerBarStart);
lbStop.addEventListener('click',  listenerBarStop);

// ── Art-Net badge (titlebar) ──────────────────────────────────────────────────

const artnetBadge = document.getElementById('artnet-badge');
const artnetLabel = document.getElementById('artnet-label');

function updateArtnetBadge(running, error) {
  artnetBadge.className = 'artnet-badge ' + (error ? 'error' : running ? 'running' : '');
  const proto = (state.settings && state.settings.protocol) || 'artnet';
  const protoLabel = proto === 'sacn' ? 'sACN' : proto === 'both' ? 'Art-Net+sACN' : 'Art-Net';
  artnetLabel.textContent = error   ? `${protoLabel}: Error`
    : running ? `${protoLabel}: Active`
    : `${protoLabel}: Stopped`;
}

window.hue.on('artnet:status', ({ running, error }) => setListenerRunning(running, error));

// ── Bridge panel ──────────────────────────────────────────────────────────────

const bridgeStatusDot  = document.getElementById('bridge-status-dot');
const bridgeStatusText = document.getElementById('bridge-status-text');
const bridgeList       = document.getElementById('bridge-list');
const pairDialog       = document.getElementById('pair-dialog');
const pairCountdown    = document.getElementById('pair-countdown');
const pairMessage      = document.getElementById('pair-message');
const pairTimerBar     = document.getElementById('pair-timer-bar');
const pairStepVerify   = document.getElementById('pair-step-verify');
const pairStepLink     = document.getElementById('pair-step-link');
const manualIpInput    = document.getElementById('manual-ip');

function setBridgeStatus(connected, bridge, connecting) {
  state.connected = connected;
  state.bridge    = bridge;
  bridgeStatusDot.className  = 'status-dot ' + (connecting ? 'connecting' : connected ? 'connected' : 'error');
  bridgeStatusText.textContent = connecting ? 'Connecting…'
    : connected ? `Connected to ${bridge}` : 'Not connected';
  document.getElementById('btn-disconnect').style.display = connected ? '' : 'none';
  document.getElementById('btn-scan').disabled = connecting;
}

const scanProgressWrap  = document.getElementById('scan-progress-wrap');
const scanProgressBar   = document.getElementById('scan-progress-bar');
const scanProgressLabel = document.getElementById('scan-progress-label');

window.hue.on('bridge:found', (bridge) => {
  const placeholder = bridgeList.querySelector('.empty-state');
  if (placeholder) placeholder.remove();
  bridgeList.appendChild(buildBridgeItem(bridge));
});

window.hue.on('bridge:scan-progress', ({ phase, completed, total, subnets }) => {
  if (phase === 'saved') {
    scanProgressBar.style.width = '3%';
    scanProgressLabel.textContent = 'Checking last known bridge IP…';
  } else if (phase === 'arp') {
    scanProgressBar.style.width = '10%';
    scanProgressLabel.textContent = 'Checking ARP cache for known Hue bridges…';
  } else if (phase === 'ssdp') {
    scanProgressBar.style.width = '20%';
    scanProgressLabel.textContent = 'Sending UPnP/SSDP multicast on all interfaces…';
  } else if (phase === 'mdns') {
    scanProgressBar.style.width = '30%';
    scanProgressLabel.textContent = 'Searching via mDNS…';
  } else {
    const pct = 30 + Math.round((completed / total) * 70);
    scanProgressBar.style.width = `${pct}%`;
    scanProgressLabel.textContent =
      `Scanning ${subnets.map(s => s + '.0/24').join(', ')} — ${completed}/${total} hosts`;
  }
});

document.getElementById('btn-show-subnets').addEventListener('click', async () => {
  const preview = document.getElementById('subnet-preview');
  const subnets = await window.hue.getScanSubnets();
  const extra   = parseExtraSubnet();
  const all     = extra ? [...new Set([...subnets, extra])] : subnets;
  preview.style.display  = '';
  preview.textContent = `Will scan: ${all.map(s => s + '.0/24').join(', ') || 'none'}`;
});

function parseExtraSubnet() {
  const raw   = document.getElementById('extra-subnet').value.trim();
  if (!raw) return null;
  const parts = raw.replace(/\/\d+$/, '').split('.');
  if (parts.length >= 3) return parts.slice(0, 3).join('.');
  return null;
}

function setScanRunning(running) {
  document.getElementById('btn-scan').style.display        = running ? 'none' : '';
  document.getElementById('btn-cancel-scan').style.display = running ? ''     : 'none';
  scanProgressWrap.style.display = running ? '' : 'none';
}

document.getElementById('btn-cancel-scan').addEventListener('click', () => {
  window.hue.cancelScan();
  setScanRunning(false);
  scanProgressLabel.textContent = 'Scan cancelled';
  scanProgressWrap.style.display = '';
});

document.getElementById('btn-scan').addEventListener('click', async () => {
  bridgeList.innerHTML = '<div class="empty-state"><small>Scanning — results appear as bridges are found…</small></div>';
  scanProgressBar.style.width   = '0%';
  scanProgressLabel.textContent = 'Starting scan…';
  setScanRunning(true);

  const ifaceIp = document.getElementById('discover-nic').value;
  const extra   = parseExtraSubnet();
  const res     = await window.hue.discoverBridges(ifaceIp, extra ? [extra] : []);

  setScanRunning(false);
  scanProgressBar.style.width = '100%';

  if (!res.success) {
    bridgeList.innerHTML = `<div class="empty-state"><p>Scan error</p><small>${res.error}</small></div>`;
    scanProgressWrap.style.display = 'none';
    return;
  }

  const count = res.bridges.length;
  scanProgressLabel.textContent = count > 0
    ? `Scan complete — ${count} bridge${count !== 1 ? 's' : ''} found`
    : 'Scan complete';
  if (count === 0 && !bridgeList.querySelector('.bridge-item')) {
    bridgeList.innerHTML = '<div class="empty-state"><p>No bridges found</p><small>Check that your Hue bridge is powered on and connected to this network</small></div>';
  }
});

function buildBridgeItem(b) {
  const div = document.createElement('div');
  div.className = 'bridge-item';
  div.innerHTML = `
    <div class="bridge-info">
      <div class="bridge-name">${b.name || 'Hue Bridge'}</div>
      <div class="bridge-ip">${b.ip}</div>
    </div>
    <button class="btn btn-primary btn-sm">Connect</button>
  `;
  div.querySelector('button').addEventListener('click', () => startPair(b.ip));
  return div;
}

document.getElementById('btn-manual-connect').addEventListener('click', () => {
  const ip = manualIpInput.value.trim();
  if (!ip) return;
  startPair(ip);
});

async function startPair(ip) {
  if (state.pairing) return;
  state.pairing = true;
  setBridgeStatus(false, null, true);

  document.getElementById('pair-ip').textContent     = ip;
  document.getElementById('pair-verify-label').innerHTML = `Checking bridge at <strong>${ip}</strong>…`;
  pairStepVerify.style.display = '';
  pairStepLink.style.display   = 'none';
  pairMessage.textContent      = '';
  pairDialog.className         = 'card visible';

  const verify = await window.hue.verifyBridge(ip);
  if (!verify.success) {
    state.pairing        = false;
    pairDialog.className = 'card';
    setBridgeStatus(false, null, false);
    toast(`Bridge not found at ${ip} — check the IP address`, 'error');
    return;
  }

  if (verify.autoConnected) {
    state.pairing        = false;
    pairDialog.className = 'card';
    setBridgeStatus(true, ip);
    window.hue.bridgeStatus().then(s => setBridgeStatus(true, s.bridge));
    bridgeList.innerHTML = '';
    scanProgressWrap.style.display = 'none';
    manualIpInput.value  = '';
    toast(`Connected to ${verify.name || ip}`, 'success');
    showTab('lights');
    return;
  }

  document.getElementById('pair-bridge-name').textContent =
    verify.name + (verify.bridgeid ? ` (${verify.bridgeid.slice(-6)})` : '');
  pairStepVerify.style.display = 'none';
  pairStepLink.style.display   = '';
  pairCountdown.textContent    = '30';
  pairTimerBar.style.width     = '100%';

  await window.hue.startPair(ip);
}

window.hue.on('bridge:pair-event', (event) => {
  if (event.type === 'waiting') {
    pairCountdown.textContent    = event.remaining;
    pairTimerBar.style.width     = `${Math.round((event.remaining / 30) * 100)}%`;
    pairMessage.textContent      = '';
  } else if (event.type === 'success') {
    state.pairing        = false;
    pairDialog.className = 'card';
    setBridgeStatus(true, state.bridge || '');
    window.hue.bridgeStatus().then(s => setBridgeStatus(true, s.bridge));
    // Clear the discovered list — no point showing "Connect" on a bridge we just connected to
    bridgeList.innerHTML = '';
    scanProgressWrap.style.display = 'none';
    toast('Bridge paired! Loading lights…', 'success');
    showTab('lights');
  } else if (event.type === 'error') {
    state.pairing        = false;
    pairDialog.className = 'card';
    setBridgeStatus(false, null, false);
    toast(`Pairing failed: ${event.message}`, 'error');
  } else if (event.type === 'timeout') {
    state.pairing              = false;
    pairStepLink.style.display = 'none';
    pairStepVerify.style.display = '';
    document.getElementById('pair-verify-label').textContent = 'Timed out — link button not pressed. Try again.';
    setBridgeStatus(false, null, false);
    toast('Timed out — press the link button within 30 s then retry', 'error');
  }
});

function cancelPairing() {
  state.pairing        = false;
  pairDialog.className = 'card';
  setBridgeStatus(false, null, false);
}
document.getElementById('btn-cancel-pair').addEventListener('click', cancelPairing);

document.getElementById('btn-disconnect').addEventListener('click', async () => {
  await window.hue.disconnect();
  setBridgeStatus(false, null, false);
  document.getElementById('lights-list').innerHTML = '';
  toast('Disconnected from bridge', 'info');
});

window.hue.on('bridge:auto-connect', async ({ connected, bridge }) => {
  // Always restore settings so listener bar/controls reflect saved config
  await refreshSettings();

  setBridgeStatus(connected, bridge, false);
  if (connected) {
    // Clear any leftover scan results — already connected, no need to show the list
    bridgeList.innerHTML = '';
    scanProgressWrap.style.display = 'none';
    toast(`Connected to ${bridge}`, 'success');
    // Restore last active tab (default to lights when connected)
    const saved = state.settings.lastTab;
    showTab(saved && saved !== 'bridge' ? saved : 'lights');
  }
});

window.hue.on('bridge:unreachable', () => {
  toast('Bridge not responding — check connection or re-scan on the Bridge tab', 'error');
});

window.hue.on('bridge:reachable', () => {
  toast('Bridge connection restored', 'success');
});

// ── Per-bulb reachability events ──────────────────────────────────────────────

window.hue.on('bulb-unreachable', ({ id }) => {
  const row = lightsList && lightsList.querySelector(`.light-row[data-id="${id}"]`);
  if (!row) return;
  const meta = row.querySelector('.light-meta');
  if (meta) meta.innerHTML = meta.innerHTML.replace(/\b(Reachable|Unreachable)\b/, 'Unreachable');
});

window.hue.on('bulb-recovered', ({ id }) => {
  const row = lightsList && lightsList.querySelector(`.light-row[data-id="${id}"]`);
  if (!row) return;
  const meta = row.querySelector('.light-meta');
  if (!meta) return;
  meta.innerHTML = meta.innerHTML.replace(/\b(Reachable|Unreachable)\b/, 'Reachable');
  // Brief green flash so the operator notices the recovery
  meta.style.transition = 'color 0ms';
  meta.style.color = '#4ade80';
  setTimeout(() => {
    meta.style.transition = 'color 200ms';
    meta.style.color = '';
  }, 200);
});

// ── Lights panel ──────────────────────────────────────────────────────────────

const lightsList = document.getElementById('lights-list');
let dragSrc = null;

document.getElementById('btn-refresh-lights').addEventListener('click', refreshLights);

async function refreshLights() {
  if (!state.connected) {
    lightsList.innerHTML = '<div class="empty-state empty-state--left"><p>Not connected to a bridge</p></div>';
    return;
  }
  try {
    const res = await window.hue.getLights();
    state.lights = res.lights || [];
    renderLights();
  } catch (err) {
    console.error('[refreshLights] ERROR:', err);
    lightsList.innerHTML = `<div class="empty-state empty-state--left"><p>Error loading lights</p><small>${err.message}</small></div>`;
  }
}

function renderLights() {
  lightsList.innerHTML = '';
  if (state.lights.length === 0) {
    lightsList.innerHTML = '<div class="empty-state empty-state--left"><p>No lights found</p><small>Make sure your lights are powered on</small></div>';
    buildMonitorCards([]);
    return;
  }
  for (const light of state.lights) {
    try {
      lightsList.appendChild(buildLightRow(light));
    } catch (err) {
      console.error('[renderLights] buildLightRow threw for light', light && light.id, light && light.name, err);
    }
  }
  buildMonitorCards(state.lights);
  buildControlCards(state.lights);
  buildDmxBars();
}

// Update the Effective Patch summary in every visible light row.
// Called whenever the default universe input changes (live) or after a patch save.
function refreshEffectivePatch() {
  const proto       = lbProtocol.value;
  const defaultUniv = proto === 'sacn'
    ? (parseInt(lbSacnUniverse.value) || 1)
    : (parseInt(lbArtnetUniverse.value) || 0);

  lightsList.querySelectorAll('.light-row').forEach(row => {
    const light = state.lights.find(l => String(l.id) === String(row.dataset.id));
    if (!light || !light.dmx) return;
    const effectiveUniv = light.customAddress?.universe ?? defaultUniv;
    const patchText = `${effectiveUniv}-${light.dmx.start}`;
    const el = row.querySelector('.effective-patch');
    if (el) el.textContent = patchText;
  });

  // Also update the placeholder in any currently-open popup
  if (activePopup) {
    const univInput = activePopup.querySelector('.light-opts-univ');
    if (univInput) univInput.placeholder = `Using default (${defaultUniv})`;
  }
}

function buildLightRow(light) {
  const row       = document.createElement('div');
  row.className   = `light-row${light.disabled ? ' disabled-light' : ''}`;
  row.dataset.id  = light.id;
  row.draggable   = true;

  const swatchColor = getLightColor(light);
  const dmx         = light.dmx;
  const seqStart    = dmx ? dmx.start : null;
  const customCh   = light.customAddress?.channel  ?? null;
  const customUniv = light.customAddress?.universe ?? null;

  // Channel badges — turn purple when a custom patch is active
  const chBadges = dmx ? dmx.labels.map(l => {
    const [, name] = l.split(':');
    const cls = { R: 'r', G: 'g', B: 'b', CT: 'ct', Bri: 'bri' }[name] || '';
    return `<span class="ch-badge ${cls}${dmx.custom ? ' custom-patch' : ''}">${l}</span>`;
  }).join('') : '';

  // Universe badge — shown only when a non-default universe is patched
  const univBadge = customUniv != null
    ? `<span class="ch-badge universe-badge">U${customUniv}</span>`
    : '';

  // Patch column — "universe-startchannel" format, e.g. "22-1"
  // Read default universe from the listener bar (source of truth for current session),
  // falling back to saved config if the field is empty.
  const proto       = lbProtocol.value;
  const defaultUniv = proto === 'sacn'
    ? (parseInt(lbSacnUniverse.value)   || state.settings.sacnUniverse || 1)
    : (parseInt(lbArtnetUniverse.value) || state.settings.universe     || 0);
  const effectiveUniv = customUniv ?? defaultUniv;
  const effectivePatch = dmx ? `${effectiveUniv}-${dmx.start}` : '—';

  row.innerHTML = `
    <span class="drag-handle" title="Drag to reorder">⠿</span>
    <div class="light-color-swatch" style="background:${swatchColor}"></div>
    <div class="light-info">
      <div class="light-name">${light.name}</div>
      <div class="light-meta">ID: ${light.id} &nbsp;·&nbsp; ${light.state && light.state.reachable !== false ? 'Reachable' : 'Unreachable'}</div>
      <div class="light-dmx-channels">${univBadge}${chBadges}</div>
    </div>
    <div class="light-addr-wrap" title="Custom DMX start channel (leave blank for sequential)">
      <span class="light-addr-label">ch</span>
      <input type="number" class="light-addr-input" min="1" max="512"
        value="${customCh != null ? customCh : ''}"
        placeholder="${seqStart != null ? seqStart : '—'}">
    </div>
    <div class="light-patch-col">
      <span class="effective-patch">${effectivePatch}</span>
    </div>
    <button class="btn btn-secondary btn-sm btn-light-opts" title="Rename · Patch universe · Delete">⋯</button>
    <label class="toggle" title="${light.disabled ? 'Enable' : 'Disable'} in DMX mapping">
      <input type="checkbox" ${light.disabled ? '' : 'checked'}>
      <span class="toggle-slider"></span>
    </label>
  `;

  // ── Toggle disabled ────────────────────────────────────────────────────────
  row.querySelector('input[type=checkbox]').addEventListener('change', async () => {
    await window.hue.toggleDisabled(light.id);
    light.disabled = !light.disabled;
    row.classList.toggle('disabled-light', light.disabled);
    refreshLights();
  });

  // ── Custom DMX channel (inline) ────────────────────────────────────────────
  const addrInput = row.querySelector('.light-addr-input');
  addrInput.addEventListener('change', async () => {
    const raw  = addrInput.value.trim();
    const num  = parseInt(raw);
    const ch   = (raw === '' || isNaN(num)) ? null : Math.max(1, Math.min(512, num));
    const univ = light.customAddress?.universe ?? null;
    await window.hue.setLightAddress(light.id, { channel: ch, universe: univ });
    light.customAddress = (ch == null && univ == null) ? null : { channel: ch, universe: univ };
    refreshLights();
  });
  addrInput.addEventListener('mousedown', e => e.stopPropagation());

  // ── Options popup (⋯) ─────────────────────────────────────────────────────
  row.querySelector('.btn-light-opts').addEventListener('click', e => {
    e.stopPropagation();
    openLightOptionsPopup(light, e.currentTarget);
  });

  // ── Drag-and-drop reorder ──────────────────────────────────────────────────
  row.addEventListener('dragstart', (e) => { dragSrc = row; row.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
  row.addEventListener('dragend',   ()  => { row.classList.remove('dragging'); document.querySelectorAll('.light-row').forEach(r => r.classList.remove('drag-over')); });
  row.addEventListener('dragover',  (e) => { e.preventDefault(); if (dragSrc && dragSrc !== row) row.classList.add('drag-over'); });
  row.addEventListener('dragleave', ()  => row.classList.remove('drag-over'));
  row.addEventListener('drop', async (e) => {
    e.preventDefault();
    row.classList.remove('drag-over');
    if (!dragSrc || dragSrc === row) return;
    const rows   = [...lightsList.querySelectorAll('.light-row')];
    const srcIdx = rows.indexOf(dragSrc);
    const dstIdx = rows.indexOf(row);
    if (srcIdx < dstIdx) row.after(dragSrc); else row.before(dragSrc);
    const newOrder = [...lightsList.querySelectorAll('.light-row')].map(r => Number(r.dataset.id));
    await window.hue.setLightOrder(newOrder);
    await refreshLights();
  });

  return row;
}

// ── Light options popup (⋯) ───────────────────────────────────────────────────
// Provides: multi-universe DMX patch (universe + channel), rename, delete.

let activePopup = null;

function closeActivePopup() {
  if (activePopup) { activePopup.remove(); activePopup = null; }
}
document.addEventListener('mousedown', e => {
  if (activePopup && !activePopup.contains(e.target)) closeActivePopup();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeActivePopup(); });

function openLightOptionsPopup(light, trigger) {
  closeActivePopup();

  const _proto = lbProtocol.value;
  const mainUniverse = _proto === 'sacn'
    ? (parseInt(lbSacnUniverse.value)   || (state.settings.sacnUniverse ?? 1))
    : (parseInt(lbArtnetUniverse.value) || (state.settings.universe     ?? 0));
  const seqLabel     = light.dmx ? `${light.dmx.start}` : '—';
  const customCh     = light.customAddress?.channel  ?? null;
  const customUniv   = light.customAddress?.universe ?? null;

  const popup = document.createElement('div');
  popup.className = 'light-opts-popup';
  popup.addEventListener('mousedown', e => e.stopPropagation());

  popup.innerHTML = `
    <div class="light-opts-title">${light.name}</div>

    <div class="light-opts-section-label">DMX Patch</div>
    <div class="light-opts-patch-row">
      <div class="light-opts-field">
        <div style="display:flex;align-items:center;gap:5px;margin-bottom:3px">
          <span class="light-opts-field-label" style="margin-bottom:0">Universe Override</span>
          <span class="custom-badge pop-univ-custom" style="${customUniv != null ? '' : 'display:none'}">Custom</span>
        </div>
        <input type="number" class="input light-opts-univ${customUniv != null ? ' input-custom-patch' : ''}" min="0" max="63999"
          value="${customUniv != null ? customUniv : ''}"
          placeholder="Using default (${mainUniverse})">
      </div>
      <div class="light-opts-field">
        <span class="light-opts-field-label">Channel</span>
        <input type="number" class="input light-opts-ch" min="1" max="512"
          value="${customCh != null ? customCh : ''}"
          placeholder="${seqLabel}">
      </div>
    </div>
    <button class="btn btn-secondary btn-sm light-opts-patch-clear"
      style="${customCh == null && customUniv == null ? 'display:none' : ''}">
      Clear patch
    </button>

    <div class="light-opts-divider"></div>

    <div class="light-opts-section-label">Rename</div>
    <div class="light-opts-rename-row">
      <input type="text" class="input light-opts-rename"
        value="${light.name.replace(/"/g, '&quot;')}" placeholder="Light name…">
      <button class="btn btn-primary btn-sm light-opts-rename-confirm">✓</button>
    </div>

    <div class="light-opts-divider"></div>

    <button class="btn btn-danger btn-sm light-opts-delete" style="width:100%">Delete from bridge</button>
  `;

  // ── Save patch when inputs change ──────────────────────────────────────────
  async function savePatch() {
    const univStr = popup.querySelector('.light-opts-univ').value.trim();
    const chStr   = popup.querySelector('.light-opts-ch').value.trim();
    const univ    = univStr !== '' ? parseInt(univStr) : null;
    const ch      = chStr   !== '' ? parseInt(chStr)   : null;
    await window.hue.setLightAddress(light.id, { channel: ch, universe: univ });
    light.customAddress = (ch == null && univ == null) ? null : { channel: ch, universe: univ };
    // Sync inline channel input in the light row
    const addrInput = lightsList.querySelector(`.light-row[data-id="${light.id}"] .light-addr-input`);
    if (addrInput) addrInput.value = ch != null ? ch : '';
    popup.querySelector('.light-opts-patch-clear').style.display =
      (ch == null && univ == null) ? 'none' : '';
    // Toggle Custom badge and accent border on the universe input
    const univInput   = popup.querySelector('.light-opts-univ');
    const customBadge = popup.querySelector('.pop-univ-custom');
    univInput.classList.toggle('input-custom-patch', univ !== null);
    if (customBadge) customBadge.style.display = univ !== null ? '' : 'none';
    refreshLights();
  }
  popup.querySelector('.light-opts-univ').addEventListener('change', savePatch);
  popup.querySelector('.light-opts-ch').addEventListener('change',   savePatch);

  // ── Clear patch ────────────────────────────────────────────────────────────
  popup.querySelector('.light-opts-patch-clear').addEventListener('click', async () => {
    popup.querySelector('.light-opts-univ').value = '';
    popup.querySelector('.light-opts-ch').value   = '';
    await window.hue.setLightAddress(light.id, null);
    light.customAddress = null;
    popup.querySelector('.light-opts-patch-clear').style.display = 'none';
    // Clear Custom badge and accent border
    popup.querySelector('.light-opts-univ').classList.remove('input-custom-patch');
    const customBadge = popup.querySelector('.pop-univ-custom');
    if (customBadge) customBadge.style.display = 'none';
    refreshLights();
  });

  // ── Rename ─────────────────────────────────────────────────────────────────
  async function doRename() {
    const newName = popup.querySelector('.light-opts-rename').value.trim();
    if (!newName || newName === light.name) return;
    const res = await window.hue.renameLight(light.id, newName);
    if (res.success) {
      light.name = newName;
      popup.querySelector('.light-opts-title').textContent = newName;
      const nameEl = lightsList.querySelector(`.light-row[data-id="${light.id}"] .light-name`);
      if (nameEl) nameEl.textContent = newName;
      toast(`Renamed to "${newName}"`, 'success');
    } else {
      toast(`Rename failed: ${res.error || ''}`, 'error');
    }
  }
  popup.querySelector('.light-opts-rename-confirm').addEventListener('click', doRename);
  popup.querySelector('.light-opts-rename').addEventListener('keydown', e => {
    if (e.key === 'Enter') doRename();
  });

  // ── Delete ─────────────────────────────────────────────────────────────────
  const deleteBtn = popup.querySelector('.light-opts-delete');
  let deleteTimer = null;
  deleteBtn.addEventListener('click', async () => {
    if (deleteBtn.dataset.confirm === 'true') {
      clearTimeout(deleteTimer);
      const res = await window.hue.deleteLight(light.id);
      if (res.success) {
        closeActivePopup();
        const row = lightsList.querySelector(`.light-row[data-id="${light.id}"]`);
        if (row) row.remove();
        state.lights = state.lights.filter(l => String(l.id) !== String(light.id));
        toast(`"${light.name}" removed from bridge`, 'info');
      } else {
        toast(`Delete failed: ${res.error || ''}`, 'error');
        deleteBtn.dataset.confirm = '';
        deleteBtn.textContent = 'Delete from bridge';
      }
    } else {
      deleteBtn.dataset.confirm = 'true';
      deleteBtn.textContent = 'Confirm delete?';
      deleteTimer = setTimeout(() => {
        if (deleteBtn.dataset.confirm === 'true') {
          deleteBtn.dataset.confirm = '';
          deleteBtn.textContent = 'Delete from bridge';
        }
      }, 3000);
    }
  });

  // ── Position ───────────────────────────────────────────────────────────────
  document.body.appendChild(popup);
  const rect = trigger.getBoundingClientRect();
  const pw   = popup.offsetWidth  || 240;
  const ph   = popup.offsetHeight || 300;
  let left   = rect.right - pw;
  let top    = rect.bottom + 4;
  if (left < 8)                           left = 8;
  if (left + pw > window.innerWidth - 8)  left = window.innerWidth  - pw - 8;
  if (top  + ph > window.innerHeight - 8) top  = rect.top - ph - 4;
  popup.style.left = `${Math.round(left)}px`;
  popup.style.top  = `${Math.round(top)}px`;

  activePopup = popup;
}

function getLightColor(light) {
  if (!light.state) return 'rgba(255,255,255,0.1)';
  const s = light.state;
  if (!s.on) return 'rgba(255,255,255,0.05)';
  if (s.colormode === 'ct') {
    const bri = (s.bri || 128) / 254;
    const v   = Math.round(bri * 255);
    return `rgb(${v}, ${Math.round(v * 0.9)}, ${Math.round(v * 0.7)})`;
  }
  if (s.hue !== undefined && s.sat !== undefined) {
    const h   = (s.hue / 65535) * 360;
    const sat = (s.sat / 254) * 100;
    const bri = Math.round(((s.bri || 128) / 254) * 50);
    return `hsl(${h}, ${sat}%, ${bri}%)`;
  }
  return 'rgba(255,255,255,0.2)';
}

// Live DMX swatch updates
window.hue.on('artnet:dmx-update', (dmx, universe) => {
  // Store frame in per-universe cache
  const univ = universe ?? state.settings.universe ?? 0;
  dmxByUniverse[univ] = dmx;

  updateDmxBars();
  onDmxPacket(univ);

  const { dmxAddress, white, transition } = state.settings;
  if (!dmxAddress) return;
  const channelsPerLight = white ? 5 : 3;
  const base = (dmxAddress - 1) + (transition === 'channel' ? 1 : 0);
  // Use the protocol-aware default universe (same logic as updateDmxBars / updateMonitorCards)
  const proto    = lbProtocol.value;
  const mainUniv = proto === 'sacn'
    ? (parseInt(lbSacnUniverse.value)   || (state.settings.sacnUniverse ?? 1))
    : (parseInt(lbArtnetUniverse.value) || (state.settings.universe     ?? 0));

  // Use per-light addressing from state.lights (supports custom patches)
  for (let i = 0; i < state.lights.length; i++) {
    const light = state.lights[i];
    const patch = light.customAddress;
    const lightUniv   = patch?.universe ?? mainUniv;
    const lightBuffer = dmxByUniverse[lightUniv] || [];
    const offset = patch?.channel != null
      ? (patch.channel - 1)
      : base + i * channelsPerLight;

    if (offset + 2 >= lightBuffer.length) continue;
    const r = lightBuffer[offset], g = lightBuffer[offset + 1], b = lightBuffer[offset + 2];
    const on = r > 0 || g > 0 || b > 0;

    // Update lights-tab swatch
    const row = lightsList.querySelector(`.light-row[data-id="${light.id}"]`);
    if (row) {
      const swatch = row.querySelector('.light-color-swatch');
      if (swatch) swatch.style.background = on ? `rgb(${r},${g},${b})` : 'rgba(255,255,255,0.05)';
    }

    // Update control-tab tile swatch
    const tile = controlGrid.querySelector(`[data-light-id="${light.id}"]`);
    if (tile) {
      const color = on ? `rgb(${r},${g},${b})` : 'rgba(255,255,255,0.05)';
      const swatch = tile.querySelector('.ctrl-color-swatch');
      if (swatch) swatch.style.background = color;
      if (on) tile.style.setProperty('--tile-color', color);
    }
  }
});

// ── DMX bar visualization ─────────────────────────────────────────────────────

function buildDmxBars() {
  const wrap = document.getElementById('dmx-bar-wrap');
  wrap.innerHTML = '';
  if (state.lights && state.lights.length > 0) {
    // One bar per fixture channel, tagged with the light id and channel offset
    for (const light of state.lights) {
      if (!light.dmx) continue;
      for (let j = 0; j < light.dmx.channels; j++) {
        const bar = document.createElement('div');
        bar.className        = 'dmx-bar';
        bar.dataset.lightId  = light.id;
        bar.dataset.chOffset = j;
        bar.style.height     = '0px';
        wrap.appendChild(bar);
      }
    }
  } else {
    // No lights loaded yet — show 64 generic placeholder bars
    for (let i = 0; i < 64; i++) {
      const bar = document.createElement('div');
      bar.className    = 'dmx-bar';
      bar.style.height = '0px';
      wrap.appendChild(bar);
    }
  }
}

function updateDmxBars() {
  const cfg = state.settings;
  const proto    = lbProtocol.value;
  const mainUniv = proto === 'sacn'
    ? (parseInt(lbSacnUniverse.value)   || cfg.sacnUniverse || 1)
    : (parseInt(lbArtnetUniverse.value) || cfg.universe     || 0);

  document.querySelectorAll('.dmx-bar[data-light-id]').forEach(bar => {
    const light     = state.lights.find(l => String(l.id) === String(bar.dataset.lightId));
    if (!light || !light.dmx) return;
    const patch     = light.customAddress;
    const lightUniv = patch?.universe ?? mainUniv;
    const buf       = dmxByUniverse[lightUniv] || [];
    // light.dmx.start is 1-based; subtract 1 for 0-based array index
    const val = buf[(light.dmx.start - 1) + parseInt(bar.dataset.chOffset)] || 0;
    bar.style.height = `${Math.round((val / 255) * 24)}px`;
  });
}

// ── OTA Updates ───────────────────────────────────────────────────────────────

const updateBanner       = document.getElementById('update-banner');
const updateBannerText   = document.getElementById('update-banner-text');
const updateProgressWrap = document.getElementById('update-progress-wrap');
const updateProgressBar  = document.getElementById('update-progress-bar');
const btnUpdateDownload  = document.getElementById('btn-update-download');
const btnUpdateInstall   = document.getElementById('btn-update-install');

window.hue.on('update:available', ({ version }) => {
  updateBannerText.textContent = `Update available: v${version}`;
  updateBanner.style.display = 'flex';
});

window.hue.on('update:progress', ({ percent }) => {
  updateProgressWrap.style.display  = 'flex';
  updateProgressBar.style.width     = `${percent}%`;
  updateBannerText.textContent      = `Downloading update… ${percent}%`;
  btnUpdateDownload.style.display   = 'none';
  btnUpdateDownload.disabled        = false;
  btnUpdateDownload.textContent     = 'Download';
});

window.hue.on('update:downloaded', () => {
  updateBannerText.textContent    = '✓ Update downloaded — restart to install';
  updateProgressWrap.style.display = 'none';
  btnUpdateInstall.style.display  = '';
  btnUpdateDownload.style.display = 'none';
});

window.hue.on('update:error', ({ message }) => {
  updateBannerText.textContent    = 'Update available';
  updateProgressWrap.style.display = 'none';
  btnUpdateDownload.style.display = '';
  btnUpdateDownload.disabled      = false;
  toast(`Update failed: ${message}`, 'error');
});

btnUpdateDownload.addEventListener('click', () => {
  btnUpdateDownload.disabled = true;
  btnUpdateDownload.textContent = 'Downloading…';
  window.hue.downloadUpdate();
});
btnUpdateInstall.addEventListener('click',  () => window.hue.installUpdate());
document.getElementById('btn-update-dismiss').addEventListener('click', () => {
  updateBanner.style.display = 'none';
});

// ── Color picker helpers ──────────────────────────────────────────────────────

function hexToHsb(hex) {
  const n = parseInt((hex || '#000000').replace('#', ''), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  const v = max, s = max === 0 ? 0 : d / max;
  let h = 0;
  if (d > 0) {
    if      (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else                h = (r - g) / d + 4;
    h /= 6;
  }
  return [h * 360, s, v]; // h: 0–360, s: 0–1, v: 0–1
}

function hsbToHex(h, s, v) {
  h = ((h % 360) + 360) % 360;
  const i = Math.floor(h / 60) % 6, f = h / 60 - Math.floor(h / 60);
  const p = v*(1-s), q = v*(1-f*s), t = v*(1-(1-f)*s);
  const [r, g, b] = [[v,t,p],[q,v,p],[p,v,t],[p,q,v],[t,p,v],[v,p,q]][i];
  return '#' + [r, g, b].map(x => Math.round(x*255).toString(16).padStart(2,'0')).join('');
}

// Build a pair of inline hue + saturation strip pickers.
// onColor(hex) fires on every drag interaction; hex is always full-brightness.
function buildColorStrips(initHex, onColor) {
  const el = document.createElement('div');
  el.className = 'ctrl-picker-strips';

  // Hidden native color input — opens the OS color picker on click
  const input = document.createElement('input');
  input.type = 'color';
  input.value = initHex;
  input.className = 'ctrl-color-input';

  input.addEventListener('input', () => onColor(input.value));
  input.addEventListener('change', () => onColor(input.value));

  el.appendChild(input);

  // Allow external sync
  el.setColor = hex => { input.value = hex; };
  return el;
}

// ── Control panel ─────────────────────────────────────────────────────────────

const controlGrid       = document.getElementById('control-grid');
const dmxOverrideBanner = document.getElementById('dmx-override-banner');
const dmxOverrideInfo   = document.getElementById('dmx-override-info');
const sceneSelect       = document.getElementById('scene-select');
const sceneNameRow      = document.getElementById('scene-name-row');

// Group selection
const selectedLights = new Set();
let groupHex = '#ffcc66'; // persists across group bar rebuilds

function getGroupBar() { return document.getElementById('group-bar'); }

function updateGroupBar() {
  let bar = getGroupBar();
  if (selectedLights.size < 1) {
    if (bar) bar.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'group-bar';
    bar.innerHTML = `
      <span id="group-bar-label"></span>
      <div class="group-bar-color">
        <div class="group-bar-swatch"></div>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:11px;color:var(--text3)">Bri</span>
        <input type="range" min="1" max="100" value="100" class="bri-slider" id="group-bri" style="width:110px">
        <span id="group-bri-val" class="bri-val">100%</span>
      </div>
      <button class="btn btn-secondary btn-sm" id="group-clear">✕ Clear</button>`;
    controlGrid.parentElement.insertBefore(bar, controlGrid);

    const groupSwatch = bar.querySelector('.group-bar-swatch');
    const groupBri    = bar.querySelector('#group-bri');
    const groupBriVal = bar.querySelector('#group-bri-val');

    const sendGroup = debounce(() => {
      const rgb = groupHex;
      const bri = parseInt(groupBri.value);
      for (const id of selectedLights) {
        controlState[id] = { ...controlState[id], rgb, bri, on: true };
        sendLightState(id, controlState[id]);
        const tile = controlGrid.querySelector(`[data-light-id="${id}"]`);
        if (tile) {
          applyTileVisual(tile, controlState[id]);
          tile.querySelector('.ctrl-bri').value      = bri;
          tile.querySelector('.bri-val').textContent = `${bri}%`;
          // keep per-tile strips in sync
          const tileStrips = tile.querySelector('.ctrl-picker-strips');
          if (tileStrips && tileStrips.setColor) tileStrips.setColor(rgb);
        }
      }
    }, 80);

    // Build hue+sat strips for group bar
    const groupStrips = buildColorStrips(groupHex, hex => {
      groupHex = hex;
      groupSwatch.style.background = hex;
      sendGroup();
    });
    bar.querySelector('.group-bar-color').appendChild(groupStrips);
    groupSwatch.style.background = groupHex;

    groupBri.addEventListener('input', e => {
      groupBriVal.textContent = `${e.target.value}%`;
      sendGroup();
    });
    bar.querySelector('#group-clear').addEventListener('click', () => {
      selectedLights.clear();
      controlGrid.querySelectorAll('.ctrl-tile.selected')
        .forEach(c => c.classList.remove('selected'));
      updateGroupBar();
    });
  }
  bar.querySelector('#group-bar-label').textContent =
    `${selectedLights.size} light${selectedLights.size > 1 ? 's' : ''} selected`;
}

function toggleCardSelect(lightId, card) {
  if (selectedLights.has(lightId)) {
    selectedLights.delete(lightId);
    card.classList.remove('selected');
  } else {
    selectedLights.add(lightId);
    card.classList.add('selected');
  }
  updateGroupBar();
}
const sceneNameInput    = document.getElementById('scene-name-input');

// Debounce helper
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// Per-light state stored in renderer (and persisted to config)
const controlState = {}; // { lightId: { on, rgb, bri } }

// Debounced persist — writes controlState to config ~1.5 s after last change
const persistControlState = debounce(() => {
  window.hue.saveSettings({ lightStates: { ...controlState } });
}, 1500);

// Apply color + on/off visuals to a tile element
function applyTileVisual(tile, s) {
  tile.style.setProperty('--tile-color', s.rgb);
  tile.classList.toggle('active', !!s.on);
  const swatch = tile.querySelector('.ctrl-color-swatch');
  if (swatch) swatch.style.background = s.on ? s.rgb : '';
}

function buildControlCards(lights) {
  selectedLights.clear();
  updateGroupBar();
  if (!lights || lights.length === 0) {
    controlGrid.innerHTML = '<div class="empty-state"><p>Connect to a bridge and load lights first</p></div>';
    return;
  }
  controlGrid.innerHTML = '';

  // Seed from persisted config if available
  const saved = (state.settings && state.settings.lightStates) || {};

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
    tile.className      = 'ctrl-tile' + (s.on ? ' active' : '');
    tile.dataset.lightId = light.id;
    tile.style.setProperty('--tile-color', s.rgb);
    tile.innerHTML = `
      <div class="ctrl-tile-glow"></div>
      <div class="ctrl-tile-top">
        <button class="ctrl-sel-dot" title="Select for group control"></button>
        <button class="ctrl-power-btn" title="Toggle on/off">⏻</button>
      </div>
      <div class="ctrl-tile-mid">
        <div class="ctrl-color-swatch" style="background:${getLightColor(light)}"></div>
      </div>
      <div class="ctrl-tile-bot">
        <span class="ctrl-tile-name">${light.name}</span>
        <div class="ctrl-bri-row">
          <input type="range" min="1" max="100" value="${s.bri}" class="bri-slider ctrl-bri">
          <span class="bri-val">${s.bri}%</span>
        </div>
      </div>`;

    // Insert hue + sat strip picker between mid and bot
    const sendColor = debounce(rgb => {
      s.rgb = rgb;
      applyTileVisual(tile, s);
      sendLightState(light.id, s);
    }, 80);
    const strips = buildColorStrips(s.rgb, sendColor);
    tile.querySelector('.ctrl-tile-mid').after(strips);

    tile.querySelector('.ctrl-sel-dot').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleCardSelect(light.id, tile);
    });

    tile.querySelector('.ctrl-power-btn').addEventListener('click', () => {
      s.on = !s.on;
      applyTileVisual(tile, s);
      sendLightState(light.id, s);
    });

    const sendBri = debounce((bri) => { s.bri = bri; sendLightState(light.id, s); }, 80);
    tile.querySelector('.ctrl-bri').addEventListener('input', (e) => {
      const bri = parseInt(e.target.value);
      tile.querySelector('.bri-val').textContent = `${bri}%`;
      sendBri(bri);
    });

    controlGrid.appendChild(tile);
  }

  // Re-apply DMX override dimming if it was active when the tab was re-entered
  if (state.dmxActive) {
    dmxOverrideBanner.style.display = 'flex';
    controlGrid.querySelectorAll('.ctrl-tile').forEach(c => c.classList.add('dmx-active'));
  }
}

// Fetch fresh bridge states and update ctrl-tile swatches to reflect reality.
// Skipped when DMX is active — the dmx-update handler keeps them live instead.
async function refreshControlSwatches() {
  if (!state.connected || state.dmxActive) return;
  const res = await window.hue.getLights();
  if (!res || !res.lights) return;
  for (const light of res.lights) {
    const tile = controlGrid.querySelector(`[data-light-id="${light.id}"]`);
    if (!tile) continue;
    const color = getLightColor(light);
    const swatch = tile.querySelector('.ctrl-color-swatch');
    if (swatch) swatch.style.background = color;
    tile.style.setProperty('--tile-color', color);
    tile.classList.toggle('active', !!(light.state && light.state.on));
  }
}

async function sendLightState(lightId, s) {
  persistControlState();
  if (!s.on) {
    await window.hue.setLightState(lightId, { on: false });
    return;
  }
  await window.hue.setLightState(lightId, { on: true, rgb: s.rgb, bri: s.bri });
}

// DMX takeover — dim tiles while DMX is active
window.hue.on('dmx:takeover-change', ({ active }) => {
  state.dmxActive = active; // persist so buildControlCards can re-apply on tab re-entry
  dmxOverrideBanner.style.display = active ? 'flex' : 'none';
  controlGrid.querySelectorAll('.ctrl-tile').forEach(c => c.classList.toggle('dmx-active', active));
  dmxOverrideInfo.textContent = '';
});

// ── Scenes ────────────────────────────────────────────────────────────────────

async function loadScenes() {
  const scenes = await window.hue.getScenes();
  sceneSelect.innerHTML = '<option value="">— No scene —</option>';
  for (const name of Object.keys(scenes)) {
    const opt = document.createElement('option');
    opt.value = opt.textContent = name;
    sceneSelect.appendChild(opt);
  }
  const hasSel = sceneSelect.value !== '';
  document.getElementById('btn-apply-scene').disabled  = !hasSel;
  document.getElementById('btn-delete-scene').disabled = !hasSel;
}

sceneSelect.addEventListener('change', () => {
  const hasSel = sceneSelect.value !== '';
  document.getElementById('btn-apply-scene').disabled  = !hasSel;
  document.getElementById('btn-delete-scene').disabled = !hasSel;
});

document.getElementById('btn-apply-scene').addEventListener('click', async () => {
  const name = sceneSelect.value;
  if (!name) return;
  const res = await window.hue.applyScene(name);
  toast(res.success ? `Scene "${name}" applied` : `Failed: ${(res.errors || []).join(', ')}`,
        res.success ? 'success' : 'error');
});

document.getElementById('btn-save-scene').addEventListener('click', () => {
  sceneNameRow.style.display = 'flex';
  sceneNameInput.value = '';
  sceneNameInput.focus();
});

document.getElementById('btn-scene-name-confirm').addEventListener('click', saveCurrentScene);
sceneNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveCurrentScene(); });

async function saveCurrentScene() {
  const name = sceneNameInput.value.trim();
  if (!name) return;
  sceneNameRow.style.display = 'none';

  const snapshot = Object.entries(controlState).map(([id, s]) => ({ id, ...s }));
  await window.hue.saveScene(name, snapshot);
  await loadScenes();
  sceneSelect.value = name;
  sceneSelect.dispatchEvent(new Event('change'));
  toast(`Scene "${name}" saved`, 'success');
}

document.getElementById('btn-scene-name-cancel').addEventListener('click', () => {
  sceneNameRow.style.display = 'none';
});

document.getElementById('btn-delete-scene').addEventListener('click', async () => {
  const name = sceneSelect.value;
  if (!name) return;
  await window.hue.deleteScene(name);
  await loadScenes();
  toast(`Scene "${name}" deleted`, 'info');
});

// ── Monitor panel ─────────────────────────────────────────────────────────────

const monitorSignalDot    = document.getElementById('monitor-signal-dot');
const monitorSignalLabel  = document.getElementById('monitor-signal-label');
const monitorSignalAge    = document.getElementById('monitor-signal-age');
const monitorUniverseLabel = document.getElementById('monitor-universe-label');
const monitorGrid         = document.getElementById('monitor-grid');

let lastPacketMs    = 0;
let signalAgeTimer  = null;

function updateSignalAge() {
  if (!lastPacketMs) return;
  const age = Date.now() - lastPacketMs;
  monitorSignalAge.textContent = age < 2000
    ? `(${age < 100 ? '<100' : age}ms ago)`
    : `(${(age / 1000).toFixed(1)}s ago)`;
  if (age >= 2000) {
    monitorSignalDot.classList.remove('active');
    monitorSignalLabel.textContent = 'Signal lost';
  }
}

function onDmxPacket(packetUniverse) {
  lastPacketMs = Date.now();
  monitorSignalDot.classList.add('active');
  monitorSignalLabel.textContent = 'Receiving';

  const cfg   = state.settings;
  const proto = cfg.protocol || 'artnet';
  const univ  = packetUniverse ?? (proto === 'sacn' ? (cfg.sacnUniverse ?? 1) : (cfg.universe ?? 0));
  monitorUniverseLabel.textContent =
    `${proto === 'sacn' ? 'sACN' : proto === 'both' ? 'Art-Net+sACN' : 'Art-Net'} · Universe ${univ}`;

  if (!signalAgeTimer) signalAgeTimer = setInterval(updateSignalAge, 250);
  updateMonitorCards();
}

function buildMonitorCards(lights) {
  if (!lights || lights.length === 0) {
    monitorGrid.innerHTML = '<div class="empty-state"><div class="icon">📡</div><p>No lights loaded — go to Lights tab and refresh</p></div>';
    return;
  }
  monitorGrid.innerHTML = '';
  for (const light of lights) {
    if (!light.dmx) continue;
    const card       = document.createElement('div');
    card.className   = 'monitor-card';
    card.dataset.lightId = light.id;

    const channelRows = light.dmx.labels.map(lbl => {
      const [chStr, name] = lbl.split(':');
      const cls = { R: 'r', G: 'g', B: 'b', CT: 'ct', Bri: 'bri' }[name] || '';
      return `<div class="monitor-channel" data-ch="${chStr}">
        <span class="monitor-ch-label">${name}</span>
        <div class="monitor-bar-bg"><div class="monitor-bar-fill ${cls}" style="width:0%"></div></div>
        <span class="monitor-ch-val">0</span>
      </div>`;
    }).join('');

    card.innerHTML = `
      <div class="monitor-card-header">
        <div class="monitor-swatch"></div>
        <span class="monitor-card-name">${light.name}</span>
        <span class="monitor-card-ch">ch${light.dmx.start}–${light.dmx.start + light.dmx.channels - 1}</span>
      </div>
      ${channelRows}`;
    monitorGrid.appendChild(card);
  }
}

function updateMonitorCards() {
  const cfg = state.settings;
  if (!cfg.dmxAddress) return;
  const channelsPerLight = 3;
  const base     = (cfg.dmxAddress - 1) + (cfg.transition === 'channel' ? 1 : 0);
  // Read from listener bar (same source of truth used everywhere else), fall back to saved config
  const proto    = lbProtocol.value;
  const mainUniv = proto === 'sacn'
    ? (parseInt(lbSacnUniverse.value)   || cfg.sacnUniverse || 1)
    : (parseInt(lbArtnetUniverse.value) || cfg.universe     || 0);

  // Build a quick lookup: lightId → index in state.lights (for sequential offset calc)
  const lightIndex = {};
  state.lights.forEach((l, i) => { lightIndex[l.id] = i; });

  monitorGrid.querySelectorAll('.monitor-card').forEach(card => {
    const lightId = card.dataset.lightId;
    const light   = state.lights.find(l => String(l.id) === String(lightId));
    const idx     = lightIndex[lightId] ?? 0;

    const patch      = light?.customAddress;
    const lightUniv  = patch?.universe ?? mainUniv;
    const dmx        = dmxByUniverse[lightUniv] || [];
    const offset     = patch?.channel != null
      ? (patch.channel - 1)
      : base + idx * channelsPerLight;

    const channels = card.querySelectorAll('.monitor-channel');
    let anyActive  = false;

    channels.forEach((row, j) => {
      const val = dmx[offset + j] || 0;
      if (val > 0) anyActive = true;
      row.querySelector('.monitor-bar-fill').style.width = `${(val / 255) * 100}%`;
      row.querySelector('.monitor-ch-val').textContent   = val;
    });

    const r = dmx[offset] || 0, g = dmx[offset + 1] || 0, b = dmx[offset + 2] || 0;
    card.querySelector('.monitor-swatch').style.background =
      (r > 0 || g > 0 || b > 0) ? `rgb(${r},${g},${b})` : 'rgba(255,255,255,0.05)';
    card.classList.toggle('active', anyActive);
  });
}

// ── sACN diagnostics ──────────────────────────────────────────────────────────

const sacnDiagBar  = document.getElementById('sacn-diag-bar');
const sacnDiagText = document.getElementById('sacn-diag-text');
const sacnDiagIcon = document.getElementById('sacn-diag-icon');

window.hue.on('sacn:diag', ({ rawCount, lastUniverse, wrongUniverse, configured, watched, lastSize }) => {
  const proto = (state.settings && state.settings.protocol) || 'artnet';
  if (proto === 'artnet') { sacnDiagBar.style.display = 'none'; return; }

  sacnDiagBar.style.display = 'flex';

  if (rawCount === 0) {
    sacnDiagBar.className = '';
    sacnDiagIcon.textContent = '📡';
    sacnDiagText.textContent = `sACN: No UDP packets received on port 5568 yet`;
    return;
  }
  if (lastUniverse === null) {
    sacnDiagBar.className = '';
    sacnDiagIcon.textContent = '';
    sacnDiagText.textContent = `sACN: ${rawCount} packets received but none matched E1.31 format (last: ${lastSize} bytes)`;
    return;
  }
  // Only warn if the last universe is completely unknown — not just an override universe
  const watchedSet = new Set(watched || [configured]);
  if (!watchedSet.has(lastUniverse)) {
    sacnDiagBar.className = 'mismatch';
    sacnDiagIcon.textContent = '';
    sacnDiagText.textContent =
      `sACN: Receiving universe ${lastUniverse} — app is configured for universe ${configured}. ` +
      `Change sACN Universe in Settings to ${lastUniverse}.`;
    return;
  }
  const univList = watched && watched.length > 1 ? watched.join(', ') : `${configured}`;
  sacnDiagBar.className = 'ok';
  sacnDiagIcon.textContent = '✓';
  sacnDiagText.textContent = `sACN: Receiving · Universes ${univList} · ${rawCount} packets`;
});

// ── NIC selectors ─────────────────────────────────────────────────────────────

async function loadNicSelectors(savedIp) {
  const ifaces    = await window.hue.getNetworkInterfaces();
  const selectors = ['discover-nic', 's-nic'];

  for (const id of selectors) {
    const sel  = document.getElementById(id);
    const prev = sel.value;
    sel.innerHTML = '';
    for (const iface of ifaces) {
      const opt       = document.createElement('option');
      opt.value       = iface.ip;
      opt.textContent = iface.label;
      if (iface.internal) opt.style.color = 'var(--text3)';
      sel.appendChild(opt);
    }
    const target = (id === 's-nic' && savedIp) ? savedIp : prev;
    if ([...sel.options].some(o => o.value === target)) sel.value = target;
  }
}

document.getElementById('btn-refresh-nics-discover').addEventListener('click', () => loadNicSelectors());
document.getElementById('btn-refresh-nics-settings').addEventListener('click', () => loadNicSelectors());

// ── Settings panel ────────────────────────────────────────────────────────────

function updateProtocolVisibility(_protocol) {
  // sACN fields are always visible in Settings so they can always be configured.
  // Protocol-based field hiding only applies to the listener bar (handled separately).
  document.getElementById('sacn-fields').style.display = '';
}

function updateMulticastHint() {
  const universe = parseInt(document.getElementById('s-sacn-universe').value) || 1;
  document.getElementById('sacn-multicast-group').textContent =
    `239.255.${(universe >> 8) & 0xff}.${universe & 0xff}`;
}

async function refreshSettings() {
  const cfg    = await window.hue.getSettings();
  state.settings = cfg;

  await loadNicSelectors(cfg.host);

  document.getElementById('s-address').value        = cfg.dmxAddress  ?? 1;
  document.getElementById('s-universe').value       = cfg.universe    ?? 0;
  document.getElementById('s-sacn-universe').value  = cfg.sacnUniverse ?? 1;
  document.getElementById('s-sacn-multicast').checked = cfg.sacnMulticast !== false;
  document.getElementById('s-transition').value     = cfg.transition === 'channel' ? 'channel' : (cfg.transition ?? 100);
  document.getElementById('s-nolimit').checked      = !!cfg.noLimit;

  // Launch at Login (read from OS — not stored in config.json)
  const loginItemEl = document.getElementById('s-login-item');
  if (loginItemEl) {
    window.hue.getLoginItem().then(enabled => { loginItemEl.checked = !!enabled; }).catch(() => {});
  }

  updateProtocolVisibility(cfg.protocol ?? 'artnet');
  updateMulticastHint();

  // Sync listener bar
  lbProtocol.value         = cfg.protocol    ?? 'artnet';
  lbArtnetUniverse.value   = cfg.universe    ?? 0;
  lbSacnUniverse.value     = cfg.sacnUniverse ?? 1;
  updateListenerBarVisibility(lbProtocol.value);

  const artnetStatus = await window.hue.artnetStatus();
  setListenerRunning(artnetStatus.running);
}

// Launch at Login — saves immediately (OS setting, not in config.json)
const loginItemEl = document.getElementById('s-login-item');
if (loginItemEl) {
  loginItemEl.addEventListener('change', () => {
    window.hue.setLoginItem(loginItemEl.checked).catch(() => {});
  });
}

document.getElementById('s-sacn-universe').addEventListener('input', () => {
  lbSacnUniverse.value = document.getElementById('s-sacn-universe').value;
  updateMulticastHint();
});
document.getElementById('s-universe').addEventListener('input', () => {
  lbArtnetUniverse.value = document.getElementById('s-universe').value;
});

document.getElementById('btn-save-settings').addEventListener('click', async () => {
  const transRaw = document.getElementById('s-transition').value.trim();
  const updates  = {
    protocol:      lbProtocol.value,
    dmxAddress:    parseInt(document.getElementById('s-address').value)       || 1,
    universe:      parseInt(document.getElementById('s-universe').value)      || 0,
    sacnUniverse:  parseInt(document.getElementById('s-sacn-universe').value) || 1,
    sacnMulticast: document.getElementById('s-sacn-multicast').checked,
    host:          document.getElementById('s-nic').value || '0.0.0.0',
    transition:    transRaw === 'channel' ? 'channel' : (parseInt(transRaw) || 100),
    noLimit:       document.getElementById('s-nolimit').checked,
  };

  await window.hue.saveSettings(updates);
  state.settings = { ...state.settings, ...updates };
  toast('Settings saved', 'success');

  if (state.artnetRunning) {
    await window.hue.stopArtnet();
    await window.hue.startArtnet();
  }
});

// ── Light discovery (Find New Lights) ─────────────────────────────────────────

let discoveryTimer     = null;
let discoveryPollCount = 0;

document.getElementById('btn-find-lights').addEventListener('click', startDiscovery);

document.getElementById('btn-discovery-done').addEventListener('click', async () => {
  clearInterval(discoveryTimer);
  discoveryTimer = null;
  document.getElementById('lights-discovery').style.display = 'none';
  await refreshLights();
});

async function startDiscovery() {
  if (!state.connected) { toast('Connect to a bridge first', 'error'); return; }

  const discoveryEl = document.getElementById('lights-discovery');
  const resultsEl   = document.getElementById('discovery-results');
  const statusEl    = document.getElementById('discovery-status-text');
  const spinnerEl   = document.getElementById('discovery-spinner');

  // Reset state
  clearInterval(discoveryTimer);
  discoveryTimer     = null;
  discoveryPollCount = 0;
  resultsEl.innerHTML = '<div class="hint" style="padding:8px 0">Starting scan…</div>';
  statusEl.textContent = 'Scanning for new lights (40 s)…';
  spinnerEl.style.display = '';
  discoveryEl.style.display = '';

  const res = await window.hue.searchNewLights();
  if (!res.success) {
    toast(`Discovery failed: ${res.error || ''}`, 'error');
    discoveryEl.style.display = 'none';
    return;
  }

  const seenIds = new Set();

  function buildDiscoveryItem(found) {
    const item = document.createElement('div');
    item.className = 'discovery-found-row';
    item.innerHTML = `
      <div class="light-color-swatch" style="background:rgba(255,255,255,0.1);width:28px;height:28px;flex-shrink:0"></div>
      <div class="discovery-found-info">
        <span class="discovery-found-name">${found.name}</span>
        <input class="input discovery-rename-input" type="text" value="${found.name.replace(/"/g,'&quot;')}" style="display:none">
        <span class="hint">ID: ${found.id}</span>
      </div>
      <button class="btn btn-secondary btn-sm discovery-rename-btn"     title="Rename">✎</button>
      <button class="btn btn-primary   btn-sm discovery-rename-confirm" style="display:none" title="Confirm">✓</button>
    `;

    const nameSpan   = item.querySelector('.discovery-found-name');
    const nameInput  = item.querySelector('.discovery-rename-input');
    const renameBtn  = item.querySelector('.discovery-rename-btn');
    const confirmBtn = item.querySelector('.discovery-rename-confirm');

    function enterEdit() {
      nameSpan.style.display   = 'none';
      nameInput.style.display  = '';
      renameBtn.style.display  = 'none';
      confirmBtn.style.display = '';
      nameInput.focus(); nameInput.select();
    }
    async function doRename() {
      const newName = nameInput.value.trim();
      if (newName && newName !== found.name) {
        const r = await window.hue.renameLight(found.id, newName);
        if (r.success) {
          found.name = newName;
          nameSpan.textContent = newName;
          toast(`Renamed to "${newName}"`, 'success');
        } else {
          toast(`Rename failed: ${r.error || ''}`, 'error');
        }
      }
      nameSpan.style.display   = '';
      nameInput.style.display  = 'none';
      renameBtn.style.display  = '';
      confirmBtn.style.display = 'none';
    }

    renameBtn.addEventListener('click',  enterEdit);
    confirmBtn.addEventListener('click', doRename);
    nameInput.addEventListener('keydown', e => {
      if (e.key === 'Enter')  doRename();
      if (e.key === 'Escape') {
        nameSpan.style.display = ''; nameInput.style.display = 'none';
        renameBtn.style.display = ''; confirmBtn.style.display = 'none';
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
      const placeholder = resultsEl.querySelector('.hint');
      if (placeholder) placeholder.remove();
      resultsEl.appendChild(buildDiscoveryItem(found));
    }

    // Stop polling when scan ends or after ~42 s (14 × 3 s)
    if (!r.scanning || discoveryPollCount >= 14) {
      clearInterval(discoveryTimer);
      discoveryTimer = null;
      spinnerEl.style.display = 'none';
      statusEl.textContent = seenIds.size > 0
        ? `Found ${seenIds.size} new light${seenIds.size !== 1 ? 's' : ''}. Click Done to add them to your list.`
        : 'Scan complete — no new lights found. Make sure the bulb is powered on and close to the bridge.';
    }
  }

  discoveryTimer = setInterval(pollForNewLights, 3000);
  // First poll after a short delay so the bridge has time to start the scan
  setTimeout(pollForNewLights, 4000);
}

// ── Init ──────────────────────────────────────────────────────────────────────

buildDmxBars();
showTab('bridge');
setBridgeStatus(false, null, false);
loadNicSelectors();
document.getElementById('btn-disconnect').style.display = 'none';
