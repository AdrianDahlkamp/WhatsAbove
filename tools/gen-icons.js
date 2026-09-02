#!/usr/bin/env node
"use strict";
/*
 * Generates the static plugin icons (pure Node, no image libraries):
 *   - whatsabove.sdPlugin/icons/plugin.png  (jet on dark rounded tile)
 *   - whatsabove.sdPlugin/icons/adsb.png    (jet + green "live" dot)
 *   - whatsabove.sdPlugin/icons/open.png    (jet + blue arrow)
 *
 * The jet silhouette is the same shape used in the dynamic SVG icons
 * (tools/../whatsabove.sdPlugin/plugin.js: PLANE_100), converted from the
 * two nose bezier curves to a polygon.
 */

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

// ---------------------------------------------------------------------------
// PNG encoder (RGBA8)
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(buf) {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length, 0);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body), 0);
	return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
	const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // color type RGBA
	const raw = Buffer.alloc((width * 4 + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (width * 4 + 1)] = 0; // filter: none
		rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
	}
	const idat = zlib.deflateSync(raw, { level: 9 });
	return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------
// Shape helpers
// ---------------------------------------------------------------------------
function cubic(p0, p1, p2, p3, n = 8) {
	const pts = [];
	for (let i = 0; i <= n; i++) {
		const t = i / n;
		const u = 1 - t;
		const x = u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0];
		const y = u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1];
		pts.push([x, y]);
	}
	return pts;
}

/** Jet silhouette polygon in the 100x100 box (same as PLANE_100 in plugin.js). */
function planePolygon() {
	const pts = [[50, 6]];
	pts.push(...cubic([50, 6], [53.5, 6], [56, 10], [56, 15])); // right nose
	pts.push(
		[56, 32],
		[96, 51],
		[96, 59],
		[57, 51.5],
		[57, 74],
		[74, 84],
		[74, 90.5],
		[52.5, 84.5],
		[47.5, 84.5],
		[26, 90.5],
		[26, 84],
		[43, 74],
		[43, 51.5],
		[4, 59],
		[4, 51],
		[44, 32],
		[44, 15],
	);
	pts.push(...cubic([44, 15], [44, 10], [46.5, 6], [50, 6])); // left nose
	return pts;
}

function insidePolygon(x, y, poly) {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const xi = poly[i][0];
		const yi = poly[i][1];
		const xj = poly[j][0];
		const yj = poly[j][1];
		if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}

/** Thick line as polygon (quadrilateral). */
function thickLine(x0, y0, x1, y1, w) {
	const dx = x1 - x0;
	const dy = y1 - y0;
	const len = Math.hypot(dx, dy) || 1;
	const nx = (-dy / len) * (w / 2);
	const ny = (dx / len) * (w / 2);
	return [
		[x0 + nx, y0 + ny],
		[x1 + nx, y1 + ny],
		[x1 - nx, y1 - ny],
		[x0 - nx, y0 - ny],
	];
}

/** Arrow head as polygon (points in direction from tail to tip). */
function arrowHead(tipX, tipY, fromX, fromY, size) {
	const dx = tipX - fromX;
	const dy = tipY - fromY;
	const len = Math.hypot(dx, dy) || 1;
	const ux = dx / len;
	const uy = dy / len;
	const bx = tipX - ux * size;
	const by = tipY - uy * size;
	const px = -uy;
	const py = ux;
	return [
		[tipX, tipY],
		[bx + px * size * 0.6, by + py * size * 0.6],
		[bx - px * size * 0.6, by - py * size * 0.6],
	];
}

function hexToRgb(hex) {
	const h = hex.replace("#", "");
	return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// ---------------------------------------------------------------------------
// Canvas (with supersampled anti-aliasing)
// ---------------------------------------------------------------------------
class Canvas {
	constructor(size, aa = 4) {
		this.size = size;
		this.aa = aa;
		this.buf = Buffer.alloc(size * size * 4); // transparent
	}

	clear(rgb, alpha = 255) {
		const [r, g, b] = hexToRgb(rgb);
		for (let i = 0; i < this.size * this.size; i++) {
			this.buf[i * 4] = r;
			this.buf[i * 4 + 1] = g;
			this.buf[i * 4 + 2] = b;
			this.buf[i * 4 + 3] = alpha;
		}
	}

	/**
	 * Fill shapes (anti-aliased via coverage).
	 * `shapes` = [{poly, rgb}] (even-odd, first match wins),
	 * `circles` = [{x,y,r,rgb}] (drawn on top of shapes),
	 * `roundedTile` = {x, y, w, h, r} — pixels outside become transparent.
	 */
	compose(shapes, circles, roundedTile) {
		const { buf, size, aa } = this;
		const step = 1 / aa;
		const n = aa * aa;
		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) {
				const o = (y * size + x) * 4;
				const baseR = buf[o];
				const baseG = buf[o + 1];
				const baseB = buf[o + 2];
				const baseA = buf[o + 3];
				if (baseA === 0 && !roundedTile) continue;

				if (roundedTile && !insideRoundedTile(x + 0.5, y + 0.5, roundedTile)) {
					buf[o + 3] = 0;
					continue;
				}

				let hitR = 0;
				let hitG = 0;
				let hitB = 0;
				let hitN = 0;
				for (let sy = 0; sy < aa; sy++) {
					const py = y + (sy + 0.5) * step;
					for (let sx = 0; sx < aa; sx++) {
						const px = x + (sx + 0.5) * step;
						let col = null;
						for (const c of circles || []) {
							const dx = px - c.x;
							const dy = py - c.y;
							if (dx * dx + dy * dy <= c.r * c.r) {
								col = c.rgb;
								break;
							}
						}
						if (!col) {
							for (const s of shapes) {
								if (insidePolygon(px, py, s.poly)) {
									col = s.rgb;
									break;
								}
							}
						}
						if (col) {
							hitR += col[0];
							hitG += col[1];
							hitB += col[2];
							hitN++;
						}
					}
				}
				if (hitN > 0) {
					const cov = hitN / n;
					buf[o] = Math.round((hitR / hitN) * cov + baseR * (1 - cov));
					buf[o + 1] = Math.round((hitG / hitN) * cov + baseG * (1 - cov));
					buf[o + 2] = Math.round((hitB / hitN) * cov + baseB * (1 - cov));
					buf[o + 3] = 255;
				}
			}
		}
	}

	write(file) {
		fs.writeFileSync(file, encodePng(this.size, this.size, this.buf));
		console.log("wrote", path.relative(process.cwd(), file));
	}
}

function insideRoundedTile(x, y, t) {
	if (x < t.x || y < t.y || x > t.x + t.w || y > t.y + t.h) return false;
	const r = t.r;
	const cx = Math.max(t.x + r, Math.min(x, t.x + t.w - r));
	const cy = Math.max(t.y + r, Math.min(y, t.y + t.h - r));
	const dx = x - cx;
	const dy = y - cy;
	return dx * dx + dy * dy <= r * r;
}

// ---------------------------------------------------------------------------
// Build the three icons
// ---------------------------------------------------------------------------
const OUT = path.join(__dirname, "..", "whatsabove.sdPlugin", "icons");
fs.mkdirSync(OUT, { recursive: true });

const SIZE = 512;
const TILE = { x: 8, y: 8, w: 496, h: 496, r: 96 };
const BG = "#151a21";
const FG = "#e8edf2";

const plane = planePolygon();
// place the jet (100 box) centered: box 216 -> scale 2.16, offset (148,148)
const planeScale = 2.16;
const planeOff = [(SIZE - 100 * planeScale) / 2, (SIZE - 100 * planeScale) / 2];
const planeScaled = plane.map(([x, y]) => [x * planeScale + planeOff[0], y * planeScale + planeOff[1]]);

// plugin.png: jet only
{
	const c = new Canvas(SIZE);
	c.clear(BG);
	c.compose([{ poly: planeScaled, rgb: hexToRgb(FG) }], [], TILE);
	c.write(path.join(OUT, "plugin.png"));
}

// adsb.png: jet + green live dot (bottom right)
{
	const c = new Canvas(SIZE);
	c.clear(BG);
	const dot = { x: 424, y: 424, r: 34, rgb: hexToRgb("#4cd97b") };
	c.compose([{ poly: planeScaled, rgb: hexToRgb(FG) }], [dot], TILE);
	c.write(path.join(OUT, "adsb.png"));
}

// open.png: jet (shifted up-left) + blue arrow to the top right
{
	const c = new Canvas(SIZE);
	c.clear(BG);
	const jet = plane.map(([x, y]) => [x * 1.7 + 84, y * 1.7 + 60]);
	const arrowLine = thickLine(262, 316, 372, 206, 26);
	const arrowTip = arrowHead(398, 180, 300, 278, 64);
	c.compose(
		[
			{ poly: jet, rgb: hexToRgb(FG) },
			{ poly: arrowLine, rgb: hexToRgb("#77aaff") },
			{ poly: arrowTip, rgb: hexToRgb("#77aaff") },
		],
		[],
		TILE,
	);
	c.write(path.join(OUT, "open.png"));
}
