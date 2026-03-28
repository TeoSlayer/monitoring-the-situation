---
name: sf-situation-monitor
description: Query a live San Francisco situational awareness system. Use this skill when the user asks about current SF conditions — aircraft overhead, active fire/police/EMS incidents, Muni transit, radio scanner activity, traffic events, or system health. Connects to the Monitoring the Situation REST API.
license: MIT
compatibility: Requires network access to the monitoring backend (default http://localhost:8766)
metadata:
  author: TeoSlayer
  version: "1.0"
allowed-tools: Bash(curl:*) Read
---

# SF Situation Monitor — Agent Skill

You are connected to a live situational awareness system for San Francisco that fuses P25 radio scanner data, aircraft ADS-B, fire/police dispatch, Muni transit, and traffic feeds. Use the REST API below to answer user questions about what's happening in the city.

## Configuration

The API runs at `http://localhost:8766` by default. All endpoints return JSON with this envelope:

```json
{ "ok": true, "timestamp": "...", "total": 42, "data": [...] }
```

## Available Endpoints

### System Status
```bash
curl -s http://localhost:8766/api/status
```
Returns uptime, feed counts, connected WebSocket clients, and OpenSearch status. Use this first to verify the system is running.

### Aircraft
```bash
# All aircraft
curl -s http://localhost:8766/api/aircraft

# Filter by type (military, helicopter, police, bizjet, ga, civilian)
curl -s "http://localhost:8766/api/aircraft?type=military,helicopter"

# Filter by callsign
curl -s "http://localhost:8766/api/aircraft?callsign=N911SF"

# Filter by altitude range (feet)
curl -s "http://localhost:8766/api/aircraft?min_alt=500&max_alt=10000"
```
Returns aircraft with fields: hex, callsign, type, model, lat, lon, altitude, speed, heading, classification.

### Fire & Police Dispatch
```bash
# All active dispatch incidents
curl -s http://localhost:8766/api/dispatch

# Filter by type
curl -s "http://localhost:8766/api/dispatch?type=fire,medical"

# Filter by priority
curl -s "http://localhost:8766/api/dispatch?priority=A"

# Filter by time
curl -s "http://localhost:8766/api/dispatch?since=2026-03-28T12:00:00Z"
```
Returns incidents with: callType, address, priority, units, status, lat, lon, timestamp.

### Muni Transit
```bash
# All Muni vehicles
curl -s http://localhost:8766/api/transit

# Filter by line (J, K, L, M, N, T, F, or bus numbers)
curl -s "http://localhost:8766/api/transit?line=N,T,J"

# Filter by occupancy
curl -s "http://localhost:8766/api/transit?occupancy=full"
```
Returns vehicles with: line_ref, line_name, destination, direction, occupancy, lat, lon, bearing, color.

### Traffic Work Zones
```bash
curl -s http://localhost:8766/api/traffic/work-zones
curl -s "http://localhost:8766/api/traffic/work-zones?status=active"
curl -s "http://localhost:8766/api/traffic/work-zones?road=Market"
```

### Traffic Events
```bash
curl -s http://localhost:8766/api/traffic/events
```
Returns active traffic incidents: type, headline, severity, road_name, lat, lon.

### Radio Transcripts
```bash
# Recent transcripts
curl -s http://localhost:8766/api/radio/recent

# Filter by talkgroup
curl -s "http://localhost:8766/api/radio/recent?talkgroup=33116"

# Filter by group name
curl -s "http://localhost:8766/api/radio/recent?group=SF%20Fire"

# Limit results
curl -s "http://localhost:8766/api/radio/recent?limit=20"
```
Returns radio messages with: transcript, talkgroup_tag, talkgroup_group, timestamp, duration, freq, emergency, encrypted.

### Active Incidents (AI-Enriched)
```bash
# All active incidents
curl -s http://localhost:8766/api/incidents

# Filter by type and severity
curl -s "http://localhost:8766/api/incidents?type=fire&severity=high,critical"
```
Returns Gemini-enriched incidents: title, description, type, severity, status, coordinates, related radio messages.

### SDR Hardware Stats
```bash
curl -s http://localhost:8766/api/sdr/stats
```
Returns RTL-SDR device info, signal stats, active frequencies, recorder status.

### Historical Search (OpenSearch)
```bash
# Full-text search across radio transcripts
curl -s "http://localhost:8766/api/search/radio?q=fire+market&limit=20"

# Search enrichment analyses
curl -s "http://localhost:8766/api/search/enrichments?q=structure+fire&type=fire"

# Search incident history
curl -s "http://localhost:8766/api/search/incidents?q=medical&severity=high"
```

### GeoJSON Exports
```bash
curl -s http://localhost:8766/api/geojson/aircraft
curl -s http://localhost:8766/api/geojson/dispatch
curl -s http://localhost:8766/api/geojson/transit
curl -s http://localhost:8766/api/geojson/work-zones
curl -s http://localhost:8766/api/geojson/incidents
```
Returns standard GeoJSON FeatureCollections — useful for piping into mapping tools.

## Usage Patterns

### "What's happening right now?"
1. Check `/api/status` for system health
2. Check `/api/incidents` for active AI-enriched incidents
3. Check `/api/dispatch` for raw dispatch calls
4. Check `/api/radio/recent?limit=10` for latest radio chatter

### "Any emergencies near [location]?"
1. Query `/api/incidents?severity=high,critical`
2. Query `/api/dispatch?type=fire,medical`
3. Cross-reference lat/lon with the user's area of interest

### "What happened earlier?"
1. Use `/api/search/radio?q=...` for historical transcript search
2. Use `/api/search/enrichments?q=...` for enrichment analysis search

### "How many aircraft are overhead?"
1. Query `/api/aircraft` and count
2. Filter with `?type=military,helicopter` for interesting ones

### "Is Muni running?"
1. Query `/api/transit` for all active vehicles
2. Filter with `?line=N` for specific lines
3. Check `/api/service-alerts` for disruptions
