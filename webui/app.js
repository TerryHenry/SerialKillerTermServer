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

// Inline field validation, shared by the Port/User/Admin editor modals: fieldId is the
// input's own id, and it must have a sibling `<span class="field-error" id="{fieldId}Error">`.
function setFieldError(fieldId, message) {
  const errorEl = document.getElementById(`${fieldId}Error`);
  const inputEl = document.getElementById(fieldId);
  if (errorEl) errorEl.textContent = message;
  if (inputEl) inputEl.classList.toggle('invalid', !!message);
}
function clearFieldError(fieldId) {
  setFieldError(fieldId, '');
}

const setupScreen = document.getElementById('setupScreen');
const loginScreen = document.getElementById('loginScreen');
const forceChangeScreen = document.getElementById('forceChangeScreen');
const totpScreen = document.getElementById('totpScreen');
const appRoot = document.getElementById('appRoot');

// ---------- Auth bootstrap ----------
async function boot() {
  const session = await api.get('/api/session');
  if (session.needsSetup) {
    show(setupScreen);
    document.body.classList.remove('app-mode');
    return;
  }
  if (session.needsTotp) {
    show(totpScreen);
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

// Shared by the password-only login and the post-2FA login -- both return the same
// { mustChangePassword } shape once the session is actually established.
async function completeLogin(result) {
  if (result.mustChangePassword) {
    show(forceChangeScreen);
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
    if (result.needsTotp) {
      document.getElementById('totpCode').value = '';
      show(totpScreen);
      return;
    }
    await completeLogin(result);
  } catch (err) {
    errorEl.textContent = 'Invalid username or password.';
  }
});

document.getElementById('totpForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('totpError');
  errorEl.textContent = '';
  try {
    const result = await api.post('/api/login-totp', { token: document.getElementById('totpCode').value.trim() });
    hide(totpScreen);
    await completeLogin(result);
  } catch (err) {
    errorEl.textContent = err.message === 'invalid_code' ? 'Wrong code. Try again.' : err.message;
    document.getElementById('totpCode').value = '';
    document.getElementById('totpCode').focus();
  }
});

document.getElementById('forceChangeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('forceChangeError');
  errorEl.textContent = '';
  const password = document.getElementById('forceChangePassword').value;
  const confirmPassword = document.getElementById('forceChangePasswordConfirm').value;
  if (password !== confirmPassword) {
    errorEl.textContent = 'Passwords do not match.';
    return;
  }
  try {
    await api.post('/api/admin-password', { password });
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
  setWebTerminalStatus(config.webTerminal.enabled);
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

// ---------- Network ----------
let wifiRadioEnabled = false;

function renderNetworkInterfaces(interfaces) {
  const tbody = document.querySelector('#networkInterfacesTable tbody');
  const empty = document.getElementById('networkInterfacesEmpty');
  tbody.innerHTML = '';
  empty.style.display = interfaces.length ? 'none' : '';
  for (const iface of interfaces) {
    const tr = document.createElement('tr');
    const statusClass = iface.state === 'connected' ? 'pill ok' : 'pill mute';
    tr.innerHTML = `
      <td>${escapeHtml(iface.name)}</td>
      <td>${escapeHtml(iface.type)}</td>
      <td><span class="${statusClass}"><span class="dot"></span>${escapeHtml(iface.state)}</span></td>
      <td>${escapeHtml(iface.ip || '—')}</td>
      <td>${escapeHtml(iface.connection || '—')}</td>
    `;
    tbody.appendChild(tr);
  }
}

function setWifiRadioUi(state) {
  wifiRadioEnabled = state === 'enabled';
  const pill = document.getElementById('wifiRadioPill');
  const text = document.getElementById('wifiRadioText');
  const btn = document.getElementById('toggleWifiBtn');
  pill.classList.toggle('running', wifiRadioEnabled);
  text.textContent = state || 'Unknown';
  btn.textContent = wifiRadioEnabled ? 'Disable Wi-Fi' : 'Enable Wi-Fi';
  btn.disabled = state == null;
}

// Only marked done once we've actually populated it with a non-empty list, so a failed
// or empty fetch (e.g. timedatectl unavailable) retries on the next loadNetwork() call
// instead of leaving the picker permanently empty for the rest of the session.
let timezonesLoaded = false;

async function loadTimezoneList() {
  if (timezonesLoaded) return;
  const zones = await api.get('/api/network/timezones');
  document.getElementById('timezoneInput').innerHTML = zones
    .map((z) => `<option value="${escapeHtml(z)}">${escapeHtml(z)}</option>`)
    .join('');
  timezonesLoaded = zones.length > 0;
}

// A plain <select> (not <input list> + <datalist>) so the full list is always visible --
// a datalist filters its suggestions against whatever the input already contains, which
// with the current timezone pre-filled meant only that one zone ever showed up.
function setTimezoneUi(timezone) {
  const select = document.getElementById('timezoneInput');
  if (timezone && ![...select.options].some((o) => o.value === timezone)) {
    select.insertAdjacentHTML('afterbegin', `<option value="${escapeHtml(timezone)}">${escapeHtml(timezone)}</option>`);
  }
  select.value = timezone || '';
}

function setNtpSyncUi(synchronized) {
  const pill = document.getElementById('ntpSyncPill');
  const text = document.getElementById('ntpSyncText');
  pill.classList.toggle('running', synchronized === true);
  text.textContent = synchronized === true ? 'Synced' : synchronized === false ? 'Not synced' : 'Unknown';
}

async function loadNetwork() {
  const data = await api.get('/api/network');
  renderNetworkInterfaces(data.interfaces);
  document.getElementById('publicIpValue').textContent = data.publicIp || 'unavailable';
  setWifiRadioUi(data.wifiRadio);
  document.getElementById('ntpServer').value = data.ntp.server;
  setNtpSyncUi(data.ntp.synchronized);
  document.getElementById('dnsServers').value = data.dns.join(', ');
  await loadTimezoneList();
  setTimezoneUi(data.timezone);
  populateStaticIpDevices(data.interfaces);
  await loadStaticIpConfig();
}

document.getElementById('refreshNetworkBtn').addEventListener('click', () => loadNetwork());

// ---------- Static IP ----------
function prefixToMask(prefix) {
  const bits = '1'.repeat(prefix).padEnd(32, '0');
  return [0, 8, 16, 24].map((i) => parseInt(bits.slice(i, i + 8), 2)).join('.');
}

function populateStaticIpDevices(interfaces) {
  const select = document.getElementById('staticIpDevice');
  const previous = select.value;
  select.innerHTML = interfaces
    .map((i) => `<option value="${escapeHtml(i.name)}">${escapeHtml(i.name)} (${escapeHtml(i.type)})</option>`)
    .join('');
  if (previous && [...select.options].some((o) => o.value === previous)) {
    select.value = previous;
  }
}

async function loadStaticIpConfig() {
  const device = document.getElementById('staticIpDevice').value;
  const msg = document.getElementById('staticIpMsg');
  const pill = document.getElementById('staticIpModePill');
  const text = document.getElementById('staticIpModeText');
  msg.textContent = '';
  if (!device) {
    pill.classList.remove('running');
    text.textContent = '—';
    return;
  }
  try {
    const config = await api.get(`/api/network/interfaces/${encodeURIComponent(device)}/ip-config`);
    const isManual = config.method === 'manual';
    pill.classList.toggle('running', isManual);
    text.textContent = isManual ? 'Static' : 'DHCP';
    document.getElementById('staticIpAddress').value = config.address || '';
    document.getElementById('staticIpMask').value = config.prefix != null ? prefixToMask(config.prefix) : '';
    document.getElementById('staticIpGateway').value = config.gateway || '';
  } catch (err) {
    pill.classList.remove('running');
    text.textContent = '—';
    document.getElementById('staticIpAddress').value = '';
    document.getElementById('staticIpMask').value = '';
    document.getElementById('staticIpGateway').value = '';
    msg.textContent = err.message;
  }
}

document.getElementById('staticIpDevice').addEventListener('change', () => loadStaticIpConfig());

document.getElementById('saveStaticIpBtn').addEventListener('click', async () => {
  const device = document.getElementById('staticIpDevice').value;
  const msg = document.getElementById('staticIpMsg');
  msg.textContent = '';
  if (!device) {
    msg.style.color = 'var(--danger)';
    msg.textContent = 'Choose an interface first.';
    return;
  }
  const address = document.getElementById('staticIpAddress').value.trim();
  const mask = document.getElementById('staticIpMask').value.trim();
  const gateway = document.getElementById('staticIpGateway').value.trim();
  if (
    !confirm(
      `Set a static IP on ${device}? If anything here is wrong, this interface -- possibly including this admin UI, if you're reaching it through here -- could become unreachable until someone fixes it via SSH or the physical console.`
    )
  ) {
    return;
  }
  try {
    await api.post(`/api/network/interfaces/${encodeURIComponent(device)}/ip`, { address, mask, gateway });
    await loadStaticIpConfig();
    msg.style.color = 'var(--ok)';
    msg.textContent = 'Saved.';
  } catch (err) {
    msg.style.color = 'var(--danger)';
    msg.textContent = err.message;
  }
});

document.getElementById('clearStaticIpBtn').addEventListener('click', async () => {
  const device = document.getElementById('staticIpDevice').value;
  const msg = document.getElementById('staticIpMsg');
  msg.textContent = '';
  if (!device) return;
  if (!confirm(`Revert ${device} to DHCP?`)) return;
  try {
    await api.post(`/api/network/interfaces/${encodeURIComponent(device)}/ip/clear`);
    await loadStaticIpConfig();
    msg.style.color = 'var(--ok)';
    msg.textContent = 'Reverted to DHCP.';
  } catch (err) {
    msg.style.color = 'var(--danger)';
    msg.textContent = err.message;
  }
});

document.getElementById('toggleWifiBtn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const msgEl = document.getElementById('wifiMsg');
  msgEl.textContent = '';
  btn.disabled = true;
  try {
    await api.post(wifiRadioEnabled ? '/api/network/wifi/disable' : '/api/network/wifi/enable');
    await loadNetwork();
  } catch (err) {
    msgEl.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

function renderWifiScanResults(networks) {
  const tbody = document.querySelector('#wifiScanTable tbody');
  const empty = document.getElementById('wifiScanEmpty');
  tbody.innerHTML = '';
  empty.style.display = networks.length ? 'none' : '';
  for (const net of networks) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    const useBtn = document.createElement('button');
    useBtn.textContent = 'Use';
    useBtn.addEventListener('click', () => {
      document.getElementById('wifiConnectSsid').value = net.ssid;
      document.getElementById('wifiConnectPassword').focus();
    });
    td.appendChild(useBtn);
    tr.innerHTML = `
      <td>${escapeHtml(net.ssid)}</td>
      <td>${escapeHtml(String(net.signal))}%</td>
      <td>${escapeHtml(net.security || 'open')}</td>
    `;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

document.getElementById('scanWifiBtn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const msgEl = document.getElementById('wifiMsg');
  msgEl.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Scanning…';
  try {
    renderWifiScanResults(await api.get('/api/network/wifi/scan'));
  } catch (err) {
    msgEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Scan for Networks';
  }
});

document.getElementById('wifiConnectBtn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const msgEl = document.getElementById('wifiMsg');
  const ssid = document.getElementById('wifiConnectSsid').value.trim();
  const password = document.getElementById('wifiConnectPassword').value;
  msgEl.textContent = '';
  if (!ssid) {
    msgEl.textContent = 'SSID is required';
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Connecting…';
  try {
    await api.post('/api/network/wifi/connect', { ssid, password });
    document.getElementById('wifiConnectPassword').value = '';
    await loadNetwork();
  } catch (err) {
    msgEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect';
  }
});

document.getElementById('saveNtpBtn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const msgEl = document.getElementById('timeDnsMsg');
  msgEl.textContent = '';
  const server = document.getElementById('ntpServer').value.trim();
  if (!server) {
    msgEl.textContent = 'NTP server is required';
    return;
  }
  btn.disabled = true;
  try {
    await api.post('/api/network/ntp', { server });
    await loadNetwork();
  } catch (err) {
    msgEl.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('saveTimezoneBtn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const msgEl = document.getElementById('timeDnsMsg');
  msgEl.textContent = '';
  const timezone = document.getElementById('timezoneInput').value.trim();
  if (!timezone) {
    msgEl.textContent = 'Timezone is required';
    return;
  }
  btn.disabled = true;
  try {
    await api.post('/api/network/timezone', { timezone });
    await loadNetwork();
  } catch (err) {
    msgEl.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('saveDnsBtn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const msgEl = document.getElementById('timeDnsMsg');
  msgEl.textContent = '';
  btn.disabled = true;
  try {
    await api.post('/api/network/dns', { servers: document.getElementById('dnsServers').value });
    await loadNetwork();
  } catch (err) {
    msgEl.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('clearDnsBtn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const msgEl = document.getElementById('timeDnsMsg');
  msgEl.textContent = '';
  btn.disabled = true;
  try {
    await api.post('/api/network/dns', { servers: '' });
    await loadNetwork();
  } catch (err) {
    msgEl.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---------- Admin password ----------
document.getElementById('changeAdminPasswordBtn').addEventListener('click', async () => {
  const msg = document.getElementById('adminPasswordMsg');
  msg.textContent = '';
  const password = document.getElementById('newAdminPassword').value;
  const confirmPassword = document.getElementById('newAdminPasswordConfirm').value;
  if (password !== confirmPassword) {
    msg.style.color = 'var(--danger)';
    msg.textContent = 'Passwords do not match.';
    return;
  }
  try {
    await api.post('/api/admin-password', { password });
    document.getElementById('newAdminPassword').value = '';
    document.getElementById('newAdminPasswordConfirm').value = '';
    msg.style.color = 'var(--ok)';
    msg.textContent = 'Password updated.';
  } catch (err) {
    msg.style.color = 'var(--danger)';
    msg.textContent = err.message;
  }
});

// ---------- Pi system (Linux) account password ----------
document.getElementById('changeOsPasswordBtn').addEventListener('click', async () => {
  const msg = document.getElementById('osPasswordMsg');
  msg.textContent = '';
  const password = document.getElementById('osPassword').value;
  const confirmPassword = document.getElementById('osPasswordConfirm').value;
  if (password !== confirmPassword) {
    msg.style.color = 'var(--danger)';
    msg.textContent = 'Passwords do not match.';
    return;
  }
  try {
    await api.post('/api/os-password', { password });
    document.getElementById('osPassword').value = '';
    document.getElementById('osPasswordConfirm').value = '';
    msg.style.color = 'var(--ok)';
    msg.textContent = 'Password updated.';
  } catch (err) {
    msg.style.color = 'var(--danger)';
    msg.textContent = err.message;
  }
});

// ---------- Two-factor auth (My Account) ----------
function setTotpStatusUi(enabled) {
  const pill = document.getElementById('totpStatusPill');
  const text = document.getElementById('totpStatusText');
  pill.classList.toggle('running', enabled);
  text.textContent = enabled ? 'Enabled' : 'Disabled';
  document.getElementById('enableTotpBtn').hidden = enabled;
  document.getElementById('disableTotpBtn').hidden = !enabled;
  document.getElementById('totpSetupPanel').hidden = true;
  document.getElementById('totpDisablePanel').hidden = true;
}

async function loadTotpStatus() {
  const session = await api.get('/api/session');
  setTotpStatusUi(!!session.totpEnabled);
}

document.getElementById('enableTotpBtn').addEventListener('click', async () => {
  const msg = document.getElementById('totpSetupMsg');
  msg.textContent = '';
  try {
    const { secret, otpauthUrl } = await api.post('/api/admin-2fa/setup');
    document.getElementById('totpSecretText').textContent = secret;
    document.getElementById('totpConfirmCode').value = '';
    window.renderTotpQr(document.getElementById('totpQrContainer'), otpauthUrl);
    document.getElementById('totpSetupPanel').hidden = false;
    document.getElementById('totpDisablePanel').hidden = true;
  } catch (err) {
    msg.textContent = err.message;
  }
});

document.getElementById('cancelTotpSetupBtn').addEventListener('click', () => {
  document.getElementById('totpSetupPanel').hidden = true;
  document.getElementById('totpSetupMsg').textContent = '';
});

document.getElementById('confirmTotpBtn').addEventListener('click', async () => {
  const msg = document.getElementById('totpSetupMsg');
  msg.textContent = '';
  const token = document.getElementById('totpConfirmCode').value.trim();
  try {
    await api.post('/api/admin-2fa/confirm', { token });
    await loadTotpStatus();
    await loadAdminsTable();
    msg.style.color = 'var(--ok)';
    msg.textContent = 'Two-factor authentication is now enabled.';
  } catch (err) {
    msg.style.color = 'var(--danger)';
    msg.textContent = err.message;
  }
});

document.getElementById('disableTotpBtn').addEventListener('click', () => {
  document.getElementById('totpDisableCode').value = '';
  document.getElementById('totpDisablePanel').hidden = false;
  document.getElementById('totpSetupPanel').hidden = true;
});

document.getElementById('cancelTotpDisableBtn').addEventListener('click', () => {
  document.getElementById('totpDisablePanel').hidden = true;
  document.getElementById('totpSetupMsg').textContent = '';
});

document.getElementById('confirmDisableTotpBtn').addEventListener('click', async () => {
  const msg = document.getElementById('totpSetupMsg');
  msg.textContent = '';
  const token = document.getElementById('totpDisableCode').value.trim();
  try {
    await api.post('/api/admin-2fa/disable', { token });
    await loadTotpStatus();
    await loadAdminsTable();
    msg.style.color = 'var(--ok)';
    msg.textContent = 'Two-factor authentication is now disabled.';
  } catch (err) {
    msg.style.color = 'var(--danger)';
    msg.textContent = err.message;
  }
});

// ---------- Admin accounts ----------
async function loadMyUsername() {
  const session = await api.get('/api/session');
  document.getElementById('myUsername').textContent = session.username || '';
}

async function loadAdminsTable() {
  const admins = await api.get('/api/admins');
  admins.sort((a, b) => a.username.localeCompare(b.username, undefined, { sensitivity: 'base' }));
  const tbody = document.querySelector('#adminsTable tbody');
  tbody.innerHTML = '';
  for (const a of admins) {
    const tr = document.createElement('tr');
    const statusPill = a.mustChangePassword
      ? '<span class="pill mute"><span class="dot"></span>Must change password</span>'
      : '<span class="pill ok"><span class="dot"></span>Active</span>';
    const totpPill = a.totpEnabled
      ? '<span class="pill ok"><span class="dot"></span>On</span>'
      : '<span class="pill mute"><span class="dot"></span>Off</span>';
    tr.innerHTML = `
      <td>${escapeHtml(a.username)}${a.isSelf ? ' <span class="hint">(you)</span>' : ''}</td>
      <td>${statusPill}</td>
      <td>${totpPill}</td>
      <td>${formatLastLogin(a.lastLoginAt)}</td>
      <td></td>
    `;
    const actionsCell = tr.lastElementChild;
    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => openAdminModal(a));
    actionsCell.appendChild(editBtn);
    if (!a.isSelf) {
      const delBtn = document.createElement('button');
      delBtn.textContent = 'Delete';
      delBtn.className = 'danger';
      delBtn.style.marginLeft = '6px';
      delBtn.addEventListener('click', async () => {
        if (confirm(`Delete admin account "${a.username}"?`)) {
          try {
            await api.del(`/api/admins/${a.id}`);
            await loadAdminsTable();
          } catch (err) {
            alert(err.message);
          }
        }
      });
      actionsCell.appendChild(delBtn);
    }
    tbody.appendChild(tr);
  }
}

function openAdminModal(admin) {
  document.getElementById('adminModalTitle').textContent = admin ? 'Edit Admin' : 'Add Admin';
  document.getElementById('adminId').value = admin?.id || '';
  document.getElementById('adminUsername').value = admin?.username || '';
  document.getElementById('adminPassword').value = '';
  document.getElementById('adminPasswordConfirm').value = '';
  document.getElementById('adminPasswordHint').style.display = admin ? 'inline' : 'none';
  clearFieldError('adminUsername');
  clearFieldError('adminPassword');
  document.getElementById('adminModalBackdrop').classList.add('open');
}

function closeAdminModal() {
  document.getElementById('adminModalBackdrop').classList.remove('open');
}

document.getElementById('addAdminBtn').addEventListener('click', () => openAdminModal(null));
document.getElementById('cancelAdminBtn').addEventListener('click', closeAdminModal);
document.getElementById('adminUsername').addEventListener('input', () => clearFieldError('adminUsername'));
document.getElementById('adminPassword').addEventListener('input', () => clearFieldError('adminPassword'));

document.getElementById('saveAdminBtn').addEventListener('click', async () => {
  const id = document.getElementById('adminId').value;
  const username = document.getElementById('adminUsername').value.trim();
  const password = document.getElementById('adminPassword').value;
  const confirmPassword = document.getElementById('adminPasswordConfirm').value;
  let valid = true;
  if (!username) {
    setFieldError('adminUsername', 'Username is required.');
    valid = false;
  }
  if (!id && !password) {
    setFieldError('adminPassword', 'A password is required for a new admin.');
    valid = false;
  }
  if (password && password.length < 8) {
    setFieldError('adminPassword', 'Password must be at least 8 characters.');
    valid = false;
  }
  if (password && password !== confirmPassword) {
    setFieldError('adminPassword', 'Passwords do not match.');
    valid = false;
  }
  if (!valid) return;
  try {
    if (id) {
      await api.post(`/api/admins/${id}`, { username, password: password || undefined });
    } else {
      await api.post('/api/admins', { username, password });
    }
    closeAdminModal();
    await loadAdminsTable();
    await loadMyUsername();
  } catch (err) {
    setFieldError('adminUsername', err.message);
  }
});

// ---------- Backup / restore ----------
document.getElementById('downloadBackupBtn').addEventListener('click', () => {
  const includeHostKey = document.getElementById('includeHostKeyOnBackup').checked;
  window.location.href = `/api/backup${includeHostKey ? '?includeHostKey=1' : ''}`;
});

document.getElementById('restoreBtn').addEventListener('click', () => {
  document.getElementById('restoreInput').click();
});

document.getElementById('restoreInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const msg = document.getElementById('restoreMsg');
  msg.style.color = 'var(--danger)';
  msg.textContent = '';
  if (!confirm('This replaces all current settings, serial ports, and users with the contents of the backup file. Continue?')) {
    return;
  }
  const formData = new FormData();
  formData.append('file', file);
  try {
    const res = await fetch('/api/restore', { method: 'POST', body: formData });
    if (!res.ok) throw await apiError(res);
    const result = await res.json();
    let message = result.hostKeyRestored
      ? 'Restore complete, including the SSH host key (takes effect after the service restarts).'
      : 'Restore complete.';
    if (result.systemSettingsWarnings && result.systemSettingsWarnings.length) {
      message += `\n\nEverything else restored, but these system settings need a look:\n${result.systemSettingsWarnings.join('\n')}`;
    }
    alert(`${message} Reloading.`);
    window.location.reload();
  } catch (err) {
    msg.textContent = err.message;
  }
});

// ---------- Ports ----------
async function loadPortsTable() {
  const ports = await api.get('/api/ports');
  ports.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
  const tbody = document.querySelector('#portsTable tbody');
  tbody.innerHTML = '';
  let statsById = {};
  try {
    statsById = Object.fromEntries((await api.get('/api/stats')).ports.map((p) => [p.id, p]));
  } catch {
    // stats are a nice-to-have here; an empty table just shows no counters
  }
  for (const p of ports) {
    const tr = document.createElement('tr');
    const stats = statsById[p.id];
    const trafficText = stats ? `${formatBytes(stats.rxBytes)} / ${formatBytes(stats.txBytes)}` : '&mdash;';
    const capturePill = p.captureEnabled
      ? '<span class="pill ok"><span class="dot"></span>On</span>'
      : '<span class="pill mute"><span class="dot"></span>Off</span>';
    tr.innerHTML = `
      <td>${escapeHtml(p.label)}</td>
      <td>${escapeHtml(p.path)}</td>
      <td>${p.baudRate}</td>
      <td>${p.dataBits}/${p.stopBits}/${p.parity}</td>
      <td>${accessPill(p.access)}</td>
      <td>${capturePill}</td>
      <td>${trafficText}</td>
      <td></td>
    `;
    const actionsCell = tr.lastElementChild;
    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => openPortModal(p));
    const debugBtn = document.createElement('button');
    debugBtn.textContent = 'Debug';
    debugBtn.className = 'secondary';
    debugBtn.style.marginLeft = '6px';
    debugBtn.addEventListener('click', () => openTrafficModal(p));
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
    actionsCell.appendChild(debugBtn);
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

function accessPill(access) {
  const cls = access && access !== 'exclusive' ? 'accent' : 'mute';
  return `<span class="pill ${cls}"><span class="dot"></span>${accessLabel(access)}</span>`;
}

function formatLastLogin(iso) {
  return iso ? new Date(iso).toLocaleString() : '<span class="hint">Never</span>';
}

function permissionPill(permission) {
  const readOnly = permission === 'read-only';
  return `<span class="pill ${readOnly ? 'mute' : 'ok'}"><span class="dot"></span>${readOnly ? 'Read-only' : 'Read/write'}</span>`;
}

let editingPortPath = null;

async function refreshSystemPortsDatalist() {
  const [systemPorts, configuredPorts] = await Promise.all([
    api.get('/api/ports/system'),
    api.get('/api/ports')
  ]);
  // Don't offer a device path that's already assigned to a different configured
  // port — but keep showing the path of the port currently being edited, since
  // that's still its own path, not a conflict.
  const assignedPaths = new Set(
    configuredPorts.filter((p) => p.path !== editingPortPath).map((p) => p.path)
  );
  const list = document.getElementById('systemPortsList');
  list.innerHTML = '';
  for (const p of systemPorts) {
    if (assignedPaths.has(p.path)) continue;
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
  document.getElementById('portCapture').checked = !!port?.captureEnabled;
  editingPortPath = port?.path || null;
  clearFieldError('portLabel');
  clearFieldError('portPath');
  refreshSystemPortsDatalist();
  document.getElementById('portModalBackdrop').classList.add('open');
}

function closePortModal() {
  document.getElementById('portModalBackdrop').classList.remove('open');
}

document.getElementById('addPortBtn').addEventListener('click', () => openPortModal(null));
document.getElementById('cancelPortBtn').addEventListener('click', closePortModal);
document.getElementById('refreshSystemPortsBtn').addEventListener('click', refreshSystemPortsDatalist);

document.getElementById('portLabel').addEventListener('input', () => clearFieldError('portLabel'));
document.getElementById('portPath').addEventListener('input', () => clearFieldError('portPath'));

document.getElementById('savePortBtn').addEventListener('click', async () => {
  const label = document.getElementById('portLabel').value.trim();
  const devPath = document.getElementById('portPath').value.trim();
  let valid = true;
  if (!label) {
    setFieldError('portLabel', 'A label is required.');
    valid = false;
  }
  if (!devPath) {
    setFieldError('portPath', 'A device path is required.');
    valid = false;
  }
  if (!valid) return;
  const port = {
    id: document.getElementById('portId').value || undefined,
    label,
    path: devPath,
    baudRate: Number(document.getElementById('portBaud').value),
    dataBits: Number(document.getElementById('portDataBits').value),
    stopBits: Number(document.getElementById('portStopBits').value),
    parity: document.getElementById('portParity').value,
    rtscts: document.getElementById('portRtscts').checked,
    access: document.getElementById('portAccess').value,
    captureEnabled: document.getElementById('portCapture').checked
  };
  await api.post('/api/ports', port);
  closePortModal();
  await loadPortsTable();
  await refreshUserDefaultPortOptions();
});

// ---------- Live traffic debug ----------
let trafficSocket = null;

function closeTrafficModal() {
  document.getElementById('trafficModalBackdrop').classList.remove('open');
  if (trafficSocket) {
    trafficSocket.close();
    trafficSocket = null;
  }
}

function openTrafficModal(port) {
  document.getElementById('trafficModalTitle').textContent = `Traffic Debug — ${port.label}`;
  const view = document.getElementById('trafficView');
  view.textContent = '';
  document.getElementById('trafficModalBackdrop').classList.add('open');

  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  trafficSocket = new WebSocket(`${proto}//${window.location.host}/ws/traffic?portId=${encodeURIComponent(port.id)}`);
  trafficSocket.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type !== 'traffic') return;
    const time = new Date(msg.ts).toLocaleTimeString();
    const dir = msg.direction === 'rx' ? 'RX' : 'TX';
    view.textContent += `[${time}] ${dir}  ${(msg.hex.match(/.{1,2}/g) || []).join(' ')}   ${msg.ascii}\n`;
    view.scrollTop = view.scrollHeight;
  });
}

document.getElementById('clearTrafficBtn').addEventListener('click', () => {
  document.getElementById('trafficView').textContent = '';
});
document.getElementById('closeTrafficBtn').addEventListener('click', closeTrafficModal);

// ---------- Web Console (HTTPS-to-Serial) ----------
let webTerminalEnabled = false;

// Same host/port as this admin UI -- it's the same HTTPS server, just a different path.
document.getElementById('webTerminalInfoIcon').title =
  `Once enabled, reach it at ${window.location.origin}/terminal`;

function setWebTerminalStatus(enabled) {
  webTerminalEnabled = enabled;
  const pill = document.getElementById('webTerminalStatusPill');
  const text = document.getElementById('webTerminalStatusText');
  const btn = document.getElementById('toggleWebTerminalBtn');
  pill.classList.toggle('running', enabled);
  text.textContent = enabled ? 'Enabled' : 'Disabled';
  btn.textContent = enabled ? 'Disable' : 'Enable';
}

document.getElementById('toggleWebTerminalBtn').addEventListener('click', async () => {
  const result = await api.post('/api/webterminal-settings', { enabled: !webTerminalEnabled });
  setWebTerminalStatus(result.enabled);
});

// ---------- Users ----------

async function loadUsersTable() {
  const users = await api.get('/api/users');
  users.sort((a, b) => a.username.localeCompare(b.username, undefined, { sensitivity: 'base' }));
  const ports = await api.get('/api/ports');
  const portById = Object.fromEntries(ports.map((p) => [p.id, p.label]));
  const tbody = document.querySelector('#usersTable tbody');
  tbody.innerHTML = '';
  for (const u of users) {
    const tr = document.createElement('tr');
    const totpPill = u.totpEnabled
      ? '<span class="pill ok"><span class="dot"></span>On</span>'
      : '<span class="pill mute"><span class="dot"></span>Off</span>';
    tr.innerHTML = `
      <td>${escapeHtml(u.username)}</td>
      <td>${escapeHtml(u.authMethod)}</td>
      <td>${permissionPill(u.permission)}</td>
      <td>${u.defaultPortId ? escapeHtml(portById[u.defaultPortId] || '(deleted port)') : '<span class="hint">port menu</span>'}</td>
      <td>${totpPill}</td>
      <td>${formatLastLogin(u.lastLoginAt)}</td>
      <td></td>
    `;
    const actionsCell = tr.lastElementChild;
    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => openUserModal(u));
    const totpBtn = document.createElement('button');
    totpBtn.textContent = u.totpEnabled ? 'Disable 2FA' : 'Enable 2FA';
    totpBtn.style.marginLeft = '6px';
    totpBtn.addEventListener('click', () => (u.totpEnabled ? disableUserTotp(u) : openUserTotpModal(u)));
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
    actionsCell.appendChild(totpBtn);
    actionsCell.appendChild(delBtn);
    tbody.appendChild(tr);
  }
}

// ---------- Per-user two-factor auth (admin-managed) ----------
async function openUserTotpModal(user) {
  const msg = document.getElementById('userTotpSetupMsg');
  msg.textContent = '';
  document.getElementById('userTotpUsername').textContent = user.username;
  document.getElementById('userTotpConfirmCode').value = '';
  try {
    const { secret, otpauthUrl } = await api.post(`/api/users/${user.id}/2fa/setup`);
    document.getElementById('userTotpSecretText').textContent = secret;
    window.renderTotpQr(document.getElementById('userTotpQrContainer'), otpauthUrl);
    document.getElementById('userTotpModalBackdrop').dataset.userId = user.id;
    document.getElementById('userTotpModalBackdrop').classList.add('open');
  } catch (err) {
    alert(err.message);
  }
}

document.getElementById('cancelUserTotpBtn').addEventListener('click', () => {
  document.getElementById('userTotpModalBackdrop').classList.remove('open');
});

document.getElementById('confirmUserTotpBtn').addEventListener('click', async () => {
  const msg = document.getElementById('userTotpSetupMsg');
  msg.textContent = '';
  const userId = document.getElementById('userTotpModalBackdrop').dataset.userId;
  const token = document.getElementById('userTotpConfirmCode').value.trim();
  try {
    await api.post(`/api/users/${userId}/2fa/confirm`, { token });
    document.getElementById('userTotpModalBackdrop').classList.remove('open');
    await loadUsersTable();
  } catch (err) {
    msg.textContent = err.message;
  }
});

async function disableUserTotp(user) {
  if (!confirm(`Disable two-factor authentication for "${user.username}"?`)) return;
  try {
    await api.post(`/api/users/${user.id}/2fa/disable`);
    await loadUsersTable();
  } catch (err) {
    alert(err.message);
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
  document.getElementById('userPasswordConfirm').value = '';
  document.getElementById('userPublicKey').value = user?.publicKey || '';
  document.getElementById('userPermission').value = user?.permission || 'read-write';
  await refreshUserDefaultPortOptions(user?.defaultPortId);
  updateAuthMethodVisibility();
  clearFieldError('userUsername');
  clearFieldError('userPassword');
  clearFieldError('userPublicKey');
  document.getElementById('userModalBackdrop').classList.add('open');
}

function closeUserModal() {
  document.getElementById('userModalBackdrop').classList.remove('open');
}

document.getElementById('downloadUserTemplateBtn').addEventListener('click', () => {
  const template =
    'username,password,authMethod,permission,defaultPort,publicKey\n' +
    'alice,changeme123,password,read-write,,\n' +
    'bob,,publickey,read-only,,"ssh-ed25519 AAAA... bob@laptop"\n';
  const blob = new Blob([template], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'users-template.csv';
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById('importUsersBtn').addEventListener('click', () => {
  document.getElementById('importUsersInput').click();
});

document.getElementById('importUsersInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const msg = document.getElementById('importUsersMsg');
  msg.textContent = '';
  const formData = new FormData();
  formData.append('file', file);
  try {
    const res = await fetch('/api/users/import', { method: 'POST', body: formData });
    if (!res.ok) throw await apiError(res);
    const result = await res.json();
    let summary = `Imported ${result.created.length} user${result.created.length === 1 ? '' : 's'}.`;
    if (result.skipped.length) {
      summary +=
        `\n\nSkipped ${result.skipped.length}:\n` +
        result.skipped.map((s) => `Row ${s.row} (${s.username}): ${s.reason}`).join('\n');
    }
    alert(summary);
    await loadUsersTable();
  } catch (err) {
    msg.textContent = err.message;
  }
});

document.getElementById('addUserBtn').addEventListener('click', () => openUserModal(null));
document.getElementById('cancelUserBtn').addEventListener('click', closeUserModal);
document.getElementById('userUsername').addEventListener('input', () => clearFieldError('userUsername'));
document.getElementById('userPassword').addEventListener('input', () => clearFieldError('userPassword'));
document.getElementById('userPublicKey').addEventListener('input', () => clearFieldError('userPublicKey'));

document.getElementById('saveUserBtn').addEventListener('click', async () => {
  const username = document.getElementById('userUsername').value.trim();
  const authMethod = document.getElementById('userAuthMethod').value;
  const password = document.getElementById('userPassword').value;
  const confirmPassword = document.getElementById('userPasswordConfirm').value;
  const publicKey = document.getElementById('userPublicKey').value.trim();
  const existingId = document.getElementById('userId').value;

  let valid = true;
  if (!username) {
    setFieldError('userUsername', 'Username is required.');
    valid = false;
  }
  if (authMethod !== 'publickey' && !password && !existingId) {
    setFieldError('userPassword', 'A password is required for a new user using password authentication.');
    valid = false;
  }
  if (password && password !== confirmPassword) {
    setFieldError('userPassword', 'Passwords do not match.');
    valid = false;
  }
  if (authMethod !== 'password' && !publicKey) {
    setFieldError('userPublicKey', 'A public key is required for public-key authentication.');
    valid = false;
  }
  if (!valid) return;

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
function methodPill(method) {
  const isHttps = method === 'https';
  return `<span class="pill ${isHttps ? 'accent' : 'mute'}"><span class="dot"></span>${isHttps ? 'HTTPS' : 'SSH'}</span>`;
}

function renderSessions(sessions) {
  const tbody = document.querySelector('#sessionsTable tbody');
  tbody.innerHTML = '';
  for (const s of sessions) {
    const tr = document.createElement('tr');
    const since = new Date(s.connectedAt).toLocaleTimeString();
    tr.innerHTML = `
      <td>${escapeHtml(s.username)}</td>
      <td>${methodPill(s.method)}</td>
      <td>${s.portLabel ? escapeHtml(s.portLabel) : '<span class="hint">at menu</span>'}</td>
      <td>${since}</td>
      <td>${permissionPill(s.permission)}</td>
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
function formatUptime(seconds) {
  seconds = Math.floor(seconds || 0);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (days || hours) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(' ');
}

// ---------- System ----------
async function loadSystemInfo() {
  const info = await api.get('/api/system/info');
  document.getElementById('systemHostname').value = info.hostname;
  document.getElementById('infoOsRelease').textContent = info.osRelease || 'Unknown';
  document.getElementById('infoKernel').textContent = info.kernel;
  document.getElementById('infoArch').textContent = info.arch;
  document.getElementById('infoCpu').textContent = `${info.cpuModel} (${info.cpuCores} core${info.cpuCores === 1 ? '' : 's'})`;
  document.getElementById('infoMemory').textContent = formatBytes(info.totalMemory);
  document.getElementById('infoDisk').textContent = info.disk
    ? `${formatBytes(info.disk.used)} / ${formatBytes(info.disk.total)} used (${info.disk.mount})`
    : 'Unknown';
  document.getElementById('infoNode').textContent = info.nodeVersion;
  document.getElementById('infoAppVersion').textContent = info.appVersion;
}

document.getElementById('refreshSystemInfoBtn').addEventListener('click', () => loadSystemInfo().catch((err) => alert(err.message)));

document.getElementById('saveHostnameBtn').addEventListener('click', async () => {
  const msg = document.getElementById('systemControlMsg');
  msg.textContent = '';
  const hostname = document.getElementById('systemHostname').value.trim();
  try {
    await api.post('/api/system/hostname', { hostname });
    msg.style.color = 'var(--ok)';
    msg.textContent = 'Hostname updated.';
  } catch (err) {
    msg.style.color = 'var(--danger)';
    msg.textContent = err.message;
  }
});

document.getElementById('rebootBtn').addEventListener('click', async () => {
  if (!confirm('Reboot the Pi now? All active SSH and web console sessions will be dropped immediately.')) return;
  const msg = document.getElementById('systemControlMsg');
  msg.style.color = 'var(--text-dim)';
  msg.textContent = 'Rebooting…';
  try {
    await api.post('/api/system/reboot');
    const backUp = await pollUntilBackUp(() => {
      msg.textContent = 'Waiting for the Pi to come back...';
    });
    if (backUp) {
      msg.style.color = 'var(--ok)';
      msg.textContent = 'Back up. Reloading…';
      setTimeout(() => window.location.reload(), 1000);
    } else {
      msg.style.color = 'var(--danger)';
      msg.textContent = 'Did not come back within 3 minutes — check on it directly.';
    }
  } catch (err) {
    msg.style.color = 'var(--danger)';
    msg.textContent = err.message;
  }
});

// ---------- Session captures ----------
async function loadCapturesTable() {
  const captures = await api.get('/api/captures');
  const tbody = document.querySelector('#capturesTable tbody');
  const empty = document.getElementById('capturesEmpty');
  tbody.innerHTML = '';
  empty.style.display = captures.length ? 'none' : 'block';
  for (const c of captures) {
    const tr = document.createElement('tr');
    const nameCell = document.createElement('td');
    const link = document.createElement('a');
    link.href = `/api/captures/${encodeURIComponent(c.name)}`;
    link.textContent = c.name;
    nameCell.appendChild(link);
    tr.appendChild(nameCell);
    const sizeCell = document.createElement('td');
    sizeCell.textContent = formatBytes(c.size);
    tr.appendChild(sizeCell);
    const modCell = document.createElement('td');
    modCell.textContent = new Date(c.modifiedAt).toLocaleString();
    tr.appendChild(modCell);
    const actionsCell = document.createElement('td');
    tr.appendChild(actionsCell);
    const delBtn = document.createElement('button');
    delBtn.textContent = 'Delete';
    delBtn.className = 'danger';
    delBtn.style.marginLeft = '6px';
    delBtn.addEventListener('click', async () => {
      if (confirm(`Delete capture "${c.name}"?`)) {
        await api.del(`/api/captures/${encodeURIComponent(c.name)}`);
        await loadCapturesTable();
      }
    });
    actionsCell.appendChild(delBtn);
    tbody.appendChild(tr);
  }
}

document.getElementById('refreshCapturesBtn').addEventListener('click', () => loadCapturesTable());

// ---------- External syslog server ----------
async function loadSyslogSettings() {
  const syslog = await api.get('/api/syslog');
  document.getElementById('syslogEnabled').checked = syslog.enabled;
  document.getElementById('syslogHost').value = syslog.host;
  document.getElementById('syslogPort').value = syslog.port;
  document.getElementById('syslogFacility').value = String(syslog.facility);
}

document.getElementById('saveSyslogBtn').addEventListener('click', async () => {
  const msg = document.getElementById('syslogMsg');
  msg.textContent = '';
  try {
    await api.post('/api/syslog', {
      enabled: document.getElementById('syslogEnabled').checked,
      host: document.getElementById('syslogHost').value.trim(),
      port: Number(document.getElementById('syslogPort').value) || 514,
      facility: Number(document.getElementById('syslogFacility').value)
    });
    msg.style.color = 'var(--ok)';
    msg.textContent = 'Saved.';
  } catch (err) {
    msg.style.color = 'var(--danger)';
    msg.textContent = err.message;
  }
});

document.getElementById('testSyslogBtn').addEventListener('click', async () => {
  const msg = document.getElementById('syslogMsg');
  msg.textContent = '';
  try {
    await api.post('/api/syslog/test');
    msg.style.color = 'var(--ok)';
    msg.textContent = 'Test message sent.';
  } catch (err) {
    msg.style.color = 'var(--danger)';
    msg.textContent = err.message;
  }
});

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
  document.getElementById('systemUptime').textContent = formatUptime(stats.uptimeSec);

  const tbody = document.querySelector('#portStatusTable tbody');
  const empty = document.getElementById('portStatusEmpty');
  tbody.innerHTML = '';
  empty.style.display = stats.ports.length ? 'none' : 'block';
  for (const p of stats.ports) {
    const tr = document.createElement('tr');
    const statusPill = p.present
      ? '<span class="status-pill inline running"><span class="dot"></span>Present</span>'
      : '<span class="status-pill inline missing"><span class="dot"></span>Missing</span>';
    tr.innerHTML = `
      <td>${escapeHtml(p.label)}</td>
      <td>${escapeHtml(p.path)}</td>
      <td>${statusPill}</td>
      <td>${p.clients}</td>
    `;
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

// ---------- Version / updates ----------
async function loadVersion() {
  const { version } = await api.get('/api/version');
  document.getElementById('aboutVersion').textContent = version;
}

document.getElementById('checkUpdateBtn').addEventListener('click', async () => {
  const statusEl = document.getElementById('updateStatus');
  const btn = document.getElementById('checkUpdateBtn');
  const applyBtn = document.getElementById('applyUpdateBtn');
  btn.disabled = true;
  applyBtn.hidden = true;
  statusEl.style.color = 'var(--text-dim)';
  statusEl.textContent = 'Checking…';
  try {
    const result = await api.get('/api/check-update');
    if (!result.found) {
      statusEl.style.color = 'var(--text-dim)';
      statusEl.textContent = 'No releases found yet.';
    } else if (result.upToDate) {
      statusEl.style.color = 'var(--ok)';
      statusEl.textContent = `Up to date (${result.currentVersion}).`;
    } else {
      statusEl.style.color = 'var(--accent-hover)';
      statusEl.innerHTML = `Update available: <a href="${escapeHtml(result.url)}" target="_blank" rel="noopener">${escapeHtml(result.latestVersion)}</a> (you're on ${escapeHtml(result.currentVersion)}).`;
      if (result.canApplyInPlace) {
        applyBtn.hidden = false;
        applyBtn.dataset.targetVersion = result.latestVersion;
      } else {
        statusEl.innerHTML += ' <span class="hint">(no in-place update package published for this release — re-flash to install it.)</span>';
      }
    }
  } catch (err) {
    statusEl.style.color = 'var(--danger)';
    statusEl.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---------- Apply update / rollback ----------
async function loadUpdateStatus() {
  const status = await api.get('/api/update/status');
  document.getElementById('rollbackUpdateBtn').hidden = !status.hasBackup;
}

/** Polls a no-auth endpoint until it responds, since the service restart this waits out
 * also invalidates the in-memory session -- a 401 from an authenticated endpoint would
 * look identical to "still down." */
async function pollUntilBackUp(onTick, timeoutMs = 3 * 60 * 1000) {
  const start = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 5000));
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch('/api/session', { cache: 'no-store' });
      if (res.ok) return true;
    } catch {
      // expected while the service is mid-restart
    }
    onTick();
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return false;
}

async function runUpdateAction(apiPath, confirmMessage, startingMessage) {
  if (!confirm(confirmMessage)) return;
  const progressEl = document.getElementById('updateProgress');
  const applyBtn = document.getElementById('applyUpdateBtn');
  const rollbackBtn = document.getElementById('rollbackUpdateBtn');
  applyBtn.disabled = true;
  rollbackBtn.disabled = true;
  progressEl.style.color = 'var(--text-dim)';
  progressEl.textContent = startingMessage;
  try {
    await api.post(apiPath);
  } catch (err) {
    progressEl.style.color = 'var(--danger)';
    progressEl.textContent = err.message;
    applyBtn.disabled = false;
    rollbackBtn.disabled = false;
    return;
  }
  progressEl.textContent = 'In progress -- watch the Log tab for details. This page will lose its connection when the service restarts, then reconnect on its own.';
  const backUp = await pollUntilBackUp(() => {
    progressEl.textContent = 'Waiting for the service to come back...';
  });
  if (backUp) {
    progressEl.style.color = 'var(--ok)';
    progressEl.textContent = 'Service is back. Reloading…';
    setTimeout(() => window.location.reload(), 1000);
  } else {
    progressEl.style.color = 'var(--danger)';
    progressEl.textContent =
      'The service did not come back within 3 minutes. SSH in on port 22 and run "systemctl status terminalserver", or "sudo bash /opt/terminalserver/provisioning/rollback-update.sh" to restore the previous version.';
    applyBtn.disabled = false;
    rollbackBtn.disabled = false;
  }
}

document.getElementById('applyUpdateBtn').addEventListener('click', () => {
  const target = document.getElementById('applyUpdateBtn').dataset.targetVersion || 'the latest version';
  runUpdateAction(
    '/api/update/apply',
    `This downloads and applies ${target}, then restarts the service. All active SSH and web console sessions will briefly disconnect. Continue?`,
    'Starting update…'
  );
});

document.getElementById('rollbackUpdateBtn').addEventListener('click', () => {
  runUpdateAction(
    '/api/update/rollback',
    'Roll back to the previous version? This restarts the service and briefly disconnects active sessions.',
    'Starting rollback…'
  );
});

// ---------- Init ----------
async function initApp() {
  const status = await api.get('/api/server/status');
  setStatus(status.running);
  await loadServerSettings();
  await loadNetwork();
  await loadTftpSettings();
  await loadTftpFiles();
  await loadPortsTable();
  await loadUsersTable();
  await loadMyUsername();
  await loadAdminsTable();
  await loadTotpStatus();
  await loadVersion();
  await loadUpdateStatus();
  await loadSystemInfo();
  await loadCapturesTable();
  await loadSyslogSettings();
  renderSessions(await api.get('/api/sessions'));
  renderStats(await api.get('/api/stats'));
  await loadLogHistory();
  connectEvents();
}

boot();
