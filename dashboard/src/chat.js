/**
 * ORACLE Chat Module — sends queries to the backend agent via WebSocket
 * and renders streaming responses with map actions.
 */

import { send, onMessage } from './ws.js';

let map = null;
let queryCounter = 0;
let currentStreamId = null;
let messageHistory = []; // { role: 'user'|'agent', text, actions? }

// DOM refs
let chatPanel, chatInput, chatSendBtn, chatMessages, chatSuggestions, chatStatus;

const SUGGESTIONS = [
  "What's happening?",
  "Any emergencies?",
  "Summarize the last hour",
  "Notable aircraft?",
  "What's near me?",
];

export function initChat(mapInstance) {
  map = mapInstance;

  chatPanel = document.getElementById('chat-panel');
  chatInput = document.getElementById('chat-input');
  chatSendBtn = document.getElementById('chat-send');
  chatMessages = document.getElementById('chat-messages');
  chatSuggestions = document.getElementById('chat-suggestions');
  chatStatus = document.getElementById('chat-status');

  if (!chatPanel || !chatInput) return;

  // Event listeners
  chatSendBtn.addEventListener('click', _handleSend);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') _handleSend();
  });
  chatInput.addEventListener('focus', () => {
    if (chatPanel.classList.contains('chat-collapsed')) {
      _expand();
    }
  });

  // Chat header click to toggle
  const chatHeader = document.getElementById('chat-header');
  if (chatHeader) {
    chatHeader.addEventListener('click', () => {
      if (chatPanel.classList.contains('chat-expanded')) {
        _collapse();
      } else {
        _expand();
      }
    });
  }

  // Register WS handler
  onMessage('agent_chunk', _onAgentChunk);

  // Render suggestion chips
  _renderSuggestions();
}

function _expand() {
  chatPanel.classList.remove('chat-collapsed');
  chatPanel.classList.add('chat-expanded');
  const tp = document.getElementById('transcript-panel');
  if (tp) tp.classList.add('chat-open');
  chatInput.focus();
}

function _collapse() {
  chatPanel.classList.remove('chat-expanded');
  chatPanel.classList.add('chat-collapsed');
  const tp = document.getElementById('transcript-panel');
  if (tp) tp.classList.remove('chat-open');
}

function _handleSend() {
  const text = chatInput.value.trim();
  if (!text) return;

  if (chatPanel.classList.contains('chat-collapsed')) {
    _expand();
  }

  // Hide suggestions
  if (chatSuggestions) chatSuggestions.style.display = 'none';

  _addMessage(text, 'user');
  chatInput.value = '';

  _sendAgentQuery(text);
}

function _sendAgentQuery(text) {
  queryCounter++;
  const id = `q_${queryCounter}`;
  currentStreamId = id;

  const center = map ? map.getCenter() : { lng: -122.4194, lat: 37.7749 };
  const zoom = map ? map.getZoom() : 12;

  send({
    type: 'agent_query',
    id,
    query: text,
    context: {
      map_center: [center.lng, center.lat],
      zoom: Math.round(zoom),
    },
  });

  // Show thinking indicator
  _addThinking(id);
}

function _onAgentChunk(msg) {
  const { id, status, delta, full, actions } = msg;

  const thinkingEl = document.getElementById(`thinking-${id}`);
  const streamEl = document.getElementById(`stream-${id}`);

  if (status === 'thinking') {
    // Already showing thinking dots from _addThinking
  } else if (status === 'streaming') {
    // Remove thinking indicator, show/update stream
    if (thinkingEl) thinkingEl.remove();

    if (!streamEl) {
      const div = document.createElement('div');
      div.className = 'chat-msg agent';
      div.id = `stream-${id}`;
      div.innerHTML = `<div class="agent-label">ORACLE</div><div class="agent-body">${_renderMarkdown(full)}<span class="stream-cursor"></span></div>`;
      chatMessages.appendChild(div);
    } else {
      const body = streamEl.querySelector('.agent-body');
      if (body) body.innerHTML = _renderMarkdown(full) + '<span class="stream-cursor"></span>';
    }
    chatMessages.scrollTop = chatMessages.scrollHeight;

    if (chatStatus) chatStatus.textContent = 'streaming...';
  } else if (status === 'done') {
    if (thinkingEl) thinkingEl.remove();

    // Finalize message
    if (streamEl) {
      const body = streamEl.querySelector('.agent-body');
      if (body) {
        body.innerHTML = _renderMarkdown(full);
        if (actions && actions.length > 0) {
          body.innerHTML += _renderActionChips(actions, id);
        }
      }
    } else {
      // No streaming happened, just show full
      const div = document.createElement('div');
      div.className = 'chat-msg agent';
      div.innerHTML = `<div class="agent-label">ORACLE</div><div class="agent-body">${_renderMarkdown(full)}${actions?.length ? _renderActionChips(actions, id) : ''}</div>`;
      chatMessages.appendChild(div);
    }
    chatMessages.scrollTop = chatMessages.scrollHeight;

    // Execute actions
    if (actions && actions.length > 0) {
      _executeActions(actions);
    }

    // Store in history
    messageHistory.push({ role: 'agent', text: full, actions });
    currentStreamId = null;

    if (chatStatus) chatStatus.textContent = '';

    // Bind action chip clicks
    _bindActionChips(id);
  } else if (status === 'error') {
    if (thinkingEl) thinkingEl.remove();
    if (streamEl) streamEl.remove();

    const div = document.createElement('div');
    div.className = 'chat-msg agent error';
    div.innerHTML = `<div class="agent-label">ORACLE</div><div class="agent-body agent-error">${_escapeHtml(full || delta || 'Unknown error')}</div>`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    currentStreamId = null;
    if (chatStatus) chatStatus.textContent = '';
  }
}

function _addMessage(text, role) {
  const div = document.createElement('div');
  div.className = `chat-msg ${role}`;
  div.textContent = text;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  messageHistory.push({ role, text });
}

function _addThinking(id) {
  const div = document.createElement('div');
  div.className = 'chat-msg agent thinking';
  div.id = `thinking-${id}`;
  div.innerHTML = '<div class="agent-label">ORACLE</div><div class="thinking-dots"><span></span><span></span><span></span></div>';
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  if (chatStatus) chatStatus.textContent = 'thinking...';
}

function _renderSuggestions() {
  if (!chatSuggestions) return;
  chatSuggestions.innerHTML = SUGGESTIONS.map(s =>
    `<button class="suggestion-chip">${_escapeHtml(s)}</button>`
  ).join('');

  chatSuggestions.addEventListener('click', (e) => {
    const chip = e.target.closest('.suggestion-chip');
    if (!chip) return;
    const text = chip.textContent;
    if (chatPanel.classList.contains('chat-collapsed')) _expand();
    chatSuggestions.style.display = 'none';
    _addMessage(text, 'user');
    _sendAgentQuery(text);
  });
}

function _renderMarkdown(text) {
  if (!text) return '';
  let html = _escapeHtml(text);
  // Bold: **text**
  html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  // Bullet lists: lines starting with - or *
  html = html.replace(/^[-*]\s+(.+)$/gm, '<span class="md-bullet">$1</span>');
  // Line breaks
  html = html.replace(/\n/g, '<br>');
  return html;
}

function _renderActionChips(actions, queryId) {
  return '<div class="action-chips">' + actions.map((a, i) => {
    if (a.action === 'fly_to') {
      return `<button class="action-chip" data-query="${queryId}" data-action-idx="${i}">View: ${_escapeHtml(a.label || 'Location')}</button>`;
    } else if (a.action === 'show_incident') {
      return `<button class="action-chip" data-query="${queryId}" data-action-idx="${i}">Show Incident</button>`;
    }
    return '';
  }).join('') + '</div>';
}

function _bindActionChips(queryId) {
  const chips = chatMessages.querySelectorAll(`[data-query="${queryId}"]`);
  chips.forEach(chip => {
    chip.addEventListener('click', () => {
      const idx = parseInt(chip.dataset.actionIdx, 10);
      const msg = messageHistory.find(m => m.actions && m.actions[idx]);
      if (msg && msg.actions[idx]) {
        _executeActions([msg.actions[idx]]);
      }
    });
  });
}

function _executeActions(actions) {
  if (!map) return;
  for (const action of actions) {
    if (action.action === 'fly_to' && action.lat && action.lon) {
      map.flyTo({
        center: [action.lon, action.lat],
        zoom: action.zoom || 15,
        pitch: 55,
        duration: 1500,
      });
      // Temporary popup
      if (window.mapboxgl) {
        const popup = new window.mapboxgl.Popup({ closeOnClick: true, closeButton: false })
          .setLngLat([action.lon, action.lat])
          .setHTML(`<div class="popup-title">${_escapeHtml(action.label || 'Location')}</div>`)
          .addTo(map);
        setTimeout(() => popup.remove(), 6000);
      }
    }
  }
}

function _escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
