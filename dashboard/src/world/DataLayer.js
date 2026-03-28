/**
 * DataLayer — Base class for modular data feeds.
 *
 * Extend this to create a new data source. Override:
 *   - fetch()    → pull data from API/source
 *   - ingest()   → transform raw data into world events/entities
 *   - render()   → update map layers from world state
 *
 * Each layer:
 *   - Has an ID and display name
 *   - Polls on a configurable interval
 *   - Writes into the shared WorldState
 *   - Can be toggled on/off
 *   - Reports its status (active, error, count)
 */

export class DataLayer {
  constructor({ id, name, pollInterval = 30000, icon = '' }) {
    this.id = id;
    this.name = name;
    this.icon = icon;
    this.pollInterval = pollInterval;

    /** @type {import('./WorldState.js').WorldState} */
    this.world = null;

    /** @type {mapboxgl.Map} */
    this.map = null;

    this.enabled = true;
    this.status = 'idle'; // idle | active | error
    this.lastFetch = null;
    this.error = null;
    this.count = 0;
    this._interval = null;
  }

  /** Attach to a map and start polling */
  attach(map) {
    this.map = map;
    this.setupLayers(map);
    this.poll();
    this._interval = setInterval(() => this.poll(), this.pollInterval);
  }

  /** Stop polling */
  detach() {
    if (this._interval) clearInterval(this._interval);
    this._interval = null;
  }

  /** Single poll cycle */
  async poll() {
    if (!this.enabled) return;
    this.status = 'active';
    try {
      const raw = await this.fetch();
      this.ingest(raw);
      this.lastFetch = Date.now();
      this.status = 'idle';
      this.error = null;
      if (this.map) this.render(this.map);
    } catch (e) {
      this.status = 'error';
      this.error = e.message;
      console.warn(`[${this.id}] poll failed:`, e);
    }
  }

  /** Toggle layer visibility */
  setEnabled(enabled) {
    this.enabled = enabled;
    if (this.map) {
      const vis = enabled ? 'visible' : 'none';
      for (const layerId of this.getMapLayerIds()) {
        if (this.map.getLayer(layerId)) {
          this.map.setLayoutProperty(layerId, 'visibility', vis);
        }
      }
    }
  }

  // ─── Override These ─────────────────────────────────────

  /** Fetch raw data from source. Return raw API response. */
  async fetch() { return null; }

  /** Transform raw data into WorldState events/entities. */
  ingest(_raw) {}

  /** Setup Mapbox layers (called once on attach). */
  setupLayers(_map) {}

  /** Update Mapbox layers from current world state (called each poll). */
  render(_map) {}

  /** Return Mapbox layer IDs this layer manages (for visibility toggling). */
  getMapLayerIds() { return []; }
}
