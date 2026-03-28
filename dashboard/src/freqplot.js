/**
 * Waterfall-style frequency display.
 * Shows the SDR's frequency range with call activity painted as colored bands.
 * Y-axis = frequency (851-853 MHz), X-axis = time, color = talkgroup group.
 */

const WINDOW_MS = 10 * 60 * 1000; // 10 minute window

// SDR frequency range (from trunk-recorder config: center 852 MHz, rate 2.4 MSPS)
const FREQ_MIN = 850800000;  // 850.8 MHz
const FREQ_MAX = 853200000;  // 853.2 MHz
const FREQ_RANGE = FREQ_MAX - FREQ_MIN;

const GROUP_COLORS = {
  'SFFD': [249, 115, 22],
  'SFPD': [234, 179, 8],
  'EMS': [59, 130, 246],
  'Mutual Aid': [167, 139, 250],
};
const DEFAULT_COLOR = [107, 114, 128];

// Known control channel frequencies (always shown as reference lines)
const CONTROL_CHANNELS = [851250000, 851400000, 851612500, 852062500];

// All events within the time window
let events = [];

export function addEvent(msg) {
  const ts = msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now();
  events.push({
    time: ts,
    freq: msg.freq || 0,
    duration: (msg.duration || 1) * 1000,
    group: msg.talkgroup_group || '',
    tag: msg.talkgroup_tag || '',
    encrypted: msg.encrypted,
    emergency: msg.emergency,
  });
}

export function loadHistory(history) {
  for (const msg of history) {
    addEvent(msg);
  }
}

function freqToY(freq, plotY, plotH) {
  const ratio = (freq - FREQ_MIN) / FREQ_RANGE;
  return plotY + (1 - ratio) * plotH; // Invert so higher freq is at top
}

export function render(canvas) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  const W = rect.width;
  const H = rect.height;

  const now = Date.now();
  const windowStart = now - WINDOW_MS;

  // Prune old events
  events = events.filter(e => e.time + e.duration > windowStart);

  // Background — dark with subtle noise feel
  ctx.fillStyle = '#060610';
  ctx.fillRect(0, 0, W, H);

  // Layout
  const LABEL_W = 42;
  const TIME_H = 14;
  const PLOT_X = LABEL_W;
  const PLOT_Y = 2;
  const PLOT_W = W - LABEL_W - 2;
  const PLOT_H = H - TIME_H - PLOT_Y;

  // Draw faint noise floor across the waterfall
  const noiseImg = ctx.createImageData(Math.ceil(PLOT_W), Math.ceil(PLOT_H));
  for (let i = 0; i < noiseImg.data.length; i += 4) {
    const v = Math.random() * 8;
    noiseImg.data[i] = v * 0.3;     // R
    noiseImg.data[i + 1] = v * 0.5; // G
    noiseImg.data[i + 2] = v * 1.2; // B
    noiseImg.data[i + 3] = 255;     // A
  }
  ctx.putImageData(noiseImg, PLOT_X, PLOT_Y);

  // Control channel reference lines (faint horizontal)
  ctx.setLineDash([2, 4]);
  ctx.lineWidth = 0.5;
  for (const ccFreq of CONTROL_CHANNELS) {
    const y = freqToY(ccFreq, PLOT_Y, PLOT_H);
    ctx.strokeStyle = 'rgba(99, 102, 241, 0.2)';
    ctx.beginPath();
    ctx.moveTo(PLOT_X, y);
    ctx.lineTo(PLOT_X + PLOT_W, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Time gridlines
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 0.5;
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.font = '7px monospace';
  ctx.textAlign = 'center';
  for (let t = 0; t <= 10; t += 2) {
    const x = PLOT_X + (t / 10) * PLOT_W;
    ctx.beginPath();
    ctx.moveTo(x, PLOT_Y);
    ctx.lineTo(x, PLOT_Y + PLOT_H);
    ctx.stroke();
    const minAgo = 10 - t;
    ctx.fillText(minAgo === 0 ? 'NOW' : `-${minAgo}m`, x, H - 2);
  }

  // Draw call events as waterfall bands
  for (const ev of events) {
    if (ev.freq === 0) continue;
    if (ev.freq < FREQ_MIN || ev.freq > FREQ_MAX) continue;

    const x1 = PLOT_X + ((ev.time - windowStart) / WINDOW_MS) * PLOT_W;
    const x2 = PLOT_X + ((ev.time + ev.duration - windowStart) / WINDOW_MS) * PLOT_W;
    const barX = Math.max(PLOT_X, x1);
    const barW = Math.max(2, x2 - barX);

    // Each call occupies ~12.5 kHz bandwidth on P25
    const bandwidth = 12500;
    const y1 = freqToY(ev.freq + bandwidth / 2, PLOT_Y, PLOT_H);
    const y2 = freqToY(ev.freq - bandwidth / 2, PLOT_Y, PLOT_H);
    const barY = Math.min(y1, y2);
    const barH = Math.max(3, Math.abs(y2 - y1));

    const rgb = GROUP_COLORS[ev.group] || DEFAULT_COLOR;
    const age = (now - ev.time) / WINDOW_MS;
    const alpha = ev.emergency ? 1.0 : Math.max(0.25, 1.0 - age * 0.7);

    // Glow for recent events
    if (age < 0.03) {
      ctx.shadowColor = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.8)`;
      ctx.shadowBlur = 10;
    }

    if (ev.encrypted) {
      ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha * 0.2})`;
      ctx.fillRect(barX, barY, barW, barH);
      ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha * 0.3})`;
      ctx.lineWidth = 0.5;
      ctx.setLineDash([1, 2]);
      ctx.strokeRect(barX, barY, barW, barH);
      ctx.setLineDash([]);
    } else {
      // Gradient fill for the signal band
      const grad = ctx.createLinearGradient(barX, barY, barX, barY + barH);
      grad.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha * 0.3})`);
      grad.addColorStop(0.5, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha * 0.8})`);
      grad.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha * 0.3})`);
      ctx.fillStyle = grad;
      ctx.fillRect(barX, barY, barW, barH);

      // Bright center line
      const centerY = barY + barH / 2;
      ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
      ctx.fillRect(barX, centerY, barW, 1);
    }

    ctx.shadowBlur = 0;
  }

  // Scanline at "now"
  const scanX = PLOT_X + PLOT_W;
  ctx.strokeStyle = 'rgba(34, 197, 94, 0.4)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(scanX, PLOT_Y);
  ctx.lineTo(scanX, PLOT_Y + PLOT_H);
  ctx.stroke();

  // Frequency labels on left side
  ctx.fillStyle = 'rgba(255,255,255,0.2)';
  ctx.font = '7px monospace';
  ctx.textAlign = 'right';
  const freqStep = 400000; // 0.4 MHz steps
  for (let f = Math.ceil(FREQ_MIN / freqStep) * freqStep; f <= FREQ_MAX; f += freqStep) {
    const y = freqToY(f, PLOT_Y, PLOT_H);
    ctx.fillText((f / 1e6).toFixed(1), PLOT_X - 3, y + 2);

    // Tick mark
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(PLOT_X - 1, y);
    ctx.lineTo(PLOT_X + PLOT_W, y);
    ctx.stroke();
  }

  // MHz label
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.1)';
  ctx.font = '7px monospace';
  ctx.textAlign = 'center';
  ctx.translate(6, PLOT_Y + PLOT_H / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('MHz', 0, 0);
  ctx.restore();
}
