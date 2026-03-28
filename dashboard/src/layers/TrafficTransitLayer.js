/**
 * TrafficTransitLayer — Shows Muni transit vehicles, work zones, and traffic events.
 *
 * Data sources pushed via WebSocket:
 *   - transit (type: "transit") → Muni vehicle positions as colored dots
 *   - traffic (type: "traffic") → Work zones as orange dashed lines
 *   - traffic_events (type: "traffic_events") → Active traffic incidents as red/yellow markers
 */

import { DataLayer } from '../world/DataLayer.js';
import { ICON_IDS } from '../emojiIcons.js';
import mapboxgl from 'mapbox-gl';

const OCCUPANCY_OPACITY = {
  full: 1.0,
  standingAvailable: 0.8,
  seatsAvailable: 0.65,
  unknown: 0.5,
};

const MUNI_RAIL_LINES = new Set(['J', 'K', 'L', 'M', 'N', 'T', 'F', 'PM', 'PH']);

function transitIcon(lineRef) {
  return MUNI_RAIL_LINES.has(String(lineRef).toUpperCase()) ? ICON_IDS.tram : ICON_IDS.bus;
}

function trafficEventIcon(type) {
  const upper = String(type).toUpperCase();
  if (upper.includes('CONSTRUCTION')) return ICON_IDS.construction;
  if (upper.includes('CONGESTION')) return ICON_IDS.congestion;
  if (upper.includes('INCIDENT')) return ICON_IDS.incident;
  if (upper.includes('ROAD_CLOSURE')) return ICON_IDS.road_closure;
  if (upper.includes('SPECIAL_EVENT')) return ICON_IDS.special_event;
  return ICON_IDS.warning;
}

const TRAFFIC_SEVERITY_COLORS = {
  Major: '#ef4444',
  Severe: '#ef4444',
  Minor: '#f59e0b',
  Unknown: '#6b7280',
};

export class TrafficTransitLayer extends DataLayer {
  constructor() {
    super({ id: 'traffic-transit', name: 'Traffic & Transit', icon: '🚌', pollInterval: 999999 });
    this.vehicles = [];
    this.workZones = [];
    this.trafficEvents = [];
  }

  async fetch() { return null; }
  ingest() {}

  /** Called from main.js when WS pushes transit vehicle data */
  ingestTransit(data) {
    this.vehicles = data || [];
    this.count = this.vehicles.length;
    if (this.map) this.render(this.map);
  }

  /** Called from main.js when WS pushes work zone data */
  ingestTraffic(data) {
    this.workZones = data || [];
    if (this.map) this.render(this.map);
  }

  /** Called from main.js when WS pushes traffic event data */
  ingestTrafficEvents(data) {
    this.trafficEvents = data || [];
    if (this.map) this.render(this.map);
  }

  setupLayers(map) {
    // ── Work Zone sources & layers ──
    map.addSource('traffic-work-zones', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });

    map.addLayer({
      id: 'work-zone-lines',
      type: 'line',
      source: 'traffic-work-zones',
      filter: ['==', ['geometry-type'], 'LineString'],
      paint: {
        'line-color': '#f97316',
        'line-width': 3,
        'line-dasharray': [2, 2],
        'line-opacity': 0.7,
      },
    });

    map.addLayer({
      id: 'work-zone-points',
      type: 'circle',
      source: 'traffic-work-zones',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': 5,
        'circle-color': '#f97316',
        'circle-opacity': 0.7,
        'circle-stroke-width': 1,
        'circle-stroke-color': 'rgba(0,0,0,0.4)',
      },
    });

    // ── Transit vehicle sources & layers ──
    map.addSource('transit-vehicles', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });

    map.addLayer({
      id: 'transit-vehicle-glow',
      type: 'circle',
      source: 'transit-vehicles',
      paint: {
        'circle-radius': 10,
        'circle-color': ['get', 'color'],
        'circle-opacity': ['*', ['get', 'opacity'], 0.15],
        'circle-blur': 0.8,
      },
    });

    map.addLayer({
      id: 'transit-vehicle-dots',
      type: 'circle',
      source: 'transit-vehicles',
      paint: {
        'circle-radius': 5,
        'circle-color': ['get', 'color'],
        'circle-opacity': ['get', 'opacity'],
        'circle-stroke-width': 1,
        'circle-stroke-color': 'rgba(0,0,0,0.4)',
      },
    });

    map.addLayer({
      id: 'transit-vehicle-emoji',
      type: 'symbol',
      source: 'transit-vehicles',
      layout: {
        'icon-image': ['get', 'icon'],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.35, 15, 0.6],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
      paint: { 'icon-opacity': 0.9 },
    });

    map.addLayer({
      id: 'transit-vehicle-labels',
      type: 'symbol',
      source: 'transit-vehicles',
      minzoom: 14,
      layout: {
        'text-field': ['get', 'line_ref'],
        'text-size': 10,
        'text-offset': [0, 1.5],
        'text-anchor': 'top',
        'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
        'text-allow-overlap': false,
      },
      paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': 'rgba(0,0,0,0.8)',
        'text-halo-width': 1,
        'text-opacity': 0.8,
      },
    });

    // ── Bearing indicator lines ──
    map.addSource('transit-bearing', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });

    map.addLayer({
      id: 'transit-bearing-lines',
      type: 'line',
      source: 'transit-bearing',
      minzoom: 14,
      paint: {
        'line-color': ['get', 'color'],
        'line-width': 1.5,
        'line-opacity': 0.5,
      },
    });

    // ── Traffic events source & layers ──
    map.addSource('traffic-events', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });

    map.addLayer({
      id: 'traffic-event-glow',
      type: 'circle',
      source: 'traffic-events',
      paint: {
        'circle-radius': 12,
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.12,
        'circle-blur': 0.8,
      },
    });

    map.addLayer({
      id: 'traffic-event-dots',
      type: 'circle',
      source: 'traffic-events',
      paint: {
        'circle-radius': 6,
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.85,
        'circle-stroke-width': 1.5,
        'circle-stroke-color': 'rgba(0,0,0,0.5)',
      },
    });

    map.addLayer({
      id: 'traffic-event-emoji',
      type: 'symbol',
      source: 'traffic-events',
      layout: {
        'icon-image': ['get', 'icon'],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.4, 15, 0.65],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
      paint: { 'icon-opacity': 0.9 },
    });

    map.addLayer({
      id: 'traffic-event-labels',
      type: 'symbol',
      source: 'traffic-events',
      minzoom: 13,
      layout: {
        'text-field': ['get', 'headline'],
        'text-size': 9,
        'text-offset': [0, 1.8],
        'text-anchor': 'top',
        'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
        'text-max-width': 10,
      },
      paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': 'rgba(0,0,0,0.8)',
        'text-halo-width': 1,
        'text-opacity': 0.7,
      },
    });

    // ── Click handlers ──

    // Traffic event click
    map.on('click', 'traffic-event-dots', (e) => {
      const p = e.features[0].properties;
      new mapboxgl.Popup({ offset: 10, maxWidth: '300px' })
        .setLngLat(e.features[0].geometry.coordinates)
        .setHTML(`
          <div class="popup-title" style="color:${p.color};">${(p.type || 'TRAFFIC').toUpperCase()}</div>
          <div style="font-size:10px;color:rgba(255,255,255,0.7);margin-bottom:4px;">${p.headline || ''}</div>
          <div class="popup-row"><span class="popup-label">Road</span><span class="popup-value">${p.road_name || '—'}</span></div>
          <div class="popup-row"><span class="popup-label">Severity</span><span class="popup-value">${p.severity || '—'}</span></div>
          <div class="popup-row"><span class="popup-label">Status</span><span class="popup-value">${p.status || '—'}</span></div>
          ${p.description ? `<div style="font-size:10px;color:rgba(255,255,255,0.5);margin-top:4px;line-height:1.3;">${p.description}</div>` : ''}
        `).addTo(map);
    });

    // Work zone click
    map.on('click', 'work-zone-lines', (e) => {
      const p = e.features[0].properties;
      new mapboxgl.Popup({ offset: 10, maxWidth: '280px' })
        .setLngLat(e.lngLat)
        .setHTML(`
          <div class="popup-title" style="color:#f97316;">WORK ZONE</div>
          <div class="popup-row"><span class="popup-label">Road</span><span class="popup-value">${p.road_name || '—'}</span></div>
          <div class="popup-row"><span class="popup-label">Direction</span><span class="popup-value">${p.direction || '—'}</span></div>
          <div class="popup-row"><span class="popup-label">Description</span><span class="popup-value">${p.description || '—'}</span></div>
          <div class="popup-row"><span class="popup-label">Status</span><span class="popup-value">${p.status || '—'}</span></div>
          <div class="popup-row"><span class="popup-label">Start</span><span class="popup-value">${p.start_date ? new Date(p.start_date).toLocaleDateString() : '—'}</span></div>
          <div class="popup-row"><span class="popup-label">End</span><span class="popup-value">${p.end_date ? new Date(p.end_date).toLocaleDateString() : '—'}</span></div>
        `).addTo(map);
    });

    map.on('click', 'work-zone-points', (e) => {
      const p = e.features[0].properties;
      new mapboxgl.Popup({ offset: 10, maxWidth: '280px' })
        .setLngLat(e.lngLat)
        .setHTML(`
          <div class="popup-title" style="color:#f97316;">WORK ZONE</div>
          <div class="popup-row"><span class="popup-label">Road</span><span class="popup-value">${p.road_name || '—'}</span></div>
          <div class="popup-row"><span class="popup-label">Description</span><span class="popup-value">${p.description || '—'}</span></div>
          <div class="popup-row"><span class="popup-label">Status</span><span class="popup-value">${p.status || '—'}</span></div>
        `).addTo(map);
    });

    // Transit vehicle click
    map.on('click', 'transit-vehicle-dots', (e) => {
      const p = e.features[0].properties;
      const ts = p.timestamp ? new Date(p.timestamp).toLocaleTimeString('en-US', { hour12: false }) : '—';
      new mapboxgl.Popup({ offset: 10, maxWidth: '260px' })
        .setLngLat(e.features[0].geometry.coordinates)
        .setHTML(`
          <div class="popup-title" style="color:${p.color};">MUNI ${p.line_name || p.line_ref || '?'}</div>
          <div class="popup-row"><span class="popup-label">Vehicle</span><span class="popup-value">${p.vehicle_ref || '—'}</span></div>
          <div class="popup-row"><span class="popup-label">Destination</span><span class="popup-value">${p.destination || '—'}</span></div>
          <div class="popup-row"><span class="popup-label">Direction</span><span class="popup-value">${p.direction || '—'}</span></div>
          <div class="popup-row"><span class="popup-label">Occupancy</span><span class="popup-value">${p.occupancy || '—'}</span></div>
          <div class="popup-row"><span class="popup-label">Bearing</span><span class="popup-value">${p.bearing ? Math.round(p.bearing) + '°' : '—'}</span></div>
          <div class="popup-row"><span class="popup-label">Updated</span><span class="popup-value">${ts}</span></div>
        `).addTo(map);
    });

    // Cursor changes
    for (const layerId of ['work-zone-lines', 'work-zone-points', 'transit-vehicle-dots', 'traffic-event-dots']) {
      map.on('mouseenter', layerId, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', layerId, () => { map.getCanvas().style.cursor = ''; });
    }
  }

  render(map) {
    // ── Work zones GeoJSON ──
    const wzFeatures = [];
    for (const wz of this.workZones) {
      if (!wz.coordinates || wz.coordinates.length === 0) continue;
      let geometry;
      if (wz.geometry_type === 'LineString') {
        geometry = { type: 'LineString', coordinates: wz.coordinates };
      } else if (wz.geometry_type === 'MultiPoint') {
        // Render each point separately
        for (const coord of wz.coordinates) {
          wzFeatures.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: coord },
            properties: { ...wz, coordinates: undefined },
          });
        }
        continue;
      } else if (wz.geometry_type === 'Point') {
        geometry = { type: 'Point', coordinates: wz.coordinates };
      } else {
        // Try to guess: array of arrays = LineString, else Point
        if (Array.isArray(wz.coordinates[0])) {
          geometry = { type: 'LineString', coordinates: wz.coordinates };
        } else {
          geometry = { type: 'Point', coordinates: wz.coordinates };
        }
      }
      wzFeatures.push({
        type: 'Feature',
        geometry,
        properties: { ...wz, coordinates: undefined },
      });
    }

    const wzGeoJSON = { type: 'FeatureCollection', features: wzFeatures };
    if (map.getSource('traffic-work-zones')) {
      map.getSource('traffic-work-zones').setData(wzGeoJSON);
    }

    // ── Transit vehicles GeoJSON ──
    const vFeatures = [];
    const bearingFeatures = [];

    for (const v of this.vehicles) {
      if (!v.lat || !v.lon) continue;
      const opacity = OCCUPANCY_OPACITY[v.occupancy] || 0.5;

      vFeatures.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [v.lon, v.lat] },
        properties: { ...v, opacity, icon: transitIcon(v.line_ref) },
      });

      // Bearing indicator (short line from vehicle in direction of travel)
      if (v.bearing) {
        const bearingRad = (v.bearing * Math.PI) / 180;
        const dist = 0.0003; // ~30m
        const endLat = v.lat + dist * Math.cos(bearingRad);
        const endLon = v.lon + dist * Math.sin(bearingRad) / Math.cos(v.lat * Math.PI / 180);
        bearingFeatures.push({
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [[v.lon, v.lat], [endLon, endLat]],
          },
          properties: { color: v.color },
        });
      }
    }

    const vGeoJSON = { type: 'FeatureCollection', features: vFeatures };
    if (map.getSource('transit-vehicles')) {
      map.getSource('transit-vehicles').setData(vGeoJSON);
    }

    const bGeoJSON = { type: 'FeatureCollection', features: bearingFeatures };
    if (map.getSource('transit-bearing')) {
      map.getSource('transit-bearing').setData(bGeoJSON);
    }

    // ── Traffic events GeoJSON ──
    const teFeatures = [];
    for (const te of this.trafficEvents) {
      if (!te.lat || !te.lon) continue;
      teFeatures.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [te.lon, te.lat] },
        properties: {
          id: te.id,
          type: te.type || 'unknown',
          subtype: te.subtype || '',
          headline: te.headline || '',
          description: te.description || '',
          severity: te.severity || 'unknown',
          status: te.status || '',
          road_name: te.road_name || '',
          direction: te.direction || '',
          created: te.created || '',
          updated: te.updated || '',
          color: TRAFFIC_SEVERITY_COLORS[te.severity] || '#f59e0b',
          icon: trafficEventIcon(te.type),
        },
      });
    }
    const teGeoJSON = { type: 'FeatureCollection', features: teFeatures };
    if (map.getSource('traffic-events')) {
      map.getSource('traffic-events').setData(teGeoJSON);
    }
  }

  getMapLayerIds() {
    return [
      'work-zone-lines', 'work-zone-points',
      'transit-vehicle-glow', 'transit-vehicle-dots', 'transit-vehicle-emoji', 'transit-vehicle-labels',
      'transit-bearing-lines',
      'traffic-event-glow', 'traffic-event-dots', 'traffic-event-emoji', 'traffic-event-labels',
    ];
  }
}
