/**
 * RadioIncidentLayer — Shows enriched radio incidents on the map.
 *
 * Displays geocoded radio transmissions as glowing dots, color-coded by
 * incident type. Click for full detail popup with Gemini analysis,
 * addresses, units, and code translations.
 */

import { DataLayer } from '../world/DataLayer.js';
import { ICON_IDS } from '../emojiIcons.js';
import mapboxgl from 'mapbox-gl';

const TYPE_COLORS = {
  fire: '#f97316',
  medical: '#3b82f6',
  police: '#eab308',
  traffic: '#a78bfa',
  maritime: '#06b6d4',
  other: '#6b7280',
};

const TYPE_EMOJI = {
  fire: '🔥',
  medical: '🚑',
  police: '🚔',
  traffic: '🚗',
  maritime: '⚓',
  other: '📻',
};

const SEV_RADIUS = {
  critical: 10,
  high: 8,
  medium: 6,
  low: 4,
};

export class RadioIncidentLayer extends DataLayer {
  constructor() {
    super({ id: 'radio-incidents', name: 'Radio Incidents', icon: '📻', pollInterval: 999999 });
    this.incidents = [];
  }

  async fetch() { return null; }
  ingest() {}

  /**
   * Called when enrichment data arrives for a radio message.
   * Only adds to map if coordinates are available.
   */
  addEnrichedMessage(msg) {
    const enrichment = msg.enrichment;
    if (!enrichment?.coordinates) return;

    const { lat, lng } = enrichment.coordinates;
    if (!lat || !lng) return;

    // Check for duplicate (same id)
    const existingIdx = this.incidents.findIndex(i => i.id === msg.id);

    const incident = {
      id: msg.id,
      lat,
      lon: lng,
      type: enrichment.incident_type || 'other',
      severity: enrichment.severity || 'low',
      color: TYPE_COLORS[enrichment.incident_type] || TYPE_COLORS.other,
      radius: SEV_RADIUS[enrichment.severity] || 4,
      analysis: enrichment.analysis || '',
      addresses: enrichment.addresses || [],
      pois: enrichment.pois || [],
      units: enrichment.units || [],
      code_translations: enrichment.code_translations || {},
      is_actionable: enrichment.is_actionable || false,
      // Original message fields
      talkgroup_tag: msg.talkgroup_tag || '',
      talkgroup_group: msg.talkgroup_group || '',
      transcript: msg.transcript || '',
      timestamp: msg.timestamp || '',
      duration: msg.duration || 0,
      sources: msg.sources || [],
      encrypted: msg.encrypted || false,
      emergency: msg.emergency || false,
      freq: msg.freq || 0,
      groupColor: msg.color || '#6b7280',
      emoji: TYPE_EMOJI[enrichment.incident_type] || TYPE_EMOJI.other,
    };

    if (existingIdx >= 0) {
      this.incidents[existingIdx] = incident;
    } else {
      this.incidents.unshift(incident);
      // Keep max 100 incidents on map
      if (this.incidents.length > 100) this.incidents.pop();
    }

    this.count = this.incidents.length;

    // Register in world state
    if (this.world) {
      this.world.addEvent({
        id: incident.id,
        type: incident.type,
        subtype: incident.talkgroup_tag,
        lat: incident.lat,
        lon: incident.lon,
        time: incident.timestamp ? new Date(incident.timestamp).getTime() : Date.now(),
        severity: incident.severity === 'critical' ? 4 : incident.severity === 'high' ? 3 : incident.severity === 'medium' ? 2 : 1,
        source: 'radio',
        properties: {
          callType: incident.type,
          address: incident.addresses.map(a => a.corrected || a.raw).join(', '),
          summary: incident.analysis,
        },
      });
    }

    if (this.map) this.render(this.map);
  }

  /**
   * Bulk load from init message — radio history that already has enrichment.
   */
  loadHistory(history) {
    for (const msg of history) {
      if (msg.enrichment?.coordinates) {
        this.addEnrichedMessage(msg);
      }
    }
  }

  setupLayers(map) {
    map.addSource('radio-incidents', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });

    // Outer pulse ring for high/critical severity
    map.addLayer({
      id: 'radio-incident-pulse',
      type: 'circle',
      source: 'radio-incidents',
      filter: ['in', ['get', 'severity'], ['literal', ['high', 'critical']]],
      paint: {
        'circle-radius': ['*', ['get', 'radius'], 3],
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.08,
        'circle-blur': 1,
      },
    });

    // Glow layer
    map.addLayer({
      id: 'radio-incident-glow',
      type: 'circle',
      source: 'radio-incidents',
      paint: {
        'circle-radius': ['*', ['get', 'radius'], 2],
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.15,
        'circle-blur': 0.8,
      },
    });

    // Main dot
    map.addLayer({
      id: 'radio-incident-dots',
      type: 'circle',
      source: 'radio-incidents',
      paint: {
        'circle-radius': ['get', 'radius'],
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.85,
        'circle-stroke-width': 1.5,
        'circle-stroke-color': 'rgba(0,0,0,0.5)',
      },
    });

    // Emoji icon on top of dots (rendered as canvas images — Mapbox can't do emoji in text-field)
    map.addLayer({
      id: 'radio-incident-emoji',
      type: 'symbol',
      source: 'radio-incidents',
      layout: {
        'icon-image': ['get', 'icon'],
        'icon-size': [
          'interpolate', ['linear'], ['zoom'],
          10, 0.45,
          15, 0.7,
        ],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
      paint: {
        'icon-opacity': 0.9,
      },
    });

    // Text labels at higher zoom
    map.addLayer({
      id: 'radio-incident-labels',
      type: 'symbol',
      source: 'radio-incidents',
      minzoom: 13,
      layout: {
        'text-field': ['get', 'label'],
        'text-size': 10,
        'text-offset': [0, 2],
        'text-anchor': 'top',
        'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
        'text-max-width': 12,
      },
      paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': 'rgba(0,0,0,0.8)',
        'text-halo-width': 1,
        'text-opacity': 0.7,
      },
    });

    // Click handler — detailed popup
    map.on('click', 'radio-incident-dots', (e) => {
      const props = e.features[0].properties;
      const coords = e.features[0].geometry.coordinates.slice();

      // Parse JSON arrays from properties (Mapbox stringifies them)
      let addresses = [];
      let pois = [];
      let units = [];
      let codeTrans = {};
      try { addresses = JSON.parse(props.addresses || '[]'); } catch {}
      try { pois = JSON.parse(props.pois || '[]'); } catch {}
      try { units = JSON.parse(props.units || '[]'); } catch {}
      try { codeTrans = JSON.parse(props.code_translations || '{}'); } catch {}

      const ts = props.timestamp ? new Date(props.timestamp).toLocaleTimeString('en-US', { hour12: false }) : '—';
      const sevColors = { critical: '#ef4444', high: '#f97316', medium: '#eab308', low: '#6b7280' };
      const sevColor = sevColors[props.severity] || '#6b7280';

      let html = `
        <div class="popup-title" style="display:flex;align-items:center;gap:6px;">
          <span style="color:${props.color}">${(props.type || 'other').toUpperCase()}</span>
          <span style="font-size:9px;color:${sevColor};border:1px solid ${sevColor}40;padding:1px 4px;border-radius:2px;">${(props.severity || 'low').toUpperCase()}</span>
        </div>
        <div style="font-size:10px;color:rgba(255,255,255,0.5);margin-bottom:6px;">${props.talkgroup_tag} — ${ts}</div>
      `;

      if (props.analysis) {
        html += `<div style="font-size:10px;color:rgba(255,255,255,0.7);line-height:1.4;margin-bottom:6px;font-style:italic;">${props.analysis}</div>`;
      }

      if (props.transcript) {
        html += `<div style="font-size:10px;color:rgba(255,255,255,0.55);line-height:1.3;margin-bottom:6px;border-left:2px solid ${props.groupColor || '#6b7280'};padding-left:6px;">"${props.transcript}"</div>`;
      }

      if (addresses.length > 0) {
        html += `<div class="popup-row"><span class="popup-label">Location</span><span class="popup-value">${addresses.map(a => a.corrected || a.raw).join(', ')}</span></div>`;
      }

      if (pois.length > 0) {
        html += `<div class="popup-row"><span class="popup-label">Nearby</span><span class="popup-value">${pois.map(p => p.name).join(', ')}</span></div>`;
      }

      if (units.length > 0) {
        html += `<div class="popup-row"><span class="popup-label">Units</span><span class="popup-value">${units.join(', ')}</span></div>`;
      }

      // Code translations
      const codeEntries = Object.entries(codeTrans);
      if (codeEntries.length > 0) {
        html += `<div style="margin-top:4px;border-top:1px solid rgba(255,255,255,0.06);padding-top:4px;">`;
        for (const [code, meaning] of codeEntries) {
          html += `<div style="font-size:9px;color:rgba(255,255,255,0.35);"><span style="color:rgba(255,255,255,0.5);font-weight:600;">${code}</span> = ${meaning}</div>`;
        }
        html += `</div>`;
      }

      html += `<div class="popup-row"><span class="popup-label">Duration</span><span class="popup-value">${props.duration}s</span></div>`;

      new mapboxgl.Popup({ offset: 12, maxWidth: '320px' })
        .setLngLat(coords)
        .setHTML(html)
        .addTo(map);
    });

    map.on('mouseenter', 'radio-incident-dots', () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'radio-incident-dots', () => {
      map.getCanvas().style.cursor = '';
    });
  }

  render(map) {
    const geojson = {
      type: 'FeatureCollection',
      features: this.incidents.map(inc => {
        // Build label from first address or talkgroup tag
        const addrLabel = inc.addresses.length > 0
          ? (inc.addresses[0].corrected || inc.addresses[0].raw || '').split(',')[0]
          : '';
        const label = addrLabel || inc.talkgroup_tag;

        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [inc.lon, inc.lat] },
          properties: {
            ...inc,
            // Stringify arrays for Mapbox (it can't handle nested objects)
            addresses: JSON.stringify(inc.addresses),
            pois: JSON.stringify(inc.pois),
            units: JSON.stringify(inc.units),
            sources: JSON.stringify(inc.sources),
            code_translations: JSON.stringify(inc.code_translations),
            icon: ICON_IDS[inc.type] || ICON_IDS.other,
            label,
          },
        };
      }),
    };

    const source = map.getSource('radio-incidents');
    if (source) source.setData(geojson);
  }

  getMapLayerIds() {
    return ['radio-incident-pulse', 'radio-incident-glow', 'radio-incident-dots', 'radio-incident-emoji', 'radio-incident-labels'];
  }
}
