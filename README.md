<img src="build/icon.png" alt="Prism" width="60" align="left" style="margin-right:12px"/>

# Prism

A desktop app that bridges your DMX lighting console to Philips Hue lights over your local network. Send Art-Net or sACN (E1.31) from any console or software and control real Hue bulbs in real time.

![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)
![Protocol](https://img.shields.io/badge/protocol-Art--Net%20%7C%20sACN%20E1.31-blueviolet)

---

## Features

- **Automatic bridge discovery** — finds Hue bridges via ARP cache, SSDP/UPnP multicast, mDNS, portal lookup, and subnet scan. Works even without knowing the bridge's IP address.
- **Art-Net & sACN (E1.31)** — listen on either protocol or both simultaneously. Universe number is configurable.
- **Per-light DMX patch** — assign any light its own DMX start channel and universe number, independent of the global start address and the other lights. Custom-patched channels are highlighted in the UI.
- **Multi-universe support** — lights patched to different universes all receive correctly in a single listener session. Prism joins the right sACN multicast groups automatically.
- **Smooth fade following** — every bridge command includes a transition time that exactly covers the gap to the next update (300 ms), so the bridge interpolates between values instead of snapping. Blackout commands cut instantly; landing ticks after an active fade pin the final value cleanly.
- **Velocity extrapolation** — while a channel is fading Prism projects the natural endpoint and sends one command covering the full remaining fade duration, keeping the bridge perfectly in sync with the console without flooding it with redundant commands.
- **Per-light command rate limiting** — each light is governed by its own independent 500 ms minimum gap, preventing any light from starving others. Keeps the total command rate comfortably below the Hue bridge's ~10 cmd/sec budget.
- **Light management from the app** — scan for new Hue bulbs (opens a 40-second Zigbee inclusion window), rename lights, and delete lights from the bridge, all without leaving Prism.
- **Control tab with presets** — manually set light colors and brightness, save named presets, and recall them instantly.
- **Bitfocus Companion support** — trigger presets from a Stream Deck or any Companion-supported controller.
- **Menu bar / tray app** — lives in the macOS menu bar (or system tray on Windows/Linux). The main window can be closed without stopping the listener. Supports **Launch at Login** for unattended operation.
- **Live Monitor** — per-channel level meters show incoming DMX values in real time with signal status.
- **sACN diagnostics** — if packets arrive on the wrong universe the app tells you exactly what universe it's seeing, and lists all universes currently being watched, so you can match your console.
- **Cross-platform** — macOS, Windows, and Linux.

---

## Download

Pre-built installers are available on the [Releases](https://github.com/YoshiBowman/Prism/releases) page:

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
git clone https://github.com/YoshiBowman/Prism.git
cd Prism
npm install
npm start
```

---

## Building Installers

```bash
npm run build:mac    # → dist/Prism-*.dmg
npm run build:win    # → dist/Prism-*.exe
npm run build:linux  # → dist/Prism-*.AppImage  +  .deb
```

---

## Setup Guide

### 1. Connect to your Hue Bridge

1. Launch Prism and go to the **Bridge** tab.
2. Click **Scan Network** — the app searches via ARP, SSDP, mDNS, portal, and subnet scan automatically.
3. When your bridge appears, click **Connect**.
4. A prompt will appear — **press the round link button on top of your physical Hue Bridge** within 30 seconds.
5. The app pairs and loads your lights.

> If your bridge isn't found, enter its IP address manually in the field at the bottom of the Bridge tab and click **Connect**.

### 2. Configure DMX Channels

1. Go to the **Lights** tab and click **↻ Refresh**.
2. Drag lights into the order you want. By default the first light gets the DMX start address, the next gets start+3, and so on.
3. Use the toggle on each row to enable or disable a light from the DMX mapping.
4. To assign a custom start channel or a different universe to a specific light, click the **⚙** options button on that light's row and enter the channel and/or universe number. Patched fields turn purple so you can see at a glance which lights have overrides.

### 3. Manage Hue Lights

From the **Lights** tab you can also:

- **Find new lights** — click **Find New Lights** to open a 40-second Zigbee inclusion window on the bridge. Any bulbs found appear in the list with an option to rename them before adding.
- **Rename a light** — open the ⚙ options panel and edit the name field, then press ✓. The name updates on the bridge immediately.
- **Delete a light** — open the ⚙ options panel and click **Delete from bridge**. A second click confirms the deletion. The light is removed from the bridge and all Prism mappings.

### 4. Configure the Listener

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

### 5. Configure your Console / Software

Point your DMX console or software at the machine running Prism:

**Art-Net**
- Destination IP: the IP of the machine running Prism (or broadcast `255.255.255.255`)
- Universe: must match the **Art-Net Univ.** setting in the app (default: 0)
- Port: 6454 (standard Art-Net port)

**sACN / E1.31**
- Send to multicast group `239.255.X.Y` where X.Y encodes your universe number, or unicast to the machine's IP
- Universe: must match the **sACN Univ.** setting in the app (default: 1)
- Port: 5568 (standard sACN port)

> **Multi-universe setups:** If you have lights patched to different universes (set in the ⚙ options panel), your console should output all of those universes. Prism joins the correct multicast groups automatically — no extra configuration needed.

### 6. DMX Channel Layout

Each light uses **3 channels** (RGB):

| Offset | Channel | Range |
|--------|---------|-------|
| +0 | Red | 0–255 |
| +1 | Green | 0–255 |
| +2 | Blue | 0–255 |

With the default sequential patch, if your start address is **1**:
- Light 1 → ch 1 (R), 2 (G), 3 (B)
- Light 2 → ch 4 (R), 5 (G), 6 (B)
- Light N → ch (N−1)×3+1 …

Use per-light address overrides (step 2 above) to map any light to any channel on any universe.

### 7. Monitor Incoming DMX

Switch to the **Monitor** tab to see live level meters for every mapped light. The signal bar at the top shows:
- Green pulsing dot — packets are arriving
- Universe and protocol in use
- sACN diagnostic banner if there's a universe mismatch between the console and the app, including the list of universes Prism is currently watching

### 8. Menu Bar Operation (macOS) / System Tray

Prism runs as a menu bar app. Closing the main window does **not** stop the listener — the app keeps running in the background and can be reopened by clicking the tray icon. To stop it completely, use **Quit** in the tray menu.

Enable **Launch at Login** in the tray menu to start Prism automatically at boot, hidden in the menu bar with the listener ready to go.

---

## Bitfocus Companion Integration

Prism runs a local HTTP API on port **38765** that Bitfocus Companion can connect to, giving you Stream Deck buttons for your presets.

> **Note:** The Prism module is not yet in the official Companion module registry. Install it manually as an offline module using the steps below.

### Installing the Companion Module

1. **Download** `companion-module-prism-X.X.X.tgz` from the [Releases](https://github.com/YoshiBowman/Prism/releases) page.
2. **Open Companion** in your browser and go to the **Modules** page.
3. Click **Import module package** and select the `.tgz` file you downloaded.
4. Go to **Connections → Add connection** and search for **Prism**.
5. Set the **Host** to `localhost` (or the IP of the machine running Prism if Companion is on a different machine) and **Port** to `38765`.
6. Click **Save**. Companion will connect and load your presets automatically.

### Available Actions

| Action | Description |
|--------|-------------|
| Apply Preset | Recalls a named preset from the Control tab |
| All Lights Off | Turns off all connected lights |

### Available Feedbacks

| Feedback | Description |
|----------|-------------|
| Preset Is Active | Colors a button when a specific preset is currently active |

---

## Troubleshooting

**Bridge not found during scan**
- Make sure the Hue Bridge is powered on and connected to the same network.
- Try entering the bridge IP manually (find it in the Hue app under Settings → My Hue system → Philips Hue).
- If your machine has multiple network adapters, select the correct one in the **Search via Interface** dropdown.

**Lights not responding to DMX**
- Confirm the listener is running (green dot in the title bar).
- Check the Monitor tab — if bars are moving, DMX is arriving. If not, check console output IP and universe.
- Make sure your console universe matches the app's universe setting (or the per-light universe override if one is set).

**Lights go unreachable after DMX starts**
- Each light is rate-limited to 2 commands/sec to stay within the Hue bridge's capacity. This is intentional — do not disable it unless diagnosing.
- If a light still goes unreachable, check the console output for `[bridge]` error lines, which show HTTP errors and Hue API errors that would otherwise be invisible.

**sACN not receiving**
- Check the Monitor tab for the sACN diagnostic banner — it will tell you what universe is actually arriving and which universes Prism is watching.
- If universe numbers match but still nothing, try switching **sACN Multicast** off (Settings) to use unicast instead.
- Make sure port 5568 UDP is not blocked by a firewall.

**Colors look wrong**
- Hue bulbs use HSB colour space. Prism converts RGB → HSB automatically. Very low values may appear off — try values above 20.
- Some Hue bulbs don't support full RGB (e.g. white-only bulbs). They will respond to brightness via the Blue channel.

**Fades look jumpy instead of smooth**
- Prism sends each command with a 300 ms transition time so the bridge interpolates between updates. If fades still look stepped, confirm you are running the latest version.
- Very fast fades (sub-frame) will always have some quantization — Hue bulbs have a finite update rate regardless of transition time.

---

## License

MIT
