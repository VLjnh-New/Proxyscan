const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const net   = require('net');
const { WebSocketServer } = require('ws');

const PORT        = process.env.PORT || 5000;
const PUBLIC      = path.join(__dirname, 'public');
const STORE_FILE  = path.join(__dirname, 'proxies.json');

// ── MIME ──────────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
  '.json': 'application/json',
};

// ── Proxy Store ───────────────────────────────────────────────────────────────
// { "ip:port": { ip, port, protocol, latency, first_seen, last_seen, checks } }
let store = {};

function loadStore() {
  try {
    if (fs.existsSync(STORE_FILE))
      store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch { store = {}; }
}

function saveStore() {
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
}

function upsertProxy(ip, port, protocol, latency) {
  const key = `${ip}:${port}`;
  const now = new Date().toISOString();
  if (store[key]) {
    store[key].latency    = latency;
    store[key].protocol   = protocol;
    store[key].last_seen  = now;
    store[key].checks++;
  } else {
    store[key] = { ip, port, protocol, latency, first_seen: now, last_seen: now, checks: 1 };
  }
  saveStore();
}

function removeProxy(key) {
  delete store[key];
  saveStore();
}

function getProxies(proto) {
  const list = Object.values(store);
  return proto ? list.filter(p => p.protocol.toUpperCase() === proto.toUpperCase()) : list;
}

loadStore();

// ── GitHub Push ───────────────────────────────────────────────────────────────
async function pushToGitHub() {
  const token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  const repo  = process.env.GITHUB_REPO;
  if (!token || !repo) {
    console.log('[GitHub] Skipped — GITHUB_PERSONAL_ACCESS_TOKEN or GITHUB_REPO not set');
    return;
  }

  const content  = Buffer.from(JSON.stringify(store, null, 2)).toString('base64');
  const filePath = 'proxies.json';
  const apiPath  = `/repos/${repo}/contents/${filePath}`;

  const get = () => new Promise(resolve => {
    const opts = {
      hostname: 'api.github.com', path: apiPath, method: 'GET',
      headers: { 'Authorization': `token ${token}`, 'User-Agent': 'ProxyScan', 'Accept': 'application/vnd.github.v3+json' },
    };
    const req = https.request(opts, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => { try { resolve(JSON.parse(body).sha || null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.end();
  });

  const sha  = await get();
  const body = JSON.stringify({
    message: `chore: update proxies ${new Date().toISOString()}`,
    content,
    ...(sha ? { sha } : {}),
  });

  return new Promise(resolve => {
    const opts = {
      hostname: 'api.github.com', path: apiPath, method: 'PUT',
      headers: {
        'Authorization': `token ${token}`, 'User-Agent': 'ProxyScan',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201)
          console.log(`[GitHub] Pushed ${filePath} → ${repo} (${Object.keys(store).length} proxies)`);
        else
          console.log(`[GitHub] Push failed — HTTP ${res.statusCode}: ${data.slice(0, 200)}`);
        resolve();
      });
    });
    req.on('error', e => { console.log(`[GitHub] Error: ${e.message}`); resolve(); });
    req.write(body);
    req.end();
  });
}

// ── JSON response helper ───────────────────────────────────────────────────────
function json(res, data, status = 200) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
  });
  res.end(body);
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  const url    = new URL(req.url, `http://localhost`);
  const p      = url.pathname;
  const method = req.method.toUpperCase();

  // ── CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS' });
    res.end(); return;
  }

  // ── REST API ──────────────────────────────────────────────────────────────

  // GET /api/proxies          — all proxies JSON
  // GET /api/proxies/http     — HTTP only
  // GET /api/proxies/socks5   — SOCKS5 only
  // GET /api/proxies/raw      — plain text IP:PORT
  // DELETE /api/proxies       — clear store
  // DELETE /api/proxies/:key  — remove single
  if (p.startsWith('/api/proxies')) {
    const seg = p.replace('/api/proxies', '').replace(/^\//, '').toLowerCase();

    if (method === 'DELETE') {
      if (!seg) { store = {}; saveStore(); json(res, { ok: true, message: 'Store cleared' }); }
      else       { removeProxy(decodeURIComponent(seg)); json(res, { ok: true }); }
      return;
    }

    if (method !== 'GET') { json(res, { error: 'Method not allowed' }, 405); return; }

    if (seg === 'raw' || seg === 'txt') {
      const proto = url.searchParams.get('protocol')?.toUpperCase() || null;
      const list  = getProxies(proto).map(p => `${p.ip}:${p.port}`).join('\n');
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end(list); return;
    }

    const proto = seg === 'http' ? 'HTTP' : seg === 'socks5' ? 'SOCKS5' : (url.searchParams.get('protocol')?.toUpperCase() || null);
    const list  = getProxies(proto);
    list.sort((a, b) => a.latency - b.latency);

    json(res, {
      updated_at: new Date().toISOString(),
      count: list.length,
      proxies: list,
    }); return;
  }

  // GET /api/schedule
  if (p === '/api/schedule' && method === 'GET') {
    json(res, {
      next_scan: nextScanTime,
      last_scan: lastScanTime,
      last_push: lastPushTime,
      scanning:  scheduleFlag.scanning || false,
      repo:      process.env.GITHUB_REPO || null,
    }); return;
  }

  // POST /api/schedule/push — manual push to GitHub
  if (p === '/api/schedule/push' && method === 'POST') {
    pushToGitHub().then(() => { lastPushTime = new Date().toISOString(); });
    json(res, { ok: true, message: 'Push triggered' }); return;
  }

  // GET /api/stats
  if (p === '/api/stats' && method === 'GET') {
    const all   = Object.values(store);
    const http  = all.filter(p => p.protocol === 'HTTP').length;
    const socks = all.filter(p => p.protocol === 'SOCKS5').length;
    const avgl  = all.length ? Math.round(all.reduce((s, p) => s + p.latency, 0) / all.length) : 0;
    json(res, { total: all.length, http, socks5: socks, avg_latency_ms: avgl }); return;
  }

  // ── Static files ──────────────────────────────────────────────────────────
  let filePath = p === '/' ? '/index.html' : p;
  const file   = path.join(PUBLIC, filePath);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
    });
    res.end(data);
  });
});

// ── IP helpers ────────────────────────────────────────────────────────────────
const ipToInt = ip => ip.split('.').reduce((a, o) => ((a << 8) + +o) >>> 0, 0);
const intToIp = n  => [24,16,8,0].map(s => (n >>> s) & 0xff).join('.');

// ── Semaphore ─────────────────────────────────────────────────────────────────
class Semaphore {
  constructor(n) { this.slots = Array(Math.max(1, n)).fill(Promise.resolve()); this.i = 0; }
  run(fn) {
    const i = this.i++ % this.slots.length;
    const p = this.slots[i].then(fn).catch(() => {});
    this.slots[i] = p;
    return p;
  }
}

// ── Network probes ────────────────────────────────────────────────────────────
function tcpConnect(host, port, ms) {
  return new Promise(resolve => {
    const s = net.createConnection({ host, port, timeout: ms });
    const done = v => { try { s.destroy(); } catch {} resolve(v); };
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error',   () => done(false));
  });
}

function probeSocks5(host, port, ms) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const s  = net.createConnection({ host, port, timeout: ms });
    s.once('connect', () => {
      s.write(Buffer.from([0x05, 0x01, 0x00]));
      s.setTimeout(ms);
      s.once('data', d => { s.destroy(); resolve(d[0] === 0x05 ? { protocol: 'SOCKS5', latency: Date.now() - t0 } : null); });
      s.once('timeout', () => { s.destroy(); resolve(null); });
      s.once('error',   () => resolve(null));
    });
    s.once('timeout', () => { s.destroy(); resolve(null); });
    s.once('error',   () => resolve(null));
  });
}

function probeHttp(host, port, ms) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const s  = net.createConnection({ host, port, timeout: ms });
    s.once('connect', () => {
      s.write('CONNECT 1.1.1.1:80 HTTP/1.1\r\nHost: 1.1.1.1:80\r\n\r\n');
      s.setTimeout(ms);
      s.once('data', d => {
        s.destroy();
        const r = d.slice(0, 16).toString();
        resolve(r.startsWith('HTTP/1.1 200') || r.startsWith('HTTP/1.0 200')
          ? { protocol: 'HTTP', latency: Date.now() - t0 } : null);
      });
      s.once('timeout', () => { s.destroy(); resolve(null); });
      s.once('error',   () => resolve(null));
    });
    s.once('timeout', () => { s.destroy(); resolve(null); });
    s.once('error',   () => resolve(null));
  });
}

async function detectProxy(host, port, ms) {
  const r = await probeSocks5(host, port, ms);
  return r || probeHttp(host, port, ms);
}

async function verifyProxy(host, port, protocol, ms) {
  const fn = protocol.toUpperCase() === 'SOCKS5'
    ? () => probeSocks5(host, port, ms)
    : () => probeHttp(host, port, ms);
  const r = await fn();
  if (r) return { ok: true, latency: r.latency, protocol };
  throw new Error(`Not a ${protocol} proxy or timed out`);
}

// ── Emit helper ───────────────────────────────────────────────────────────────
const send = (ws, type, data) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, ...data }));
};

// ── Scan ──────────────────────────────────────────────────────────────────────
async function runScan(ws, args, flag) {
  const { network, mask, startPort, endPort, concurrent, synTimeout, verifyTimeout, verifyConcurrent } = args;

  const netId = (ipToInt(network) & ipToInt(mask)) >>> 0;
  const bcast = (netId | (~ipToInt(mask) >>> 0)) >>> 0;
  const total = (bcast - netId - 1) * (endPort - startPort + 1);

  let scanned = 0, found = 0, portsOpen = 0;
  const verTasks = [], synTasks = [];
  const verSem = new Semaphore(verifyConcurrent);
  const synSem = new Semaphore(concurrent);

  const queueVerify = (ip, port) => {
    verTasks.push(verSem.run(async () => {
      if (flag.stop) return;
      const r = await detectProxy(ip, port, verifyTimeout);
      if (r && !flag.stop) {
        found++;
        upsertProxy(ip, port, r.protocol, r.latency);
        send(ws, 'scan_result', { ip, port, protocol: r.protocol, latency: r.latency });
      }
    }));
  };

  for (let ipInt = netId + 1; ipInt < bcast; ipInt++) {
    if (flag.stop) break;
    const ip = intToIp(ipInt);
    for (let port = startPort; port <= endPort; port++) {
      if (flag.stop) break;
      synTasks.push(synSem.run(async () => {
        if (flag.stop) return;
        const open = await tcpConnect(ip, port, synTimeout);
        if (open && !flag.stop) { portsOpen++; queueVerify(ip, port); send(ws, 'scan_port_open', { portsOpen }); }
        scanned++;
        if (scanned % 100 === 0 || scanned === total)
          send(ws, 'scan_progress', { scanned, total, found, portsOpen });
      }));
    }
  }

  await Promise.all(synTasks);
  await Promise.all(verTasks);
  send(ws, 'scan_progress', { scanned, total, found, portsOpen });
  send(ws, 'scan_done', { scanned, total, found, portsOpen });
}

// ── Test ──────────────────────────────────────────────────────────────────────
async function runTest(ws, args, flag) {
  const { host, port, protocol, count, timeout, interval } = args;
  flag.stop = false;
  for (let i = 1; i <= count; i++) {
    if (flag.stop) { send(ws, 'test_stopped', {}); return; }
    try {
      const r = await verifyProxy(host, port, protocol, timeout);
      send(ws, 'test_result', { seq: i, ok: true, latency: r.latency, protocol: r.protocol });
    } catch (e) {
      send(ws, 'test_result', { seq: i, ok: false, error: e.message });
    }
    if (i < count && !flag.stop) await new Promise(r => setTimeout(r, interval));
  }
  send(ws, 'test_done', {});
}

// ── Auto Scan (multiple ranges sequential) ────────────────────────────────────
async function runAutoScan(ws, args, flag) {
  const { targets, startPort, endPort, concurrent, synTimeout, verifyTimeout, verifyConcurrent } = args;
  const t0 = Date.now();
  let totalFound = 0, totalScanned = 0;

  for (let i = 0; i < targets.length; i++) {
    if (flag.stop) break;
    const { network, mask, label } = targets[i];
    send(ws, 'auto_range_start', { index: i, total: targets.length, network, mask, label });

    const foundBefore = totalFound;
    const origUpsert  = upsertProxy;

    await runScan(ws, { network, mask, startPort, endPort, concurrent, synTimeout, verifyTimeout, verifyConcurrent }, flag);

    const cur = Object.keys(store).length;
    send(ws, 'auto_range_done', { index: i, total: targets.length, network, label });
  }

  send(ws, 'auto_done', { elapsed: Date.now() - t0 });
}

// ── Recheck stored proxies ────────────────────────────────────────────────────
async function runRecheck(ws, args, flag) {
  const { timeout = 5000, concurrent = 50 } = args;
  const entries = Object.entries(store);
  const sem = new Semaphore(concurrent);
  let checked = 0, alive = 0, removed = 0;

  send(ws, 'recheck_start', { total: entries.length });

  const tasks = entries.map(([key, p]) => sem.run(async () => {
    if (flag.stop) return;
    const r = await detectProxy(p.ip, p.port, timeout);
    checked++;
    if (r) {
      alive++;
      upsertProxy(p.ip, p.port, r.protocol, r.latency);
      send(ws, 'recheck_result', { ip: p.ip, port: p.port, alive: true, latency: r.latency, protocol: r.protocol });
    } else {
      removed++;
      removeProxy(key);
      send(ws, 'recheck_result', { ip: p.ip, port: p.port, alive: false });
    }
    send(ws, 'recheck_progress', { checked, total: entries.length, alive, removed });
  }));

  await Promise.all(tasks);
  send(ws, 'recheck_done', { checked, alive, removed });
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', ws => {
  const flag = { stop: false };
  console.log('[WS] connected');

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const { id, cmd, args } = msg;
    const ok  = r => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ id, ok: true,  result: r }));
    const err = e => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ id, ok: false, error: String(e) }));

    if (cmd === 'stop')        { flag.stop = true;  ok(null); return; }
    if (cmd === 'scan')        { flag.stop = false; ok(null); runScan(ws, args, flag).catch(console.error); return; }
    if (cmd === 'test')        { flag.stop = false; ok(null); runTest(ws, args, flag).catch(console.error); return; }
    if (cmd === 'auto_scan')   { flag.stop = false; ok(null); runAutoScan(ws, args, flag).catch(console.error); return; }
    if (cmd === 'recheck')     { flag.stop = false; ok(null); runRecheck(ws, args, flag).catch(console.error); return; }
    if (cmd === 'get_store')   { ok({ count: Object.keys(store).length, proxies: Object.values(store) }); return; }
    if (cmd === 'clear_store') { store = {}; saveStore(); ok(null); return; }
    if (cmd === 'remove_proxy'){ removeProxy(args.key); ok(null); return; }
    err('Unknown command: ' + cmd);
  });

  ws.on('close', () => { flag.stop = true; console.log('[WS] disconnected'); });
});

// ── Scheduled Auto-Scan ───────────────────────────────────────────────────────
const SCHEDULE_RANGES = [
  { label: 'Vietnam (Viettel)',    network: '171.224.0.0', mask: '255.255.255.0' },
  { label: 'Vietnam (Viettel 2)',  network: '171.225.0.0', mask: '255.255.255.0' },
  { label: 'Vietnam (VNPT)',       network: '113.160.0.0', mask: '255.255.255.0' },
  { label: 'Vietnam (VNPT 2)',     network: '113.161.0.0', mask: '255.255.255.0' },
  { label: 'Vietnam (FPT)',        network: '27.72.0.0',   mask: '255.255.255.0' },
  { label: 'Vietnam (FPT 2)',      network: '14.162.0.0',  mask: '255.255.255.0' },
  { label: 'Indonesia (hosting)',  network: '103.28.0.0',  mask: '255.255.255.0' },
  { label: 'Indonesia (cloud)',    network: '103.89.0.0',  mask: '255.255.255.0' },
  { label: 'India (datacenter)',   network: '103.4.0.0',   mask: '255.255.255.0' },
  { label: 'India (datacenter 2)', network: '103.5.0.0',   mask: '255.255.255.0' },
  { label: 'Bangladesh',           network: '103.67.0.0',  mask: '255.255.255.0' },
  { label: 'Bangladesh 2',         network: '103.75.0.0',  mask: '255.255.255.0' },
  { label: 'China (telecom)',      network: '36.99.0.0',   mask: '255.255.255.0' },
  { label: 'China (unicom)',       network: '36.33.0.0',   mask: '255.255.255.0' },
  { label: 'Asia mixed',           network: '103.0.0.0',   mask: '255.255.255.0' },
  { label: 'Asia mixed 2',         network: '103.1.0.0',   mask: '255.255.255.0' },
  { label: 'Cloud VPS',            network: '45.76.0.0',   mask: '255.255.255.0' },
  { label: 'Cloud VPS 2',          network: '45.32.0.0',   mask: '255.255.255.0' },
];

let scheduleFlag = { stop: false, scanning: false };
let nextScanTime = null;
let lastScanTime = null;
let lastPushTime = null;
let scheduleTimer = null;

function broadcast(type, data) {
  const msg = JSON.stringify({ type, ...data });
  wss.clients.forEach(c => { if (c.readyState === c.OPEN) c.send(msg); });
}

async function runScheduledScan() {
  if (scheduleFlag.scanning) return;
  scheduleFlag = { stop: false, scanning: true };
  lastScanTime = new Date().toISOString();
  console.log(`[Schedule] Auto-scan started at ${lastScanTime}`);

  broadcast('schedule_start', { time: lastScanTime, ranges: SCHEDULE_RANGES.length });

  const fakeWs = {
    readyState: 1, OPEN: 1,
    send(raw) {
      try {
        const msg = JSON.parse(raw);
        wss.clients.forEach(c => { if (c.readyState === c.OPEN) c.send(raw); });
      } catch {}
    },
  };

  try {
    await runAutoScan(fakeWs, {
      targets:          SCHEDULE_RANGES,
      startPort:        7000,
      endPort:          9999,
      concurrent:       500,
      synTimeout:       400,
      verifyTimeout:    1500,
      verifyConcurrent: 60,
    }, scheduleFlag);
    console.log(`[Schedule] Scan done — ${Object.keys(store).length} proxies total`);
    await pushToGitHub();
    lastPushTime = new Date().toISOString();
    broadcast('schedule_push_done', { time: lastPushTime, count: Object.keys(store).length });
  } catch (e) {
    console.error('[Schedule] Error:', e.message);
  }

  scheduleFlag.scanning = false;
  scheduleNext();
}

function scheduleNext() {
  if (scheduleTimer) clearTimeout(scheduleTimer);
  const interval = 24 * 60 * 60 * 1000;
  nextScanTime = new Date(Date.now() + interval).toISOString();
  console.log(`[Schedule] Next scan at ${nextScanTime}`);
  scheduleTimer = setTimeout(runScheduledScan, interval);
}

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Proxy Scanner  →  http://0.0.0.0:${PORT}\nAPI endpoints  →  /api/proxies  /api/proxies/http  /api/proxies/socks5  /api/proxies/raw`);

  // First scan after 1 minute, then every 24h
  setTimeout(() => {
    console.log('[Schedule] Running first scheduled scan…');
    runScheduledScan();
  }, 60 * 1000);

  scheduleNext();
});
