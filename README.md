# Monitoring the Situation

Real-time situational awareness dashboard for San Francisco. Fuses P25 trunked radio, aircraft ADS-B, fire/police dispatch, Muni transit, and traffic data into a single live map with LLM-powered analysis.

Built at a hackathon with a MacBook Air, an RTL-SDR dongle, and a window facing the city.

## Architecture

```
Browser (Vite + Mapbox GL + Deck.gl)
        │
        │ WebSocket :8765
        ▼
Python Backend (asyncio + aiohttp)
   ├── trunk-recorder ──► P25 radio → faster-whisper transcription
   ├── Airplanes.live  ──► ADS-B aircraft positions
   ├── FlightRadar24   ──► Military / helicopter / bizjet classification
   ├── DataSF SODA     ──► Fire + police dispatch calls
   ├── Nexla SDK       ──► Data integration platform for 511 traffic/transit feeds
   ├── 511 SF Bay      ──► Muni vehicles + work zones + traffic events
   ├── Gemini Flash    ──► Enrichment, incident analysis, ORACLE chat
   ├── OpenSearch (DO) ──► Persistence + historical queries (DigitalOcean managed)
   └── Telegram Bot    ──► Push alerts for critical incidents + query interface
```

## Data Sources

| Source | What it provides | Update interval |
|--------|-----------------|-----------------|
| **trunk-recorder** (RTL-SDR) | P25 radio transmissions — SFFD, SFPD dispatch, EMS, mutual aid | 1s file poll |
| **faster-whisper** | Speech-to-text transcription of radio audio | Async per call |
| **Airplanes.live** | All aircraft ADS-B positions within 125nm | 10s |
| **FlightRadar24** | Military, police, helicopter, bizjet classification | 30s |
| **DataSF Fire Dispatch** | Fire/EMS calls with address, type, priority, units | 30s |
| **DataSF Police Dispatch** | Police incidents with disposition and coordinates | 30s |
| **Nexla** | Data integration platform — normalizes and routes 511 transit/traffic feeds | Pipeline |
| **511 SF Bay** (via Nexla) | Muni vehicle positions, work zones, traffic events | 15s |
| **Google Gemini** | Situation enrichment, incident summaries, ORACLE Q&A | 5s cycle |
| **OpenSearch** (DigitalOcean) | Historical transcript/enrichment/incident persistence | On ingest |
| **Telegram Bot** | Push alerts for critical/high-severity incidents, query interface | Real-time |

## Map Layers

- **Aircraft** — colored by class (military red, police yellow, helicopter cyan, bizjet purple) with flight trails
- **Dispatch** — fire/medical/police incidents with emoji icons, click for details
- **Radio Incidents** — geocoded P25 transmissions with severity glow rings
- **Traffic & Transit** — Muni vehicles (colored by line), work zones (orange dashed), traffic events

All layers togglable from the sidebar.

## Dashboard Features

- Live radio transcript feed with search and talkgroup filtering
- Channel monitor table showing all active P25 talkgroups
- Incident panel with Gemini-enriched analysis
- ORACLE chat — ask natural language questions about the current situation
- SDR signal stats and frequency activity plot
- Telegram integration — critical incident push alerts and remote query bot
- REST API on :8766 for external integrations

## Prerequisites

```bash
brew install cmake gnuradio rtl-sdr uhd libcurl boost openssl
pip3 install aiohttp websockets python-dotenv requests faster-whisper google-genai
```

Optional:
```bash
pip3 install opensearch-py nexla-sdk python-telegram-bot
```

## Setup

1. **Build trunk-recorder** (one time):
```bash
cd trunk-recorder/build
cmake ..
make -j$(sysctl -n hw.ncpu)
```

2. **Install frontend dependencies** (one time):
```bash
cd dashboard
npm install
```

3. **Configure environment** — create `dashboard/backend/.env`:
```
GEMINI_API_KEY=your-google-ai-key
API_511_KEY=your-511-api-key
TELEGRAM_BOT_TOKEN=your-telegram-bot-token
TELEGRAM_CHAT_ID=your-chat-id
```

The Mapbox token is in `dashboard/src/config.js`. FR24 and Airplanes.live tokens are embedded in the backend.

## Run

Start the backend (launches trunk-recorder + all polling + WebSocket server):
```bash
cd dashboard/backend
python3 server.py
```

Start the frontend dev server:
```bash
cd dashboard
npm run dev
```

Open `http://localhost:5173`.

## Project Structure

```
.
├── dashboard/
│   ├── src/
│   │   ├── main.js              # App entry — map setup, WS handlers, layer wiring
│   │   ├── radio.js             # Radio transcript state, filtering, rendering
│   │   ├── chat.js              # ORACLE chat panel (Gemini-powered)
│   │   ├── ws.js                # WebSocket client
│   │   ├── config.js            # API tokens, map center, poll intervals
│   │   ├── emojiIcons.js        # Canvas-rendered emoji for Mapbox symbol layers
│   │   ├── freqplot.js          # Frequency activity sparkline
│   │   ├── style.css            # All styles
│   │   ├── layers/
│   │   │   ├── AircraftLayer.js
│   │   │   ├── DispatchLayer.js
│   │   │   ├── RadioIncidentLayer.js
│   │   │   └── TrafficTransitLayer.js
│   │   └── world/
│   │       ├── WorldState.js    # Global event bus + spatial index
│   │       └── DataLayer.js     # Base class for all map layers
│   ├── backend/
│   │   ├── server.py            # Main backend — polling, transcription, enrichment, WS + REST API
│   │   └── nexla_feeds.py       # 511 traffic/transit data via Nexla SDK
│   ├── index.html
│   ├── vite.config.js
│   └── package.json
├── trunk-recorder/              # P25 trunked radio decoder (C++, builds to build/trunk-recorder)
├── gr-osmosdr/                  # SDR driver source (GNU Radio OsmoSDR)
├── trunk-recorder-config.json   # RTL-SDR device config + P25 control channels
├── talkgroups.csv               # CCSF talkgroup ID → name/group/category mapping
└── RESEARCH.md                  # Radio frequency research notes
```

## Hardware

- MacBook Air (M-series)
- RTL-SDR v3 dongle ($25) — 24 MHz to 1.766 GHz
- Antenna pointed at San Francisco from the WorkOS office

## Radio Intelligence Notes

- SF Fire/EMS (talkgroups 925–955): **100% unencrypted** P25 Phase II
- SFPD dispatch (talkgroups 804–829): dispatcher side in the clear, field units encrypted
- Mutual aid (talkgroups 835–889): all unencrypted interop channels
- P25 control channel is always in the clear — reveals unit IDs, talkgroup activity, timing
