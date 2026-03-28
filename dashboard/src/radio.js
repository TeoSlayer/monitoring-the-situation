/**
 * Radio state management — real P25 radio data from trunk-recorder + whisper.
 * Replaces the old simulation with live WebSocket data.
 */

const RADIO_HISTORY_MAX = 200;

// Group color map
const GROUP_COLORS = {
  'SFFD': '#f97316',
  'SFPD': '#eab308',
  'EMS': '#3b82f6',
  'Mutual Aid': '#a78bfa',
};

// State
let radioHistory = [];
let radioChannels = {};  // talkgroup_id -> channel info + activity stats
let totalTransmissions = 0;
let sdrStats = {};
let activeFilter = null; // null = show all, or { group: 'SFFD' } or { talkgroup: 927 }
let searchTerm = ''; // text search across transcripts

// ─── Data Ingestion ───────────────────────────────────

export function ingestRadioMessage(msg) {
  radioHistory.unshift(msg);
  if (radioHistory.length > RADIO_HISTORY_MAX) radioHistory.pop();
  totalTransmissions++;

  // Update channel activity
  const tg = msg.talkgroup;
  if (tg && radioChannels[tg]) {
    radioChannels[tg].tx_count++;
    radioChannels[tg].last_tx = msg.timestamp;
    radioChannels[tg].active = true;
    // Clear active after 8s
    setTimeout(() => { if (radioChannels[tg]) radioChannels[tg].active = false; }, 8000);
  } else if (tg) {
    radioChannels[tg] = {
      talkgroup: tg,
      tag: msg.talkgroup_tag || `TG ${tg}`,
      group: msg.talkgroup_group || '',
      category: msg.talkgroup_category || '',
      tx_count: 1,
      last_tx: msg.timestamp,
      active: true,
    };
    setTimeout(() => { if (radioChannels[tg]) radioChannels[tg].active = false; }, 8000);
  }
}

export function ingestRadioHistory(history) {
  radioHistory = (history || []).slice().reverse();
  totalTransmissions = radioHistory.length;
}

export function ingestRadioChannels(channels) {
  radioChannels = channels || {};
  // Set all as inactive initially (will be activated by live messages)
  for (const ch of Object.values(radioChannels)) {
    ch.active = false;
  }
}

export function ingestTelemetry(telemetry) {
  if (telemetry.channels) radioChannels = telemetry.channels;
  if (telemetry.total_tx != null) totalTransmissions = telemetry.total_tx;
  if (telemetry.sdr) sdrStats = telemetry.sdr;
}

export function ingestSdr(sdr) {
  if (sdr) sdrStats = sdr;
}

// ─── Enrichment Ingestion ─────────────────────────────

export function ingestEnrichment(id, enrichment) {
  for (let i = 0; i < radioHistory.length; i++) {
    if (radioHistory[i].id === id) {
      radioHistory[i].processed = true;
      radioHistory[i].enrichment = enrichment;
      return;
    }
  }
}

// Incident + Situation state
let incidents = {};         // id -> incident
let situationSummary = '';

export function ingestIncidents(data) {
  if (data.incidents) incidents = data.incidents;
  if (data.situation_summary) situationSummary = data.situation_summary;
}

export function getIncidents() {
  return incidents;
}

export function getActiveIncidentCount() {
  return Object.values(incidents).filter(i => i.status === 'active').length;
}

export function getSituationSummary() {
  return situationSummary;
}

// ─── Rendering: Incident Panel ────────────────────────

const SEV_COLORS = { critical: '#ef4444', high: '#f97316', medium: '#eab308', low: '#6b7280' };
const TYPE_EMOJI = { fire: '🔥', medical: '🚑', police: '🚔', traffic: '🚗', maritime: '⚓', other: '📻' };

export function renderIncidentPanel(container, onSelect) {
  const allIncidents = Object.values(incidents).sort((a, b) => {
    // Active first, then by severity, then by update time
    if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
    const sevOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    if (sevOrder[a.severity] !== sevOrder[b.severity]) return (sevOrder[a.severity] || 3) - (sevOrder[b.severity] || 3);
    return (b.updated_at || '').localeCompare(a.updated_at || '');
  });

  if (allIncidents.length === 0) {
    container.innerHTML = '<div class="transcript-empty">No incidents detected yet. Incidents are created from radio analysis.</div>';
    return;
  }

  container.innerHTML = allIncidents.map(inc => {
    const sevColor = SEV_COLORS[inc.severity] || SEV_COLORS.low;
    const emoji = TYPE_EMOJI[inc.type] || TYPE_EMOJI.other;
    const isActive = inc.status === 'active';
    const txCount = (inc.transcript_ids || []).length;
    const hasCoords = inc.coordinates?.lat && inc.coordinates?.lng;
    const updated = inc.updated_at ? formatTimestamp(inc.updated_at) : '';
    const locationStr = inc.location || '';

    return `
      <div class="incident-card${isActive ? ' active' : ''}" data-incident-id="${inc.id}"${hasCoords ? ` data-lat="${inc.coordinates.lat}" data-lng="${inc.coordinates.lng}"` : ''}>
        <div class="incident-header">
          <span class="incident-emoji">${emoji}</span>
          <span class="incident-title">${escapeHtml(inc.title)}</span>
          <span class="incident-sev" style="color:${sevColor};border-color:${sevColor}40">${(inc.severity || 'low').toUpperCase()}</span>
        </div>
        <div class="incident-desc">${escapeHtml(inc.description || '')}</div>
        <div class="incident-meta">
          ${locationStr ? `<span class="incident-loc">${escapeHtml(locationStr)}</span>` : ''}
          <span class="incident-tx-count">${txCount} transmissions</span>
          <span class="incident-time">${updated}</span>
          ${isActive ? '<span class="incident-status-active">ACTIVE</span>' : '<span class="incident-status-resolved">RESOLVED</span>'}
        </div>
      </div>
    `;
  }).join('');
}

export function renderIncidentDetail(container, incidentId) {
  const inc = incidents[incidentId];
  if (!inc) {
    container.innerHTML = '<div class="transcript-empty">Incident not found</div>';
    return;
  }

  const sevColor = SEV_COLORS[inc.severity] || SEV_COLORS.low;
  const emoji = TYPE_EMOJI[inc.type] || TYPE_EMOJI.other;
  const timeline = (inc.timeline || []).sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));

  let html = `
    <div class="incident-detail-header">
      <span class="incident-emoji" style="font-size:24px">${emoji}</span>
      <div>
        <div class="incident-detail-title">${escapeHtml(inc.title)}</div>
        <div class="incident-detail-type">
          <span style="color:${sevColor}">${(inc.type || 'other').toUpperCase()}</span>
          <span class="incident-sev" style="color:${sevColor};border-color:${sevColor}40">${(inc.severity || 'low').toUpperCase()}</span>
          ${inc.status === 'active' ? '<span class="incident-status-active">ACTIVE</span>' : '<span class="incident-status-resolved">RESOLVED</span>'}
        </div>
      </div>
    </div>
    <div class="incident-detail-desc">${escapeHtml(inc.description || '')}</div>
  `;

  if (inc.location) {
    html += `<div class="incident-detail-location">${escapeHtml(inc.location)}</div>`;
  }

  if (timeline.length > 0) {
    html += '<div class="incident-timeline-label">TIMELINE</div>';
    html += '<div class="incident-timeline">';
    for (const entry of timeline) {
      const ts = formatTimestamp(entry.timestamp);
      const groupColor = GROUP_COLORS[entry.talkgroup_group] || '#6b7280';
      html += `
        <div class="incident-tl-entry">
          <div class="incident-tl-time">${ts}</div>
          <div class="incident-tl-dot" style="background:${groupColor}"></div>
          <div class="incident-tl-content">
            <span class="incident-tl-tag" style="color:${groupColor}">${escapeHtml(entry.talkgroup_tag || '?')}</span>
            <div class="incident-tl-text">${escapeHtml(entry.transcript || '')}</div>
            ${entry.analysis ? `<div class="incident-tl-analysis">${escapeHtml(entry.analysis)}</div>` : ''}
          </div>
        </div>
      `;
    }
    html += '</div>';
  }

  container.innerHTML = html;
}

// ─── Accessors ─────────────────────────────────────────

export function getTotalTransmissions() {
  return totalTransmissions;
}

export function getRadioHistory() {
  return radioHistory;
}

export function getRadioChannels() {
  return radioChannels;
}

export function getActiveChannelCount() {
  return Object.values(radioChannels).filter(ch => ch.active).length;
}

// ─── Rendering: Radio Feeds (sidebar) ──────────────────

export function renderRadioFeeds(container) {
  const allChannels = Object.values(radioChannels);

  if (allChannels.length === 0) {
    container.innerHTML = '<div class="radio-feed"><span class="radio-name" style="opacity:0.3">Waiting for radio data...</span></div>';
    return;
  }

  // Show channels with activity first (sorted by recency), then key channels with 0 TX
  const withActivity = allChannels
    .filter(ch => ch.tx_count > 0)
    .sort((a, b) => {
      if (a.active && !b.active) return -1;
      if (!a.active && b.active) return 1;
      return (b.last_tx || '').localeCompare(a.last_tx || '');
    });

  // Key dispatch channels to always show (even with 0 TX)
  const keyCategories = new Set(['Fire Dispatch', 'Law Dispatch', 'EMS Dispatch']);
  const keyIdle = allChannels
    .filter(ch => ch.tx_count === 0 && keyCategories.has(ch.category))
    .sort((a, b) => a.talkgroup - b.talkgroup);

  const channels = [...withActivity, ...keyIdle].slice(0, 14);

  container.innerHTML = channels.map(ch => {
    const color = GROUP_COLORS[ch.group] || '#6b7280';
    const dotClass = ch.active ? 'active' : 'idle';
    const lastTx = ch.last_tx ? formatTimeAgo(ch.last_tx) : '—';
    const tag = ch.tag || `TG ${ch.talkgroup}`;

    return `
      <div class="radio-feed">
        <span class="radio-dot ${dotClass}" style="${ch.active ? `background: ${color}; box-shadow: 0 0 6px ${color}80;` : ''}"></span>
        <span class="radio-name">${tag}</span>
        <span class="radio-tx-count">${ch.tx_count}</span>
        <span class="radio-time">${lastTx}</span>
      </div>
    `;
  }).join('');
}

// ─── Filter Grid (expanded modal) ──────────────────────

export function setFilter(filter) {
  activeFilter = filter;
}

export function getFilter() {
  return activeFilter;
}

export function setSearchTerm(term) {
  searchTerm = (term || '').toLowerCase().trim();
}

export function renderFilterGrid(container) {
  const allChannels = Object.values(radioChannels);
  if (allChannels.length === 0) return;

  // Group channels by department
  const groups = {};
  for (const ch of allChannels) {
    const g = ch.group || 'Other';
    if (!groups[g]) groups[g] = [];
    groups[g].push(ch);
  }

  let html = '<div class="filter-grid">';

  for (const [groupName, channels] of Object.entries(groups)) {
    const color = GROUP_COLORS[groupName] || '#6b7280';
    const isGroupActive = activeFilter?.group === groupName;
    const groupClass = isGroupActive ? ' filter-active' : '';
    const totalTx = channels.reduce((sum, c) => sum + (c.tx_count || 0), 0);

    html += `<div class="filter-group">`;
    html += `<div class="filter-group-btn${groupClass}" data-filter-group="${groupName}" style="--group-color: ${color}">`;
    html += `<span class="filter-group-dot" style="background: ${color}"></span>`;
    html += `<span class="filter-group-name">${groupName}</span>`;
    html += `<span class="filter-group-count">${totalTx}</span>`;
    html += `</div>`;

    html += `<div class="filter-channels">`;
    for (const ch of channels.sort((a, b) => (b.tx_count || 0) - (a.tx_count || 0))) {
      const tag = ch.tag || `TG ${ch.talkgroup}`;
      const isChanActive = activeFilter?.talkgroup === ch.talkgroup;
      const isLive = ch.active;
      const chanClass = isChanActive ? ' filter-active' : '';
      const liveClass = isLive ? ' filter-live' : '';
      html += `<span class="filter-ch${chanClass}${liveClass}" data-filter-tg="${ch.talkgroup}" style="--group-color: ${color}" title="${ch.tx_count || 0} tx">${tag}</span>`;
    }
    html += `</div></div>`;
  }

  // "All" button
  const allActive = activeFilter === null ? ' filter-active' : '';
  html += `<div class="filter-all-btn${allActive}" data-filter-all>ALL CHANNELS</div>`;
  html += '</div>';

  container.innerHTML = html;
}

// ─── Rendering: Transcript Feed ────────────────────────

export function renderTranscriptFeed(container, limit = 50) {
  let items = radioHistory;

  // Apply filter for expanded modal
  if (activeFilter && container.id === 'transcript-modal-feed') {
    if (activeFilter.group) {
      items = items.filter(m => m.talkgroup_group === activeFilter.group);
    } else if (activeFilter.talkgroup) {
      items = items.filter(m => m.talkgroup === activeFilter.talkgroup);
    }
  }

  // Apply text search
  if (searchTerm) {
    items = items.filter(m => {
      const transcript = (m.transcript || '').toLowerCase();
      const tag = (m.talkgroup_tag || '').toLowerCase();
      const group = (m.talkgroup_group || '').toLowerCase();
      const enrichment = m.enrichment;
      const analysis = enrichment ? (enrichment.analysis || '').toLowerCase() : '';
      const addresses = enrichment?.addresses ? enrichment.addresses.map(a => (a.corrected || a.raw || '').toLowerCase()).join(' ') : '';
      return transcript.includes(searchTerm) || tag.includes(searchTerm) || group.includes(searchTerm) || analysis.includes(searchTerm) || addresses.includes(searchTerm);
    });
  }

  items = items.slice(0, limit);

  if (items.length === 0) {
    container.innerHTML = '<div class="transcript-empty">Waiting for radio transmissions...</div>';
    return;
  }

  container.innerHTML = items.map((msg, i) => {
    const color = GROUP_COLORS[msg.talkgroup_group] || '#6b7280';
    const tag = msg.talkgroup_tag || `TG ${msg.talkgroup}`;
    const ts = formatTimestamp(msg.timestamp);
    const sources = (msg.sources || []).join(', ');
    const isNew = i === 0;
    const enrichment = msg.enrichment;

    if (msg.encrypted) {
      return `
        <div class="transcript-item${isNew ? ' new' : ''}" style="border-left-color: ${color}">
          <div class="transcript-header">
            <span class="transcript-time">${ts}</span>
            <span class="transcript-badge" style="background: ${color}20; color: ${color}">${tag}</span>
            <span class="transcript-encrypted">ENCRYPTED</span>
          </div>
          <div class="transcript-meta">${msg.duration}s${sources ? ' — ' + sources : ''}</div>
        </div>
      `;
    }

    const text = msg.transcript || '(no speech detected)';
    const emergencyClass = msg.emergency ? ' emergency' : '';
    const hasCoords = enrichment?.coordinates;
    const clickAttr = hasCoords
      ? ` data-lat="${enrichment.coordinates.lat}" data-lng="${enrichment.coordinates.lng}" style="border-left-color: ${color}; cursor: pointer;"`
      : ` style="border-left-color: ${color}"`;

    // Enrichment badges
    let enrichmentHtml = '';
    if (enrichment) {
      const sevColors = { critical: '#ef4444', high: '#f97316', medium: '#eab308', low: '#6b7280' };
      const sevColor = sevColors[enrichment.severity] || '#6b7280';
      const typeLabel = enrichment.incident_type !== 'other' ? enrichment.incident_type.toUpperCase() : '';

      let badges = '';
      if (typeLabel) {
        badges += `<span class="enrich-type" style="color: ${sevColor}; border-color: ${sevColor}40">${typeLabel}</span>`;
      }
      if (enrichment.severity && enrichment.severity !== 'low') {
        badges += `<span class="enrich-severity sev-${enrichment.severity}">${enrichment.severity.toUpperCase()}</span>`;
      }
      if (hasCoords) {
        badges += `<span class="enrich-loc" title="Click to view on map">LOC</span>`;
      }

      let analysisHtml = '';
      if (enrichment.analysis) {
        analysisHtml = `<div class="enrich-analysis">${escapeHtml(enrichment.analysis)}</div>`;
      }

      let addressHtml = '';
      if (enrichment.addresses?.length > 0) {
        const addrTexts = enrichment.addresses.map(a => a.corrected || a.raw).join(', ');
        addressHtml = `<div class="enrich-address">${escapeHtml(addrTexts)}</div>`;
      }

      if (badges || analysisHtml || addressHtml) {
        enrichmentHtml = `<div class="enrich-row">${badges}</div>${analysisHtml}${addressHtml}`;
      }
    } else if (msg.processed === false) {
      enrichmentHtml = '<div class="enrich-pending"></div>';
    }

    return `
      <div class="transcript-item${isNew ? ' new' : ''}${emergencyClass}"${clickAttr}>
        <div class="transcript-header">
          <span class="transcript-time">${ts}</span>
          <span class="transcript-badge" style="background: ${color}20; color: ${color}">${tag}</span>
          ${msg.emergency ? '<span class="transcript-emergency">EMERGENCY</span>' : ''}
        </div>
        <div class="transcript-text">${escapeHtml(text)}</div>
        ${enrichmentHtml}
        <div class="transcript-meta">${msg.duration}s${sources ? ' — ' + sources : ''} — ${formatFreq(msg.freq)}</div>
      </div>
    `;
  }).join('');
}

// ─── Rendering: Channel Table (modal) ───────────────────

export function renderChannelTable(container) {
  const allChannels = Object.values(radioChannels).sort((a, b) => {
    // Active first, then by most recent TX, then by highest TX count
    if (a.active && !b.active) return -1;
    if (!a.active && b.active) return 1;
    const aTime = a.last_tx || '';
    const bTime = b.last_tx || '';
    if (aTime !== bTime) return bTime.localeCompare(aTime);
    return (b.tx_count || 0) - (a.tx_count || 0);
  });

  if (allChannels.length === 0) {
    container.innerHTML = '<div class="transcript-empty">No channels loaded</div>';
    return;
  }

  // Group by department
  const groups = {};
  for (const ch of allChannels) {
    const g = ch.group || 'Other';
    if (!groups[g]) groups[g] = [];
    groups[g].push(ch);
  }

  let html = '';
  for (const [groupName, channels] of Object.entries(groups)) {
    const color = GROUP_COLORS[groupName] || '#6b7280';
    const activeCount = channels.filter(c => c.active).length;
    const totalTx = channels.reduce((sum, c) => sum + (c.tx_count || 0), 0);

    html += `<div class="ch-group-label" style="color: ${color}"><span class="ch-group-dot" style="background: ${color}"></span>${groupName} <span class="ch-group-stats">${activeCount} active / ${totalTx} tx</span></div>`;
    html += '<table class="ch-table"><thead><tr><th></th><th>CHANNEL</th><th>CATEGORY</th><th>TX</th><th>LAST</th></tr></thead><tbody>';

    // Sort within group: active first, then by recency, then by tx count
    channels.sort((a, b) => {
      if (a.active && !b.active) return -1;
      if (!a.active && b.active) return 1;
      const aTime = a.last_tx || '';
      const bTime = b.last_tx || '';
      if (aTime !== bTime) return bTime.localeCompare(aTime);
      return (b.tx_count || 0) - (a.tx_count || 0);
    });

    for (const ch of channels) {
      const isActive = ch.active;
      const rowClass = isActive ? ' class="ch-active"' : '';
      const indicator = isActive
        ? `<span class="ch-indicator on" style="background: ${color}; color: ${color}"></span>`
        : '<span class="ch-indicator off"></span>';
      const tag = ch.tag || `TG ${ch.talkgroup}`;
      const lastTx = ch.last_tx ? formatTimeAgo(ch.last_tx) : '—';

      html += `<tr${rowClass}><td>${indicator}</td><td class="ch-tag">${tag}</td><td>${ch.category || '—'}</td><td class="ch-count">${ch.tx_count || 0}</td><td class="ch-time">${lastTx}</td></tr>`;
    }

    html += '</tbody></table>';
  }

  container.innerHTML = html;
}

// ─── Rendering: SDR Stats ──────────────────────────────

export function renderSdrStats(container) {
  const s = sdrStats;
  if (!s || !s.device) {
    container.innerHTML = '<div class="transcript-empty">No SDR data</div>';
    return;
  }

  const active = s.active;
  const uptime = s.uptime_sec > 0 ? formatUptime(s.uptime_sec) : (active ? 'starting...' : 'offline');
  const encPct = s.total_calls > 0 ? Math.round(s.total_encrypted / s.total_calls * 100) : 0;
  const errRate = s.total_calls > 0 ? (s.total_errors / s.total_calls).toFixed(2) : '0';

  // Top frequencies used
  const topFreqs = Object.entries(s.freqs_used || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([f, c]) => `<span class="sdr-freq" title="${c} calls">${(parseInt(f) / 1e6).toFixed(4)}</span>`)
    .join(' ');

  container.innerHTML = `
    <div class="sdr-status">
      <span class="sdr-dot ${active ? 'active' : 'offline'}"></span>
      <span class="sdr-status-text">${active ? 'LOCKED' : 'OFFLINE'}</span>
      <span class="sdr-uptime">${uptime}</span>
    </div>
    <div class="sdr-grid">
      <div class="sdr-row"><span class="sdr-label">Device</span><span class="sdr-value">${s.device} (${s.driver})</span></div>
      <div class="sdr-row"><span class="sdr-label">Center</span><span class="sdr-value">${s.center_freq_mhz} MHz</span></div>
      <div class="sdr-row"><span class="sdr-label">Sample Rate</span><span class="sdr-value">${s.sample_rate_msps} MSPS</span></div>
      <div class="sdr-row"><span class="sdr-label">Gain</span><span class="sdr-value">${s.gain_db} dB</span></div>
      <div class="sdr-row"><span class="sdr-label">Modulation</span><span class="sdr-value">${(s.modulation || '').toUpperCase()}</span></div>
      <div class="sdr-row"><span class="sdr-label">Recorders</span><span class="sdr-value">${s.digital_recorders}</span></div>
      <div class="sdr-sep"></div>
      <div class="sdr-row"><span class="sdr-label">Calls</span><span class="sdr-value">${s.total_calls}</span></div>
      <div class="sdr-row"><span class="sdr-label">Encrypted</span><span class="sdr-value">${s.total_encrypted} (${encPct}%)</span></div>
      <div class="sdr-row"><span class="sdr-label">Freq Error</span><span class="sdr-value">${s.avg_freq_error_hz} Hz avg / ${s.last_freq_error_hz} Hz last</span></div>
      <div class="sdr-row"><span class="sdr-label">Decode Errors</span><span class="sdr-value">${s.total_errors} (${errRate}/call)</span></div>
      <div class="sdr-row"><span class="sdr-label">Spikes</span><span class="sdr-value">${s.total_spikes}</span></div>
    </div>
    ${topFreqs ? `<div class="sdr-freqs"><span class="sdr-label">Active Freqs</span>${topFreqs}</div>` : ''}
  `;
}

function formatUptime(sec) {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

// ─── Helpers ───────────────────────────────────────────

function formatTimeAgo(isoStr) {
  try {
    const d = new Date(isoStr);
    const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
    if (seconds < 5) return 'NOW';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h`;
  } catch {
    return '—';
  }
}

function formatTimestamp(isoStr) {
  try {
    return new Date(isoStr).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '??:??:??';
  }
}

function formatFreq(freq) {
  if (!freq) return '';
  return (freq / 1e6).toFixed(4) + ' MHz';
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
