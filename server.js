// RouteX live server. No packages needed: run `node server.js` (Node 18 or newer).
// It keeps crowd, traffic, deviation and GPS of every bus and pushes each change to all connected phones.
// It also issues the rotating QR codes, checks tickets, stores SOS alerts, and (optionally) checks Firebase logins.
//
// Optional settings (environment variables on Render):
//   FIREBASE_PROJECT_ID  turn on login checks: only a conductor who passed Firebase OTP may change a bus
//   CONDUCTOR_PHONES     comma list of allowed conductor numbers, e.g. 9876543210,9123456780 (empty = any)
//   TOMTOM_API_KEY       real traffic from TomTom (uses the bus GPS)
//   TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM, SOS_NUMBERS   send an SMS when somebody presses SOS
//   ADMIN_KEY            lets you open /sos?key=... to list SOS alerts
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const os = require('os');

const PORT = process.env.PORT || 8080;
const MAX = 100;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const PROJECT = process.env.FIREBASE_PROJECT_ID || '';
const SECURE = !!PROJECT;
const CONDUCTOR_PHONES = (process.env.CONDUCTOR_PHONES || '').split(',').map((x) => x.trim()).filter(Boolean);
const TOMTOM_KEY = process.env.TOMTOM_API_KEY || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';

const QR_LIFE_MS = 120 * 1000; // a QR can be scanned for 2 minutes
const TICKET_LIFE_MS = 4 * 60 * 60 * 1000; // a ticket is valid for 4 hours
const MANUAL_TRAFFIC_MS = 10 * 60 * 1000; // a conductor's own traffic choice wins for 10 minutes
const AUTO_TRAFFIC_MS = 5 * 60 * 1000;

const TRAFFIC = ['Low', 'Medium', 'Heavy'];
const buses = {}; // { busId: { crowd, trafficManual, trafficManualAt, trafficAuto, trafficAutoAt, deviation, gps } }
const clients = new Set();
const qrTokens = new Map(); // token -> { busId, exp }
const tickets = new Map(); // id -> ticket
const ticketByOwner = new Map(); // "mobile|busId" -> id
const sosList = [];

const blank = () => ({
  crowd: 0, trafficManual: 'Low', trafficManualAt: 0, trafficAuto: null, trafficAutoAt: 0,
  deviation: false, gps: null, lastTrafficFetch: 0,
});

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

// ---------- what phones see for one bus ----------
function effectiveTraffic(b, now = Date.now()) {
  if (b.trafficManualAt && now - b.trafficManualAt < MANUAL_TRAFFIC_MS) return b.trafficManual;
  if (b.trafficAuto && now - b.trafficAutoAt < AUTO_TRAFFIC_MS) return b.trafficAuto;
  return b.trafficManual;
}
function view(b, now = Date.now()) {
  const o = { crowd: b.crowd, traffic: effectiveTraffic(b, now), deviation: b.deviation };
  if (b.gps) {
    o.gps = { lat: b.gps.lat, lon: b.gps.lon };
    o.gpsAge = now - b.gps.t;
  }
  return o;
}
function allViews() {
  const out = {};
  for (const id of Object.keys(buses)) out[id] = view(buses[id]);
  return out;
}
function pushBus(id) {
  broadcast({ type: 'bus', busId: id, ...view(buses[id]) });
}

// ---------- Firebase login check (no packages: uses Google's public certificates) ----------
let certCache = { certs: null, until: 0 };
function fetchCerts() {
  return new Promise((resolve, reject) => {
    https
      .get('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com', (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          try {
            const m = /max-age=(\d+)/.exec(res.headers['cache-control'] || '');
            certCache = { certs: JSON.parse(body), until: Date.now() + (m ? Number(m[1]) : 3600) * 1000 };
            resolve(certCache.certs);
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}
async function getCerts() {
  if (certCache.certs && Date.now() < certCache.until) return certCache.certs;
  return fetchCerts();
}
const b64u = (s) => Buffer.from(s, 'base64url').toString('utf8');

async function verifyIdToken(token, certs) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('bad token');
  const header = JSON.parse(b64u(parts[0]));
  const p = JSON.parse(b64u(parts[1]));
  if (header.alg !== 'RS256' || !header.kid) throw new Error('bad alg');
  const pem = (certs || (await getCerts()))[header.kid];
  if (!pem) throw new Error('unknown key');
  const key = new crypto.X509Certificate(pem).publicKey;
  const ok = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), key, Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new Error('bad signature');
  const now = Math.floor(Date.now() / 1000);
  if (p.aud !== PROJECT) throw new Error('wrong project');
  if (p.iss !== 'https://securetoken.google.com/' + PROJECT) throw new Error('wrong issuer');
  if (!p.sub || typeof p.exp !== 'number' || p.exp < now) throw new Error('expired');
  if (typeof p.iat === 'number' && p.iat > now + 300) throw new Error('future token');
  return p;
}

// ---------- SMS for SOS (Twilio, optional) ----------
function sendSms(text) {
  const sid = process.env.TWILIO_SID;
  const tok = process.env.TWILIO_TOKEN;
  const from = process.env.TWILIO_FROM;
  const numbers = (process.env.SOS_NUMBERS || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!sid || !tok || !from || !numbers.length) return;
  for (const to of numbers) {
    const body = new URLSearchParams({ To: to, From: from, Body: text }).toString();
    const req = https.request(
      {
        method: 'POST',
        hostname: 'api.twilio.com',
        path: `/2010-04-01/Accounts/${sid}/Messages.json`,
        auth: `${sid}:${tok}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => res.resume()
    );
    req.on('error', () => {});
    req.end(body);
  }
}

// ---------- TomTom traffic (optional) ----------
function trafficFromSpeeds(current, free) {
  if (!(free > 0) || !(current >= 0)) return null;
  const r = current / free;
  return r >= 0.75 ? 'Low' : r >= 0.45 ? 'Medium' : 'Heavy';
}
function fetchTraffic(id) {
  const b = buses[id];
  if (!TOMTOM_KEY || !b || !b.gps || Date.now() - b.lastTrafficFetch < 60000) return;
  b.lastTrafficFetch = Date.now();
  const url = `https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json?point=${b.gps.lat},${b.gps.lon}&key=${TOMTOM_KEY}`;
  https
    .get(url, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          const f = JSON.parse(body).flowSegmentData;
          const level = trafficFromSpeeds(f.currentSpeed, f.freeFlowSpeed);
          if (level) {
            const before = effectiveTraffic(b);
            b.trafficAuto = level;
            b.trafficAutoAt = Date.now();
            if (effectiveTraffic(b) !== before) pushBus(id);
          }
        } catch (e) {
          // ignore bad answer
        }
      });
    })
    .on('error', () => {});
}

// ---------- who may do what ----------
const clean = (s, n) => String(s == null ? '' : s).slice(0, n);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

function canControl(conn, busId) {
  if (!SECURE) return true; // test mode without Firebase
  return conn.verified && conn.role === 'conductor' && conn.busId === busId;
}

function rateOk(conn, key, limit, perMs) {
  const now = Date.now();
  const w = (conn.rate[key] = (conn.rate[key] || []).filter((t) => now - t < perMs));
  if (w.length >= limit) return false;
  w.push(now);
  return true;
}

function newToken() {
  return crypto.randomBytes(6).toString('base64url');
}

async function onHello(conn, m, reply) {
  const role = m.role === 'conductor' ? 'conductor' : 'passenger';
  const mobile = clean(m.mobile, 10).replace(/\D/g, '');
  let verified = false;
  if (SECURE) {
    try {
      const p = await verifyIdToken(m.idToken, m._certs);
      const phone = String(p.phone_number || '');
      if (!phone.endsWith(mobile) || mobile.length !== 10) throw new Error('phone does not match');
      if (role === 'conductor' && CONDUCTOR_PHONES.length && !CONDUCTOR_PHONES.includes(mobile)) {
        throw new Error('not a listed conductor');
      }
      verified = true;
    } catch (e) {
      conn.verified = false;
      conn.role = 'passenger';
      return reply({ type: 'hello', ok: false, reason: e.message });
    }
  }
  conn.verified = verified || !SECURE;
  conn.role = role;
  conn.busId = clean(m.busId, 40);
  conn.mobile = mobile;
  conn.name = clean(m.name, 60);
  reply({ type: 'hello', ok: true });
}

function onSet(conn, m) {
  if (typeof m.busId !== 'string' || m.busId.length > 40) return;
  if (!canControl(conn, m.busId)) return;
  const bus = buses[m.busId] || (buses[m.busId] = blank());
  const before = JSON.stringify(view(bus));
  if (Number.isInteger(m.crowd)) bus.crowd = Math.max(0, Math.min(MAX, m.crowd));
  if (TRAFFIC.includes(m.traffic)) {
    bus.trafficManual = m.traffic;
    bus.trafficManualAt = Date.now();
  }
  if (typeof m.deviation === 'boolean') bus.deviation = m.deviation;
  if (m.gps && isNum(m.gps.lat) && isNum(m.gps.lon) && Math.abs(m.gps.lat) <= 90 && Math.abs(m.gps.lon) <= 180) {
    bus.gps = { lat: m.gps.lat, lon: m.gps.lon, t: Date.now() };
    fetchTraffic(m.busId);
  }
  // a GPS fix alone is still sent (passengers use its time); other fields only when they changed
  if (m.gps || JSON.stringify(view(bus)) !== before) pushBus(m.busId);
}

function issueTicket(conn, m) {
  const t = qrTokens.get(m.token);
  if (!t || t.busId !== m.busId) return { ok: false, reason: 'invalid' };
  if (t.exp < Date.now()) return { ok: false, reason: 'expired' };
  const mobile = conn.mobile || clean(m.mobile, 10).replace(/\D/g, '');
  if (SECURE && !conn.verified) return { ok: false, reason: 'login' };
  const key = mobile + '|' + m.busId;
  const have = ticketByOwner.get(key);
  if (have && tickets.get(have) && tickets.get(have).expiresAt > Date.now()) {
    return { ok: true, ticket: tickets.get(have) }; // same passenger, same bus: same ticket
  }
  const now = Date.now();
  const ticket = {
    id: 'T' + crypto.randomBytes(4).toString('hex').toUpperCase(),
    busId: m.busId, owner: mobile, name: clean(conn.name || m.name, 60),
    issuedAt: now, expiresAt: now + TICKET_LIFE_MS, from: '', to: '', fare: 0,
  };
  tickets.set(ticket.id, ticket);
  ticketByOwner.set(key, ticket.id);
  if (tickets.size > 5000) {
    for (const [id, tk] of tickets) if (tk.expiresAt < now) tickets.delete(id);
  }
  return { ok: true, ticket };
}

function onMessage(conn, text) {
  let m;
  try {
    m = JSON.parse(text);
  } catch (e) {
    return;
  }
  if (!m || typeof m.type !== 'string') return;
  const reply = (obj) => send(conn.socket, m.rid ? { rid: m.rid, ...obj } : obj);

  if (m.type === 'hello') {
    onHello(conn, m, reply);
  } else if (m.type === 'set') {
    onSet(conn, m);
  } else if (m.type === 'qr') {
    const busId = clean(m.busId, 40);
    if (!canControl(conn, busId)) return reply({ type: 'qr', ok: false });
    for (const [k, v] of qrTokens) if (v.exp < Date.now() - 60000) qrTokens.delete(k);
    const token = newToken();
    qrTokens.set(token, { busId, exp: Date.now() + QR_LIFE_MS });
    reply({ type: 'qr', ok: true, busId, token, life: QR_LIFE_MS });
  } else if (m.type === 'claim') {
    if (!rateOk(conn, 'claim', 20, 60000)) return reply({ type: 'ticket', ok: false, reason: 'slow' });
    const r = issueTicket(conn, { ...m, busId: clean(m.busId, 40), token: clean(m.token, 20) });
    reply({ type: 'ticket', ...r });
  } else if (m.type === 'ticket-update') {
    const tk = tickets.get(clean(m.id, 20));
    if (tk && tk.owner === conn.mobile && tk.expiresAt > Date.now()) {
      tk.from = clean(m.from, 80);
      tk.to = clean(m.to, 80);
      tk.fare = isNum(m.fare) ? Math.round(m.fare) : tk.fare;
    }
  } else if (m.type === 'sos') {
    if (!rateOk(conn, 'sos', 5, 60000)) return reply({ type: 'sos', ok: false });
    if (SECURE && !conn.verified) return reply({ type: 'sos', ok: false });
    const rec = {
      id: 'S' + crypto.randomBytes(3).toString('hex').toUpperCase(),
      at: Date.now(), role: conn.role || 'passenger',
      name: clean(m.name || conn.name, 60), mobile: clean(m.mobile || conn.mobile, 10),
      busId: clean(m.busId || conn.busId, 40),
      lat: isNum(m.lat) ? m.lat : null, lon: isNum(m.lon) ? m.lon : null,
    };
    sosList.unshift(rec);
    if (sosList.length > 200) sosList.pop();
    reply({ type: 'sos', ok: true, id: rec.id });
    for (const c of clients) {
      if (c.conn.role === 'conductor' && rec.busId && c.conn.busId === rec.busId) {
        send(c, { type: 'sos-alert', ...rec });
      }
    }
    const where = rec.lat != null ? ` https://maps.google.com/?q=${rec.lat},${rec.lon}` : '';
    sendSms(`RouteX SOS: ${rec.name} +91${rec.mobile} bus ${rec.busId || '-'}${where}`);
    console.log(`SOS ${rec.id} ${rec.name} ${rec.mobile} bus=${rec.busId}`);
  }
}

const server = http.createServer((req, res) => {
  if (req.url && req.url.startsWith('/sos')) {
    const key = new URL(req.url, 'http://x').searchParams.get('key');
    if (ADMIN_KEY && key === ADMIN_KEY) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(sosList));
    }
    res.statusCode = 403;
    return res.end('no');
  }
  res.end('RouteX live server');
});

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
  const conn = { socket, role: 'passenger', busId: '', mobile: '', name: '', verified: false, rate: {} };
  socket.conn = conn;
  clients.add(socket);
  send(socket, { type: 'state', buses: allViews() });

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
        try {
          onMessage(conn, f.payload.toString('utf8'));
        } catch (e) {
          console.log('bad message', e.message);
        }
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

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`RouteX live server running. Login checks: ${SECURE ? 'ON' : 'off (test mode)'}. TomTom: ${TOMTOM_KEY ? 'ON' : 'off'}.`);
    console.log('Put one of these in src/config.js:');
    for (const list of Object.values(os.networkInterfaces())) {
      for (const i of list || []) {
        if (i.family === 'IPv4' && !i.internal) console.log(`  ws://${i.address}:${PORT}`);
      }
    }
  });
}

module.exports = { server, verifyIdToken, trafficFromSpeeds, effectiveTraffic, buses };
