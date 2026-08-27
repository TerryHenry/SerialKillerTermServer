'use strict';

const api = {
  async get(url) {
    const res = await fetch(url);
    if (!res.ok) throw await apiError(res);
    return res.json();
  },
  async post(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    if (!res.ok) throw await apiError(res);
    return res.json();
  },
  async del(url) {
    const res = await fetch(url, { method: 'DELETE' });
    if (!res.ok) throw await apiError(res);
    return res.json();
  }
};

async function apiError(res) {
  try {
    const body = await res.json();
    return new Error(body.error || `HTTP ${res.status}`);
  } catch {
    return new Error(`HTTP ${res.status}`);
  }
}

function show(el) { el.classList.add('active'); }
function hide(el) { el.classList.remove('active'); }

const setupScreen = document.getElementById('setupScreen');
const loginScreen = document.getElementById('loginScreen');
const forceChangeScreen = document.getElementById('forceChangeScreen');
const appRoot = document.getElementById('appRoot');

// ---------- Auth bootstrap ----------
async function boot() {
  const session = await api.get('/api/session');
  if (session.needsSetup) {
    show(setupScreen);
    document.body.classList.remove('app-mode');
    return;
  }
  if (!session.authenticated) {
    show(loginScreen);
    document.body.classList.remove('app-mode');
    return;
  }
  if (session.mustChangePassword) {
    show(forceChangeScreen);
    document.body.classList.remove('app-mode');
    return;
  }
  document.body.classList.add('app-mode');
  show(appRoot);
  await initApp();
}

document.getElementById('setupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('setupError');
  errorEl.textContent = '';
  try {
    await api.post('/api/setup', {
      username: document.getElementById('setupUsername').value.trim(),
      password: document.getElementById('setupPassword').value
    });
    hide(setupScreen);
    document.body.classList.add('app-mode');
    show(appRoot);
    await initApp();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('loginError');
  errorEl.textContent = '';
  try {
    const result = await api.post('/api/login', {
      username: document.getElementById('loginUsername').value.trim(),
      password: document.getElementById('loginPassword').value
    });
    hide(loginScreen);
    if (result.mustChangePassword) {
      show(forceChangeScreen);
      return;
    }
    document.body.classList.add('app-mode');
    show(appRoot);
    await initApp();
  } catch (err) {
    errorEl.textContent = 'Invalid username or password.';
  }
});

document.getElementById('forceChangeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('forceChangeError');
  errorEl.textContent = '';
  try {
    await api.post('/api/admin-password', {
      password: document.getElementById('forceChangePassword').value
    });
    hide(forceChangeScreen);
    document.body.classList.add('app-mode');
    show(appRoot);
    await initApp();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await api.post('/api/logout');
  window.location.reload();
});

// ---------- Tabs ----------
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ---------- Status / server toggle ----------
function setStatus(running) {
  const pill = document.getElementById('statusPill');
  const text = document.getElementById('statusText');
  const btn = document.getElementById('toggleServerBtn');
  pill.classList.toggle('running', running);
  text.textContent = running ? 'Running' : 'Stopped';
  btn.textContent = running ? 'Stop Server' : 'Start Server';
}

document.getElementById('toggleServerBtn').addEventListener('click', async () => {
  const status = await api.get('/api/server/status');
  const result = status.running ? await api.post('/api/server/stop') : await api.post('/api/server/start');
  setStatus(result.running);
});

// ---------- TFTP ----------
function setTftpStatus(running) {
  const pill = document.getElementById('tftpStatusPill');
  const text = document.getElementById('tftpStatusText');
  const btn = document.getElementById('toggleTftpBtn');
  pill.classList.toggle('running', running);
  text.textContent = running ? 'Running' : 'Stopped';
  btn.textContent = running ? 'Stop Server' : 'Start Server';
}

async function loadTftpSettings() {
  const config = await api.get('/api/config');
  document.getElementById('tftpPort').value = config.tftp.port;
  document.getElementById('tftpAllowUpload').checked = config.tftp.allowUpload;
  document.getElementById('tftpAutoStart').checked = config.tftp.autoStart;
  const status = await api.get('/api/tftp/status');
  setTftpStatus(status.running);
}

document.getElementById('saveTftpSettingsBtn').addEventListener('click', async () => {
  await api.post('/api/tftp-settings', {
    port: Number(document.getElementById('tftpPort').value),
    allowUpload: document.getElementById('tftpAllowUpload').checked,
    autoStart: document.getElementById('tftpAutoStart').checked
  });
});

document.getElementById('toggleTftpBtn').addEventListener('click', async () => {
  const status = await api.get('/api/tftp/status');
  try {
    const result = status.running ? await api.post('/api/tftp/stop') : await api.post('/api/tftp/start');
    setTftpStatus(result.running);
  } catch (err) {
    alert(err.message);
  }
});

// ---------- TFTP directory ----------
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

async function loadTftpFiles() {
  const files = await api.get('/api/tftp/files');
  const tbody = document.querySelector('#tftpFilesTable tbody');
  const empty = document.getElementById('tftpFilesEmpty');
  tbody.innerHTML = '';
  empty.style.display = files.length ? 'none' : 'block';
  for (const f of files) {
    const tr = document.createElement('tr');
    const nameCell = document.createElement('td');
    const link = document.createElement('a');
    link.href = `/api/tftp/files/${encodeURIComponent(f.name)}`;
    link.textContent = f.name;
    nameCell.appendChild(link);
    tr.appendChild(nameCell);
    const sizeCell = document.createElement('td');
    sizeCell.textContent = formatBytes(f.size);
    tr.appendChild(sizeCell);
    const modCell = document.createElement('td');
    modCell.textContent = new Date(f.modifiedAt).toLocaleString();
    tr.appendChild(modCell);
    const actionsCell = document.createElement('td');
    const delBtn = document.createElement('button');
    delBtn.textContent = 'Delete';
    delBtn.className = 'danger';
    delBtn.addEventListener('click', async () => {
      if (confirm(`Delete "${f.name}"?`)) {
        await api.del(`/api/tftp/files/${encodeURIComponent(f.name)}`);
        await loadTftpFiles();
      }
    });
    actionsCell.appendChild(delBtn);
    tr.appendChild(actionsCell);
    tbody.appendChild(tr);
  }
}

document.getElementById('tftpUploadBtn').addEventListener('click', () => {
  document.getElementById('tftpUploadInput').click();
});

document.getElementById('tftpUploadInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const msg = document.getElementById('tftpUploadMsg');
  msg.textContent = '';
  const formData = new FormData();
  formData.append('file', file);
  try {
    const res = await fetch('/api/tftp/files', { method: 'POST', body: formData });
    if (!res.ok) throw await apiError(res);
    await loadTftpFiles();
  } catch (err) {
    msg.textContent = err.message;
  }
});

// ---------- Server settings ----------
async function loadServerSettings() {
  const config = await api.get('/api/config');
  document.getElementById('sshPort').value = config.ssh.port;
  document.getElementById('allowMenu').checked = config.ssh.allowPortMenu;
  document.getElementById('autoStart').checked = config.ssh.autoStart;
  document.getElementById('banner').value = config.ssh.banner;
  const fp = await api.get('/api/host-key-fingerprint');
  document.getElementById('hostKeyFingerprint').textContent = fp.fingerprint || '(unavailable)';
}

document.getElementById('saveServerSettingsBtn').addEventListener('click', async () => {
  await api.post('/api/ssh-settings', {
    port: Number(document.getElementById('sshPort').value),
    allowPortMenu: document.getElementById('allowMenu').checked,
    autoStart: document.getElementById('autoStart').checked,
    banner: document.getElementById('banner').value
  });
});

// ---------- Admin password ----------
document.getElementById('changeAdminPasswordBtn').addEventListener('click', async () => {
  const msg = document.getElementById('adminPasswordMsg');
  msg.textContent = '';
  const password = document.getElementById('newAdminPassword').value;
  try {
    await api.post('/api/admin-password', { password });
    document.getElementById('newAdminPassword').value = '';
    msg.style.color = 'var(--ok)';
    msg.textContent = 'Password updated.';
  } catch (err) {
    msg.style.color = 'var(--danger)';
    msg.textContent = err.message;
  }
});

// ---------- Ports ----------
async function loadPortsTable() {
  const ports = await api.get('/api/ports');
  const tbody = document.querySelector('#portsTable tbody');
  tbody.innerHTML = '';
  for (const p of ports) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(p.label)}</td>
      <td>${escapeHtml(p.path)}</td>
      <td>${p.baudRate}</td>
      <td>${p.dataBits}/${p.stopBits}/${p.parity}</td>
      <td>${accessLabel(p.access)}</td>
      <td></td>
    `;
    const actionsCell = tr.lastElementChild;
    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => openPortModal(p));
    const delBtn = document.createElement('button');
    delBtn.textContent = 'Delete';
    delBtn.className = 'danger';
    delBtn.style.marginLeft = '6px';
    delBtn.addEventListener('click', async () => {
      if (confirm(`Delete port "${p.label}"?`)) {
        await api.del(`/api/ports/${p.id}`);
        await loadPortsTable();
        await refreshUserDefaultPortOptions();
      }
    });
    actionsCell.appendChild(editBtn);
    actionsCell.appendChild(delBtn);
    tbody.appendChild(tr);
  }
}

function accessLabel(access) {
  if (access === 'shared-rw') return 'Shared (read/write)';
  if (access === 'first-write') return 'Shared (first user read/write)';
  if (access === 'shared-ro') return 'Shared (read-only)';
  return 'Exclusive';
}

async function refreshSystemPortsDatalist() {
  const ports = await api.get('/api/ports/system');
  const list = document.getElementById('systemPortsList');
  list.innerHTML = '';
  for (const p of ports) {
    const opt = document.createElement('option');
    opt.value = p.path;
    opt.label = p.manufacturer ? `${p.path} (${p.manufacturer})` : p.path;
    list.appendChild(opt);
  }
}

function openPortModal(port) {
  document.getElementById('portModalTitle').textContent = port ? 'Edit Serial Port' : 'Add Serial Port';
  document.getElementById('portId').value = port?.id || '';
  document.getElementById('portLabel').value = port?.label || '';
  document.getElementById('portPath').value = port?.path || '';
  document.getElementById('portBaud').value = String(port?.baudRate || 9600);
  document.getElementById('portDataBits').value = String(port?.dataBits || 8);
  document.getElementById('portStopBits').value = String(port?.stopBits || 1);
  document.getElementById('portParity').value = port?.parity || 'none';
  document.getElementById('portRtscts').checked = !!port?.rtscts;
  document.getElementById('portAccess').value = port?.access || 'exclusive';
  refreshSystemPortsDatalist();
  document.getElementById('portModalBackdrop').classList.add('open');
}

function closePortModal() {
  document.getElementById('portModalBackdrop').classList.remove('open');
}

document.getElementById('addPortBtn').addEventListener('click', () => openPortModal(null));
document.getElementById('cancelPortBtn').addEventListener('click', closePortModal);
document.getElementById('refreshSystemPortsBtn').addEventListener('click', refreshSystemPortsDatalist);

document.getElementById('savePortBtn').addEventListener('click', async () => {
  const label = document.getElementById('portLabel').value.trim();
  const devPath = document.getElementById('portPath').value.trim();
  if (!label || !devPath) {
    alert('Label and device path are required.');
    return;
  }
  const port = {
    id: document.getElementById('portId').value || undefined,
    label,
    path: devPath,
    baudRate: Number(document.getElementById('portBaud').value),
    dataBits: Number(document.getElementById('portDataBits').value),
    stopBits: Number(document.getElementById('portStopBits').value),
    parity: document.getElementById('portParity').value,
    rtscts: document.getElementById('portRtscts').checked,
    access: document.getElementById('portAccess').value
  };
  await api.post('/api/ports', port);
  closePortModal();
  await loadPortsTable();
  await refreshUserDefaultPortOptions();
});

// ---------- Users ----------
async function loadUsersTable() {
  const users = await api.get('/api/users');
  const ports = await api.get('/api/ports');
  const portById = Object.fromEntries(ports.map((p) => [p.id, p.label]));
  const tbody = document.querySelector('#usersTable tbody');
  tbody.innerHTML = '';
  for (const u of users) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(u.username)}</td>
      <td>${escapeHtml(u.authMethod)}</td>
      <td>${u.permission === 'read-only' ? 'Read-only' : 'Read/write'}</td>
      <td>${u.defaultPortId ? escapeHtml(portById[u.defaultPortId] || '(deleted port)') : '<span class="hint">port menu</span>'}</td>
      <td></td>
    `;
    const actionsCell = tr.lastElementChild;
    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => openUserModal(u));
    const delBtn = document.createElement('button');
    delBtn.textContent = 'Delete';
    delBtn.className = 'danger';
    delBtn.style.marginLeft = '6px';
    delBtn.addEventListener('click', async () => {
      if (confirm(`Delete user "${u.username}"?`)) {
        await api.del(`/api/users/${u.id}`);
        await loadUsersTable();
      }
    });
    actionsCell.appendChild(editBtn);
    actionsCell.appendChild(delBtn);
    tbody.appendChild(tr);
  }
}

async function refreshUserDefaultPortOptions(selectedId) {
  const ports = await api.get('/api/ports');
  const select = document.getElementById('userDefaultPort');
  select.innerHTML = '<option value="">(none — show port menu)</option>';
  for (const p of ports) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.label;
    select.appendChild(opt);
  }
  select.value = selectedId || '';
}

function updateAuthMethodVisibility() {
  const method = document.getElementById('userAuthMethod').value;
  document.getElementById('userPasswordRow').style.display = method === 'publickey' ? 'none' : 'flex';
  document.getElementById('userPublicKeyRow').style.display = method === 'password' ? 'none' : 'flex';
}
document.getElementById('userAuthMethod').addEventListener('change', updateAuthMethodVisibility);

async function openUserModal(user) {
  document.getElementById('userModalTitle').textContent = user ? 'Edit User' : 'Add User';
  document.getElementById('userId').value = user?.id || '';
  document.getElementById('userUsername').value = user?.username || '';
  document.getElementById('userAuthMethod').value = user?.authMethod || 'password';
  document.getElementById('userPassword').value = '';
  document.getElementById('userPublicKey').value = user?.publicKey || '';
  document.getElementById('userPermission').value = user?.permission || 'read-write';
  await refreshUserDefaultPortOptions(user?.defaultPortId);
  updateAuthMethodVisibility();
  document.getElementById('userModalBackdrop').classList.add('open');
}

function closeUserModal() {
  document.getElementById('userModalBackdrop').classList.remove('open');
}

document.getElementById('addUserBtn').addEventListener('click', () => openUserModal(null));
document.getElementById('cancelUserBtn').addEventListener('click', closeUserModal);

document.getElementById('saveUserBtn').addEventListener('click', async () => {
  const username = document.getElementById('userUsername').value.trim();
  if (!username) {
    alert('Username is required.');
    return;
  }
  const authMethod = document.getElementById('userAuthMethod').value;
  const password = document.getElementById('userPassword').value;
  const publicKey = document.getElementById('userPublicKey').value.trim();

  if (authMethod !== 'publickey' && !password) {
    const existingId = document.getElementById('userId').value;
    if (!existingId) {
      alert('A password is required for new users using password authentication.');
      return;
    }
  }
  if (authMethod !== 'password' && !publicKey) {
    alert('A public key is required for public-key authentication.');
    return;
  }

  const user = {
    id: document.getElementById('userId').value || undefined,
    username,
    authMethod,
    publicKey: authMethod === 'password' ? '' : publicKey,
    permission: document.getElementById('userPermission').value,
    defaultPortId: document.getElementById('userDefaultPort').value || null,
    newPassword: password || undefined
  };
  await api.post('/api/users', user);
  closeUserModal();
  await loadUsersTable();
});

// ---------- Sessions ----------
function renderSessions(sessions) {
  const tbody = document.querySelector('#sessionsTable tbody');
  tbody.innerHTML = '';
  for (const s of sessions) {
    const tr = document.createElement('tr');
    const since = new Date(s.connectedAt).toLocaleTimeString();
    tr.innerHTML = `
      <td>${escapeHtml(s.username)}</td>
      <td>${s.portLabel ? escapeHtml(s.portLabel) : '<span class="hint">at menu</span>'}</td>
      <td>${since}</td>
      <td>${s.permission === 'read-only' ? 'Read-only' : 'Read/write'}</td>
      <td></td>
    `;
    const actionsCell = tr.lastElementChild;
    const kickBtn = document.createElement('button');
    kickBtn.textContent = 'Disconnect';
    kickBtn.className = 'danger';
    kickBtn.addEventListener('click', () => api.post(`/api/sessions/${s.id}/kick`));
    actionsCell.appendChild(kickBtn);
    tbody.appendChild(tr);
  }
}

// ---------- Dashboard ----------
function setBar(fillEl, percent) {
  const pct = Math.max(0, Math.min(100, percent || 0));
  fillEl.style.width = `${pct}%`;
  fillEl.classList.toggle('warn', pct >= 70 && pct < 90);
  fillEl.classList.toggle('danger', pct >= 90);
}

function renderStats(stats) {
  document.getElementById('statCpu').textContent = `${stats.cpuPercent.toFixed(1)}%`;
  setBar(document.getElementById('statCpuBar'), stats.cpuPercent);

  document.getElementById('statMem').textContent = `${stats.memory.percent.toFixed(1)}%`;
  setBar(document.getElementById('statMemBar'), stats.memory.percent);
  document.getElementById('statMemSub').textContent =
    `${formatBytes(stats.memory.used)} / ${formatBytes(stats.memory.total)}`;

  if (stats.disk) {
    document.getElementById('statDisk').textContent = `${stats.disk.percent.toFixed(1)}%`;
    setBar(document.getElementById('statDiskBar'), stats.disk.percent);
    document.getElementById('statDiskSub').textContent =
      `${formatBytes(stats.disk.used)} / ${formatBytes(stats.disk.total)}`;
  }

  document.getElementById('statClients').textContent = stats.clientsConnected;

  const tbody = document.querySelector('#clientsPerPortTable tbody');
  const empty = document.getElementById('clientsPerPortEmpty');
  tbody.innerHTML = '';
  empty.style.display = stats.clientsPerPort.length ? 'none' : 'block';
  for (const row of stats.clientsPerPort) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(row.label)}</td><td>${row.count}</td>`;
    tbody.appendChild(tr);
  }
}

// ---------- Log ----------
async function loadLogHistory() {
  const lines = await api.get('/api/log');
  const logView = document.getElementById('logView');
  logView.textContent = lines.length ? lines.join('\n') + '\n' : '';
  logView.scrollTop = logView.scrollHeight;
}

// ---------- Live events ----------
let eventSource = null;
function connectEvents() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource('/api/events');
  const logView = document.getElementById('logView');
  eventSource.addEventListener('log', (e) => {
    logView.textContent += JSON.parse(e.data) + '\n';
    logView.scrollTop = logView.scrollHeight;
  });
  eventSource.addEventListener('status', (e) => setStatus(JSON.parse(e.data).running));
  eventSource.addEventListener('sessions', (e) => renderSessions(JSON.parse(e.data)));
  eventSource.addEventListener('tftp-status', (e) => setTftpStatus(JSON.parse(e.data).running));
  eventSource.addEventListener('stats', (e) => renderStats(JSON.parse(e.data)));
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------- Init ----------
async function initApp() {
  const status = await api.get('/api/server/status');
  setStatus(status.running);
  await loadServerSettings();
  await loadTftpSettings();
  await loadTftpFiles();
  await loadPortsTable();
  await loadUsersTable();
  renderSessions(await api.get('/api/sessions'));
  renderStats(await api.get('/api/stats'));
  await loadLogHistory();
  connectEvents();
}

boot();
