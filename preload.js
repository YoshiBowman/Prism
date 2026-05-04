'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hue', {
  // Network
  getNetworkInterfaces: () => ipcRenderer.invoke('network:get-interfaces'),

  // Bridge
  discoverBridges: (ifaceIp, extraSubnets) => ipcRenderer.invoke('bridge:discover', ifaceIp, extraSubnets),
  getScanSubnets: () => ipcRenderer.invoke('bridge:get-scan-subnets'),
  verifyBridge: (ip) => ipcRenderer.invoke('bridge:verify', ip),
  startPair: (ip) => ipcRenderer.invoke('bridge:start-pair', ip),
  connectSaved: () => ipcRenderer.invoke('bridge:connect-saved'),
  disconnect: () => ipcRenderer.invoke('bridge:disconnect'),
  bridgeStatus: () => ipcRenderer.invoke('bridge:status'),

  // Lights
  getLights: () => ipcRenderer.invoke('lights:get'),
  setLightOrder: (order) => ipcRenderer.invoke('lights:set-order', order),
  toggleDisabled: (lightId) => ipcRenderer.invoke('lights:toggle-disabled', lightId),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (updates) => ipcRenderer.invoke('settings:save', updates),

  // Art-Net
  startArtnet: () => ipcRenderer.invoke('artnet:start'),
  stopArtnet: () => ipcRenderer.invoke('artnet:stop'),
  artnetStatus: () => ipcRenderer.invoke('artnet:status'),

  // Events from main process
  on: (channel, fn) => {
    const allowed = [
      'bridge:pair-event',
      'bridge:auto-connect',
      'bridge:found',
      'bridge:scan-progress',
      'artnet:dmx-update',
      'artnet:status',
      'sacn:diag',
    ];
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_, ...args) => fn(...args));
  },
  off: (channel, fn) => ipcRenderer.removeListener(channel, fn),
});
