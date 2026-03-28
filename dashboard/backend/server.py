"""
Monitoring the Situation — Live Backend

WebSocket server that polls multiple data sources and pushes
real-time updates to the frontend dashboard.

Feeds:
  - FlightRadar24 API: non-commercial aircraft (military, heli, GA, bizjets)
  - Airplanes.live: all aircraft in 125nm radius (free, no key)
  - DataSF SODA: fire/EMS and police dispatch
  - P25 Radio: trunk-recorder + faster-whisper transcription

Run:
  python3 backend/server.py
"""

import asyncio
import csv
import json
import logging
import os
import glob
import signal
import subprocess
import time
import urllib.parse
import urllib.request
from collections import deque
from datetime import datetime, timedelta, timezone
from pathlib import Path

import aiohttp
from aiohttp import web
import websockets

from dotenv import load_dotenv

# Load API keys from project root .env
_env_path = Path(__file__).resolve().parent.parent.parent / ".env"
if _env_path.exists():
    load_dotenv(_env_path)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")

# Optional: nexla-sdk for 511 data ingestion via Nexla
try:
    from backend.nexla_feeds import get_traffic_and_transport as _nexla_fetch_all, _fetch_511, _NORMALIZERS, NEXLA_SOURCE_DEFS
    HAS_NEXLA = True
except ImportError:
    try:
        from nexla_feeds import get_traffic_and_transport as _nexla_fetch_all, _fetch_511, _NORMALIZERS, NEXLA_SOURCE_DEFS
        HAS_NEXLA = True
    except ImportError:
        HAS_NEXLA = False

# Optional: opensearch-py for data persistence
try:
    from opensearchpy import OpenSearch
    HAS_OPENSEARCH = True
except ImportError:
    HAS_OPENSEARCH = False

# Optional: faster-whisper for radio transcription
try:
    from faster_whisper import WhisperModel
    HAS_WHISPER = True
except ImportError:
    HAS_WHISPER = False

# Optional: google-genai for enrichment
try:
    from google import genai
    from google.genai import types as genai_types
    HAS_GEMINI = bool(GEMINI_API_KEY)
except ImportError:
    HAS_GEMINI = False

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("monitor")

# ─── Config ──────────────────────────────────────────────

WS_HOST = "0.0.0.0"
WS_PORT = 8765

FR24_TOKEN = os.getenv("FR24_TOKEN", "")
FR24_BASE = "https://fr24api.flightradar24.com/api"
FR24_HEADERS = {
    "Accept": "application/json",
    "Accept-Version": "v1",
    "Authorization": f"Bearer {FR24_TOKEN}",
}

# Antenna location
ANTENNA_LAT = 37.7901
ANTENNA_LON = -122.4034

# 50nm ≈ 0.83° lat, ~1.04° lon at this latitude
SF_BOUNDS = f"{ANTENNA_LAT + 0.83},{ANTENNA_LAT - 0.83},{ANTENNA_LON - 1.04},{ANTENNA_LON + 1.04}"
# Non-commercial categories: Military, Helicopters, Business Jets, GA, Drones
FR24_CATEGORIES = "M,H,J,T,D"

AIRPLANES_LIVE_URL = f"https://api.airplanes.live/v2/point/{ANTENNA_LAT}/{ANTENNA_LON}/25"
FIRE_DISPATCH_URL = "https://data.sfgov.org/resource/nuek-vuh3.json?$order=received_timestamp%20DESC&$limit=100"
POLICE_DISPATCH_URL = "https://data.sfgov.org/resource/gnap-fj3t.json?$order=call_date_time%20DESC&$limit=100"

# Poll intervals (seconds)
# FR24 at 30s = 120 req/hr = ~540 req until 4PM (well within 60K)
POLL_FR24 = 30
POLL_AIRCRAFT = 10  # airplanes.live (free, no limit)
POLL_DISPATCH = 30
POLL_RADIO = 1  # check for new recordings every 1s

# 511 API (transit + traffic)
API_511_KEY = os.getenv("API_511_KEY", "")
POLL_TRANSIT = 15       # Muni vehicles every 15s
POLL_WORK_ZONES = 300   # Work zones every 5 min
POLL_NEXLA = 30         # Nexla full fetch every 30s (transit fast, traffic slower)

# ─── Radio / trunk-recorder config ─────────────────────
BASE_DIR = Path(__file__).resolve().parent.parent.parent  # Hackathon root
RECORDINGS_DIR = str(BASE_DIR / "recordings")
TRUNK_RECORDER = str(BASE_DIR / "trunk-recorder" / "build" / "trunk-recorder")
TRUNK_CONFIG = str(BASE_DIR / "trunk-recorder-config.json")
TALKGROUPS_CSV = str(BASE_DIR / "talkgroups.csv")
RADIO_HISTORY_MAX = 200
RADIO_JSON_PATH = str(BASE_DIR / "radio_feed.json")

# SFPD / Coast Guard identification
SFPD_CALLSIGNS = {"N911SF", "N81SF", "SFPD", "CHP"}
COAST_GUARD_KW = {"GUARD", "USCG", "CGD"}

# ─── Enrichment config ─────────────────────────────────
GEMINI_MODEL = "gemini-3-flash-preview"
ENRICHMENT_WINDOW_MINUTES = 20
ENRICHMENT_WINDOW_EVERY = 5  # run window analysis every N enriched events
NOMINATIM_RATE_LIMIT = 1.1   # seconds between geocoding requests

# ─── State ───────────────────────────────────────────────

connected_clients = set()
latest_state = {
    "aircraft": [],
    "dispatch": [],
    "fr24_credits_used": 0,
    "radio_history": [],
    "radio_channels": {},      # talkgroup_id -> channel info + activity stats
    "incidents": {},            # incident_id -> incident dict
    "transit_vehicles": [],
    "work_zones": [],
    "traffic_events": [],
    "stop_departures": [],
    "service_alerts": [],
    "sdr": {                   # RTL-SDR connection stats
        "device": "rtl=0",
        "driver": "osmosdr",
        "center_freq_mhz": 852.0,
        "sample_rate_msps": 2.4,
        "gain_db": 49,
        "modulation": "qpsk",
        "system": "CCSF P25",
        "control_channels_mhz": [851.25, 851.4, 851.6125, 852.0625],
        "digital_recorders": 2,
        "active": False,
        "uptime_sec": 0,
        "start_time": None,
        # Aggregated from call metadata
        "total_calls": 0,
        "total_encrypted": 0,
        "total_errors": 0,
        "total_spikes": 0,
        "avg_freq_error_hz": 0,
        "last_freq_error_hz": 0,
        "freqs_used": {},       # freq -> call count
        "audio_types": {},      # audio_type -> count
    },
}

# Radio internals
_seen_wavs = set()
_trunk_proc = None
_whisper_model = None
_talkgroups = {}  # talkgroup_id (int) -> {tag, description, group, category, mode}

# Enrichment internals
_enrichment_queue = asyncio.Queue()  # holds message dicts to enrich
_gemini_client = None
_geocode_cache = {}
_last_geocode_time = 0.0
_enriched_count = 0
_enrichment_window = deque()  # sliding window of enriched messages

def _load_talkgroups():
    """Load talkgroup metadata from CSV."""
    if not os.path.exists(TALKGROUPS_CSV):
        log.warning(f"Talkgroups CSV not found: {TALKGROUPS_CSV}")
        return
    with open(TALKGROUPS_CSV, "r") as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                tg_id = int(row["Decimal"])
            except (ValueError, KeyError):
                continue
            _talkgroups[tg_id] = {
                "tag": row.get("Alpha Tag", ""),
                "description": row.get("Description", ""),
                "group": row.get("Category", ""),
                "category": row.get("Tag", ""),
                "mode": row.get("Mode", ""),
            }
    log.info(f"Loaded {len(_talkgroups)} talkgroups from CSV")

def _init_radio_channels():
    """Build initial channel list from talkgroups for telemetry."""
    for tg_id, tg in _talkgroups.items():
        latest_state["radio_channels"][tg_id] = {
            "talkgroup": tg_id,
            "tag": tg["tag"],
            "description": tg["description"],
            "group": tg["group"],
            "category": tg["category"],
            "tx_count": 0,
            "last_tx": None,
            "active": False,
        }

def _preload_radio_history():
    """Load recent transcripts from transcript_log.jsonl to seed history + channel stats."""
    log_path = str(BASE_DIR / "transcript_log.jsonl")
    if not os.path.exists(log_path):
        log.info("No transcript log found, starting fresh")
        return

    entries = []
    try:
        with open(log_path, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                    entries.append(entry)
                except json.JSONDecodeError:
                    continue
    except Exception as e:
        log.error(f"Error reading transcript log: {e}")
        return

    # Take last N entries
    recent = entries[-RADIO_HISTORY_MAX:]
    log.info(f"Pre-loading {len(recent)} transcripts from log ({len(entries)} total)")

    for entry in recent:
        tg = entry.get("talkgroup", 0)
        tg_info = _talkgroups.get(tg, {}) if isinstance(tg, int) else {}
        tg_group = entry.get("talkgroup_group", "") or tg_info.get("group", "")

        msg = {
            "type": "radio",
            "timestamp": datetime.fromtimestamp(entry.get("timestamp", 0), tz=timezone.utc).isoformat() if entry.get("timestamp") else entry.get("time", ""),
            "talkgroup": tg,
            "talkgroup_tag": entry.get("talkgroup_tag", "") or tg_info.get("tag", f"TG {tg}"),
            "talkgroup_group": tg_group,
            "talkgroup_category": tg_info.get("category", ""),
            "duration": entry.get("duration", 0),
            "sources": entry.get("sources", []),
            "transcript": entry.get("transcript", ""),
            "encrypted": bool(entry.get("encrypted", 0)),
            "emergency": bool(entry.get("emergency", 0)),
            "freq": entry.get("freq", 0),
            "color": _group_color(tg_group),
            "processed": False,
            "enrichment": None,
        }
        msg["id"] = _make_record_id(msg)
        latest_state["radio_history"].append(msg)

        # Update channel stats
        if isinstance(tg, int) and tg in latest_state["radio_channels"]:
            ch = latest_state["radio_channels"][tg]
            ch["tx_count"] += 1
            ch["last_tx"] = msg["timestamp"]
        elif isinstance(tg, int) and tg:
            latest_state["radio_channels"][tg] = {
                "talkgroup": tg,
                "tag": msg["talkgroup_tag"],
                "description": tg_info.get("description", ""),
                "group": tg_group,
                "category": tg_info.get("category", ""),
                "tx_count": 1,
                "last_tx": msg["timestamp"],
                "active": False,
            }

    log.info(f"Radio history: {len(latest_state['radio_history'])} entries, "
             f"{sum(1 for ch in latest_state['radio_channels'].values() if ch['tx_count'] > 0)} channels with activity")


# ─── Aircraft Classification ────────────────────────────

# Common helicopter ICAO type codes
HELI_TYPES = {
    "R22", "R44", "R66", "EC35", "EC45", "EC55", "EC30", "EC20", "EC75",
    "H500", "H60", "AS50", "AS55", "AS65", "A109", "A119", "A139", "A149",
    "A169", "B06", "B06T", "B105", "B206", "B212", "B222", "B230", "B407", "B412",
    "B429", "B430", "B505", "BK17", "MD52", "MD60", "MD90", "S76", "S70",
    "S92", "UH1", "UH60", "AH64", "CH47", "CH53", "V22", "NH90",
    "AS32", "AS33", "S61", "H135", "H145", "H155", "H160", "H175", "H215",
    "H225", "BALL", "GLID", "ULAC", "EC30", "EC25", "EC20", "SA34", "SA36",
    "HUCO", "LAMA", "ALLO", "PUMA", "GAZL",
}

# Business jet type codes
BIZJET_TYPES = {
    "C525", "C550", "C560", "C680", "C750", "CL30", "CL35", "CL60",
    "E135", "E145", "E35L", "E50P", "E55P", "FA10", "FA20", "FA50",
    "FA7X", "FA8X", "F900", "F2TH", "G150", "G200", "G280", "G3", "G4",
    "GALX", "GL5T", "GL7T", "GLEX", "GLF4", "GLF5", "GLF6", "H25B",
    "H25C", "HA4T", "HDJT", "LJ24", "LJ25", "LJ31", "LJ35", "LJ40",
    "LJ45", "LJ55", "LJ60", "LJ70", "LJ75", "PC24", "PRM1", "BE40",
    "BE4W", "C25A", "C25B", "C25C", "C56X", "C68A", "C700",
}

# GA / prop type codes
GA_TYPES = {
    "C150", "C152", "C172", "C177", "C180", "C182", "C185", "C206",
    "C207", "C208", "C210", "C310", "C340", "C402", "C414", "C421",
    "PA18", "PA22", "PA23", "PA24", "PA28", "PA30", "PA31", "PA32",
    "PA34", "PA44", "PA46", "PA60", "BE33", "BE35", "BE36", "BE55",
    "BE58", "BE76", "BE95", "DA40", "DA42", "DA62", "M20P", "M20T",
    "P28A", "P28B", "P28R", "P28T", "P32R", "P32T", "SR20", "SR22",
    "T206", "T210",
}


HELI_PREFIXES = {"R22", "R44", "R66", "EC", "AS", "B0", "B1", "B2", "B4", "B5", "MD", "H1", "H2", "UH", "AH", "CH", "S7", "S9", "NH", "A1"}

def _is_heli_type(ac_type):
    """Check if type code is a helicopter."""
    if ac_type in HELI_TYPES:
        return True
    # Prefix check for variants (e.g. B06T, EC35P, AS350)
    for p in HELI_PREFIXES:
        if ac_type.startswith(p) and len(ac_type) >= 3:
            return True
    return False

def classify_aircraft(ac, source="airplanes.live"):
    """Classify aircraft into: military, police, coast-guard, helicopter, bizjet, ga, civilian."""
    cs = (ac.get("callsign") or ac.get("flight") or "").strip().upper()
    ac_type = (ac.get("type") or ac.get("t") or "").strip().upper()

    # Police
    if any(k in cs for k in SFPD_CALLSIGNS):
        return "police"
    # Coast Guard
    if any(k in cs for k in COAST_GUARD_KW):
        return "coast-guard"

    if source == "fr24":
        cat = ac.get("category", "")
        if cat == "M":
            return "military"
        if cat == "H" or _is_heli_type(ac_type):
            return "helicopter"
        if cat == "J" or ac_type in BIZJET_TYPES:
            return "bizjet"
        if cat == "T" or ac_type in GA_TYPES:
            return "ga"
        if cat == "D":
            return "drone"
        return "non-commercial"

    # airplanes.live
    if ac.get("mil") or (ac.get("dbFlags", 0) & 1):
        # Military helis should still show as helicopter shape
        if _is_heli_type(ac_type):
            return "helicopter"
        return "military"
    if _is_heli_type(ac_type):
        return "helicopter"
    if ac_type in BIZJET_TYPES:
        return "bizjet"
    if ac_type in GA_TYPES:
        return "ga"
    return "civilian"


def type_color(classification):
    colors = {
        "police": "#ef4444",       # red
        "coast-guard": "#f97316",  # orange
        "military": "#f59e0b",     # amber
        "helicopter": "#22d3ee",   # cyan
        "bizjet": "#a78bfa",       # purple
        "ga": "#4ade80",           # green
        "drone": "#f472b6",        # pink
        "non-commercial": "#818cf8",  # indigo
        "civilian": "#64748b",     # slate
    }
    return colors.get(classification, "#64748b")


def is_interesting(classification):
    return classification not in ("civilian",)


# ─── Data Fetching ───────────────────────────────────────

async def fetch_fr24(session):
    """Fetch non-commercial aircraft from FlightRadar24 API."""
    url = f"{FR24_BASE}/live/flight-positions/full"
    params = {
        "bounds": SF_BOUNDS,
        "categories": FR24_CATEGORIES,
        "limit": 500,
    }
    try:
        async with session.get(url, headers=FR24_HEADERS, params=params) as resp:
            if resp.status == 200:
                data = await resp.json()
                flights = data.get("data", [])
                log.info(f"FR24: {len(flights)} non-commercial aircraft")
                latest_state["fr24_credits_used"] += 1
                return flights
            elif resp.status == 429:
                log.warning("FR24: rate limited, backing off")
                return []
            else:
                body = await resp.text()
                log.warning(f"FR24: HTTP {resp.status} — {body[:200]}")
                return []
    except Exception as e:
        log.error(f"FR24 fetch error: {e}")
        return []


async def fetch_airplanes_live(session):
    """Fetch all aircraft from Airplanes.live (free, no key)."""
    try:
        async with session.get(AIRPLANES_LIVE_URL) as resp:
            if resp.status == 200:
                data = await resp.json()
                aircraft = data.get("ac", [])
                log.info(f"Airplanes.live: {len(aircraft)} aircraft")
                return aircraft
            return []
    except Exception as e:
        log.error(f"Airplanes.live fetch error: {e}")
        return []


async def fetch_fire_dispatch(session):
    """Fetch fire/EMS dispatch from DataSF."""
    try:
        async with session.get(FIRE_DISPATCH_URL) as resp:
            if resp.status == 200:
                return await resp.json()
            return []
    except Exception as e:
        log.error(f"Fire dispatch error: {e}")
        return []


async def fetch_police_dispatch(session):
    """Fetch police dispatch from DataSF."""
    try:
        async with session.get(POLICE_DISPATCH_URL) as resp:
            if resp.status == 200:
                return await resp.json()
            return []
    except Exception as e:
        log.error(f"Police dispatch error: {e}")
        return []


# ─── 511 API (Transit + Traffic) ─────────────────────────

async def fetch_transit_vehicles(session):
    """Fetch Muni vehicle positions from 511.org SIRI VehicleMonitoring."""
    if not API_511_KEY:
        return []
    url = "https://api.511.org/transit/VehicleMonitoring"
    params = {"api_key": API_511_KEY, "agency": "SF", "format": "json"}
    try:
        async with session.get(url, params=params) as resp:
            if resp.status == 200:
                text = await resp.text()
                # 511 sometimes returns BOM-prefixed JSON
                if text.startswith('\ufeff'):
                    text = text[1:]
                data = json.loads(text)
                delivery = data.get("Siri", {}).get("ServiceDelivery", {})
                vm = delivery.get("VehicleMonitoringDelivery", {})
                activities = vm.get("VehicleActivity", [])
                log.info(f"511 Transit: {len(activities)} vehicles")
                return activities
            else:
                log.warning(f"511 Transit: HTTP {resp.status}")
                return []
    except Exception as e:
        log.error(f"511 Transit fetch error: {e}")
        return []


async def fetch_work_zones(session):
    """Fetch work zone data from 511.org WZDx feed."""
    if not API_511_KEY:
        return []
    url = "https://api.511.org/traffic/wzdx"
    params = {"api_key": API_511_KEY, "format": "json"}
    try:
        async with session.get(url, params=params) as resp:
            if resp.status == 200:
                text = await resp.text()
                if text.startswith('\ufeff'):
                    text = text[1:]
                data = json.loads(text)
                features = data.get("features", [])
                log.info(f"511 Work Zones: {len(features)} zones")
                return features
            else:
                log.warning(f"511 Work Zones: HTTP {resp.status}")
                return []
    except Exception as e:
        log.error(f"511 Work Zones fetch error: {e}")
        return []


_MUNI_RAIL_COLORS = {
    "J": "#f59e0b",   # amber
    "K": "#a78bfa",   # purple
    "L": "#a78bfa",   # purple
    "M": "#06b6d4",   # cyan
    "N": "#3b82f6",   # blue
    "T": "#ef4444",   # red
    "F": "#22c55e",   # green
    "PM": "#f97316",  # orange
    "PH": "#f97316",  # orange
}


def _muni_line_color(line_ref):
    """Return color for a Muni line (rail gets distinct colors, buses get slate)."""
    return _MUNI_RAIL_COLORS.get(str(line_ref).upper(), "#64748b")


def process_transit_vehicles(activities):
    """Unwrap SIRI VehicleActivity → flat vehicle dicts."""
    results = []
    for act in activities:
        journey = act.get("MonitoredVehicleJourney", {})
        vl = journey.get("VehicleLocation", {})
        lat = vl.get("Latitude")
        lon = vl.get("Longitude")
        if not lat or not lon:
            continue
        try:
            lat, lon = float(lat), float(lon)
        except (ValueError, TypeError):
            continue

        line_ref = journey.get("LineRef") or ""
        results.append({
            "id": f"muni-{journey.get('VehicleRef', '')}",
            "vehicle_ref": journey.get("VehicleRef", ""),
            "line_ref": line_ref,
            "line_name": journey.get("PublishedLineName") or line_ref,
            "destination": journey.get("DestinationName") or "",
            "direction": journey.get("DirectionRef") or "",
            "occupancy": journey.get("Occupancy") or "unknown",
            "lat": lat,
            "lon": lon,
            "bearing": float(journey.get("Bearing", 0) or 0),
            "timestamp": act.get("RecordedAtTime") or "",
            "color": _muni_line_color(line_ref),
        })
    return results


def process_work_zones(features):
    """Extract work zone features into flat dicts."""
    results = []
    for feat in features:
        props = feat.get("properties", {})
        geom = feat.get("geometry", {})
        wz_id = props.get("road_event_id") or props.get("id") or ""
        results.append({
            "id": f"wz-{wz_id}",
            "road_name": props.get("road_names", [""])[0] if isinstance(props.get("road_names"), list) else str(props.get("road_names", "")),
            "direction": props.get("direction") or "",
            "description": props.get("description") or props.get("event_type") or "",
            "status": props.get("event_status") or "active",
            "start_date": props.get("start_date") or "",
            "end_date": props.get("end_date") or "",
            "geometry_type": geom.get("type", ""),
            "coordinates": geom.get("coordinates", []),
        })
    return results


# ─── Data Processing ────────────────────────────────────

def process_fr24_aircraft(flights):
    """Transform FR24 data into our unified aircraft format."""
    results = []
    for ac in flights:
        lat = ac.get("lat")
        lon = ac.get("lon")
        if not lat or not lon:
            continue

        classification = classify_aircraft(ac, source="fr24")
        alt = ac.get("alt", 0) or 0

        results.append({
            "id": ac.get("fr24_id") or ac.get("hex", ""),
            "source": "fr24",
            "classification": classification,
            "color": type_color(classification),
            "interesting": is_interesting(classification),
            "lat": lat,
            "lon": lon,
            "alt": alt,
            "altMeters": alt * 0.3048 if isinstance(alt, (int, float)) else 0,
            "heading": ac.get("track", 0) or 0,
            "speed": ac.get("gspeed", 0) or 0,
            "vspeed": ac.get("vspeed", 0) or 0,
            "flight": (ac.get("callsign") or ac.get("flight") or "").strip() if isinstance(ac.get("callsign") or ac.get("flight"), str) else "",
            "squawk": ac.get("squawk") or "",
            "acType": ac.get("type") or "",
            "registration": ac.get("reg") or "",
            "origin": ac.get("orig_icao") or "",
            "destination": ac.get("dest_icao") or "",
            "category": ac.get("category") or "",
            "fr24_id": ac.get("fr24_id") or "",
            "fr24_url": f"https://www.flightradar24.com/{(ac.get('callsign') or '').strip() or ac.get('fr24_id', '')}",
        })
    return results


def process_adsbx_aircraft(aircraft_list):
    """Transform Airplanes.live data into unified format."""
    results = []
    for ac in aircraft_list:
        lat = ac.get("lat")
        lon = ac.get("lon")
        if not lat or not lon:
            continue

        classification = classify_aircraft(ac, source="airplanes.live")
        alt = ac.get("alt_baro") or ac.get("alt_geom") or 0
        if isinstance(alt, str):
            alt = 0

        results.append({
            "id": ac.get("hex", ""),
            "source": "adsb",
            "classification": classification,
            "color": type_color(classification),
            "interesting": is_interesting(classification),
            "lat": lat,
            "lon": lon,
            "alt": alt,
            "altMeters": alt * 0.3048 if isinstance(alt, (int, float)) else 0,
            "heading": ac.get("track", 0) or 0,
            "speed": ac.get("gs", 0) or 0,
            "vspeed": ac.get("baro_rate", 0) or 0,
            "flight": (ac.get("flight") or "").strip(),
            "squawk": ac.get("squawk", ""),
            "acType": ac.get("t", ""),
            "registration": ac.get("r", ""),
            "origin": "",
            "destination": "",
            "category": ac.get("category", ""),
        })
    return results


def process_dispatch(fire_data, police_data):
    """Transform dispatch data into unified format."""
    events = []
    cutoff = time.time() - 300  # 5 minutes

    for ev in fire_data:
        if not ev.get("point"):
            continue
        pt = ev["point"]
        coords = pt.get("coordinates") or [
            float(pt.get("longitude", 0)),
            float(pt.get("latitude", 0)),
        ]
        if not coords[0] or not coords[1]:
            continue

        ts_str = ev.get("received_timestamp", "")
        try:
            ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00")).timestamp()
        except (ValueError, AttributeError):
            ts = time.time()

        if ts < cutoff:
            continue

        call_type = (ev.get("call_type") or "").lower()
        if "fire" in call_type or "alarm" in call_type or "smoke" in call_type:
            etype = "fire"
        elif "medic" in call_type or "medical" in call_type or "ems" in call_type:
            etype = "medical"
        else:
            etype = "other"

        color = {"fire": "#f97316", "medical": "#3b82f6"}.get(etype, "#6b7280")
        age = time.time() - ts

        events.append({
            "id": f"fire-{ev.get('call_number', '')}",
            "source": "fire",
            "type": etype,
            "color": color,
            "lon": coords[0],
            "lat": coords[1],
            "callType": ev.get("call_type", "Unknown"),
            "address": ev.get("address", ""),
            "timestamp": ts_str,
            "priority": ev.get("priority", ""),
            "units": ev.get("unit_id", ""),
            "status": ev.get("call_final_disposition", ""),
            "opacity": max(0.3, 1 - age / 300),
            "severity": 3 if ev.get("priority") in ("1", "E") else 1,
        })

    for ev in police_data:
        lat = ev.get("latitude")
        lon = ev.get("longitude")
        if not lat or not lon:
            continue
        try:
            lat, lon = float(lat), float(lon)
        except (ValueError, TypeError):
            continue

        ts_str = ev.get("call_date_time", "")
        try:
            ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00")).timestamp()
        except (ValueError, AttributeError):
            ts = time.time()

        if ts < cutoff:
            continue

        age = time.time() - ts
        events.append({
            "id": f"police-{ev.get('cad_number', '')}",
            "source": "police",
            "type": "police",
            "color": "#eab308",
            "lon": lon,
            "lat": lat,
            "callType": ev.get("call_type_final_desc") or ev.get("call_type_original_desc") or "Unknown",
            "address": ev.get("intersection_point", ""),
            "timestamp": ts_str,
            "priority": ev.get("priority", ""),
            "units": "",
            "status": ev.get("disposition", ""),
            "opacity": max(0.3, 1 - age / 300),
            "severity": 3 if ev.get("priority") == "A" else 1,
        })

    return events


def merge_aircraft(fr24_list, adsb_list):
    """Merge FR24 + Airplanes.live, preferring FR24 data, deduping by hex/reg."""
    merged = {}

    # FR24 data takes priority (richer metadata)
    for ac in fr24_list:
        key = ac["registration"] or ac["id"] or ac["flight"]
        if key:
            merged[key] = ac

    # Add Airplanes.live aircraft not already in FR24 set
    for ac in adsb_list:
        key = ac["registration"] or ac["id"] or ac["flight"]
        if key and key not in merged:
            merged[key] = ac

    return list(merged.values())


# ─── Radio / Trunk-Recorder ──────────────────────────────

def _group_color(group):
    """Color for radio talkgroup group."""
    colors = {
        "SFFD": "#f97316",
        "SFPD": "#eab308",
        "EMS": "#3b82f6",
        "Mutual Aid": "#a78bfa",
    }
    return colors.get(group, "#6b7280")

def _start_trunk_recorder():
    """Start trunk-recorder as a subprocess."""
    global _trunk_proc

    # Check if an existing trunk-recorder process is running (not us)
    try:
        result = subprocess.run(
            ["pgrep", "-x", "trunk-recorder"], capture_output=True, text=True
        )
        if result.returncode == 0 and result.stdout.strip():
            pids = result.stdout.strip()
            log.info(f"trunk-recorder already running (PID {pids}) — using its recordings")
            latest_state["sdr"]["active"] = True
            latest_state["sdr"]["start_time"] = time.time()
            return True
    except Exception:
        pass

    if not os.path.exists(TRUNK_RECORDER):
        log.warning(f"trunk-recorder not found at {TRUNK_RECORDER}")
        return False
    if not os.path.exists(TRUNK_CONFIG):
        log.warning(f"trunk-recorder config not found at {TRUNK_CONFIG}")
        return False

    log.info("Starting trunk-recorder...")
    _trunk_proc = subprocess.Popen(
        [TRUNK_RECORDER, "--config", TRUNK_CONFIG],
        cwd=str(BASE_DIR),  # trunk-recorder needs talkgroups.csv in CWD
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    # Give it time to initialize the SDR and lock control channel
    time.sleep(5)
    if _trunk_proc.poll() is not None:
        output = _trunk_proc.stdout.read().decode()[-1000:] if _trunk_proc.stdout else ""
        log.error(f"trunk-recorder exited! Last output:\n{output}")
        _trunk_proc = None
        return False
    log.info(f"trunk-recorder running (PID {_trunk_proc.pid})")
    latest_state["sdr"]["active"] = True
    latest_state["sdr"]["start_time"] = time.time()
    return True

def _stop_trunk_recorder():
    """Gracefully stop trunk-recorder (our subprocess or any external instance)."""
    global _trunk_proc
    if _trunk_proc and _trunk_proc.poll() is None:
        log.info("Stopping our trunk-recorder subprocess...")
        _trunk_proc.terminate()
        try:
            _trunk_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _trunk_proc.kill()
        _trunk_proc = None

    # Also kill any external trunk-recorder process
    try:
        result = subprocess.run(["pgrep", "-x", "trunk-recorder"], capture_output=True, text=True)
        if result.returncode == 0 and result.stdout.strip():
            for pid in result.stdout.strip().split("\n"):
                pid = pid.strip()
                if pid:
                    log.info(f"Killing external trunk-recorder PID {pid}")
                    subprocess.run(["kill", "-9", pid], capture_output=True)
    except Exception:
        pass

def _transcribe(wav_path):
    """Transcribe a WAV file using faster-whisper."""
    if not _whisper_model:
        return ""
    try:
        segments, info = _whisper_model.transcribe(
            wav_path, language="en", beam_size=5, vad_filter=True
        )
        return " ".join(s.text.strip() for s in segments)
    except Exception as e:
        log.error(f"Transcription error: {e}")
        return f"[transcription error]"

def _process_call(wav_path):
    """Process a single radio call: read metadata, transcribe, return message."""
    json_path = wav_path.replace(".wav", ".json")
    meta = {}
    if os.path.exists(json_path):
        try:
            with open(json_path) as f:
                meta = json.load(f)
        except Exception:
            pass

    tg = meta.get("talkgroup", 0)
    tg_tag = meta.get("talkgroup_tag", "")
    tg_group = meta.get("talkgroup_group", "")
    encrypted = bool(meta.get("encrypted", 0))
    emergency = bool(meta.get("emergency", 0))
    duration = meta.get("call_length_ms", 0) / 1000
    start_time = meta.get("start_time", 0)
    freq = meta.get("freq", 0)
    sources = [s.get("tag", str(s.get("src", "?"))) for s in meta.get("srcList", [])]

    # Fill from talkgroups CSV if metadata is sparse
    tg_info = _talkgroups.get(tg, {})
    if not tg_tag:
        tg_tag = tg_info.get("tag", f"TG {tg}")
    if not tg_group:
        tg_group = tg_info.get("group", "")

    ts = datetime.fromtimestamp(start_time, tz=timezone.utc).isoformat() if start_time else datetime.now(timezone.utc).isoformat()

    transcript = ""
    if not encrypted:
        transcript = _transcribe(wav_path)

    msg = {
        "type": "radio",
        "timestamp": ts,
        "talkgroup": tg,
        "talkgroup_tag": tg_tag,
        "talkgroup_group": tg_group,
        "talkgroup_category": tg_info.get("category", ""),
        "duration": round(duration, 1),
        "sources": sources,
        "transcript": transcript,
        "encrypted": encrypted,
        "emergency": emergency,
        "freq": freq,
        "color": _group_color(tg_group),
        "processed": False,
        "enrichment": None,
    }
    # Generate stable ID
    msg["id"] = _make_record_id(msg)

    # Update SDR stats from call metadata
    sdr = latest_state["sdr"]
    sdr["total_calls"] += 1
    if encrypted:
        sdr["total_encrypted"] += 1
    freq_error = meta.get("freq_error", 0)
    sdr["last_freq_error_hz"] = freq_error
    # Running average
    n = sdr["total_calls"]
    sdr["avg_freq_error_hz"] = round(sdr["avg_freq_error_hz"] * (n - 1) / n + freq_error / n, 1)
    # Error/spike counts from freqList
    for fl in meta.get("freqList", []):
        sdr["total_errors"] += fl.get("error_count", 0)
        sdr["total_spikes"] += fl.get("spike_count", 0)
    # Track frequencies and audio types
    if freq:
        freq_key = str(freq)
        sdr["freqs_used"][freq_key] = sdr["freqs_used"].get(freq_key, 0) + 1
    audio_type = meta.get("audio_type", "unknown")
    sdr["audio_types"][audio_type] = sdr["audio_types"].get(audio_type, 0) + 1
    # Uptime
    if sdr["start_time"]:
        sdr["uptime_sec"] = int(time.time() - sdr["start_time"])

    label = tg_tag or f"TG {tg}"
    if encrypted:
        log.info(f"Radio: [{label}] ENCRYPTED ({duration:.1f}s)")
    elif transcript:
        log.info(f"Radio: [{label}] ({duration:.1f}s) \"{transcript[:80]}\"")
    else:
        log.info(f"Radio: [{label}] ({duration:.1f}s) (no speech)")

    return msg


def _cleanup_recording(wav_path):
    """Delete WAV, M4A, and JSON files for a processed recording to save disk space."""
    for ext in [".wav", ".m4a", ".json"]:
        path = wav_path.replace(".wav", ext)
        try:
            if os.path.exists(path):
                os.remove(path)
        except Exception as e:
            log.warning(f"Could not remove {path}: {e}")


import hashlib


# ─── Enrichment: Gemini + Geocoding ─────────────────────

def _get_gemini_client():
    global _gemini_client
    if _gemini_client is None and HAS_GEMINI:
        _gemini_client = genai.Client(api_key=GEMINI_API_KEY)
    return _gemini_client


def _geocode_sync(query):
    """Geocode via Nominatim (synchronous, rate-limited, cached)."""
    global _last_geocode_time

    cache_key = query.lower().strip()
    if cache_key in _geocode_cache:
        return _geocode_cache[cache_key]

    elapsed = time.monotonic() - _last_geocode_time
    if elapsed < NOMINATIM_RATE_LIMIT:
        time.sleep(NOMINATIM_RATE_LIMIT - elapsed)
    _last_geocode_time = time.monotonic()

    params = urllib.parse.urlencode({
        "q": f"{query}, San Francisco, CA, USA",
        "format": "json",
        "limit": 1,
        "addressdetails": 0,
    })
    url = f"https://nominatim.openstreetmap.org/search?{params}"
    req = urllib.request.Request(url, headers={"User-Agent": "SF-Scanner-Agent/1.0 (hackathon)"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            results = json.loads(resp.read())
        if results:
            r = results[0]
            result = {
                "lat": float(r["lat"]),
                "lng": float(r["lon"]),
                "display_name": r.get("display_name", query),
            }
            _geocode_cache[cache_key] = result
            return result
    except Exception as exc:
        log.warning(f"Geocode error for '{query}': {exc}")

    _geocode_cache[cache_key] = None
    return None


async def _geocode(address):
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(_geocode_sync, address),
            timeout=15,
        )
    except asyncio.TimeoutError:
        log.warning(f"Geocode timed out for '{address}'")
        return None


_TRANSMISSION_SYSTEM = """You are an expert on San Francisco public safety communications and geography.

Analyze one radio transmission and return a JSON object with:
{
  "addresses": [
    {
      "raw": "exactly as mentioned",
      "corrected": "corrected standard SF address",
      "type": "intersection|block|landmark|coordinates",
      "neighborhood": "SF neighborhood name (e.g. Mission, SoMa, Tenderloin, Richmond)",
      "cross_streets": "nearest cross street if identifiable"
    }
  ],
  "pois": [
    {
      "name": "Official real-world POI name near the incident location",
      "type": "hospital|fire_station|police_station|transit|landmark|school|park|marina",
      "geocode_query": "name + neighborhood for Nominatim search"
    }
  ],
  "analysis": "1-2 sentences describing what is happening in plain English, translating any 10-codes, signal codes, unit designations, or abbreviations into human-readable language",
  "incident_type": "medical|fire|police|maritime|traffic|other",
  "severity": "low|medium|high|critical",
  "units": ["unit identifiers mentioned"],
  "is_actionable": true,
  "linked_event_id": null,
  "code_translations": {"10-4": "Acknowledged", "Code 3": "Lights and sirens"}
}

IMPORTANT:
- Many transmissions will NOT contain addresses (status updates, unit check-ins, etc.). Return empty arrays for addresses and pois in that case.
- If recent context is provided, check if this transmission is related to a prior event and set "linked_event_id" to that event's ID.
- Only extract addresses that are actually spoken in the transcript. Do NOT invent or guess addresses.
- Translate ALL radio codes, 10-codes, signal codes, unit designators, and abbreviations in your analysis. E.g. "10-4" = "Acknowledged", "Code 3" = "Lights and sirens", "10-97" = "Arrived on scene", "E42" = "Engine 42", "B3" = "Battalion 3", etc. Put translations in "code_translations" field.
- For SFFD: translate box alarm numbers, response levels (1st alarm, 2nd alarm), apparatus types (Engine, Truck, Battalion, Rescue, Medic).
- For SFPD: translate disposition codes, beat designators, sector references.

SF geography knowledge:
- Broderick St: Western Addition/Hayes Valley
- Market St & Van Ness Ave: major downtown intersection
- UCSF Medical Center: Parnassus Ave, Inner Sunset
- Marsh St area: Inner Sunset / Twin Peaks
- Pier 39: Fisherman's Wharf, on the Embarcadero
- 3 miles west of Golden Gate: open Pacific Ocean / coastal waters
- City Hall: Dr Carlton B Goodlett Pl, Civic Center
- Green St: Russian Hill / North Beach
- Balboa St: Richmond District
- Parnassus Ave: inner Sunset, leads to UCSF

Return 2-4 real, nearby POIs relevant to the incident if an address is mentioned. Return empty arrays if no addresses or POIs are clearly relevant. Do not invent addresses not mentioned in the transcript.
"""

_WINDOW_SYSTEM = """You are a San Francisco public safety situational awareness analyst.

Given a 20-minute window of radio transmissions, synthesize the situation.

Return a JSON object:
{
  "derived_events": [
    {
      "id": "evt_001",
      "title": "Short event title",
      "description": "What is happening, who is involved, current status",
      "primary_location": "Main location of this event",
      "incident_type": "medical|fire|police|maritime|traffic|other",
      "severity": "low|medium|high|critical",
      "status": "active|resolved|unknown",
      "related_tx_timestamps": ["ISO timestamps of related transmissions"]
    }
  ],
  "situation_summary": "2-3 paragraph plain-English summary of all current incidents for a dispatcher or incident commander",
  "active_incident_count": 0,
  "highest_severity": "low|medium|high|critical"
}

Group transmissions into logical events (a cardiac emergency is one event even if multiple units report in).
"""


def _gemini_call_sync(system, prompt, json_mode=True):
    """Synchronous Gemini call."""
    client = _get_gemini_client()
    if not client:
        return ""
    config = genai_types.GenerateContentConfig(
        system_instruction=system,
        response_mime_type="application/json" if json_mode else "text/plain",
        temperature=0.1,
    )
    resp = client.models.generate_content(
        model=GEMINI_MODEL,
        contents=prompt,
        config=config,
    )
    return resp.text or ""


async def _gemini_call(system, prompt, json_mode=True):
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(_gemini_call_sync, system, prompt, json_mode),
            timeout=30,
        )
    except asyncio.TimeoutError:
        log.warning("Gemini call timed out after 30s")
        return "{}" if json_mode else ""


async def _analyze_transmission(msg):
    """Analyze a single radio transmission with Gemini, including recent context."""
    tag = msg.get("talkgroup_tag") or f"TG {msg.get('talkgroup', '?')}"
    group = msg.get("talkgroup_group") or "Unknown"
    transcript = msg.get("transcript") or ""

    # Build recent context from enrichment window (last 5 messages)
    context_lines = []
    recent = list(_enrichment_window)[-5:]
    for prev in recent:
        prev_tag = prev.get("talkgroup_tag") or "?"
        prev_group = prev.get("talkgroup_group") or "?"
        prev_ts = prev.get("timestamp", "?")
        prev_text = prev.get("transcript") or ""
        prev_enrichment = prev.get("enrichment")
        prev_type = prev_enrichment.get("incident_type", "") if prev_enrichment else ""
        prev_analysis = prev_enrichment.get("analysis", "") if prev_enrichment else ""
        context_lines.append(
            f"  [{prev_ts}] {prev_tag} ({prev_group}): {prev_text[:100]}"
            + (f" [type={prev_type}, analysis: {prev_analysis[:80]}]" if prev_type else "")
        )

    context_section = ""
    if context_lines:
        context_section = "\n\nRecent prior transmissions (use to link related events):\n" + "\n".join(context_lines)

    prompt = (
        f"Channel: {tag} ({group})\n"
        f"Timestamp: {msg.get('timestamp', '')}\n"
        f"Transcript: {transcript}\n"
        f"{context_section}\n\n"
        "Analyze this transmission."
    )
    try:
        raw = await _gemini_call(_TRANSMISSION_SYSTEM, prompt)
        parsed = json.loads(raw)
        if isinstance(parsed, list):
            parsed = parsed[0] if parsed else {}
        if not isinstance(parsed, dict):
            parsed = {}
        return parsed
    except Exception as exc:
        log.error(f"Gemini analysis error: {exc}")
        return {
            "addresses": [], "pois": [],
            "analysis": transcript[:120],
            "incident_type": "other", "severity": "low",
            "units": [], "is_actionable": False,
        }


async def _analyze_window(window_txs):
    """Analyze a sliding window of transmissions."""
    if not window_txs:
        return {
            "derived_events": [], "situation_summary": "No transmissions in window.",
            "active_incident_count": 0, "highest_severity": "low",
        }

    lines = []
    for tx in window_txs:
        tag = tx.get("talkgroup_tag") or "?"
        group = tx.get("talkgroup_group") or "?"
        ts = tx.get("timestamp", "?")
        transcript = tx.get("transcript") or ""
        lines.append(f"[{ts}] {tag} ({group}): {transcript}")

    prompt = (
        f"20-minute window - {len(window_txs)} transmissions:\n\n"
        + "\n".join(lines)
        + "\n\nSynthesize the current situation across all San Francisco public safety channels."
    )
    try:
        raw = await _gemini_call(_WINDOW_SYSTEM, prompt)
        parsed = json.loads(raw)
        if isinstance(parsed, list):
            parsed = parsed[0] if parsed else {}
        if not isinstance(parsed, dict):
            parsed = {}
        return parsed
    except Exception as exc:
        log.error(f"Window analysis error: {exc}")
        return {
            "derived_events": [], "situation_summary": "Window analysis unavailable.",
            "active_incident_count": 0, "highest_severity": "low",
        }


async def _enrich_message(msg):
    """Run full enrichment on a single message: Gemini analysis + geocoding."""
    transcript = msg.get("transcript") or ""
    if not transcript.strip() or msg.get("encrypted"):
        return {
            "processed": True,
            "enrichment": {
                "analysis": "",
                "incident_type": "other",
                "severity": "low",
                "addresses": [],
                "pois": [],
                "units": [],
                "coordinates": None,
                "is_actionable": False,
            }
        }

    # Step 1: Gemini per-event analysis
    analysis = await _analyze_transmission(msg)

    # Handle case where Gemini returns a list instead of dict
    if isinstance(analysis, list):
        analysis = analysis[0] if analysis else {}
    if not isinstance(analysis, dict):
        analysis = {}

    inc_type = analysis.get("incident_type", "other")
    severity = analysis.get("severity", "low")
    analysis_text = analysis.get("analysis", "")
    units = analysis.get("units", [])
    is_actionable = analysis.get("is_actionable", False)

    # Step 2: Geocode addresses
    geocoded_addresses = []
    primary_coords = None

    for addr in analysis.get("addresses", []):
        corrected = addr.get("corrected") or addr.get("raw") or ""
        raw = addr.get("raw") or corrected
        if not corrected:
            continue

        coords = await _geocode(corrected)
        geocoded_addresses.append({
            "raw": raw,
            "corrected": corrected,
            "type": addr.get("type", "block"),
            "neighborhood": addr.get("neighborhood", ""),
            "cross_streets": addr.get("cross_streets", ""),
            "lat": coords["lat"] if coords else None,
            "lng": coords["lng"] if coords else None,
            "display_name": coords["display_name"] if coords else None,
        })
        if coords and primary_coords is None:
            primary_coords = {"lat": coords["lat"], "lng": coords["lng"]}

    # Step 3: Geocode POIs
    geocoded_pois = []
    for poi in analysis.get("pois", []):
        name = poi.get("name") or ""
        if not name:
            continue
        poi_type = poi.get("type") or "landmark"
        q = poi.get("geocode_query") or f"{name} San Francisco"
        poi_coords = await _geocode(q)
        geocoded_pois.append({
            "name": name,
            "type": poi_type,
            "lat": poi_coords["lat"] if poi_coords else None,
            "lng": poi_coords["lng"] if poi_coords else None,
        })
        # Use POI coords as fallback if no address coords
        if poi_coords and primary_coords is None:
            primary_coords = {"lat": poi_coords["lat"], "lng": poi_coords["lng"]}

    return {
        "processed": True,
        "enrichment": {
            "analysis": analysis_text,
            "incident_type": inc_type,
            "severity": severity,
            "addresses": geocoded_addresses,
            "pois": geocoded_pois,
            "units": units,
            "coordinates": primary_coords,
            "is_actionable": is_actionable,
            "code_translations": analysis.get("code_translations", {}),
            "linked_event_id": analysis.get("linked_event_id"),
        }
    }


ENRICHMENT_LOG_PATH = str(BASE_DIR / "enrichment_log.json")
INCIDENTS_LOG_PATH = str(BASE_DIR / "incidents_log.json")


def _load_persisted_incidents():
    """Load saved incidents from disk."""
    if not os.path.exists(INCIDENTS_LOG_PATH):
        return {}
    try:
        with open(INCIDENTS_LOG_PATH, "r") as f:
            return json.load(f)
    except Exception as e:
        log.warning(f"Could not load incidents log: {e}")
        return {}


def _persist_incidents():
    """Save all incidents to disk."""
    try:
        tmp = INCIDENTS_LOG_PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump(latest_state["incidents"], f, indent=2)
        os.replace(tmp, INCIDENTS_LOG_PATH)
    except Exception as e:
        log.warning(f"Could not persist incidents: {e}")


def _merge_derived_events(derived_events, window_txs):
    """Merge Gemini-derived events into the incidents tracker.

    For each derived event:
      - If it matches an existing incident (by title similarity or overlapping transcripts), update it
      - Otherwise create a new incident
    Then link related transcripts from radio_history.
    """
    for evt in derived_events:
        evt_id = evt.get("id", "")
        title = evt.get("title", "Unknown Incident")
        description = evt.get("description", "")
        inc_type = evt.get("incident_type", "other")
        severity = evt.get("severity", "low")
        status = evt.get("status", "active")
        location = evt.get("primary_location", "")
        related_ts = evt.get("related_tx_timestamps", [])

        # Try to match to an existing incident by title similarity
        matched_id = None
        title_lower = title.lower()
        for existing_id, existing in latest_state["incidents"].items():
            existing_title = existing.get("title", "").lower()
            # Simple matching: same type + overlapping words in title
            if existing.get("type") == inc_type:
                existing_words = set(existing_title.split())
                new_words = set(title_lower.split())
                overlap = existing_words & new_words
                # If >40% of words overlap, consider it the same incident
                if len(overlap) > 0 and len(overlap) / max(len(new_words), 1) > 0.4:
                    matched_id = existing_id
                    break

        if matched_id:
            # Update existing incident
            inc = latest_state["incidents"][matched_id]
            inc["description"] = description  # latest description
            if severity in ("critical", "high") or (severity == "medium" and inc.get("severity") == "low"):
                inc["severity"] = severity
            inc["status"] = status
            if location and not inc.get("location"):
                inc["location"] = location
            inc["updated_at"] = datetime.now(timezone.utc).isoformat()
            # Add new related timestamps
            existing_ts = set(inc.get("related_timestamps", []))
            for ts in related_ts:
                existing_ts.add(ts)
            inc["related_timestamps"] = list(existing_ts)
        else:
            # Create new incident
            inc_id = f"inc_{hashlib.sha256(f'{title}-{inc_type}-{time.time()}'.encode()).hexdigest()[:8]}"
            latest_state["incidents"][inc_id] = {
                "id": inc_id,
                "title": title,
                "description": description,
                "type": inc_type,
                "severity": severity,
                "status": status,
                "location": location,
                "coordinates": None,  # will be filled from linked transcripts
                "created_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat(),
                "related_timestamps": related_ts,
                "transcript_ids": [],
                "timeline": [],
            }
            log.info(f"New incident: [{inc_type.upper()}] {title} (severity={severity})")

    # Link transcripts to incidents by matching timestamps
    for inc_id, inc in latest_state["incidents"].items():
        related_ts = set(inc.get("related_timestamps", []))
        if not related_ts:
            continue

        for msg in latest_state["radio_history"]:
            msg_ts = msg.get("timestamp", "")
            msg_id = msg.get("id", "")
            if not msg_id:
                continue

            # Match by timestamp
            if msg_ts in related_ts and msg_id not in inc.get("transcript_ids", []):
                inc.setdefault("transcript_ids", []).append(msg_id)

                # Add to timeline
                enrichment = msg.get("enrichment") or {}
                inc.setdefault("timeline", []).append({
                    "timestamp": msg_ts,
                    "transcript_id": msg_id,
                    "talkgroup_tag": msg.get("talkgroup_tag", ""),
                    "talkgroup_group": msg.get("talkgroup_group", ""),
                    "transcript": (msg.get("transcript") or "")[:200],
                    "analysis": enrichment.get("analysis", ""),
                })

                # Inherit coordinates from enriched transcripts
                if not inc.get("coordinates") and enrichment.get("coordinates"):
                    inc["coordinates"] = enrichment["coordinates"]

    # Also try to link transcripts via enrichment.linked_event_id
    for msg in latest_state["radio_history"]:
        enrichment = msg.get("enrichment")
        if not enrichment:
            continue
        linked_id = enrichment.get("linked_event_id")
        if not linked_id:
            continue
        # Find the incident with a matching derived event id
        for inc_id, inc in latest_state["incidents"].items():
            if linked_id in inc.get("related_timestamps", []) or linked_id == inc_id:
                msg_id = msg.get("id", "")
                if msg_id and msg_id not in inc.get("transcript_ids", []):
                    inc.setdefault("transcript_ids", []).append(msg_id)

    _persist_incidents()

    # Index all updated incidents in OpenSearch
    if HAS_OPENSEARCH:
        for inc in latest_state["incidents"].values():
            asyncio.create_task(_index_incident(inc))

def _load_persisted_enrichments():
    """Load saved enrichment data from disk."""
    if not os.path.exists(ENRICHMENT_LOG_PATH):
        return {}
    try:
        with open(ENRICHMENT_LOG_PATH, "r") as f:
            return json.load(f)
    except Exception as e:
        log.warning(f"Could not load enrichment log: {e}")
        return {}


def _persist_enrichment(msg_id, enrichment):
    """Save enrichment data for a message to disk."""
    try:
        data = _load_persisted_enrichments()
        data[msg_id] = enrichment
        tmp = ENRICHMENT_LOG_PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f)
        os.replace(tmp, ENRICHMENT_LOG_PATH)
    except Exception as e:
        log.warning(f"Could not persist enrichment: {e}")


def _apply_persisted_enrichments():
    """Apply saved enrichments to current radio_history on startup."""
    data = _load_persisted_enrichments()
    if not data:
        return
    applied = 0
    for msg in latest_state["radio_history"]:
        msg_id = msg.get("id")
        if msg_id and msg_id in data:
            msg["processed"] = True
            msg["enrichment"] = data[msg_id]
            applied += 1
    if applied:
        log.info(f"Applied {applied} persisted enrichments to radio history")


async def enrichment_loop():
    """Background loop that processes the enrichment queue sequentially."""
    global _enriched_count

    if not HAS_GEMINI:
        log.warning("Gemini not available — enrichment disabled")
        return

    log.info(f"Enrichment loop started (model={GEMINI_MODEL})")

    while True:
        try:
            msg = await _enrichment_queue.get()
            msg_id = msg.get("id")
            if not msg_id:
                continue

            tag = msg.get("talkgroup_tag") or f"TG {msg.get('talkgroup', '?')}"
            log.info(f"Enriching: [{tag}] {(msg.get('transcript') or '')[:60]}...")

            result = await _enrich_message(msg)
            enrichment = result["enrichment"]

            # Update the message in radio_history
            for i, m in enumerate(latest_state["radio_history"]):
                if m.get("id") == msg_id:
                    latest_state["radio_history"][i]["processed"] = True
                    latest_state["radio_history"][i]["enrichment"] = enrichment
                    break

            _enriched_count += 1

            # Log result
            coords_str = ""
            if enrichment.get("coordinates"):
                c = enrichment["coordinates"]
                coords_str = f" @ {c['lat']:.4f},{c['lng']:.4f}"
            log.info(
                f"Enriched #{_enriched_count}: [{tag}] "
                f"type={enrichment.get('incident_type')} "
                f"severity={enrichment.get('severity')}"
                f"{coords_str}"
            )

            # Persist enrichment to transcript log
            _persist_enrichment(msg_id, enrichment)

            # Index in OpenSearch (fire-and-forget)
            if HAS_OPENSEARCH:
                asyncio.create_task(_index_enrichment(msg_id, enrichment))

            # Broadcast enrichment update to all clients
            await broadcast({
                "type": "enrichment",
                "id": msg_id,
                "enrichment": enrichment,
            })

            # Update enrichment window (use a copy to avoid polluting the broadcast dict)
            if msg.get("transcript") and not msg.get("encrypted"):
                ts_str = msg.get("timestamp", "")
                try:
                    dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                except (ValueError, AttributeError):
                    dt = datetime.now(timezone.utc)
                window_entry = dict(msg)
                window_entry["_dt"] = dt
                _enrichment_window.append(window_entry)
                # Trim window
                cutoff = dt - timedelta(minutes=ENRICHMENT_WINDOW_MINUTES)
                while _enrichment_window and _enrichment_window[0].get("_dt", dt) < cutoff:
                    _enrichment_window.popleft()

            # Run window analysis every N events
            if _enriched_count % ENRICHMENT_WINDOW_EVERY == 0 and len(_enrichment_window) > 0:
                log.info(f"Running window analysis on {len(_enrichment_window)} transmissions...")
                w_result = await _analyze_window(list(_enrichment_window))

                # Merge derived events into incident tracker
                derived = w_result.get("derived_events", [])
                if derived:
                    _merge_derived_events(derived, list(_enrichment_window))

                # Broadcast full incident state + situation
                await broadcast({
                    "type": "incidents",
                    "incidents": latest_state["incidents"],
                    "situation_summary": w_result.get("situation_summary", ""),
                    "active_count": len([i for i in latest_state["incidents"].values() if i.get("status") == "active"]),
                    "highest_severity": w_result.get("highest_severity", "low"),
                })
                log.info(
                    f"Window: {len(derived)} derived events → "
                    f"{len(latest_state['incidents'])} tracked incidents, "
                    f"highest={w_result.get('highest_severity', '?')}"
                )

        except Exception as e:
            log.error(f"Enrichment error: {e}", exc_info=True)

        await asyncio.sleep(0.1)  # Small delay between enrichments


import math
import queue
import re


# ─── OpenSearch Persistence ──────────────────────────────

OPENSEARCH_HOST = os.getenv("OPENSEARCH_HOST", "")
OPENSEARCH_PORT = int(os.getenv("OPENSEARCH_PORT", "25060"))
OPENSEARCH_USER = os.getenv("OPENSEARCH_USER", "")
OPENSEARCH_PASS = os.getenv("OPENSEARCH_PASS", "")

_opensearch_client = None


def _get_opensearch_client():
    """Lazy singleton for OpenSearch client."""
    global _opensearch_client
    if _opensearch_client is not None:
        return _opensearch_client
    if not HAS_OPENSEARCH:
        return None
    try:
        _opensearch_client = OpenSearch(
            hosts=[{"host": OPENSEARCH_HOST, "port": OPENSEARCH_PORT}],
            http_auth=(OPENSEARCH_USER, OPENSEARCH_PASS),
            use_ssl=True,
            verify_certs=False,  # DigitalOcean managed DB
            ssl_show_warn=False,
            timeout=10,
        )
        # Test connection
        info = _opensearch_client.info()
        log.info(f"OpenSearch connected: {info.get('version', {}).get('distribution', '?')} {info.get('version', {}).get('number', '?')}")
        return _opensearch_client
    except Exception as e:
        log.warning(f"OpenSearch connection failed: {e}")
        _opensearch_client = None
        return None


_OPENSEARCH_INDICES = {
    "radio-transcripts": {
        "mappings": {
            "properties": {
                "id": {"type": "keyword"},
                "timestamp": {"type": "date"},
                "talkgroup": {"type": "integer"},
                "talkgroup_tag": {"type": "keyword"},
                "talkgroup_group": {"type": "keyword"},
                "transcript": {"type": "text"},
                "encrypted": {"type": "boolean"},
                "emergency": {"type": "boolean"},
                "duration": {"type": "float"},
                "freq": {"type": "long"},
            }
        }
    },
    "enrichments": {
        "mappings": {
            "properties": {
                "id": {"type": "keyword"},
                "timestamp": {"type": "date"},
                "incident_type": {"type": "keyword"},
                "severity": {"type": "keyword"},
                "analysis": {"type": "text"},
                "coordinates": {"type": "geo_point"},
                "addresses": {"type": "nested", "properties": {
                    "raw": {"type": "text"},
                    "corrected": {"type": "text"},
                    "neighborhood": {"type": "keyword"},
                }},
                "units": {"type": "keyword"},
            }
        }
    },
    "incidents": {
        "mappings": {
            "properties": {
                "id": {"type": "keyword"},
                "title": {"type": "text"},
                "description": {"type": "text"},
                "type": {"type": "keyword"},
                "severity": {"type": "keyword"},
                "status": {"type": "keyword"},
                "location": {"type": "text"},
                "coordinates": {"type": "geo_point"},
                "created_at": {"type": "date"},
                "updated_at": {"type": "date"},
            }
        }
    },
}


def _ensure_opensearch_indices():
    """Create OpenSearch indices if they don't exist."""
    client = _get_opensearch_client()
    if not client:
        return
    for idx_name, body in _OPENSEARCH_INDICES.items():
        try:
            if not client.indices.exists(index=idx_name):
                client.indices.create(index=idx_name, body=body)
                log.info(f"OpenSearch: created index '{idx_name}'")
            else:
                log.info(f"OpenSearch: index '{idx_name}' exists")
        except Exception as e:
            log.warning(f"OpenSearch index '{idx_name}' error: {e}")


async def _index_transcript(msg):
    """Index a radio transcript in OpenSearch (fire-and-forget)."""
    client = _get_opensearch_client()
    if not client:
        return
    try:
        doc = {
            "id": msg.get("id", ""),
            "timestamp": msg.get("timestamp"),
            "talkgroup": msg.get("talkgroup"),
            "talkgroup_tag": msg.get("talkgroup_tag", ""),
            "talkgroup_group": msg.get("talkgroup_group", ""),
            "transcript": msg.get("transcript", ""),
            "encrypted": msg.get("encrypted", False),
            "emergency": msg.get("emergency", False),
            "duration": msg.get("duration", 0),
            "freq": msg.get("freq", 0),
        }
        await asyncio.to_thread(client.index, index="radio-transcripts", body=doc, id=doc["id"])
    except Exception as e:
        log.debug(f"OpenSearch index transcript error: {e}")


async def _index_enrichment(msg_id, enrichment):
    """Index an enrichment result in OpenSearch (fire-and-forget)."""
    client = _get_opensearch_client()
    if not client:
        return
    try:
        coords = enrichment.get("coordinates")
        doc = {
            "id": msg_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "incident_type": enrichment.get("incident_type", "other"),
            "severity": enrichment.get("severity", "low"),
            "analysis": enrichment.get("analysis", ""),
            "units": enrichment.get("units", []),
        }
        if coords and coords.get("lat") and coords.get("lng"):
            doc["coordinates"] = {"lat": coords["lat"], "lon": coords["lng"]}
        if enrichment.get("addresses"):
            doc["addresses"] = enrichment["addresses"]
        await asyncio.to_thread(client.index, index="enrichments", body=doc, id=msg_id)
    except Exception as e:
        log.debug(f"OpenSearch index enrichment error: {e}")


async def _index_incident(incident):
    """Index an incident in OpenSearch (fire-and-forget)."""
    client = _get_opensearch_client()
    if not client:
        return
    try:
        doc = {
            "id": incident.get("id", ""),
            "title": incident.get("title", ""),
            "description": incident.get("description", ""),
            "type": incident.get("type", "other"),
            "severity": incident.get("severity", "low"),
            "status": incident.get("status", "active"),
            "location": incident.get("location", ""),
            "created_at": incident.get("created_at"),
            "updated_at": incident.get("updated_at"),
        }
        coords = incident.get("coordinates")
        if coords and coords.get("lat") and coords.get("lng"):
            doc["coordinates"] = {"lat": coords["lat"], "lon": coords["lng"]}
        await asyncio.to_thread(client.index, index="incidents", body=doc, id=doc["id"])
    except Exception as e:
        log.debug(f"OpenSearch index incident error: {e}")


async def _search_opensearch(query, index="radio-transcripts", size=20):
    """Full-text search across an OpenSearch index."""
    client = _get_opensearch_client()
    if not client:
        return []
    try:
        fields = {
            "radio-transcripts": ["transcript", "talkgroup_tag", "talkgroup_group"],
            "enrichments": ["analysis", "incident_type", "severity"],
            "incidents": ["title", "description", "type", "location"],
        }.get(index, ["transcript", "title", "description"])

        body = {
            "query": {
                "multi_match": {
                    "query": query,
                    "fields": fields,
                    "type": "best_fields",
                    "fuzziness": "AUTO",
                }
            },
            "sort": [{"timestamp": {"order": "desc", "unmapped_type": "date"}}],
            "size": size,
        }
        result = await asyncio.to_thread(client.search, index=index, body=body)
        hits = result.get("hits", {}).get("hits", [])
        return [h["_source"] for h in hits]
    except Exception as e:
        log.debug(f"OpenSearch search error: {e}")
        return []


# ─── ORACLE Agent ─────────────────────────────────────

_AGENT_SYSTEM = """You are ORACLE, a San Francisco situational awareness analyst embedded in a real-time monitoring dashboard.

Data feeds provided in context:
- P25 Trunked Radio transcripts (SFFD, SFPD, EMS, Mutual Aid) via RTL-SDR
- ADS-B aircraft within 125nm (classified: military, police, helicopter, bizjet, GA, civilian)
- SF Fire/EMS and Police dispatch from DataSF
- Enriched incidents derived from radio analysis

CRITICAL RULES:
- ONLY cite information that is EXPLICITLY present in the context data below. Never invent callsigns, addresses, incidents, or coordinates.
- If the context has no relevant data for a question, say "No data available" — do not fabricate.
- Be concise. Use bullet points. Cite verbatim from context: exact callsigns, talkgroup tags, timestamps, addresses as they appear.
- Translate radio codes (10-codes, signal codes) when you see them in transcripts.
- If context is empty or sparse, say so directly.

fly_to actions: You may include ONE fly_to action at the end ONLY if the context contains explicit coordinates (lat/lon) for the location. Use ONLY coordinates that appear in the context data. Format:
```json
[{"action":"fly_to","lat":37.7749,"lon":-122.4194,"zoom":15,"label":"Description"}]
```
Do NOT include fly_to actions with guessed or invented coordinates. Omit the actions block entirely if no coordinates exist in context."""

def _haversine_km(lat1, lon1, lat2, lon2):
    """Haversine distance in km."""
    R = 6371
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon/2)**2
    return R * 2 * math.asin(math.sqrt(a))


def _build_agent_context(query, client_ctx=None, historical=None):
    """Build a context string from all live data sources for the ORACLE agent."""
    parts = []
    now = datetime.now(timezone.utc)
    parts.append(f"Current time: {now.strftime('%Y-%m-%d %H:%M:%S UTC')}")

    if client_ctx:
        mc = client_ctx.get("map_center")
        if mc:
            parts.append(f"User map view: center=[{mc[0]:.4f}, {mc[1]:.4f}], zoom={client_ctx.get('zoom', 12)}")

    # Active incidents — only include ones that have enriched transcripts on the map
    # (incidents are derived from radio analysis; only those with coordinates are visible)
    inc_list = list(latest_state.get("incidents", {}).values())
    active_inc = [i for i in inc_list if i.get("status") == "active"]
    active_inc.sort(key=lambda i: {"critical": 0, "high": 1, "medium": 2, "low": 3}.get(i.get("severity", "low"), 3))

    # Check which incidents have transcripts that are actually enriched in current session
    enriched_ids = {m.get("id") for m in latest_state.get("radio_history", []) if m.get("enrichment") and m["enrichment"].get("coordinates")}
    visible_inc = []
    for inc in active_inc:
        tx_ids = set(inc.get("transcript_ids", []))
        has_visible = bool(tx_ids & enriched_ids) or bool(inc.get("coordinates"))
        if has_visible:
            visible_inc.append(inc)

    if visible_inc:
        parts.append(f"\n--- ACTIVE INCIDENTS ({len(visible_inc)} visible on map) ---")
        for inc in visible_inc[:10]:
            tx_count = len(inc.get("transcript_ids", []))
            coords = inc.get("coordinates")
            coord_str = f" [COORDS: lat={coords['lat']:.4f}, lon={coords['lng']:.4f}]" if coords else " [NO COORDS]"
            parts.append(
                f"- [{inc.get('severity','?').upper()}] {inc.get('title','?')} "
                f"({inc.get('type','?')}) — {inc.get('description','')[:120]} "
                f"| location: {inc.get('location','unknown')}{coord_str} | {tx_count} tx"
            )
    else:
        parts.append("\n--- ACTIVE INCIDENTS: none currently visible on map ---")

    # Recent radio transcripts (last 15 non-encrypted with content)
    history = latest_state.get("radio_history", [])
    recent_tx = [m for m in history if m.get("transcript") and not m.get("encrypted")][-15:]
    if recent_tx:
        parts.append(f"\n--- RECENT RADIO ({len(recent_tx)} transcripts) ---")
        for msg in recent_tx:
            tag = msg.get("talkgroup_tag") or f"TG {msg.get('talkgroup', '?')}"
            ts = msg.get("timestamp", "?")
            text = (msg.get("transcript") or "")[:150]
            enrich = msg.get("enrichment") or {}
            enrich_str = ""
            if enrich.get("incident_type") and enrich["incident_type"] != "other":
                enrich_str = f" [{enrich['incident_type'].upper()}/{enrich.get('severity','?')}]"
            if enrich.get("analysis"):
                enrich_str += f" Analysis: {enrich['analysis'][:100]}"
            if enrich.get("addresses"):
                addrs = ", ".join(a.get("corrected", a.get("raw", "")) for a in enrich["addresses"])
                enrich_str += f" Addr: {addrs}"
            if enrich.get("coordinates"):
                c = enrich["coordinates"]
                enrich_str += f" [ON MAP: {c['lat']:.4f},{c['lng']:.4f}]"
            parts.append(f"  [{ts}] {tag}: {text}{enrich_str}")
    else:
        parts.append("\n--- RECENT RADIO: no transcripts yet ---")

    # Interesting aircraft (up to 20)
    aircraft = latest_state.get("aircraft", [])
    interesting_ac = [a for a in aircraft if a.get("interesting")][:20]
    if interesting_ac:
        parts.append(f"\n--- NOTABLE AIRCRAFT ({len(interesting_ac)} of {len(aircraft)} total) ---")
        for ac in interesting_ac:
            cs = ac.get("flight") or ac.get("id") or "?"
            ac_type = ac.get("acType") or "?"
            alt = ac.get("alt", 0)
            cls = ac.get("classification", "?")
            lat, lon = ac.get("lat", 0), ac.get("lon", 0)
            parts.append(f"  {cs} ({cls}, {ac_type}) — {alt:,}ft @ {lat:.4f},{lon:.4f}")
    else:
        parts.append(f"\n--- AIRCRAFT: {len(aircraft)} tracked, none flagged as notable ---")

    # Dispatch events (up to 10)
    dispatch = latest_state.get("dispatch", [])
    if dispatch:
        parts.append(f"\n--- DISPATCH ({len(dispatch)} active) ---")
        for ev in dispatch[:10]:
            parts.append(
                f"  [{ev.get('source','?')}] {ev.get('callType','?')} — {ev.get('address','?')} "
                f"(priority={ev.get('priority','?')}, status={ev.get('status','?')})"
            )

    # Transit vehicles
    transit = latest_state.get("transit_vehicles", [])
    if transit:
        # Summarize by line
        line_counts = {}
        for v in transit:
            lr = v.get("line_ref") or "?"
            line_counts[lr] = line_counts.get(lr, 0) + 1
        line_summary = ", ".join(f"{lr}:{c}" for lr, c in sorted(line_counts.items(), key=lambda x: -x[1])[:15])
        parts.append(f"\n--- MUNI TRANSIT ({len(transit)} vehicles) ---")
        parts.append(f"  Lines: {line_summary}")
    else:
        parts.append("\n--- MUNI TRANSIT: no data ---")

    # Work zones
    work_zones = latest_state.get("work_zones", [])
    active_wz = [wz for wz in work_zones if wz.get("status") == "active"]
    if work_zones:
        parts.append(f"\n--- WORK ZONES ({len(active_wz)} active of {len(work_zones)} total) ---")
        for wz in active_wz[:5]:
            parts.append(f"  {wz.get('road_name','?')} {wz.get('direction','')}: {wz.get('description','')[:80]}")

    # Traffic events (from Nexla/511)
    traffic_events = latest_state.get("traffic_events", [])
    if traffic_events:
        parts.append(f"\n--- TRAFFIC EVENTS ({len(traffic_events)} active) ---")
        for te in traffic_events[:8]:
            parts.append(f"  [{te.get('severity','?')}] {te.get('headline') or te.get('type','?')} — {te.get('road_name','?')} {te.get('direction','')}: {(te.get('description') or '')[:80]}")

    # Service alerts
    alerts = latest_state.get("service_alerts", [])
    if alerts:
        parts.append(f"\n--- MUNI SERVICE ALERTS ({len(alerts)}) ---")
        for a in alerts[:5]:
            # Nexla-normalized alerts keep the original structure
            alert_data = a.get("Alert", a) if isinstance(a, dict) else a
            if isinstance(alert_data, dict):
                header = alert_data.get("HeaderText", {})
                if isinstance(header, dict):
                    text = header.get("Translation", [{}])[0].get("Text", str(alert_data)[:100]) if isinstance(header.get("Translation"), list) else str(header)[:100]
                else:
                    text = str(header)[:100]
                parts.append(f"  {text}")

    # SDR stats summary
    sdr = latest_state.get("sdr", {})
    if sdr.get("active"):
        uptime = sdr.get("uptime_sec", 0)
        total_calls = sdr.get("total_calls", 0)
        enc_pct = round(sdr.get("total_encrypted", 0) / max(total_calls, 1) * 100, 1)
        parts.append(f"\n--- SDR: uptime={uptime}s, calls={total_calls}, encrypted={enc_pct}% ---")

    # Cross-correlations: aircraft near active incidents
    if active_inc and interesting_ac:
        correlations = []
        for inc in active_inc:
            coords = inc.get("coordinates")
            if not coords:
                continue
            for ac in interesting_ac:
                ac_lat, ac_lon = ac.get("lat", 0), ac.get("lon", 0)
                dist = _haversine_km(coords["lat"], coords["lng"], ac_lat, ac_lon)
                if dist < 2.0:
                    correlations.append(
                        f"  Aircraft {ac.get('flight','?')} ({ac.get('classification','?')}) "
                        f"is {dist:.1f}km from incident \"{inc.get('title','?')}\""
                    )
        if correlations:
            parts.append("\n--- CROSS-CORRELATIONS ---")
            parts.extend(correlations)

    # Situation summary from last window analysis
    # (stored in the enrichment window state)
    if _enrichment_window:
        parts.append(f"\n--- ENRICHMENT WINDOW: {len(_enrichment_window)} recent transmissions being tracked ---")

    # Historical results from OpenSearch
    if historical:
        parts.append(f"\n--- HISTORICAL DATA (from OpenSearch, {len(historical)} results) ---")
        for h in historical[:15]:
            ts = h.get("timestamp", "?")
            txt = h.get("transcript") or h.get("analysis") or h.get("title") or h.get("description") or ""
            tag = h.get("talkgroup_tag") or h.get("incident_type") or h.get("type") or ""
            parts.append(f"  [{ts}] {tag}: {txt[:120]}")

    return "\n".join(parts)


_ACTION_RE = re.compile(r'```json\s*\n(\[.*?\])\s*\n```\s*$', re.DOTALL)

def _extract_agent_actions(text):
    """Extract JSON actions block from end of agent response. Returns (clean_text, actions_list)."""
    match = _ACTION_RE.search(text)
    if not match:
        return text, []
    try:
        actions = json.loads(match.group(1))
        if not isinstance(actions, list):
            return text, []
        clean = text[:match.start()].rstrip()
        return clean, actions
    except (json.JSONDecodeError, ValueError):
        return text, []


async def _handle_agent_query(ws, msg):
    """Handle an ORACLE agent query with streaming Gemini response."""
    query_id = msg.get("id", "q_0")
    query = msg.get("query", "").strip()
    client_ctx = msg.get("context", {})

    if not query:
        await ws.send(json.dumps({
            "type": "agent_chunk", "id": query_id,
            "status": "error", "delta": "Empty query", "full": "Empty query", "actions": [],
        }))
        return

    # Send thinking status
    await ws.send(json.dumps({
        "type": "agent_chunk", "id": query_id, "status": "thinking", "delta": "", "full": "",
    }))

    try:
        # Check if query is asking about historical data
        historical = None
        history_keywords = ["before", "earlier", "last hour", "yesterday", "history", "previous", "ago", "past", "today", "this morning", "tonight"]
        if HAS_OPENSEARCH and any(kw in query.lower() for kw in history_keywords):
            try:
                historical = await _search_opensearch(query, index="radio-transcripts", size=20)
                if not historical:
                    historical = await _search_opensearch(query, index="enrichments", size=10)
            except Exception:
                pass

        # Build context
        context = _build_agent_context(query, client_ctx, historical=historical)
        prompt = f"Context data:\n{context}\n\nUser query: {query}"

        client = _get_gemini_client()
        if not client:
            await ws.send(json.dumps({
                "type": "agent_chunk", "id": query_id,
                "status": "error", "delta": "Gemini not available", "full": "Gemini not available", "actions": [],
            }))
            return

        # Stream response via thread queue so each chunk reaches the client immediately
        full_text = ""
        chunk_q = queue.Queue()
        _SENTINEL = object()

        def _stream_sync():
            """Runs in a thread: iterates Gemini stream, pushes chunks to queue."""
            try:
                config = genai_types.GenerateContentConfig(
                    system_instruction=_AGENT_SYSTEM,
                    temperature=0.3,
                )
                stream = client.models.generate_content_stream(
                    model=GEMINI_MODEL,
                    contents=prompt,
                    config=config,
                )
                for chunk in stream:
                    text = chunk.text or ""
                    if text:
                        chunk_q.put(text)
            except Exception as exc:
                chunk_q.put(exc)
            finally:
                chunk_q.put(_SENTINEL)

        # Start generation in background thread
        loop = asyncio.get_event_loop()
        loop.run_in_executor(None, _stream_sync)

        # Consume chunks from queue and send each to client immediately
        deadline = time.time() + 45  # generous timeout
        while True:
            try:
                item = await asyncio.wait_for(
                    asyncio.to_thread(chunk_q.get, timeout=30),
                    timeout=35,
                )
            except (asyncio.TimeoutError, Exception):
                break

            if item is _SENTINEL:
                break
            if isinstance(item, Exception):
                raise item

            full_text += item
            try:
                await ws.send(json.dumps({
                    "type": "agent_chunk", "id": query_id,
                    "status": "streaming", "delta": item, "full": full_text,
                }))
            except websockets.exceptions.ConnectionClosed:
                return

            if time.time() > deadline:
                break

        # Extract actions and send done
        clean_text, actions = _extract_agent_actions(full_text)
        await ws.send(json.dumps({
            "type": "agent_chunk", "id": query_id,
            "status": "done", "delta": "", "full": clean_text, "actions": actions,
        }))
        log.info(f"ORACLE query completed: \"{query[:50]}\" → {len(clean_text)} chars, {len(actions)} actions")

    except asyncio.TimeoutError:
        await ws.send(json.dumps({
            "type": "agent_chunk", "id": query_id,
            "status": "error", "delta": "Request timed out", "full": "Request timed out after 30s", "actions": [],
        }))
    except websockets.exceptions.ConnectionClosed:
        return
    except Exception as e:
        log.error(f"ORACLE agent error: {e}", exc_info=True)
        try:
            await ws.send(json.dumps({
                "type": "agent_chunk", "id": query_id,
                "status": "error", "delta": str(e), "full": f"Error: {e}", "actions": [],
            }))
        except Exception:
            pass


def _make_record_id(msg):
    """Stable unique ID for a transcript record.

    NOTE: freq is intentionally excluded — the transcript log written by
    live_monitor.py doesn't store it, so preloaded history would get
    different IDs than live messages, breaking enrichment persistence.
    timestamp+talkgroup+duration is unique enough.
    """
    raw = f"{msg.get('timestamp','')}-{msg.get('talkgroup','')}-{msg.get('duration','')}"
    return hashlib.sha256(raw.encode()).hexdigest()[:12]


def _export_radio_json():
    """Write enrichment-ready JSON with all transcripts. All enrichment fields are null — fill them externally."""
    try:
        records = []
        for msg in latest_state["radio_history"]:
            records.append({
                "id": _make_record_id(msg),
                "timestamp": msg.get("timestamp"),
                "talkgroup": msg.get("talkgroup"),
                "talkgroup_tag": msg.get("talkgroup_tag"),
                "talkgroup_group": msg.get("talkgroup_group"),
                "talkgroup_category": msg.get("talkgroup_category"),
                "freq_hz": msg.get("freq"),
                "freq_mhz": round(msg["freq"] / 1e6, 4) if msg.get("freq") else None,
                "duration_sec": msg.get("duration"),
                "sources": msg.get("sources"),
                "encrypted": msg.get("encrypted"),
                "emergency": msg.get("emergency"),
                "transcript": msg.get("transcript"),
                # Enrichment slots — all null, fill externally
                "address": None,
                "cross_streets": None,
                "city": None,
                "coordinates": None,
                "units_dispatched": None,
                "incident_number": None,
                "event_type": None,
                "event_category": None,
                "severity": None,
                "poi": None,
                "notes": None,
            })

        data = {
            "schema_version": 2,
            "exported_at": datetime.now(timezone.utc).isoformat(),
            "source": "CCSF P25 Trunked Radio (San Francisco)",
            "antenna": {"lat": ANTENNA_LAT, "lon": ANTENNA_LON},
            "total_records": len(records),
            "channels": {
                str(k): v for k, v in latest_state["radio_channels"].items()
            },
            "records": records,
        }
        tmp = RADIO_JSON_PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, RADIO_JSON_PATH)
    except Exception as e:
        log.error(f"JSON export error: {e}")


# ─── Broadcast ───────────────────────────────────────────

async def broadcast(message):
    """Send message to all connected WebSocket clients."""
    global connected_clients
    if not connected_clients:
        return
    data = json.dumps(message)
    disconnected = set()
    # Snapshot to avoid "Set changed size during iteration"
    clients = set(connected_clients)
    for ws in clients:
        try:
            await ws.send(data)
        except websockets.exceptions.ConnectionClosed:
            disconnected.add(ws)
    connected_clients -= disconnected


# ─── Poll Loops ──────────────────────────────────────────

async def poll_aircraft(session):
    """Poll both FR24 and Airplanes.live, merge, and broadcast."""
    fr24_interval = POLL_FR24
    adsb_interval = POLL_AIRCRAFT

    fr24_next = 0
    adsb_next = 0

    fr24_data = []
    adsb_data = []

    while True:
        now = time.time()
        tasks = []

        if now >= fr24_next:
            tasks.append(("fr24", fetch_fr24(session)))
            fr24_next = now + fr24_interval

        if now >= adsb_next:
            tasks.append(("adsb", fetch_airplanes_live(session)))
            adsb_next = now + adsb_interval

        for name, coro in tasks:
            try:
                result = await coro
                if name == "fr24":
                    fr24_data = process_fr24_aircraft(result)
                elif name == "adsb":
                    adsb_data = process_adsbx_aircraft(result)
            except Exception as e:
                log.error(f"{name} processing error: {e}")

        # Merge: FR24 non-commercial + all ADSB
        all_aircraft = merge_aircraft(fr24_data, adsb_data)
        interesting = [ac for ac in all_aircraft if ac["interesting"]]

        latest_state["aircraft"] = all_aircraft

        await broadcast({
            "type": "aircraft",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "total": len(all_aircraft),
            "interesting": len(interesting),
            "data": all_aircraft,
        })

        if interesting:
            log.info(
                f"⚡ {len(interesting)} interesting aircraft: "
                + ", ".join(f"{a['flight'] or a['id']} ({a['classification']})" for a in interesting[:5])
            )

        await asyncio.sleep(2)


async def poll_dispatch(session):
    """Poll DataSF dispatch feeds and broadcast."""
    while True:
        try:
            fire, police = await asyncio.gather(
                fetch_fire_dispatch(session),
                fetch_police_dispatch(session),
            )
            events = process_dispatch(fire, police)
            latest_state["dispatch"] = events

            await broadcast({
                "type": "dispatch",
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "total": len(events),
                "data": events,
            })

            log.info(f"Dispatch: {len(events)} active incidents")
        except Exception as e:
            log.error(f"Dispatch poll error: {e}")

        await asyncio.sleep(POLL_DISPATCH)


async def poll_radio():
    """Poll recordings directory for new WAV files, transcribe, and broadcast."""
    global _seen_wavs

    # Mark all existing files as seen on startup
    for w in glob.glob(os.path.join(RECORDINGS_DIR, "**", "*.wav"), recursive=True):
        _seen_wavs.add(w)
    log.info(f"Radio: {len(_seen_wavs)} existing recordings marked as seen")

    last_new_file_time = time.time()
    STALE_THRESHOLD = 120  # restart trunk-recorder if no new files for 2 minutes

    while True:
        try:
            wavs = glob.glob(os.path.join(RECORDINGS_DIR, "**", "*.wav"), recursive=True)
            new_files = []
            for w in wavs:
                if w not in _seen_wavs:
                    # File is complete when .m4a companion exists
                    m4a = w.replace(".wav", ".m4a")
                    if os.path.exists(m4a):
                        _seen_wavs.add(w)
                        new_files.append(w)

            if new_files:
                last_new_file_time = time.time()

            for wav_path in sorted(new_files):
                # Run transcription in a thread to avoid blocking the event loop
                loop = asyncio.get_event_loop()
                msg = await loop.run_in_executor(None, _process_call, wav_path)

                # Update channel telemetry
                tg = msg["talkgroup"]
                if tg in latest_state["radio_channels"]:
                    ch = latest_state["radio_channels"][tg]
                    ch["tx_count"] += 1
                    ch["last_tx"] = msg["timestamp"]
                    ch["active"] = True
                elif tg:
                    # Unknown talkgroup — add it dynamically
                    latest_state["radio_channels"][tg] = {
                        "talkgroup": tg,
                        "tag": msg["talkgroup_tag"],
                        "description": "",
                        "group": msg["talkgroup_group"],
                        "category": msg.get("talkgroup_category", ""),
                        "tx_count": 1,
                        "last_tx": msg["timestamp"],
                        "active": True,
                    }

                # Add to history buffer
                latest_state["radio_history"].append(msg)
                if len(latest_state["radio_history"]) > RADIO_HISTORY_MAX:
                    latest_state["radio_history"] = latest_state["radio_history"][-RADIO_HISTORY_MAX:]

                # Broadcast the single radio message
                await broadcast(msg)

                # Index in OpenSearch (fire-and-forget)
                if HAS_OPENSEARCH:
                    asyncio.create_task(_index_transcript(msg))

                # Also broadcast updated channel telemetry
                await broadcast({
                    "type": "radio_telemetry",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "channels": latest_state["radio_channels"],
                    "total_tx": len(latest_state["radio_history"]),
                    "sdr": latest_state["sdr"],
                })

                # Queue for async enrichment (Gemini analysis + geocoding)
                if HAS_GEMINI and not msg.get("encrypted"):
                    try:
                        _enrichment_queue.put_nowait(msg)
                    except asyncio.QueueFull:
                        log.warning("Enrichment queue full, skipping")

                # Export JSON for external consumers
                _export_radio_json()

                # Clean up processed files to save disk space
                _cleanup_recording(wav_path)

            # Auto-restart trunk-recorder if stale
            if time.time() - last_new_file_time > STALE_THRESHOLD:
                log.warning(f"No new recordings for {STALE_THRESHOLD}s — restarting trunk-recorder")
                _stop_trunk_recorder()
                await asyncio.sleep(2)
                if _start_trunk_recorder():
                    log.info("trunk-recorder restarted successfully")
                else:
                    log.error("trunk-recorder restart failed")
                last_new_file_time = time.time()  # Reset timer to avoid restart loop

        except Exception as e:
            log.error(f"Radio poll error: {e}")

        # Keep uptime ticking even when no new calls
        sdr = latest_state["sdr"]
        if sdr.get("start_time"):
            sdr["uptime_sec"] = int(time.time() - sdr["start_time"])

        await asyncio.sleep(POLL_RADIO)


async def poll_transit(session):
    """Poll 511.org for Muni vehicle positions (fallback when Nexla unavailable)."""
    if HAS_NEXLA:
        log.info("511 Transit: Nexla available, skipping direct polling")
        return
    if not API_511_KEY:
        log.info("511 Transit: skipping (no API_511_KEY)")
        return
    while True:
        try:
            activities = await fetch_transit_vehicles(session)
            vehicles = process_transit_vehicles(activities)
            latest_state["transit_vehicles"] = vehicles
            await broadcast({
                "type": "transit",
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "total": len(vehicles),
                "data": vehicles,
            })
        except Exception as e:
            log.error(f"Transit poll error: {e}")
        await asyncio.sleep(POLL_TRANSIT)


async def poll_work_zones(session):
    """Poll 511.org for work zone data (fallback when Nexla unavailable)."""
    if HAS_NEXLA:
        log.info("511 Work Zones: Nexla available, skipping direct polling")
        return
    if not API_511_KEY:
        log.info("511 Work Zones: skipping (no API_511_KEY)")
        return
    while True:
        try:
            features = await fetch_work_zones(session)
            zones = process_work_zones(features)
            latest_state["work_zones"] = zones
            await broadcast({
                "type": "traffic",
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "total": len(zones),
                "data": zones,
            })
        except Exception as e:
            log.error(f"Work zones poll error: {e}")
        await asyncio.sleep(POLL_WORK_ZONES)


def _process_nexla_vehicles(raw_vehicles):
    """Process Nexla-normalized vehicle records into our transit format."""
    results = []
    for v in raw_vehicles:
        loc = v.get("location") or {}
        lat = loc.get("latitude")
        lon = loc.get("longitude")
        if not lat or not lon:
            continue
        line_ref = v.get("line_ref") or ""
        results.append({
            "id": f"muni-{v.get('vehicle_ref', '')}",
            "vehicle_ref": v.get("vehicle_ref", ""),
            "line_ref": line_ref,
            "line_name": v.get("published_line_name") or line_ref,
            "destination": v.get("destination") or "",
            "direction": v.get("direction_ref") or "",
            "occupancy": v.get("occupancy") or "unknown",
            "lat": lat,
            "lon": lon,
            "bearing": 0,
            "timestamp": v.get("recorded_at") or "",
            "color": _muni_line_color(line_ref),
        })
    return results


def _process_nexla_work_zones(raw_zones):
    """Process Nexla-normalized work zone records into our format."""
    results = []
    for wz in raw_zones:
        loc = wz.get("location") or {}
        results.append({
            "id": f"wz-{wz.get('id', '')}",
            "road_name": wz.get("road_name") or "",
            "direction": wz.get("direction") or "",
            "description": wz.get("description") or "",
            "status": wz.get("status") or "active",
            "start_date": wz.get("start_date") or "",
            "end_date": wz.get("end_date") or "",
            "geometry_type": loc.get("type", ""),
            "coordinates": loc.get("coordinates", []),
        })
    return results


def _process_nexla_traffic_events(raw_events):
    """Process Nexla-normalized traffic event records."""
    results = []
    for ev in raw_events:
        loc = ev.get("location") or {}
        coords = loc.get("coordinates")
        if not coords:
            continue
        # Coords may be [lon, lat] or [[lon, lat], ...]
        if isinstance(coords[0], list):
            lon, lat = coords[0][0], coords[0][1]
        else:
            lon, lat = coords[0], coords[1]
        results.append({
            "id": f"te-{ev.get('id', '')}",
            "type": ev.get("type") or "unknown",
            "subtype": ev.get("subtype") or "",
            "headline": ev.get("headline") or "",
            "description": ev.get("description") or "",
            "severity": ev.get("severity") or "unknown",
            "status": ev.get("status") or "active",
            "road_name": ev.get("road_name") or "",
            "direction": ev.get("direction") or "",
            "lat": float(lat),
            "lon": float(lon),
            "geometry_type": loc.get("type", "Point"),
            "coordinates": coords,
            "created": ev.get("created") or "",
            "updated": ev.get("updated") or "",
        })
    return results


async def poll_nexla():
    """Poll all 511 feeds via Nexla SDK (fetches live from 511 + manages Nexla pipelines)."""
    if not HAS_NEXLA:
        log.info("Nexla: SDK not available, skipping")
        return

    log.info("Nexla: starting 511 feed polling")

    # First run: full Nexla provisioning (creates sources/nexsets)
    first_run = True

    while True:
        try:
            if first_run:
                # Full provisioning + fetch (slower, sets up Nexla pipelines)
                try:
                    log.info("Nexla: provisioning sources + fetching live data...")
                    data = await asyncio.to_thread(_nexla_fetch_all)
                except Exception as nexla_err:
                    log.warning(f"Nexla provisioning failed ({nexla_err}), falling back to direct 511 fetch")
                    data = await asyncio.to_thread(_nexla_direct_fetch)
                first_run = False
            else:
                # Subsequent runs: just fetch directly from 511 (faster)
                data = await asyncio.to_thread(_nexla_direct_fetch)

            now_ts = datetime.now(timezone.utc).isoformat()

            # Process transit vehicles
            raw_vehicles = data.get("transit", {}).get("vehicle_positions", [])
            vehicles = _process_nexla_vehicles(raw_vehicles)
            latest_state["transit_vehicles"] = vehicles
            await broadcast({
                "type": "transit",
                "timestamp": now_ts,
                "total": len(vehicles),
                "data": vehicles,
            })

            # Process work zones
            raw_zones = data.get("traffic", {}).get("work_zones", [])
            zones = _process_nexla_work_zones(raw_zones)
            latest_state["work_zones"] = zones
            await broadcast({
                "type": "traffic",
                "timestamp": now_ts,
                "total": len(zones),
                "data": zones,
            })

            # Process traffic events (new feed)
            raw_events = data.get("traffic", {}).get("events", [])
            events = _process_nexla_traffic_events(raw_events)
            latest_state["traffic_events"] = events
            await broadcast({
                "type": "traffic_events",
                "timestamp": now_ts,
                "total": len(events),
                "data": events,
            })

            # Store stop departures + service alerts
            stop_deps = data.get("transit", {}).get("stop_departures", [])
            latest_state["stop_departures"] = stop_deps
            await broadcast({
                "type": "stop_departures",
                "timestamp": now_ts,
                "total": len(stop_deps),
                "data": stop_deps,
            })

            alerts = data.get("transit", {}).get("service_alerts", [])
            latest_state["service_alerts"] = alerts
            await broadcast({
                "type": "service_alerts",
                "timestamp": now_ts,
                "total": len(alerts),
                "data": alerts,
            })

            log.info(
                f"Nexla: {len(vehicles)} vehicles, {len(zones)} work zones, "
                f"{len(events)} traffic events, {len(stop_deps)} departures, "
                f"{len(alerts)} alerts"
            )

        except Exception as e:
            log.error(f"Nexla poll error: {e}", exc_info=True)

        await asyncio.sleep(POLL_NEXLA)


def _nexla_direct_fetch():
    """Direct 511 fetch using the normalizers from nexla_feeds.py (no Nexla provisioning)."""
    raw = {}
    for defn in NEXLA_SOURCE_DEFS:
        tag = defn["tag"]
        try:
            records = _fetch_511(defn["url"], defn["path_to_data"])
            normalizer = _NORMALIZERS[tag]
            raw[tag] = [n for r in records if (n := normalizer(r)) is not None]
        except Exception as e:
            log.warning(f"511 direct fetch [{tag}]: {e}")
            raw[tag] = []

    return {
        "traffic": {
            "events": raw.get("traffic_events", []),
            "work_zones": raw.get("work_zones", []),
        },
        "transit": {
            "vehicle_positions": raw.get("vehicle_positions", []),
            "stop_departures": raw.get("stop_departures", []),
            "service_alerts": raw.get("service_alerts", []),
        },
    }


# ─── WebSocket Handler ───────────────────────────────────

async def ws_handler(websocket):
    """Handle a new WebSocket connection."""
    connected_clients.add(websocket)
    remote = websocket.remote_address
    log.info(f"Client connected: {remote} ({len(connected_clients)} total)")

    # Send current state immediately
    try:
        await websocket.send(json.dumps({
            "type": "init",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "aircraft": {
                "total": len(latest_state["aircraft"]),
                "data": latest_state["aircraft"],
            },
            "dispatch": {
                "total": len(latest_state["dispatch"]),
                "data": latest_state["dispatch"],
            },
            "radio": {
                "history": latest_state["radio_history"],
                "channels": latest_state["radio_channels"],
                "total_tx": len(latest_state["radio_history"]),
            },
            "sdr": latest_state["sdr"],
            "incidents": latest_state["incidents"],
            "transit": {
                "total": len(latest_state["transit_vehicles"]),
                "data": latest_state["transit_vehicles"],
            },
            "traffic": {
                "total": len(latest_state["work_zones"]),
                "data": latest_state["work_zones"],
            },
            "traffic_events": {
                "total": len(latest_state["traffic_events"]),
                "data": latest_state["traffic_events"],
            },
            "service_alerts": {
                "total": len(latest_state["service_alerts"]),
                "data": latest_state["service_alerts"],
            },
        }))

        # Keep connection alive, handle incoming messages
        async for message in websocket:
            try:
                msg = json.loads(message)
                if msg.get("type") == "ping":
                    await websocket.send(json.dumps({"type": "pong"}))
                elif msg.get("type") == "agent_query":
                    asyncio.create_task(_handle_agent_query(websocket, msg))
                elif msg.get("type") == "query":
                    await websocket.send(json.dumps({
                        "type": "query_response",
                        "data": {
                            "aircraft_count": len(latest_state["aircraft"]),
                            "interesting_count": len([a for a in latest_state["aircraft"] if a["interesting"]]),
                            "dispatch_count": len(latest_state["dispatch"]),
                        },
                    }))
            except json.JSONDecodeError:
                pass

    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        connected_clients.discard(websocket)
        log.info(f"Client disconnected: {remote} ({len(connected_clients)} remaining)")


# ─── REST API (aiohttp) ──────────────────────────────────

def _api_response(data, total=None):
    """Standard JSON envelope for API responses."""
    if total is None:
        total = len(data) if isinstance(data, list) else 1
    return web.json_response({
        "ok": True,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "total": total,
        "data": data,
    })


def _api_error(msg, status=400):
    return web.json_response({"ok": False, "error": msg}, status=status)


def _to_geojson_fc(features):
    """Wrap a list of GeoJSON features in a FeatureCollection."""
    return {"type": "FeatureCollection", "features": features}


# ── CORS middleware ──
@web.middleware
async def cors_middleware(request, handler):
    if request.method == "OPTIONS":
        resp = web.Response(status=204)
    else:
        try:
            resp = await handler(request)
        except web.HTTPException as e:
            resp = e
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp


# ── Live State Endpoints ──

async def api_aircraft(request):
    aircraft = list(latest_state.get("aircraft", []))
    # Filter params
    type_filter = request.query.get("type")
    callsign = request.query.get("callsign", "").upper()
    min_alt = request.query.get("min_alt")
    max_alt = request.query.get("max_alt")

    if type_filter:
        types = set(t.strip() for t in type_filter.split(","))
        aircraft = [a for a in aircraft if a.get("classification") in types]
    if callsign:
        aircraft = [a for a in aircraft if callsign in (a.get("flight") or "").upper()]
    if min_alt:
        try:
            min_alt = int(min_alt)
            aircraft = [a for a in aircraft if (a.get("alt") or 0) >= min_alt]
        except ValueError:
            pass
    if max_alt:
        try:
            max_alt = int(max_alt)
            aircraft = [a for a in aircraft if (a.get("alt") or 0) <= max_alt]
        except ValueError:
            pass
    return _api_response(aircraft)


async def api_dispatch(request):
    events = list(latest_state.get("dispatch", []))
    type_filter = request.query.get("type")
    priority = request.query.get("priority")
    since = request.query.get("since")

    if type_filter:
        types = set(t.strip() for t in type_filter.split(","))
        events = [e for e in events if e.get("type") in types]
    if priority:
        events = [e for e in events if e.get("priority") == priority]
    if since:
        events = [e for e in events if (e.get("timestamp") or "") >= since]
    return _api_response(events)


async def api_transit(request):
    vehicles = list(latest_state.get("transit_vehicles", []))
    line = request.query.get("line")
    direction = request.query.get("direction")
    occupancy = request.query.get("occupancy")

    if line:
        lines = set(l.strip().upper() for l in line.split(","))
        vehicles = [v for v in vehicles if str(v.get("line_ref", "")).upper() in lines]
    if direction:
        vehicles = [v for v in vehicles if (v.get("direction") or "").upper() == direction.upper()]
    if occupancy:
        vehicles = [v for v in vehicles if v.get("occupancy") == occupancy]
    return _api_response(vehicles)


async def api_work_zones(request):
    zones = list(latest_state.get("work_zones", []))
    status = request.query.get("status")
    road = request.query.get("road", "").lower()

    if status:
        zones = [z for z in zones if z.get("status") == status]
    if road:
        zones = [z for z in zones if road in (z.get("road_name") or "").lower()]
    return _api_response(zones)


async def api_radio_recent(request):
    history = list(latest_state.get("radio_history", []))
    talkgroup = request.query.get("talkgroup")
    group = request.query.get("group")
    limit = int(request.query.get("limit", "50"))
    encrypted = request.query.get("encrypted")

    if talkgroup:
        try:
            tg = int(talkgroup)
            history = [m for m in history if m.get("talkgroup") == tg]
        except ValueError:
            pass
    if group:
        history = [m for m in history if group.lower() in (m.get("talkgroup_group") or "").lower()]
    if encrypted is not None:
        enc = encrypted.lower() in ("true", "1", "yes")
        history = [m for m in history if m.get("encrypted") == enc]

    history = history[-limit:]
    return _api_response(history)


async def api_incidents(request):
    incidents = list(latest_state.get("incidents", {}).values())
    type_filter = request.query.get("type")
    severity = request.query.get("severity")
    status = request.query.get("status")

    if type_filter:
        types = set(t.strip() for t in type_filter.split(","))
        incidents = [i for i in incidents if i.get("type") in types]
    if severity:
        sevs = set(s.strip() for s in severity.split(","))
        incidents = [i for i in incidents if i.get("severity") in sevs]
    if status:
        incidents = [i for i in incidents if i.get("status") == status]
    return _api_response(incidents)


async def api_incident_detail(request):
    inc_id = request.match_info.get("id", "")
    incident = latest_state.get("incidents", {}).get(inc_id)
    if not incident:
        return _api_error(f"Incident '{inc_id}' not found", 404)
    return _api_response(incident, total=1)


async def api_traffic_events(request):
    events = list(latest_state.get("traffic_events", []))
    severity = request.query.get("severity")
    road = request.query.get("road", "").lower()
    event_type = request.query.get("type")

    if severity:
        events = [e for e in events if e.get("severity") == severity]
    if road:
        events = [e for e in events if road in (e.get("road_name") or "").lower()]
    if event_type:
        types = set(t.strip() for t in event_type.split(","))
        events = [e for e in events if e.get("type") in types]
    return _api_response(events)


async def api_service_alerts(request):
    return _api_response(latest_state.get("service_alerts", []))


async def api_sdr_stats(request):
    return _api_response(latest_state.get("sdr", {}), total=1)


async def api_status(request):
    sdr = latest_state.get("sdr", {})
    return _api_response({
        "uptime_sec": sdr.get("uptime_sec", 0),
        "sdr_active": sdr.get("active", False),
        "total_calls": sdr.get("total_calls", 0),
        "ws_clients": len(connected_clients),
        "aircraft_count": len(latest_state.get("aircraft", [])),
        "dispatch_count": len(latest_state.get("dispatch", [])),
        "transit_count": len(latest_state.get("transit_vehicles", [])),
        "work_zone_count": len(latest_state.get("work_zones", [])),
        "incident_count": len(latest_state.get("incidents", {})),
        "radio_history_count": len(latest_state.get("radio_history", [])),
        "opensearch": HAS_OPENSEARCH and _opensearch_client is not None,
        "gemini": HAS_GEMINI,
    }, total=1)


# ── Historical Search Endpoints (OpenSearch) ──

async def api_search_radio(request):
    if not HAS_OPENSEARCH or not _get_opensearch_client():
        return _api_error("OpenSearch not available", 503)
    q = request.query.get("q", "")
    limit = min(int(request.query.get("limit", "50")), 200)
    if not q:
        return _api_error("Missing 'q' parameter")
    results = await _search_opensearch(q, index="radio-transcripts", size=limit)
    return _api_response(results)


async def api_search_enrichments(request):
    if not HAS_OPENSEARCH or not _get_opensearch_client():
        return _api_error("OpenSearch not available", 503)
    q = request.query.get("q", "")
    limit = min(int(request.query.get("limit", "20")), 100)
    if not q:
        return _api_error("Missing 'q' parameter")
    results = await _search_opensearch(q, index="enrichments", size=limit)
    return _api_response(results)


async def api_search_incidents(request):
    if not HAS_OPENSEARCH or not _get_opensearch_client():
        return _api_error("OpenSearch not available", 503)
    q = request.query.get("q", "")
    limit = min(int(request.query.get("limit", "20")), 100)
    if not q:
        return _api_error("Missing 'q' parameter")
    results = await _search_opensearch(q, index="incidents", size=limit)
    return _api_response(results)


# ── GeoJSON Export Endpoints ──

async def api_geojson_transit(request):
    features = []
    for v in latest_state.get("transit_vehicles", []):
        if v.get("lat") and v.get("lon"):
            features.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [v["lon"], v["lat"]]},
                "properties": {k: v2 for k, v2 in v.items() if k not in ("lat", "lon")},
            })
    return web.json_response(_to_geojson_fc(features))


async def api_geojson_work_zones(request):
    features = []
    for wz in latest_state.get("work_zones", []):
        coords = wz.get("coordinates", [])
        if not coords:
            continue
        geom_type = wz.get("geometry_type", "LineString")
        features.append({
            "type": "Feature",
            "geometry": {"type": geom_type, "coordinates": coords},
            "properties": {k: v for k, v in wz.items() if k not in ("coordinates", "geometry_type")},
        })
    return web.json_response(_to_geojson_fc(features))


async def api_geojson_incidents(request):
    features = []
    for inc in latest_state.get("incidents", {}).values():
        coords = inc.get("coordinates")
        if not coords:
            continue
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [coords.get("lng", 0), coords.get("lat", 0)]},
            "properties": {k: v for k, v in inc.items() if k != "coordinates"},
        })
    return web.json_response(_to_geojson_fc(features))


async def api_geojson_dispatch(request):
    features = []
    for ev in latest_state.get("dispatch", []):
        if ev.get("lat") and ev.get("lon"):
            features.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [ev["lon"], ev["lat"]]},
                "properties": {k: v for k, v in ev.items() if k not in ("lat", "lon")},
            })
    return web.json_response(_to_geojson_fc(features))


async def api_geojson_aircraft(request):
    features = []
    for ac in latest_state.get("aircraft", []):
        if ac.get("lat") and ac.get("lon"):
            features.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [ac["lon"], ac["lat"]]},
                "properties": {k: v for k, v in ac.items() if k not in ("lat", "lon")},
            })
    return web.json_response(_to_geojson_fc(features))


async def _start_http_api():
    """Start the REST API on port 8766."""
    app = web.Application(middlewares=[cors_middleware])

    # Live state
    app.router.add_get('/api/aircraft', api_aircraft)
    app.router.add_get('/api/dispatch', api_dispatch)
    app.router.add_get('/api/transit', api_transit)
    app.router.add_get('/api/traffic/work-zones', api_work_zones)
    app.router.add_get('/api/radio/recent', api_radio_recent)
    app.router.add_get('/api/incidents', api_incidents)
    app.router.add_get('/api/incidents/{id}', api_incident_detail)
    app.router.add_get('/api/traffic/events', api_traffic_events)
    app.router.add_get('/api/service-alerts', api_service_alerts)
    app.router.add_get('/api/sdr/stats', api_sdr_stats)
    app.router.add_get('/api/status', api_status)

    # Historical search (OpenSearch)
    app.router.add_get('/api/search/radio', api_search_radio)
    app.router.add_get('/api/search/enrichments', api_search_enrichments)
    app.router.add_get('/api/search/incidents', api_search_incidents)

    # GeoJSON exports
    app.router.add_get('/api/geojson/transit', api_geojson_transit)
    app.router.add_get('/api/geojson/work-zones', api_geojson_work_zones)
    app.router.add_get('/api/geojson/incidents', api_geojson_incidents)
    app.router.add_get('/api/geojson/dispatch', api_geojson_dispatch)
    app.router.add_get('/api/geojson/aircraft', api_geojson_aircraft)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '0.0.0.0', 8766)
    await site.start()
    log.info("REST API running on http://localhost:8766")


# ─── Main ────────────────────────────────────────────────

async def main():
    global _whisper_model

    log.info("=" * 50)
    log.info("  MONITORING THE SITUATION — Backend")
    log.info("=" * 50)
    log.info(f"WebSocket server starting on ws://{WS_HOST}:{WS_PORT}")
    log.info(f"FR24 categories: {FR24_CATEGORIES}")
    log.info(f"SF bounds: {SF_BOUNDS}")
    log.info("")

    # Load talkgroups and pre-populate history
    _load_talkgroups()
    _init_radio_channels()
    _preload_radio_history()
    _apply_persisted_enrichments()
    # Load persisted incidents
    saved_incidents = _load_persisted_incidents()
    if saved_incidents:
        latest_state["incidents"] = saved_incidents
        log.info(f"Loaded {len(saved_incidents)} persisted incidents")
    _export_radio_json()
    log.info(f"Radio JSON exported to {RADIO_JSON_PATH}")

    # Load whisper model
    if HAS_WHISPER:
        log.info("Loading Whisper model (base.en)...")
        _whisper_model = WhisperModel("base.en", device="cpu", compute_type="int8")
        log.info("Whisper model ready")
    else:
        log.warning("faster-whisper not installed — radio transcription disabled")

    # OpenSearch setup
    if HAS_OPENSEARCH:
        _ensure_opensearch_indices()
    else:
        log.warning("opensearch-py not installed — persistence disabled")

    # Enrichment + Agent status
    if HAS_GEMINI:
        log.info(f"Gemini enrichment enabled (model={GEMINI_MODEL})")
        log.info("ORACLE agent query handler ready")
    else:
        log.warning("Gemini enrichment disabled (google-genai not installed or no API key)")

    # Start trunk-recorder
    radio_enabled = _start_trunk_recorder()
    if radio_enabled:
        log.info("Radio feed enabled")
    else:
        log.warning("Radio feed disabled (trunk-recorder not available) — will still serve cached history")

    # Start REST API
    await _start_http_api()

    async with aiohttp.ClientSession() as session:
        # Start WebSocket server
        async with websockets.serve(ws_handler, WS_HOST, WS_PORT):
            log.info(f"WebSocket server running on ws://localhost:{WS_PORT}")

            # Run poll loops concurrently
            # Always run poll_radio — it picks up recordings from any trunk-recorder instance
            tasks = [
                poll_aircraft(session),
                poll_dispatch(session),
                poll_radio(),
                enrichment_loop(),
                poll_transit(session),
                poll_work_zones(session),
                poll_nexla(),
            ]

            try:
                await asyncio.gather(*tasks)
            finally:
                _stop_trunk_recorder()


if __name__ == "__main__":
    asyncio.run(main())
