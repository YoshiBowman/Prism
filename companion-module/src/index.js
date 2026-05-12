'use strict';

const { InstanceBase, InstanceStatus, runEntrypoint } = require('@companion-module/base');
const http = require('http');

class PrismInstance extends InstanceBase {
  constructor(internal) {
    super(internal);
    this._host = 'localhost';
    this._port = 38765;
    this._pollTimer = null;
    this._presets = [];
  }

  async init(config) {
    this._host = config.host || 'localhost';
    this._port = parseInt(config.port) || 38765;
    this.updateStatus(InstanceStatus.Connecting);
    this._setupActions();
    this._setupFeedbacks();
    this._startPolling();
  }

  async destroy() {
    if (this._pollTimer) clearInterval(this._pollTimer);
  }

  getConfigFields() {
    return [
      {
        type: 'textinput',
        id: 'host',
        label: 'Prism Host',
        default: 'localhost',
        width: 8,
      },
      {
        type: 'number',
        id: 'port',
        label: 'Prism HTTP Port',
        default: 38765,
        min: 1024,
        max: 65535,
        width: 4,
      },
    ];
  }

  async configUpdated(config) {
    this._host = config.host || 'localhost';
    this._port = parseInt(config.port) || 38765;
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._startPolling();
  }

  // ── HTTP helpers ─────────────────────────────────────────────────────────────

  _apiGet(path) {
    return new Promise((resolve, reject) => {
      const req = http.get({ hostname: this._host, port: this._port, path }, (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { reject(new Error('Bad JSON')); }
        });
      });
      req.on('error', reject);
      req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
    });
  }

  _apiPost(path, body = {}) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          hostname: this._host, port: this._port, path,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        },
        (res) => {
          let data = '';
          res.on('data', c => { data += c; });
          res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
        }
      );
      req.on('error', reject);
      req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
      req.write(payload);
      req.end();
    });
  }

  // ── Polling ──────────────────────────────────────────────────────────────────

  _startPolling() {
    this._poll();
    this._pollTimer = setInterval(() => this._poll(), 5000);
  }

  async _poll() {
    try {
      const status = await this._apiGet('/api/status');
      this.updateStatus(InstanceStatus.Ok);
      const presetNames = Object.keys(status.presets || {});
      if (JSON.stringify(presetNames) !== JSON.stringify(this._presets)) {
        this._presets = presetNames;
        this._setupActions();
        this._setupFeedbacks();
      }
      this.checkFeedbacks('preset_active');
    } catch {
      this.updateStatus(InstanceStatus.ConnectionFailure, 'Cannot reach Prism');
    }
  }

  // ── Actions ──────────────────────────────────────────────────────────────────

  _setupActions() {
    const presetChoices = this._presets.map(p => ({ id: p, label: p }));

    this.setActionDefinitions({
      apply_preset: {
        name: 'Apply Preset',
        options: [
          {
            type: 'dropdown',
            id: 'preset',
            label: 'Preset',
            default: presetChoices[0]?.id || '',
            choices: presetChoices,
            allowCustom: true,
          },
        ],
        callback: async (action) => {
          try {
            await this._apiPost(`/api/presets/${encodeURIComponent(action.options.preset)}/apply`);
          } catch (e) {
            this.log('error', `Failed to apply preset: ${e.message}`);
          }
        },
      },

      set_light: {
        name: 'Set Light Color',
        options: [
          { type: 'textinput', id: 'lightId', label: 'Light ID', default: '1' },
          { type: 'colorpicker', id: 'color', label: 'Color', default: 0xffffff },
          { type: 'number', id: 'bri', label: 'Brightness %', default: 100, min: 0, max: 100 },
        ],
        callback: async (action) => {
          const rgb = action.options.color;
          const r = (rgb >> 16) & 0xff;
          const g = (rgb >> 8)  & 0xff;
          const b =  rgb        & 0xff;
          try {
            await this._apiPost(`/api/lights/${action.options.lightId}/state`, {
              r, g, b, bri: action.options.bri,
            });
          } catch (e) {
            this.log('error', `Failed to set light: ${e.message}`);
          }
        },
      },

      all_off: {
        name: 'All Lights Off',
        options: [],
        callback: async () => {
          try { await this._apiPost('/api/lights/all/off'); } catch {}
        },
      },
    });
  }

  // ── Feedbacks ────────────────────────────────────────────────────────────────

  _setupFeedbacks() {
    const presetChoices = this._presets.map(p => ({ id: p, label: p }));

    this.setFeedbackDefinitions({
      preset_active: {
        name: 'Preset Is Active',
        type: 'boolean',
        defaultStyle: { bgcolor: 0x6600cc, color: 0xffffff },
        options: [
          {
            type: 'dropdown',
            id: 'preset',
            label: 'Preset',
            default: presetChoices[0]?.id || '',
            choices: presetChoices,
            allowCustom: true,
          },
        ],
        callback: async (feedback) => {
          try {
            const status = await this._apiGet('/api/status');
            return status.activePreset === feedback.options.preset;
          } catch { return false; }
        },
      },
    });
  }
}

runEntrypoint(PrismInstance, []);
