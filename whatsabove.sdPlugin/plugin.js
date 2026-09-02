#!/usr/bin/env node
"use strict";

/*
 * WhatsAbove — OpenDeck plugin
 * ============================
 * Zeigt lokale ADS-B-Daten (dump1090-fa / PiAware SkyAware) auf Stream-Deck-Tasten:
 *   - nächstes Flugzeug (Rufzeichen, Höhe, Entfernung)
 *   - Anzahl aktuell gesehener Flugzeuge
 *   - kombinierbar, per Property Inspector konfigurierbar
 * Ein Tastendruck öffnet die konfigurierte URL (lokaler SkyAware, FlightRadar, ...).
 *
 * Zero-Dependency-Node-Plugin (Node >= 20).
 */

const fs = require("node:fs");
const path = require("node:path");
const MiniWS = require("./wsclient");

// ---------------------------------------------------------------------------
// Argument parsing: OpenDeck launches us with
//   plugin.js -port <n> -pluginUUID <uuid> -registerEvent registerPlugin -info <json>
// ---------------------------------------------------------------------------
function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "-port") out.port = argv[++i];
		else if (argv[i] === "-pluginUUID") out.uuid = argv[++i];
		else if (argv[i] === "-registerEvent") out.registerEvent = argv[++i];
		else if (argv[i] === "-info") out.info = argv[++i];
	}
	return out;
}

const args = parseArgs(process.argv.slice(2));

const ACTION_ADSB = "whatsabove.adsb";

function log(...a) {
	console.log("[whatsabove]", ...a);
}
function warn(...a) {
	console.error("[whatsabove]", ...a);
}

// ---------------------------------------------------------------------------
// WebSocket connection to OpenDeck (with reconnect)
// ---------------------------------------------------------------------------
let ws = null;
let sendQueue = [];
let intentionalClose = false;

function send(obj) {
	const data = JSON.stringify(obj);
	if (ws && ws.readyState === 1 /* open */) {
		ws.send(data);
	} else {
		sendQueue.push(data);
	}
}
function flushQueue() {
	while (sendQueue.length) ws.send(sendQueue.shift());
}
function logToOpenDeck(message) {
	send({ event: "logMessage", payload: { message } });
}

function connect(attempt = 0) {
	intentionalClose = false;
	log("connecting to ws://127.0.0.1:" + args.port, "(attempt", attempt + 1 + ")");
	const sock = new MiniWS("ws://127.0.0.1:" + args.port);
	ws = sock;
	sock.on("open", () => {
		log("connected, registering as", args.uuid);
		sock.send(JSON.stringify({ event: args.registerEvent, uuid: args.uuid }));
		flushQueue();
	});
	sock.on("message", (text) => {
		let msg;
		try {
			msg = JSON.parse(text);
		} catch {
			return;
		}
		handleMessage(msg);
	});
	sock.on("close", () => {
		if (intentionalClose) return;
		const delay = Math.min(1000 * 2 ** attempt, 15000);
		log("connection closed, reconnecting in", delay, "ms");
		setTimeout(() => connect(attempt + 1), delay);
	});
	sock.on("error", (e) => warn("socket error:", e && e.message ? e.message : e));
}

function main() {
	if (!args.port || !args.registerEvent || !args.uuid) {
		warn("Not launched by OpenDeck (missing args). Exiting.");
		process.exit(1);
	}
	connect();
	process.on("SIGTERM", () => process.exit(0));
	process.on("uncaughtException", (e) => warn("uncaught:", e && e.stack));
	process.on("unhandledRejection", (e) => warn("unhandled:", e && e.message ? e.message : e));
}

// ---------------------------------------------------------------------------
// Per-context state
// ---------------------------------------------------------------------------
const contexts = new Map(); // context string -> state

/** OpenDeck serializes ActionContext as "device.profile.controller.position.index". */
function contextToString(context) {
	if (typeof context === "string") return context;
	if (context && typeof context === "object") {
		return `${context.device}.${context.profile}.${context.controller}.${context.position}.${context.index ?? 0}`;
	}
	return String(context);
}

function stateFor(context, action) {
	const key = contextToString(context);
	let st = contexts.get(key);
	if (!st) {
		st = { context: key, action, settings: {}, timer: null, busy: false, lastImage: undefined, lastOk: true };
		contexts.set(key, st);
	}
	st.action = action;
	return st;
}

function stopLoop(st) {
	if (st.timer) {
		clearInterval(st.timer);
		st.timer = null;
	}
}

// ---------------------------------------------------------------------------
// Data layer
// ---------------------------------------------------------------------------
const USER_AGENT = "WhatsAbove/1.0 (OpenDeck plugin)";

async function httpGetJson(url, timeoutMs = 4000) {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const r = await fetch(url, { redirect: "follow", signal: ctrl.signal, headers: { "User-Agent": USER_AGENT } });
		if (!r.ok) throw new Error("HTTP " + r.status);
		return await r.json();
	} finally {
		clearTimeout(t);
	}
}

// Shared in-flight + short-TTL cache so several buttons on the same host
// don't hammer the receiver.
const dataCache = new Map(); // url -> { promise, ts }
const CACHE_TTL_MS = 1200;

function cached(url) {
	const hit = dataCache.get(url);
	const now = Date.now();
	if (hit && now - hit.ts < CACHE_TTL_MS && hit.promise) return hit.promise;
	const promise = httpGetJson(url).catch((e) => {
		hit.error = e;
		throw e;
	});
	const entry = { promise, ts: now, error: null };
	dataCache.set(url, entry);
	promise.catch(() => {
		entry.ts = 0; // on failure: don't cache
	});
	return promise;
}

function normalizeHost(s) {
	let h = (s || "").trim();
	if (!h) return null;
	if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(h)) h = "http://" + h;
	try {
		const u = new URL(h);
		if (u.pathname !== "/" && u.pathname !== "") {
			// user pasted a full page URL; strip to origin
			h = u.origin;
		}
		return h;
	} catch {
		return null;
	}
}

function dataUrls(host) {
	return {
		aircraft: host + "/data/aircraft.json",
		receiver: host + "/data/receiver.json",
	};
}

const receiverCache = new Map(); // host -> { lat, lon, ts }
const RECEIVER_TTL_MS = 5 * 60 * 1000;

async function getReceiver(host) {
	const hit = receiverCache.get(host);
	if (hit && Date.now() - hit.ts < RECEIVER_TTL_MS) return hit;
	const urls = dataUrls(host);
	const data = await httpGetJson(urls.receiver);
	const out = { lat: data.lat, lon: data.lon, ts: Date.now() };
	receiverCache.set(host, out);
	return out;
}

// ---------------------------------------------------------------------------
// Geometry + formatting
// ---------------------------------------------------------------------------
function distanceKm(lat1, lon1, lat2, lon2) {
	const R = 6371;
	const rad = (d) => (d * Math.PI) / 180;
	const dLat = rad(lat2 - lat1);
	const dLon = rad(lon2 - lon1);
	const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
	return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Locale-aware number formats (de = "36.000 / 14,7", en = "36,000 / 14.7").
const FORMATTERS = {
	de: {
		int: new Intl.NumberFormat("de-DE"),
		one: new Intl.NumberFormat("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
	},
	en: {
		int: new Intl.NumberFormat("en-US"),
		one: new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
	},
};
const fmtFor = (lang) => FORMATTERS[lang] || FORMATTERS.en;

// Units: altitude ft (default) or m; distance km (default) or NM.
const FT_TO_M = 0.3048;
const KM_PER_NM = 1.852;

function formatDistance(km, lang, unit) {
	if (km == null) return null;
	const f = fmtFor(lang);
	if (unit === "nm") return f.one.format(km / KM_PER_NM) + " NM";
	if (km < 1) return Math.round(km * 1000) + " m";
	return f.one.format(km) + " km";
}

function formatAltitude(ft, lang, unit) {
	if (ft == null) return null;
	if (unit === "m") return fmtFor(lang).int.format(Math.round(ft * FT_TO_M)) + " m";
	return fmtFor(lang).int.format(Math.round(ft)) + " ft";
}

function callsignOf(a) {
	const c = (a.flight || "").trim();
	return c || (a.hex ? a.hex.toUpperCase() : "?");
}

/**
 * Compute the summary for a button.
 * @returns {{ok, count, nearest: null|{callsign, altFt, distKm, track}, reason}}
 */
function summarize(aircraftJson, receiver) {
	const aircraft = Array.isArray(aircraftJson.aircraft) ? aircraftJson.aircraft : [];
	const count = aircraft.length;
	let nearest = null;
	for (const a of aircraft) {
		if (typeof a.lat !== "number" || typeof a.lon !== "number") continue;
		let d;
		if (receiver && typeof receiver.lat === "number" && typeof receiver.lon === "number") {
			d = distanceKm(receiver.lat, receiver.lon, a.lat, a.lon);
		} else {
			continue;
		}
		if (nearest == null || d < nearest.distKm) {
			nearest = {
				callsign: callsignOf(a),
				altFt: typeof a.alt_baro === "number" ? a.alt_baro : typeof a.alt_geom === "number" ? a.alt_geom : null,
				distKm: d,
				track: typeof a.track === "number" ? a.track : null,
				squawk: typeof a.squawk === "string" && a.squawk.trim() ? a.squawk.trim() : null,
			};
		}
	}
	return { ok: true, count, nearest };
}

// ---------------------------------------------------------------------------
// SVG icon rendering
// ---------------------------------------------------------------------------
const SIZE = 512;

// Top-down jet silhouette in a 100x100 box (points "up" = north).
const PLANE_100 =
	"M50 6 C53.5 6 56 10 56 15 L56 32 L96 51 L96 59 L57 51.5 L57 74 L74 84 L74 90.5 L52.5 84.5 L47.5 84.5 L26 90.5 L26 84 L43 74 L43 51.5 L4 59 L4 51 L44 32 L44 15 C44 10 46.5 6 50 6 Z";

function planeAt(cx, cy, box, color, track, opacity) {
	const scale = box / 100;
	const rot = track != null ? `<g transform="rotate(${track.toFixed(1)} 50 50)">` : "<g>";
	const op = opacity != null ? ` opacity="${opacity}"` : "";
	return `<g transform="translate(${(cx - box / 2).toFixed(1)} ${(cy - box / 2).toFixed(1)}) scale(${scale})">${rot}<path d="${PLANE_100}" fill="${color}"${op}/></g></g>`;
}

function escapeXml(s) {
	return String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

const COL_BG = "#151a21";
const COL_FG = "#e8edf2";
const COL_DIM = "#9fb0c0";
const COL_RED = "#e05555";
const COL_LINE = "#2a3340";

function svgWrap(inner) {
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">` +
		`<rect x="0" y="0" width="${SIZE}" height="${SIZE}" rx="56" fill="${COL_BG}"/>` +
		inner +
		`</svg>`;
	return "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");
}

function textLine(y, text, size, color, weight, anchor) {
	return (
		`<text x="256" y="${y}" text-anchor="${anchor || "middle"}" font-family="'DejaVu Sans','Noto Sans',sans-serif" ` +
		`font-weight="${weight || "bold"}" font-size="${size}" fill="${color}">${escapeXml(text)}</text>`
	);
}

const clampSize = (v, min, max, dflt) => {
	const n = Number(v);
	return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : dflt;
};

// Localized strings for the rendered icons (de = default, en = English).
const L10N = {
	de: {
		offlineHint: "Datenquelle nicht erreichbar",
		noPosition: "keine Position",
		noAircraft: "keine Flugzeuge",
		withoutPosition: (n) => `${n} ohne Positionsdaten`,
		aircraft: (n) => (n === 1 ? "Flugzeug" : "Flugzeuge"),
	},
	en: {
		offlineHint: "data source unreachable",
		noPosition: "no position",
		noAircraft: "no aircraft",
		withoutPosition: (n) => `${n} without position data`,
		aircraft: (n) => "aircraft",
	},
};

// ---------------------------------------------------------------------------
// Configurable lines: which lines are shown and in which order (per key).
// The enabled lines fill fixed slot baselines in their configured order;
// with 2 enabled lines the outer slots are used, with 1 the middle slot, so
// the default order/selection renders exactly like the original layout.
// A line without data leaves its slot empty (as before).
// ---------------------------------------------------------------------------
const LINE_IDS = ["callsign", "altitude", "distance", "squawk"];
const NEAREST_SLOTS = { 1: [364], 2: [288, 432], 3: [288, 364, 432], 4: [280, 346, 412, 478] };
const BOTH_SLOTS = { 1: [254], 2: [186, 322], 3: [186, 254, 322], 4: [164, 208, 252, 296] };
const BOTH_LINE_CAPS = { callsign: 84, altitude: 64, distance: 64, squawk: 64 };
// with four lines in "both" mode the room is too tight for the normal caps
const BOTH_CAP_4LINES = 44;

/** Text + style for one line; null when the flight has no data for it. */
function lineContent(id, n, s) {
	if (id === "callsign")
		return { text: n.callsign.slice(0, 9), size: s.identSize, color: COL_FG, weight: "bold" };
	if (id === "altitude") {
		const t = formatAltitude(n.altFt, s.lang, s.altUnit);
		return t ? { text: t, size: s.altSize, color: COL_DIM, weight: "normal" } : null;
	}
	if (id === "distance") {
		const t = formatDistance(n.distKm, s.lang, s.distUnit);
		return t ? { text: t, size: s.distSize, color: COL_DIM, weight: "normal" } : null;
	}
	if (id === "squawk")
		return n.squawk ? { text: n.squawk, size: s.squawkSize, color: COL_DIM, weight: "normal" } : null;
	return null;
}

/**
 * Render the icon for the current state.
 * @param {object} summary from summarize(), or {ok:false, reason}
 * @param {object} s normalized settings (mode, font sizes, lang)
 * @returns {{image: string}} base64 SVG data URI
 */
function renderIcon(summary, s) {
	const mode = s.mode;
	const L = L10N[s.lang] || L10N.de;

	if (!summary || !summary.ok) {
		return {
			image: svgWrap(
				planeAt(256, 150, 150, COL_RED, null, 0.9) +
					textLine(330, "offline", 72, COL_RED) +
					textLine(400, L.offlineHint, 36, COL_DIM, "normal"),
			),
		};
	}

	const n = summary.nearest;
	const count = summary.count;

	if (mode === "count") {
		const numSize = count >= 1000 ? 150 : 220;
		return {
			image: svgWrap(
				planeAt(256, 110, 96, COL_DIM, null, 0.85) +
					textLine(330, String(count), numSize, COL_FG) +
					textLine(420, L.aircraft(count), 54, COL_DIM, "normal"),
			),
		};
	}

	if (mode === "nearest") {
		if (!n) {
			return {
				image: svgWrap(
					planeAt(256, 150, 150, COL_DIM, null, 0.7) +
						textLine(330, count > 0 ? L.noPosition : L.noAircraft, 52, COL_DIM, "normal") +
						(count > 0 ? textLine(400, L.withoutPosition(count), 36, COL_DIM, "normal") : ""),
				),
			};
		}
		// jet on top, then the enabled lines in the configured slot order
		const slots = NEAREST_SLOTS[s.lines.length] || NEAREST_SLOTS[3];
		let out = planeAt(256, 118, 150, COL_FG, n.track);
		s.lines.forEach((id, i) => {
			const line = lineContent(id, n, s);
			if (line) out += textLine(slots[i], line.text, line.size, line.color, line.weight);
		});
		return { image: svgWrap(out) };
	}

	// mode === "both": jet + ident + stacked alt/dist on top, count on bottom.
	// "both" has less vertical room, so the three lines are capped to fit;
	// the count sits low (baseline 452) to leave room for larger alt/dist lines.
	let top;
	if (!n) {
		top =
			planeAt(256, 70, 92, COL_DIM, null, 0.7) +
			textLine(220, count > 0 ? L.noPosition : L.noAircraft, 52, COL_DIM, "normal");
	} else {
		// "both" has less vertical room, so each line type keeps a cap
		// (tighter cap with four lines).
		const slots = BOTH_SLOTS[s.lines.length] || BOTH_SLOTS[3];
		const four = s.lines.length === 4;
		let out = planeAt(256, 70, 92, COL_FG, n.track);
		s.lines.forEach((id, i) => {
			const line = lineContent(id, n, s);
			if (line)
				out += textLine(
					slots[i],
					line.text,
					Math.min(line.size, four ? BOTH_CAP_4LINES : BOTH_LINE_CAPS[id]),
					line.color,
					line.weight,
				);
		});
		top = out;
	}
	const numSize = count >= 1000 ? 56 : 84;
	return {
		image: svgWrap(
			top +
				`<rect x="64" y="348" width="384" height="4" rx="2" fill="${COL_LINE}"/>` +
				`<text x="256" y="456" text-anchor="middle" font-family="'DejaVu Sans','Noto Sans',sans-serif">` +
				`<tspan font-weight="bold" font-size="${numSize}" fill="${COL_FG}">${count}</tspan>` +
				`<tspan font-weight="normal" font-size="${numSize === 56 ? 32 : 44}" fill="${COL_DIM}" dx="10"> ${L.aircraft(count)}</tspan>` +
				`</text>`,
		),
	};
}

// ---------------------------------------------------------------------------
// ADS-B action
// ---------------------------------------------------------------------------
const DEFAULTS_ADSB = {
	lang: "en",
	mode: "nearest",
	dataHost: "0.0.0.0",
	openUrl: "http://0.0.0.0:8080/",
	refresh: 5,
	altUnit: "ft",
	distUnit: "km",
	lines: ["callsign", "altitude", "distance"],
	// configurable font sizes (SVG units on the 512 viewBox)
	identSize: 80,
	altSize: 46,
	distSize: 46,
	squawkSize: 46,
};

function normalizeSettings(raw, defaults) {
	const s = Object.assign({}, defaults, raw || {});
	s.lang = s.lang === "de" || s.lang === "en" ? s.lang : defaults.lang;
	s.mode = ["nearest", "count", "both"].includes(s.mode) ? s.mode : defaults.mode;
	s.dataHost = (s.dataHost || defaults.dataHost).trim();
	s.openUrl = (s.openUrl || "").trim();
	const r = Number(s.refresh);
	s.refresh = Number.isFinite(r) ? Math.min(120, Math.max(1, r)) : defaults.refresh;
	s.altUnit = s.altUnit === "m" ? "m" : "ft";
	s.distUnit = s.distUnit === "nm" ? "nm" : "km";
	const rawLines = Array.isArray(s.lines) ? s.lines : [];
	const lines = [];
	for (const id of rawLines) if (LINE_IDS.includes(id) && !lines.includes(id)) lines.push(id);
	s.lines = lines.length ? lines : defaults.lines;
	s.identSize = clampSize(s.identSize, 24, 140, defaults.identSize);
	s.altSize = clampSize(s.altSize, 20, 80, defaults.altSize);
	s.distSize = clampSize(s.distSize, 20, 80, defaults.distSize);
	s.squawkSize = clampSize(s.squawkSize, 20, 80, defaults.squawkSize);
	return s;
}

async function updateAdsB(st) {
	if (st.busy) return;
	st.busy = true;
	try {
		const s = st.settings;
		const host = normalizeHost(s.dataHost);
		if (!host) {
			pushIcon(st, renderIcon({ ok: false, reason: "no host" }, s));
			return;
		}
		const urls = dataUrls(host);
		let aircraftJson = null;
		try {
			aircraftJson = await cached(urls.aircraft);
		} catch (e) {
			pushIcon(st, renderIcon({ ok: false, reason: e.message }, s));
			logToOpenDeck(`aircraft.json nicht erreichbar (${host}): ${e.message}`);
			return;
		}
		let receiver = null;
		try {
			receiver = await getReceiver(host);
		} catch {
			// receiver position unknown -> distances unavailable, but data still shows
		}
		const summary = summarize(aircraftJson, receiver);
		pushIcon(st, renderIcon(summary, s));
	} catch (e) {
		warn("update failed:", e.message);
	} finally {
		st.busy = false;
	}
}

function pushIcon(st, rendered) {
	if (rendered.image !== st.lastImage) {
		st.lastImage = rendered.image;
		send({ event: "setImage", context: st.context, payload: { image: rendered.image, state: 0 } });
	}
}

function startAdsBLoop(st) {
	stopLoop(st);
	const ms = st.settings.refresh * 1000;
	st.timer = setInterval(() => updateAdsB(st), ms);
	updateAdsB(st);
	log(`adsb loop started for ${st.context} (mode=${st.settings.mode}, refresh=${st.settings.refresh}s, host=${st.settings.dataHost})`);
}

function handleAdsB(msg, event) {
	const st = stateFor(msg.context, ACTION_ADSB);
	if (event === "willAppear" || event === "didReceiveSettings") {
		st.settings = normalizeSettings(msg.payload && msg.payload.settings, DEFAULTS_ADSB);
		st.lastImage = undefined;
		startAdsBLoop(st);
	} else if (event === "keyUp") {
		// open on release, so a single press opens the URL exactly once
		const url = (st.settings.openUrl || "").trim();
		if (url) {
			log("opening", url);
			send({ event: "openUrl", payload: { url } });
		}
	} else if (event === "willDisappear") {
		stopLoop(st);
		contexts.delete(st.context);
		log("adsb loop stopped for", st.context);
	}
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------
function handleMessage(msg) {
	const event = msg.event;
	if (event === "willAppear" || event === "didReceiveSettings" || event === "keyDown" || event === "keyUp" || event === "willDisappear") {
		if (msg.action === ACTION_ADSB) return handleAdsB(msg, event);
		log("ignoring action:", msg.action);
		return;
	}
	log("ignoring event:", event);
}

main();
