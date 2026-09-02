#!/usr/bin/env node
"use strict";
/*
 * Mock OpenDeck server for testing the WhatsAbove plugin locally.
 *
 * Usage:
 *   node tools/mock-opendeck.js <port> [settingsJson]
 *
 * - Accepts the plugin's WebSocket connection.
 * - Waits for `registerPlugin`.
 * - Sends `willAppear` with a context and the given settings.
 * - After a delay (env KEYUP_AFTER_MS, default 3000) sends `keyUp`.
 * - Prints every event it receives from the plugin (setImage/setTitle/...),
 *   and decodes SVG data URIs to files under tools/out/ for inspection.
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { encodeFrame, decodeFrame, upgradeKey } = require("./wsframe");

const port = Number(process.argv[2] || 12345);
const settings = JSON.parse(process.argv[3] || "{}");
const actionUuid = process.env.ACTION || "de.adrianvd.whatsabove.adsb";
const context = "MOCK.Default.Keypad.0.0"; // OpenDeck serializes ActionContext as a string
const payloadBase = {
	settings,
	coordinates: { row: 0, column: 0 },
	controller: "Keypad",
	state: 0,
	isInMultiAction: false,
};
const KEYUP_AFTER_MS = Number(process.env.KEYUP_AFTER_MS || 3000);

const outDir = path.join(__dirname, "out");
fs.mkdirSync(outDir, { recursive: true });
let imgCount = 0;

function send(sock, obj) {
	sock.write(encodeFrame(0x1, Buffer.from(JSON.stringify(obj), "utf8")));
}

function saveImage(image) {
	if (!image || !image.startsWith("data:image/svg+xml")) return;
	try {
		const b64 = image.split(",")[1];
		const svg = Buffer.from(b64, "base64").toString("utf8");
		const file = path.join(outDir, `img-${String(++imgCount).padStart(3, "0")}.svg`);
		fs.writeFileSync(file, svg);
		console.log(`[mock] saved image -> ${path.relative(process.cwd(), file)}`);
	} catch (e) {
		console.log("[mock] image save failed:", e.message);
	}
}

const server = http.createServer((req, res) => res.end("mock"));
server.on("upgrade", (req, socket) => {
	const key = (req.headers["sec-websocket-key"] || "");
	socket.write(
		"HTTP/1.1 101 Switching Protocols\r\n" +
			"Upgrade: websocket\r\n" +
			"Connection: Upgrade\r\n" +
			`Sec-WebSocket-Accept: ${upgradeKey(key)}\r\n\r\n`,
	);
	let buf = Buffer.alloc(0);
	socket.on("data", (chunk) => {
		buf = Buffer.concat([buf, chunk]);
		while (true) {
			const f = decodeFrame(buf);
			if (!f) break;
			buf = f.rest;
			if (f.opcode === 0x8) return;
			if (f.opcode !== 0x1 && f.opcode !== 0x9) continue;
			if (f.opcode === 0x9) {
				// ping -> pong
				socket.write(encodeFrame(0xa, f.payload));
				continue;
			}
			let msg;
			try {
				msg = JSON.parse(f.payload.toString("utf8"));
			} catch {
				continue;
			}
			console.log("[mock] <-", msg.event, JSON.stringify(msg.payload || {}).slice(0, 300));
			if (msg.event === "registerPlugin") {
				console.log("[mock] registered:", msg.uuid);
				send(socket, {
					event: "willAppear",
					action: actionUuid,
					context,
					device: "MOCK",
					payload: { ...payloadBase },
				});
				setTimeout(() => {
					send(socket, {
						event: "keyDown",
						action: actionUuid,
						context,
						device: "MOCK",
						payload: { ...payloadBase },
					});
					send(socket, {
						event: "keyUp",
						action: actionUuid,
						context,
						device: "MOCK",
						payload: { ...payloadBase },
					});
					console.log("[mock] sent keyDown+keyUp");
				}, KEYUP_AFTER_MS);
			}
			if (msg.event === "setImage") saveImage(msg.payload && msg.payload.image);
		}
	});
});

server.listen(port, "127.0.0.1", () => console.log(`[mock] listening on ${port}`));
