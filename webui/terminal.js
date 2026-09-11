'use strict';

const loginScreen = document.getElementById('loginScreen');
const totpScreen = document.getElementById('totpScreen');
const portPickerScreen = document.getElementById('portPickerScreen');
const terminalScreen = document.getElementById('terminalScreen');
const disabledScreen = document.getElementById('disabledScreen');

function showScreen(el) {
  [loginScreen, totpScreen, portPickerScreen, terminalScreen, disabledScreen].forEach((s) => s.classList.remove('active'));
  el.classList.add('active');
}

async function apiPost(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function apiGet(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function afterLogin(result) {
  if (result.needsPortSelection) {
    await showPortPicker();
  } else {
    connectTerminal();
  }
}

document.getElementById('terminalLoginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('terminalLoginError');
  errorEl.textContent = '';
  const username = document.getElementById('terminalUsername').value;
  const password = document.getElementById('terminalPassword').value;
  try {
    const result = await apiPost('/api/terminal/login', { username, password });
    document.getElementById('terminalPassword').value = '';
    if (result.needsTotp) {
      document.getElementById('terminalTotpCode').value = '';
      showScreen(totpScreen);
      return;
    }
    await afterLogin(result);
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

document.getElementById('terminalTotpForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('terminalTotpError');
  errorEl.textContent = '';
  try {
    const result = await apiPost('/api/terminal/login-totp', { token: document.getElementById('terminalTotpCode').value.trim() });
    await afterLogin(result);
  } catch (err) {
    errorEl.textContent = err.message === 'invalid_code' ? 'Wrong code. Try again.' : err.message;
    document.getElementById('terminalTotpCode').value = '';
    document.getElementById('terminalTotpCode').focus();
  }
});

async function showPortPicker() {
  const errorEl = document.getElementById('portPickerError');
  const listEl = document.getElementById('portList');
  errorEl.textContent = '';
  listEl.innerHTML = '';
  showScreen(portPickerScreen);
  try {
    const ports = await apiGet('/api/terminal/ports');
    if (ports.length === 0) {
      errorEl.textContent = 'No serial ports are available.';
      return;
    }
    for (const port of ports) {
      const btn = document.createElement('button');
      const clientsNote = port.clients ? ` — ${port.clients} connected` : '';
      btn.textContent = `${port.label}${port.present ? '' : ' — not present'}${clientsNote}`;
      btn.disabled = !port.present;
      btn.addEventListener('click', () => connectTerminal(port.id));
      listEl.appendChild(btn);
    }
  } catch (err) {
    errorEl.textContent = err.message;
  }
}

let ws = null;
let term = null;

function connectTerminal(portId) {
  showScreen(terminalScreen);
  const container = document.getElementById('xtermContainer');
  container.innerHTML = '';

  term = new Terminal({ cursorBlink: true, convertEol: true });
  term.open(container);
  term.write('Connecting...\r\n');

  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${window.location.host}/ws/terminal${portId ? `?portId=${encodeURIComponent(portId)}` : ''}`;
  ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';

  ws.addEventListener('open', () => {
    term.clear();
  });

  ws.addEventListener('message', (event) => {
    if (typeof event.data === 'string') {
      const msg = JSON.parse(event.data);
      if (msg.type === 'connected') {
        document.getElementById('terminalTitle').textContent = `Serial Console — ${msg.label}`;
      } else if (msg.type === 'error') {
        term.write(`\r\n\x1b[31m[${msg.message}]\x1b[0m\r\n`);
      }
      return;
    }
    term.write(new Uint8Array(event.data));
  });

  ws.addEventListener('close', () => {
    term.write('\r\n\x1b[33m[Disconnected]\x1b[0m\r\n');
  });

  ws.addEventListener('error', () => {
    term.write('\r\n\x1b[31m[Connection error]\x1b[0m\r\n');
  });

  term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(data));
  });
}

document.getElementById('terminalDisconnectBtn').addEventListener('click', async () => {
  if (ws) {
    ws.close();
    ws = null;
  }
  try {
    await apiPost('/api/terminal/logout');
  } catch {
    // best-effort — the session may already be gone
  }
  document.getElementById('terminalUsername').value = '';
  document.getElementById('terminalPassword').value = '';
  showScreen(loginScreen);
});

(async () => {
  try {
    const session = await apiGet('/api/terminal/session');
    if (!session.enabled) {
      showScreen(disabledScreen);
      return;
    }
    if (session.needsTotp) {
      showScreen(totpScreen);
      return;
    }
    if (session.authenticated) {
      if (session.needsPortSelection) {
        await showPortPicker();
      } else {
        connectTerminal();
      }
    }
  } catch {
    // stay on the login screen
  }
})();
