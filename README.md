# DMX-HUE

A desktop app that bridges your DMX lighting console to Philips Hue lights over your local network. Send Art-Net or sACN (E1.31) from any console or software and control real Hue bulbs in real time.

![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)
![Protocol](https://img.shields.io/badge/protocol-Art--Net%20%7C%20sACN%20E1.31-blueviolet)

---

## Features

- **Automatic bridge discovery** — finds Hue bridges via ARP cache, SSDP/UPnP multicast, mDNS, and subnet scan. Works even without knowing the bridge's IP address.
- **Art-Net & sACN (E1.31)** — listen on either protocol or both simultaneously. Universe number is configurable.
- **Per-light DMX mapping** — drag to reorder lights, set the DMX start address, enable/disable individual lights.
- **White / CT mode** — optional 5-channel mode adds Color Temperature and Brightness channels per light.
- **Color Loop** — trigger a color cycle effect when RGB = 1, 1, 1.
- **Live Monitor** — per-channel level meters show incoming DMX values in real time with signal status.
- **sACN diagnostics** — if packets arrive on the wrong universe the app tells you exactly what universe it's seeing so you can match your console.
- **Cross-platform** — macOS, Windows, and Linux.

---

## Download

Pre-built installers are available on the [Releases](https://github.com/YoshiBowman/DMX-Hue/releases) page:

| Platform | File |
|----------|------|
| macOS (Apple Silicon + Intel) | `.dmg` |
| Windows | `.exe` (NSIS installer) |
| Linux | `.AppImage` or `.deb` |

---

## Running from Source

### Requirements

- [Node.js](https://nodejs.org) v18 or later
- npm (comes with Node.js)

### Setup

```bash
git clone https://github.com/YoshiBowman/DMX-Hue.git
cd DMX-Hue
npm install
npm start
```

---

## Building Installers

```bash
npm run build:mac    # → dist/DMX-HUE-*.dmg
npm run build:win    # → dist/DMX-HUE-*.exe
npm run build:linux  # → dist/DMX-HUE-*.AppImage  +  .deb
```

> **Note:** Building the Windows installer on macOS requires [Wine](https://www.winehq.org). It's easiest to build on the target platform or use a CI service.

---

## Setup Guide

### 1. Connect to your Hue Bridge

1. Launch DMX-HUE and go to the **Bridge** tab.
2. Click **Scan Network** — the app searches via ARP, SSDP, mDNS, and subnet scan automatically.
3. When your bridge appears, click **Connect**.
4. A prompt will appear — **press the round link button on top of your physical Hue Bridge** within 30 seconds.
5. The app pairs and loads your lights.

> If your bridge isn't found, enter its IP address manually in the field at the bottom of the Bridge tab and click **Connect**.

### 2. Configure DMX Channels

1. Go to the **Lights** tab and click **↻ Refresh**.
2. Drag lights into the order you want. The first light gets the DMX start address, the next gets start+3, etc.
3. Use the toggle on each row to enable or disable a light from the DMX mapping.

### 3. Configure the Listener

Use the **listener bar** at the top of the app (always visible):

| Control | Description |
|---------|-------------|
| Protocol | `Art-Net`, `sACN (E1.31)`, or `Both` |
| Art-Net Univ. | Art-Net universe number (default: 0) |
| sACN Univ. | sACN universe number (default: 1) |
| ▶ Start | Start listening for DMX packets |
| ■ Stop | Stop the listener |

Click **▶ Start** — the badge in the title bar turns green when packets are being received.

Additional options (bind interface, DMX start address, transition time) are in the **Settings** tab.

### 4. Configure your Console / Software

Point your DMX console or software at the machine running DMX-HUE:

**Art-Net**
- Destination IP: the IP of the machine running DMX-HUE (or broadcast `255.255.255.255`)
- Universe: must match the **Art-Net Univ.** setting in the app (default: 0)
- Port: 6454 (standard Art-Net port)

**sACN / E1.31**
- Send to multicast group `239.255.X.Y` where X.Y encodes your universe number, or unicast to the machine's IP
- Universe: must match the **sACN Univ.** setting in the app (default: 1)
- Port: 5568 (standard sACN port)

### 5. DMX Channel Layout

Each light uses **3 channels** (RGB) by default:

| Offset | Channel | Range |
|--------|---------|-------|
| +0 | Red | 0–255 |
| +1 | Green | 0–255 |
| +2 | Blue | 0–255 |

With **White / CT Mode** enabled (Settings → Features), each light uses **5 channels**:

| Offset | Channel | Range |
|--------|---------|-------|
| +0 | Red | 0–255 |
| +1 | Green | 0–255 |
| +2 | Blue | 0–255 |
| +3 | Color Temperature | 0 (warm) – 255 (cool) |
| +4 | Brightness | 0–255 |

> When RGB = 0,0,0 and CT mode is active, the light switches to white CT mode using channels +3 and +4.

### 6. Monitor Incoming DMX

Switch to the **Monitor** tab to see live level meters for every mapped light. The signal bar at the top shows:
- Green pulsing dot — packets are arriving
- Universe and protocol in use
- sACN diagnostic banner if there's a universe mismatch between the console and the app

---

## Troubleshooting

**Bridge not found during scan**
- Make sure the Hue Bridge is powered on and connected to the same network.
- Try entering the bridge IP manually (find it in the Hue app under Settings → My Hue system → Philips Hue).
- If your machine has multiple network adapters, select the correct one in the **Search via Interface** dropdown.

**Lights not responding to DMX**
- Confirm the listener is running (green dot in the title bar).
- Check the Monitor tab — if bars are moving, DMX is arriving. If not, check console output IP and universe.
- Make sure your console universe matches the app's universe setting.

**sACN not receiving**
- Check the Monitor tab for the sACN diagnostic banner — it will tell you what universe is actually arriving.
- If universe numbers match but still nothing, try switching **sACN Multicast** off (Settings) to use unicast instead.
- Make sure port 5568 UDP is not blocked by a firewall.

**Colors look wrong**
- Hue bulbs use HSB colour space. The app converts RGB → HSB automatically. Very low values may appear off — try values above 20.
- Some Hue bulbs don't support full RGB (e.g. white-only bulbs). They will respond to brightness via the Blue channel.

---

## License

MIT
