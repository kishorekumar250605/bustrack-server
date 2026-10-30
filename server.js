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
const shownTickets = new Map(); // busId -> ticketed count last sent to phones
const onboard = new Map(); // busId -> Set of ticket ids whose passengers are still on the bus
const MAX_TICKETS = MAX; // one passenger can take any number of tickets, up to the bus capacity
const ticketByOwner = new Map(); // "mobile|busId" -> id
const sosList = []; // every emergency (newest first)
const incidents = new Map(); // id -> emergency record
const contactsByMobile = new Map(); // passenger mobile -> up to 3 family numbers
const TRAIL_MAX = 500;
const TRACK_KEEP_MS = 60 * 60 * 1000; // a tracking link works for 1 hour after the emergency is closed

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
// Passengers with a ticket who have not yet reached their stop (every ticket counts as many people as it has seats)
function ticketed(id, now = Date.now()) {
  const set = onboard.get(id);
  if (!set) return 0;
  let n = 0;
  for (const tid of set) {
    const tk = tickets.get(tid);
    if (!tk || !tk.dropAt || tk.dropAt <= now || tk.expiresAt <= now) set.delete(tid);
    else if (!tk.startAt || tk.startAt <= now) n += tk.qty; // an online booking counts only after the bus reaches its From stop
  }
  if (!set.size) onboard.delete(id);
  return n;
}
// crowd on the bus = tickets of passengers who are still riding (automatic; the conductor does not set it)
function view(b, now = Date.now(), id = '') {
  const t = id ? ticketed(id, now) : 0;
  const o = { crowd: Math.min(MAX, t), ticketed: t, traffic: effectiveTraffic(b, now), deviation: b.deviation };
  if (b.gps) {
    o.gps = { lat: b.gps.lat, lon: b.gps.lon };
    o.gpsAge = now - b.gps.t;
  }
  return o;
}
function allViews() {
  const out = {};
  for (const id of Object.keys(buses)) out[id] = view(buses[id], Date.now(), id);
  return out;
}
function pushBus(id) {
  const v = view(buses[id], Date.now(), id);
  if (v.ticketed) shownTickets.set(id, v.ticketed);
  else shownTickets.delete(id);
  broadcast({ type: 'bus', busId: id, ...v });
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
function sendSms(text, extra = []) {
  const sid = process.env.TWILIO_SID;
  const tok = process.env.TWILIO_TOKEN;
  const from = process.env.TWILIO_FROM;
  const numbers = [
    ...(process.env.SOS_NUMBERS || '').split(',').map((x) => x.trim()).filter(Boolean),
    ...extra.map((x) => '+91' + x),
  ];
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
  const before = JSON.stringify(view(bus, Date.now(), m.busId));
  // crowd is automatic: it comes only from tickets, so a conductor's crowd value is ignored
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
  if (m.gps || JSON.stringify(view(bus, Date.now(), m.busId)) !== before) pushBus(m.busId);
}

function issueTicket(conn, m) {
  const t = qrTokens.get(m.token);
  if (!t || t.busId !== m.busId) return { ok: false, reason: 'invalid' };
  if (t.exp < Date.now()) return { ok: false, reason: 'expired' };
  const mobile = conn.mobile || clean(m.mobile, 10).replace(/\D/g, '');
  if (SECURE && !conn.verified) return { ok: false, reason: 'login' };
  const key = mobile + '|' + m.busId;
  const have = ticketByOwner.get(key);
  const old = have && tickets.get(have);
  if (old && old.expiresAt > Date.now() && (!old.dropAt || old.dropAt > Date.now())) {
    return { ok: true, ticket: tickets.get(have) }; // same passenger, same bus: same ticket
  }
  const now = Date.now();
  const ticket = {
    id: 'T' + crypto.randomBytes(4).toString('hex').toUpperCase(),
    busId: m.busId, owner: mobile, name: clean(conn.name || m.name, 60),
    issuedAt: now, expiresAt: now + TICKET_LIFE_MS, from: '', to: '', fare: 0, qty: 1, dropAt: 0,
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
  } else if (m.type === 'book') {
    // online booking: no conductor QR needed. The ticket has its own QR; its seats count from the time the bus reaches the From stop
    if (!rateOk(conn, 'book', 10, 60000)) return reply({ type: 'ticket', ok: false, reason: 'slow' });
    if (SECURE && !conn.verified) return reply({ type: 'ticket', ok: false, reason: 'login' });
    const busId = clean(m.busId, 40);
    const qty = Number.isInteger(m.qty) ? Math.max(1, Math.min(MAX_TICKETS, m.qty)) : 1;
    const wait = isNum(m.wait) && m.wait >= 0 && m.wait <= 360 ? m.wait : 0;
    const ride = isNum(m.ride) && m.ride >= 0 && m.ride <= 360 ? m.ride : 0;
    if (!busId || !clean(m.from, 80) || !clean(m.to, 80)) return reply({ type: 'ticket', ok: false, reason: 'invalid' });
    const now = Date.now();
    const tk = {
      id: 'B' + crypto.randomBytes(4).toString('hex').toUpperCase(),
      busId, owner: conn.mobile || clean(m.mobile, 10).replace(/\D/g, ''), name: clean(conn.name || m.name, 60),
      issuedAt: now, expiresAt: now + 12 * 3600 * 1000, online: true,
      from: clean(m.from, 80), to: clean(m.to, 80), fare: isNum(m.fare) ? Math.round(m.fare) : 0, qty,
      startAt: now + wait * 60000, dropAt: now + (wait + ride) * 60000,
    };
    tickets.set(tk.id, tk);
    if (!onboard.has(busId)) onboard.set(busId, new Set());
    onboard.get(busId).add(tk.id);
    if (!buses[busId]) buses[busId] = blank();
    pushBus(busId);
    reply({ type: 'ticket', ok: true, ticket: tk });
  } else if (m.type === 'ticket-update') {
    const tk = tickets.get(clean(m.id, 20));
    if (tk && tk.owner === conn.mobile && tk.expiresAt > Date.now()) {
      tk.from = clean(m.from, 80);
      tk.to = clean(m.to, 80);
      tk.fare = isNum(m.fare) ? Math.round(m.fare) : tk.fare;
      if (Number.isInteger(m.qty)) tk.qty = Math.max(1, Math.min(MAX_TICKETS, m.qty));
      // seats are taken from now until the ride to the destination stop is over
      if (isNum(m.ride) && m.ride >= 0 && m.ride <= 360) {
        tk.dropAt = Date.now() + m.ride * 60000;
        if (!onboard.has(tk.busId)) onboard.set(tk.busId, new Set());
        onboard.get(tk.busId).add(tk.id);
        if (!buses[tk.busId]) buses[tk.busId] = blank();
        pushBus(tk.busId);
      }
    }
  } else if (m.type === 'sos') {
    if (!rateOk(conn, 'sos', 5, 60000)) return reply({ type: 'sos', ok: false });
    if (SECURE && !conn.verified) return reply({ type: 'sos', ok: false });
    const mobile = clean(m.mobile || conn.mobile, 10);
    const rec = {
      id: 'S' + crypto.randomBytes(3).toString('hex').toUpperCase(),
      token: crypto.randomBytes(8).toString('hex'),
      at: Date.now(), role: conn.role || 'passenger',
      name: clean(m.name || conn.name, 60), mobile,
      busId: clean(m.busId || conn.busId, 40), routeNo: clean(m.routeNo, 12),
      lat: isNum(m.lat) ? m.lat : null, lon: isNum(m.lon) ? m.lon : null, locAt: isNum(m.lat) ? Date.now() : 0,
      trail: isNum(m.lat) ? [[m.lat, m.lon, Date.now()]] : [],
      status: 'open', ackAt: 0, ackBy: '', resolvedAt: 0, note: '',
      contacts: (contactsByMobile.get(mobile) || []).slice(),
    };
    sosList.unshift(rec);
    if (sosList.length > 200) sosList.pop();
    incidents.set(rec.id, rec);
    const host = conn.host || process.env.PUBLIC_HOST || '';
    const link = host ? `https://${host}/t/${rec.id}?k=${rec.token}` : '';
    reply({ type: 'sos', ok: true, id: rec.id, link, contacts: rec.contacts.length });
    for (const c of clients) {
      if (c.conn.role === 'conductor' && rec.busId && c.conn.busId === rec.busId) {
        send(c, { type: 'sos-alert', id: rec.id, name: rec.name, mobile: rec.mobile, busId: rec.busId, lat: rec.lat, lon: rec.lon, at: rec.at });
      }
    }
    // family members and the control room get an SMS with the live tracking link (if Twilio is set up)
    const where = rec.lat != null ? ` Location: https://maps.google.com/?q=${rec.lat},${rec.lon}` : '';
    sendSms(`RouteX EMERGENCY: ${rec.name} +91${rec.mobile} needs help. Bus ${rec.routeNo || '-'} ${rec.busId || '-'}.${where}${link ? ' Live tracking: ' + link : ''}`, rec.contacts);
    console.log(`SOS ${rec.id} ${rec.name} ${rec.mobile} bus=${rec.busId} family=${rec.contacts.length}`);
  } else if (m.type === 'sos-loc') {
    // the passenger's phone sends its position every few seconds while the emergency is open
    const rec = incidents.get(clean(m.id, 12));
    if (!rec || rec.mobile !== conn.mobile || rec.resolvedAt) return reply({ type: 'sos-loc', ok: false, status: rec ? rec.status : 'unknown' });
    if (isNum(m.lat) && isNum(m.lon)) {
      rec.lat = m.lat;
      rec.lon = m.lon;
      rec.locAt = Date.now();
      rec.trail.push([m.lat, m.lon, rec.locAt]);
      if (rec.trail.length > TRAIL_MAX) rec.trail.shift();
    }
    reply({ type: 'sos-loc', ok: true, status: rec.status, ackBy: rec.ackBy, note: rec.note });
  } else if (m.type === 'sos-cancel') {
    const rec = incidents.get(clean(m.id, 12));
    if (rec && rec.mobile === conn.mobile && !rec.resolvedAt) {
      rec.status = 'safe';
      rec.resolvedAt = Date.now();
      rec.note = 'Passenger marked themselves safe';
    }
    reply({ type: 'sos-cancel', ok: !!rec });
  } else if (m.type === 'contacts-set') {
    const list = (Array.isArray(m.contacts) ? m.contacts : [])
      .map((x) => clean(String(x), 10).replace(/\D/g, ''))
      .filter((x) => x.length === 10)
      .slice(0, 3);
    if (conn.mobile) contactsByMobile.set(conn.mobile, [...new Set(list)]);
    reply({ type: 'contacts', ok: true, contacts: contactsByMobile.get(conn.mobile) || [] });
  } else if (m.type === 'contacts-get') {
    reply({ type: 'contacts', ok: true, contacts: contactsByMobile.get(conn.mobile) || [] });
  }
}

// ---------- control room (admin) and family tracking pages ----------
const publicRec = (r) => ({
  id: r.id, at: r.at, name: r.name, mobile: r.mobile, busId: r.busId, routeNo: r.routeNo,
  lat: r.lat, lon: r.lon, locAt: r.locAt, status: r.status, ackAt: r.ackAt, ackBy: r.ackBy,
  resolvedAt: r.resolvedAt, note: r.note, family: r.contacts.length,
});
const json = (res, code, obj) => {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
};
const adminOk = (key) => ADMIN_KEY && key === ADMIN_KEY;
function readBody(req, cb) {
  let b = '';
  req.on('data', (c) => {
    b += c;
    if (b.length > 5000) req.destroy();
  });
  req.on('end', () => {
    try {
      cb(JSON.parse(b || '{}'));
    } catch (e) {
      cb({});
    }
  });
}
const PAGE_HEAD = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">';
const ADMIN_PAGE = PAGE_HEAD + `<title>RouteX Control Room</title><style>body{font-family:Arial,sans-serif;background:#efe3c8;margin:0;padding:14px;color:#2e2015}h1{margin:0 0 10px}.c{background:#faf3e0;border:2px solid #2e2015;border-radius:6px;padding:12px;margin-bottom:10px}.open{border-color:#9b2c2c}.t{font-weight:bold;font-size:18px}.b{margin:6px 6px 0 0;padding:8px 12px;border:0;border-radius:4px;background:#3b2a1e;color:#fff;font-weight:bold;cursor:pointer}.r{background:#4f6f3a}small{color:#7a6650}input{padding:6px;width:60%}</style></head><body><h1>RouteX Control Room</h1><div id="l">Loading...</div><script>
var K=new URLSearchParams(location.search).get('key');
function el(t,x,c){var e=document.createElement(t);if(x)e.textContent=x;if(c)e.className=c;return e}
function act(p,id,note){fetch('/admin/'+p,{method:'POST',body:JSON.stringify({key:K,id:id,note:note||'',by:'Control room'})}).then(load)}
function load(){fetch('/admin/data?key='+encodeURIComponent(K)).then(function(r){return r.json()}).then(function(d){var L=document.getElementById('l');L.textContent='';if(!d.length)L.textContent='No emergencies.';d.forEach(function(x){var c=el('div','', 'c'+(x.status==='open'?' open':''));c.appendChild(el('div',x.name+'  +91'+x.mobile+'  ['+x.status.toUpperCase()+']','t'));c.appendChild(el('div','Bus '+(x.routeNo||'-')+'  '+(x.busId||'-')+'   Family alerted: '+x.family));c.appendChild(el('small','Started '+new Date(x.at).toLocaleTimeString()+(x.locAt?'   Last location '+Math.round((Date.now()-x.locAt)/1000)+' s ago':'   No location')+(x.ackBy?'   Acknowledged by '+x.ackBy:'')+(x.note?'   Note: '+x.note:'')));c.appendChild(el('br'));if(x.lat!=null){var a=el('a','Open live location');a.href='https://maps.google.com/?q='+x.lat+','+x.lon;a.target='_blank';c.appendChild(a)}c.appendChild(el('br'));if(!x.resolvedAt){if(x.status==='open'){var b1=el('button','Acknowledge','b');b1.onclick=function(){act('ack',x.id)};c.appendChild(b1)}var n=el('input');n.placeholder='Note (help sent, police called...)';c.appendChild(n);var b2=el('button','Resolve and close','b r');b2.onclick=function(){act('resolve',x.id,n.value)};c.appendChild(b2)}L.appendChild(c)})})}
load();setInterval(load,5000);
</script></body></html>`;
const TRACK_PAGE = PAGE_HEAD + `<title>RouteX Live Tracking</title><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><style>body{margin:0;font-family:Arial,sans-serif}#i{padding:10px;background:#faf3e0;border-bottom:2px solid #2e2015}#m{height:calc(100vh - 90px)}</style></head><body><div id="i">Loading...</div><div id="m"></div><script>
var p=location.pathname.split('/');var id=p[2];var k=new URLSearchParams(location.search).get('k');
var map=L.map('m').setView([13.08,80.27],12);L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'OpenStreetMap'}).addTo(map);
var mk=null,ln=null,first=true;
function load(){fetch('/t/'+id+'.json?k='+k).then(function(r){return r.json()}).then(function(d){
 var t=d.name+' | Bus '+(d.routeNo||'-')+' '+(d.busId||'-')+' | '+d.status.toUpperCase();
 if(d.locAt)t+=' | updated '+Math.round((Date.now()-d.locAt)/1000)+' s ago';
 document.getElementById('i').textContent=t;
 if(d.lat!=null){var ll=[d.lat,d.lon];if(!mk)mk=L.marker(ll).addTo(map);mk.setLatLng(ll);
  var tr=d.trail.map(function(x){return [x[0],x[1]]});if(!ln)ln=L.polyline(tr,{color:'#9b2c2c'}).addTo(map);ln.setLatLngs(tr);
  if(first){map.setView(ll,16);first=false}}
}).catch(function(){document.getElementById('i').textContent='This link is no longer active.'})}
load();setInterval(load,5000);
</script></body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url || '/', 'http://x');
  const path = u.pathname;
  if (path === '/sos') {
    if (adminOk(u.searchParams.get('key'))) return json(res, 200, sosList.map(publicRec));
    res.statusCode = 403;
    return res.end('no');
  }
  if (path === '/admin') {
    if (!adminOk(u.searchParams.get('key'))) {
      res.statusCode = 403;
      return res.end('Set ADMIN_KEY on the server and open /admin?key=YOUR_KEY');
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(ADMIN_PAGE);
  }
  if (path === '/admin/data') {
    if (!adminOk(u.searchParams.get('key'))) return json(res, 403, { error: 'no' });
    return json(res, 200, sosList.map(publicRec));
  }
  if ((path === '/admin/ack' || path === '/admin/resolve') && req.method === 'POST') {
    return readBody(req, (b) => {
      if (!adminOk(b.key)) return json(res, 403, { error: 'no' });
      const rec = incidents.get(String(b.id || ''));
      if (!rec) return json(res, 404, { error: 'unknown' });
      const now = Date.now();
      if (path === '/admin/ack' && rec.status === 'open') {
        rec.status = 'acknowledged';
        rec.ackAt = now;
        rec.ackBy = clean(b.by || 'Control room', 40);
      } else if (path === '/admin/resolve' && !rec.resolvedAt) {
        rec.status = 'resolved';
        rec.resolvedAt = now;
        rec.note = clean(b.note, 120);
        if (!rec.ackAt) {
          rec.ackAt = now;
          rec.ackBy = clean(b.by || 'Control room', 40);
        }
      }
      json(res, 200, publicRec(rec));
    });
  }
  const t = path.match(/^\/t\/(S[0-9A-F]{6})(\.json)?$/);
  if (t) {
    const rec = incidents.get(t[1]);
    const k = u.searchParams.get('k');
    const dead = !rec || rec.token !== k || (rec.resolvedAt && Date.now() - rec.resolvedAt > TRACK_KEEP_MS);
    if (t[2]) {
      if (dead) return json(res, 404, { error: 'gone' });
      return json(res, 200, { ...publicRec(rec), trail: rec.trail });
    }
    if (dead) {
      res.statusCode = 404;
      return res.end('This tracking link is no longer active.');
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(TRACK_PAGE);
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
  const conn = { socket, role: 'passenger', busId: '', mobile: '', name: '', verified: false, rate: {}, host: req.headers.host || '' };
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

// seats are given back when passengers reach their stop: tell every phone when the count on a bus changes
function refreshCrowd() {
  for (const id of new Set([...onboard.keys(), ...shownTickets.keys()])) {
    const n = ticketed(id);
    if ((shownTickets.get(id) || 0) !== n) {
      if (n) shownTickets.set(id, n);
      else shownTickets.delete(id);
      if (buses[id]) pushBus(id);
    }
  }
}
setInterval(refreshCrowd, 10000);

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

module.exports = { server, verifyIdToken, trafficFromSpeeds, effectiveTraffic, buses, refreshCrowd };
