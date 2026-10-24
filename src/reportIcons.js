// Report categories and their vector icons (inline SVG, 24x24, 2px round stroke).
// Stable ids are what the database stores — never icon characters.
// The SVG strings below are constants written in this file (no user input), so they are safe to inject as HTML.

export const REPORT_CATEGORIES = [
  { id: 'speed_camera',       label: 'Speed camera',                 color: '#f97316', persistent: true },
  { id: 'road_closure',       label: 'Road closure',                 color: '#ef4444' },
  { id: 'accident_breakdown', label: 'Accident or vehicle breakdown', color: '#d97706' },
  { id: 'congestion',         label: 'Congestion ahead',             color: '#ca8a04' },
  { id: 'other',              label: 'Other hazard',                 color: '#64748b' },
];

export const REPORT_CATEGORY_BY_ID = Object.fromEntries(REPORT_CATEGORIES.map((c) => [c.id, c]));

const ICON_INNER = {
  // enforcement camera on a pole, with radar arcs
  speed_camera:
    '<rect x="3" y="3" width="13" height="7" rx="1.5"/><circle cx="9.5" cy="6.5" r="1.6"/>' +
    '<path d="M9.5 10v10M6 21h7"/><path d="M19 4.5a4 4 0 0 1 0 4M21.5 3a7 7 0 0 1 0 7"/>',
  // striped road barrier on two legs
  road_closure:
    '<rect x="2" y="5" width="20" height="6" rx="1"/><path d="M6 5 3 11M11 5 8 11M16 5l-3 6M21 5l-3 6"/>' +
    '<path d="M5 11v10M19 11v10"/>',
  // tow truck carrying a car
  accident_breakdown:
    '<path d="M2 16h20"/><path d="M15 16V9h4l3 4v3"/><path d="M17 9v4h4"/>' +
    '<path d="M3.5 15v-2.5L5 10h5l1.5 2.5V15"/><path d="M13 9l2-2"/>' +
    '<circle cx="6" cy="18.5" r="2"/><circle cx="12" cy="18.5" r="2"/><circle cx="19" cy="18.5" r="2"/>',
  // three cars queued in a row
  congestion:
    '<path d="M.5 15v-2.5l1.4-2.2h3.2L6.5 12.5V15z"/><path d="M8.5 15v-2.5l1.4-2.2h3.2l1.4 2.2V15z"/>' +
    '<path d="M16.5 15v-2.5l1.4-2.2h3.2l1.4 2.2V15z"/><path d="M1 19h22"/>',
  // general warning triangle
  other:
    '<path d="M12 3 2 20h20z"/><path d="M12 10v4"/><path d="M12 17h.01"/>',
};

// Report-button glyph: warning triangle (used inside the circular button)
export const REPORT_BUTTON_ICON_INNER = '<path d="M12 3 2 20h20z"/><path d="M12 10v4"/><path d="M12 17h.01"/>';

export const iconSvg = (inner, size = 20, stroke = '#fff') =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`;

export const reportIconSvg = (categoryId, size = 20, stroke = '#fff') =>
  iconSvg(ICON_INNER[categoryId] || ICON_INNER.other, size, stroke);