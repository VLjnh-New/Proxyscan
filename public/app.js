// ── WebSocket ─────────────────────────────────────────────────────────────────
let ws = null;
let callId = 0;
const pending = new Map();
const handlers = new Map();

function wsConnect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  setWsStatus('connecting');

  ws.onopen = () => setWsStatus('connected');

  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if ('id' in msg) {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error)); }
    } else if (msg.type) {
      const h = handlers.get(msg.type);
      if (h) h(msg);
    }
  };

  ws.onclose = () => { setWsStatus('error'); setTimeout(wsConnect, 3000); };
  ws.onerror = () => {};
}

function call(cmd, args) {
  return new Promise((resolve, reject) => {
    const id = ++callId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, cmd, args }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('Timeout')); } }, 60000);
  });
}

function on(type, fn) { handlers.set(type, fn); }

function setWsStatus(s) {
  const el = document.getElementById('ws-indicator');
  const lb = document.getElementById('ws-label');
  el.className = `ws-indicator ${s}`;
  lb.textContent = s === 'connected' ? 'Connected' : s === 'connecting' ? 'Connecting…' : 'Disconnected';
}

// ── Tab navigation ─────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === `tab-${tab}`));
  });
});

// ── Log helper ────────────────────────────────────────────────────────────────
function appendLog(el, text, cls = '') {
  const d = document.createElement('div');
  d.className = `log-line ${cls}`;
  d.textContent = text;
  el.appendChild(d);
  el.scrollTop = el.scrollHeight;
  while (el.children.length > 500) el.removeChild(el.firstChild);
}

function fmtMs(ms) {
  if (ms === null || ms === undefined) return '--';
  return ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`;
}

function latCls(ms) {
  if (ms <= 100) return 'latency-fast';
  if (ms <= 500) return 'latency-medium';
  return 'latency-slow';
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST TAB
// ═══════════════════════════════════════════════════════════════════════════════
const testLog    = document.getElementById('test-log');
const testStatus = document.getElementById('test-status');
const btnStart   = document.getElementById('btn-test-start');
const btnStop    = document.getElementById('btn-test-stop');
const btnClear   = document.getElementById('btn-test-clear');

let testStats = { ok: 0, fail: 0, min: null, max: null, sum: 0 };

function updateTestStats() {
  const avg = testStats.ok > 0 ? testStats.sum / testStats.ok : null;
  document.getElementById('s-min').textContent  = fmtMs(testStats.min);
  document.getElementById('s-max').textContent  = fmtMs(testStats.max);
  document.getElementById('s-avg').textContent  = fmtMs(avg);
  document.getElementById('s-loss').textContent = `${testStats.fail}/${testStats.ok + testStats.fail}`;
}

function setTestRunning(running) {
  btnStart.disabled = running;
  btnStop.disabled  = !running;
  ['test-host','test-port','test-proto','test-count','test-timeout','test-interval']
    .forEach(id => { const el = document.getElementById(id); if (el) el.disabled = running; });
  testStatus.className = `badge badge-${running ? 'running' : 'idle'}`;
  testStatus.textContent = running ? 'Running' : 'Idle';
}

on('test_result', msg => {
  const seq = String(msg.seq).padStart(4, ' ');
  if (msg.ok) {
    testStats.ok++;
    testStats.sum += msg.latency;
    if (testStats.min === null || msg.latency < testStats.min) testStats.min = msg.latency;
    if (testStats.max === null || msg.latency > testStats.max) testStats.max = msg.latency;
    appendLog(testLog, `  [${seq}]  ✓  ${fmtMs(msg.latency)}  (${msg.protocol})`, 'log-ok');
  } else {
    testStats.fail++;
    appendLog(testLog, `  [${seq}]  ✗  ${msg.error}`, 'log-error');
  }
  updateTestStats();
});

on('test_done', () => {
  const avg = testStats.ok > 0 ? testStats.sum / testStats.ok : null;
  appendLog(testLog, ``, 'log-dim');
  appendLog(testLog, `  Done — min ${fmtMs(testStats.min)}  max ${fmtMs(testStats.max)}  avg ${fmtMs(avg)}  loss ${testStats.fail}/${testStats.ok + testStats.fail}`, 'log-header');
  setTestRunning(false);
  testStatus.className = 'badge badge-done';
  testStatus.textContent = 'Done';
});

on('test_stopped', () => {
  appendLog(testLog, '  Stopped by user', 'log-warn');
  setTestRunning(false);
});

btnStart.addEventListener('click', async () => {
  const host     = document.getElementById('test-host').value.trim();
  const port     = parseInt(document.getElementById('test-port').value);
  const protocol = document.getElementById('test-proto').value;
  const count    = parseInt(document.getElementById('test-count').value) || 10;
  const timeout  = parseInt(document.getElementById('test-timeout').value) || 3000;
  const interval = parseInt(document.getElementById('test-interval').value) || 500;

  if (!host) { document.getElementById('test-host').classList.add('error'); return; }
  if (!port || port < 1 || port > 65535) { document.getElementById('test-port').classList.add('error'); return; }
  document.getElementById('test-host').classList.remove('error');
  document.getElementById('test-port').classList.remove('error');

  testStats = { ok: 0, fail: 0, min: null, max: null, sum: 0 };
  updateTestStats();
  appendLog(testLog, '', '');
  appendLog(testLog, `  Testing ${protocol} proxy  ${host}:${port}  ×${count}`, 'log-header');

  setTestRunning(true);
  try {
    await call('test', { host, port, protocol, count, timeout, interval });
  } catch (e) {
    appendLog(testLog, `  Error: ${e.message}`, 'log-error');
    setTestRunning(false);
  }
});

btnStop.addEventListener('click', () => call('stop', {}));

btnClear.addEventListener('click', () => {
  testLog.innerHTML = '';
  testStats = { ok: 0, fail: 0, min: null, max: null, sum: 0 };
  updateTestStats();
  setTestRunning(false);
  testStatus.className = 'badge badge-idle';
  testStatus.textContent = 'Idle';
});

document.getElementById('btn-copy-log').addEventListener('click', () => {
  const text = Array.from(testLog.querySelectorAll('.log-line')).map(l => l.textContent).join('\n');
  navigator.clipboard.writeText(text);
});

// ═══════════════════════════════════════════════════════════════════════════════
// SCAN TAB
// ═══════════════════════════════════════════════════════════════════════════════
const scanLog    = document.getElementById('scan-log');
const scanStatus = document.getElementById('scan-status');
const btnScanStart = document.getElementById('btn-scan-start');
const btnScanStop  = document.getElementById('btn-scan-stop');
const btnScanClear = document.getElementById('btn-scan-clear');
const resultTbody  = document.getElementById('result-tbody');
const tableEmpty   = document.getElementById('table-empty');

let scanResults  = [];
let scanStart    = null;
let sortKey      = null;
let sortAsc      = true;
let filterStr    = '';
let speedInterval = null;

function setScanRunning(running) {
  btnScanStart.disabled = running;
  btnScanStop.disabled  = !running;
  ['scan-network','scan-mask','scan-port-start','scan-port-end','scan-concurrent','scan-syn-timeout','scan-ver-concurrent']
    .forEach(id => { const el = document.getElementById(id); if (el) el.disabled = running; });
  scanStatus.className = `badge badge-${running ? 'running' : 'idle'}`;
  scanStatus.textContent = running ? 'Scanning…' : 'Idle';
  if (!running && speedInterval) { clearInterval(speedInterval); speedInterval = null; }
}

function renderTable() {
  let rows = [...scanResults];
  if (filterStr) {
    const f = filterStr.toLowerCase();
    rows = rows.filter(r => r.ip.includes(f) || String(r.port).includes(f) || r.protocol.toLowerCase().includes(f));
  }
  if (sortKey) {
    rows.sort((a, b) => {
      let va = a[sortKey], vb = b[sortKey];
      if (typeof va === 'number') return sortAsc ? va - vb : vb - va;
      return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
    });
  }
  document.getElementById('result-count').textContent = rows.length;
  tableEmpty.style.display = rows.length ? 'none' : 'block';

  const frag = document.createDocumentFragment();
  rows.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="col-num">${i + 1}</td>
      <td style="font-family:var(--mono);font-weight:600">${r.ip}</td>
      <td style="font-family:var(--mono)">${r.port}</td>
      <td><span class="proto-chip proto-${r.protocol.toLowerCase()}">${r.protocol}</span></td>
      <td class="${latCls(r.latency)}">${r.latency} ms</td>
      <td><button class="btn-test-row" data-ip="${r.ip}" data-port="${r.port}" data-proto="${r.protocol}">Test →</button></td>
    `;
    frag.appendChild(tr);
  });
  resultTbody.innerHTML = '';
  resultTbody.appendChild(frag);

  // Quick-test buttons
  resultTbody.querySelectorAll('.btn-test-row').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelector('[data-tab="test"]').click();
      document.getElementById('test-host').value  = btn.dataset.ip;
      document.getElementById('test-port').value  = btn.dataset.port;
      document.getElementById('test-proto').value = btn.dataset.proto;
    });
  });
}

// Sort headers
document.querySelectorAll('#result-table th[data-sort]').forEach(th => {
  th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (sortKey === k) sortAsc = !sortAsc; else { sortKey = k; sortAsc = true; }
    renderTable();
  });
});

// Filter
document.getElementById('scan-filter').addEventListener('input', e => {
  filterStr = e.target.value.trim();
  renderTable();
});

// Scan events
on('scan_result', msg => {
  scanResults.push({ ip: msg.ip, port: msg.port, protocol: msg.protocol, latency: msg.latency });
  appendLog(scanLog, `  [FOUND]  ${msg.protocol.padEnd(6)}  ${msg.ip}:${msg.port}  ${msg.latency} ms`, 'log-ok');
  renderTable();
});

on('scan_port_open', msg => {
  document.getElementById('sc-open').textContent = msg.portsOpen;
});

on('scan_progress', msg => {
  const pct = msg.total > 0 ? (msg.scanned / msg.total) * 100 : 0;
  document.getElementById('scan-progress-fill').style.width = `${pct.toFixed(1)}%`;
  document.getElementById('scan-progress-label').textContent =
    `${msg.scanned.toLocaleString()} / ${msg.total.toLocaleString()}`;
  document.getElementById('sc-scanned').textContent = msg.scanned.toLocaleString();
  document.getElementById('sc-found').textContent   = msg.found;
});

on('scan_done', msg => {
  setScanRunning(false);
  scanStatus.className = 'badge badge-done';
  scanStatus.textContent = 'Done';
  const elapsed = scanStart ? ((Date.now() - scanStart) / 1000).toFixed(1) : '?';
  appendLog(scanLog, `  [DONE]  ${msg.found} proxies found in ${elapsed}s (${msg.scanned.toLocaleString()} scanned, ${msg.portsOpen} ports open)`, 'log-header');
  document.getElementById('sc-speed').textContent = '0/s';
});

btnScanStart.addEventListener('click', async () => {
  const network         = document.getElementById('scan-network').value.trim();
  const mask            = document.getElementById('scan-mask').value.trim();
  const startPort       = parseInt(document.getElementById('scan-port-start').value) || 1;
  const endPort         = parseInt(document.getElementById('scan-port-end').value) || 9999;
  const concurrent      = Math.min(parseInt(document.getElementById('scan-concurrent').value) || 300, 5000);
  const synTimeout      = parseInt(document.getElementById('scan-syn-timeout').value) || 500;
  const verifyConcurrent = Math.min(parseInt(document.getElementById('scan-ver-concurrent').value) || 50, 500);

  if (!network) { document.getElementById('scan-network').classList.add('error'); return; }
  document.getElementById('scan-network').classList.remove('error');

  scanResults = [];
  renderTable();
  scanLog.innerHTML = '';
  document.getElementById('sc-scanned').textContent = '0';
  document.getElementById('sc-open').textContent    = '0';
  document.getElementById('sc-found').textContent   = '0';
  document.getElementById('sc-speed').textContent   = '0/s';
  document.getElementById('scan-progress-fill').style.width = '0%';
  document.getElementById('scan-progress-label').textContent = '0 / 0';

  scanStart = Date.now();
  setScanRunning(true);

  appendLog(scanLog, `  [START]  ${network} / ${mask}  ports ${startPort}–${endPort}  threads ${concurrent}`, 'log-info');

  // Speed tracker
  let lastScanned = 0;
  speedInterval = setInterval(() => {
    const cur = parseInt(document.getElementById('sc-scanned').textContent.replace(/,/g, '')) || 0;
    document.getElementById('sc-speed').textContent = `${(cur - lastScanned)}/s`;
    lastScanned = cur;
  }, 1000);

  try {
    await call('scan', { network, mask, startPort, endPort, concurrent, synTimeout, verifyTimeout: 1500, verifyConcurrent });
  } catch (e) {
    appendLog(scanLog, `  [ERROR]  ${e.message}`, 'log-error');
    setScanRunning(false);
  }
});

btnScanStop.addEventListener('click', () => {
  call('stop', {});
  appendLog(scanLog, '  [STOP]  Stopping…', 'log-warn');
});

btnScanClear.addEventListener('click', () => {
  scanResults = [];
  renderTable();
  scanLog.innerHTML = '';
  document.getElementById('sc-scanned').textContent = '0';
  document.getElementById('sc-open').textContent    = '0';
  document.getElementById('sc-found').textContent   = '0';
  document.getElementById('sc-speed').textContent   = '0/s';
  document.getElementById('scan-progress-fill').style.width = '0%';
  document.getElementById('scan-progress-label').textContent = '0 / 0';
  setScanRunning(false);
});

// Export CSV
document.getElementById('btn-export').addEventListener('click', () => {
  if (!scanResults.length) return;
  const csv = ['IP,Port,Protocol,Latency(ms)', ...scanResults.map(r => `${r.ip},${r.port},${r.protocol},${r.latency}`)].join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = `proxies_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
});

// ═══════════════════════════════════════════════════════════════════════════════
// AUTO TAB
// ═══════════════════════════════════════════════════════════════════════════════

const DEFAULT_RANGES = [
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

let autoRanges   = DEFAULT_RANGES.map(r => ({ ...r, enabled: true }));
let autoRunning  = false;
let autoSpeedInt = null;
let autoFound    = 0;

function renderRangeTable() {
  document.getElementById('range-count').textContent = autoRanges.filter(r => r.enabled).length + '/' + autoRanges.length;
  const tbody = document.getElementById('range-tbody');
  tbody.innerHTML = autoRanges.map((r, i) => `
    <tr id="range-row-${i}">
      <td style="text-align:center">
        <span class="range-status waiting" id="range-dot-${i}"></span>
      </td>
      <td>
        <input type="checkbox" ${r.enabled ? 'checked' : ''} onchange="toggleRange(${i}, this.checked)"
          style="accent-color:var(--primary);margin-right:6px"/>
        <span style="font-size:12px;color:var(--muted)">${r.label}</span>
      </td>
      <td style="font-family:var(--mono);font-size:12px">${r.network}</td>
      <td style="font-size:12px;color:var(--muted)">${r.mask}</td>
      <td>
        <button class="icon-btn" onclick="removeRange(${i})" title="Remove">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </td>
    </tr>
  `).join('');
}

window.toggleRange = (i, v) => { autoRanges[i].enabled = v; renderRangeTable(); };
window.removeRange = i => { autoRanges.splice(i, 1); renderRangeTable(); };

document.getElementById('btn-reset-ranges').addEventListener('click', () => {
  autoRanges = DEFAULT_RANGES.map(r => ({ ...r, enabled: true }));
  renderRangeTable();
});

document.getElementById('btn-add-range').addEventListener('click', () => {
  const label   = prompt('Label (e.g. My Range):');
  if (!label) return;
  const network = prompt('Network (e.g. 192.168.1.0):');
  if (!network) return;
  const mask    = prompt('Subnet mask:', '255.255.255.0') || '255.255.255.0';
  autoRanges.push({ label, network, mask, enabled: true });
  renderRangeTable();
});

function setAutoRunning(running) {
  autoRunning = running;
  document.getElementById('btn-auto-start').disabled = running;
  document.getElementById('btn-auto-stop').disabled  = !running;
  ['auto-port-start','auto-port-end','auto-concurrent','auto-syn-timeout','auto-ver-concurrent']
    .forEach(id => { const el = document.getElementById(id); if (el) el.disabled = running; });
  const status = document.getElementById('auto-status');
  status.className = `badge badge-${running ? 'running' : 'idle'}`;
  status.textContent = running ? 'Running…' : 'Idle';
  if (!running && autoSpeedInt) { clearInterval(autoSpeedInt); autoSpeedInt = null; }
}

const autoLog = document.getElementById('auto-log');

on('auto_range_start', msg => {
  document.getElementById('auto-range-cur').textContent   = msg.index + 1;
  document.getElementById('auto-range-total').textContent = msg.total;
  document.getElementById('auto-progress-fill').style.width = '0%';
  document.getElementById('auto-progress-label').textContent = `Scanning ${msg.label || msg.network}…`;
  const prev = document.querySelector('.range-status.running');
  if (prev) prev.classList.replace('running', 'done');
  const dot = document.getElementById(`range-dot-${msg.index}`);
  if (dot) dot.className = 'range-status running';
  appendLog(autoLog, `  [${msg.index + 1}/${msg.total}]  Starting → ${msg.label || msg.network} (${msg.network})`, 'log-info');
});

on('auto_range_done', msg => {
  const dot = document.getElementById(`range-dot-${msg.index}`);
  if (dot) dot.className = 'range-status done';
  appendLog(autoLog, `  [${msg.index + 1}/${msg.total}]  Done → ${msg.label || msg.network}`, 'log-dim');
});

on('auto_done', msg => {
  setAutoRunning(false);
  document.getElementById('auto-status').className = 'badge badge-done';
  document.getElementById('auto-status').textContent = 'Done';
  const elapsed = (msg.elapsed / 1000).toFixed(1);
  appendLog(autoLog, `  [DONE]  All ranges complete — ${autoFound} proxies found in ${elapsed}s`, 'log-header');
  document.getElementById('auto-speed').textContent = '0/s';
  refreshStore();
});

on('scan_progress', msg => {
  if (!autoRunning) return;
  const pct = msg.total > 0 ? (msg.scanned / msg.total) * 100 : 0;
  document.getElementById('auto-progress-fill').style.width = `${pct.toFixed(1)}%`;
  document.getElementById('auto-progress-label').textContent =
    `${msg.scanned.toLocaleString()} / ${msg.total.toLocaleString()}`;
});

on('scan_result', msg => {
  if (autoRunning) {
    autoFound++;
    document.getElementById('auto-found').textContent = autoFound;
    appendLog(autoLog, `  [FOUND]  ${msg.protocol.padEnd(6)}  ${msg.ip}:${msg.port}  ${msg.latency} ms`, 'log-ok');
  }
});

document.getElementById('btn-auto-start').addEventListener('click', async () => {
  const targets = autoRanges.filter(r => r.enabled);
  if (!targets.length) { alert('Enable at least one IP range.'); return; }

  const startPort       = parseInt(document.getElementById('auto-port-start').value) || 7000;
  const endPort         = parseInt(document.getElementById('auto-port-end').value)   || 9999;
  const concurrent      = parseInt(document.getElementById('auto-concurrent').value) || 500;
  const synTimeout      = parseInt(document.getElementById('auto-syn-timeout').value) || 400;
  const verifyConcurrent = parseInt(document.getElementById('auto-ver-concurrent').value) || 60;

  autoFound = 0;
  document.getElementById('auto-found').textContent   = '0';
  document.getElementById('auto-range-cur').textContent = '0';
  document.getElementById('auto-range-total').textContent = targets.length;
  document.getElementById('auto-speed').textContent   = '0/s';
  document.getElementById('auto-progress-fill').style.width = '0%';
  autoLog.innerHTML = '';

  renderRangeTable();
  setAutoRunning(true);

  appendLog(autoLog, `  [START]  Auto scanning ${targets.length} ranges  ports ${startPort}–${endPort}  threads ${concurrent}`, 'log-header');

  let lastScanned = 0;
  autoSpeedInt = setInterval(() => {
    const label = document.getElementById('auto-progress-label').textContent;
    const cur = parseInt((label.split('/')[0] || '0').replace(/[^0-9]/g, '')) || 0;
    document.getElementById('auto-speed').textContent = `${cur - lastScanned}/s`;
    lastScanned = cur;
  }, 1000);

  try {
    await call('auto_scan', { targets, startPort, endPort, concurrent, synTimeout, verifyTimeout: 1500, verifyConcurrent });
  } catch (e) {
    appendLog(autoLog, `  [ERROR]  ${e.message}`, 'log-error');
    setAutoRunning(false);
  }
});

document.getElementById('btn-auto-stop').addEventListener('click', () => {
  call('stop', {});
  appendLog(autoLog, '  [STOP]  Stopping after current range…', 'log-warn');
});

// ── Recheck panel ─────────────────────────────────────────────────────────────
const recheckLog = document.getElementById('recheck-log');

on('recheck_start', msg => {
  document.getElementById('rc-checked').textContent = '0';
  document.getElementById('rc-alive').textContent   = '0';
  document.getElementById('rc-removed').textContent = '0';
  document.getElementById('rc-progress-fill').style.width = '0%';
  document.getElementById('rc-progress-label').textContent = `0 / ${msg.total}`;
  appendLog(recheckLog, `  [START]  Rechecking ${msg.total} stored proxies…`, 'log-header');
});

on('recheck_progress', msg => {
  const pct = msg.total > 0 ? (msg.checked / msg.total) * 100 : 0;
  document.getElementById('rc-progress-fill').style.width  = `${pct.toFixed(1)}%`;
  document.getElementById('rc-progress-label').textContent = `${msg.checked} / ${msg.total}`;
  document.getElementById('rc-checked').textContent = msg.checked;
  document.getElementById('rc-alive').textContent   = msg.alive;
  document.getElementById('rc-removed').textContent = msg.removed;
});

on('recheck_result', msg => {
  if (msg.alive) {
    appendLog(recheckLog, `  [OK]   ${msg.ip}:${msg.port}  ${msg.latency} ms  (${msg.protocol})`, 'log-ok');
  } else {
    appendLog(recheckLog, `  [DEAD] ${msg.ip}:${msg.port}  removed`, 'log-error');
  }
});

on('recheck_done', msg => {
  document.getElementById('btn-recheck-start').disabled = false;
  document.getElementById('btn-recheck-stop').disabled  = true;
  document.getElementById('auto-status').className  = 'badge badge-done';
  document.getElementById('auto-status').textContent = 'Done';
  appendLog(recheckLog, `  [DONE]  ${msg.alive} alive  ${msg.removed} removed`, 'log-header');
  refreshStore();
});

document.getElementById('btn-recheck-start').addEventListener('click', async () => {
  const timeout    = parseInt(document.getElementById('recheck-timeout').value) || 5000;
  const concurrent = parseInt(document.getElementById('recheck-concurrent').value) || 50;
  recheckLog.innerHTML = '';
  document.getElementById('btn-recheck-start').disabled = true;
  document.getElementById('btn-recheck-stop').disabled  = false;
  document.getElementById('auto-status').className  = 'badge badge-running';
  document.getElementById('auto-status').textContent = 'Rechecking…';
  try {
    await call('recheck', { timeout, concurrent });
  } catch (e) {
    appendLog(recheckLog, `  [ERROR]  ${e.message}`, 'log-error');
    document.getElementById('btn-recheck-start').disabled = false;
  }
});

document.getElementById('btn-recheck-stop').addEventListener('click', () => call('stop', {}));

// ── Auto mode switcher ────────────────────────────────────────────────────────
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b === btn));
    const mode = btn.dataset.mode;
    document.getElementById('auto-scan-panel').style.display    = mode === 'scan'    ? '' : 'none';
    document.getElementById('auto-recheck-panel').style.display = mode === 'recheck' ? '' : 'none';
  });
});

// Init
renderRangeTable();

// ── API Tab ───────────────────────────────────────────────────────────────────
let storeData = [];

function fmtDate(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  return d.toLocaleDateString() + ' ' + d.toTimeString().slice(0, 8);
}

function renderStore(data) {
  storeData = data || [];
  const filter = (document.getElementById('store-filter').value || '').toLowerCase();
  const rows   = storeData.filter(p =>
    !filter ||
    p.ip.includes(filter) ||
    String(p.port).includes(filter) ||
    p.protocol.toLowerCase().includes(filter)
  );

  const tbody = document.getElementById('store-tbody');
  const empty = document.getElementById('store-empty');
  document.getElementById('store-count').textContent = storeData.length;

  if (!rows.length) {
    tbody.innerHTML = '';
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  tbody.innerHTML = rows.map((p, i) => `
    <tr>
      <td class="col-num">${i + 1}</td>
      <td>${p.ip}</td>
      <td>${p.port}</td>
      <td><span class="proto-badge ${p.protocol.toLowerCase()}">${p.protocol}</span></td>
      <td>${p.latency} ms</td>
      <td style="font-size:11px;color:var(--muted)">${fmtDate(p.first_seen)}</td>
      <td style="font-size:11px;color:var(--muted)">${fmtDate(p.last_seen)}</td>
      <td>${p.checks}</td>
      <td>
        <button class="icon-btn" title="Remove" onclick="removeFromStore('${p.ip}:${p.port}')">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>
          </svg>
        </button>
      </td>
    </tr>
  `).join('');
}

async function refreshStore() {
  try {
    const r = await call('get_store', {});
    renderStore(r.proxies);
    updateApiStats(r.proxies);
    refreshJsonPreview();
  } catch {}
}

function updateApiStats(proxies) {
  const http   = proxies.filter(p => p.protocol === 'HTTP').length;
  const socks5 = proxies.filter(p => p.protocol === 'SOCKS5').length;
  const avgL   = proxies.length
    ? Math.round(proxies.reduce((s, p) => s + p.latency, 0) / proxies.length)
    : 0;
  document.getElementById('api-stat-total').textContent  = proxies.length;
  document.getElementById('api-stat-http').textContent   = http;
  document.getElementById('api-stat-socks5').textContent = socks5;
  document.getElementById('api-stat-latency').textContent = proxies.length ? avgL + ' ms' : '-- ms';
  document.getElementById('api-total-badge').textContent  = proxies.length + ' proxies';
}

async function refreshJsonPreview() {
  try {
    const res  = await fetch('/api/proxies');
    const data = await res.json();
    document.getElementById('json-preview').textContent = JSON.stringify(data, null, 2);
  } catch (e) {
    document.getElementById('json-preview').textContent = 'Error: ' + e.message;
  }
}

window.removeFromStore = async function(key) {
  await call('remove_proxy', { key });
  await refreshStore();
};

document.getElementById('btn-refresh-store').addEventListener('click', refreshStore);

document.getElementById('btn-clear-store').addEventListener('click', async () => {
  if (!confirm('Clear all stored proxies?')) return;
  await call('clear_store', {});
  await refreshStore();
});

document.getElementById('store-filter').addEventListener('input', () => renderStore(storeData));

// Copy endpoint URLs
document.querySelectorAll('.copy-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const ep   = btn.dataset.ep;
    const map  = { all: '/api/proxies', http: '/api/proxies/http', socks5: '/api/proxies/socks5', raw: '/api/proxies/raw', stats: '/api/stats' };
    const url  = location.origin + (map[ep] || '');
    navigator.clipboard.writeText(url).then(() => {
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy', 1500);
    });
  });
});

// Update endpoint links with full origin
function initApiLinks() {
  const base = location.origin;
  document.getElementById('ep-all-link').href    = base + '/api/proxies';
  document.getElementById('ep-http-link').href   = base + '/api/proxies/http';
  document.getElementById('ep-socks5-link').href = base + '/api/proxies/socks5';
  document.getElementById('ep-raw-link').href    = base + '/api/proxies/raw';
  document.getElementById('ep-stats-link').href  = base + '/api/stats';
}

// Update store count badge when a scan finds a proxy
const origScanResult = handlers.get('scan_result');
handlers.set('scan_result', msg => {
  if (origScanResult) origScanResult(msg);
  refreshStore();
});

// Refresh store when switching to API tab
document.querySelectorAll('.nav-btn[data-tab="api"]').forEach(btn => {
  btn.addEventListener('click', () => { refreshStore(); initApiLinks(); });
});

// ── Schedule Status ───────────────────────────────────────────────────────────
const schedDot   = document.getElementById('sched-dot');
const schedLabel = document.getElementById('sched-label');
const schedNext  = document.getElementById('sched-next');

function fmtCountdown(iso) {
  if (!iso) return '';
  const diff = new Date(iso) - Date.now();
  if (diff <= 0) return 'Sắp quét…';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return `Còn ${h}h ${m}m`;
}

function updateSchedUI(scanning, nextTime, lastPush) {
  if (scanning) {
    schedDot.className   = 'sched-dot scanning';
    schedLabel.textContent = 'Đang quét…';
    schedNext.textContent  = '';
  } else {
    schedDot.className   = 'sched-dot idle';
    schedLabel.textContent = 'Tự động 24h';
    schedNext.textContent  = nextTime ? fmtCountdown(nextTime) : '';
  }
}

async function fetchSchedule() {
  try {
    const r = await fetch('/api/schedule');
    const d = await r.json();
    updateSchedUI(d.scanning, d.next_scan, d.last_push);
  } catch {}
}

on('schedule_start', msg => updateSchedUI(true, null, null));
on('schedule_push_done', msg => {
  updateSchedUI(false, null, msg.time);
  refreshStore();
});

document.getElementById('btn-push-github').addEventListener('click', async () => {
  const btn = document.getElementById('btn-push-github');
  btn.textContent = 'Đang push…';
  btn.disabled = true;
  try {
    await fetch('/api/schedule/push', { method: 'POST' });
    btn.textContent = 'Đã push!';
    setTimeout(() => { btn.textContent = '⬆ Push GitHub'; btn.disabled = false; }, 2000);
  } catch {
    btn.textContent = '⬆ Push GitHub';
    btn.disabled = false;
  }
});

// Refresh countdown every minute
setInterval(fetchSchedule, 60000);

// ── Start ─────────────────────────────────────────────────────────────────────
wsConnect();
initApiLinks();
fetchSchedule();
