/**
 * emojiIcons — Renders emoji as canvas images and registers them with Mapbox.
 *
 * Mapbox GL JS symbol layers can't render emoji in text-field (SDF font limitation).
 * This module draws emoji onto a canvas, converts to ImageData, and adds them
 * as icon images that can be used with `icon-image` in symbol layers.
 */

const EMOJI_LIST = [
  // Radio incidents / dispatch
  { id: 'emoji-fire',      char: '\u{1F525}' },   // 🔥
  { id: 'emoji-ambulance',  char: '\u{1F691}' },   // 🚑
  { id: 'emoji-police-car', char: '\u{1F694}' },   // 🚔
  { id: 'emoji-car',        char: '\u{1F697}' },   // 🚗
  { id: 'emoji-anchor',     char: '\u{2693}'  },   // ⚓
  { id: 'emoji-radio',      char: '\u{1F4FB}' },   // 📻
  // Transit
  { id: 'emoji-bus',        char: '\u{1F68C}' },   // 🚌
  { id: 'emoji-tram',       char: '\u{1F68A}' },   // 🚊
  // Traffic events
  { id: 'emoji-warning',    char: '\u{26A0}\u{FE0F}' },  // ⚠️
  { id: 'emoji-construction', char: '\u{1F6A7}' }, // 🚧
  { id: 'emoji-siren',      char: '\u{1F6A8}' },   // 🚨
  { id: 'emoji-no-entry',   char: '\u{26D4}' },    // ⛔
  { id: 'emoji-snail',      char: '\u{1F40C}' },   // 🐌
  { id: 'emoji-circus',     char: '\u{1F3AA}' },   // 🎪
];

const SIZE = 48;  // px — rendered at 2x for retina
const PIXEL_RATIO = 2;

function renderEmoji(char) {
  const canvas = document.createElement('canvas');
  const size = SIZE * PIXEL_RATIO;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  // Use explicit emoji fonts — 'serif' alone may not render color emoji on all platforms
  ctx.font = `${size * 0.75}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(char, size / 2, size / 2);
  return ctx.getImageData(0, 0, size, size);
}

/**
 * Register all emoji icons with a Mapbox map instance.
 * Call this once after the map style loads.
 */
export function registerEmojiIcons(map) {
  for (const { id, char } of EMOJI_LIST) {
    if (map.hasImage(id)) map.removeImage(id);
    const imageData = renderEmoji(char);
    map.addImage(id, imageData, { pixelRatio: PIXEL_RATIO });
  }
}

/**
 * Mapping from semantic emoji name → registered icon ID.
 * Use these values as the `icon` property in GeoJSON features.
 */
export const ICON_IDS = {
  // Radio / dispatch types
  fire:      'emoji-fire',
  medical:   'emoji-ambulance',
  police:    'emoji-police-car',
  traffic:   'emoji-car',
  maritime:  'emoji-anchor',
  other:     'emoji-radio',
  // Transit
  bus:       'emoji-bus',
  tram:      'emoji-tram',
  // Traffic events
  warning:       'emoji-warning',
  construction:  'emoji-construction',
  incident:      'emoji-siren',
  road_closure:  'emoji-no-entry',
  congestion:    'emoji-snail',
  special_event: 'emoji-circus',
};
