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

// ── Tabs ─────────────────────────────────────────────────────────────────────

const tabs   = document.querySelectorAll('.tab');
const panels = document.querySelectorAll('.panel');

function showTab(name) {
  tabs.forEach(t   => t.classList.toggle('active', t.dataset.tab === name));
  panels.forEach(p => p.classList.toggle('active', p.id === `panel-${name}`));
  if (name === 'lights'   && state.connected) refreshLights();
  if (name === 'settings') refreshSettings();
  if (name === 'monitor'  && state.lights.length > 0) buildMonitorCards(state.lights);
  if (name === 'control') { buildControlCards(state.lights); loadScenes(); }
}

tabs.forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));

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
  if (phase === 'arp') {
    scanProgressBar.style.width = '5%';
    scanProgressLabel.textContent = 'Checking ARP cache for known Hue bridges…';
  } else if (phase === 'ssdp') {
    scanProgressBar.style.width = '15%';
    scanProgressLabel.textContent = 'Sending UPnP/SSDP multicast on all interfaces…';
  } else if (phase === 'mdns') {
    scanProgressBar.style.width = '25%';
    scanProgressLabel.textContent = 'Searching via mDNS…';
  } else {
    const pct = 25 + Math.round((completed / total) * 75);
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

document.getElementById('btn-scan').addEventListener('click', async () => {
  bridgeList.innerHTML = '<div class="empty-state"><small>Scanning — results appear as bridges are found…</small></div>';
  scanProgressWrap.style.display = '';
  scanProgressBar.style.width    = '0%';
  scanProgressLabel.textContent  = 'Starting scan…';
  document.getElementById('btn-scan').disabled = true;

  const ifaceIp = document.getElementById('discover-nic').value;
  const extra   = parseExtraSubnet();
  const res     = await window.hue.discoverBridges(ifaceIp, extra ? [extra] : []);

  scanProgressBar.style.width = '100%';
  document.getElementById('btn-scan').disabled = false;

  if (!res.success) {
    bridgeList.innerHTML = `<div class="empty-state"><p>Scan error</p><small>${res.error}</small></div>`;
    scanProgressWrap.style.display = 'none';
    return;
  }

  scanProgressLabel.textContent = `Scan complete — ${res.bridges.length} bridge${res.bridges.length !== 1 ? 's' : ''} found`;
  if (res.bridges.length === 0 && !bridgeList.querySelector('.bridge-item')) {
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

window.hue.on('bridge:auto-connect', ({ connected, bridge }) => {
  setBridgeStatus(connected, bridge, false);
  if (connected) {
    toast(`Connected to ${bridge}`, 'success');
    showTab('lights');
  }
});

// ── Lights panel ──────────────────────────────────────────────────────────────

const lightsList = document.getElementById('lights-list');
let dragSrc = null;

document.getElementById('btn-refresh-lights').addEventListener('click', refreshLights);

async function refreshLights() {
  if (!state.connected) {
    lightsList.innerHTML = '<div class="empty-state"><div class="icon">💡</div><p>Not connected to a bridge</p></div>';
    return;
  }
  const res   = await window.hue.getLights();
  state.lights = res.lights || [];
  renderLights();
}

function renderLights() {
  lightsList.innerHTML = '';
  if (state.lights.length === 0) {
    lightsList.innerHTML = '<div class="empty-state"><div class="icon">💡</div><p>No lights found</p><small>Make sure your lights are powered on</small></div>';
    buildMonitorCards([]);
    return;
  }
  for (const light of state.lights) lightsList.appendChild(buildLightRow(light));
  buildMonitorCards(state.lights);
  buildControlCards(state.lights);
}

function buildLightRow(light) {
  const row       = document.createElement('div');
  row.className   = `light-row${light.disabled ? ' disabled-light' : ''}`;
  row.dataset.id  = light.id;
  row.draggable   = true;

  const swatchColor = getLightColor(light);
  const dmx         = light.dmx;
  const chBadges    = dmx ? dmx.labels.map(l => {
    const [, name] = l.split(':');
    const cls = { R: 'r', G: 'g', B: 'b', CT: 'ct', Bri: 'bri' }[name] || '';
    return `<span class="ch-badge ${cls}">${l}</span>`;
  }).join('') : '';

  row.innerHTML = `
    <span class="drag-handle" title="Drag to reorder">⠿</span>
    <div class="light-color-swatch" style="background:${swatchColor}"></div>
    <div class="light-info">
      <div class="light-name">${light.name}</div>
      <div class="light-meta">ID: ${light.id} &nbsp;·&nbsp; ${light.state && light.state.reachable !== false ? 'Reachable' : 'Unreachable'}</div>
      <div class="light-dmx-channels">${chBadges}</div>
    </div>
    <label class="toggle" title="${light.disabled ? 'Enable' : 'Disable'} in DMX mapping">
      <input type="checkbox" ${light.disabled ? '' : 'checked'}>
      <span class="toggle-slider"></span>
    </label>
  `;

  row.querySelector('input[type=checkbox]').addEventListener('change', async () => {
    await window.hue.toggleDisabled(light.id);
    light.disabled = !light.disabled;
    row.classList.toggle('disabled-light', light.disabled);
    refreshLights();
  });

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
window.hue.on('artnet:dmx-update', (dmx) => {
  updateDmxBars(dmx);
  onDmxPacket(dmx);

  const { dmxAddress, white, transition } = state.settings;
  if (!dmxAddress) return;
  const channelsPerLight = white ? 5 : 3;
  const base = (dmxAddress - 1) + (transition === 'channel' ? 1 : 0);

  document.querySelectorAll('.light-row').forEach((row, i) => {
    const offset = base + i * channelsPerLight;
    if (offset + 2 >= dmx.length) return;
    const r = dmx[offset], g = dmx[offset + 1], b = dmx[offset + 2];
    const on = r > 0 || g > 0 || b > 0;
    const swatch = row.querySelector('.light-color-swatch');
    if (swatch) swatch.style.background = on ? `rgb(${r},${g},${b})` : 'rgba(255,255,255,0.05)';
  });
});

// ── DMX bar visualization ─────────────────────────────────────────────────────

function buildDmxBars() {
  const wrap = document.getElementById('dmx-bar-wrap');
  wrap.innerHTML = '';
  for (let i = 0; i < 64; i++) {
    const bar = document.createElement('div');
    bar.className   = 'dmx-bar';
    bar.style.height = '0px';
    wrap.appendChild(bar);
  }
}

function updateDmxBars(dmx) {
  document.querySelectorAll('.dmx-bar').forEach((bar, i) => {
    bar.style.height = `${Math.round(((dmx[i] || 0) / 255) * 24)}px`;
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
  updateBannerText.textContent = `⬆ Update available: v${version}`;
  updateBanner.style.display = 'flex';
});

window.hue.on('update:progress', ({ percent }) => {
  updateProgressWrap.style.display = 'flex';
  updateProgressBar.style.width    = `${percent}%`;
  updateBannerText.textContent     = `Downloading update… ${percent}%`;
  btnUpdateDownload.style.display  = 'none';
});

window.hue.on('update:downloaded', () => {
  updateBannerText.textContent    = '✓ Update downloaded — restart to install';
  updateProgressWrap.style.display = 'none';
  btnUpdateInstall.style.display  = '';
  btnUpdateDownload.style.display = 'none';
});

btnUpdateDownload.addEventListener('click', () => window.hue.downloadUpdate());
btnUpdateInstall.addEventListener('click',  () => window.hue.installUpdate());
document.getElementById('btn-update-dismiss').addEventListener('click', () => {
  updateBanner.style.display = 'none';
});

// ── Control panel ─────────────────────────────────────────────────────────────

const controlGrid       = document.getElementById('control-grid');
const dmxOverrideBanner = document.getElementById('dmx-override-banner');
const dmxOverrideInfo   = document.getElementById('dmx-override-info');
const dmxThresholdInput = document.getElementById('dmx-threshold-input');
const sceneSelect       = document.getElementById('scene-select');
const sceneNameRow      = document.getElementById('scene-name-row');

// Group selection
const selectedLights = new Set();

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
      <div class="control-row" style="flex:1;margin:0;gap:10px">
        <span class="control-row-label" style="width:auto">Color</span>
        <input type="color" class="color-input" id="group-color" value="#ffffff">
        <span class="control-row-label" style="width:auto;margin-left:10px">Brightness</span>
        <input type="range" min="1" max="100" value="100" class="bri-slider" id="group-bri" style="max-width:120px">
        <span id="group-bri-val" class="bri-val">100%</span>
      </div>
      <button class="btn btn-secondary btn-sm" id="group-clear">✕ Clear</button>`;
    controlGrid.parentElement.insertBefore(bar, controlGrid);

    const groupColor = bar.querySelector('#group-color');
    const groupBri   = bar.querySelector('#group-bri');
    const groupBriVal = bar.querySelector('#group-bri-val');

    const sendGroup = debounce(() => {
      const rgb = groupColor.value;
      const bri = parseInt(groupBri.value);
      for (const id of selectedLights) {
        controlState[id] = { ...controlState[id], rgb, bri, on: true };
        sendLightState(id, controlState[id]);
        // sync individual card UI
        const card = controlGrid.querySelector(`[data-light-id="${id}"]`);
        if (card) {
          card.querySelector('.ctrl-color').value = rgb;
          card.querySelector('.ctrl-bri').value   = bri;
          card.querySelector('.bri-val').textContent = `${bri}%`;
          card.querySelector('.ctrl-onoff').checked = true;
        }
      }
    }, 80);

    groupColor.addEventListener('input', sendGroup);
    groupBri.addEventListener('input', (e) => {
      groupBriVal.textContent = `${e.target.value}%`;
      sendGroup();
    });
    bar.querySelector('#group-clear').addEventListener('click', () => {
      selectedLights.clear();
      controlGrid.querySelectorAll('.control-card.selected')
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

// Per-light state stored in renderer for scene saving
const controlState = {}; // { lightId: { on, rgb, bri } }

function buildControlCards(lights) {
  selectedLights.clear();
  updateGroupBar();
  if (!lights || lights.length === 0) {
    controlGrid.innerHTML = '<div class="empty-state"><div class="icon">🎛️</div><p>Connect to a bridge and load lights first</p></div>';
    return;
  }
  controlGrid.innerHTML = '';

  for (const light of lights) {
    if (!controlState[light.id]) {
      controlState[light.id] = { on: light.state?.on ?? true, rgb: '#ffffff', bri: Math.round(((light.state?.bri ?? 254) / 254) * 100) };
    }
    const s = controlState[light.id];

    const card = document.createElement('div');
    card.className   = 'control-card';
    card.dataset.lightId = light.id;
    card.innerHTML = `
      <div class="control-card-header">
        <button class="ctrl-select-btn" title="Select for group control"></button>
        <span class="control-card-name">${light.name}</span>
        <label class="toggle" title="On / Off">
          <input type="checkbox" class="ctrl-onoff" ${s.on ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="control-row">
        <span class="control-row-label">Color</span>
        <input type="color" class="color-input ctrl-color" value="${s.rgb}">
      </div>
      <div class="control-row">
        <span class="control-row-label">Brightness</span>
        <input type="range" min="1" max="100" value="${s.bri}" class="bri-slider ctrl-bri">
        <span class="bri-val">${s.bri}%</span>
      </div>`;

    card.querySelector('.ctrl-select-btn').addEventListener('click', () => toggleCardSelect(light.id, card));

    card.querySelector('.ctrl-onoff').addEventListener('change', (e) => {
      s.on = e.target.checked;
      sendLightState(light.id, s);
    });

    const sendColor = debounce((rgb) => { s.rgb = rgb; sendLightState(light.id, s); }, 80);
    card.querySelector('.ctrl-color').addEventListener('input', (e) => sendColor(e.target.value));

    const sendBri = debounce((bri) => { s.bri = bri; sendLightState(light.id, s); }, 80);
    card.querySelector('.ctrl-bri').addEventListener('input', (e) => {
      const bri = parseInt(e.target.value);
      e.target.closest('.control-row').querySelector('.bri-val').textContent = `${bri}%`;
      sendBri(bri);
    });

    controlGrid.appendChild(card);
  }
}

async function sendLightState(lightId, s) {
  if (!s.on) {
    await window.hue.setLightState(lightId, { on: false });
    return;
  }
  await window.hue.setLightState(lightId, { on: true, rgb: s.rgb, bri: s.bri });
}

// DMX takeover — dim control cards while DMX is active
window.hue.on('dmx:takeover-change', ({ active }) => {
  dmxOverrideBanner.style.display = active ? 'flex' : 'none';
  controlGrid.querySelectorAll('.control-card').forEach(c => c.classList.toggle('dmx-active', active));
  const threshold = parseInt(dmxThresholdInput.value) || 100;
  dmxOverrideInfo.textContent = active ? `(priority ≥ ${threshold})` : '';
});

// Save priority threshold on change
dmxThresholdInput.addEventListener('change', () => {
  window.hue.saveSettings({ dmxPriorityThreshold: parseInt(dmxThresholdInput.value) || 100 });
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

function onDmxPacket(dmx) {
  lastPacketMs = Date.now();
  monitorSignalDot.classList.add('active');
  monitorSignalLabel.textContent = 'Receiving';

  const cfg   = state.settings;
  const proto = cfg.protocol || 'artnet';
  const univ  = proto === 'sacn' ? (cfg.sacnUniverse ?? 1) : (cfg.universe ?? 0);
  monitorUniverseLabel.textContent =
    `${proto === 'sacn' ? 'sACN' : proto === 'both' ? 'Art-Net+sACN' : 'Art-Net'} · Universe ${univ}`;

  if (!signalAgeTimer) signalAgeTimer = setInterval(updateSignalAge, 250);
  updateMonitorCards(dmx);
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

function updateMonitorCards(dmx) {
  const cfg = state.settings;
  if (!cfg.dmxAddress) return;
  const channelsPerLight = cfg.white ? 5 : 3;
  const base = (cfg.dmxAddress - 1) + (cfg.transition === 'channel' ? 1 : 0);

  monitorGrid.querySelectorAll('.monitor-card').forEach((card, i) => {
    const offset   = base + i * channelsPerLight;
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

window.hue.on('sacn:diag', ({ rawCount, lastUniverse, wrongUniverse, configured, lastSize }) => {
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
    sacnDiagIcon.textContent = '⚠️';
    sacnDiagText.textContent = `sACN: ${rawCount} packets received but none matched E1.31 format (last: ${lastSize} bytes)`;
    return;
  }
  if (lastUniverse !== configured) {
    sacnDiagBar.className = 'mismatch';
    sacnDiagIcon.textContent = '⚠️';
    sacnDiagText.textContent =
      `sACN: Receiving universe ${lastUniverse} — app is configured for universe ${configured}. ` +
      `Change sACN Universe in Settings to ${lastUniverse}.`;
    return;
  }
  sacnDiagBar.className = 'ok';
  sacnDiagIcon.textContent = '✓';
  sacnDiagText.textContent = `sACN: Receiving universe ${lastUniverse} · ${rawCount} packets`;
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

function updateProtocolVisibility(protocol) {
  const sacnFields  = document.getElementById('sacn-fields');
  sacnFields.style.display = (protocol === 'artnet') ? 'none' : '';
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
  document.getElementById('s-colorloop').checked    = !!cfg.colorloop;
  document.getElementById('s-white').checked        = !!cfg.white;
  document.getElementById('s-nolimit').checked      = !!cfg.noLimit;

  if (dmxThresholdInput) dmxThresholdInput.value = cfg.dmxPriorityThreshold ?? 100;

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

document.getElementById('s-sacn-universe').addEventListener('input', updateMulticastHint);

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
    colorloop:     document.getElementById('s-colorloop').checked,
    white:         document.getElementById('s-white').checked,
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

// ── Init ──────────────────────────────────────────────────────────────────────

buildDmxBars();
showTab('bridge');
setBridgeStatus(false, null, false);
loadNicSelectors();
document.getElementById('btn-disconnect').style.display = 'none';
