"""
SF Bay Area Traffic & Public Transit — Nexla-powered ingestion
==============================================================

Uses the Nexla SDK to provision REST API data sources pointing at the
511 SF Bay Open Data API, activates them so Nexla ingests the feeds, and
reads the resulting nexset records back as a single JSON payload.

Required environment variable:
    NEXLA_SERVICE_KEY   – your Nexla service key
                          (Settings › Authentication in the Nexla UI)

Optional:
    NEXLA_API_URL       – override the Nexla API base URL
                          (default: https://dataops.nexla.io/nexla-api)

Install dependencies:
    pip install nexla-sdk requests
"""

import json
import os

import requests
from nexla_sdk import NexlaClient
from nexla_sdk.models.credentials.requests import CredentialCreate
from nexla_sdk.models.sources.requests import SourceCreate

# ── 511 SF Bay API ─────────────────────────────────────────────────────────────
_511_API_KEY  = os.getenv("API_511_KEY", "")
_511_BASE     = "https://api.511.org"
SF_BBOX       = "-122.5247,37.7081,-122.3573,37.8124"  # San Francisco bounding box
SF_OPERATOR   = "SF"                                    # SFMTA / SF Muni

# ── Nexla ──────────────────────────────────────────────────────────────────────
NEXLA_CREDENTIAL_NAME = "511 SF Bay – no-auth"

# Each entry declares one Nexla REST API source → one nexset.
# `path_to_data`  tells Nexla which JSON key holds the record array.
# `tag`           is used as the key in the returned dict.
NEXLA_SOURCE_DEFS = [
    {
        "tag":           "traffic_events",
        "name":          "SF 511 – Traffic Events",
        # NOTE: bbox param causes the 511 API to time out — fetch all Bay Area
        # events and filter to SF coordinates in the normalizer.
        "url":           (
            f"{_511_BASE}/traffic/events"
            f"?api_key={_511_API_KEY}&format=json&status=ACTIVE"
        ),
        "path_to_data":  "events",
        "description":   "Active traffic incidents (Bay Area; filtered to SF in code)",
    },
    {
        "tag":           "work_zones",
        "name":          "SF 511 – Work Zones (WZDx)",
        "url":           (
            f"{_511_BASE}/traffic/wzdx"
            f"?api_key={_511_API_KEY}&format=json"
        ),
        "path_to_data":  "features",
        "description":   "Active road construction and closures (Bay Area; filtered to SF in code)",
    },
    {
        "tag":           "vehicle_positions",
        "name":          "SF 511 – Muni Vehicle Positions",
        "url":           (
            f"{_511_BASE}/transit/VehicleMonitoring"
            f"?api_key={_511_API_KEY}&format=json&agency={SF_OPERATOR}"
        ),
        "path_to_data":  (
            "Siri.ServiceDelivery.VehicleMonitoringDelivery.VehicleActivity"
        ),
        "description":   "Live SF Muni vehicle locations (SIRI VehicleMonitoring)",
    },
    {
        "tag":           "stop_departures",
        "name":          "SF 511 – Muni Stop Departures",
        "url":           (
            f"{_511_BASE}/transit/StopMonitoring"
            f"?api_key={_511_API_KEY}&format=json&agency={SF_OPERATOR}"
        ),
        # StopMonitoring has no Siri wrapper — starts directly at ServiceDelivery
        "path_to_data":  "ServiceDelivery.StopMonitoringDelivery.MonitoredStopVisit",
        "description":   "Real-time SF Muni departure predictions (SIRI StopMonitoring)",
    },
    {
        "tag":           "service_alerts",
        "name":          "SF 511 – Muni Service Alerts",
        "url":           (
            f"{_511_BASE}/transit/servicealerts"
            f"?api_key={_511_API_KEY}&format=json&agency={SF_OPERATOR}"
        ),
        "path_to_data":  "Entities",   # records are under Entities key
        "description":   "Active SF Muni service alerts",
    },
]


# ── Nexla helpers ──────────────────────────────────────────────────────────────

def _nexla_client() -> NexlaClient:
    """
    Return an authenticated NexlaClient.

    Checks two env vars (in priority order):
      NEXLA_ACCESS_TOKEN  – a session/access token obtained from the Nexla UI
                            or API; passed directly as `access_token`.
      NEXLA_SERVICE_KEY   – a long-lived service key created under
                            Settings › Authentication; the SDK exchanges it
                            for a session token automatically.

    If you have a session token, prefer NEXLA_ACCESS_TOKEN.
    """
    access_token = os.environ.get("NEXLA_ACCESS_TOKEN", "")
    service_key  = os.environ.get("NEXLA_SERVICE_KEY", "")

    if not access_token and not service_key:
        raise EnvironmentError(
            "No Nexla credentials found. Set one of:\n"
            "  export NEXLA_ACCESS_TOKEN=<session-token>   # session / access token\n"
            "  export NEXLA_SERVICE_KEY=<service-key>      # long-lived service key"
        )

    kwargs: dict = {}
    if access_token:
        kwargs["access_token"] = access_token
    else:
        kwargs["service_key"] = service_key

    api_url = os.environ.get("NEXLA_API_URL", "")
    if api_url:
        kwargs["api_url"] = api_url

    return NexlaClient(**kwargs)


def _get_or_create_credential(client: NexlaClient) -> str:
    """
    Return the ID of the Nexla credential used for 511 sources.
    The 511 API key is embedded in each URL, so we register a no-auth REST
    credential — this satisfies Nexla's requirement without duplicating the key.
    """
    for cred in client.credentials.list():
        if cred.name == NEXLA_CREDENTIAL_NAME:
            print(f"  [nexla] reusing credential '{NEXLA_CREDENTIAL_NAME}' (id={cred.id})")
            return str(cred.id)

    print(f"  [nexla] creating credential '{NEXLA_CREDENTIAL_NAME}' …")
    cred = client.credentials.create(
        CredentialCreate(
            name=NEXLA_CREDENTIAL_NAME,
            credentials_type="rest",
            credentials={
                "auth.type": "NONE",
                "test.url":  f"{_511_BASE}/traffic/events?api_key={_511_API_KEY}&format=json",
            },
        )
    )
    return str(cred.id)


def _find_existing_source(client: NexlaClient, name: str):
    """Return the source object whose name matches, or None."""
    for source in client.sources.list():
        if source.name == name:
            return source
    return None


def _get_or_create_nexset(client: NexlaClient, source_id: int, name: str):
    """
    Return the nexset linked to source_id, creating it if it doesn't exist.

    Nexla does NOT auto-create nexsets when a source is activated — they must
    be created explicitly via POST /data_sets with data_source_id.
    The SDK's NexsetCreate uses parent_data_set_id (for derived nexsets), so
    we pass a raw dict which BaseResource.create also accepts.
    """
    # Check if one already exists on the source
    source = client.sources.get(source_id, expand=True)
    if source.data_sets:
        ds = source.data_sets[0]
        print(f"  [nexla] reusing nexset id={ds.id} for source {source_id}")
        return ds

    # Also scan the global list (catches nexsets created outside this script)
    for nexset in client.nexsets.list():
        if nexset.data_source_id == source_id:
            print(f"  [nexla] found nexset id={nexset.id} for source {source_id}")
            return nexset

    # Create one explicitly
    print(f"  [nexla] creating nexset for source {source_id} …")
    nexset = client.nexsets.create(
        {"name": name, "data_source_id": source_id, "has_custom_transform": False}
    )
    print(f"  [nexla] created nexset id={nexset.id}")
    return nexset


def _provision_source(client: NexlaClient, cred_id: str, defn: dict) -> str:
    """
    Ensure a Nexla REST API source for `defn` exists, has the correct URL,
    and is active. Deletes and recreates the source if its URL has drifted.
    Returns the nexset ID so we can read data from it.
    """
    source = _find_existing_source(client, defn["name"])

    if source is not None:
        cfg = source.source_config or {}
        if source.source_type != "rest" or cfg.get("url") != defn["url"] or cfg.get("path_to_data") != defn["path_to_data"]:
            print(f"  [nexla] source '{defn['name']}' config changed — deleting id={source.id} …")
            if source.status == "ACTIVE":
                client.sources.pause(source.id)
            client.sources.delete(source.id)
            source = None
        else:
            print(f"  [nexla] reusing source '{defn['name']}' (id={source.id})")

    if source is None:
        print(f"  [nexla] creating source '{defn['name']}' …")
        source_config: dict = {
            "url":    defn["url"],
            "method": "GET",
            "headers": {"Accept": "application/json"},
        }
        if defn["path_to_data"]:
            source_config["path_to_data"] = defn["path_to_data"]
        source = client.sources.create(
            SourceCreate(
                name=defn["name"],
                source_type="rest",
                data_credentials_id=int(cred_id),
                source_config=source_config,
            )
        )
        print(f"  [nexla] activating source id={source.id} …")
        client.sources.activate(source.id)

    nexset = _get_or_create_nexset(client, source.id, defn["name"])
    print(f"  [nexla] nexset id={nexset.id} ready for '{defn['name']}'")
    return str(nexset.id)


def _fetch_511(url: str, path_to_data: str) -> list:
    """
    Fetch from a 511 API endpoint and extract the records array using
    the dot-separated path_to_data key path.
    """
    resp = requests.get(url, timeout=30)
    data = json.loads(resp.text.lstrip("\ufeff"))

    if not path_to_data:
        return data if isinstance(data, list) else [data]

    for key in path_to_data.split("."):
        if isinstance(data, dict):
            data = data.get(key, [])
        else:
            return []

    return data if isinstance(data, list) else ([data] if data else [])


# ── Normalizers ────────────────────────────────────────────────────────────────

# SF bounding box used for post-fetch filtering (lon_min, lat_min, lon_max, lat_max)
_SF_LON_MIN, _SF_LAT_MIN, _SF_LON_MAX, _SF_LAT_MAX = -122.5247, 37.7081, -122.3573, 37.8124


def _in_sf(coords) -> bool:
    """Return True if a GeoJSON coordinate pair [lon, lat] falls within SF bbox."""
    if not coords:
        return True  # no location data — include by default
    try:
        # coords may be [lon, lat] (Point) or [[lon, lat], ...] (LineString)
        pair = coords[0] if isinstance(coords[0], list) else coords
        lon, lat = float(pair[0]), float(pair[1])
        return _SF_LON_MIN <= lon <= _SF_LON_MAX and _SF_LAT_MIN <= lat <= _SF_LAT_MAX
    except (IndexError, TypeError, ValueError):
        return True


def _normalize_traffic_event(record: dict) -> dict | None:
    """Returns None if the event falls outside the SF bounding box."""
    roads = record.get("roads") or [{}]
    geo   = record.get("geography") or {}
    coords = geo.get("coordinates")
    if not _in_sf(coords):
        return None
    return {
        "id":          record.get("id"),
        "type":        record.get("event_type"),
        "subtype":     record.get("event_subtypes"),
        "headline":    record.get("headline"),
        "description": record.get("description"),
        "severity":    record.get("severity"),
        "status":      record.get("status"),
        "road_name":   roads[0].get("name") if roads else None,
        "direction":   roads[0].get("direction") if roads else None,
        "location": {
            "type":        geo.get("type"),
            "coordinates": geo.get("coordinates"),
        },
        "created":     record.get("created"),
        "updated":     record.get("updated"),
        "start_time":  record.get("schedule", {}).get("start_time"),
        "end_time":    record.get("schedule", {}).get("end_time"),
        "source":      "nexla:511_traffic_events",
    }


def _normalize_work_zone(record: dict) -> dict | None:
    props    = record.get("properties") or {}
    geometry = record.get("geometry")   or {}
    if not _in_sf(geometry.get("coordinates")):
        return None
    return {
        "id":          props.get("road_event_id"),
        "type":        "work_zone",
        "road_name":   props.get("road_name"),
        "direction":   props.get("direction"),
        "description": props.get("description"),
        "status":      props.get("event_status"),
        "start_date":  props.get("start_date"),
        "end_date":    props.get("end_date"),
        "location": {
            "type":        geometry.get("type"),
            "coordinates": geometry.get("coordinates"),
        },
        "source": "nexla:511_wzdx",
    }


def _normalize_vehicle(record: dict) -> dict:
    journey  = record.get("MonitoredVehicleJourney") or {}
    loc      = journey.get("VehicleLocation") or {}
    lat      = loc.get("Latitude")
    lon      = loc.get("Longitude")
    return {
        "vehicle_ref":          journey.get("VehicleRef"),
        "line_ref":             journey.get("LineRef"),
        "published_line_name":  journey.get("PublishedLineName"),
        "direction_ref":        journey.get("DirectionRef"),
        "destination":          journey.get("DestinationName"),
        "origin_name":          journey.get("OriginName"),
        "occupancy":            journey.get("Occupancy"),
        "operator_id":          SF_OPERATOR,
        "operator_name":        "SF Muni (SFMTA)",
        "location": {
            "type":        "Point",
            "coordinates": [float(lon), float(lat)] if lat and lon else None,
            "latitude":    float(lat) if lat else None,
            "longitude":   float(lon) if lon else None,
        },
        "recorded_at": record.get("RecordedAtTime"),
        "source":      "nexla:511_vehicle_monitoring",
    }


def _normalize_stop_departure(record: dict) -> dict:
    journey = record.get("MonitoredVehicleJourney") or {}
    call    = journey.get("MonitoredCall") or {}
    dist    = (call.get("Extensions") or {}).get("Distances") or {}
    return {
        "stop_point_ref":        call.get("StopPointRef"),
        "stop_point_name":       call.get("StopPointName"),
        "line_ref":              journey.get("LineRef"),
        "published_line_name":   journey.get("PublishedLineName"),
        "direction_ref":         journey.get("DirectionRef"),
        "destination":           journey.get("DestinationName"),
        "vehicle_ref":           journey.get("VehicleRef"),
        "operator_id":           SF_OPERATOR,
        "operator_name":         "SF Muni (SFMTA)",
        "aimed_departure_time":  call.get("AimedDepartureTime"),
        "expected_departure_time": call.get("ExpectedDepartureTime"),
        "aimed_arrival_time":    call.get("AimedArrivalTime"),
        "expected_arrival_time": call.get("ExpectedArrivalTime"),
        "distance_from_stop":    dist.get("DistanceFromStop"),
        "recorded_at":           record.get("RecordedAtTime"),
        "source":                "nexla:511_stop_monitoring",
    }


def _normalize_alert(record: dict) -> dict:
    return {**record, "operator_id": SF_OPERATOR, "source": "nexla:511_service_alerts"}


_NORMALIZERS = {
    "traffic_events":   _normalize_traffic_event,
    "work_zones":       _normalize_work_zone,
    "vehicle_positions": _normalize_vehicle,
    "stop_departures":  _normalize_stop_departure,
    "service_alerts":   _normalize_alert,
}


# ── Public API ─────────────────────────────────────────────────────────────────

def get_traffic_and_transport() -> dict:
    """
    Provision Nexla REST API sources for the 511 SF Bay feeds (idempotent),
    read the ingested records from each nexset, and return a unified dict.

    Returns:
        {
            "traffic": {
                "events":     [...],   # active traffic incidents / congestion
                "work_zones": [...],   # active road construction / closures
            },
            "transit": {
                "vehicle_positions": [...],  # live Muni vehicle locations
                "stop_departures":   [...],  # real-time departure predictions
                "service_alerts":    [...],  # active service alerts
            },
            "meta": {
                "operator_id":   "SF",
                "operator_name": "SF Muni (SFMTA)",
                "bbox":          "<SF bounding box>",
                "ingested_via":  "511 API (live) + Nexla REST sources (scheduled)",
                "nexset_ids":    { "<tag>": "<nexset_id>", ... },
            }
        }
    """
    print("Initialising Nexla client …")
    client = _nexla_client()

    print("Provisioning Nexla credential …")
    cred_id = _get_or_create_credential(client)

    # Provision Nexla sources and nexsets (pipeline governance)
    nexset_ids: dict[str, str] = {}
    print("Provisioning Nexla sources …")
    for defn in NEXLA_SOURCE_DEFS:
        nexset_ids[defn["tag"]] = _provision_source(client, cred_id, defn)

    # Fetch live data from 511 and normalise
    # Nexla's scheduled runs will independently ingest these same endpoints
    # on their own schedule — nexset_ids in meta show where that data lands.
    raw: dict[str, list] = {}
    print("Fetching live data from 511 …")
    for defn in NEXLA_SOURCE_DEFS:
        tag = defn["tag"]
        print(f"  [{tag}] …")
        records = _fetch_511(defn["url"], defn["path_to_data"])
        normalizer = _NORMALIZERS[tag]
        raw[tag] = [n for r in records if (n := normalizer(r)) is not None]

    result = {
        "traffic": {
            "events":     raw["traffic_events"],
            "work_zones": raw["work_zones"],
        },
        "transit": {
            "vehicle_positions": raw["vehicle_positions"],
            "stop_departures":   raw["stop_departures"],
            "service_alerts":    raw["service_alerts"],
        },
        "meta": {
            "operator_id":   SF_OPERATOR,
            "operator_name": "SF Muni (SFMTA)",
            "bbox":          SF_BBOX,
            "ingested_via":  "511 API (live) + Nexla REST sources (scheduled)",
            "nexset_ids":    nexset_ids,
        },
    }

    print(
        f"\nDone. Records ingested via Nexla:"
        f"\n  Traffic events    : {len(raw['traffic_events'])}"
        f"\n  Work zones        : {len(raw['work_zones'])}"
        f"\n  Vehicle positions : {len(raw['vehicle_positions'])}"
        f"\n  Stop departures   : {len(raw['stop_departures'])}"
        f"\n  Service alerts    : {len(raw['service_alerts'])}"
    )
    return result


if __name__ == "__main__":
    import sys
    from datetime import datetime

    output_file = (
        sys.argv[1]
        if len(sys.argv) > 1
        else f"sf_traffic_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    )
    data = get_traffic_and_transport()
    with open(output_file, "w") as f:
        json.dump(data, f, indent=2)
    print(f"Output written to {output_file}")
