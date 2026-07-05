'use strict';

// Prism — Bitfocus Companion module (source).
// Built to ../main.js with `npm run build` (esbuild bundle). The bundle is
// what ships inside the release tgz; keep this source in sync and rebuild.

const { InstanceBase, InstanceStatus, runEntrypoint, combineRgb } = require('@companion-module/base');
const http = require('http');

const POLL_MS = 2000;

class PrismInstance extends InstanceBase {
	constructor(internal) {
		super(internal);
		this.host = 'localhost';
		this.port = 38765;
		this.pollTimer = null;
		this.presets = [];          // scene names from Prism
		this.activePreset = null;
		this.prismStatus = {        // last /api/status payload highlights
			connected: false,
			bridge: null,
			dmxActive: false,
			listening: false,
			unreachable: 0,
			version: '',
		};
	}

	async init(config) {
		this.host = config.host || 'localhost';
		this.port = parseInt(config.port) || 38765;
		this.updateStatus(InstanceStatus.Connecting);
		this._defined = false;
		this._defineAll();
		this._startPolling();
	}

	async destroy() {
		if (this.pollTimer) clearInterval(this.pollTimer);
	}

	getConfigFields() {
		return [
			{
				type: 'textinput',
				id: 'host',
				label: 'Prism Host',
				default: 'localhost',
				width: 8,
				tooltip: 'IP address or hostname of the machine running Prism',
			},
			{
				type: 'number',
				id: 'port',
				label: 'Prism Port',
				default: 38765,
				min: 1024,
				max: 65535,
				width: 4,
			},
		];
	}

	async configUpdated(config) {
		this.host = config.host || 'localhost';
		this.port = parseInt(config.port) || 38765;
		if (this.pollTimer) clearInterval(this.pollTimer);
		this._startPolling();
	}

	// ── HTTP helpers ────────────────────────────────────────────────────────────
	_get(path) {
		return new Promise((resolve, reject) => {
			const req = http.get({ hostname: this.host, port: this.port, path }, (res) => {
				let data = '';
				res.on('data', (c) => { data += c; });
				res.on('end', () => {
					try { resolve(JSON.parse(data)); }
					catch { reject(new Error('Invalid JSON')); }
				});
			});
			req.on('error', reject);
			req.setTimeout(3000, () => { req.destroy(); reject(new Error('Timeout')); });
		});
	}

	_post(path, body) {
		return new Promise((resolve, reject) => {
			const payload = JSON.stringify(body || {});
			const req = http.request(
				{
					hostname: this.host,
					port: this.port,
					path,
					method: 'POST',
					headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
				},
				(res) => {
					let data = '';
					res.on('data', (c) => { data += c; });
					res.on('end', () => {
						try { resolve(JSON.parse(data)); } catch { resolve({}); }
					});
				}
			);
			req.on('error', reject);
			req.setTimeout(3000, () => { req.destroy(); reject(new Error('Timeout')); });
			req.write(payload);
			req.end();
		});
	}

	// ── Polling ─────────────────────────────────────────────────────────────────
	_startPolling() {
		this._poll();
		this.pollTimer = setInterval(() => this._poll(), POLL_MS);
	}

	async _poll() {
		try {
			const status = await this._get('/api/status');
			this.updateStatus(InstanceStatus.Ok);

			const incoming = Object.keys(status.presets || {});
			const changed  = JSON.stringify(incoming) !== JSON.stringify(this.presets);
			this.presets      = incoming;
			this.activePreset = status.activePreset || null;
			this.prismStatus = {
				connected:   !!status.connected,
				bridge:      status.bridge || null,
				dmxActive:   !!status.dmxActive,
				listening:   !!status.listening,
				unreachable: status.unreachable || 0,
				version:     status.version || '',
			};

			// Always (re)define on the first successful poll, then only when the
			// preset list actually changes — a Prism with zero scenes must still
			// register its actions and feedbacks.
			if (changed || !this._defined) this._defineAll();

			this.setVariableValues({
				bridge:        this.prismStatus.bridge || 'not connected',
				active_preset: this.activePreset || 'none',
				dmx_active:    this.prismStatus.dmxActive ? 'yes' : 'no',
				listening:     this.prismStatus.listening ? 'yes' : 'no',
				unreachable:   this.prismStatus.unreachable,
				preset_count:  this.presets.length,
				prism_version: this.prismStatus.version,
			});
			this.checkFeedbacks('preset_active', 'bridge_connected', 'dmx_active', 'has_unreachable', 'listening');
		} catch {
			this.updateStatus(InstanceStatus.ConnectionFailure, 'Cannot reach Prism');
		}
	}

	// Register all action, feedback, variable, and preset definitions.
	_defineAll() {
		this._updateActions();
		this._updateFeedbacks();
		this._updateVariables();
		this._updatePresets();
		this._defined = true;
	}

	// ── Actions ─────────────────────────────────────────────────────────────────
	_updateActions() {
		const choices = this.presets.map((p) => ({ id: p, label: p }));
		this.setActionDefinitions({
			apply_preset: {
				name: 'Apply Preset',
				options: [
					{
						type: 'dropdown',
						id: 'preset',
						label: 'Preset',
						default: choices[0]?.id ?? '',
						choices,
						allowCustom: true,
					},
				],
				callback: async (action) => {
					try {
						await this._post(`/api/presets/${encodeURIComponent(action.options.preset)}/apply`);
						this.activePreset = action.options.preset;
						this.checkFeedbacks('preset_active');
					} catch (e) {
						this.log('error', `Apply preset failed: ${e.message}`);
					}
				},
			},
			all_off: {
				name: 'All Lights Off',
				options: [],
				callback: async () => {
					try { await this._post('/api/lights/all/off'); }
					catch (e) { this.log('error', `All off failed: ${e.message}`); }
				},
			},
			panic: {
				name: 'PANIC — Instant Blackout',
				description: 'One group command to the bridge: every light off with zero transition',
				options: [],
				callback: async () => {
					try { await this._post('/api/panic'); }
					catch (e) { this.log('error', `Panic failed: ${e.message}`); }
				},
			},
		});
	}

	// ── Feedbacks ───────────────────────────────────────────────────────────────
	_updateFeedbacks() {
		const choices = this.presets.map((p) => ({ id: p, label: p }));
		this.setFeedbackDefinitions({
			preset_active: {
				name: 'Preset Is Active',
				type: 'boolean',
				defaultStyle: { bgcolor: combineRgb(102, 0, 204), color: combineRgb(255, 255, 255) },
				options: [
					{
						type: 'dropdown',
						id: 'preset',
						label: 'Preset',
						default: choices[0]?.id ?? '',
						choices,
						allowCustom: true,
					},
				],
				callback: (feedback) => this.activePreset === feedback.options.preset,
			},
			bridge_connected: {
				name: 'Prism Connected To Bridge',
				type: 'boolean',
				defaultStyle: { bgcolor: combineRgb(0, 102, 0), color: combineRgb(255, 255, 255) },
				options: [],
				callback: () => this.prismStatus.connected,
			},
			listening: {
				name: 'DMX Listener Running',
				type: 'boolean',
				defaultStyle: { bgcolor: combineRgb(0, 82, 153), color: combineRgb(255, 255, 255) },
				options: [],
				callback: () => this.prismStatus.listening,
			},
			dmx_active: {
				name: 'DMX Signal Active',
				type: 'boolean',
				defaultStyle: { bgcolor: combineRgb(153, 102, 0), color: combineRgb(255, 255, 255) },
				options: [],
				callback: () => this.prismStatus.dmxActive,
			},
			has_unreachable: {
				name: 'Any Bulb Unreachable',
				type: 'boolean',
				defaultStyle: { bgcolor: combineRgb(153, 0, 0), color: combineRgb(255, 255, 255) },
				options: [],
				callback: () => this.prismStatus.unreachable > 0,
			},
		});
	}

	// ── Variables ───────────────────────────────────────────────────────────────
	_updateVariables() {
		this.setVariableDefinitions([
			{ variableId: 'bridge',        name: 'Bridge IP' },
			{ variableId: 'active_preset', name: 'Active preset' },
			{ variableId: 'dmx_active',    name: 'DMX signal active (yes/no)' },
			{ variableId: 'listening',     name: 'DMX listener running (yes/no)' },
			{ variableId: 'unreachable',   name: 'Unreachable bulb count' },
			{ variableId: 'preset_count',  name: 'Number of presets' },
			{ variableId: 'prism_version', name: 'Prism version' },
		]);
	}

	// ── Preset buttons ──────────────────────────────────────────────────────────
	_updatePresets() {
		const presetDefs = this.presets.map((name) => ({
			category: 'Presets',
			name,
			type: 'button',
			style: { text: name, size: 'auto', color: combineRgb(255, 255, 255), bgcolor: combineRgb(102, 0, 204) },
			feedbacks: [
				{
					feedbackId: 'preset_active',
					options: { preset: name },
					style: { bgcolor: combineRgb(170, 68, 255), color: combineRgb(255, 255, 255) },
				},
			],
			steps: [{ down: [{ actionId: 'apply_preset', options: { preset: name } }], up: [] }],
		}));

		presetDefs.push({
			category: 'Controls',
			name: 'All Off',
			type: 'button',
			style: { text: 'All Off', size: 'auto', color: combineRgb(255, 255, 255), bgcolor: combineRgb(51, 0, 0) },
			feedbacks: [],
			steps: [{ down: [{ actionId: 'all_off', options: {} }], up: [] }],
		});
		presetDefs.push({
			category: 'Controls',
			name: 'PANIC',
			type: 'button',
			style: { text: 'PANIC', size: '18', color: combineRgb(255, 255, 255), bgcolor: combineRgb(153, 0, 0) },
			feedbacks: [],
			steps: [{ down: [{ actionId: 'panic', options: {} }], up: [] }],
		});
		presetDefs.push({
			category: 'Status',
			name: 'Bridge Status',
			type: 'button',
			style: { text: 'Bridge\\n$(prism:bridge)', size: 'auto', color: combineRgb(255, 255, 255), bgcolor: combineRgb(26, 26, 26) },
			feedbacks: [
				{ feedbackId: 'bridge_connected', options: {}, style: { bgcolor: combineRgb(0, 102, 0) } },
				{ feedbackId: 'has_unreachable', options: {}, style: { bgcolor: combineRgb(153, 0, 0), text: 'UNREACH\\n$(prism:unreachable)' } },
			],
			steps: [{ down: [], up: [] }],
		});

		this.setPresetDefinitions(presetDefs);
	}
}

runEntrypoint(PrismInstance, []);
