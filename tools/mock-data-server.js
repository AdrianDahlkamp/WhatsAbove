#!/usr/bin/env node
// Deterministic data source for plugin tests: serves aircraft.json / receiver.json.
// Usage: node tools/mock-data-server.js <port>
// Env: AC (JSON array of aircraft; default: one plane with full data)

const http = require('http');

const port = Number(process.argv[2]);
if (!port) {
	console.error('usage: node tools/mock-data-server.js <port>');
	process.exit(1);
}

const aircraft = process.env.AC
	? JSON.parse(process.env.AC)
	: [
			{
				hex: 'a46d6f',
				flight: '  TEST123',
				alt_baro: 36000,
				gs: 460,
				track: 90,
				lat: 54.89592 + 0.1,
				lon: 8.31155 + 0.15,
				seen: 0,
				rssi: -70,
			},
		];

const receiver = { lat: 54.89592, lon: 8.31155, messages: 12345 };

http
	.createServer((req, res) => {
		if (req.url === '/data/aircraft.json') {
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({ now: new Date().toISOString(), messages: 12345, aircraft }));
		} else if (req.url === '/data/receiver.json') {
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify(receiver));
		} else {
			res.statusCode = 404;
			res.end();
		}
	})
	.listen(port, '127.0.0.1', () => console.log(`[mock-data] http://127.0.0.1:${port}`));
