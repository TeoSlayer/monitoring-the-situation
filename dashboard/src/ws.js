/**
 * WebSocket client — connects to the Python backend
 * and dispatches incoming data to registered handlers.
 */

const WS_URL = `ws://${window.location.hostname}:8765`;
const RECONNECT_DELAY = 3000;

let ws = null;
let handlers = {};
let statusEl = null;

export function onMessage(type, handler) {
  if (!handlers[type]) handlers[type] = [];
  handlers[type].push(handler);
}

function dispatch(msg) {
  const fns = handlers[msg.type] || [];
  for (const fn of fns) fn(msg);
  // Also dispatch to wildcard handlers
  const wildcards = handlers['*'] || [];
  for (const fn of wildcards) fn(msg);
}

function setStatus(connected) {
  if (!statusEl) statusEl = document.querySelector('.status-dot');
  if (statusEl) {
    statusEl.style.background = connected ? '#22c55e' : '#ef4444';
    statusEl.style.boxShadow = connected
      ? '0 0 8px rgba(34,197,94,0.6)'
      : '0 0 8px rgba(239,68,68,0.6)';
  }
}

export function connect() {
  if (ws && ws.readyState <= 1) return;

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log('[WS] Connected to backend');
    setStatus(true);
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      dispatch(msg);
    } catch (e) {
      console.warn('[WS] Parse error:', e);
    }
  };

  ws.onclose = () => {
    console.log('[WS] Disconnected, reconnecting...');
    setStatus(false);
    setTimeout(connect, RECONNECT_DELAY);
  };

  ws.onerror = (err) => {
    console.warn('[WS] Error:', err);
    ws.close();
  };
}

export function send(message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}
