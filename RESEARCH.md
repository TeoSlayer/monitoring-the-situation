# Hackathon Research — Radio & WiFi Sensing Agent

## Overview
Building an autonomous agent that perceives the world through radio signals — no APIs, no internet needed. Using a Mac's built-in WiFi/BT radio + RTL-SDR dongle(s) in San Francisco.

---

## 1. WiFi Sensing (Built-in Mac Radio)

### What Works (CoreWLAN + PyObjC)
- **Requires**: `pyobjc-framework-CoreWLAN`, `pyobjc-framework-CoreLocation`
- **Location Services must be enabled** for Terminal to see SSIDs/BSSIDs
  - Run `request_location.py` to trigger the macOS permission dialog
  - System Settings > Privacy & Security > Location Services > enable for Terminal

### Interface Data (no scan needed)
| Field | Example Value | Notes |
|---|---|---|
| RSSI | -54 dBm | Current connection signal strength |
| Noise floor | -99 dBm | Ambient noise |
| TX rate | 286.0 Mbps | Current throughput |
| TX power | 1496 mW | Transmit power |
| Channel | 108 (5GHz, 20MHz) | Current channel |
| MAC address | a0:9a:8e:3e:01:f1 | Interface hardware address |
| Supported channels | 88 channels | 2.4GHz + 5GHz + 6GHz |
| PHY mode | 6 (802.11ax) | Active radio mode |

### Network Scanning
- **77-81 networks visible** per scan in our test location (SF office)
- Each network provides: SSID, BSSID, RSSI, noise, channel, band, width, beacon interval, security mode
- **Repeated scans**: need ~5s cooldown between scans or you get "Resource busy" error
- 3rd consecutive scan often fails — safe to do 2 per cycle
- **RSSI variance** across scans can indicate motion/environmental changes

### Notable Networks Seen
- boku-corp (channels 44, 149, 157) — strongest at -47 dBm
- boku-sf-guest (channels 44, 149, 157)
- WorkOS-Guest (channel 108) — our connection
- Suite226, SFSolaN, SFSola (channel 36)
- Multiple APs per SSID = good for triangulation

### Limitations
- `airport` CLI utility **removed** on current macOS (Sequoia+)
- `system_profiler SPAirPortDataType` shows networks but redacts names even with Location Services
- CoreWLAN scan "Resource busy" on rapid successive scans
- Monitor mode (probe request capture) disconnects WiFi during capture

---

## 2. Device Discovery (No External Hardware)

### ARP Table
- **131 devices** found on the 10.104.0.0/16 office network
- All with MAC addresses and IPs
- Hostnames mostly unresolved — could do MAC vendor lookups

### Bluetooth
Found paired/known devices via `system_profiler SPBluetoothDataType`:
- Alex's AirPods Pro (70:8C:F2:EE:B7:F0) — firmware 8B28, serial numbers
- Calin's AirPods Pro (F0:5C:D5:32:BF:30)
- Calin's Apple Watch (58:55:95:4A:CB:60)
- Catalina's AirPods (B8:5D:0A:17:2C:08)
- Cristina's AirPods Pro (34:31:8F:0B:F8:33)
- CURIO 2-354801H (00:1B:41:CB:D6:6F) — Desktop Computer
- Delia's AirPods (00:8A:76:3F:2C:EB)
- DualSense Wireless Controller (A0:FA:9C:C3:04:2A)
- BT chipset: BCM_4388C2, PCIe transport

### AWDL (AirDrop)
- awdl0 interface is active
- Can detect AirDrop-capable peers

### Bonjour/mDNS
- Returned 0 results in our test — dns-sd needs longer runtime or network blocks mDNS
- Services to scan: _airplay._tcp, _raop._tcp, _homekit._tcp, _googlecast._tcp, etc.

### Probe Request Scanning (Monitor Mode)
- Script: `probe_scanner.py`
- Requires `sudo` — puts WiFi into monitor mode
- Catches devices actively scanning for WiFi networks
- Reveals: source MAC, vendor, requested SSIDs
- **Disconnects WiFi** during capture (reconnects when done)
- Best on channel 6 (2.4GHz) for widest device coverage

---

## 3. RTL-SDR — Radio Frequencies in SF

### Required Hardware
- RTL-SDR dongle (~$25) — frequency range 24 MHz to 1.766 GHz
- One dongle = one frequency at a time
- Two dongles ($50) = simultaneous monitoring of two bands

### Decodable Data Signals

| Signal | Frequency | Decoder | What You Get |
|---|---|---|---|
| **ISM IoT** | 433 / 915 MHz | `rtl_433` | Weather stations, TPMS (car tire sensors = traffic proxy), door sensors, smart home devices |
| **ADS-B** | 1090 MHz | `dump1090` | Aircraft position, speed, altitude, callsign (SFO/OAK/SJC) |
| **AIS** | 161.975 / 162.025 MHz | `rtl_ais` | Ship position, name, cargo, destination (SF Bay) |
| **ACARS** | 129.125 MHz | `acarsdec` | Aircraft operational text messages |
| **Pagers (POCSAG/FLEX)** | 152-158 / 929 MHz | `multimon-ng` | Hospital/restaurant plaintext pages |
| **APRS** | 144.39 MHz | `direwolf` | Amateur radio position/telemetry beacons |
| **NOAA satellite** | 137 MHz | `noaa-apt` | Weather imagery of Pacific coast (~15 min per pass) |

### Voice Communications (Listenable)

| Signal | Frequency | Mode | Notes |
|---|---|---|---|
| **Aviation ATC** | 118-136 MHz | AM | SFO Tower (120.5), NorCal Approach (135.65), Ground (121.8), ATIS (113.7) |
| **Marine VHF** | 156-162 MHz | FM | Coast Guard Ch16 (156.8), SF Bay vessel traffic |
| **FRS/GMRS** | 462-467 MHz | FM | Walkie-talkies nearby |
| **MURS** | 151-154 MHz | FM | Business band, security |
| **Railroad** | 160-162 MHz | FM | Caltrain, freight |
| **Amateur 2m** | 144-148 MHz | FM | Bay Area ham repeaters |
| **Amateur 70cm** | 420-450 MHz | FM | Bay Area ham repeaters |
| **NOAA Weather** | 162.475 MHz | FM | Automated local forecast |

### Legality
- **All reception is legal** in California
- Only restriction: CA Penal Code 636.5 — illegal to use scanner to aid in committing a crime
- Passive listening at a hackathon = completely legal

---

## 4. San Francisco Public Safety Radio — CCSF P25 Trunked System

**Source**: [RadioReference SF P25](https://www.radioreference.com/db/sid/6758)

### System Overview
- P25 Phase II trunked system
- Operated by City and County of San Francisco (CCSF)
- Decodable with RTL-SDR + `trunk-recorder` or `op25`

### Encryption Status by Agency

#### SFPD (Police) — PARTIALLY ENCRYPTED
- **Dispatch is partially in the clear** — dispatcher transmits incident type, address, unit assignments unencrypted
- Field unit responses (officer radio traffic) are encrypted
- Talkgroups 804-818 (A1-A8): Mixed encryption
- Talkgroups 820-829 (A9-A14): Mixed encryption
- **Mutual Aid talkgroups 835-889: ALL UNENCRYPTED**

#### SFFD (Fire) — ALL UNENCRYPTED
- Talkgroups 925-955: Control, Tactical A1-A16 — **all clear/unencrypted**
- Talkgroups 959-985: EMS, Support — **all clear/unencrypted**
- Talkgroups 36101-36116: Training — digital, possibly encrypted

#### EMS — MOSTLY UNENCRYPTED
- Talkgroups 961-962: EMS Tac 1-2 — **unencrypted**
- Talkgroup 36117: EMS Alt Dispatch — digital

### SF Fire Frequencies (Conventional)
- F1: 488.3625 MHz — Division 1 (downtown)
- F2: 488.5625 MHz — Division 2 (northwest)
- F3: 488.7625 MHz — Division 3 (northeast, southwest)
- F4: 489.1625 MHz — Primary fireground
- F5: 489.1875 MHz — Arson squad, admin, secondary fireground
- F6: 489.1125 MHz — Citywide emergency

### Key Insight for Agent
Even on encrypted channels, **P25 control channel is always in the clear** and reveals:
- Which talkgroups are active (unit/group keying up)
- Timing and frequency of transmissions
- Activity spikes = something happening
- Unit IDs (which radios are transmitting)

An agent can detect "SFPD radio activity spiked 5x in the Mission" without hearing content.

---

## 5. Agent Architecture — "Radio Oracle"

```
┌─────────────────────────────────────────────┐
│              Radio Oracle Agent              │
├─────────────┬───────────────────────────────┤
│ 433 MHz     │ Weather, TPMS traffic flow,   │
│ (ISM)       │ IoT sensor grid               │
├─────────────┼───────────────────────────────┤
│ 162 MHz     │ Ship positions, bay traffic   │
│ (AIS)       │                               │
├─────────────┼───────────────────────────────┤
│ 1090 MHz    │ Aircraft positions, altitude  │
│ (ADS-B)     │                               │
├─────────────┼───────────────────────────────┤
│ P25 trunked │ Fire/EMS dispatch audio,      │
│ (UHF)       │ police dispatch, activity     │
├─────────────┼───────────────────────────────┤
│ 118-136 MHz │ ATC voice (speech-to-text)    │
│ (Air band)  │                               │
├─────────────┼───────────────────────────────┤
│ WiFi/BT     │ People density, device count, │
│ (built-in)  │ AP fingerprinting             │
├─────────────┴───────────────────────────────┤
│         LLM fuses all signals into          │
│      situational awareness + answers        │
│                                             │
│  "What's happening in the city right now?"  │
│  "Is the bay busy?" "SFO delays likely?"    │
│  "Any fire activity in SoMa?"               │
└─────────────────────────────────────────────┘
```

### Software Stack
- `rtl_433` — ISM band IoT decoding (dozens of protocols, zero config)
- `dump1090` — ADS-B aircraft decoding
- `rtl_ais` — AIS ship decoding
- `trunk-recorder` or `op25` — P25 trunked system decoding
- `acarsdec` — ACARS aircraft messages
- `multimon-ng` — pager decoding
- Whisper — speech-to-text for voice channels
- Python + scapy — WiFi probe request parsing
- CoreWLAN (PyObjC) — WiFi AP scanning

### Priority Order for Implementation
1. `rtl_433` (433 MHz) — most immediate payoff, dozens of streams
2. P25 trunk (SFFD/dispatch) — most compelling demo
3. AIS (162 MHz) — SF-specific, visual
4. ADS-B (1090 MHz) — lots of data
5. Air band voice + STT — wow factor

---

## 6. Scripts Created

| File | Purpose |
|---|---|
| `wifi_explore.py` | v1 — basic CoreWLAN scan (all networks show as hidden without location perms) |
| `wifi_explore_v2.py` | v2 — multi-source: CoreWLAN + airport + system_profiler + networksetup + repeated scan |
| `request_location.py` | Triggers macOS Location Services permission dialog for Terminal/python3 |
| `find_devices.py` | Device discovery: ARP table, Bonjour/mDNS, ping sweep, Bluetooth, AWDL |
| `probe_scanner.py` | Monitor mode probe request capture (requires sudo, disconnects WiFi) |

### Dependencies Installed
```
pip3 install pyobjc-framework-CoreWLAN pyobjc-framework-CoreLocation scapy
```

---

## 7. Environment Notes
- Mac: MacBook Air M-series
- macOS: Sequoia+ (Darwin 25.3.0)
- Python: 3.13.7
- WiFi chipset: Broadcom (supports monitor mode)
- BT chipset: BCM_4388C2 (PCIe)
- `airport` CLI utility: **REMOVED** in this macOS version
- Network: 10.104.0.0/16 (WorkOS-Guest, DHCP)
- Connected AP BSSID: a6:80:94:c0:c5:95, channel 108 (5GHz)
