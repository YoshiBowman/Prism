'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hue', {
  // Network
  getNetworkInterfaces: () => ipcRenderer.invoke('network:get-interfaces'),

  // Bridge
  discoverBridges:  (ifaceIp, extraSubnets) => ipcRenderer.invoke('bridge:discover', ifaceIp, extraSubnets),
  getScanSubnets:   ()   => ipcRenderer.invoke('bridge:get-scan-subnets'),
  verifyBridge:     (ip) => ipcRenderer.invoke('bridge:verify', ip),
  startPair:        (ip) => ipcRenderer.invoke('bridge:start-pair', ip),
  connectSaved:     ()   => ipcRenderer.invoke('bridge:connect-saved'),
  disconnect:       ()   => ipcRenderer.invoke('bridge:disconnect'),
  bridgeStatus:     ()   => ipcRenderer.invoke('bridge:status'),

  // Lights
  getLights:       ()           => ipcRenderer.invoke('lights:get'),
  setLightOrder:   (order)      => ipcRenderer.invoke('lights:set-order', order),
  toggleDisabled:  (lightId)    => ipcRenderer.invoke('lights:toggle-disabled', lightId),
  setLightState:   (id, state)  => ipcRenderer.invoke('lights:set-state', id, state),

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

  // Events from main process
  on: (channel, fn) => {
    const allowed = [
      'bridge:pair-event',
      'bridge:auto-connect',
      'bridge:found',
      'bridge:scan-progress',
      'bridge:unreachable',
      'bridge:reachable',
      'artnet:dmx-update',
      'artnet:status',
      'sacn:diag',
      'dmx:takeover-change',
      'update:available',
      'update:progress',
      'update:downloaded',
      'update:error',
    ];
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_, ...args) => fn(...args));
  },
  off: (channel, fn) => ipcRenderer.removeListener(channel, fn),
});
