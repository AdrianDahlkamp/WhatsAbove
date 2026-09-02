"use strict";

/*
 * Minimal WebSocket client for Node >= 20 with zero external dependencies.
 *
 * OpenDeck launches plugin processes and connects them to a local WebSocket
 * server. Node's global `WebSocket` is only reliably present from Node 22, so
 * we implement the small subset we need (text frames, ping/pong, close) on top
 * of `node:http` + `node:crypto`.
 *
 * API:
 *   const ws = new MiniWS(url);          // url like "ws://127.0.0.1:PORT"
 *   ws.on("open", cb);
 *   ws.on("message", (text) => ...);     // text only
 *   ws.on("close", (code, reason) => ...);
 *   ws.on("error", (err) => ...);
 *   ws.send(textOrBuffer);
 *   ws.close();
 */

const http = require("node:http");
const crypto = require("node:crypto");

const OPCODE = {
	CONT: 0x0,
	TEXT: 0x1,
	BINARY: 0x2,
	CLOSE: 0x8,
	PING: 0x9,
	PONG: 0xa,
};

class MiniWS {
	constructor(url) {
		const u = new URL(url);
		if (!/^ws:/.test(u.protocol)) throw new Error("Only ws:// is supported: " + url);
		this._u = u;
		this._sock = null;
		this._buf = Buffer.alloc(0);
		this._frame = null; // partial frame state
		this._masked = false;
		this._closed = false;
		this._listeners = { open: [], message: [], close: [], error: [] };
		this._connect();
	}

	get readyState() {
		if (this._closed) return 3; // CLOSED
		if (this._sock) return 1; // OPEN
		return 0; // CONNECTING
	}

	on(evt, cb) {
		if (this._listeners[evt]) this._listeners[evt].push(cb);
		return this;
	}

	_emit(evt, ...args) {
		for (const cb of this._listeners[evt] || []) {
			try {
				cb(...args);
			} catch (e) {
				// listener errors must not crash the plugin
			}
		}
	}

	_connect() {
		const key = crypto.randomBytes(16).toString("base64");
		const req = http.request({
			host: this._u.hostname,
			port: this._u.port || 80,
			path: this._u.pathname + this._u.search,
			method: "GET",
			headers: {
				"Connection": "Upgrade",
				"Upgrade": "websocket",
				"Sec-WebSocket-Key": key,
				"Sec-WebSocket-Version": "13",
				"User-Agent": "WhatsAbove/1.0",
			},
		});

		req.on("upgrade", (res, socket) => {
			this._sock = socket;
			socket.setNoDelay(true);
			socket.on("data", (chunk) => this._onData(chunk));
			socket.on("error", (e) => this._emit("error", e));
			socket.on("close", () => this._finish());
			this._emit("open");
		});

		req.on("response", (res) => {
			// Not upgraded.
			this._emit("error", new Error("HTTP " + res.statusCode + " (no websocket upgrade)"));
			res.resume();
			res.on("end", () => this._finish());
		});

		req.on("error", (e) => this._emit("error", e));
		req.end();
	}

	_finish() {
		if (this._closed) return;
		this._closed = true;
		this._emit("close");
	}

	send(data) {
		if (!this._sock || this._closed) return;
		const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
		try {
			this._sock.write(this._encodeFrame(OPCODE.TEXT, payload));
		} catch (e) {
			this._emit("error", e);
		}
	}

	close() {
		if (this._closed) return;
		try {
			this._sock.write(this._encodeFrame(OPCODE.CLOSE, Buffer.alloc(0)));
		} catch {
			/* ignore */
		}
		this._closeSoon();
	}

	_closeSoon() {
		const sock = this._sock;
		if (!sock) return this._finish();
		const t = setTimeout(() => {
			try {
				sock.destroy();
			} catch {
				/* ignore */
			}
			this._finish();
		}, 500);
		t.unref && t.unref();
	}

	// --- framing -------------------------------------------------------------

	_encodeFrame(opcode, payload) {
		const len = payload.length;
		let header;
		if (len < 126) {
			header = Buffer.alloc(2);
			header[1] = len;
		} else if (len < 65536) {
			header = Buffer.alloc(4);
			header[1] = 126;
			header.writeUInt16BE(len, 2);
		} else {
			header = Buffer.alloc(10);
			header[1] = 127;
			header.writeBigUInt64BE(BigInt(len), 2);
		}
		header[0] = 0x80 | opcode; // FIN + opcode
		const mask = crypto.randomBytes(4);
		header[1] |= 0x80; // client must mask
		const masked = Buffer.alloc(len);
		for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
		return Buffer.concat([header, mask, masked]);
	}

	_onData(chunk) {
		this._buf = Buffer.concat([this._buf, chunk]);
		while (true) {
			const frame = this._tryReadFrame();
			if (!frame) break;
			this._handleFrame(frame);
			if (this._closed) return;
		}
	}

	_tryReadFrame() {
		const b = this._buf;
		if (b.length < 2) return null;
		const b0 = b[0];
		const b1 = b[1];
		const opcode = b0 & 0x0f;
		const masked = (b1 & 0x80) !== 0;
		let len = b1 & 0x7f;
		let offset = 2;

		if (len === 126) {
			if (b.length < offset + 2) return null;
			len = b.readUInt16BE(offset);
			offset += 2;
		} else if (len === 127) {
			if (b.length < offset + 8) return null;
			const big = b.readBigUInt64BE(offset);
			if (big > BigInt(0x7fffffff)) {
				this._emit("error", new Error("Frame too large"));
				return null;
			}
			len = Number(big);
			offset += 8;
		}

		let mask = null;
		if (masked) {
			if (b.length < offset + 4) return null;
			mask = b.slice(offset, offset + 4);
			offset += 4;
		}

		if (b.length < offset + len) return null;
		let payload = b.slice(offset, offset + len);
		if (masked) {
			const unmasked = Buffer.alloc(len);
			for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ mask[i % 4];
			payload = unmasked;
		}
		this._buf = b.slice(offset + len);
		return { opcode, payload };
	}

	_handleFrame(frame) {
		const { opcode, payload } = frame;
		switch (opcode) {
			case OPCODE.TEXT:
				this._emit("message", payload.toString("utf8"));
				break;
			case OPCODE.BINARY:
				// Not expected from OpenDeck; ignore.
				break;
			case OPCODE.PING:
				this._sendControl(OPCODE.PONG, payload);
				break;
			case OPCODE.PONG:
				break;
			case OPCODE.CLOSE:
				this._sendControl(OPCODE.CLOSE, Buffer.alloc(0));
				this._closeSoon();
				break;
			case OPCODE.CONT:
				// We don't send fragmented frames and ignore incoming ones.
				break;
			default:
				break;
		}
	}

	_sendControl(opcode, payload) {
		if (!this._sock || this._closed) return;
		try {
			this._sock.write(this._encodeFrame(opcode, payload));
		} catch {
			/* ignore */
		}
	}
}

module.exports = MiniWS;
