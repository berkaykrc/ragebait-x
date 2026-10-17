// The brand mark's geometry — the single source of truth both emitters
// (mark.svg and the PNG rasteriser) derive from. Section 2 of the branding
// plan fixes these coordinates on a 128-unit grid, and this file holds ONLY
// geometry: no rendering logic lives here, so SVG and PNG cannot drift apart.
//
// A rounded-square "specimen" tile with three stacked bars of increasing
// width — a miniature signal meter, the same idea as the hovercard pill.
// The plan pins the tile radius (28) and the bar rectangles exactly; the bars
// are square-cornered because the plan assigns them no radius on purpose:
// every bar is 16 units tall, 2px at 16px, and any rounding there would eat
// the legibility floor the icons test enforces.

export const SIZES = [16, 32, 48, 64, 96, 128];

export const PRIMS = [
  { type: "rect", x: 0, y: 0, w: 128, h: 128, rx: 28, fill: "#0b0d10" },
  { type: "rect", x: 20, y: 18, w: 40, h: 16, rx: 0, fill: "#e7eaee" },
  { type: "rect", x: 20, y: 44, w: 64, h: 16, rx: 0, fill: "#e7eaee" },
  // The longest bar carries the accent.
  { type: "rect", x: 20, y: 70, w: 88, h: 16, rx: 0, fill: "#4cc2c4" },
];
