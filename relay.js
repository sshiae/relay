'use strict';

/*
 * Public relay for the personal remote desktop.
 *
 * Deploy this on a free Node host (Render/Koyeb). It gives a permanent public
 * https/wss address. Your PC runs `agent.js`, which dials OUT to this relay
 * over ordinary TLS/443 (passes through your VPN), and the relay bridges each
 * browser to your PC.
 *
 *   [browser] --wss--> [relay] <--wss (outbound)-- [agent on PC] --> localhost:8765
 *
 * Env vars (set on the host):
 *   PASSWORD   - password the browser must enter (same you use now)
 *   AGENT_KEY  - shared secret so only YOUR agent can register as the agent
 *   PORT       - provided by the host automatically
 *
 * Multiplex wire format between relay and agent (all binary):
 *   [op:1][viewerId:4 BE] then, for op MSG: [flags:1][payload]
 *   op 1 OPEN   (relay->agent)  new viewer connected
 *   op 2 CLOSE  (both)          viewer/local socket closed
 *   op 3 MSG    (both)          a message for that viewer (flags bit0: 1=text)
 *   op 4 CONFIG (agent->relay)  payload = /config.json contents to cache
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '9000', 10);
const PASSWORD = process.env.PASSWORD || '';
const AGENT_KEY = process.env.AGENT_KEY || '';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!PASSWORD || !AGENT_KEY) {
  console.error('[FATAL] set PASSWORD and AGENT_KEY environment variables');
  process.exit(1);
}

// ---- mux opcodes ----------------------------------------------------------
const OP_OPEN = 1, OP_CLOSE = 2, OP_MSG = 3, OP_CONFIG = 4;
function frameOpen(id) { const b = Buffer.allocUnsafe(5); b[0] = OP_OPEN; b.writeUInt32BE(id >>> 0, 1); return b; }
function frameClose(id) { const b = Buffer.allocUnsafe(5); b[0] = OP_CLOSE; b.writeUInt32BE(id >>> 0, 1); return b; }
function frameMsg(id, isText, payload) {
  const head = Buffer.allocUnsafe(6);
  head[0] = OP_MSG; head.writeUInt32BE(id >>> 0, 1); head[5] = isText ? 1 : 0;
  return Buffer.concat([head, payload]);
}

// ---- state ----------------------------------------------------------------
let agentWs = null;                 // the single connected agent
let cachedConfig = '{"monitors":[]}';
const viewers = new Map();          // viewerId -> browser ws
let nextViewerId = 1;

// ---- sessions / auth (same scheme as the local server) --------------------
const sessions = new Map();
function newSession() { const t = crypto.randomBytes(32).toString('hex'); sessions.set(t, Date.now() + SESSION_TTL_MS); return t; }
function validSession(t) { if (!t) return false; const e = sessions.get(t); if (!e) return false; if (Date.now() > e) { sessions.delete(t); return false; } return true; }
function parseCookies(req) {
  const out = {}; const h = req.headers.cookie; if (!h) return out;
  for (const p of h.split(';')) { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }
  return out;
}
function passwordOk(given) {
  const a = Buffer.from(String(given == null ? '' : given)); const b = Buffer.from(PASSWORD);
  if (a.length !== b.length) { crypto.timingSafeEqual(b, b); return false; }
  return crypto.timingSafeEqual(a, b);
}
const attempts = new Map();
function tooMany(ip) { const r = attempts.get(ip); if (!r) return false; if (Date.now() > r.until) { attempts.delete(ip); return false; } return r.count >= 10; }
function noteFail(ip) { const r = attempts.get(ip) || { count: 0, until: 0 }; r.count++; r.until = Date.now() + 5 * 60 * 1000; attempts.set(ip, r); }

function serveFile(res, file, type) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

// ---- HTTP -----------------------------------------------------------------
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const cookies = parseCookies(req);
  const authed = validSession(cookies.sid);
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();

  if (req.method === 'POST' && u.pathname === '/login') {
    let body = ''; req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      if (tooMany(ip)) { res.writeHead(429); res.end('too many attempts'); return; }
      const params = new URLSearchParams(body);
      if (passwordOk(params.get('password'))) {
        res.writeHead(302, { 'Set-Cookie': `sid=${newSession()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`, 'Location': '/' });
        res.end();
      } else { noteFail(ip); res.writeHead(302, { 'Location': '/?e=1' }); res.end(); }
    });
    return;
  }
  if (u.pathname === '/logout') { if (cookies.sid) sessions.delete(cookies.sid); res.writeHead(302, { 'Set-Cookie': 'sid=; Path=/; Max-Age=0', 'Location': '/' }); res.end(); return; }
  if (u.pathname === '/healthz') { res.writeHead(200); res.end('ok'); return; }
  if (u.pathname === '/config.json') {
    if (!authed) { res.writeHead(401); res.end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(cachedConfig); return;
  }
  if (u.pathname === '/' || u.pathname === '/index.html') {
    return serveFile(res, path.join(PUBLIC_DIR, authed ? 'viewer.html' : 'login.html'), 'text/html; charset=utf-8');
  }
  res.writeHead(404); res.end('not found');
});

// ---- WebSocket: /agent (the PC) and /ws (browsers) ------------------------
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/agent') {
    if (u.searchParams.get('key') !== AGENT_KEY) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => onAgent(ws));
    return;
  }
  if (u.pathname === '/ws') {
    if (!validSession(parseCookies(req).sid)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => onViewer(ws));
    return;
  }
  socket.destroy();
});

function onAgent(ws) {
  if (agentWs) { try { agentWs.close(); } catch (_) {} }
  agentWs = ws; ws.binaryType = 'nodebuffer';
  console.log('[relay] agent connected');
  ws.on('message', (data, isBinary) => {
    if (!isBinary || data.length < 1) return;
    const op = data[0];
    if (op === OP_CONFIG) { cachedConfig = data.slice(5).toString('utf8') || cachedConfig; return; }
    const id = data.readUInt32BE(1);
    const v = viewers.get(id);
    if (op === OP_MSG) { if (v && v.readyState === 1) { const isText = data[5] === 1; v.send(data.slice(6), { binary: !isText }); } }
    else if (op === OP_CLOSE) { if (v) { try { v.close(); } catch (_) {} viewers.delete(id); } }
  });
  ws.on('close', () => { if (agentWs === ws) agentWs = null; console.log('[relay] agent disconnected'); for (const v of viewers.values()) { try { v.close(); } catch (_) {} } viewers.clear(); });
  ws.on('error', () => {});
}

function sendToAgent(buf) { if (agentWs && agentWs.readyState === 1) agentWs.send(buf); }

function onViewer(ws) {
  ws.binaryType = 'nodebuffer';
  if (!agentWs) { try { ws.close(); } catch (_) {} return; }  // no PC connected
  const id = nextViewerId++; if (nextViewerId > 0xffffffff) nextViewerId = 1;
  viewers.set(id, ws);
  console.log('[relay] viewer', id, 'connected; total', viewers.size);
  sendToAgent(frameOpen(id));
  ws.on('message', (data, isBinary) => { sendToAgent(frameMsg(id, !isBinary, isBinary ? data : Buffer.from(data))); });
  ws.on('close', () => { viewers.delete(id); sendToAgent(frameClose(id)); console.log('[relay] viewer', id, 'closed'); });
  ws.on('error', () => {});
}

server.listen(PORT, () => console.log(`[relay] listening on :${PORT}`));
