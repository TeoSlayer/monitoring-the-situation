import './style.css';
import mapboxgl from 'mapbox-gl';
import { MAPBOX_TOKEN, SF_CENTER, ANTENNA_LOCATION } from './config.js';
import { world } from './world/WorldState.js';
import { AircraftLayer } from './layers/AircraftLayer.js';
import { DispatchLayer } from './layers/DispatchLayer.js';
import { RadioIncidentLayer } from './layers/RadioIncidentLayer.js';
import { TrafficTransitLayer } from './layers/TrafficTransitLayer.js';
import {
  ingestRadioMessage, ingestRadioHistory, ingestRadioChannels, ingestTelemetry, ingestSdr,
  ingestEnrichment, ingestIncidents, getActiveIncidentCount,
  renderTranscriptFeed, renderChannelTable, renderSdrStats, renderFilterGrid,
  renderIncidentPanel, renderIncidentDetail,
  getTotalTransmissions, getRadioHistory, setFilter, setSearchTerm,
} from './radio.js';
import { connect, onMessage } from './ws.js';
import { initChat } from './chat.js';
import * as freqplot from './freqplot.js';
import { registerEmojiIcons } from './emojiIcons.js';

mapboxgl.accessToken = MAPBOX_TOKEN;

// ===== Layers =====
const aircraftLayer = new AircraftLayer();
const dispatchLayer = new DispatchLayer();
const radioIncidentLayer = new RadioIncidentLayer();
const trafficTransitLayer = new TrafficTransitLayer();

world.registerLayer(aircraftLayer);
world.registerLayer(dispatchLayer);
world.registerLayer(radioIncidentLayer);
world.registerLayer(trafficTransitLayer);

// ===== Activity Log =====
const logEntries = [];

function addLog(type, message) {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  logEntries.unshift({ type, message, time });
  if (logEntries.length > 50) logEntries.pop();
  const container = document.getElementById('activity-log');
  if (!container) return;
  container.innerHTML = logEntries.slice(0, 20).map(e =>
    `<div class="log-entry"><span class="log-time">${e.time}</span><span class="log-type ${e.type}">${e.type.toUpperCase()}</span> ${e.message}</div>`
  ).join('');
}

world.onChange(({ type, data }) => {
  if (type === 'event' && data.properties?.summary) {
    addLog(data.type, data.properties.summary);
  }
});

// ===== Clock =====
function updateClock() {
  const el = document.getElementById('clock');
  if (el) el.textContent = new Date().toLocaleTimeString('en-US', { hour12: false }) + ' PST';
}
setInterval(updateClock, 1000);
updateClock();

// ===== Stats =====
function updateStats() {
  setText('stat-aircraft', aircraftLayer.count);
  const radioIncCount = getActiveIncidentCount();
  const dispatchCount = dispatchLayer.count;
  setText('stat-incidents', radioIncCount + dispatchCount);
  const txCount = getTotalTransmissions();
  setText('stat-radio', txCount);
  setText('transcript-count', txCount);
  setText('aircraft-count', aircraftLayer.count);
  setText('dispatch-count', dispatchCount);
  setText('stat-muni', trafficTransitLayer.count);
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

// ===== Selection Panel =====
function renderSelectionPanel(aircraft) {
  const panel = document.getElementById('selection-panel');
  const transcriptPanel = document.getElementById('transcript-panel');
  if (!panel) return;

  if (!aircraft) {
    panel.classList.remove('visible');
    if (transcriptPanel) {
      transcriptPanel.style.top = '';
      transcriptPanel.style.maxHeight = '';
    }
    return;
  }

  // Push transcript panel down instead of hiding it
  if (transcriptPanel) {
    transcriptPanel.style.top = '340px';
    transcriptPanel.style.maxHeight = 'calc(100vh - 360px)';
  }

  const typeLabels = {
    'military': 'MILITARY',
    'police': 'POLICE',
    'coast-guard': 'COAST GUARD',
    'helicopter': 'HELICOPTER',
    'bizjet': 'BUSINESS JET',
    'ga': 'GENERAL AVIATION',
    'drone': 'DRONE',
    'non-commercial': 'NON-COMMERCIAL',
    'civilian': 'CIVILIAN',
  };

  const typeLabel = typeLabels[aircraft.type] || aircraft.type.toUpperCase();
  const fr24Link = aircraft.fr24_url
    ? `<a href="${aircraft.fr24_url}" target="_blank" class="sel-fr24-link">View on FlightRadar24</a>`
    : '';

  panel.innerHTML = `
    <button class="sel-close" id="sel-close">&times;</button>
    <div class="sel-header">
      <span class="sel-badge">SELECTED</span>
      <span class="sel-badge type-${aircraft.type}">${typeLabel}</span>
    </div>
    <div class="sel-callsign">${aircraft.flight || 'UNKNOWN'}</div>
    <div class="sel-grid">
      <div class="sel-row"><span class="sel-label">Type</span><span class="sel-value">${aircraft.acType || '---'}</span></div>
      <div class="sel-row"><span class="sel-label">Registration</span><span class="sel-value">${aircraft.registration || '---'}</span></div>
      <div class="sel-row"><span class="sel-label">Altitude</span><span class="sel-value">${aircraft.alt ? aircraft.alt.toLocaleString() + ' ft' : '---'}</span></div>
      <div class="sel-row"><span class="sel-label">Speed</span><span class="sel-value">${aircraft.speed ? Math.round(aircraft.speed) + ' kts' : '---'}</span></div>
      <div class="sel-row"><span class="sel-label">Heading</span><span class="sel-value">${aircraft.heading ? Math.round(aircraft.heading) + '°' : '---'}</span></div>
      <div class="sel-row"><span class="sel-label">Squawk</span><span class="sel-value">${aircraft.squawk || '---'}</span></div>
      ${aircraft.origin || aircraft.destination ? `<div class="sel-row"><span class="sel-label">Route</span><span class="sel-value">${aircraft.origin || '?'} → ${aircraft.destination || '?'}</span></div>` : ''}
      <div class="sel-row"><span class="sel-label">Source</span><span class="sel-value">${aircraft.source || '---'}</span></div>
      <div class="sel-row"><span class="sel-label">Position</span><span class="sel-value">${aircraft.lat.toFixed(4)}, ${aircraft.lon.toFixed(4)}</span></div>
    </div>
    ${fr24Link}
  `;

  panel.classList.add('visible');

  document.getElementById('sel-close').addEventListener('click', () => {
    aircraftLayer.deselectAircraft();
  });
}

// Wire up selection
aircraftLayer.onSelect(renderSelectionPanel);

// ===== Map =====
const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/dark-v11',
  center: SF_CENTER,
  zoom: 12,
  pitch: 55,
  bearing: -15,
  antialias: true,
  projection: 'globe',
});

map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'bottom-right');

map.on('style.load', () => {
  // 3D terrain
  map.addSource('mapbox-dem', {
    type: 'raster-dem',
    url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
    tileSize: 512,
    maxzoom: 14,
  });
  map.setTerrain({ source: 'mapbox-dem', exaggeration: 1.3 });

  // Atmosphere
  map.setFog({
    color: 'rgba(10, 10, 20, 0.8)',
    'high-color': 'rgba(20, 20, 40, 0.6)',
    'horizon-blend': 0.08,
    'space-color': 'rgba(5, 5, 15, 1)',
    'star-intensity': 0.4,
  });

  // 3D buildings
  const layers = map.getStyle().layers;
  const labelLayer = layers.find(l => l.type === 'symbol' && l.layout?.['text-field'])?.id;

  map.addLayer({
    id: '3d-buildings',
    source: 'composite',
    'source-layer': 'building',
    filter: ['==', 'extrude', 'true'],
    type: 'fill-extrusion',
    minzoom: 12,
    paint: {
      'fill-extrusion-color': '#1a1a2e',
      'fill-extrusion-height': ['get', 'height'],
      'fill-extrusion-base': ['get', 'min_height'],
      'fill-extrusion-opacity': 0.7,
    },
  }, labelLayer);

  // Register emoji images for symbol layers (Mapbox can't render emoji in text-field)
  registerEmojiIcons(map);

  // Attach all layers to map
  dispatchLayer.attach(map);
  radioIncidentLayer.attach(map);
  trafficTransitLayer.attach(map);
  aircraftLayer.attach(map);

  // Antenna marker
  const antennaEl = document.createElement('div');
  antennaEl.style.width = '24px';
  antennaEl.style.height = '24px';
  antennaEl.style.position = 'relative';
  antennaEl.innerHTML = '<div class="antenna-circle"></div><div class="antenna-marker">📡</div><div class="antenna-rings"></div>';
  new mapboxgl.Marker({ element: antennaEl, anchor: 'center' })
    .setLngLat(ANTENNA_LOCATION)
    .setPopup(new mapboxgl.Popup({ offset: 15 }).setHTML(
      '<div class="popup-title">📡 ANTENNA</div>' +
      '<div class="popup-row"><span class="popup-label">Status</span><span class="popup-value" style="color:#22c55e">ACTIVE</span></div>' +
      '<div class="popup-row"><span class="popup-label">Location</span><span class="popup-value">37.7901, -122.4034</span></div>' +
      '<div class="popup-row"><span class="popup-label">Equipment</span><span class="popup-value">RTL-SDR</span></div>'
    ))
    .addTo(map);

  // Refresh radio feeds + transcript + stats periodically
  setInterval(() => {
    const transcriptEl = document.getElementById('transcript-feed');
    if (transcriptEl) renderTranscriptFeed(transcriptEl);
    const channelTableEl = document.getElementById('channel-table');
    if (channelTableEl) renderChannelTable(channelTableEl);
    const sdrEl = document.getElementById('sdr-stats');
    if (sdrEl) renderSdrStats(sdrEl);
    freqplot.render(document.getElementById('freq-plot'));
    updateStats();
  }, 2000);

  // ===== Channel Monitor Modal =====
  const channelModal = document.getElementById('channel-modal');
  const openChannelsBtn = document.getElementById('open-channels');
  const closeChannelBtn = document.getElementById('channel-modal-close');

  if (openChannelsBtn && channelModal) {
    openChannelsBtn.addEventListener('click', () => {
      channelModal.classList.toggle('modal-hidden');
      // Render immediately when opening
      const tbl = document.getElementById('channel-table');
      if (tbl) renderChannelTable(tbl);
    });
  }
  if (closeChannelBtn && channelModal) {
    closeChannelBtn.addEventListener('click', () => {
      channelModal.classList.add('modal-hidden');
    });
  }
  // Close modal on backdrop click
  if (channelModal) {
    channelModal.addEventListener('click', (e) => {
      if (e.target === channelModal) channelModal.classList.add('modal-hidden');
    });
  }

  // ===== Transcript Expand Modal =====
  const transcriptExpandBtn = document.getElementById('transcript-expand');
  const transcriptModal = document.getElementById('transcript-modal');
  const transcriptModalClose = document.getElementById('transcript-modal-close');

  function refreshExpandedTranscripts() {
    const grid = document.getElementById('transcript-filter-grid');
    if (grid) renderFilterGrid(grid);
    const feed = document.getElementById('transcript-modal-feed');
    if (feed) renderTranscriptFeed(feed, 200);
  }

  if (transcriptExpandBtn && transcriptModal) {
    transcriptExpandBtn.addEventListener('click', () => {
      transcriptModal.classList.toggle('modal-hidden');
      setFilter(null); // Reset filter on open
      refreshExpandedTranscripts();
    });
  }
  if (transcriptModalClose && transcriptModal) {
    transcriptModalClose.addEventListener('click', () => {
      transcriptModal.classList.add('modal-hidden');
      setFilter(null);
    });
  }
  if (transcriptModal) {
    transcriptModal.addEventListener('click', (e) => {
      if (e.target === transcriptModal) {
        transcriptModal.classList.add('modal-hidden');
        setFilter(null);
      }
    });

    // Delegate filter clicks
    transcriptModal.addEventListener('click', (e) => {
      const groupBtn = e.target.closest('[data-filter-group]');
      const tgBtn = e.target.closest('[data-filter-tg]');
      const allBtn = e.target.closest('[data-filter-all]');

      if (allBtn) {
        setFilter(null);
        refreshExpandedTranscripts();
      } else if (tgBtn) {
        const tg = parseInt(tgBtn.dataset.filterTg, 10);
        setFilter({ talkgroup: tg });
        refreshExpandedTranscripts();
      } else if (groupBtn) {
        const group = groupBtn.dataset.filterGroup;
        setFilter({ group });
        refreshExpandedTranscripts();
      }
    });
  }

  // ===== Incident Modal =====
  const incidentModal = document.getElementById('incident-modal');
  const incidentDetailModal = document.getElementById('incident-detail-modal');
  const openIncidentsBtn = document.getElementById('open-incidents');
  const closeIncidentBtn = document.getElementById('incident-modal-close');
  const closeIncidentDetailBtn = document.getElementById('incident-detail-close');
  const incidentBackBtn = document.getElementById('incident-back');

  if (openIncidentsBtn && incidentModal) {
    openIncidentsBtn.addEventListener('click', () => {
      incidentModal.classList.toggle('modal-hidden');
      const list = document.getElementById('incident-list');
      if (list) renderIncidentPanel(list);
    });
  }
  if (closeIncidentBtn) {
    closeIncidentBtn.addEventListener('click', () => incidentModal.classList.add('modal-hidden'));
  }
  if (incidentModal) {
    incidentModal.addEventListener('click', (e) => {
      if (e.target === incidentModal) incidentModal.classList.add('modal-hidden');
    });
    // Click incident card → open detail
    incidentModal.addEventListener('click', (e) => {
      const card = e.target.closest('[data-incident-id]');
      if (!card) return;
      const incId = card.dataset.incidentId;
      // Fly to location if available
      const lat = parseFloat(card.dataset.lat);
      const lng = parseFloat(card.dataset.lng);
      if (!isNaN(lat) && !isNaN(lng)) {
        map.flyTo({ center: [lng, lat], zoom: 15, pitch: 55, duration: 1500 });
      }
      // Show detail modal
      incidentModal.classList.add('modal-hidden');
      incidentDetailModal.classList.remove('modal-hidden');
      const detail = document.getElementById('incident-detail');
      if (detail) renderIncidentDetail(detail, incId);
    });
  }
  if (closeIncidentDetailBtn) {
    closeIncidentDetailBtn.addEventListener('click', () => incidentDetailModal.classList.add('modal-hidden'));
  }
  if (incidentBackBtn) {
    incidentBackBtn.addEventListener('click', () => {
      incidentDetailModal.classList.add('modal-hidden');
      incidentModal.classList.remove('modal-hidden');
      const list = document.getElementById('incident-list');
      if (list) renderIncidentPanel(list);
    });
  }
  if (incidentDetailModal) {
    incidentDetailModal.addEventListener('click', (e) => {
      if (e.target === incidentDetailModal) incidentDetailModal.classList.add('modal-hidden');
    });
  }

  // ===== Telegram Panel Toggle =====
  const telegramPanel = document.getElementById('telegram-panel');
  const openTelegramBtn = document.getElementById('open-telegram');
  if (openTelegramBtn && telegramPanel) {
    openTelegramBtn.addEventListener('click', () => telegramPanel.classList.toggle('telegram-hidden'));
  }

  // ===== Telegram Zone Modal =====
  const telegramZoneModal = document.getElementById('telegram-zone-modal');
  const telegramConfigBtn = document.getElementById('telegram-config-btn');
  const telegramZoneClose = document.getElementById('telegram-zone-close');
  if (telegramConfigBtn && telegramZoneModal) {
    telegramConfigBtn.addEventListener('click', () => telegramZoneModal.classList.toggle('modal-hidden'));
  }
  if (telegramZoneClose) {
    telegramZoneClose.addEventListener('click', () => telegramZoneModal.classList.add('modal-hidden'));
  }
  if (telegramZoneModal) {
    telegramZoneModal.addEventListener('click', (e) => {
      if (e.target === telegramZoneModal) telegramZoneModal.classList.add('modal-hidden');
    });
  }

  // ===== Transcript Click-to-Fly =====
  function handleTranscriptClick(e) {
    const item = e.target.closest('[data-lat][data-lng]');
    if (!item) return;
    const lat = parseFloat(item.dataset.lat);
    const lng = parseFloat(item.dataset.lng);
    if (isNaN(lat) || isNaN(lng)) return;
    map.flyTo({ center: [lng, lat], zoom: 15, pitch: 55, duration: 1500 });
    // Add a brief pulse marker
    const popup = new mapboxgl.Popup({ closeOnClick: true, closeButton: false, offset: 0 })
      .setLngLat([lng, lat])
      .setHTML('<div class="popup-title">Incident Location</div>')
      .addTo(map);
    setTimeout(() => popup.remove(), 4000);
  }

  const transcriptFeed = document.getElementById('transcript-feed');
  if (transcriptFeed) transcriptFeed.addEventListener('click', handleTranscriptClick);
  const transcriptModalFeed = document.getElementById('transcript-modal-feed');
  if (transcriptModalFeed) transcriptModalFeed.addEventListener('click', handleTranscriptClick);

  // Connect to WebSocket backend
  connect();

  addLog('aircraft', 'System initialized — connecting to backend');
});

// ===== WebSocket Handlers =====

// Initial state from backend
onMessage('init', (msg) => {
  addLog('aircraft', `Backend connected — ${msg.aircraft?.total || 0} aircraft, ${msg.dispatch?.total || 0} incidents`);
  if (msg.aircraft?.data) aircraftLayer.ingestFromWS(msg.aircraft.data);
  if (msg.dispatch?.data) dispatchLayer.ingestFromWS(msg.dispatch.data);
  if (msg.radio) {
    ingestRadioHistory(msg.radio.history);
    ingestRadioChannels(msg.radio.channels);
    freqplot.loadHistory(msg.radio.history);
    // Load any already-enriched history onto the map
    radioIncidentLayer.loadHistory(msg.radio.history || []);
    addLog('radio', `Radio: ${msg.radio.total_tx || 0} transcripts, ${Object.keys(msg.radio.channels || {}).length} channels`);
  }
  if (msg.sdr) ingestSdr(msg.sdr);
  if (msg.incidents) ingestIncidents({ incidents: msg.incidents });
  if (msg.transit?.data) trafficTransitLayer.ingestTransit(msg.transit.data);
  if (msg.traffic?.data) trafficTransitLayer.ingestTraffic(msg.traffic.data);
  if (msg.traffic_events?.data) trafficTransitLayer.ingestTrafficEvents(msg.traffic_events.data);
  updateStats();
});

// Live aircraft updates from backend
onMessage('aircraft', (msg) => {
  aircraftLayer.ingestFromWS(msg.data);
  updateStats();
});

// Live dispatch updates from backend
onMessage('dispatch', (msg) => {
  dispatchLayer.ingestFromWS(msg.data);
  updateStats();
});

// Live radio transcripts from backend
onMessage('radio', (msg) => {
  ingestRadioMessage(msg);
  freqplot.addEvent(msg);
  const tag = msg.talkgroup_tag || `TG ${msg.talkgroup}`;
  if (msg.encrypted) {
    addLog('radio', `${tag} — ENCRYPTED (${msg.duration}s)`);
  } else if (msg.transcript) {
    const preview = msg.transcript.length > 60 ? msg.transcript.slice(0, 60) + '...' : msg.transcript;
    addLog('radio', `${tag} — "${preview}"`);
  }
  // Immediately re-render transcript feed for responsiveness
  const transcriptEl = document.getElementById('transcript-feed');
  if (transcriptEl) renderTranscriptFeed(transcriptEl);
  // Also update the expanded modal if open
  const modalFeed = document.getElementById('transcript-modal-feed');
  if (modalFeed) renderTranscriptFeed(modalFeed, 200);
  const filterGrid = document.getElementById('transcript-filter-grid');
  if (filterGrid) renderFilterGrid(filterGrid);
  updateStats();
});

// Radio telemetry updates
onMessage('radio_telemetry', (msg) => {
  ingestTelemetry(msg);
  const channelTableEl = document.getElementById('channel-table');
  if (channelTableEl) renderChannelTable(channelTableEl);
  updateStats();
});

// Enrichment updates (Gemini analysis + geocoding results)
onMessage('enrichment', (msg) => {
  ingestEnrichment(msg.id, msg.enrichment);

  // Find the full message in history to pass to the map layer
  const history = getRadioHistory();
  const fullMsg = history.find(m => m.id === msg.id);
  if (fullMsg) {
    radioIncidentLayer.addEnrichedMessage(fullMsg);
  }

  // Re-render transcript feeds to show enrichment
  const transcriptEl = document.getElementById('transcript-feed');
  if (transcriptEl) renderTranscriptFeed(transcriptEl);
  const modalFeed = document.getElementById('transcript-modal-feed');
  if (modalFeed) renderTranscriptFeed(modalFeed, 200);
});

// Incident updates (from window analysis)
onMessage('incidents', (msg) => {
  ingestIncidents(msg);
  // Re-render incident list if modal is open
  const incList = document.getElementById('incident-list');
  if (incList) renderIncidentPanel(incList);
  const count = msg.active_count || 0;
  addLog('radio', `Incidents: ${count} active, severity: ${msg.highest_severity}`);
  updateStats();
});

// Live transit vehicle updates
onMessage('transit', (msg) => {
  trafficTransitLayer.ingestTransit(msg.data);
  updateStats();
});

// Live work zone / traffic updates
onMessage('traffic', (msg) => {
  trafficTransitLayer.ingestTraffic(msg.data);
});

// Live traffic event updates (accidents, congestion, etc.)
onMessage('traffic_events', (msg) => {
  trafficTransitLayer.ingestTrafficEvents(msg.data);
});

// ===== Chat (ORACLE Agent) =====
initChat(map);

// ===== Modal Stack Management =====
function closeAllModals() {
  const modals = document.querySelectorAll('#channel-modal, #transcript-modal, #incident-modal, #incident-detail-modal');
  modals.forEach(m => m.classList.add('modal-hidden'));
  setFilter(null);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeAllModals();
});

// ===== Transcript Search =====
const transcriptSearchInput = document.getElementById('transcript-search');
if (transcriptSearchInput) {
  transcriptSearchInput.addEventListener('input', () => {
    setSearchTerm(transcriptSearchInput.value);
    const transcriptEl = document.getElementById('transcript-feed');
    if (transcriptEl) renderTranscriptFeed(transcriptEl);
  });
}

// ===== Layer Toggle Wiring =====
const layerMap = {
  'aircraft': aircraftLayer,
  'dispatch': dispatchLayer,
  'radio-incidents': radioIncidentLayer,
  'traffic-transit': trafficTransitLayer,
};

document.querySelectorAll('.layer-toggle').forEach(label => {
  const layerId = label.dataset.layer;
  const layer = layerMap[layerId];
  if (!layer) return;
  const checkbox = label.querySelector('input[type="checkbox"]');
  if (checkbox) {
    checkbox.addEventListener('change', () => {
      layer.setEnabled(checkbox.checked);
    });
  }
});

window.__world = world;
window.__map = map;
window.mapboxgl = mapboxgl;
