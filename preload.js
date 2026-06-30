'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Maps each (channel → caller fn → wrapper) so off() can remove the exact
// wrapper that on() registered. Lives in the preload scope, not exposed.
const _listenerWrappers = new Map();

contextBridge.exposeInMainWorld('hue', {
  // Network
  getNetworkInterfaces: () => ipcRenderer.invoke('network:get-interfaces'),

  // Bridge
  discoverBridges:  (ifaceIp, extraSubnets) => ipcRenderer.invoke('bridge:discover', ifaceIp, extraSubnets),
  cancelScan:       ()   => ipcRenderer.invoke('bridge:cancel-scan'),
  getScanSubnets:   ()   => ipcRenderer.invoke('bridge:get-scan-subnets'),
  verifyBridge:     (ip) => ipcRenderer.invoke('bridge:verify', ip),
  startPair:        (ip) => ipcRenderer.invoke('bridge:start-pair', ip),
  connectSaved:     ()   => ipcRenderer.invoke('bridge:connect-saved'),
  disconnect:       ()   => ipcRenderer.invoke('bridge:disconnect'),
  bridgeStatus:     ()   => ipcRenderer.invoke('bridge:status'),
  rebootBridge:     ()   => ipcRenderer.invoke('bridge:reboot'),
  cancelReboot:     ()   => ipcRenderer.invoke('bridge:reboot-cancel'),

  // Lights
  getLights:       ()             => ipcRenderer.invoke('lights:get'),
  setLightOrder:   (order)        => ipcRenderer.invoke('lights:set-order', order),
  toggleDisabled:  (lightId)      => ipcRenderer.invoke('lights:toggle-disabled', lightId),
  setLightState:   (id, state)    => ipcRenderer.invoke('lights:set-state', id, state),
  setLightAddress: (id, addr)     => ipcRenderer.invoke('lights:set-address', id, addr),
  searchNewLights: ()             => ipcRenderer.invoke('lights:search-new'),
  getNewLights:    ()             => ipcRenderer.invoke('lights:get-new'),
  renameLight:     (id, name)     => ipcRenderer.invoke('lights:rename', id, name),
  addLight:        (id)           => ipcRenderer.invoke('lights:add', id),
  deleteLight:     (id)           => ipcRenderer.invoke('lights:delete', id),

  // Scenes
  getScenes:    ()            => ipcRenderer.invoke('scenes:get'),
  saveScene:    (name, lights) => ipcRenderer.invoke('scenes:save', name, lights),
  applyScene:   (name)        => ipcRenderer.invoke('scenes:apply', name),
  deleteScene:  (name)        => ipcRenderer.invoke('scenes:delete', name),

  // Settings
  getSettings:  (updates) => ipcRenderer.invoke('settings:get'),
  saveSettings: (updates) => ipcRenderer.invoke('settings:save', updates),

  // DMX status
  dmxIsActive: () => ipcRenderer.invoke('dmx:is-active'),

  // Art-Net / sACN listener
  startArtnet:  () => ipcRenderer.invoke('artnet:start'),
  stopArtnet:   () => ipcRenderer.invoke('artnet:stop'),
  artnetStatus: () => ipcRenderer.invoke('artnet:status'),

  // Updates
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate:  () => ipcRenderer.invoke('update:install'),

  // Tray / window management
  openMainWindow: () => ipcRenderer.invoke('tray:open-main'),
  quit:           () => ipcRenderer.invoke('tray:quit'),

  // Login item (launch at login)
  getLoginItem:   ()        => ipcRenderer.invoke('login-item:get'),
  setLoginItem:   (enabled) => ipcRenderer.invoke('login-item:set', enabled),

  // Events from main process
  on: (channel, fn) => {
    const allowed = [
      'bridge:pair-event',
      'bridge:auto-connect',
      'bridge:found',
      'bridge:scan-progress',
      'bridge:unreachable',
      'bridge:reachable',
      'bridge:reboot-started',
      'bridge:reboot-reconnecting',
      'bridge:reboot-complete',
      'bridge:reboot-timeout',
      'artnet:dmx-update',
      'artnet:status',
      'sacn:diag',
      'dmx:takeover-change',
      'companion:preset-applied',
      'bulb-unreachable',
      'bulb-recovered',
      'update:available',
      'update:progress',
      'update:downloaded',
      'update:error',
    ];
    if (!allowed.includes(channel)) return;
    // on() wraps fn in a new closure, so a later off(channel, fn) could never
    // match the registered listener. Track the wrapper keyed by the caller's fn
    // so off() can look it up and actually remove it — otherwise listeners
    // accumulate across re-registrations and leak.
    const wrapper = (_, ...args) => fn(...args);
    if (!_listenerWrappers.has(channel)) _listenerWrappers.set(channel, new Map());
    _listenerWrappers.get(channel).set(fn, wrapper);
    ipcRenderer.on(channel, wrapper);
  },
  off: (channel, fn) => {
    const forChannel = _listenerWrappers.get(channel);
    const wrapper = forChannel && forChannel.get(fn);
    if (wrapper) {
      ipcRenderer.removeListener(channel, wrapper);
      forChannel.delete(fn);
    }
  },
});
