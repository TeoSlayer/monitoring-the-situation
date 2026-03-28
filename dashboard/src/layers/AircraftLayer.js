import { DataLayer } from '../world/DataLayer.js';
import mapboxgl from 'mapbox-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { PathLayer, LineLayer } from '@deck.gl/layers';

const TRAIL_LENGTH = 40;

function hexToRgba(hex, alpha = 255) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return [r, g, b, alpha];
}

export class AircraftLayer extends DataLayer {
  constructor() {
    super({
      id: 'aircraft',
      name: 'Aircraft',
      icon: '✈️',
      pollInterval: 999999,
    });
    this.trails = {};
    this.aircraft = [];
    this.showMilitaryOnly = false;
    this.selectedId = null;
    this._onSelect = null;
    this._deckOverlay = null;
  }

  onSelect(cb) { this._onSelect = cb; }

  async fetch() { return null; }
  ingest() {}

  ingestFromWS(aircraftArray) {
    this.aircraft = aircraftArray
      .filter(ac => ac.lat && ac.lon)
      .map(ac => {
        const id = ac.id || ac.flight || Math.random().toString(36);
        const alt = (typeof ac.alt === 'number') ? ac.alt : 0;
        const altMeters = (typeof ac.altMeters === 'number') ? ac.altMeters : alt * 0.3048;
        const classification = ac.classification || 'civilian';
        const color = ac.color || '#6b7280';

        if (!this.trails[id]) this.trails[id] = [];
        this.trails[id].push([ac.lon, ac.lat, altMeters]);
        if (this.trails[id].length > TRAIL_LENGTH) this.trails[id].shift();

        if (this.world) {
          this.world.upsertEntity({
            id: `aircraft-${id}`,
            type: 'aircraft',
            lat: ac.lat,
            lon: ac.lon,
            properties: {
              flight: ac.flight || '',
              classification,
              altitude: alt,
              speed: ac.speed || 0,
              heading: ac.heading || 0,
              squawk: ac.squawk || '',
              acType: ac.acType || '',
              registration: ac.registration || '',
              source: ac.source || '',
              origin: ac.origin || '',
              destination: ac.destination || '',
            },
          });

          if (ac.interesting) {
            this.world.addEvent({
              id: `ac-${id}-${Date.now()}`,
              type: 'aircraft',
              subtype: classification,
              lat: ac.lat,
              lon: ac.lon,
              severity: classification === 'police' ? 3 : 2,
              source: 'aircraft',
              entityIds: [`aircraft-${id}`],
              properties: {
                flight: ac.flight || '',
                altitude: alt,
                summary: `${classification.toUpperCase()} ${ac.flight || id} at ${alt.toLocaleString()} ft`,
              },
            });
          }
        }

        return {
          id,
          type: classification,
          color,
          interesting: ac.interesting || false,
          lon: ac.lon,
          lat: ac.lat,
          alt,
          altMeters,
          heading: ac.heading || 0,
          speed: ac.speed || 0,
          flight: ac.flight || '',
          squawk: ac.squawk || '',
          acType: ac.acType || '',
          registration: ac.registration || '',
          source: ac.source || '',
          origin: ac.origin || '',
          destination: ac.destination || '',
          fr24_url: ac.fr24_url || '',
          trail: [...(this.trails[id] || [])],
        };
      });

    this.count = this.aircraft.length;

    if (this.selectedId && this._onSelect) {
      const sel = this.aircraft.find(a => a.id === this.selectedId);
      if (sel) this._onSelect(sel);
    }

    if (this.map) this.render(this.map);
  }

  getVisible() {
    if (this.showMilitaryOnly) {
      return this.aircraft.filter(ac => ac.type !== 'civilian');
    }
    return this.aircraft;
  }

  selectAircraft(id) {
    this.selectedId = id;
    const ac = this.aircraft.find(a => a.id === id);
    if (ac && this.map) {
      // Adjust zoom based on altitude — higher aircraft = more zoomed out
      const alt = ac.alt || 0;
      const zoom = alt > 30000 ? 10 : alt > 15000 ? 11 : alt > 5000 ? 12 : 13;
      const pitch = alt > 15000 ? 45 : 60;
      this.map.flyTo({
        center: [ac.lon, ac.lat],
        zoom,
        pitch,
        bearing: ac.heading - 30,
        duration: 1500,
        essential: true,
      });
    }
    if (this._onSelect) this._onSelect(ac || null);
    if (this.map) this.render(this.map);
  }

  deselectAircraft() {
    this.selectedId = null;
    if (this._onSelect) this._onSelect(null);
    if (this.map) this.render(this.map);
  }

  _drawDelta(ctx, S, fill, stroke) {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(0, -S * 0.44);
    ctx.lineTo(S * 0.36, S * 0.28);
    ctx.lineTo(S * 0.08, S * 0.18);
    ctx.lineTo(S * 0.1, S * 0.38);
    ctx.lineTo(0, S * 0.3);
    ctx.lineTo(-S * 0.1, S * 0.38);
    ctx.lineTo(-S * 0.08, S * 0.18);
    ctx.lineTo(-S * 0.36, S * 0.28);
    ctx.closePath();
    ctx.fill();
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
  }

  _drawJet(ctx, S, bodyColor, wingColor, tailColor) {
    ctx.fillStyle = bodyColor;
    ctx.beginPath();
    ctx.moveTo(0, -S * 0.42);
    ctx.lineTo(S * 0.05, -S * 0.1);
    ctx.lineTo(S * 0.05, S * 0.3);
    ctx.lineTo(0, S * 0.38);
    ctx.lineTo(-S * 0.05, S * 0.3);
    ctx.lineTo(-S * 0.05, -S * 0.1);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = wingColor;
    ctx.beginPath();
    ctx.moveTo(-S * 0.04, -S * 0.04);
    ctx.lineTo(-S * 0.36, S * 0.1);
    ctx.lineTo(-S * 0.33, S * 0.15);
    ctx.lineTo(-S * 0.04, S * 0.06);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(S * 0.04, -S * 0.04);
    ctx.lineTo(S * 0.36, S * 0.1);
    ctx.lineTo(S * 0.33, S * 0.15);
    ctx.lineTo(S * 0.04, S * 0.06);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = tailColor;
    [[-1, 1], [1, 1]].forEach(([dx]) => {
      ctx.beginPath();
      ctx.moveTo(dx * S * 0.03, S * 0.25);
      ctx.lineTo(dx * S * 0.15, S * 0.36);
      ctx.lineTo(dx * S * 0.13, S * 0.4);
      ctx.lineTo(dx * S * 0.03, S * 0.32);
      ctx.closePath();
      ctx.fill();
    });
  }

  _drawHeli(ctx, S, bodyColor, boomColor, rotorColor) {
    ctx.fillStyle = bodyColor;
    ctx.beginPath();
    ctx.ellipse(0, 0, S * 0.1, S * 0.18, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = boomColor;
    ctx.fillRect(-S * 0.025, S * 0.12, S * 0.05, S * 0.25);
    ctx.fillStyle = bodyColor;
    ctx.fillRect(-S * 0.08, S * 0.34, S * 0.16, S * 0.03);
    ctx.strokeStyle = rotorColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(-S * 0.35, 0); ctx.lineTo(S * 0.35, 0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -S * 0.3); ctx.lineTo(0, S * 0.1); ctx.stroke();
    ctx.fillStyle = bodyColor;
    ctx.beginPath(); ctx.arc(0, -S * 0.02, S * 0.04, 0, Math.PI * 2); ctx.fill();
  }

  _makeIcon(S, drawFn) {
    const c = document.createElement('canvas');
    c.width = S; c.height = S;
    const ctx = c.getContext('2d');
    ctx.translate(S / 2, S / 2);
    drawFn(ctx, S);
    return { width: S, height: S, data: ctx.getImageData(0, 0, S, S).data };
  }

  _registerIcons(map) {
    const S = 64;
    const R = window.devicePixelRatio || 1;
    const opt = { pixelRatio: R, sdf: false };

    map.addImage('icon-civilian', this._makeIcon(S, (ctx, s) =>
      this._drawJet(ctx, s, '#94a3b8', '#64748b', '#475569')
    ), opt);

    map.addImage('icon-jet', this._makeIcon(S, (ctx, s) =>
      this._drawJet(ctx, s, '#a5b4fc', '#818cf8', '#6366f1')
    ), opt);

    map.addImage('icon-bizjet', this._makeIcon(S, (ctx, s) =>
      this._drawJet(ctx, s, '#c4b5fd', '#a78bfa', '#8b5cf6')
    ), opt);

    map.addImage('icon-ga', this._makeIcon(S, (ctx, s) => {
      ctx.fillStyle = '#86efac';
      ctx.beginPath();
      ctx.moveTo(0, -s * 0.36);
      ctx.lineTo(s * 0.04, -s * 0.05);
      ctx.lineTo(s * 0.04, s * 0.3);
      ctx.lineTo(0, s * 0.36);
      ctx.lineTo(-s * 0.04, s * 0.3);
      ctx.lineTo(-s * 0.04, -s * 0.05);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#4ade80';
      ctx.beginPath();
      ctx.moveTo(-s * 0.03, -s * 0.12);
      ctx.lineTo(-s * 0.4, -s * 0.04);
      ctx.lineTo(-s * 0.38, s * 0.01);
      ctx.lineTo(-s * 0.03, -s * 0.05);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(s * 0.03, -s * 0.12);
      ctx.lineTo(s * 0.4, -s * 0.04);
      ctx.lineTo(s * 0.38, s * 0.01);
      ctx.lineTo(s * 0.03, -s * 0.05);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#22c55e';
      ctx.beginPath();
      ctx.moveTo(-s * 0.02, s * 0.25);
      ctx.lineTo(-s * 0.12, s * 0.34);
      ctx.lineTo(-s * 0.1, s * 0.37);
      ctx.lineTo(-s * 0.02, s * 0.3);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(s * 0.02, s * 0.25);
      ctx.lineTo(s * 0.12, s * 0.34);
      ctx.lineTo(s * 0.1, s * 0.37);
      ctx.lineTo(s * 0.02, s * 0.3);
      ctx.closePath();
      ctx.fill();
    }), opt);

    map.addImage('icon-military', this._makeIcon(S, (ctx, s) =>
      this._drawDelta(ctx, s, '#f59e0b', 'rgba(0,0,0,0.3)')
    ), opt);

    map.addImage('icon-police', this._makeIcon(S, (ctx, s) =>
      this._drawDelta(ctx, s, '#ef4444', 'rgba(0,0,0,0.3)')
    ), opt);

    map.addImage('icon-heli', this._makeIcon(S, (ctx, s) =>
      this._drawHeli(ctx, s, '#22d3ee', '#0891b2', 'rgba(34,211,238,0.6)')
    ), opt);

    map.addImage('icon-coastguard', this._makeIcon(S, (ctx, s) =>
      this._drawHeli(ctx, s, '#f97316', '#ea580c', 'rgba(249,115,22,0.6)')
    ), opt);

    map.addImage('icon-drone', this._makeIcon(S, (ctx, s) => {
      ctx.fillStyle = '#f472b6';
      ctx.beginPath();
      ctx.moveTo(0, -s * 0.28);
      ctx.lineTo(s * 0.2, 0);
      ctx.lineTo(0, s * 0.28);
      ctx.lineTo(-s * 0.2, 0);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#ec4899';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(-s * 0.25, -s * 0.15); ctx.lineTo(s * 0.25, s * 0.15); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(s * 0.25, -s * 0.15); ctx.lineTo(-s * 0.25, s * 0.15); ctx.stroke();
      [[-s*0.25,-s*0.15],[s*0.25,-s*0.15],[-s*0.25,s*0.15],[s*0.25,s*0.15]].forEach(([x,y]) => {
        ctx.fillStyle = 'rgba(244,114,182,0.4)';
        ctx.beginPath(); ctx.arc(x, y, s * 0.07, 0, Math.PI * 2); ctx.fill();
      });
    }), opt);
  }

  setupLayers(map) {
    this._registerIcons(map);

    // deck.gl overlay for 3D trails at altitude
    this._deckOverlay = new MapboxOverlay({
      interleaved: true,
      layers: [],
    });
    map.addControl(this._deckOverlay);

    map.addSource('aircraft', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });

    map.addSource('aircraft-shadow-src', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });

    // Ground shadow
    map.addLayer({
      id: 'aircraft-shadow',
      type: 'circle',
      source: 'aircraft-shadow-src',
      paint: {
        'circle-radius': 4,
        'circle-color': 'rgba(0,0,0,0.25)',
        'circle-blur': 1,
      },
    });

    // Aircraft icon — elevated to actual altitude
    map.addLayer({
      id: 'aircraft-icons',
      type: 'symbol',
      source: 'aircraft',
      layout: {
        'icon-image': [
          'match', ['get', 'type'],
          'military', 'icon-military',
          'police', 'icon-police',
          'coast-guard', 'icon-coastguard',
          'helicopter', 'icon-heli',
          'bizjet', 'icon-bizjet',
          'ga', 'icon-ga',
          'drone', 'icon-drone',
          'civilian', 'icon-civilian',
          'icon-jet',
        ],
        'icon-size': [
          'case',
          ['==', ['get', 'selected'], true], 1.1,
          ['==', ['get', 'interesting'], true], 0.9,
          0.6,
        ],
        'icon-rotate': ['get', 'heading'],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'text-field': ['get', 'label'],
        'text-size': 10,
        'text-offset': [0, 1.8],
        'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
        'text-allow-overlap': false,
        'symbol-z-elevate': true,
        'symbol-elevation-reference': 'sea',
      },
      paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': 'rgba(0,0,0,0.9)',
        'text-halo-width': 1.5,
        'symbol-z-offset': ['coalesce', ['get', 'altMeters'], 0],
      },
    });

    // Click to select
    map.on('click', 'aircraft-icons', (e) => {
      const f = e.features[0];
      const id = f.properties.id;
      this.selectAircraft(id);
    });

    map.on('mouseenter', 'aircraft-icons', () => map.getCanvas().style.cursor = 'pointer');
    map.on('mouseleave', 'aircraft-icons', () => map.getCanvas().style.cursor = '');
  }

  render(map) {
    const visible = this.getVisible();

    // === Mapbox sources ===
    const geojson = {
      type: 'FeatureCollection',
      features: visible.map(ac => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [ac.lon, ac.lat, ac.altMeters] },
        properties: {
          id: ac.id,
          type: ac.type,
          interesting: ac.interesting,
          selected: ac.id === this.selectedId,
          color: ac.color,
          heading: ac.heading,
          flight: ac.flight,
          label: ac.interesting
            ? `${ac.flight} ${ac.alt.toLocaleString()}'`
            : ac.flight,
          alt: ac.alt,
          altMeters: ac.altMeters,
          speed: ac.speed,
          squawk: ac.squawk,
          acType: ac.acType,
          registration: ac.registration,
          source: ac.source,
          origin: ac.origin,
          destination: ac.destination,
          fr24_url: ac.fr24_url,
        },
      })),
    };

    const shadowGeojson = {
      type: 'FeatureCollection',
      features: visible.map(ac => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [ac.lon, ac.lat] },
        properties: { type: ac.type },
      })),
    };

    if (map.getSource('aircraft')) map.getSource('aircraft').setData(geojson);
    if (map.getSource('aircraft-shadow-src')) map.getSource('aircraft-shadow-src').setData(shadowGeojson);

    // === deck.gl layers (droplines only, no trails) ===
    if (this._deckOverlay) {
      const dropData = visible.filter(ac => ac.interesting || ac.id === this.selectedId);

      const droplineLayer = new LineLayer({
        id: 'aircraft-droplines',
        data: dropData,
        getSourcePosition: ac => [ac.lon, ac.lat, ac.altMeters],
        getTargetPosition: ac => [ac.lon, ac.lat, 0],
        getColor: ac => hexToRgba(ac.color, 35),
        getWidth: 1,
        widthMinPixels: 1,
      });

      this._deckOverlay.setProps({
        layers: [droplineLayer],
      });
    }
  }

  getMapLayerIds() {
    return ['aircraft-icons', 'aircraft-shadow'];
  }
}
