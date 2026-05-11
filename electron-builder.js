'use strict';

module.exports = {
  appId:       'com.dmxhue.app',
  productName: 'DMX-HUE',
  copyright:   'Copyright © 2025',

  directories: { output: 'dist' },

  files: [
    'main.js',
    'preload.js',
    'renderer/**/*',
    'package.json',
    'node_modules/**/*',
  ],

  mac: {
    category:            'public.app-category.utilities',
    hardenedRuntime:     true,
    gatekeeperAssess:    false,
    entitlements:        'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    icon:                'build/icon.icns',
    extendInfo: {
      NSLocalNetworkUsageDescription: 'DMX-HUE needs local network access to discover and control Philips Hue bridges and receive Art-Net / sACN DMX data.',
      NSBonjourServices: ['_hue._tcp', '_ssdp._udp'],
    },
    notarize: process.env.APPLE_TEAM_ID
      ? { teamId: process.env.APPLE_TEAM_ID }
      : false,
    target: [
      { target: 'dmg', arch: ['x64', 'arm64'] },
      { target: 'zip', arch: ['x64', 'arm64'] },
    ],
  },

  win: {
    icon:   'build/icon.ico',
    target: [{ target: 'nsis', arch: ['x64'] }],
  },

  linux: {
    icon:     'build/icon.png',
    category: 'AudioVideo',
    target: [
      { target: 'AppImage', arch: ['x64'] },
      { target: 'deb',      arch: ['x64'] },
    ],
  },

  nsis: {
    oneClick:                        false,
    allowToChangeInstallationDirectory: true,
  },

  publish: {
    provider: 'github',
    owner:    'YoshiBowman',
    repo:     'DMX-Hue',
  },
};
