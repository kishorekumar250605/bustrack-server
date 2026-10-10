// Tiny live server for BusTrack. No packages needed: run `node server.js`.
// It keeps crowd, traffic and route deviation of every bus and pushes each change to all connected phones.
const http = require('http');
const crypto = require('crypto');
const os = require('os');

const PORT = process.env.PORT || 8080; // hosting services set PORT themselves
const MAX = 50;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const TRAFFIC = ['Low', 'Medium', 'Heavy'];
const buses = {}; // { busId: { crowd, traffic, deviation } }
const clients = new Set();

const blank = () => ({ crowd: 0, traffic: 'Low', deviation: false });

function frame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

function readFrame(b) {
  if (b.length < 2) return null;
  const opcode = b[0] & 0x0f;
  const masked = (b[1] & 0x80) !== 0;
  let len = b[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (b.length < 4) return null;
    len = b.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (b.length < 10) return null;
    len = Number(b.readBigUInt64BE(2));
    off = 10;
  }
  if (len > 1e6) return { opcode: 8, payload: Buffer.alloc(0), size: b.length };
  const maskLen = masked ? 4 : 0;
  if (b.length < off + maskLen + len) return null;
  const payload = Buffer.from(b.subarray(off + maskLen, off + maskLen + len));
  if (masked) {
    const m = b.subarray(off, off + 4);
    for (let i = 0; i < payload.length; i++) payload[i] ^= m[i % 4];
  }
  return { opcode, payload, size: off + maskLen + len };
}

function send(socket, obj) {
  if (socket.writable) socket.write(frame(1, Buffer.from(JSON.stringify(obj))));
}

function broadcast(obj) {
  for (const c of clients) send(c, obj);
}

function onMessage(text) {
  let m;
  try {
    m = JSON.parse(text);
  } catch (e) {
    return;
  }
  if (!m || m.type !== 'set' || typeof m.busId !== 'string' || m.busId.length > 40) return;
  const bus = buses[m.busId] || (buses[m.busId] = blank());
  if (Number.isInteger(m.crowd)) bus.crowd = Math.max(0, Math.min(MAX, m.crowd));
  if (TRAFFIC.includes(m.traffic)) bus.traffic = m.traffic;
  if (typeof m.deviation === 'boolean') bus.deviation = m.deviation;
  broadcast({ type: 'bus', busId: m.busId, ...bus });
  console.log(`${m.busId}  crowd=${bus.crowd}  traffic=${bus.traffic}  deviation=${bus.deviation}`);
}

const server = http.createServer((req, res) => res.end('BusTrack live server'));

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) return socket.destroy();
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  clients.add(socket);
  send(socket, { type: 'state', buses });

  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const f = readFrame(buf);
      if (!f) break;
      buf = buf.subarray(f.size);
      if (f.opcode === 8) {
        socket.end(frame(8, Buffer.alloc(0)));
      } else if (f.opcode === 9) {
        socket.write(frame(10, f.payload));
      } else if (f.opcode === 1) {
        onMessage(f.payload.toString('utf8'));
      }
    }
  });
  const drop = () => clients.delete(socket);
  socket.on('close', drop);
  socket.on('error', drop);
});

// keep connections alive through hosting proxies that close idle sockets
setInterval(() => {
  for (const c of clients) if (c.writable) c.write(frame(9, Buffer.alloc(0)));
}, 25000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('BusTrack live server running. Put one of these in src/config.js:');
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) console.log(`  ws://${i.address}:${PORT}`);
    }
  }
});
