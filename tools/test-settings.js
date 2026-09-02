"use strict";
// Minimal OpenDeck mock that also exercises didReceiveSettings (PI changes).
// Usage: node tools/test-settings.js <port>

const http = require("node:http");
const crypto = require("node:crypto");
const { encodeFrame, decodeFrame, upgradeKey } = require("./wsframe.js");

const port = Number(process.argv[2] || 12410);
const context = "MOCK.Default.Keypad.1.0";
const action = "whatsabove.adsb";

const server = http.createServer((req, res) => res.end("ok"));
server.on("upgrade", (req, socket) => {
	const key = req.headers["sec-websocket-key"];
	if (!key) return socket.destroy();
	socket.write(
		"HTTP/1.1 101 Switching Protocols\r\n" +
			"Upgrade: websocket\r\n" +
			"Connection: Upgrade\r\n" +
			`Sec-WebSocket-Accept: ${upgradeKey(key)}\r\n\r\n`,
	);
	const send = (obj) => socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify(obj), "utf8")));
	const payload = (settings) => ({ settings, coordinates: { row: 0, column: 1 }, controller: "Keypad", state: 0, isInMultiAction: false });

	let buf = Buffer.alloc(0);
	socket.on("data", (chunk) => {
		buf = Buffer.concat([buf, chunk]);
		let f;
		while ((f = decodeFrame(buf))) {
			buf = f.rest;
			if (f.opcode === 0x8) return;
			if (f.opcode === 0x9) {
				socket.write(encodeFrame(0xa, f.payload));
				continue;
			}
			if (f.opcode !== 0x1) continue;
			const msg = JSON.parse(f.payload.toString("utf8"));
			console.log("[ts] <-", msg.event, JSON.stringify(msg.payload || {}).slice(0, 120));
			if (msg.event === "registerPlugin") {
				send({ event: "willAppear", action, context, device: "MOCK", payload: payload({ mode: "nearest", dataHost: "http://10.12.95.235:8080", openUrl: "http://10.12.95.235:8080/", refresh: 2 }) });
				setTimeout(() => {
					// user changed settings in the PI
					send({ event: "didReceiveSettings", action, context, device: "MOCK", payload: payload({ mode: "both", dataHost: "http://10.12.95.235:8080", openUrl: "http://10.12.95.235:8080/", refresh: 2 }) });
				}, 2500);
				setTimeout(() => {
					send({ event: "keyUp", action, context, device: "MOCK", payload: payload({ mode: "both", dataHost: "http://10.12.95.235:8080", openUrl: "http://10.12.95.235:8080/", refresh: 2 }) });
					setTimeout(() => process.exit(0), 500);
				}, 6000);
			}
		}
	});
	socket.on("error", () => {});
});
server.listen(port, "127.0.0.1", () => console.log("[ts] listening on", port));
