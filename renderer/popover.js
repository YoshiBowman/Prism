'use strict';

const dot          = document.getElementById('status-dot');
const statusText   = document.getElementById('status-text');
const protocolHint = document.getElementById('protocol-hint');
const btnStart     = document.getElementById('btn-start');
const btnStop      = document.getElementById('btn-stop');
const btnOpen      = document.getElementById('btn-open');
const btnQuit      = document.getElementById('btn-quit');

// ── Helpers ───────────────────────────────────────────────────────────────────

function protocolLabel(protocol) {
  if (protocol === 'sacn')  return 'sACN';
  if (protocol === 'both')  return 'Art-Net + sACN';
  return 'Art-Net';
}

function buildHint(settings, running) {
  const proto = settings.protocol || 'artnet';
  const label = protocolLabel(proto);
  if (proto === 'artnet') return `${label}  ·  Universe ${settings.universe ?? 0}`;
  if (proto === 'sacn')   return `${label}  ·  Universe ${settings.sacnUniverse ?? 1}`;
  return `${label}  ·  ${settings.universe ?? 0} / ${settings.sacnUniverse ?? 1}`;
}

// ── Status update ─────────────────────────────────────────────────────────────

let cachedSettings = {};

function applyStatus({ running }) {
  dot.className = running ? 'dot running' : 'dot';
  statusText.textContent = running ? 'DMX Active' : 'Stopped';
  btnStart.disabled = !!running;
  btnStop.disabled  = !running;
}

// ── Init ──────────────────────────────────────────────────────────────────────

(async () => {
  const [status, settings] = await Promise.all([
    window.hue.artnetStatus(),
    window.hue.getSettings(),
  ]);
  cachedSettings = settings;
  applyStatus(status);
  protocolHint.textContent = buildHint(settings);
})();

// ── Live updates from main ────────────────────────────────────────────────────

window.hue.on('artnet:status', (status) => {
  applyStatus(status);
});

// ── Button handlers ───────────────────────────────────────────────────────────

btnStart.addEventListener('click', async () => {
  btnStart.disabled = true;
  await window.hue.startArtnet();
});

btnStop.addEventListener('click', async () => {
  btnStop.disabled = true;
  await window.hue.stopArtnet();
});

btnOpen.addEventListener('click', () => {
  window.hue.openMainWindow();
  // Popover auto-hides on blur when main window takes focus
});

btnQuit.addEventListener('click', () => {
  window.hue.quit();
});
