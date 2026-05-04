'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
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
  protocol: 'artnet',   // 'artnet' | 'sacn' | 'both'
  host: '0.0.0.0',
  transition: 100,
  colorloop: false,
  white: false,
  noLimit: false,
  disabledLights: {},
  lightsOrder: [],
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
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ── Hue API state ────────────────────────────────────────────────────────────

let hueApi = null;
let mainWindow = null;

async function connectToSavedBridge() {
  if (!config.bridge || !config.user) return false;
  try {
    hueApi = await v3.api.createInsecureLocal(config.bridge).connect(config.user);
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

// Per-light update queue for rate limiting
let updateQueue = [];
let updateTimer = null;
let lastUpdateTime = 0;

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

function buildLightState(r, g, b, extraChannels, opts) {
  const { LightState } = v3.lightStates;
  const state = new LightState();

  if (r === 0 && g === 0 && b === 0) {
    if (!opts.white || (extraChannels && extraChannels[1] === 0)) {
      return state.off();
    }
  }

  state.on(true);
  state.effect('none');
  state.transitiontime(Math.round((opts.transition || 100) / 100));

  if (opts.colorloop && r === 1 && g === 1 && b === 1) {
    return state.effect('colorloop');
  }

  if (opts.white && r === 0 && g === 0 && b === 0 && extraChannels) {
    const ct = Math.round(153 + (extraChannels[0] / 255) * (500 - 153));
    const bri = Math.max(1, Math.round((extraChannels[1] / 255) * 100));
    return state.ct(ct).brightness(bri);
  }

  const [h, s, v] = rgbToHsb(r, g, b);
  state.hue(Math.round(h * 65535));
  state.saturation(Math.round(s * 100));
  state.brightness(Math.max(1, Math.round(v * 100)));

  return state;
}

function scheduleUpdate(lightId, state) {
  // Remove any pending update for this light
  updateQueue = updateQueue.filter(item => item.lightId !== lightId);
  updateQueue.push({ lightId, state });
  if (!updateTimer) drainQueue();
}

function drainQueue() {
  updateTimer = null;
  if (!hueApi || updateQueue.length === 0) return;

  const rateMs = config.noLimit ? 0 : 100;
  const now = Date.now();
  const wait = Math.max(0, rateMs - (now - lastUpdateTime));

  updateTimer = setTimeout(async () => {
    updateTimer = null;
    if (!updateQueue.length) return;

    const { lightId, state } = updateQueue.shift();
    lastUpdateTime = Date.now();
    try {
      await hueApi.lights.setLightState(lightId, state);
    } catch { /* light may be unreachable */ }

    if (updateQueue.length > 0) drainQueue();
  }, wait);
}

function processArtnet(data) {
  if (!hueApi) return;

  const opts = {
    transition: config.transition === 'channel' ? (data[0] * 100) : config.transition,
    colorloop: config.colorloop,
    white: config.white,
  };

  const channelsPerLight = config.white ? 5 : 3;
  const baseOffset = (config.dmxAddress - 1) + (config.transition === 'channel' ? 1 : 0);

  const orderedLights = getOrderedLights();

  for (let i = 0; i < orderedLights.length; i++) {
    const light = orderedLights[i];
    if (config.disabledLights[light.id]) continue;

    const offset = baseOffset + i * channelsPerLight;
    if (offset + 2 >= data.length) break;

    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    const extra = config.white ? [data[offset + 3] || 0, data[offset + 4] || 0] : null;

    const state = buildLightState(r, g, b, extra, opts);
    scheduleUpdate(light.id, state);
  }

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
    processArtnet(dmxData);
  });

  artnetSocket.on('error', (err) => {
    artnetRunning = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('artnet:status', { running: false, error: err.message });
    }
  });

  artnetSocket.bind(ARTNET_PORT, config.host === '0.0.0.0' ? undefined : config.host, () => {
    try { artnetSocket.setBroadcast(true); } catch {}
    artnetRunning = true;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('artnet:status', { running: true });
    }
  });

  return { success: true };
}

function stopArtnet() {
  if (artnetSocket) {
    try { artnetSocket.close(); } catch {}
    artnetSocket = null;
  }
  artnetRunning = false;
  updateQueue = [];
  if (updateTimer) { clearTimeout(updateTimer); updateTimer = null; }
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
  const universe = msg.readUInt16BE(113);
  const propCount = msg.readUInt16BE(123);
  if (msg.length < 125 + propCount) return null;
  // Start code at 125, DMX data at 126
  const dmxData = msg.slice(126, 125 + propCount);
  return { universe, dmxData };
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
    emitSacnDiag();

    if (result.universe !== config.sacnUniverse) {
      sacnDiag.wrongUniverse++;
      return;
    }
    dmxBuffer = Buffer.from(result.dmxData);
    processArtnet(result.dmxData);
  });

  sacnSocket.on('error', (err) => {
    sacnRunning = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('artnet:status', { running: isAnyRunning(), sacnError: err.message });
    }
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
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('artnet:status', buildStatusPayload());
    }
  });

  return { success: true };
}

function stopSACN() {
  if (sacnSocket) {
    try { sacnSocket.close(); } catch {}
    sacnSocket = null;
  }
  sacnRunning = false;
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
  const channelsPerLight = config.white ? 5 : 3;
  const base = (config.dmxAddress - 1) + (config.transition === 'channel' ? 1 : 0);
  const orderedLights = getOrderedLights();
  const map = {};
  orderedLights.forEach((light, i) => {
    const start = base + i * channelsPerLight + 1;
    map[light.id] = {
      start,
      channels: channelsPerLight,
      labels: config.white
        ? ['R', 'G', 'B', 'CT', 'Bri'].map((l, j) => `ch${start + j}:${l}`)
        : ['R', 'G', 'B'].map((l, j) => `ch${start + j}:${l}`),
    };
  });
  return map;
}

// ── IPC handlers ─────────────────────────────────────────────────────────────

// ── Bridge discovery ──────────────────────────────────────────────────────────

// ── Discovery methods ─────────────────────────────────────────────────────────

const HUE_OUI = ['00:17:88', 'ec:b5:fa', 'c4:29:96', 'b8:27:eb'];

// Probe a single IP on both HTTP :80 and HTTPS :443 for the Hue /api/config endpoint.
// Hard setTimeout deadline prevents hanging when a host doesn't respond at the TCP level.
function probeHueBridge(ip, timeoutMs = 900) {
  function tryProto(mod, port) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (val) => { if (done) return; done = true; if (val) resolve(val); else reject(); };
      const deadline = setTimeout(() => finish(null), timeoutMs);
      try {
        const req = mod.get(
          { hostname: ip, port, path: '/api/config', rejectUnauthorized: false },
          (res) => {
            clearTimeout(deadline);
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => {
              try {
                const j = JSON.parse(data);
                finish((j.bridgeid || j.modelid) ? { ip, name: j.name || 'Hue Bridge', bridgeid: j.bridgeid } : null);
              } catch { finish(null); }
            });
            res.on('error', () => finish(null));
          }
        );
        req.on('error', () => { clearTimeout(deadline); finish(null); });
        req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch {} finish(null); });
      } catch { clearTimeout(deadline); finish(null); }
    });
  }
  return Promise.any([tryProto(http, 80), tryProto(https, 443)]).catch(() => null);
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
                        /philips.*hue/i.test(text) || /urn:.*schemas-upnp-org.*Basic/i.test(text);
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

ipcMain.handle('bridge:discover', async (event, ifaceIp, extraSubnets = []) => {
  const sender = event.sender;
  const found = [];
  const seen = new Set();

  function emit(bridge) {
    if (seen.has(bridge.ip)) return;
    seen.add(bridge.ip);
    found.push(bridge);
    if (!sender.isDestroyed()) sender.send('bridge:found', bridge);
  }

  // ── Phase 0: ARP cache (instant — filters by Philips/Signify MAC OUI) ──
  if (!sender.isDestroyed()) sender.send('bridge:scan-progress', { phase: 'arp', completed: 0, total: 0, subnets: [] });
  const arpResults = await arpCacheScan().catch(() => []);
  for (const b of arpResults) emit(b);

  // ── Phase 1: SSDP (UPnP multicast from every interface — subnet-independent) ──
  if (!sender.isDestroyed()) sender.send('bridge:scan-progress', { phase: 'ssdp', completed: 0, total: 0, subnets: [] });
  const ssdpResults = await ssdpDiscover(4000).catch(() => []);
  for (const b of ssdpResults) emit(b);

  // ── Phase 2: mDNS (finds bridges on any reachable subnet, incl. direct connections) ──
  if (!sender.isDestroyed()) sender.send('bridge:scan-progress', { phase: 'mdns', completed: 0, total: 0, subnets: [] });
  const mdnsResults = await mDNSDiscover(4500).catch(() => []);
  for (const b of mdnsResults) emit(b);

  // ── Phase 2: HTTP/HTTPS subnet scan fallback ──
  const subnets = [...new Set([...getSubnetsToScan(ifaceIp), ...(extraSubnets || [])])];
  if (subnets.length > 0) {
    const ips = [];
    for (const s of subnets) for (let i = 1; i <= 254; i++) ips.push(`${s}.${i}`);
    const CONCURRENCY = 20;
    let completed = 0;

    for (let i = 0; i < ips.length; i += CONCURRENCY) {
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
  const result = await probeHueBridge(ip, 3000);
  if (result) return { success: true, name: result.name, bridgeid: result.bridgeid };
  return { success: false, error: `No Hue bridge responded at ${ip}` };
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
    'protocol', 'host', 'transition', 'colorloop', 'white', 'noLimit',
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
  updateQueue = [];
  if (updateTimer) { clearTimeout(updateTimer); updateTimer = null; }
  return { success: true };
});

ipcMain.handle('artnet:status', () => buildStatusPayload());

// ── Bridge pairing ───────────────────────────────────────────────────────────

async function pairBridge(ip, sender) {
  let unauthApi;
  try {
    unauthApi = await v3.api.createInsecureLocal(ip).connect();
  } catch (err) {
    sender.send('bridge:pair-event', { type: 'error', message: `Cannot reach bridge: ${err.message}` });
    return;
  }

  sender.send('bridge:pair-event', { type: 'waiting', remaining: 30 });

  const deadline = Date.now() + 30000;

  while (Date.now() < deadline) {
    try {
      const user = await unauthApi.users.createUser('dmx-hue-gui', 'main-app');
      config.bridge = ip;
      config.user = user.username;
      saveConfig();
      hueApi = await v3.api.createInsecureLocal(ip).connect(config.user);
      sender.send('bridge:pair-event', { type: 'success' });
      return;
    } catch (err) {
      const msg = String(err.message || '');
      if ((err.getHueErrorType && err.getHueErrorType() === 101) || msg.toLowerCase().includes('link button')) {
        const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000));
        sender.send('bridge:pair-event', { type: 'waiting', remaining });
        await new Promise(r => setTimeout(r, 1000));
      } else {
        sender.send('bridge:pair-event', { type: 'error', message: err.message });
        return;
      }
    }
  }

  sender.send('bridge:pair-event', { type: 'timeout' });
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
}

app.whenReady().then(async () => {
  loadConfig();
  createWindow();

  // Try auto-connect on startup
  const connected = await connectToSavedBridge();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.once('did-finish-load', () => {
      // Inject platform so CSS can adjust titlebar padding
      mainWindow.webContents.executeJavaScript(
        `document.body.dataset.platform = '${process.platform}'`
      );
      mainWindow.webContents.send('bridge:auto-connect', { connected, bridge: config.bridge });
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopArtnet();
  if (process.platform !== 'darwin') app.quit();
});
