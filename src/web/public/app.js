/* Nectar Dashboard — vanilla JS SPA */

const API = '/api';
let releases = [];
let ws = null;

// ── DOM refs ────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const connStatus = $('#connStatus');
const releaseList = $('#releaseList');
const releaseDetail = $('#releaseDetail');
const customerMap = $('#customerMap');
const filterState = $('#filterState');
const newReleaseModal = $('#newReleaseModal');

// ── Navigation ──────────────────────────────────────────────
let currentView = 'releases';
let selectedVersion = null;

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    showView(btn.dataset.view);
  });
});

function showView(view) {
  currentView = view;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  if (view === 'detail') {
    $('#view-detail').classList.add('active');
  } else {
    $(`#view-${view}`).classList.add('active');
  }
  if (view === 'customers') loadCustomers();
}

$('#btnBack').addEventListener('click', () => {
  selectedVersion = null;
  showView('releases');
});

// ── WebSocket ───────────────────────────────────────────────
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => {
    connStatus.textContent = 'connected';
    connStatus.className = 'connection-status connected';
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === 'init') {
      releases = msg.releases;
      renderReleaseList();
      return;
    }

    if (msg.type === 'release:created') {
      releases.unshift(msg.release);
      renderReleaseList();
      return;
    }

    if (msg.type === 'release:updated' || msg.type === 'release:transition') {
      const idx = releases.findIndex(r => r.version === msg.release.version);
      if (idx >= 0) releases[idx] = msg.release;
      else releases.unshift(msg.release);
      renderReleaseList();
      if (selectedVersion === msg.release.version) renderDetail(msg.release);
      return;
    }

    if (msg.type === 'release:deleted') {
      releases = releases.filter(r => r.version !== msg.version);
      renderReleaseList();
      if (selectedVersion === msg.version) {
        selectedVersion = null;
        showView('releases');
      }
      return;
    }
  };

  ws.onclose = () => {
    connStatus.textContent = 'disconnected — reconnecting...';
    connStatus.className = 'connection-status error';
    setTimeout(connectWs, 3000);
  };

  ws.onerror = () => {
    connStatus.textContent = 'error';
    connStatus.className = 'connection-status error';
  };
}

// ── Release List ────────────────────────────────────────────
function renderReleaseList() {
  const filter = filterState.value;
  const filtered = filter ? releases.filter(r => r.state === filter) : releases;

  if (filtered.length === 0) {
    releaseList.innerHTML = '<div class="empty">No releases yet. Create one to get started.</div>';
    return;
  }

  releaseList.innerHTML = filtered.map(r => {
    const picked = r.tickets.filter(t => t.state === 'cherry-picked').length;
    const pending = r.tickets.filter(t => t.state === 'pending').length;
    const approvedRoles = r.approvals.map(a => a.role);
    const deployDone = r.deployments.filter(d => d.status === 'deployed').length;

    return `
      <div class="release-card" data-version="${r.version}">
        <div class="release-header">
          <span class="release-version">${r.version}</span>
          <span class="state-badge state-${r.state}">${r.state}</span>
          ${r.risk.numericScore !== null ? `<span class="tag tag-${riskClass(r.risk.numericScore)}">${riskLabel(r.risk.numericScore)}</span>` : ''}
          ${r.ci.status ? `<span class="tag tag-${r.ci.status === 'passing' ? 'merged' : 'pending'}">CI: ${r.ci.status}</span>` : ''}
        </div>
        <div class="release-meta">
          ${r.tickets.length > 0 ? `<span>${r.tickets.length} tickets | ${picked} picked | ${pending} pending</span>` : ''}
          ${r.deployments.length > 0 ? `<span>Deploy: ${deployDone}/${r.deployments.length}</span>` : ''}
          ${r.approvals.length > 0 ? `<span>Approvals: ${approvedRoles.join(', ')}</span>` : ''}
          <span>Created ${timeAgo(r.createdAt)}</span>
        </div>
      </div>
    `;
  }).join('');

  // Click handlers
  releaseList.querySelectorAll('.release-card').forEach(card => {
    card.addEventListener('click', () => {
      selectedVersion = card.dataset.version;
      const release = releases.find(r => r.version === selectedVersion);
      if (release) {
        renderDetail(release);
        showView('detail');
      }
    });
  });
}

filterState.addEventListener('change', renderReleaseList);

// ── Release Detail ──────────────────────────────────────────
function renderDetail(r) {
  const TRANSITIONS = {
    planning: ['cutting'], cutting: ['stabilizing'], stabilizing: ['approved'],
    approved: ['deploying'], deploying: ['done', 'stabilizing'], done: [],
  };
  const nextStates = TRANSITIONS[r.state] || [];

  releaseDetail.innerHTML = `
    <div class="detail-header">
      <h2>${r.version}</h2>
      <span class="state-badge state-${r.state}">${r.state}</span>
    </div>

    <div class="detail-actions">
      ${nextStates.map(s => `<button class="btn-sm btn-transition" data-state="${s}">Move to ${s}</button>`).join('')}
    </div>

    <div class="detail-section">
      <h3>Info</h3>
      <div class="release-meta">
        <span>Branch: ${r.branch}</span>
        ${r.cutFrom ? `<span>Cut from: ${r.cutFrom.substring(0, 7)}</span>` : ''}
        ${r.cutBy ? `<span>Cut by: ${r.cutBy}</span>` : ''}
        ${r.cutAt ? `<span>Cut at: ${new Date(r.cutAt).toLocaleDateString()}</span>` : ''}
      </div>
    </div>

    <div class="detail-section">
      <h3>Tickets (${r.tickets.length})</h3>
      ${r.tickets.length > 0 ? `
        <div class="ticket-list">
          ${r.tickets.map(t => `
            <div class="ticket-row">
              <span style="font-weight:600">${t.key}</span>
              <span style="flex:1;color:var(--text-dim)">${t.summary}</span>
              <span class="tag tag-${t.state}">${t.state}</span>
              ${t.pr ? `<span style="color:var(--text-dim)">#${t.pr}</span>` : ''}
            </div>
          `).join('')}
        </div>
      ` : '<div class="empty">No tickets added yet</div>'}
    </div>

    <div class="detail-section">
      <h3>Cherry-picks (${r.cherryPicks.length})</h3>
      ${r.cherryPicks.length > 0 ? `
        <div class="cp-list">
          ${r.cherryPicks.map(c => `
            <div class="cp-row">
              <span style="font-family:monospace">${c.sha.substring(0, 7)}</span>
              ${c.ticket ? `<span>${c.ticket}</span>` : ''}
              ${c.pr ? `<span style="color:var(--text-dim)">PR #${c.pr}</span>` : ''}
              <span class="tag tag-${c.status}">${c.status}</span>
            </div>
          `).join('')}
        </div>
      ` : '<div class="empty">No cherry-picks tracked yet</div>'}
    </div>

    <div class="detail-section">
      <h3>Approvals</h3>
      ${r.approvals.length > 0 ? `
        <div class="deploy-list">
          ${r.approvals.map(a => `
            <div class="deploy-row">
              <span style="font-weight:600">${a.role}</span>
              <span style="color:var(--text-dim)">${a.user}</span>
              <span style="color:var(--text-dim)">${timeAgo(a.at)}</span>
            </div>
          `).join('')}
        </div>
      ` : '<div class="empty">No approvals yet</div>'}
    </div>

    <div class="detail-section">
      <h3>Deployments</h3>
      ${r.deployments.length > 0 ? `
        <div class="deploy-list">
          ${r.deployments.map(d => `
            <div class="deploy-row">
              <span style="font-weight:600">${d.customer}</span>
              <span>${d.env}</span>
              <span class="tag tag-${d.status === 'deployed' ? 'merged' : 'pending'}">${d.status}</span>
              <span style="color:var(--text-dim)">${timeAgo(d.at)}</span>
            </div>
          `).join('')}
        </div>
      ` : '<div class="empty">No deployments tracked yet</div>'}
    </div>
  `;

  // Transition button handlers
  releaseDetail.querySelectorAll('.btn-transition').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await apiFetch(`/releases/${r.version}`, {
          method: 'PATCH',
          body: JSON.stringify({ state: btn.dataset.state }),
        });
      } catch (err) {
        alert(err.message);
      }
      btn.disabled = false;
    });
  });
}

// ── Customer Map ────────────────────────────────────────────
async function loadCustomers() {
  try {
    const data = await apiFetch('/customers');
    if (data.length === 0) {
      customerMap.innerHTML = '<div class="empty">No customers configured in nectar.config.js</div>';
      return;
    }
    customerMap.innerHTML = `
      <table class="customer-table">
        <thead><tr><th>Customer</th><th>Production</th><th>Staging</th></tr></thead>
        <tbody>
          ${data.map(c => `
            <tr>
              <td style="font-weight:600">${c.name}</td>
              <td>${c.production || '—'}</td>
              <td>${c.staging || '—'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (err) {
    customerMap.innerHTML = `<div class="empty">Error: ${err.message}</div>`;
  }
}

// ── New Release Modal ───────────────────────────────────────
$('#btnNewRelease').addEventListener('click', () => newReleaseModal.showModal());
$('#btnCancelNew').addEventListener('click', () => newReleaseModal.close());

$('#newReleaseForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const body = {};
  for (const [k, v] of form.entries()) { if (v) body[k] = v; }

  try {
    await apiFetch('/releases', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    newReleaseModal.close();
    e.target.reset();
  } catch (err) {
    alert(err.message);
  }
});

// ── Helpers ─────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function riskLabel(score) {
  if (score <= 30) return 'LOW';
  if (score <= 60) return 'MED';
  return 'HIGH';
}

function riskClass(score) {
  if (score <= 30) return 'merged';   // green
  if (score <= 60) return 'pending';  // yellow
  return 'in-progress';               // blue (will need red class later)
}

// ── Init ────────────────────────────────────────────────────
connectWs();
