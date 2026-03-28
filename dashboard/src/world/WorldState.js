/**
 * WorldState — The unified spatial-temporal knowledge graph.
 *
 * Everything that happens in SF gets indexed here. Every data feed
 * (aircraft, marine, dispatch, radio) registers events and entities
 * into H3 hex cells. The result is a traversable graph:
 *
 *   HexCell <--has--> Event <--involves--> Entity
 *       |                                     |
 *   neighbors                              history (hex trail)
 *
 * An AI agent queries this graph through structured tools:
 *   getHotspots() → top hexes by heat
 *   getHexDetails(h3) → everything in a cell
 *   traceEntity(id) → movement through space/time
 *   getTimeline(h3, range) → what happened when
 *   nearby(h3, rings) → surrounding activity
 */

import { latLngToCell, gridDisk, cellToLatLng, cellToBoundary } from 'h3-js';

const H3_RES = 8; // ~460m edge — neighborhood scale
const MAX_EVENTS = 5000;
const HEAT_DECAY_MS = 3600000; // 1 hour half-life

export class WorldState {
  constructor() {
    /** @type {Map<string, HexCell>} */
    this.hexCells = new Map();

    /** @type {Map<string, Entity>} */
    this.entities = new Map();

    /** @type {Event[]} */
    this.events = [];

    /** @type {Map<string, DataLayer>} */
    this.layers = new Map();

    this.listeners = [];
  }

  // ─── Registration ─────────────────────────────────────────

  /** Register a modular data layer */
  registerLayer(layer) {
    this.layers.set(layer.id, layer);
    layer.world = this;
  }

  /** Subscribe to world changes */
  onChange(fn) {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter(f => f !== fn); };
  }

  _emit(type, data) {
    for (const fn of this.listeners) fn({ type, data, time: Date.now() });
  }

  // ─── Core Writes ──────────────────────────────────────────

  /** Ingest an event at a location */
  addEvent(event) {
    const {
      id, type, subtype, lat, lon, time = Date.now(),
      severity = 1, source, properties = {}, entityIds = []
    } = event;

    const hex = latLngToCell(lat, lon, H3_RES);
    const ev = {
      id, type, subtype, hex, lat, lon,
      time: typeof time === 'number' ? time : new Date(time).getTime(),
      severity, source, properties, entityIds,
    };

    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(-MAX_EVENTS);
    }

    // Ensure hex cell exists and add event
    const cell = this._ensureCell(hex);
    cell.events.push(ev);
    cell.lastActivity = ev.time;
    cell.dirty = true;

    // Link entities to this hex
    for (const eid of entityIds) {
      if (this.entities.has(eid)) {
        const entity = this.entities.get(eid);
        entity.currentHex = hex;
        entity.lastSeen = ev.time;
        if (!cell.entityIds.has(eid)) cell.entityIds.add(eid);
      }
    }

    this._emit('event', ev);
    return ev;
  }

  /** Register or update an entity (aircraft, vessel, unit, etc.) */
  upsertEntity(entity) {
    const {
      id, type, lat, lon, properties = {},
    } = entity;

    const hex = latLngToCell(lat, lon, H3_RES);
    const now = Date.now();

    if (this.entities.has(id)) {
      const existing = this.entities.get(id);
      const prevHex = existing.currentHex;

      // Track movement
      if (prevHex && prevHex !== hex) {
        existing.trail.push({ hex: prevHex, time: existing.lastSeen });
        if (existing.trail.length > 100) existing.trail.shift();
      }

      existing.currentHex = hex;
      existing.lat = lat;
      existing.lon = lon;
      existing.lastSeen = now;
      existing.properties = { ...existing.properties, ...properties };

      // Update hex cell
      const cell = this._ensureCell(hex);
      cell.entityIds.add(id);

      this._emit('entity-moved', existing);
      return existing;
    } else {
      const newEntity = {
        id, type, lat, lon,
        currentHex: hex,
        firstSeen: now,
        lastSeen: now,
        trail: [],
        properties,
      };
      this.entities.set(id, newEntity);

      const cell = this._ensureCell(hex);
      cell.entityIds.add(id);

      this._emit('entity-new', newEntity);
      return newEntity;
    }
  }

  /** Remove stale entities */
  pruneEntities(maxAgeMs = 300000) {
    const cutoff = Date.now() - maxAgeMs;
    for (const [id, entity] of this.entities) {
      if (entity.lastSeen < cutoff) {
        this.entities.delete(id);
        // Remove from hex cells
        for (const cell of this.hexCells.values()) {
          cell.entityIds.delete(id);
        }
      }
    }
  }

  // ─── Hex Cell Management ──────────────────────────────────

  _ensureCell(hex) {
    if (!this.hexCells.has(hex)) {
      const [lat, lon] = cellToLatLng(hex);
      this.hexCells.set(hex, {
        hex,
        lat, lon,
        events: [],
        entityIds: new Set(),
        lastActivity: 0,
        dirty: true,
      });
    }
    return this.hexCells.get(hex);
  }

  // ─── Agent Query Interface ────────────────────────────────

  /**
   * Get hottest hex cells by activity density.
   * Heat = sum of event severities, decayed by age.
   */
  getHotspots(n = 10, timeWindowMs = 3600000) {
    const now = Date.now();
    const cutoff = now - timeWindowMs;
    const scored = [];

    for (const [hex, cell] of this.hexCells) {
      const recentEvents = cell.events.filter(e => e.time > cutoff);
      if (recentEvents.length === 0) continue;

      let heat = 0;
      const typeCounts = {};
      for (const ev of recentEvents) {
        const age = now - ev.time;
        const decay = Math.exp(-age / HEAT_DECAY_MS);
        heat += ev.severity * decay;
        typeCounts[ev.type] = (typeCounts[ev.type] || 0) + 1;
      }

      scored.push({
        hex,
        lat: cell.lat,
        lon: cell.lon,
        heat: Math.round(heat * 100) / 100,
        eventCount: recentEvents.length,
        entityCount: cell.entityIds.size,
        typeCounts,
        lastActivity: new Date(cell.lastActivity).toISOString(),
      });
    }

    scored.sort((a, b) => b.heat - a.heat);
    return scored.slice(0, n);
  }

  /**
   * Get everything in a specific hex cell.
   */
  getHexDetails(hex) {
    const cell = this.hexCells.get(hex);
    if (!cell) return null;

    const entities = [];
    for (const eid of cell.entityIds) {
      const e = this.entities.get(eid);
      if (e) entities.push({ ...e, trail: e.trail.slice(-10) });
    }

    return {
      hex,
      lat: cell.lat,
      lon: cell.lon,
      events: cell.events.slice(-50).map(e => ({
        ...e,
        time: new Date(e.time).toISOString(),
      })),
      entities,
      neighbors: gridDisk(hex, 1).filter(h => h !== hex),
    };
  }

  /**
   * Trace an entity through space and time.
   */
  traceEntity(entityId) {
    const entity = this.entities.get(entityId);
    if (!entity) return null;

    return {
      ...entity,
      trail: entity.trail.map(t => ({
        ...t,
        time: new Date(t.time).toISOString(),
        lat: cellToLatLng(t.hex)[0],
        lon: cellToLatLng(t.hex)[1],
      })),
      currentHex: entity.currentHex,
      relatedEvents: this.events
        .filter(e => e.entityIds.includes(entityId))
        .slice(-20)
        .map(e => ({ ...e, time: new Date(e.time).toISOString() })),
    };
  }

  /**
   * Get activity in surrounding hex cells.
   */
  nearby(lat, lon, rings = 2, timeWindowMs = 3600000) {
    const centerHex = latLngToCell(lat, lon, H3_RES);
    const hexes = gridDisk(centerHex, rings);
    const cutoff = Date.now() - timeWindowMs;
    const result = [];

    for (const hex of hexes) {
      const cell = this.hexCells.get(hex);
      if (!cell) continue;
      const recentEvents = cell.events.filter(e => e.time > cutoff);
      if (recentEvents.length === 0 && cell.entityIds.size === 0) continue;

      result.push({
        hex,
        lat: cell.lat,
        lon: cell.lon,
        distance: hex === centerHex ? 0 : 1,
        eventCount: recentEvents.length,
        entityCount: cell.entityIds.size,
        types: [...new Set(recentEvents.map(e => e.type))],
      });
    }

    return result;
  }

  /**
   * Get timeline of events in a hex cell.
   */
  getTimeline(hex, timeWindowMs = 3600000) {
    const cell = this.hexCells.get(hex);
    if (!cell) return [];

    const cutoff = Date.now() - timeWindowMs;
    return cell.events
      .filter(e => e.time > cutoff)
      .map(e => ({
        time: new Date(e.time).toISOString(),
        type: e.type,
        subtype: e.subtype,
        severity: e.severity,
        summary: e.properties.summary || `${e.type}: ${e.subtype || 'activity'}`,
        entityIds: e.entityIds,
      }));
  }

  /**
   * Search events by type/subtype across all cells.
   */
  search({ type, subtype, minSeverity = 0, timeWindowMs = 3600000, limit = 50 } = {}) {
    const cutoff = Date.now() - timeWindowMs;
    return this.events
      .filter(e =>
        e.time > cutoff &&
        (!type || e.type === type) &&
        (!subtype || e.subtype === subtype) &&
        e.severity >= minSeverity
      )
      .slice(-limit)
      .map(e => ({
        ...e,
        time: new Date(e.time).toISOString(),
      }));
  }

  /**
   * Full world snapshot for agent context.
   * This is what gets serialized and passed to the LLM.
   */
  getWorldSnapshot(timeWindowMs = 3600000) {
    const hotspots = this.getHotspots(5, timeWindowMs);
    const entityList = [];
    for (const [, e] of this.entities) {
      entityList.push({
        id: e.id,
        type: e.type,
        lat: e.lat,
        lon: e.lon,
        properties: e.properties,
        lastSeen: new Date(e.lastSeen).toISOString(),
      });
    }

    const cutoff = Date.now() - timeWindowMs;
    const recentEvents = this.events.filter(e => e.time > cutoff);
    const typeCounts = {};
    for (const e of recentEvents) {
      typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
    }

    return {
      timestamp: new Date().toISOString(),
      summary: {
        totalEvents: recentEvents.length,
        totalEntities: this.entities.size,
        activeCells: this.hexCells.size,
        typeCounts,
      },
      hotspots,
      entities: entityList,
      recentEvents: recentEvents.slice(-20).map(e => ({
        ...e,
        time: new Date(e.time).toISOString(),
      })),
    };
  }

  // ─── Hex Grid GeoJSON for Rendering ───────────────────────

  /**
   * Generate GeoJSON for the hex grid visualization.
   */
  getHexGeoJSON(timeWindowMs = 3600000) {
    const now = Date.now();
    const cutoff = now - timeWindowMs;
    const features = [];

    for (const [hex, cell] of this.hexCells) {
      const recentEvents = cell.events.filter(e => e.time > cutoff);
      if (recentEvents.length === 0 && cell.entityIds.size === 0) continue;

      // Calculate heat
      let heat = 0;
      const typeCounts = {};
      for (const ev of recentEvents) {
        const age = now - ev.time;
        const decay = Math.exp(-age / HEAT_DECAY_MS);
        heat += ev.severity * decay;
        typeCounts[ev.type] = (typeCounts[ev.type] || 0) + 1;
      }

      // Dominant type for color
      let dominantType = 'other';
      let maxCount = 0;
      for (const [t, c] of Object.entries(typeCounts)) {
        if (c > maxCount) { maxCount = c; dominantType = t; }
      }

      // H3 cell boundary as polygon
      const boundary = cellToBoundary(hex, true); // [lng, lat] pairs
      const color = this._typeColor(dominantType, heat);
      const height = Math.min(heat * 100, 800);

      features.push({
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [boundary.concat([boundary[0]])],
        },
        properties: {
          hex,
          heat: Math.round(heat * 100) / 100,
          height,
          color,
          eventCount: recentEvents.length,
          entityCount: cell.entityIds.size,
          dominantType,
        },
      });
    }

    return { type: 'FeatureCollection', features };
  }

  _typeColor(type, heat) {
    const intensity = Math.min(1, heat / 5);
    const alpha = 0.2 + intensity * 0.6;
    switch (type) {
      case 'fire': return `rgba(249, 115, 22, ${alpha})`;
      case 'medical': return `rgba(59, 130, 246, ${alpha})`;
      case 'police': return `rgba(234, 179, 8, ${alpha})`;
      case 'aircraft': return `rgba(167, 139, 250, ${alpha})`;
      case 'marine': return `rgba(6, 182, 212, ${alpha})`;
      default: return `rgba(139, 92, 246, ${alpha})`;
    }
  }
}

// ─── Singleton ────────────────────────────────────────────

export const world = new WorldState();
