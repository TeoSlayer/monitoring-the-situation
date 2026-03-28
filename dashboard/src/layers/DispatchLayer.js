import { DataLayer } from '../world/DataLayer.js';
import { FIRE_DISPATCH_API, POLICE_DISPATCH_API } from '../config.js';
import { ICON_IDS } from '../emojiIcons.js';
import mapboxgl from 'mapbox-gl';

function classify(callType) {
  const ct = (callType || '').toLowerCase();
  if (ct.includes('fire') || ct.includes('alarm') || ct.includes('smoke')) return 'fire';
  if (ct.includes('medical') || ct.includes('medic') || ct.includes('ems') || ct.includes('injury') || ct.includes('unconscious') || ct.includes('breathing')) return 'medical';
  return 'police';
}

function typeColor(t) {
  return t === 'fire' ? '#f97316' : t === 'medical' ? '#3b82f6' : '#eab308';
}


export class DispatchLayer extends DataLayer {
  constructor() {
    super({ id: 'dispatch', name: 'Dispatch', icon: '🚨', pollInterval: 999999 }); // Backend pushes via WS
    this.incidents = [];
    this.timeWindowMinutes = 5;
  }

  // Data comes from WebSocket backend, not direct polling
  async fetch() { return null; }

  ingest(raw) {
    if (!raw) return;
    const events = [];
    const cutoff = Date.now() - this.timeWindowMinutes * 60000;

    for (const ev of (raw.fire || [])) {
      if (!ev.point) continue;
      const coords = ev.point.coordinates || [parseFloat(ev.point.longitude), parseFloat(ev.point.latitude)];
      if (!coords[0] || !coords[1]) continue;
      const ts = new Date(ev.received_timestamp).getTime();
      if (ts < cutoff) continue;

      const type = classify(ev.call_type);
      const age = (Date.now() - ts) / 60000;
      const incident = {
        id: `fire-${ev.call_number || Math.random()}`,
        type, color: typeColor(type),
        lon: coords[0], lat: coords[1],
        callType: ev.call_type || 'Unknown',
        address: ev.address || '',
        timestamp: ev.received_timestamp || '',
        priority: ev.priority || '',
        units: ev.unit_id || '',
        status: ev.call_final_disposition || '',
        severity: ev.priority === '1' || ev.priority === 'E' ? 3 : ev.priority === '2' ? 2 : 1,
        opacity: Math.max(0.3, 1 - (age / this.timeWindowMinutes)),
        radius: ev.priority === '1' || ev.priority === 'E' ? 7 : 5,
      };
      events.push(incident);

      if (this.world) {
        this.world.addEvent({
          id: incident.id, type: incident.type, subtype: ev.call_type,
          lat: incident.lat, lon: incident.lon, time: ts,
          severity: incident.severity, source: 'dispatch',
          properties: { callType: incident.callType, address: incident.address, units: incident.units, summary: `${incident.callType} at ${incident.address}` },
        });
      }
    }

    for (const ev of (raw.police || [])) {
      const lat = parseFloat(ev.latitude);
      const lon = parseFloat(ev.longitude);
      if (!lat || !lon) continue;
      const ts = new Date(ev.call_date_time).getTime();
      if (ts < cutoff) continue;

      const age = (Date.now() - ts) / 60000;
      const incident = {
        id: `police-${ev.cad_number || Math.random()}`,
        type: 'police', color: typeColor('police'),
        lon, lat,
        callType: ev.call_type_final_desc || ev.call_type_original_desc || 'Unknown',
        address: ev.intersection_point || '',
        timestamp: ev.call_date_time || '',
        priority: ev.priority || '',
        units: '', status: ev.disposition || '',
        severity: ev.priority === 'A' ? 3 : ev.priority === 'B' ? 2 : 1,
        opacity: Math.max(0.3, 1 - (age / this.timeWindowMinutes)),
        radius: ev.priority === 'A' ? 7 : 5,
      };
      events.push(incident);

      if (this.world) {
        this.world.addEvent({
          id: incident.id, type: 'police', subtype: incident.callType,
          lat, lon, time: ts, severity: incident.severity, source: 'dispatch',
          properties: { callType: incident.callType, address: incident.address, summary: `${incident.callType} at ${incident.address}` },
        });
      }
    }

    this.incidents = events;
    this.count = events.length;
  }

  /** Called by main.js when WebSocket pushes dispatch data */
  ingestFromWS(events) {
    this.incidents = events.map(ev => {
      // Register in world state
      if (this.world && ev.lat && ev.lon) {
        this.world.addEvent({
          id: ev.id,
          type: ev.type || 'other',
          subtype: ev.callType,
          lat: ev.lat,
          lon: ev.lon,
          time: ev.timestamp ? new Date(ev.timestamp).getTime() : Date.now(),
          severity: ev.severity || 1,
          source: 'dispatch',
          properties: {
            callType: ev.callType,
            address: ev.address,
            summary: `${ev.callType} at ${ev.address}`,
          },
        });
      }
      return {
        ...ev,
        radius: ev.severity >= 3 ? 7 : 5,
        opacity: ev.opacity || 0.8,
        color: ev.color || '#6b7280',
      };
    });
    this.count = this.incidents.length;
    if (this.map) this.render(this.map);
  }

  setupLayers(map) {
    map.addSource('dispatch', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

    map.addLayer({
      id: 'dispatch-glow', type: 'circle', source: 'dispatch',
      paint: { 'circle-radius': ['*', ['get', 'radius'], 2.5], 'circle-color': ['get', 'color'], 'circle-opacity': ['*', ['get', 'opacity'], 0.12], 'circle-blur': 1 },
    });
    map.addLayer({
      id: 'dispatch-dots', type: 'circle', source: 'dispatch',
      paint: { 'circle-radius': ['get', 'radius'], 'circle-color': ['get', 'color'], 'circle-opacity': ['get', 'opacity'], 'circle-stroke-width': 1, 'circle-stroke-color': 'rgba(0,0,0,0.4)' },
    });

    map.addLayer({
      id: 'dispatch-emoji', type: 'symbol', source: 'dispatch',
      layout: {
        'icon-image': ['get', 'icon'],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.4, 15, 0.65],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
      paint: { 'icon-opacity': 0.9 },
    });

    map.on('click', 'dispatch-dots', (e) => {
      const p = e.features[0].properties;
      const time = p.timestamp ? new Date(p.timestamp).toLocaleTimeString() : '—';
      new mapboxgl.Popup({ offset: 10 })
        .setLngLat(e.features[0].geometry.coordinates)
        .setHTML(`
          <div class="popup-title">${p.callType}</div>
          <div class="popup-row"><span class="popup-label">Address</span><span class="popup-value">${p.address || '—'}</span></div>
          <div class="popup-row"><span class="popup-label">Time</span><span class="popup-value">${time}</span></div>
          <div class="popup-row"><span class="popup-label">Priority</span><span class="popup-value">${p.priority || '—'}</span></div>
          <div class="popup-row"><span class="popup-label">Units</span><span class="popup-value">${p.units || '—'}</span></div>
          <div class="popup-row"><span class="popup-label">Status</span><span class="popup-value">${p.status || '—'}</span></div>
        `).addTo(map);
    });
    map.on('mouseenter', 'dispatch-dots', () => map.getCanvas().style.cursor = 'pointer');
    map.on('mouseleave', 'dispatch-dots', () => map.getCanvas().style.cursor = '');
  }

  render(map) {
    const geojson = {
      type: 'FeatureCollection',
      features: this.incidents.map(ev => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [ev.lon, ev.lat] },
        properties: { ...ev, icon: ICON_IDS[ev.type] || ICON_IDS.other },
      })),
    };
    if (map.getSource('dispatch')) map.getSource('dispatch').setData(geojson);
  }

  getMapLayerIds() { return ['dispatch-dots', 'dispatch-glow', 'dispatch-emoji']; }
}
