#!/usr/bin/env node
'use strict';
/*
 * Presenter remote-control server.
 *
 * Run this with Node.js in the same folder as presenter.html and remote.html:
 *   node server.js
 *
 * It serves the Presenter app itself (so the Control window can talk to this
 * server without any browser cross-origin issues) plus a lightweight mobile
 * "remote.html" page, and relays messages between them over Server-Sent
 * Events. No npm install needed — only Node's built-in modules are used.
 *
 * A PIN protects it: only requests that include the correct PIN can send
 * commands or read state. The Control window (when opened from this server)
 * picks it up automatically; phones have to be told it once.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
const ROOT = __dirname;
// The desktop app sets PRESENTER_DATA_DIR (a writable per-user folder); the plain
// "node server.js" way keeps the PIN file next to server.js as before.
const DATA_DIR = process.env.PRESENTER_DATA_DIR || ROOT;
const PUBLIC_FILES = new Set(['/manifest.json', '/icon-192.png', '/icon-512.png']);

// --- The two PINs ------------------------------------------------------------------------
//  1. Connection PIN  - what a phone needs to connect and control Presenter.
//  2. Change PIN      - a separate PIN that must be typed to change the connection PIN (or itself).
// Both can only be changed from the computer running Presenter (Settings -> PINs).
// The first time Presenter runs it picks a random connection PIN (and starts with the default change PIN below); changing them in Settings is remembered
// in pin-config.json (the change PIN is stored scrambled, not as plain text).
const CONFIG_FILE = path.join(DATA_DIR, 'pin-config.json');
function randomPin() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }  // fresh 6-digit connection PIN per install
const DEFAULT_CHANGE_PIN = '4742';  // PIN required to change the PINs
const PIN_MIN = 4, PIN_MAX = 64;
function hashPin(pin, salt) { return crypto.scryptSync(String(pin), salt, 32).toString('hex'); }
function makeChangeRecord(pin) { const salt = crypto.randomBytes(16).toString('hex'); return { salt, hash: hashPin(pin, salt) }; }
let config = null;
try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { /* first run */ }
function configValid(c) { return c && typeof c.pin === 'string' && c.pin && c.change && typeof c.change.salt === 'string' && typeof c.change.hash === 'string'; }
function saveConfig() { try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config)); } catch (e) { console.error('Could not save ' + CONFIG_FILE); } }
if (!configValid(config)) { config = { pin: randomPin(), change: makeChangeRecord(DEFAULT_CHANGE_PIN) }; saveConfig(); }
// Starting the server with PIN=... still overrides the connection PIN.
if (process.env.PIN && String(process.env.PIN).trim()) { config.pin = String(process.env.PIN).trim(); saveConfig(); }
let PIN = config.pin;   // the connection PIN: any text of 4-64 characters

// Checking the change PIN: 5 wrong tries lock the change option for 5 minutes.
const changeFails = { n: 0, until: 0 };
function checkChangePin(given) {
  if (changeFails.until > Date.now()) return 'locked';
  const g = typeof given === 'string' ? given.slice(0, 128) : '';
  let ok = false;
  try { ok = crypto.timingSafeEqual(Buffer.from(hashPin(g, config.change.salt), 'hex'), Buffer.from(config.change.hash, 'hex')); } catch (e) {}
  if (ok) { changeFails.n = 0; return 'ok'; }
  changeFails.n += 1;
  if (changeFails.n >= 5) { changeFails.until = Date.now() + 5 * 60 * 1000; changeFails.n = 0; }
  return 'wrong';
}
function sameAsChangePin(x) {
  try { return crypto.timingSafeEqual(Buffer.from(hashPin(x, config.change.salt), 'hex'), Buffer.from(config.change.hash, 'hex')); } catch (e) { return false; }
}

// --- workspace layouts (panel arrangement) -----------------------------------------------------
// The Control window's panel layouts (Premiere-style workspaces) are saved HERE, in workspace-config.json,
// so they survive a cleared browser cache / reinstall and are the same in every Control window.
// Only the Presenter window on this computer may change them (like the PINs); phones can only SWITCH
// between saved workspaces (the Control window does that when it receives the request).
const WORKSPACE_FILE = path.join(DATA_DIR, 'workspace-config.json');
const WS_IDS = ['lib', 'slides', 'prev'];
const WS_MAX_BYTES = 64 * 1024;
function wsNum(n) { return typeof n === 'number' && isFinite(n) && n > 0 && n < 1e7; }
function wsCleanLayout(l) {
  if (!l || typeof l !== 'object' || !Array.isArray(l.cols) || !Array.isArray(l.hidden) || !Array.isArray(l.colW)) return null;
  if (l.cols.length < 1 || l.cols.length > WS_IDS.length || l.colW.length !== l.cols.length) return null;
  const seen = [];
  for (const c of l.cols) {
    if (!Array.isArray(c) || !c.length) return null;
    for (const id of c) { if (!WS_IDS.includes(id) || seen.includes(id)) return null; seen.push(id); }
  }
  if (seen.length !== WS_IDS.length) return null;
  if (!l.hidden.every((h) => WS_IDS.includes(h)) || new Set(l.hidden).size !== l.hidden.length || l.hidden.length >= WS_IDS.length) return null;
  if (!l.colW.every(wsNum) || !l.weights || typeof l.weights !== 'object' || !WS_IDS.every((id) => wsNum(l.weights[id]))) return null;
  const weights = {}; WS_IDS.forEach((id) => { weights[id] = l.weights[id]; });
  return { cols: l.cols.map((c) => c.slice()), hidden: l.hidden.slice(), colW: l.colW.slice(), weights };
}
function wsCleanName(n) { return typeof n === 'string' ? n.replace(/[\u0000-\u001f\u007f<>]/g, ' ').trim().slice(0, 24) : ''; }
function wsCleanConfig(body) {
  if (!body || typeof body !== 'object') return null;
  const out = { current: null, custom: {}, names: [] };
  if (body.current) {
    const name = wsCleanName(body.current.name), layout = wsCleanLayout(body.current.layout);
    if (!name || !layout) return null;
    out.current = { name, layout };
  }
  const custom = body.custom && typeof body.custom === 'object' ? body.custom : {};
  const keys = Object.keys(custom);
  if (keys.length > 40) return null;
  for (const k of keys) {
    const name = wsCleanName(k), layout = wsCleanLayout(custom[k]);
    if (name && layout) out.custom[name] = layout;
  }
  if (Array.isArray(body.names)) out.names = body.names.map(wsCleanName).filter(Boolean).slice(0, 60);
  return out;
}
let workspaceConfig = { rev: 0, current: null, custom: {}, names: [] };
try {
  const saved = JSON.parse(fs.readFileSync(WORKSPACE_FILE, 'utf8'));
  const clean = wsCleanConfig(saved);
  if (clean) workspaceConfig = { rev: Math.max(0, Number(saved.rev) || 0), current: clean.current, custom: clean.custom, names: clean.names };
} catch (e) { /* none yet */ }
function saveWorkspaceConfig() { try { fs.writeFileSync(WORKSPACE_FILE, JSON.stringify(workspaceConfig)); } catch (e) { console.error('Could not save ' + WORKSPACE_FILE); } }

// --- phone pairing -----------------------------------------------------------
// A phone finds this computer on the Wi-Fi (GET /api/hello) and asks to pair
// (POST /api/pair). The desktop app shows an "Allow this phone?" prompt; once
// allowed, that phone is remembered and gets the PIN automatically from then on.
const PAIRED_FILE = path.join(DATA_DIR, 'paired-devices.json');
let pairedIds = new Set();
try { pairedIds = new Set(JSON.parse(fs.readFileSync(PAIRED_FILE, 'utf8'))); } catch (e) { /* none yet */ }
function savePaired() { try { fs.writeFileSync(PAIRED_FILE, JSON.stringify(Array.from(pairedIds))); } catch (e) {} }
let pairHandler = null;   // async (deviceName, abortSignal) => boolean, set by the desktop app
let pairPending = false;
module.exports = { setPairHandler: (fn) => { pairHandler = fn; } };


// --- connected phones ---------------------------------------------------------
// Every phone that opens the remote is listed in the Presenter window (📱 Phone), where it can be
// removed. "Remove" disconnects the phone immediately and blocks it (by its id and by its network
// address, for 24 hours) so it cannot just reconnect with the PIN it already knows.
// Changing the password (📱 Phone -> Save password) is the way to lock out everybody who has it.
const DEVICES_FILE = path.join(DATA_DIR, 'phone-devices.json');
const BLOCK_MS = 24 * 60 * 60 * 1000;
let devices = {};      // id -> { id, name, ip, firstSeen, lastSeen, blocked }
let blockedIps = {};   // ip -> time (ms) until which that address is refused
try {
  const saved = JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8'));
  if (saved && typeof saved === 'object') { devices = saved.devices || {}; blockedIps = saved.blockedIps || {}; }
} catch (e) { /* none yet */ }
let devicesDirty = false;
function saveDevices() { devicesDirty = false; try { fs.writeFileSync(DEVICES_FILE, JSON.stringify({ devices, blockedIps })); } catch (e) {} }
setInterval(() => { if (devicesDirty) saveDevices(); }, 30000).unref();
const phoneStreams = new Map(); // id -> Set of that phone's open /events responses

function cleanId(v) { v = String(v == null ? '' : v); return /^[A-Za-z0-9._-]{6,64}$/.test(v) ? v : ''; }
function cleanName(v) { return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, ' ').trim().slice(0, 60); }
function isLocalAddr(a) { return a === '127.0.0.1' || a === '::1' || lanAddresses().includes(a); }

// Which phone is this request from? '' = the Control window on this computer (no id, loopback).
// A request from another device that doesn't say who it is (an old cached page) is tracked by address.
function phoneId(req, rawId) {
  const id = cleanId(rawId);
  if (id) return id;
  return isLoopback(req) ? '' : 'ip-' + clientIp(req);
}
function isBlocked(req, id) {
  if (id && devices[id] && devices[id].blocked) return true;
  if (isLoopback(req)) return false;
  const until = blockedIps[clientIp(req)];
  if (until && until > Date.now()) return true;
  if (until) { delete blockedIps[clientIp(req)]; devicesDirty = true; }
  return false;
}
function touchDevice(req, id, name) {
  const now = Date.now();
  let d = devices[id];
  if (!d) {
    d = devices[id] = { id, name: name || (id.startsWith('ip-') ? 'Unknown device' : 'Phone'), ip: clientIp(req), firstSeen: now, lastSeen: now, blocked: false };
    saveDevices();
  } else {
    if (name && name !== d.name) d.name = name;
    d.ip = clientIp(req); d.lastSeen = now; devicesDirty = true;
  }
  return d;
}
function removedReply(res) {
  res.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ ok: false, removed: true, error: 'removed', message: 'This phone was removed from Presenter on the computer.' }));
}
function closePhoneStreams(id, message) {
  const set = phoneStreams.get(id);
  if (!set) return;
  phoneStreams.delete(id);
  for (const res of Array.from(set)) {
    sendSSE(res, message);
    clients.delete(res);
    try { res.end(); } catch (e) {}
  }
}
// Disconnect a phone right now and keep it out.
function removePhone(id) {
  const d = devices[id];
  if (!d) return false;
  closePhoneStreams(id, { from: 'server', type: 'removed' });
  pairedIds.delete(id); savePaired();
  d.blocked = true;
  if (d.ip && !isLocalAddr(d.ip)) blockedIps[d.ip] = Date.now() + BLOCK_MS;
  saveDevices();
  return true;
}
// Let a removed phone connect again (it is forgotten and simply shows up again when it reconnects).
function allowPhone(id) {
  const d = devices[id];
  if (!d) return false;
  if (d.ip) delete blockedIps[d.ip];
  delete devices[id];
  saveDevices();
  return true;
}
function listDevices() {
  const now = Date.now();
  for (const id of Object.keys(devices)) {   // forget phones not seen for a month
    const d = devices[id];
    const live = phoneStreams.get(id);
    if (!d.blocked && !(live && live.size) && now - d.lastSeen > 30 * 24 * 60 * 60 * 1000) { delete devices[id]; devicesDirty = true; }
  }
  return Object.values(devices).map((d) => {
    const live = phoneStreams.get(d.id);
    return { id: d.id, name: d.name, ip: d.ip, firstSeen: d.firstSeen, lastSeen: d.lastSeen, connected: !!(live && live.size), blocked: !!d.blocked };
  }).sort((a, b) => (a.blocked - b.blocked) || (b.connected - a.connected) || (b.lastSeen - a.lastSeen));
}
// The device-management calls only work from the Presenter window on this computer, and not from
// other web pages (which would carry a foreign Origin header).
function adminOk(req) {
  if (!isLoopback(req)) return false;
  const o = req.headers.origin;
  if (!o) return true;
  try {
    const h = new URL(o).hostname.replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || lanAddresses().includes(h);
  } catch (e) { return false; }
}

// --- password check with brute-force protection ----------------------------------
// Anything reachable from outside the local network (e.g. over Tailscale) must not allow
// unlimited guessing: after 5 wrong tries a client address is locked out for 10 minutes.
const failures = new Map(); // ip -> { n, until }
function clientIp(req) {
  let a = (req.socket && req.socket.remoteAddress) || '';
  if (a.startsWith('::ffff:')) a = a.slice(7);
  return a;
}
function lockedOut(req) {
  const f = failures.get(clientIp(req));
  return !!(f && f.until && f.until > Date.now());
}
function pinOk(req, given) {
  if (lockedOut(req)) return false;
  const a = Buffer.from(String(given == null ? '' : given));
  const b = Buffer.from(PIN);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  const ip = clientIp(req);
  if (ok) { failures.delete(ip); return true; }
  if (isLoopback(req)) return false;
  const f = failures.get(ip) || { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= 5) { f.until = Date.now() + 10 * 60 * 1000; f.n = 0; }
  failures.set(ip, f);
  return false;
}
function tooMany(res) {
  res.writeHead(429, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ ok: false, error: 'locked', message: 'Too many wrong PINs. Try again in 10 minutes.' }));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// --- network helpers ----------------------------------------------------------
function lanAddresses() {
  const nets = os.networkInterfaces();
  const addrs = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) addrs.push(net.address);
    }
  }
  return addrs;
}
// True only for requests coming from this same computer (loopback, or this
// machine's own network address). A phone on the Wi-Fi never matches.
function isLoopback(req) {
  let a = (req.socket && req.socket.remoteAddress) || '';
  if (a.startsWith('::ffff:')) a = a.slice(7);
  return a === '127.0.0.1' || a === '::1' || lanAddresses().includes(a);
}

// --- SSE client bookkeeping -------------------------------------------------
const clients = new Set();
let lastState = null; // most recent {from:'control', type:'state', ...} message, replayed to new joiners

function sendSSE(res, obj) {
  try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (e) { /* client gone */ }
}

function broadcast(obj) {
  for (const res of clients) sendSSE(res, obj);
}

function badPin(res, req) {
  if (req && lockedOut(req)) { tooMany(res); return; }
  res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ ok: false, error: 'bad-pin' }));
}

// --- static file helper -----------------------------------------------------
function serveFile(res, filePath, inject) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('Not found: ' + path.basename(filePath));
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    let body = data;
    if (inject && ext === '.html') {
      const html = data.toString('utf8');
      const info = { port: PORT, addresses: lanAddresses() };
      const snippet = '<script>window.__SERVER_PIN__=' + JSON.stringify(PIN) + ';window.__SERVER_INFO__=' + JSON.stringify(info) + ';</script>';
      body = html.includes('<head>') ? html.replace('<head>', '<head>' + snippet) : snippet + html;
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(body);
  });
}

function readJsonBody(req, cb) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    try {
      const raw = Buffer.concat(chunks).toString('utf8');
      cb(null, raw ? JSON.parse(raw) : {});
    } catch (e) {
      cb(e);
    }
  });
  req.on('error', cb);
}

// --- server ------------------------------------------------------------------
const server = http.createServer((req, res) => {
  let u;
  try { u = new URL(req.url, 'http://localhost'); } catch (e) { res.writeHead(400); res.end(); return; }
  let pathname;
  try { pathname = decodeURIComponent(u.pathname); } catch (e) { res.writeHead(400); res.end(); return; }
  // Treat "/remote/" the same as "/remote", etc. — a trailing slash shouldn't matter.
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  if (pathname === '/api/hello') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ app: 'presenter', name: os.hostname(), port: PORT, pair: !!pairHandler }));
    return;
  }

  // Pairing: ONLY the configured connection PIN authorizes a phone. No device-id shortcut, no "Allow" box.
  if (pathname === '/api/pair' && req.method === 'POST') {
    const reply = (obj) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(obj));
    };
    readJsonBody(req, (err, msg) => {
      msg = (err || !msg || typeof msg !== 'object') ? {} : msg;
      const id = cleanId(msg.id);
      if (isBlocked(req, id)) { reply({ ok: false, denied: true }); return; }
      if (lockedOut(req)) { reply({ ok: false, locked: true }); return; }
      if (typeof msg.pin !== 'string' || !msg.pin) { reply({ ok: false, needPin: true }); return; }
      if (pinOk(req, msg.pin)) { reply({ ok: true, pin: PIN }); return; }
      reply({ ok: false, wrongPin: true });
    });
    return;
  }

  // Change the connection PIN. Only the computer running Presenter may do this, and it needs the change PIN.
  if (pathname === '/api/set-password' && req.method === 'POST') {
    const out = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
    if (!adminOk(req)) { out(403, { ok: false, error: 'local-only', message: 'The PIN can only be changed on the computer running Presenter.' }); return; }
    readJsonBody(req, (err, msg) => {
      msg = (err || !msg || typeof msg !== 'object') ? {} : msg;
      const pw = typeof msg.password === 'string' ? msg.password.trim() : '';
      const c = checkChangePin(msg.changePin);
      if (c === 'locked') { out(429, { ok: false, error: 'locked', message: 'Too many wrong tries. Try again in 5 minutes.' }); return; }
      if (c !== 'ok') { out(401, { ok: false, error: 'bad-change-pin', message: 'Wrong change PIN.' }); return; }
      if (pw.length < PIN_MIN || pw.length > PIN_MAX) { out(400, { ok: false, error: 'length', message: 'Use ' + PIN_MIN + ' to ' + PIN_MAX + ' characters.' }); return; }
      if (sameAsChangePin(pw)) { out(400, { ok: false, error: 'same', message: 'The connection PIN must be different from the change PIN.' }); return; }
      PIN = pw; config.pin = pw; saveConfig();
      pairedIds = new Set(); savePaired(); // phones must use the new PIN
      for (const id of Array.from(phoneStreams.keys())) closePhoneStreams(id, { from: 'server', type: 'signout' });
      // The PIN is the gate now, so earlier removals no longer need to be remembered.
      for (const id of Object.keys(devices)) { if (devices[id].blocked) delete devices[id]; }
      blockedIps = {}; saveDevices();
      out(200, { ok: true });
    });
    return;
  }

  // Change the change PIN itself (needs the current change PIN, this computer only).
  if (pathname === '/api/set-change-pin' && req.method === 'POST') {
    const out = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
    if (!adminOk(req)) { out(403, { ok: false, error: 'local-only', message: 'The PIN can only be changed on the computer running Presenter.' }); return; }
    readJsonBody(req, (err, msg) => {
      msg = (err || !msg || typeof msg !== 'object') ? {} : msg;
      const np = typeof msg.newChangePin === 'string' ? msg.newChangePin.trim() : '';
      const c = checkChangePin(msg.changePin);
      if (c === 'locked') { out(429, { ok: false, error: 'locked', message: 'Too many wrong tries. Try again in 5 minutes.' }); return; }
      if (c !== 'ok') { out(401, { ok: false, error: 'bad-change-pin', message: 'Wrong current change PIN.' }); return; }
      if (np.length < PIN_MIN || np.length > PIN_MAX) { out(400, { ok: false, error: 'length', message: 'Use ' + PIN_MIN + ' to ' + PIN_MAX + ' characters.' }); return; }
      if (np === PIN) { out(400, { ok: false, error: 'same', message: 'The change PIN must be different from the connection PIN.' }); return; }
      config.change = makeChangeRecord(np); saveConfig();
      out(200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/verify-pin') {
    if (lockedOut(req)) { tooMany(res); return; }
    const ok = pinOk(req, u.searchParams.get('pin'));
    if (ok && isBlocked(req, phoneId(req, u.searchParams.get('id')))) { removedReply(res); return; }
    res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: ok }));
    return;
  }

  if (pathname === '/events') {
    if (!pinOk(req, u.searchParams.get('pin'))) { badPin(res, req); return; }
    const pid = phoneId(req, u.searchParams.get('id'));
    if (pid) {
      if (isBlocked(req, pid)) { removedReply(res); return; }
      touchDevice(req, pid, cleanName(u.searchParams.get('name')));
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write('retry: 2000\n\n');
    clients.add(res);
    if (pid) {
      if (!phoneStreams.has(pid)) phoneStreams.set(pid, new Set());
      phoneStreams.get(pid).add(res);
    }
    if (lastState) sendSSE(res, lastState);
    const heartbeat = setInterval(() => { try { res.write(':hb\n\n'); } catch (e) {} }, 20000);
    req.on('close', () => {
      clearInterval(heartbeat); clients.delete(res);
      if (pid) {
        const set = phoneStreams.get(pid);
        if (set) { set.delete(res); if (!set.size) phoneStreams.delete(pid); }
        if (devices[pid]) { devices[pid].lastSeen = Date.now(); devicesDirty = true; }
      }
    });
    return;
  }

  // Phones list and removal (Presenter window on this computer only).
  if (pathname === '/api/devices' && req.method === 'GET') {
    if (!adminOk(req)) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'local-only' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, devices: listDevices() }));
    return;
  }
  if ((pathname === '/api/devices/remove' || pathname === '/api/devices/allow') && req.method === 'POST') {
    const out = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
    if (!adminOk(req)) { out(403, { ok: false, error: 'local-only' }); return; }
    readJsonBody(req, (err, msg) => {
      const id = (!err && msg && typeof msg.id === 'string') ? msg.id : '';
      const done = pathname.endsWith('/remove') ? removePhone(id) : allowPhone(id);
      out(done ? 200 : 404, { ok: done, devices: listDevices() });
    });
    return;
  }

  // Workspace layouts: read/write only from the Presenter window on this computer.
  if (pathname === '/api/workspace') {
    const out = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
    if (!adminOk(req)) { out(403, { ok: false, error: 'local-only', message: 'Workspaces can only be edited on the computer running Presenter.' }); return; }
    if (req.method === 'GET') { out(200, Object.assign({ ok: true }, workspaceConfig)); return; }
    if (req.method === 'POST') {
      if (Number(req.headers['content-length'] || 0) > WS_MAX_BYTES) { out(413, { ok: false, error: 'too-big' }); return; }
      readJsonBody(req, (err, msg) => {
        const clean = err ? null : wsCleanConfig(msg);
        if (!clean) { out(400, { ok: false, error: 'bad-workspace', message: 'Invalid workspace data.' }); return; }
        workspaceConfig = { rev: workspaceConfig.rev + 1, current: clean.current, custom: clean.custom, names: clean.names };
        saveWorkspaceConfig();
        // Tell every other Control window; phones get the names with the next state push.
        broadcast({ from: 'server', type: 'workspace', rev: workspaceConfig.rev });
        out(200, { ok: true, rev: workspaceConfig.rev });
      });
      return;
    }
    out(405, { ok: false }); return;
  }

  if (pathname === '/api/send' && req.method === 'POST') {
    readJsonBody(req, (err, msg) => {
      if (err || !msg || typeof msg !== 'object') {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: false, error: 'bad json' }));
        return;
      }
      if (!pinOk(req, msg.pin)) { badPin(res, req); return; }
      const sid = phoneId(req, msg.id);
      if (sid) {
        if (isBlocked(req, sid)) { removedReply(res); return; }
        touchDevice(req, sid, cleanName(msg.name));
      }
      // Only the Control window on this computer may speak as 'control' (slides/state). A phone cannot impersonate it.
      if (msg.from === 'control' && !isLoopback(req)) { res.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ ok: false, error: 'forbidden' })); return; }
      delete msg.id; delete msg.name;
      if (msg.type === 'state' && msg.from === 'control') lastState = msg;
      broadcast(msg);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // Static files. Only presenter.html, and only when it's requested from this
  // same computer, gets the PIN and phone links injected. A phone (or anyone
  // else on the network) that opens the main address does NOT get the PIN.
  let filePath, injectPin = false;
  if (pathname === '/' || pathname === '/presenter.html' || pathname === '/control' || pathname === '/live') {
    filePath = path.join(ROOT, 'presenter.html');
    injectPin = isLoopback(req);
  } else if (pathname === '/remote' || pathname === '/remote.html') {
    filePath = path.join(ROOT, 'remote.html');
  } else if (PUBLIC_FILES.has(pathname)) {
    filePath = path.join(ROOT, pathname);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end('Not found');
    return;
  }
  serveFile(res, filePath, injectPin);
});

const HOST = process.env.HOST && String(process.env.HOST).trim() ? String(process.env.HOST).trim() : '0.0.0.0';

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE' && process.env.PRESENTER_EMBEDDED) {
    console.log('Port ' + PORT + ' is already in use - assuming a Presenter server is already running.');
    return;
  }
  console.error('Server error: ' + (err && err.message));
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const addrs = lanAddresses();
  console.log('');
  console.log('Presenter remote server is running, listening on ' + HOST + ':' + PORT + ' (every network interface on this computer).');
  console.log('');
  console.log('  Connection PIN (needed once per phone): ' + PIN);
  console.log('');
  console.log('  On this computer, open the Control window at (a plain double-click on presenter.html will NOT work with the phone):');
  console.log('    http://localhost:' + PORT + '/');
  console.log('');
  console.log('  On your phone (same Wi-Fi, or Tailscale from any network), open:');
  if (addrs.length === 0) {
    console.log('    Could not detect a network address automatically.');
    console.log('    Run "ipconfig" (Windows) or "ifconfig" / "ip addr" (Mac/Linux) to find');
    console.log('    this computer\'s local IP, then open http://<that-ip>:' + PORT + '/remote on your phone.');
  } else {
    addrs.forEach((a) => console.log('    http://' + a + ':' + PORT + '/remote'));
    console.log('');
    console.log('  Easier: in the Presenter window click "Phone" — it shows a QR code to scan.');
  }
  console.log('');
  console.log('  The PINs are kept in pin-config.json. Change them in Presenter: Settings -> PINs');
  console.log('  (that needs the separate change PIN). Starting with PIN=yourpin overrides the connection PIN.');
  console.log('');
  console.log('  Reachable from any device on your network by default (protected by the PIN');
  console.log('  above). To restrict it to just this computer instead, start it with');
  console.log('  HOST=127.0.0.1 node server.js.');
  console.log('');
  console.log('Keep this window open for as long as you want the phone to stay connected.');
  console.log('Press Ctrl+C to stop.');
  console.log('');
});
