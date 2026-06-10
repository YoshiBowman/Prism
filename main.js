'use strict';

const { app, BrowserWindow, ipcMain, Tray, nativeImage, screen } = require('electron');

// ── Single-instance guard ─────────────────────────────────────────────────────
// Two Prism instances (e.g. a Launch-at-Login packaged build hidden in the tray
// plus a dev `npm start`) BOTH receive every DMX frame — the sACN/Art-Net sockets
// bind with reuseAddr — and both send commands to the same bulbs. The doubled,
// version-skewed traffic saturates the bridge's Zigbee radio and makes bulbs
// flap unreachable no matter how well-behaved each instance is individually.
// The lock is keyed on the shared userData dir, so it also dedupes across the
// packaged app and the dev tree. Second instance exits immediately; the first
// gets a `second-instance` event and raises its window.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}
app.on('second-instance', () => { try { openMainWindow(); } catch {} });
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
  lightAddresses: {},         // { lightId: dmxStartChannel } — custom per-light patch (1-based)
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
  validateConfig();
}

// Coerce config values to the types the rest of the app expects.
// A config written by an older version, hand-edited, or partially migrated
// can contain strings where numbers are expected (e.g. "22" for a universe),
// or missing container objects. Fixing them here means no downstream code has
// to defensively re-parse. Runs on every load.
function validateConfig() {
  const toInt = (v, fallback) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
  };
  config.dmxAddress   = toInt(config.dmxAddress,   DEFAULT_CONFIG.dmxAddress);
  config.universe     = toInt(config.universe,     DEFAULT_CONFIG.universe);
  config.sacnUniverse = toInt(config.sacnUniverse, DEFAULT_CONFIG.sacnUniverse);
  // transition may legitimately be the string 'channel'; only coerce numerics
  if (config.transition !== 'channel') config.transition = toInt(config.transition, DEFAULT_CONFIG.transition);
  config.sacnMulticast = !!config.sacnMulticast;
  config.noLimit       = !!config.noLimit;
  if (typeof config.protocol !== 'string') config.protocol = DEFAULT_CONFIG.protocol;
  if (typeof config.host !== 'string')     config.host     = DEFAULT_CONFIG.host;
  // Ensure container objects/arrays exist so callers never hit undefined
  if (!config.disabledLights || typeof config.disabledLights !== 'object') config.disabledLights = {};
  if (!config.lightAddresses || typeof config.lightAddresses !== 'object') config.lightAddresses = {};
  if (!config.scenes         || typeof config.scenes         !== 'object') config.scenes = {};
  if (!config.lightStates    || typeof config.lightStates    !== 'object') config.lightStates = {};
  if (!Array.isArray(config.lightsOrder)) config.lightsOrder = [];
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
let startupRetryTimer = null;  // setInterval handle for the login-time reconnect loop

// ── Bridge reboot flow state ───────────────────────────────────────────────────
// isRebooting is true from the moment a reboot command succeeds until the bridge
// reconnects, times out, or the user cancels. While true, the normal health-check
// reconnect is suppressed so the two reconnect paths can't race each other.
let isRebooting     = false;
let rebootTimer     = null;  // setTimeout handle for the next poll
let rebootStartMs   = 0;
let rebootAttempt   = 0;
let rebootSawOffline = false; // have we confirmed the bridge actually went down?
const REBOOT_POLL_MS         = 2500;   // how often to poll the bridge API
const REBOOT_OFFLINE_WAIT_MS = 30000;  // max time to wait to SEE the bridge drop
const REBOOT_TIMEOUT_MS      = 150000; // overall give-up window (2.5 min)

// ── DMX priority takeover tracking ────────────────────────────────────────────

let lastDmxTakeoverMs  = 0;
let dmxTakeoverActive  = false;

function markDmxActive() {
  lastDmxTakeoverMs = Date.now();
}

function isDmxActive() {
  return Date.now() - lastDmxTakeoverMs < 2000;
}

// Broadcast takeover state changes to renderer every 500 ms.
// Handle is captured so it can be cleared on quit (see cleanupAll()).
let takeoverBroadcastTimer = setInterval(() => {
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
// Also refreshes light states so syncUnreachableFromCache() can detect bulbs
// that went offline mid-session without needing active DMX traffic to notice.
//
// REENTRANCY GUARD: a slow bridge could make a check outlast the 30 s interval.
// isHealthChecking ensures a new tick is skipped while the previous one is still
// in flight, so checks can never stack up. Handle is captured for quit cleanup.
let isHealthChecking = false;
let healthCheckTimer = null;

async function healthCheckTick() {
  if (!config.bridge || !config.user) return;
  if (isRebooting) return;       // reboot flow owns reconnection — don't race it
  if (isHealthChecking) return;  // previous check still running — skip this tick
  isHealthChecking = true;
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
    // Bridge is up — refresh light states to catch any bulbs that went unreachable
    fetchLights().catch(() => {});
  } catch {
    // Bridge didn't respond — drop the stale session and force a clean reconnect.
    // Null the API handle so no PUT/GET races against a dead connection, and clear
    // the dedup cache so the reconnect re-sends every light's full current state.
    if (isRebooting) return; // a reboot may have started while the GET was in flight
    hueApi = null;
    for (const k of Object.keys(lightLastSent)) delete lightLastSent[k];
    await connectToSavedBridge().catch(() => {});
  } finally {
    isHealthChecking = false;
  }
}

function startHealthCheck() {
  if (!healthCheckTimer) healthCheckTimer = setInterval(healthCheckTick, 30000);
}

function stopHealthCheck() {
  if (healthCheckTimer) { clearInterval(healthCheckTimer); healthCheckTimer = null; }
}

startHealthCheck();

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

// Guards against overlapping connects. connectToSavedBridge() is reachable from
// three independent callers (startup retry loop, 30 s health check, and the
// bridge:connect-saved IPC), any of which can fire while another is mid-connect.
// Two simultaneous localConnect() calls would race to assign hueApi and could
// leave a half-initialised Api object live. While a connect is in flight, later
// callers return the same in-flight promise instead of starting a second one.
let isConnecting       = false;
let connectInFlight    = null;

async function connectToSavedBridge() {
  if (!config.bridge || !config.user) return false;
  if (isConnecting && connectInFlight) return connectInFlight; // coalesce concurrent calls
  isConnecting    = true;
  connectInFlight = (async () => {
  try {
    hueApi = await localConnect(config.bridge, config.user);
    // Clear rate-limit and dedup caches so every light re-sends its current
    // state on the next tick after a reconnect.
    for (const k of Object.keys(lightLastSent))   delete lightLastSent[k];
    for (const k of Object.keys(lightLastSendMs)) delete lightLastSendMs[k];
    await fetchLights().catch(() => {});
    // Seed unreachable lights from the initial fetch
    let seedCount = 0;
    for (const light of lightsCache) {
      if (light.state && light.state.reachable === false) {
        unreachableLights.add(String(light.id));
        seedCount++;
      }
    }
    if (seedCount > 0)
      console.log(`[recovery] ${seedCount} unreachable bulb(s) at startup — recovery poller active`);
    startRecoveryPoller();
    return true;
  } catch (err) {
    console.warn('[bridge] reconnect failed:', err.message);
    hueApi = null;
    return false;
  }
  })();
  try {
    return await connectInFlight;
  } finally {
    isConnecting    = false;
    connectInFlight = null;
  }
}

// ── Bridge reboot ──────────────────────────────────────────────────────────────
// Last-resort recovery: ask the bridge to reboot, then ride out the offline
// period and reconnect automatically. Only ever invoked from the UI confirmation
// flow (never Companion or any external trigger).

// Send PUT /config { reboot: true }. Resolves { ok, error } — never rejects.
function sendRebootCommand() {
  return new Promise(resolve => {
    const body = Buffer.from(JSON.stringify({ reboot: true }));
    const req = http.request({
      hostname: config.bridge, port: 80,
      path: `/api/${config.user}/config`, method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
      agent: keepAliveAgent, timeout: 5000,
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        // Hue returns [{"success":{"/config/reboot":true}}] on success,
        // or [{"error":{...}}] / HTTP >=400 on failure.
        if (res.statusCode >= 400) { resolve({ ok: false, error: `HTTP ${res.statusCode}` }); return; }
        if (data.includes('"error"')) {
          const m = data.match(/"description"\s*:\s*"([^"]+)"/);
          resolve({ ok: false, error: m ? m[1] : 'Bridge rejected reboot' });
          return;
        }
        resolve({ ok: true });
      });
    });
    req.on('error',   err => resolve({ ok: false, error: err.message }));
    req.on('timeout', ()  => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

async function rebootBridge() {
  if (!hueApi || !config.bridge || !config.user) {
    return { success: false, error: 'Bridge not connected' };
  }
  if (isRebooting) return { success: false, error: 'Reboot already in progress' };

  // Stop all outbound traffic BEFORE sending the reboot so no PUT fires while the
  // bridge is on its way down.
  stopBridgeTicker();
  stopRecoveryPoller();

  const result = await sendRebootCommand();
  if (!result.ok) {
    // Bridge is presumably still up — resume normal operation so the user can retry.
    return { success: false, error: result.error };
  }

  console.log('[bridge] Reboot command sent — bridge going offline');
  beginRebootOfflineFlow();
  return { success: true };
}

// Lightweight reachability probe — GET /config, resolves true/false, never rejects.
// Used by the reboot flow to detect the offline period and the return.
function bridgeApiReachable() {
  return new Promise(resolve => {
    const req = http.request({
      hostname: config.bridge, port: 80,
      path: `/api/${config.user}/config`, method: 'GET',
      agent: keepAliveAgent, timeout: 3000,
    }, res => { res.resume(); resolve(true); });
    req.on('error',   () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// Tear down the live session and start the two-phase reboot watch:
//   Phase 1 — confirm the bridge actually goes OFFLINE (proves the reboot took).
//   Phase 2 — wait for it to come back, then reconnect.
function beginRebootOfflineFlow() {
  hueApi = null;
  for (const k of Object.keys(lightLastSent)) delete lightLastSent[k];
  stopBridgeTicker();
  stopRecoveryPoller();
  stopHealthCheck();          // reboot watch owns reconnection now

  isRebooting    = true;
  rebootStartMs  = Date.now();
  rebootAttempt  = 0;
  rebootSawOffline = false;

  sendToAll('bridge:reboot-started', { estimatedSeconds: 60 });

  // Start polling almost immediately — the bridge usually drops within a few
  // seconds, and we want to SEE that drop rather than assume it.
  rebootTimer = setTimeout(rebootPoll, REBOOT_POLL_MS);
}

async function rebootPoll() {
  if (!isRebooting) return;
  const elapsed = Math.round((Date.now() - rebootStartMs) / 1000);
  const up = await bridgeApiReachable();
  if (!isRebooting) return;     // cancelled while the probe was in flight

  // ── Phase 1: waiting to confirm the bridge has gone offline ──────────────────
  if (!rebootSawOffline) {
    if (!up) {
      // Confirmed — the reboot took effect.
      rebootSawOffline = true;
      console.log(`[bridge] Confirmed offline after ${elapsed}s — waiting for it to come back`);
      sendToAll('bridge:reboot-reconnecting', { attempt: 0, elapsed, phase: 'offline-confirmed' });
    } else if (Date.now() - rebootStartMs >= REBOOT_OFFLINE_WAIT_MS) {
      // The bridge never dropped within the window — the command was accepted
      // but did not actually restart the hardware. Reconnect and tell the user.
      const ok = await connectToSavedBridge().catch(() => false);
      finishReboot(ok, elapsed, 'no-offline');
      return;
    } else {
      sendToAll('bridge:reboot-reconnecting', { attempt: 0, elapsed, phase: 'going-offline' });
    }
    rebootTimer = setTimeout(rebootPoll, REBOOT_POLL_MS);
    return;
  }

  // ── Phase 2: bridge dropped; wait for it to return, then reconnect ───────────
  if (up) {
    rebootAttempt++;
    const ok = await connectToSavedBridge().catch(() => false);
    if (!isRebooting) return;
    if (ok) { finishReboot(true, Math.round((Date.now() - rebootStartMs) / 1000), 'rebooted'); return; }
    sendToAll('bridge:reboot-reconnecting', { attempt: rebootAttempt, elapsed, phase: 'reconnecting' });
  } else {
    sendToAll('bridge:reboot-reconnecting', { attempt: rebootAttempt, elapsed, phase: 'waiting-online' });
  }

  if (Date.now() - rebootStartMs >= REBOOT_TIMEOUT_MS) {
    isRebooting = false;
    if (rebootTimer) { clearTimeout(rebootTimer); rebootTimer = null; }
    startHealthCheck();         // keep quietly retrying in the background
    console.warn(`[bridge] Reboot reconnect timed out after ${elapsed}s`);
    sendToAll('bridge:reboot-timeout', { elapsed, reason: 'timeout' });
    return;
  }

  rebootTimer = setTimeout(rebootPoll, REBOOT_POLL_MS);
}

// Resolve the reboot flow.
//   outcome 'rebooted'   — saw it drop and come back (true success)
//   outcome 'no-offline' — never dropped; reconnected anyway (likely unsupported)
function finishReboot(connected, elapsed, outcome) {
  isRebooting = false;
  if (rebootTimer) { clearTimeout(rebootTimer); rebootTimer = null; }
  startHealthCheck();
  if (connected) {
    fetchLights().catch(() => {});
    sendBridgeStatus();
  }
  if (outcome === 'no-offline') {
    console.warn(`[bridge] Bridge never went offline after ${elapsed}s — restart likely unsupported on this firmware`);
  } else {
    console.log(`[bridge] Reboot complete — reconnected after ${elapsed}s`);
  }
  sendToAll('bridge:reboot-complete', { elapsed, didReboot: outcome === 'rebooted', connected });
}

// User cancelled the reboot wait — stop the loop and return to normal disconnected
// behaviour (health check resumes so the app can still recover on its own).
function cancelReboot() {
  if (!isRebooting) return { success: false, error: 'Not rebooting' };
  isRebooting = false;
  rebootSawOffline = false;
  if (rebootTimer) { clearTimeout(rebootTimer); rebootTimer = null; }
  startHealthCheck();
  return { success: true };
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
const dmxBuffers = {};   // { universeNum: Buffer } — latest received DMX frame per universe

// ── Intermediary ───────────────────────────────────────────────────────────────
// The Hue bridge only sustains ~10 commands/sec total across all lights, so we
// can't blindly forward every DMX frame (40+/sec). Instead:
//   • Each DMX frame updates a per-light "current value" table — no API calls.
//   • A 250 ms tick sends each light's current value, deduped (skip if unchanged)
//     and rate-limited per light (1 cmd/sec/light).
//   • Each command carries a 300 ms transition so the bridge interpolates between
//     ticks and tracks moving values smoothly.
// Simple and predictable: the value the operator sets is the value that is sent.

const TICKER_MS  = 250;
const FOLLOW_TT  = Math.round((TICKER_MS + 50) / 100); // 3 deciseconds = 300 ms

// { lightId: { r, g, b, extra } }  — latest value from DMX frames
const lightCurrent = {};
// { lightId: { r, g, b } }         — the value we last actually SENT to each light
const lightLastSent = {};
// { lightId: number }              — timestamp of last actual send per light (PER-LIGHT rate limit)
// NOTE: This intentionally replaces the old single global _lastDirectSendMs.
//       A global timer had a critical flaw: light 1 always reset the timer in
//       the same synchronous tick loop, so light 2 was always blocked (0 ms
//       elapsed) and never sent commands.  Per-light timers let every light send
//       independently without starving each other.
const lightLastSendMs = {};
// { lightId: { r, g, b } }  — value seen on the PREVIOUS tick (movement detection only;
//                             no velocity math, no extrapolation)
const lightTickPrev = {};
// { lightId: bool }         — was the value moving on the previous tick too?
const lightMovingPrev = {};

// Per-light command budget. The Hue bridge sustains ~10 cmd/sec total, and each
// bulb's Zigbee link reliably handles only ~1 cmd/sec — exceeding it makes the
// bridge mark bulbs unreachable, which then flap as commands keep arriving.
//   SEND_GAP_MS — minimum spacing between commands to ONE light (1 cmd/sec).
//   ONOFF_GAP_MS — reduced floor for on/off boundary crossings, so blackouts and
//                 lights-up cues land fast (≤500 ms) but a 0↔full strobe still
//                 can't exceed 2 cmd/sec/light.
//   JITTER      — ignore value changes smaller than this. DMX sources dither by
//                 ±1-2 units even while "holding"; without this, that jitter
//                 alone would stream a command every cycle and flood the bridge.
//   FADE_TT     — transition used while a value is actively moving: long enough
//                 to cover the gap to the next send (1 s cadence + tick), so a
//                 fade renders as one continuous glide instead of step-and-hold.
const SEND_GAP_MS  = 1000;
const ONOFF_GAP_MS = 500;
const JITTER       = 3;
const FADE_TT      = Math.round((SEND_GAP_MS + TICKER_MS) / 100); // 13 ds = 1.3 s

// ── Per-bulb recovery ─────────────────────────────────────────────────────────
// Set of light IDs (strings) the bridge has marked unreachable.
// Populated from: fetchLights() seed on startup, sendDirectState() error responses,
// and the 30 s health-check reachability sync (syncUnreachableFromCache).
// Cleared per-light when confirmReachability() or the sync sees reachable:true.
// CRITICAL INVARIANT: bulbs in this set receive NO DMX traffic (tickBridge skips
// them) and NO probe traffic while DMX is active — commands to dead bulbs make
// the bridge retry Zigbee delivery for seconds each, saturating the radio and
// knocking LIVE bulbs unreachable. Breaking this invariant re-creates the
// "bulbs keep dropping during shows" cascade.
const unreachableLights = new Set();
// setInterval handle for the recovery poller — null means not running.
// DOUBLE-START GUARD: startRecoveryPoller() is a no-op when this is non-null.
let recoveryInterval    = null;

let bridgeTicker = null;

function updateCurrent(lightId, r, g, b, extra) {
  lightCurrent[lightId] = { r, g, b, extra };
}

function clampByte(v) { return v < 0 ? 0 : v > 255 ? 255 : Math.round(v); }

// Each tick, send each light's CURRENT value and let the bridge interpolate.
// Deliberately simple and predictable — the value the operator sets is the value
// that is sent — with guards that keep the command rate within what the bridge
// and each bulb's Zigbee link can actually sustain:
//   • UNREACHABLE SKIP — bulbs the bridge has marked unreachable get ZERO DMX
//     traffic. Every command to a dead bulb makes the bridge retry Zigbee
//     delivery for seconds, eating the airtime live bulbs need; with even one
//     dead bulb patched, that cascade knocks healthy bulbs unreachable too.
//     The recovery system owns unreachable bulbs until they return.
//   • JITTER tolerance — skip changes smaller than a few units (source dither),
//     so a "held" level doesn't stream commands forever.
//   • SEND_GAP_MS rate cap — at most 1 command/sec to any one light
//     (ONOFF_GAP_MS floor for on/off cues so blackouts land fast).
//   • Adaptive transition, no velocity math: a SETTLED value sends with a quick
//     300 ms ramp (snappy discrete cues); a value MOVING for 2+ ticks is a fade
//     and sends with FADE_TT so consecutive 1/sec commands chain into one
//     continuous glide. A value on its FIRST moving tick waits one tick (250 ms)
//     to learn which it is. Blackout is always immediate with tt 0.
function tickBridge() {
  if (!hueApi || !config.bridge || !config.user) return;
  const now = Date.now();
  for (const [lightId, cur] of Object.entries(lightCurrent)) {
    if (config.disabledLights[lightId]) continue;

    // Movement detection — stamped every tick, even for skipped bulbs, so the
    // state is current the moment a bulb recovers.
    const tickPrev   = lightTickPrev[lightId];
    const moving     = !!tickPrev && Math.max(
      Math.abs(cur.r - tickPrev.r), Math.abs(cur.g - tickPrev.g), Math.abs(cur.b - tickPrev.b)) >= JITTER;
    const movingPrev = !!lightMovingPrev[lightId];
    lightTickPrev[lightId]   = { r: cur.r, g: cur.g, b: cur.b };
    lightMovingPrev[lightId] = moving;

    // Dead bulbs get no DMX traffic — the recovery system owns them.
    if (unreachableLights.has(String(lightId))) continue;

    const isBlackout = cur.r === 0 && cur.g === 0 && cur.b === 0;
    const last = lightLastSent[lightId];
    const wasBlackout   = last ? (last.r === 0 && last.g === 0 && last.b === 0) : null;
    const onOffBoundary = last != null && isBlackout !== wasBlackout;

    if (last) {
      const diff = Math.max(Math.abs(cur.r - last.r), Math.abs(cur.g - last.g), Math.abs(cur.b - last.b));
      if (diff === 0) continue;                                  // already at this value
      if (diff < JITTER && !onOffBoundary) continue;             // source dither — ignore
    }

    // Per-light rate cap — protects the bulb's Zigbee link. On/off cues use the
    // reduced floor so a blackout never waits a full second.
    const gap = config.noLimit ? 0 : (onOffBoundary ? ONOFF_GAP_MS : SEND_GAP_MS);
    if (gap > 0 && now - (lightLastSendMs[lightId] || 0) < gap) continue;

    // Pick the transition that matches what the value is doing.
    let tt;
    if (isBlackout)          tt = 0;          // blackout: instant
    else if (onOffBoundary)  tt = FOLLOW_TT;  // lights-up cue: act now, quick ramp
    else if (!moving)        tt = FOLLOW_TT;  // settled target: snappy 300 ms
    else if (movingPrev)     tt = FADE_TT;    // sustained fade: glide across the send gap
    else continue;                            // first moving tick: wait one tick to classify

    lightLastSent[lightId]   = { r: cur.r, g: cur.g, b: cur.b };
    lightLastSendMs[lightId] = now;
    sendDirectState(lightId, buildDirectPayload(cur.r, cur.g, cur.b, { tt }));
  }
}

function startBridgeTicker() {
  if (!bridgeTicker) bridgeTicker = setInterval(tickBridge, TICKER_MS);
}

function stopBridgeTicker() {
  if (bridgeTicker) { clearInterval(bridgeTicker); bridgeTicker = null; }
  for (const k of Object.keys(lightCurrent))     delete lightCurrent[k];
  for (const k of Object.keys(lightLastSent))    delete lightLastSent[k];
  for (const k of Object.keys(lightLastSendMs))  delete lightLastSendMs[k];
  for (const k of Object.keys(lightTickPrev))    delete lightTickPrev[k];
  for (const k of Object.keys(lightMovingPrev))  delete lightMovingPrev[k];
}

// ── Per-bulb recovery poller ─────────────────────────────────────────────────
// While IDLE (no DMX): every 8 s, send a non-destructive probe PUT to each bulb
// in unreachableLights. The PUT forces the bridge to attempt Zigbee contact;
// confirmReachability() then reads back state.reachable 4 s later.
//
// While DMX IS ACTIVE: send NO probe traffic at all. Probes to dead bulbs make
// the bridge retry Zigbee delivery for seconds per attempt, eating the airtime
// live bulbs need mid-show — probing during a show is how one dead bulb cascades
// into "everything keeps going unreachable". In-show recovery instead rides on
// the 30 s health-check reachability sync (GET-only, zero Zigbee cost): when a
// bulb is re-powered it announces itself to the bridge on its own, the sync sees
// reachable:true, and the ticker resumes sending to it automatically.
//
// DOUBLE-START GUARD: startRecoveryPoller() is a no-op if recoveryInterval !== null.

function startRecoveryPoller() {
  if (recoveryInterval !== null) return; // already running
  recoveryInterval = setInterval(tickRecovery, 8000);
}

function stopRecoveryPoller() {
  if (recoveryInterval !== null) {
    clearInterval(recoveryInterval);
    recoveryInterval = null;
  }
  unreachableLights.clear();
}

function tickRecovery() {
  if (!hueApi || !config.bridge || !config.user) return;
  if (unreachableLights.size === 0) return;
  if (isDmxActive()) return; // never add Zigbee load mid-show — see block comment
  for (const lightId of unreachableLights) {
    sendRecoveryProbe(lightId);
  }
}

// Send a single non-destructive PUT to force the bridge to retry Zigbee contact.
// The payload re-asserts the bulb's last known on/off state, so a successful
// probe changes nothing visible (the old {on:true, bri:1} probe snapped
// recovering bulbs to minimum brightness and fought with DMX).
// Uses the same per-light rate-limit bucket as tickBridge.
// Returns true if the probe was dispatched, false if skipped this cycle.
function sendRecoveryProbe(lightId) {
  if (!config.bridge || !config.user) return false;
  if (isDmxActive()) return false; // in-show recovery is handled by the 30 s sync

  // Honour the same per-light rate limit used by the DMX ticker
  const lastMs = lightLastSendMs[lightId] || 0;
  if (!config.noLimit && Date.now() - lastMs < SEND_GAP_MS) return false; // too soon — retry next cycle

  lightLastSendMs[lightId] = Date.now();

  const cached = lightsCache.find(l => String(l.id) === String(lightId));
  const lastOn = cached && cached.state ? !!cached.state.on : true;
  const probe  = Buffer.from(JSON.stringify({ on: lastOn, transitiontime: 0 }));
  console.log(`[recovery] Attempting bulb ${lightId}…`);

  const req = http.request({
    hostname: config.bridge,
    port:     80,
    path:     `/api/${config.user}/lights/${lightId}/state`,
    method:   'PUT',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': probe.length },
    agent:    keepAliveAgent,
  }, res => {
    res.resume(); // drain the PUT response — we don't trust it to confirm reachability
    // The bridge silently returns success for unreachable bulbs (it queues the command
    // internally rather than returning an error), so a clean PUT body does NOT mean the
    // bulb actually responded over Zigbee.
    //
    // After sending the probe the bridge begins a Zigbee round-trip and briefly sets
    // reachable:true optimistically while that attempt is in flight — reading back
    // immediately would catch that transient value and produce false recoveries.
    // Wait 4 s to let the Zigbee exchange complete and the bridge settle on the real
    // outcome before reading state.reachable.
    res.on('end', () => setTimeout(() => confirmReachability(String(lightId)), 4000));
  });
  req.on('error', err => console.warn(`[recovery] PUT light ${lightId} error: ${err.message}`));
  req.write(probe);
  req.end();
  return true;
}

// GET /lights/{id} and check state.reachable — the only reliable way to know
// whether a bulb actually responded to the Zigbee probe.
function confirmReachability(sid) {
  if (!config.bridge || !config.user) return;
  const req = http.request({
    hostname: config.bridge,
    port:     80,
    path:     `/api/${config.user}/lights/${sid}`,
    method:   'GET',
    agent:    keepAliveAgent,
  }, res => {
    let data = '';
    res.on('data', c => { data += c; });
    res.on('end', () => {
      try {
        const body = JSON.parse(data);
        if (body && body.state && body.state.reachable === true) {
          // Bridge confirms the bulb is back on the Zigbee mesh
          unreachableLights.delete(sid);
          delete lightLastSent[sid]; // clear dedup so next DMX tick sends a full resync
          console.log(`[recovery] Bulb ${sid} recovered — resuming DMX control`);
          if (mainWindow && !mainWindow.isDestroyed())
            mainWindow.webContents.send('bulb-recovered', { id: sid });
        } else {
          console.log(`[recovery] Bulb ${sid} still unreachable`);
          // Leave in unreachableLights — next tickRecovery() will retry
        }
      } catch {
        console.warn(`[recovery] Bad JSON from GET /lights/${sid}`);
      }
    });
  });
  req.on('error', err => console.warn(`[recovery] GET light ${sid} error: ${err.message}`));
  req.end();
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
  }, res => {
    // Read the response body — the Hue API returns HTTP 200 even for errors,
    // with JSON like [{"error":{"type":1,"description":"unauthorized user"}}].
    // Status-code checking alone misses these failures.
    let data = '';
    res.on('data', c => { data += c; });
    res.on('end', () => {
      if (res.statusCode >= 400) {
        console.warn(`[bridge] PUT light ${lightId} → HTTP ${res.statusCode}: ${data.slice(0, 200)}`);
        return;
      }
      if (data.includes('"error"')) {
        console.warn(`[bridge] PUT light ${lightId} → API error: ${data.slice(0, 200)}`);
        // Hue error type 7 = bulb unreachable (Zigbee contact lost)
        if (data.includes('"type":7')) {
          const sid  = String(lightId);
          const isNew = !unreachableLights.has(sid);
          unreachableLights.add(sid);
          if (isNew) {
            console.warn(`[recovery] Bulb ${sid} went unreachable — queued for recovery`);
            if (mainWindow && !mainWindow.isDestroyed())
              mainWindow.webContents.send('bulb-unreachable', { id: sid });
            // Accelerated first attempt — probe after 2 s before the 8 s poller kicks in
            setTimeout(() => sendRecoveryProbe(sid), 2000);
          }
        }
        return;
      }
      // Apparent success — but the bridge silently returns success for unreachable
      // bulbs too (it queues the command). Delay the GET so the bridge has time to
      // complete the Zigbee round-trip and settle on the real reachable value.
      const sid = String(lightId);
      if (unreachableLights.has(sid)) {
        setTimeout(() => confirmReachability(sid), 4000);
      }
    });
  });
  req.on('error', err => console.warn(`[bridge] PUT light ${lightId} error: ${err.message}`));
  req.write(body);
  req.end();
}

// Raw HTTP/HTTPS request helper for the Hue local REST API.
// Tries port 80 first; falls back to cert-free HTTPS on failure.
// Returns the parsed JSON body (rejects on network errors or bad JSON).
function hueBridgeRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const tlsAgent = new https.Agent({ rejectUnauthorized: false, minVersion: 'TLSv1', ciphers: 'ALL' });

    function attempt(mod, port) {
      const opts = {
        hostname: config.bridge,
        port,
        path:     `/api/${config.user}${apiPath}`,
        method,
        agent:    port === 443 ? tlsAgent : keepAliveAgent,
      };
      if (payload) opts.headers = { 'Content-Type': 'application/json', 'Content-Length': payload.length };

      const req = mod.request(opts, res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error('Bad JSON from bridge')); }
        });
      });
      req.on('error', e => { if (port === 80) attempt(https, 443); else reject(e); });
      req.setTimeout(8000, () => { req.destroy(); if (port === 443) reject(new Error('timeout')); else attempt(https, 443); });
      if (payload) req.write(payload);
      req.end();
    }
    attempt(http, 80);
  });
}

// Build a plain-object payload (Hue API units) instead of a LightState object
function buildDirectPayload(r, g, b, opts = {}) {
  const tt = opts.tt !== undefined ? opts.tt : FOLLOW_TT;
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

// Returns the set of universe numbers this protocol's socket should accept.
// Always includes the base (globally-configured) universe plus any universe
// explicitly assigned to at least one light via a custom patch.
// Cached watched-universe set — rebuilt whenever lightAddresses or the base universe changes.
// Avoids allocating a new Set on every incoming sACN packet (which can be thousands/sec).
let _watchedUniversesCache = null;
let _watchedUniversesBase  = null;

function getWatchedUniverses(baseUniverse) {
  if (_watchedUniversesCache && _watchedUniversesBase === baseUniverse) {
    return _watchedUniversesCache;
  }
  const universes = new Set([baseUniverse]);
  for (const patch of Object.values(config.lightAddresses || {})) {
    if (patch == null || typeof patch === 'number') continue;
    if (patch.universe != null) universes.add(patch.universe);
  }
  _watchedUniversesBase  = baseUniverse;
  _watchedUniversesCache = universes;
  return universes;
}

// Call this whenever lightAddresses changes so the cache is rebuilt on next use.
function invalidateWatchedUniverses() {
  _watchedUniversesCache = null;
}

// processArtnet(data, packetUniverse, defaultUniverse)
//   packetUniverse  — the universe number in the received packet
//   defaultUniverse — the globally-configured universe for this protocol
//                     (config.universe for Art-Net / config.sacnUniverse for sACN)
// Lights with no custom patch respond to defaultUniverse; lights with a custom
// universe patch respond only when packetUniverse matches their patched universe.
function processArtnet(data, packetUniverse, defaultUniverse) {
  if (!hueApi) return;

  // A single malformed frame must never crash the listener. Any unexpected
  // shape (short buffer, bad offset, etc.) is logged once and the frame dropped.
  try {
    // Cache the raw frame so the renderer can read per-universe live data
    dmxBuffers[packetUniverse] = Buffer.from(data);

    const channelsPerLight = 3;
    const baseOffset       = (config.dmxAddress - 1) + (config.transition === 'channel' ? 1 : 0);
    const lightAddresses   = config.lightAddresses || {};
    const orderedLights    = getOrderedLights();

    for (let i = 0; i < orderedLights.length; i++) {
      const light = orderedLights[i];
      if (config.disabledLights[light.id]) continue;

      const raw = lightAddresses[light.id];
      // Backward compat: plain number stored → treat as { channel: n }
      const patch = (raw != null && typeof raw === 'number') ? { channel: raw } : raw;

      // Determine which universe this light is patched to
      const lightUniverse = patch?.universe ?? defaultUniverse;
      // Skip lights that belong to a different universe in this packet
      if (lightUniverse !== packetUniverse) continue;

      // Determine the 0-based offset within this universe's buffer
      const offset = patch?.channel != null
        ? (patch.channel - 1)
        : baseOffset + i * channelsPerLight;

      if (offset < 0 || offset + 2 >= data.length) continue;

      updateCurrent(light.id, data[offset], data[offset + 1], data[offset + 2], null);
    }

    startBridgeTicker();

    // Send the frame + universe number to the renderer for live display
    if (mainWindow && !mainWindow.isDestroyed()) {
      const snapshot = Array.from(data.slice(0, Math.min(data.length, 512)));
      mainWindow.webContents.send('artnet:dmx-update', snapshot, packetUniverse);
    }
  } catch (err) {
    console.warn(`[dmx] dropped malformed frame on universe ${packetUniverse}: ${err.message}`);
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
    if (!getWatchedUniverses(config.universe).has(msgUniverse)) return;

    const length  = msg.readUInt16BE(16);
    const dmxData = msg.slice(18, 18 + length);
    markDmxActive();
    processArtnet(dmxData, msgUniverse, config.universe);
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

// Throttle the diag IPC send to at most once per second.
// emitSacnDiag() is called on every incoming sACN packet; without throttling,
// heavy traffic (e.g. 150 universes) would flood the main-process event loop
// with thousands of IPC sends/sec, backing up the event queue and delaying
// the keepAlive socket timeouts that prevent ECONNRESET on the bridge.
let _sacnDiagLastAt = 0;
function emitSacnDiag() {
  const now = Date.now();
  if (now - _sacnDiagLastAt < 1000) return;
  _sacnDiagLastAt = now;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sacn:diag', {
      ...sacnDiag,
      configured: config.sacnUniverse,
      watched: [...getWatchedUniverses(config.sacnUniverse)],
    });
  }
}

function sacnMulticastGroup(universe) {
  return `239.255.${(universe >> 8) & 0xff}.${universe & 0xff}`;
}

// Join a sACN multicast group on the socket that is currently bound.
// Safe to call for groups already joined (errors are swallowed).
function joinSacnGroup(universe) {
  if (!sacnSocket || !config.sacnMulticast) return;
  const group = sacnMulticastGroup(universe);
  if (config.host !== '0.0.0.0') {
    try { sacnSocket.addMembership(group, config.host); } catch {}
  } else {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs) {
        if (a.family !== 'IPv4' || a.internal) continue;
        try { sacnSocket.addMembership(group, a.address); } catch {}
      }
    }
  }
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

    // ── Fast pre-filter ───────────────────────────────────────────────────────
    // In E1.31 the universe is a 16-bit BE value at byte offset 113.
    // Read those two bytes before doing any further work so we can drop the
    // overwhelming majority of packets (all non-watched universes) in ~1 µs
    // rather than running the full parseSACN validation on every one of them.
    // This is critical when a sender is transmitting 100+ universes: without
    // this guard, parseSACN runs thousands of times per second and saturates
    // the event loop, delaying the keepAlive socket timeouts and causing
    // ECONNRESET failures on the Hue bridge connection.
    if (msg.length >= 115) {
      const rawUniv = msg.readUInt16BE(113);
      if (!getWatchedUniverses(config.sacnUniverse).has(rawUniv)) {
        sacnDiag.wrongUniverse++;
        emitSacnDiag(); // throttled to 1/sec — negligible cost
        return;
      }
    }

    const result = parseSACN(msg);
    if (!result) { emitSacnDiag(); return; }

    sacnDiag.lastUniverse = result.universe;
    sacnDiag.lastPriority = result.priority;
    emitSacnDiag();

    markDmxActive();
    processArtnet(result.dmxData, result.universe, config.sacnUniverse);
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
        // Join the default universe AND every per-light universe override so
        // the OS delivers packets for all watched universes to this socket.
        for (const universe of getWatchedUniverses(config.sacnUniverse)) {
          joinSacnGroup(universe);
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
    syncUnreachableFromCache();
    return lightsCache;
  } catch (err) {
    console.error('[fetchLights] ERROR:', err);
    return lightsCache;
  }
}

// Compare lightsCache against unreachableLights and fire events for transitions.
// Called after every fetchLights() so any bulb that went offline mid-session
// is picked up within one health-check cycle (30 s) even with no DMX activity.
function syncUnreachableFromCache() {
  for (const light of lightsCache) {
    const sid = String(light.id);
    const offline = light.state && light.state.reachable === false;
    if (offline) {
      if (!unreachableLights.has(sid)) {
        // Newly unreachable — start recovery
        unreachableLights.add(sid);
        console.warn(`[recovery] Bulb ${sid} went unreachable (detected via poll) — queued for recovery`);
        if (mainWindow && !mainWindow.isDestroyed())
          mainWindow.webContents.send('bulb-unreachable', { id: sid });
        // Accelerated first attempt
        setTimeout(() => sendRecoveryProbe(sid), 2000);
      }
    } else {
      if (unreachableLights.has(sid)) {
        // Was unreachable, now showing online in the full fetch
        unreachableLights.delete(sid);
        delete lightLastSent[sid];
        console.log(`[recovery] Bulb ${sid} recovered (detected via poll) — resuming DMX control`);
        if (mainWindow && !mainWindow.isDestroyed())
          mainWindow.webContents.send('bulb-recovered', { id: sid });
      }
    }
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
  const base             = (config.dmxAddress - 1) + (config.transition === 'channel' ? 1 : 0);
  const orderedLights    = getOrderedLights();
  const lightAddresses   = config.lightAddresses || {};
  const map = {};
  orderedLights.forEach((light, i) => {
    const raw   = lightAddresses[light.id];
    // Backward compat: plain number → treat as { channel: n }
    const patch = (raw != null && typeof raw === 'number') ? { channel: raw } : raw;

    const customChannel  = patch?.channel  ?? null;
    const customUniverse = patch?.universe ?? null;
    const isCustom       = patch != null;

    const start    = customChannel  != null ? customChannel  : base + i * channelsPerLight + 1;
    // Default universe is protocol-specific: Art-Net uses config.universe, sACN uses config.sacnUniverse
    const defaultUniverse = config.protocol === 'sacn' ? (config.sacnUniverse ?? 1) : (config.universe ?? 0);
    const universe = customUniverse != null ? customUniverse : defaultUniverse;

    map[light.id] = {
      start,
      universe,
      channels: channelsPerLight,
      labels:   ['R', 'G', 'B'].map((l, j) => `ch${start + j}:${l}`),
      custom:   isCustom,
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
      startRecoveryPoller();
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
  stopRecoveryPoller();
  lightsCache = [];
  return { success: true };
});

ipcMain.handle('bridge:status', () => {
  return {
    connected: hueApi !== null,
    bridge: config.bridge,
    rebooting: isRebooting,
  };
});

// Reboot the Hue bridge. UI-only — guarded so it can't fire without a live
// connection, and it stops the ticker/recovery poller before issuing the command.
ipcMain.handle('bridge:reboot', async () => rebootBridge());

// Cancel an in-progress post-reboot reconnect loop.
ipcMain.handle('bridge:reboot-cancel', () => cancelReboot());

ipcMain.handle('lights:get', async () => {
  const lights         = await fetchLights();
  const dmxMap         = calcDmxChannels();
  const ordered        = getOrderedLights();
  const lightAddresses = config.lightAddresses || {};
  return {
    lights: ordered.map(l => ({
      ...l,
      dmx:           dmxMap[l.id] || null,
      disabled:      !!config.disabledLights[l.id],
      customAddress: (() => {
          const raw = lightAddresses[l.id];
          if (raw == null) return null;
          // Backward compat: plain number → expose as { channel: n, universe: null }
          if (typeof raw === 'number') return { channel: raw, universe: null };
          return raw;
        })(),
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

// ── Per-light DMX address patching ────────────────────────────────────────────

// Set or clear the per-light DMX patch.
//   patch = null                    → sequential (no override)
//   patch = { channel?, universe? } → either field optional; null field = use global default
// When both fields are absent/null the patch is cleared entirely.
ipcMain.handle('lights:set-address', (event, lightId, patch) => {
  if (!config.lightAddresses) config.lightAddresses = {};
  if (
    patch == null ||
    (typeof patch === 'object' && patch.channel == null && patch.universe == null)
  ) {
    delete config.lightAddresses[lightId];
  } else if (typeof patch === 'number') {
    // Legacy call — treat as channel-only
    config.lightAddresses[lightId] = { channel: patch };
  } else {
    // Store only the fields that are actually set so we don't clobber missing ones
    const stored = {};
    if (patch.channel  != null) stored.channel  = Number(patch.channel);
    if (patch.universe != null) stored.universe = Number(patch.universe);
    config.lightAddresses[lightId] = stored;
    // If sACN is already running, join the new universe's multicast group immediately
    // so packets arrive without requiring a listener restart.
    if (stored.universe != null && sacnRunning) joinSacnGroup(stored.universe);
  }
  invalidateWatchedUniverses();
  saveConfig();
  return { success: true };
});

// ── Hue bulb discovery ────────────────────────────────────────────────────────

// POST /lights — tells the bridge to open a 40-second Zigbee inclusion window.
ipcMain.handle('lights:search-new', async () => {
  if (!config.bridge || !config.user) return { success: false, error: 'Not connected' };
  try {
    await hueBridgeRequest('POST', '/lights', {});
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// GET /lights/new — poll for lights found during the active scan.
// Returns { scanning: bool, lights: [{ id, name }] }
ipcMain.handle('lights:get-new', async () => {
  if (!config.bridge || !config.user) return { success: false, error: 'Not connected' };
  try {
    const result = await hueBridgeRequest('GET', '/lights/new', null);
    // result shape: { "lastscan": "active" | "<timestamp>", "<id>": { name: "..." }, ... }
    const { lastscan, ...rest } = result;
    const lights = Object.entries(rest).map(([id, info]) => ({ id, name: info.name || `Light ${id}` }));
    return { success: true, scanning: lastscan === 'active', lights };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Rename a light on the bridge and update our local cache.
ipcMain.handle('lights:rename', async (event, lightId, name) => {
  if (!config.bridge || !config.user) return { success: false, error: 'Not connected' };
  try {
    await hueBridgeRequest('PUT', `/lights/${lightId}`, { name });
    const cached = lightsCache.find(l => String(l.id) === String(lightId));
    if (cached) cached.name = name;
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Delete a light from the bridge and remove it from local state.
ipcMain.handle('lights:delete', async (event, lightId) => {
  if (!config.bridge || !config.user) return { success: false, error: 'Not connected' };
  try {
    await hueBridgeRequest('DELETE', `/lights/${lightId}`, null);
    lightsCache = lightsCache.filter(l => String(l.id) !== String(lightId));
    // Clean up all per-light config entries
    delete config.disabledLights[lightId];
    if (config.lightAddresses) { delete config.lightAddresses[lightId]; invalidateWatchedUniverses(); }
    config.lightsOrder = (config.lightsOrder || []).filter(id => String(id) !== String(lightId));
    saveConfig();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
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
  // Explicitly broadcast stopped state — stopArtnet/stopSACN don't emit events
  sendToAll('artnet:status', buildStatusPayload());
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
  // In packaged builds the icon is placed in Resources/ via extraResources.
  // In development __dirname is the project root so build/icon.png is correct.
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'tray-icon.png')
    : path.join(__dirname, 'build', 'icon.png');

  let icon = nativeImage.createFromPath(iconPath);
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

// Send the current bridge connection state to the main window.
function sendBridgeStatus() {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send('bridge:auto-connect', { connected: !!hueApi, bridge: config.bridge });
}

// Show (or create) the main window and restore Dock presence on macOS
function openMainWindow() {
  if (process.platform === 'darwin' && app.dock) app.dock.show();

  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.webContents.executeJavaScript(
        `document.body.dataset.platform = '${process.platform}'`
      );
      // Fire immediately so the listener bar / settings populate right away —
      // don't wait on the bridge connection promise.
      sendBridgeStatus();
      // If still connecting, fire again once the attempt resolves so the
      // status dot updates without the user having to do anything.
      if (!hueApi && connectedPromise) {
        connectedPromise.then(() => sendBridgeStatus()).catch(() => {});
      }
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
  stopRecoveryPoller();
  app.quit();
});

ipcMain.handle('login-item:get', () => app.getLoginItemSettings().openAtLogin);

ipcMain.handle('login-item:set', (_, enabled) => {
  // openAsHidden tells macOS to start the app without bringing it to the
  // foreground — essential for a tray-only background launch.
  app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
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

  // Connect to saved bridge in the background immediately.
  // If the network isn't ready yet (common at login), retry every 8 s for
  // up to 2 minutes before handing off to the 30 s health-check interval.
  connectedPromise = connectToSavedBridge().then(ok => {
    if (ok || !config.bridge) return ok;
    let attempts = 0;
    startupRetryTimer = setInterval(async () => {
      if (hueApi || ++attempts >= 15) { clearInterval(startupRetryTimer); startupRetryTimer = null; return; }
      const connected = await connectToSavedBridge().catch(() => false);
      if (connected) {
        clearInterval(startupRetryTimer);
        startupRetryTimer = null;
        sendBridgeStatus();   // notify main window if it's open
      }
    }, 8000); // every 8 s  →  15 attempts  →  2 minutes
    return false;
  });

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

// Tear down every timer, socket, and server. Idempotent — safe to call more
// than once (close() / clearInterval() on already-stopped handles are no-ops).
function cleanupAll() {
  stopArtnet();
  stopSACN();
  stopBridgeTicker();
  stopRecoveryPoller();
  stopHealthCheck();
  isRebooting = false;
  if (takeoverBroadcastTimer) { clearInterval(takeoverBroadcastTimer); takeoverBroadcastTimer = null; }
  if (startupRetryTimer)      { clearInterval(startupRetryTimer);      startupRetryTimer = null; }
  if (rebootTimer)            { clearTimeout(rebootTimer);             rebootTimer = null; }
  if (companionServer) { try { companionServer.close(); } catch {} companionServer = null; }
}

// before-quit fires for an actual app quit on every platform (incl. the tray
// "Quit" item and macOS Cmd-Q), unlike window-all-closed which we deliberately
// ignore on macOS to keep running in the menu bar. This is the single guaranteed
// teardown point, so all intervals/sockets/servers are released here.
app.on('before-quit', cleanupAll);

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') {
    // Keep running in the menu bar — listener stays active, Dock stays hidden
    if (app.dock) app.dock.hide();
  } else {
    cleanupAll();
    app.quit();
  }
});
