"use strict";
/* Shared WebSocket frame helpers (server side: frames unmasked). */
const crypto = require("node:crypto");

function encodeFrame(opcode, payload) {
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
	header[0] = 0x80 | opcode;
	return Buffer.concat([header, payload]);
}

function decodeFrame(buf) {
	if (buf.length < 2) return null;
	const b0 = buf[0];
	const b1 = buf[1];
	const opcode = b0 & 0x0f;
	const masked = (b1 & 0x80) !== 0;
	let len = b1 & 0x7f;
	let offset = 2;
	if (len === 126) {
		if (buf.length < offset + 2) return null;
		len = buf.readUInt16BE(offset);
		offset += 2;
	} else if (len === 127) {
		if (buf.length < offset + 8) return null;
		len = Number(buf.readBigUInt64BE(offset));
		offset += 8;
	}
	let mask = null;
	if (masked) {
		if (buf.length < offset + 4) return null;
		mask = buf.slice(offset, offset + 4);
		offset += 4;
	}
	if (buf.length < offset + len) return null;
	let payload = buf.slice(offset, offset + len);
	if (masked) {
		const out = Buffer.alloc(len);
		for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i % 4];
		payload = out;
	}
	return { opcode, payload, rest: buf.slice(offset + len) };
}

function upgradeKey(key) {
	return crypto
		.createHash("sha1")
		.update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
		.digest("base64");
}

module.exports = { encodeFrame, decodeFrame, upgradeKey };
