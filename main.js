'use strict';

const { app, BrowserWindow, ipcMain, Tray, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const dgram = require('dgram');
const { v3 } = require('node-hue-api');

// ── Config ──────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

const DEFAULT_CONFIG = {
  bridge: null,
  user: null,
  dmxAddress: 1,
  universe: 0,
  sacnUniverse: 1,
  sacnMulticast: true,
  protocol: 'artnet',
  host: '0.0.0.0',
  transition: 100,
  noLimit: false,
  disabledLights: {},
  lightsOrder: [],
  scenes: {},                 // { sceneName: [ { id, on, rgb, bri } ] }
  lightStates: {},            // { lightId: { on, rgb, bri } } — persisted control-tab state
  lastTab: 'bridge',          // last active tab, restored on launch
};

let config = { ...DEFAULT_CONFIG };

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    config = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    config = { ...DEFAULT_CONFIG };
  }
}

function saveConfig() {
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, CONFIG_PATH); // atomic replace — crash mid-write can't corrupt the live file
}

// ── Hue API state ────────────────────────────────────────────────────────────

let hueApi      = null;
let mainWindow  = null;
let tray        = null;
let popoverWin  = null;
let connectedPromise = null;   // resolves when initial bridge connect attempt finishes

// ── DMX priority takeover tracking ────────────────────────────────────────────

let lastDmxTakeoverMs  = 0;
let dmxTakeoverActive  = false;

function markDmxActive() {
  lastDmxTakeoverMs = Date.now();
}

function isDmxActive() {
  return Date.now() - lastDmxTakeoverMs < 2000;
}

// Broadcast takeover state changes to renderer every 500 ms
setInterval(() => {
  const nowActive = isDmxActive();
  if (nowActive !== dmxTakeoverActive) {
    dmxTakeoverActive = nowActive;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('dmx:takeover-change', { active: nowActive });
    }
  }
}, 500);

// ── Broadcast helper ─────────────────────────────────────────────────────────
// Sends a status event to every open window (main + tray popover).
// Used for channels both windows care about (e.g. artnet:status).
function sendToAll(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
  if (popoverWin && !popoverWin.isDestroyed()) popoverWin.webContents.send(channel, ...args);
}

// ── Bridge health-check / auto-reconnect ──────────────────────────────────────
// Runs every 30 s. Sends a lightweight GET to the bridge to confirm it's still
// reachable (also keeps the TCP socket alive between DMX bursts) and silently
// reconnects if the bridge has restarted or moved since the app launched.
setInterval(async () => {
  if (!config.bridge || !config.user) return;
  try {
    await new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: config.bridge, port: 80, path: `/api/${config.user}/config`,
          method: 'GET', agent: keepAliveAgent, timeout: 5000 },
        res => { res.resume(); resolve(); }
      );
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    });
  } catch {
    // Bridge didn't respond — silently re-establish the session
    await connectToSavedBridge().catch(() => {});
  }
}, 30000);

// Build a node-hue-api Api object over HTTPS without cert validation or cert-pinning.
// Used when the bridge rejects HTTP (port 80 closed on newer firmware).
async function localConnectHttps(ip, username) {
  const axios = require('axios');
  const NHTransport = require('node-hue-api/lib/api/http/Transport');
  const NHApi      = require('node-hue-api/lib/api/Api');

  const agent = new https.Agent({
    rejectUnauthorized: false,
    minVersion: 'TLSv1',
    ciphers: 'ALL',
  });
  const apiBaseUrl = `https://${ip}/api`;
  // Verify the bridge is reachable before handing back the Api object
  await axios.get(`https://${ip}/api/config`, { httpsAgent: agent, timeout: 5000 });
  const transport = new NHTransport(username, axios.create({ baseURL: apiBaseUrl, httpsAgent: agent }));
  return new NHApi({ remote: false, baseUrl: apiBaseUrl, username: username || null }, transport);
}

// Try HTTP first (older firmware), fall back to cert-free HTTPS (newer firmware).
async function localConnect(ip, username) {
  try {
    return await v3.api.createInsecureLocal(ip).connect(username);
  } catch (e) {
    // HTTP failed for any non-Hue-API reason — try HTTPS
    if (e.getHueErrorType && e.getHueErrorType()) throw e;
    return await localConnectHttps(ip, username);
  }
}

async function connectToSavedBridge() {
  if (!config.bridge || !config.user) return false;
  try {
    hueApi = await localConnect(config.bridge, config.user);
    fetchLights().catch(() => {});
    return true;
  } catch {
    hueApi = null;
    return false;
  }
}

// ── Network interfaces ────────────────────────────────────────────────────────

function getNetworkInterfaces() {
  const raw = os.networkInterfaces();
  const results = [{ name: 'All Interfaces', ip: '0.0.0.0', label: 'All Interfaces (0.0.0.0)', internal: false }];

  for (const [ifName, addrs] of Object.entries(raw)) {
    for (const addr of addrs) {
      if (addr.family !== 'IPv4') continue;
      results.push({
        name: ifName,
        ip: addr.address,
        label: `${ifName} — ${addr.address}${addr.internal ? ' (loopback)' : ''}`,
        internal: addr.internal,
      });
    }
  }
  return results;
}

ipcMain.handle('network:get-interfaces', () => getNetworkInterfaces());

// ── Art-Net ──────────────────────────────────────────────────────────────────

const ARTNET_PORT = 6454;
const OPCODE_OUTPUT = 0x5000;

let artnetSocket = null;
let artnetRunning = false;
let dmxBuffer = Buffer.alloc(512, 0);

// ── Smart intermediary ────────────────────────────────────────────────────────
// The Hue bridge processes ~10 commands/sec total across all lights.  Sending
// current-value-every-tick at 10 Hz × 4 lights = 40 commands/sec overflows its
// internal queue, which then drains slowly — producing the "10-second fade"
// the user sees even though the console is done in 3 seconds.
//
// Strategy (true intermediary):
//   • Each DMX frame updates a per-light "current value" table — no API calls.
//   • A 250 ms tick compares current values to the previous tick to detect velocity.
//   • If STATIC  → send current value with tt=0  (instant correction; dedup = 0 calls
//                  on unchanging scenes).
//   • If FADING  → extrapolate to the natural endpoint (the channel wall at 0 or 255)
//                  and send ONE command with the matching transitiontime.
//                  For a linear 3-second fade this means 1-2 total commands rather than
//                  30, so the bridge queue never grows.  The bridge runs its own native
//                  smooth transition and tracks the console perfectly.
//   • End-of-fade → velocity drops to ~0, a single snap correction confirms final state.

const TICKER_MS = 250;

// { lightId: { r, g, b, extra } }  — latest value from DMX frames
const lightCurrent = {};
// { lightId: { r, g, b } }         — values from the previous tick
const lightPrev    = {};
// { lightId: string }              — last sent endpoint key (dedup)
const lightLastKey = {};

let bridgeTicker = null;

function updateCurrent(lightId, r, g, b, extra) {
  lightCurrent[lightId] = { r, g, b, extra };
}

function clampByte(v) { return v < 0 ? 0 : v > 255 ? 255 : Math.round(v); }

function tickBridge() {
  if (!hueApi || !config.bridge || !config.user) return;
  for (const [lightId, cur] of Object.entries(lightCurrent)) {
    if (config.disabledLights[lightId]) continue;

    const prev = lightPrev[lightId];
    lightPrev[lightId] = { r: cur.r, g: cur.g, b: cur.b };

    if (!prev) {
      // First tick — no history yet, just send current
      const key = `s:${cur.r},${cur.g},${cur.b}`;
      if (lightLastKey[lightId] === key) continue;
      lightLastKey[lightId] = key;
      sendDirectState(lightId, buildDirectPayload(cur.r, cur.g, cur.b, { tt: 0 }));
      continue;
    }

    const dr = cur.r - prev.r;
    const dg = cur.g - prev.g;
    const db = cur.b - prev.b;
    const maxDelta = Math.max(Math.abs(dr), Math.abs(dg), Math.abs(db));

    if (maxDelta < 2) {
      // Static — instant correction, dedup prevents redundant calls
      const key = `s:${cur.r},${cur.g},${cur.b}`;
      if (lightLastKey[lightId] === key) continue;
      lightLastKey[lightId] = key;
      sendDirectState(lightId, buildDirectPayload(cur.r, cur.g, cur.b, { tt: 0 }));
      continue;
    }

    // ── Fading: extrapolate to natural endpoint ────────────────────────────
    // velocity in units/ms over the last tick window
    const vr = dr / TICKER_MS;
    const vg = dg / TICKER_MS;
    const vb = db / TICKER_MS;

    // Time (ms) until the first channel hits its wall (0 or 255)
    let timeToEnd = Infinity;
    for (const [val, vel] of [[cur.r, vr], [cur.g, vg], [cur.b, vb]]) {
      if (Math.abs(vel) < 0.001) continue;
      const wall = vel > 0 ? 255 : 0;
      const t = (wall - val) / vel;
      if (t > 0 && t < timeToEnd) timeToEnd = t;
    }

    if (!isFinite(timeToEnd) || timeToEnd > 60000) {
      // Can't extrapolate — fall back to snap
      const key = `s:${cur.r},${cur.g},${cur.b}`;
      if (lightLastKey[lightId] === key) continue;
      lightLastKey[lightId] = key;
      sendDirectState(lightId, buildDirectPayload(cur.r, cur.g, cur.b, { tt: 0 }));
      continue;
    }

    // Projected endpoint and transition duration
    const pr = clampByte(cur.r + vr * timeToEnd);
    const pg = clampByte(cur.g + vg * timeToEnd);
    const pb = clampByte(cur.b + vb * timeToEnd);
    const tt = Math.max(1, Math.round(timeToEnd / 100)); // deciseconds

    // Dedup on endpoint only — tt naturally decreases each tick and doesn't need re-sending
    const key = `f:${pr},${pg},${pb}`;
    if (lightLastKey[lightId] === key) continue;
    lightLastKey[lightId] = key;

    sendDirectState(lightId, buildDirectPayload(pr, pg, pb, { tt }));
  }
}

function startBridgeTicker() {
  if (!bridgeTicker) bridgeTicker = setInterval(tickBridge, TICKER_MS);
}

function stopBridgeTicker() {
  if (bridgeTicker) { clearInterval(bridgeTicker); bridgeTicker = null; }
  for (const k of Object.keys(lightCurrent)) delete lightCurrent[k];
  for (const k of Object.keys(lightPrev))    delete lightPrev[k];
  for (const k of Object.keys(lightLastKey)) delete lightLastKey[k];
}

// Keep-alive HTTP agent — reuses TCP connections to the bridge.
// Free-socket timeout of 20 s ensures idle sockets are destroyed before the
// Hue bridge closes them (~30 s), preventing silent ECONNRESET failures after
// the app has been left running overnight with no DMX activity.
const keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: Infinity });
keepAliveAgent.on('free', socket => socket.setTimeout(20000, () => socket.destroy()));

// Fast direct PUT to the Hue local REST API bypassing node-hue-api overhead
function sendDirectState(lightId, payload) {
  if (!config.bridge || !config.user) return;
  const body = Buffer.from(JSON.stringify(payload));
  const req  = http.request({
    hostname: config.bridge,
    port:     80,
    path:     `/api/${config.user}/lights/${lightId}/state`,
    method:   'PUT',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': body.length },
    agent:    keepAliveAgent,
  }, res => res.resume());
  req.on('error', () => {});
  req.write(body);
  req.end();
}

// Build a plain-object payload (Hue API units) instead of a LightState object
function buildDirectPayload(r, g, b, opts = {}) {
  const tt = opts.tt !== undefined ? opts.tt : 0;
  if (r === 0 && g === 0 && b === 0) return { on: false, transitiontime: tt };
  const [h, s, v] = rgbToHsb(r, g, b);
  return {
    on:             true,
    hue:            Math.round(h * 65535),
    sat:            Math.round(s * 254),
    bri:            Math.max(1, Math.round(v * 254)),
    effect:         'none',
    transitiontime: tt,
  };
}

function rgbToHsb(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const v = max;
  const s = max === 0 ? 0 : (max - min) / max;
  let h = 0;
  if (max !== min) {
    const d = max - min;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, v];
}

function buildLightState(r, g, b, opts = {}) {
  const { LightState } = v3.lightStates;
  const state = new LightState();

  if (r === 0 && g === 0 && b === 0) return state.off();

  state.on(true);
  state.effect('none');
  state.transitiontime(Math.round((opts.transition || 100) / 100));

  const [h, s, v] = rgbToHsb(r, g, b);
  state.hue(Math.round(h * 65535));
  state.saturation(Math.round(s * 100));
  state.brightness(Math.max(1, Math.round(v * 100)));

  return state;
}

function processArtnet(data) {
  if (!hueApi) return;

  const channelsPerLight = 3;
  const baseOffset = (config.dmxAddress - 1) + (config.transition === 'channel' ? 1 : 0);

  const orderedLights = getOrderedLights();

  for (let i = 0; i < orderedLights.length; i++) {
    const light = orderedLights[i];
    if (config.disabledLights[light.id]) continue;

    const offset = baseOffset + i * channelsPerLight;
    if (offset + 2 >= data.length) break;

    const r     = data[offset];
    const g     = data[offset + 1];
    const b     = data[offset + 2];
    updateCurrent(light.id, r, g, b, null);
  }

  // Ensure the 100 ms bridge ticker is running
  startBridgeTicker();

  // Forward DMX buffer snapshot to renderer for live display
  if (mainWindow && !mainWindow.isDestroyed()) {
    const snapshot = Array.from(data.slice(0, Math.min(data.length, 512)));
    mainWindow.webContents.send('artnet:dmx-update', snapshot);
  }
}

function startArtnet() {
  if (artnetRunning) return { success: true, message: 'Already running' };

  artnetSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  artnetSocket.on('message', (msg) => {
    if (msg.length < 18) return;
    // Validate Art-Net header
    if (msg.toString('ascii', 0, 7) !== 'Art-Net') return;
    const opCode = msg.readUInt16LE(8);
    if (opCode !== OPCODE_OUTPUT) return;

    const msgUniverse = msg.readUInt16LE(14);
    if (msgUniverse !== config.universe) return;

    const length = msg.readUInt16BE(16);
    const dmxData = msg.slice(18, 18 + length);
    dmxBuffer = Buffer.from(dmxData);
    markDmxActive(); // Art-Net always takes over
    processArtnet(dmxData);
  });

  artnetSocket.on('error', (err) => {
    artnetRunning = false;
    try { artnetSocket.close(); } catch {} // prevent orphaned socket holding port 6454 after error
    artnetSocket = null;
    sendToAll('artnet:status', { running: false, error: err.message });
  });

  artnetSocket.bind(ARTNET_PORT, config.host === '0.0.0.0' ? undefined : config.host, () => {
    try { artnetSocket.setBroadcast(true); } catch {}
    artnetRunning = true;
    sendToAll('artnet:status', { running: true });
  });

  return { success: true };
}

function stopArtnet() {
  if (artnetSocket) {
    try { artnetSocket.close(); } catch {}
    artnetSocket = null;
  }
  artnetRunning = false;
  // Stop the predictive ticker when no protocol is running
  if (!sacnRunning) stopBridgeTicker();
  return { success: true };
}

// ── sACN (E1.31) ──────────────────────────────────────────────────────────────

const SACN_PORT = 5568;
// ACN Packet Identifier — 12 bytes defined in ANSI E1.17
const ACN_ID = Buffer.from([
  0x41, 0x53, 0x43, 0x2d, 0x45, 0x31, 0x2e, 0x31, 0x37, 0x00, 0x00, 0x00,
]);

let sacnSocket = null;
let sacnRunning = false;

// Diagnostics — visible in the Monitor tab
const sacnDiag = { rawCount: 0, lastUniverse: null, lastSize: 0, wrongUniverse: 0 };

function emitSacnDiag() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sacn:diag', { ...sacnDiag, configured: config.sacnUniverse });
  }
}

function sacnMulticastGroup(universe) {
  return `239.255.${(universe >> 8) & 0xff}.${universe & 0xff}`;
}

function parseSACN(msg) {
  if (msg.length < 126) return null;
  // ACN Packet Identifier at offset 4
  for (let i = 0; i < 12; i++) {
    if (msg[4 + i] !== ACN_ID[i]) return null;
  }
  // Root vector 0x00000004, framing vector 0x00000002
  if (msg.readUInt32BE(18) !== 0x00000004) return null;
  if (msg.readUInt32BE(40) !== 0x00000002) return null;
  const priority = msg[108];          // E1.31 priority byte (0–200, default 100)
  const universe  = msg.readUInt16BE(113);
  const propCount = msg.readUInt16BE(123);
  if (msg.length < 125 + propCount) return null;
  const dmxData = msg.slice(126, 125 + propCount);
  return { universe, priority, dmxData };
}

function startSACN() {
  if (sacnRunning) return { success: true, message: 'Already running' };

  sacnDiag.rawCount = 0;
  sacnDiag.lastUniverse = null;
  sacnDiag.wrongUniverse = 0;

  sacnSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  sacnSocket.on('message', (msg) => {
    sacnDiag.rawCount++;
    sacnDiag.lastSize = msg.length;

    const result = parseSACN(msg);
    if (!result) { emitSacnDiag(); return; }

    sacnDiag.lastUniverse = result.universe;
    sacnDiag.lastPriority = result.priority;
    emitSacnDiag();

    if (result.universe !== config.sacnUniverse) {
      sacnDiag.wrongUniverse++;
      return;
    }

    markDmxActive();
    dmxBuffer = Buffer.from(result.dmxData);
    processArtnet(result.dmxData);
  });

  sacnSocket.on('error', (err) => {
    sacnRunning = false;
    try { sacnSocket.close(); } catch {} // prevent orphaned socket holding port 5568 after error
    sacnSocket = null;
    sendToAll('artnet:status', { running: isAnyRunning(), sacnError: err.message });
  });

  sacnSocket.bind(SACN_PORT, () => {
    try {
      sacnSocket.setBroadcast(true);
      if (config.sacnMulticast) {
        const group = sacnMulticastGroup(config.sacnUniverse);
        if (config.host !== '0.0.0.0') {
          // Specific interface requested
          sacnSocket.addMembership(group, config.host);
        } else {
          // Join on every non-loopback IPv4 interface so multicast works on all network segments
          for (const addrs of Object.values(os.networkInterfaces())) {
            for (const a of addrs) {
              if (a.family !== 'IPv4' || a.internal) continue;
              try { sacnSocket.addMembership(group, a.address); } catch {}
            }
          }
        }
      }
    } catch {}
    sacnRunning = true;
    sendToAll('artnet:status', buildStatusPayload());
  });

  return { success: true };
}

function stopSACN() {
  if (sacnSocket) {
    try { sacnSocket.close(); } catch {}
    sacnSocket = null;
  }
  sacnRunning = false;
  // Stop the predictive ticker when no protocol is running
  if (!artnetRunning) stopBridgeTicker();
  return { success: true };
}

function isAnyRunning() { return artnetRunning || sacnRunning; }

function buildStatusPayload() {
  return {
    running: isAnyRunning(),
    artnet: artnetRunning,
    sacn: sacnRunning,
    protocol: config.protocol,
  };
}

// ── Lights cache ─────────────────────────────────────────────────────────────

let lightsCache = [];

async function fetchLights() {
  if (!hueApi) return [];
  try {
    const lights = await hueApi.lights.getAll();
    lightsCache = lights.map(l => ({
      id: l.id,
      name: l.name,
      state: l.state,
    }));
    return lightsCache;
  } catch {
    return lightsCache;
  }
}

function getOrderedLights() {
  const order = config.lightsOrder || [];
  const ordered = [];
  const seen = new Set();

  for (const id of order) {
    const light = lightsCache.find(l => l.id === id);
    if (light) { ordered.push(light); seen.add(id); }
  }
  for (const light of lightsCache) {
    if (!seen.has(light.id)) ordered.push(light);
  }
  return ordered;
}

function calcDmxChannels() {
  const channelsPerLight = 3;
  const base = (config.dmxAddress - 1) + (config.transition === 'channel' ? 1 : 0);
  const orderedLights = getOrderedLights();
  const map = {};
  orderedLights.forEach((light, i) => {
    const start = base + i * channelsPerLight + 1;
    map[light.id] = {
      start,
      channels: channelsPerLight,
      labels: ['R', 'G', 'B'].map((l, j) => `ch${start + j}:${l}`),
    };
  });
  return map;
}

// ── IPC handlers ─────────────────────────────────────────────────────────────

// ── Bridge discovery ──────────────────────────────────────────────────────────

// ── Discovery methods ─────────────────────────────────────────────────────────

// Philips/Signify OUI prefixes for ARP-based discovery
const HUE_OUI = ['00:17:88', 'ec:b5:fa', 'c4:29:96', 'b8:27:eb', '00:17:88', 'a4:34:d9'];

// Probe a single IP on both HTTP :80 and HTTPS :443 for the Hue /api/config endpoint.
function probeHueBridge(ip, timeoutMs = 1500) {
  function tryFetch(mod, port) {
    const opts = {
      hostname: ip, port, path: '/api/config',
      rejectUnauthorized: false,
      // Hue Bridge uses TLS 1.0/1.1 on older firmware — allow legacy versions
      minVersion: 'TLSv1',
      ciphers: 'ALL',
    };
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (val) => { if (done) return; done = true; if (val) resolve(val); else reject(); };
      const deadline = setTimeout(() => finish(null), timeoutMs);
      try {
        const req = mod.get(opts, (res) => {
          // Follow one HTTP→HTTPS redirect
          if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
            res.resume();
            clearTimeout(deadline);
            tryFetch(https, 443).then(resolve).catch(() => reject());
            return;
          }
          clearTimeout(deadline);
          let data = '';
          res.on('data', c => { data += c; });
          res.on('end', () => {
            try {
              const j = JSON.parse(data);
              // Accept any response that looks like a Hue bridge
              const ok = j.bridgeid || j.modelid || j.apiversion || j.name;
              finish(ok ? { ip, name: j.name || 'Hue Bridge', bridgeid: j.bridgeid || null } : null);
            } catch { finish(null); }
          });
          res.on('error', () => finish(null));
        });
        req.on('error', () => { clearTimeout(deadline); finish(null); });
        req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch {} finish(null); });
      } catch { clearTimeout(deadline); finish(null); }
    });
  }
  return Promise.any([tryFetch(http, 80), tryFetch(https, 443)]).catch(() => null);
}

// Hue portal discovery — asks Signify's cloud which bridge is on this public IP.
// Works even when local multicast (SSDP/mDNS) is blocked.
function portalDiscover() {
  return new Promise((resolve) => {
    const req = https.get('https://discovery.meethue.com/', { rejectUnauthorized: true }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const arr = JSON.parse(data);
          if (!Array.isArray(arr)) { resolve([]); return; }
          resolve(arr.map(b => ({ ip: b.internalipaddress, name: 'Hue Bridge', bridgeid: b.id || null })).filter(b => b.ip));
        } catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.setTimeout(5000, () => { try { req.destroy(); } catch {} resolve([]); });
  });
}

// Phase 0 — ARP cache: instant, filters by Philips/Signify OUI
function arpCacheScan() {
  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    execFile('arp', ['-a'], { timeout: 3000 }, (err, stdout) => {
      if (err || !stdout) { resolve([]); return; }
      const found = [];
      const isWin = process.platform === 'win32';
      for (const line of stdout.split('\n')) {
        let ip, mac;
        if (isWin) {
          // "  192.168.1.1     aa-bb-cc-dd-ee-ff     dynamic"
          const m = line.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s+([0-9a-f]{2}-[0-9a-f]{2}-[0-9a-f]{2}-[0-9a-f]{2}-[0-9a-f]{2}-[0-9a-f]{2})/i);
          if (!m) continue;
          ip  = m[1];
          mac = m[2].replace(/-/g, ':');
        } else {
          // macOS/Linux: "? (ip) at mac ..."
          const ipM  = line.match(/\((\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\)/);
          const macM = line.match(/at\s+([0-9a-f:]{17})/i);
          if (!ipM || !macM) continue;
          ip  = ipM[1];
          mac = macM[1];
        }
        if (HUE_OUI.some(p => mac.toLowerCase().startsWith(p))) {
          found.push({ ip, name: 'Hue Bridge', bridgeid: null });
        }
      }
      resolve(found);
    });
  });
}

// Phase 1 — SSDP: send UPnP M-SEARCH from EVERY interface independently.
// Multicast is per-link so we must bind one socket per interface to cover all networks.
const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const SSDP_MSEARCH =
  'M-SEARCH * HTTP/1.1\r\n' +
  `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
  'MAN: "ssdp:discover"\r\n' +
  'MX: 3\r\nST: ssdp:all\r\n\r\n';

function ssdpDiscover(timeoutMs = 4000) {
  const sockets = [];
  const found = new Map();

  return new Promise((resolve) => {
    const ifaces = os.networkInterfaces();
    for (const addrs of Object.values(ifaces)) {
      for (const a of addrs) {
        if (a.family !== 'IPv4' || a.internal) continue;

        const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        sockets.push(sock);

        sock.on('message', (msg, rinfo) => {
          const text = msg.toString();
          if (found.has(rinfo.address)) return;
          const isHue = text.includes('IpBridge') || text.includes('hue-bridgeid') ||
                        /philips.*hue/i.test(text) || /urn:.*schemas-upnp-org.*Basic/i.test(text) ||
                        /signify/i.test(text) || text.includes('_hue._tcp');
          if (isHue) {
            // Extract friendly name from SSDP headers if possible
            const serverLine = text.match(/SERVER:\s*(.+)/i);
            found.set(rinfo.address, {
              ip: rinfo.address,
              name: 'Hue Bridge (SSDP)',
              bridgeid: (text.match(/hue-bridgeid:\s*(\S+)/i) || [])[1] || null,
            });
          }
        });

        sock.on('error', () => {});

        sock.bind(0, a.address, () => {
          try {
            const buf = Buffer.from(SSDP_MSEARCH);
            sock.send(buf, 0, buf.length, SSDP_PORT, SSDP_ADDR);
          } catch {}
        });
      }
    }

    setTimeout(() => {
      sockets.forEach(s => { try { s.close(); } catch {} });
      resolve([...found.values()]);
    }, timeoutMs);
  });
}

// Phase 2 — mDNS: dns-sd on macOS/Windows-Bonjour, avahi-browse on Linux
function mDNSDiscover(timeoutMs = 4500) {
  if (process.platform === 'linux') return avahiDiscover(timeoutMs);
  // macOS (dns-sd) and Windows with Bonjour installed
  return new Promise((resolve) => {
    const instances = new Set();
    const browse = spawn('dns-sd', ['-B', '_hue._tcp', 'local']);
    browse.stdout.on('data', (data) => {
      for (const line of data.toString().split('\n')) {
        const m = line.match(/\s+Add\s+\S+\s+\S+\s+local\.\s+_hue\._tcp\.\s+(.+)$/);
        if (m) instances.add(m[1].trim());
      }
    });
    browse.on('error', () => {});
    setTimeout(async () => {
      browse.kill();
      const results = await Promise.all([...instances].map(n => resolveMDNSService(n).catch(() => null)));
      resolve(results.filter(Boolean));
    }, timeoutMs);
  });
}

// Linux mDNS via avahi-browse (gracefully skips if avahi not installed)
function avahiDiscover(timeoutMs = 4500) {
  return new Promise((resolve) => {
    const found = new Map();
    let proc;
    try {
      proc = spawn('avahi-browse', ['-rpt', '_hue._tcp'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { resolve([]); return; }

    proc.stdout.on('data', (data) => {
      for (const line of data.toString().split('\n')) {
        // avahi-browse -rpt output: type;iface;proto;name;type;domain;hostname;addr;port;txt
        const parts = line.split(';');
        if (parts[0] !== '=' || parts.length < 9) continue;
        const ip = parts[7];
        if (ip && !found.has(ip)) {
          found.set(ip, { ip, name: `Hue Bridge — ${parts[3]}`, bridgeid: null });
        }
      }
    });
    proc.on('error', () => {});
    setTimeout(() => {
      try { proc.kill(); } catch {}
      resolve([...found.values()]);
    }, timeoutMs);
  });
}

function resolveMDNSService(instanceName) {
  return new Promise((resolve) => {
    const lookup = spawn('dns-sd', ['-L', instanceName, '_hue._tcp', 'local']);
    let hostname = null, bridgeid = null;
    lookup.stdout.on('data', (data) => {
      const text = data.toString();
      const h = text.match(/can be reached at (\S+?):\d+/);
      if (h) hostname = h[1];
      const b = text.match(/bridgeid=([^\s]+)/i);
      if (b) bridgeid = b[1];
    });
    lookup.on('error', () => {});
    setTimeout(async () => {
      lookup.kill();
      if (!hostname) { resolve(null); return; }
      const ip = await resolveDotLocal(hostname).catch(() => null);
      resolve(ip ? { ip, name: `Hue Bridge — ${instanceName}`, bridgeid } : null);
    }, 2500);
  });
}

function resolveDotLocal(hostname) {
  return new Promise((resolve) => {
    const proc = spawn('dns-sd', ['-G', 'v4', hostname]);
    proc.stdout.on('data', (data) => {
      const m = data.toString().match(/Add\s+\S+\s+\S+\s+\S+\s+\S+\s+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
      if (m) { proc.kill(); resolve(m[1]); }
    });
    proc.on('error', () => resolve(null));
    setTimeout(() => { proc.kill(); resolve(null); }, 2000);
  });
}

// Parse routing table (cross-platform) and return all reachable /24 prefixes
function getRoutedSubnets() {
  const { execFileSync } = require('child_process');
  const subnets = new Set();
  try {
    let out;
    if (process.platform === 'win32') {
      out = execFileSync('route', ['print', '-4'], { timeout: 3000 }).toString();
      for (const line of out.split('\n')) {
        const m = line.trim().match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
        if (!m) continue;
        const ip = m[1];
        if (ip === '0.0.0.0' || ip.startsWith('127.') || ip.startsWith('224.')) continue;
        const parts  = ip.split('.');
        const prefix = parts.slice(0, 3).join('.');
        if (/^\d+\.\d+\.\d+$/.test(prefix)) subnets.add(prefix);
      }
    } else if (process.platform === 'linux') {
      out = execFileSync('ip', ['route', 'show'], { timeout: 3000 }).toString();
      for (const line of out.split('\n')) {
        const m = line.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
        if (!m) continue;
        const ip = m[1];
        if (ip.startsWith('127.') || ip.startsWith('224.')) continue;
        const prefix = ip.split('.').slice(0, 3).join('.');
        if (/^\d+\.\d+\.\d+$/.test(prefix)) subnets.add(prefix);
      }
    } else {
      // macOS
      out = execFileSync('netstat', ['-rn', '-f', 'inet'], { timeout: 3000 }).toString();
      for (const line of out.split('\n')) {
        if (/\bH\b/.test(line)) continue;
        const dest = line.trim().split(/\s+/)[0];
        if (!dest || dest === 'Destination') continue;
        const ip   = dest.replace(/\/\d+$/, '');
        const parts = ip.split('.');
        if (parts.length < 2) continue;
        if (ip.startsWith('127.') || ip.startsWith('224.') || ip.startsWith('ff')) continue;
        const prefix = parts.slice(0, 3).join('.');
        if (/^\d+\.\d+\.\d+$/.test(prefix)) subnets.add(prefix);
      }
    }
  } catch { /* ignore */ }
  return [...subnets];
}

// Return /24 subnets for the subnet-scan fallback (NIC addresses + routing table)
function getSubnetsToScan(ifaceIp) {
  const subnets = new Set();
  if (ifaceIp && ifaceIp !== '0.0.0.0') {
    subnets.add(ifaceIp.split('.').slice(0, 3).join('.'));
  } else {
    // Own interface addresses
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs) {
        if (a.family !== 'IPv4' || a.internal) continue;
        subnets.add(a.address.split('.').slice(0, 3).join('.'));
      }
    }
    // Additional network routes from routing table
    for (const s of getRoutedSubnets()) subnets.add(s);
  }
  return [...subnets];
}

const yieldToEventLoop = () => new Promise(r => setImmediate(r));

let scanCancelled = false;
ipcMain.handle('bridge:cancel-scan', () => { scanCancelled = true; });

ipcMain.handle('bridge:discover', async (event, ifaceIp, extraSubnets = []) => {
  scanCancelled = false;
  const sender = event.sender;
  const found = [];
  const seen = new Set();

  function emit(bridge) {
    if (seen.has(bridge.ip)) return;
    seen.add(bridge.ip);
    found.push(bridge);
    if (!sender.isDestroyed()) sender.send('bridge:found', bridge);
  }

  // ── Phase -1: Try the saved bridge IP first (no probe — direct connect) ──
  if (config.bridge && config.user) {
    if (!sender.isDestroyed()) sender.send('bridge:scan-progress', { phase: 'saved', completed: 0, total: 0, subnets: [] });
    try {
      await localConnect(config.bridge, config.user);
      emit({ ip: config.bridge, name: 'Hue Bridge', bridgeid: null });
    } catch {
      const savedResult = await probeHueBridge(config.bridge, 2000).catch(() => null);
      if (savedResult) emit(savedResult);
    }
  }

  // ── Phase 0: ARP + portal in parallel (fast) ──
  if (scanCancelled) return { success: true, bridges: found };
  if (!sender.isDestroyed()) sender.send('bridge:scan-progress', { phase: 'arp', completed: 0, total: 0, subnets: [] });
  const [arpResults, portalResults] = await Promise.all([
    arpCacheScan().catch(() => []),
    portalDiscover().catch(() => []),
  ]);
  for (const b of arpResults) emit(b);
  for (const b of portalResults) emit(b);

  // ── Phase 1: SSDP (UPnP multicast from every interface — subnet-independent) ──
  if (scanCancelled) return { success: true, bridges: found };
  if (!sender.isDestroyed()) sender.send('bridge:scan-progress', { phase: 'ssdp', completed: 0, total: 0, subnets: [] });
  const ssdpResults = await ssdpDiscover(4000).catch(() => []);
  for (const b of ssdpResults) emit(b);

  // ── Phase 2: mDNS (finds bridges on any reachable subnet, incl. direct connections) ──
  if (scanCancelled) return { success: true, bridges: found };
  if (!sender.isDestroyed()) sender.send('bridge:scan-progress', { phase: 'mdns', completed: 0, total: 0, subnets: [] });
  const mdnsResults = await mDNSDiscover(4500).catch(() => []);
  for (const b of mdnsResults) emit(b);

  // ── Phase 3: HTTP/HTTPS subnet scan fallback ──
  // Always include the saved bridge's /24 so we find it even if it's on a different
  // subnet from the selected NIC (e.g. different VLAN that's still routable).
  if (scanCancelled) return { success: true, bridges: found };
  const savedSubnet = config.bridge ? config.bridge.split('.').slice(0, 3).join('.') : null;
  const subnets = [...new Set([
    ...getSubnetsToScan(ifaceIp),
    ...(extraSubnets || []),
    ...(savedSubnet ? [savedSubnet] : []),
  ])];
  if (subnets.length > 0) {
    const ips = [];
    for (const s of subnets) for (let i = 1; i <= 254; i++) ips.push(`${s}.${i}`);
    const CONCURRENCY = 20;
    let completed = 0;

    for (let i = 0; i < ips.length; i += CONCURRENCY) {
      if (scanCancelled) break;
      const batch = ips.slice(i, i + CONCURRENCY).map(ip => probeHueBridge(ip));
      const results = await Promise.all(batch);
      for (const r of results) { if (r) emit(r); }
      completed += batch.length;
      if (!sender.isDestroyed()) {
        sender.send('bridge:scan-progress', { phase: 'scan', completed, total: ips.length, subnets });
      }
      // Yield after each batch so IPC/UI events aren't starved
      await yieldToEventLoop();
    }
  }

  return { success: true, bridges: found };
});

ipcMain.handle('bridge:get-scan-subnets', () => getSubnetsToScan('0.0.0.0'));

ipcMain.handle('bridge:verify', async (event, ip) => {
  // Try saved credentials first (no probe needed)
  if (config.user) {
    try {
      const api = await localConnect(ip, config.user);
      hueApi = api;
      config.bridge = ip;
      saveConfig();
      fetchLights().catch(() => {});
      return { success: true, name: ip, bridgeid: null, autoConnected: true };
    } catch {}
  }

  // No saved credentials — skip probe, go straight to link-button pairing.
  // Wrong IPs will fail at the pairing step instead of here.
  return { success: true, name: ip, bridgeid: null, autoConnected: false };
});

ipcMain.handle('bridge:start-pair', async (event, ip) => {
  pairBridge(ip, event.sender);
  return { success: true };
});

ipcMain.handle('bridge:connect-saved', async () => {
  const ok = await connectToSavedBridge();
  return { success: ok, bridge: config.bridge };
});

ipcMain.handle('bridge:disconnect', async () => {
  hueApi = null;
  config.bridge = null;
  config.user = null;
  saveConfig();
  stopArtnet();
  lightsCache = [];
  return { success: true };
});

ipcMain.handle('bridge:status', () => {
  return {
    connected: hueApi !== null,
    bridge: config.bridge,
  };
});

ipcMain.handle('lights:get', async () => {
  const lights = await fetchLights();
  const dmxMap = calcDmxChannels();
  return {
    lights: getOrderedLights().map(l => ({
      ...l,
      dmx: dmxMap[l.id] || null,
      disabled: !!config.disabledLights[l.id],
    })),
  };
});

ipcMain.handle('lights:set-order', (event, order) => {
  config.lightsOrder = order;
  saveConfig();
  return { success: true };
});

ipcMain.handle('lights:toggle-disabled', (event, lightId) => {
  if (config.disabledLights[lightId]) {
    delete config.disabledLights[lightId];
  } else {
    config.disabledLights[lightId] = true;
  }
  saveConfig();
  return { disabled: !!config.disabledLights[lightId] };
});

ipcMain.handle('settings:get', () => {
  return { ...config };
});

ipcMain.handle('settings:save', (event, updates) => {
  const safeKeys = [
    'dmxAddress', 'universe', 'sacnUniverse', 'sacnMulticast',
    'protocol', 'host', 'transition', 'noLimit',
    'lightStates', 'lastTab',
  ];
  for (const key of safeKeys) {
    if (updates[key] !== undefined) config[key] = updates[key];
  }
  saveConfig();
  return { success: true };
});

ipcMain.handle('artnet:start', () => {
  const p = config.protocol;
  if (p === 'artnet') return startArtnet();
  if (p === 'sacn')   return startSACN();
  // 'both'
  startArtnet();
  startSACN();
  return { success: true };
});

ipcMain.handle('artnet:stop', () => {
  stopArtnet();
  stopSACN();
  // stopBridgeTicker() is called inside stopArtnet/stopSACN; calling it here
  // as a safety net in case both were already stopped individually
  stopBridgeTicker();
  return { success: true };
});

ipcMain.handle('artnet:status', () => buildStatusPayload());

// ── Native light control ─────────────────────────────────────────────────────

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

ipcMain.handle('lights:set-state', async (event, lightId, { on, rgb, bri, ct, mode }) => {
  if (!hueApi) return { success: false, error: 'Not connected' };
  const { LightState } = v3.lightStates;
  const state = new LightState();
  state.transitiontime(Math.round((config.transition || 100) / 100));

  if (!on) {
    state.off();
  } else {
    state.on(true);
    if (mode === 'ct' && ct != null) {
      state.ct(ct);
      state.brightness(Math.max(1, bri ?? 100));
    } else if (rgb) {
      const [r, g, b] = hexToRgb(rgb);
      const [h, s] = rgbToHsb(r, g, b);
      state.hue(Math.round(h * 65535));
      state.saturation(Math.round(s * 100));
      state.brightness(Math.max(1, bri ?? 100));
    } else {
      state.brightness(Math.max(1, bri ?? 100));
    }
  }

  try {
    await hueApi.lights.setLightState(lightId, state);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('dmx:is-active', () => isDmxActive());

// ── Scene management ──────────────────────────────────────────────────────────

ipcMain.handle('scenes:get', () => config.scenes || {});

ipcMain.handle('scenes:save', (event, name, lights) => {
  if (!config.scenes) config.scenes = {};
  config.scenes[name] = lights;
  saveConfig();
  return { success: true };
});

ipcMain.handle('scenes:apply', async (event, name) => {
  if (!hueApi) return { success: false, error: 'Not connected' };
  const scene = (config.scenes || {})[name];
  if (!scene) return { success: false, error: 'Scene not found' };
  const errors = [];
  for (const entry of scene) {
    try {
      const { LightState } = v3.lightStates;
      const state = new LightState();
      state.transitiontime(Math.round((config.transition || 100) / 100));
      if (!entry.on) {
        state.off();
      } else {
        state.on(true);
        if (entry.rgb) {
          const [r, g, b] = hexToRgb(entry.rgb);
          const [h, s] = rgbToHsb(r, g, b);
          state.hue(Math.round(h * 65535));
          state.saturation(Math.round(s * 100));
          state.brightness(Math.max(1, entry.bri ?? 100));
        } else {
          state.brightness(Math.max(1, entry.bri ?? 100));
        }
      }
      await hueApi.lights.setLightState(entry.id, state);
    } catch (err) {
      errors.push(`Light ${entry.id}: ${err.message}`);
    }
  }
  return { success: errors.length === 0, errors };
});

ipcMain.handle('scenes:delete', (event, name) => {
  if (config.scenes) delete config.scenes[name];
  saveConfig();
  return { success: true };
});

// ── Bridge pairing ───────────────────────────────────────────────────────────

// POST to the Hue pairing endpoint over raw HTTPS — no node-hue-api connect needed.
function huePost(ip, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const agent = new https.Agent({ rejectUnauthorized: false, minVersion: 'TLSv1', ciphers: 'ALL' });
    // Try HTTPS first; fall back to HTTP if HTTPS gets a hard error
    function attempt(mod, port) {
      const req = mod.request(
        { hostname: ip, port, path, method: 'POST', agent: port === 443 ? agent : undefined,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
        (res) => {
          let data = '';
          res.on('data', c => { data += c; });
          res.on('end', () => {
            try { resolve(JSON.parse(data)); } catch { reject(new Error('Bad JSON from bridge')); }
          });
        }
      );
      req.on('error', (e) => {
        if (port === 443) { reject(e); return; }
        // HTTP failed — try HTTPS
        attempt(https, 443);
      });
      req.setTimeout(5000, () => { req.destroy(); if (port === 443) reject(new Error('timeout')); else attempt(https, 443); });
      req.write(payload);
      req.end();
    }
    attempt(http, 80);
  });
}

async function pairBridge(ip, sender) {
  sender.send('bridge:pair-event', { type: 'waiting', remaining: 30 });

  const deadline = Date.now() + 30000;

  while (Date.now() < deadline) {
    try {
      const result = await huePost(ip, '/api', { devicetype: 'prism#app' });
      const first = Array.isArray(result) ? result[0] : result;

      if (first && first.success && first.success.username) {
        config.bridge = ip;
        config.user = first.success.username;
        saveConfig();
        hueApi = await localConnect(ip, config.user);
        sender.send('bridge:pair-event', { type: 'success' });
        return;
      }

      const errType = first && first.error && first.error.type;
      if (errType === 101) {
        // Link button not pressed — keep waiting
        const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000));
        sender.send('bridge:pair-event', { type: 'waiting', remaining });
        await new Promise(r => setTimeout(r, 1000));
      } else {
        sender.send('bridge:pair-event', { type: 'error', message: first?.error?.description || JSON.stringify(result) });
        return;
      }
    } catch (err) {
      sender.send('bridge:pair-event', { type: 'error', message: `Cannot reach bridge: ${err.message}` });
      return;
    }
  }

  sender.send('bridge:pair-event', { type: 'timeout' });
}

// ── Companion HTTP API ────────────────────────────────────────────────────────
// Listens on localhost only so Companion (running on the same machine or LAN)
// can trigger presets and query state without any Electron IPC.

let companionServer = null;
const COMPANION_PORT = 38765;

function startCompanionServer() {
  if (companionServer) return;

  companionServer = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost`);
    const send = (code, body) => {
      const json = JSON.stringify(body);
      res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(json);
    };

    // GET /api/status
    if (req.method === 'GET' && url.pathname === '/api/status') {
      send(200, {
        connected: !!hueApi,
        bridge: config.bridge || null,
        activePreset: config._activePreset || null,
        presets: config.scenes || {},
      });
      return;
    }

    // GET /api/presets
    if (req.method === 'GET' && url.pathname === '/api/presets') {
      send(200, { presets: Object.keys(config.scenes || {}) });
      return;
    }

    // POST /api/presets/:name/apply
    const applyMatch = url.pathname.match(/^\/api\/presets\/(.+)\/apply$/);
    if (req.method === 'POST' && applyMatch) {
      const name = decodeURIComponent(applyMatch[1]);
      const scene = config.scenes && config.scenes[name];
      if (!scene) { send(404, { error: 'Preset not found' }); return; }
      if (!hueApi) { send(503, { error: 'Not connected to bridge' }); return; }

      config._activePreset = name;
      // Apply each light state from the preset
      (async () => {
        for (const entry of scene) {
          try {
            const { LightState } = v3.lightStates;
            const state = new LightState();
            if (!entry.on) { state.off(); }
            else {
              state.on(true);
              if (entry.rgb) {
                const hex = entry.rgb.replace('#', '');
                const r = parseInt(hex.substring(0, 2), 16);
                const g = parseInt(hex.substring(2, 4), 16);
                const b = parseInt(hex.substring(4, 6), 16);
                const [h, s, vv] = rgbToHsb(r, g, b);
                state.hue(Math.round(h * 65535));
                state.saturation(Math.round(s * 100));
                state.brightness(Math.max(1, Math.round(vv * 100)));
              }
              if (entry.bri !== undefined) state.brightness(entry.bri);
              state.transitiontime(4);
            }
            await hueApi.lights.setLightState(entry.id, state);
          } catch {}
        }
        // Notify renderer to refresh control tab swatches
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('companion:preset-applied', name);
        }
      })();

      send(200, { ok: true, preset: name });
      return;
    }

    // POST /api/lights/all/off
    if (req.method === 'POST' && url.pathname === '/api/lights/all/off') {
      if (!hueApi) { send(503, { error: 'Not connected' }); return; }
      (async () => {
        for (const light of lightsCache) {
          try {
            const { LightState } = v3.lightStates;
            await hueApi.lights.setLightState(light.id, new LightState().off());
          } catch {}
        }
      })();
      send(200, { ok: true });
      return;
    }

    send(404, { error: 'Not found' });
  });

  companionServer.listen(COMPANION_PORT, '0.0.0.0', () => {
    console.log(`[companion] API listening on port ${COMPANION_PORT}`);
  });
  companionServer.on('error', (e) => {
    console.warn(`[companion] Server error: ${e.message}`);
  });
}

// ── Window ───────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0d1117',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
    // Hide from Dock when main window closes — keep running in tray
    if (process.platform === 'darwin' && app.dock) app.dock.hide();
  });
}

// ── Tray / popover ────────────────────────────────────────────────────────────

function createTray() {
  const iconPath = path.join(__dirname, 'build', 'icon.png');
  let icon = nativeImage.createFromPath(iconPath);
  // Resize to menu-bar size; on macOS a template image would be ideal but the
  // app icon works fine as a small colour icon for now.
  if (process.platform === 'darwin') icon = icon.resize({ width: 18, height: 18 });

  tray = new Tray(icon);
  tray.setToolTip('Prism');
  tray.on('click', (_, bounds) => togglePopover(bounds));
}

function createPopoverWin() {
  popoverWin = new BrowserWindow({
    width:      300,
    height:     195,
    show:       false,
    frame:      false,
    resizable:  false,
    movable:    false,
    alwaysOnTop: true,
    transparent: true,
    hasShadow:  false,   // CSS box-shadow provides shadow inside transparent window
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  popoverWin.loadFile(path.join(__dirname, 'renderer', 'popover.html'));

  // Auto-hide when focus moves elsewhere (native popover behaviour)
  popoverWin.on('blur', () => {
    if (popoverWin && !popoverWin.isDestroyed()) popoverWin.hide();
  });
}

function togglePopover(trayBounds) {
  if (!popoverWin || popoverWin.isDestroyed()) return;

  if (popoverWin.isVisible()) { popoverWin.hide(); return; }

  const { width: popW, height: popH } = popoverWin.getBounds();
  let x = Math.round(trayBounds.x + trayBounds.width  / 2 - popW / 2);
  const y = Math.round(trayBounds.y + trayBounds.height + 2);

  // Clamp horizontally so the popover doesn't bleed off screen
  const disp = screen.getDisplayMatching(trayBounds);
  x = Math.max(disp.workArea.x,
        Math.min(x, disp.workArea.x + disp.workArea.width - popW));

  popoverWin.setPosition(x, y);
  popoverWin.show();
  popoverWin.focus();
}

// Show (or create) the main window and restore Dock presence on macOS
function openMainWindow() {
  if (process.platform === 'darwin' && app.dock) app.dock.show();

  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    // Send auto-connect result once the page finishes loading
    mainWindow.webContents.once('did-finish-load', async () => {
      mainWindow.webContents.executeJavaScript(
        `document.body.dataset.platform = '${process.platform}'`
      );
      const connected = connectedPromise ? await connectedPromise : !!hueApi;
      if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send('bridge:auto-connect', { connected, bridge: config.bridge });
    });
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

// ── Tray IPC ──────────────────────────────────────────────────────────────────

ipcMain.handle('tray:open-main', () => { openMainWindow(); return { success: true }; });

ipcMain.handle('tray:quit', () => {
  stopArtnet();
  stopSACN();
  stopBridgeTicker();
  app.quit();
});

ipcMain.handle('login-item:get', () => app.getLoginItemSettings().openAtLogin);

ipcMain.handle('login-item:set', (_, enabled) => {
  app.setLoginItemSettings({ openAtLogin: enabled });
  return { success: true };
});

app.whenReady().then(() => {
  loadConfig();
  startCompanionServer();

  // Create tray icon and hidden popover — these live for the entire app lifetime
  createTray();
  createPopoverWin();

  // On macOS start as a tray-only app (no Dock icon until main window is opened)
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  // Connect to saved bridge in the background immediately
  connectedPromise = connectToSavedBridge();

  // Show the main window on first launch (no bridge configured yet) so the
  // user can go through setup. After that the app starts silently in the tray.
  if (!config.bridge) openMainWindow();

  // ── Auto-updater (production only) ────────────────────────────────────────
  if (app.isPackaged) {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = false;

    autoUpdater.on('update-available', (info) => {
      if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send('update:available', { version: info.version });
    });
    autoUpdater.on('download-progress', (p) => {
      if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send('update:progress', { percent: Math.round(p.percent) });
    });
    autoUpdater.on('update-downloaded', () => {
      if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send('update:downloaded');
    });
    autoUpdater.on('error', (err) => {
      if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send('update:error', { message: err ? err.message : 'Unknown error' });
    });

    ipcMain.handle('update:download', async () => {
      try { await autoUpdater.downloadUpdate(); }
      catch (err) {
        if (mainWindow && !mainWindow.isDestroyed())
          mainWindow.webContents.send('update:error', { message: err ? err.message : 'Download failed' });
      }
    });
    ipcMain.handle('update:install', () => { autoUpdater.quitAndInstall(); });

    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 5000);
  }

  // Dock icon clicked (macOS) — bring the main window back up
  app.on('activate', () => openMainWindow());
});

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') {
    // Keep running in the menu bar — listener stays active, Dock stays hidden
    if (app.dock) app.dock.hide();
  } else {
    stopArtnet();
    stopSACN();
    stopBridgeTicker();
    app.quit();
  }
});
