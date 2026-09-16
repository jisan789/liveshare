/**
 * LiveShare App UI and WebSocket Signaling Orchestration
 */

// Helper: Format bytes to human readable string
function formatBytes(bytes, decimals = 2) {
  if (!+bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

// Helper: Format seconds to ETA mm:ss
function formatTime(seconds) {
  if (!seconds || seconds <= 0) return '0s';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// Helper: Hash password with SHA-256
async function sha256(str) {
  const buffer = new TextEncoder().encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Generate random 6-character room code
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code.slice(0, 3) + '-' + code.slice(3);
}

// App State
const state = {
  activeTab: 'send',
  selectedFiles: [],
  ws: null,
  isUploader: false,
  roomId: null,
  password: null,
  peerId: null,
  peers: {}, // peerId -> WebRTCPeer
  pingInterval: null,
  receivedFiles: []
};

// DOM Elements
const tabSendBtn = document.getElementById('tab-send-btn');
const tabReceiveBtn = document.getElementById('tab-receive-btn');
const sendSection = document.getElementById('send-section');
const receiveSection = document.getElementById('receive-section');

// Dropzone & File List
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const fileListContainer = document.getElementById('file-list');
const sendPasswordInput = document.getElementById('send-password');
const sendRoomCodeInput = document.getElementById('send-room-code');
const btnGenCode = document.getElementById('btn-gen-code');
const btnStartShare = document.getElementById('btn-start-share');

// Active Session Elements (Sender)
const senderActiveSession = document.getElementById('sender-active-session');
const senderConfigCard = document.getElementById('sender-config-card');
const displayRoomCode = document.getElementById('display-room-code');
const btnCopyCode = document.getElementById('btn-copy-code');
const btnCopyLink = document.getElementById('btn-copy-link');
const btnShowQr = document.getElementById('btn-show-qr');
const btnStopShare = document.getElementById('btn-stop-share');
const senderPeerStatus = document.getElementById('sender-peer-status');
const senderTransferProgress = document.getElementById('sender-transfer-progress');
const senderProgressFill = document.getElementById('sender-progress-fill');
const senderProgressPercent = document.getElementById('sender-progress-percent');
const senderProgressStats = document.getElementById('sender-progress-stats');
const senderTransferFile = document.getElementById('sender-transfer-file');

// Receiver Elements
const receiveRoomCodeInput = document.getElementById('receive-room-code');
const receivePasswordInput = document.getElementById('receive-password');
const btnConnectReceive = document.getElementById('btn-connect-receive');
const receiverActiveSession = document.getElementById('receiver-active-session');
const receiverConfigCard = document.getElementById('receiver-config-card');
const receiverPeerStatus = document.getElementById('receiver-peer-status');
const receiverFileManifest = document.getElementById('receiver-file-manifest');
const receiverTransferProgress = document.getElementById('receiver-transfer-progress');
const receiverProgressFill = document.getElementById('receiver-progress-fill');
const receiverProgressPercent = document.getElementById('receiver-progress-percent');
const receiverProgressStats = document.getElementById('receiver-progress-stats');
const receiverTransferFile = document.getElementById('receiver-transfer-file');
const receivedDownloadsList = document.getElementById('received-downloads-list');
const btnLeaveReceive = document.getElementById('btn-leave-receive');

// QR Modal Elements
const qrModal = document.getElementById('qr-modal');
const btnCloseQr = document.getElementById('btn-close-qr');
const qrCanvasContainer = document.getElementById('qr-code-canvas');
const qrRoomText = document.getElementById('qr-room-text');

// Toast Notification
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  let iconSvg = '';
  if (type === 'success') {
    iconSvg = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>';
  } else if (type === 'error') {
    iconSvg = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f43f5e" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
  } else {
    iconSvg = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#06b6d4" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
  }

  toast.innerHTML = `${iconSvg} <span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-10px)';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// Switch Tabs
function switchTab(tab) {
  state.activeTab = tab;
  if (tab === 'send') {
    tabSendBtn.classList.add('active');
    tabReceiveBtn.classList.remove('active');
    sendSection.classList.add('active');
    receiveSection.classList.remove('active');
  } else {
    tabReceiveBtn.classList.add('active');
    tabSendBtn.classList.remove('active');
    receiveSection.classList.add('active');
    sendSection.classList.remove('active');
  }
}

tabSendBtn.addEventListener('click', () => switchTab('send'));
tabReceiveBtn.addEventListener('click', () => switchTab('receive'));

// Generate Code Button
btnGenCode.addEventListener('click', () => {
  sendRoomCodeInput.value = generateRoomCode();
});
sendRoomCodeInput.value = generateRoomCode();

// Check for Room query param on load
window.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const roomParam = urlParams.get('room');
  if (roomParam) {
    receiveRoomCodeInput.value = roomParam.toUpperCase();
    switchTab('receive');
    receivePasswordInput.focus();
    showToast(`Loaded share room: ${roomParam.toUpperCase()}. Enter password to join.`, 'info');
  }
});

// Dropzone & File Selection
dropzone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => handleFilesSelected(e.target.files));

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
});

['dragleave', 'dragend'].forEach(type => {
  dropzone.addEventListener(type, () => dropzone.classList.remove('dragover'));
});

dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
    handleFilesSelected(e.dataTransfer.files);
  }
});

function handleFilesSelected(files) {
  for (let i = 0; i < files.length; i++) {
    state.selectedFiles.push(files[i]);
  }
  renderSelectedFiles();
}

function renderSelectedFiles() {
  fileListContainer.innerHTML = '';
  if (state.selectedFiles.length === 0) {
    btnStartShare.disabled = true;
    return;
  }

  btnStartShare.disabled = false;
  state.selectedFiles.forEach((file, index) => {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.innerHTML = `
      <div class="file-info">
        <div class="file-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
          </svg>
        </div>
        <div class="file-details">
          <span class="file-name" title="${file.name}">${file.name}</span>
          <span class="file-meta">${formatBytes(file.size)}</span>
        </div>
      </div>
      <button class="file-remove-btn" title="Remove file" onclick="removeFile(${index})">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    `;
    fileListContainer.appendChild(item);
  });
}

window.removeFile = function(index) {
  state.selectedFiles.splice(index, 1);
  renderSelectedFiles();
};

// WebSocket Signaling connection
function connectWebSocket() {
  return new Promise((resolve, reject) => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      resolve(state.ws);
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('Connected to WebSocket signaling server');
      // Setup heartbeat ping every 25 seconds for Render keepalive
      if (state.pingInterval) clearInterval(state.pingInterval);
      state.pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 25000);
      state.ws = ws;
      resolve(ws);
    };

    ws.onerror = (err) => {
      console.error('WebSocket connection error:', err);
      showToast('Could not connect to signaling server.', 'error');
      reject(err);
    };

    ws.onclose = () => {
      console.log('WebSocket closed');
      if (state.pingInterval) clearInterval(state.pingInterval);
    };

    ws.onmessage = (event) => {
      handleSignalingMessage(JSON.parse(event.data));
    };
  });
}

// -------------------------------------------------------------
// SENDER WORKFLOW
// -------------------------------------------------------------
btnStartShare.addEventListener('click', async () => {
  const roomCode = sendRoomCodeInput.value.trim().toUpperCase();
  const password = sendPasswordInput.value.trim();

  if (!roomCode) {
    showToast('Please enter or generate a Room Code.', 'error');
    return;
  }
  if (!password) {
    showToast('Please set a Password for receiver authorization.', 'error');
    return;
  }
  if (state.selectedFiles.length === 0) {
    showToast('Please select at least one file to share.', 'error');
    return;
  }

  btnStartShare.disabled = true;
  btnStartShare.innerHTML = `<span>Starting Session...</span>`;

  try {
    const ws = await connectWebSocket();
    const passwordHash = await sha256(password);
    state.isUploader = true;
    state.roomId = roomCode;
    state.password = password;

    const fileMetadata = state.selectedFiles.map(f => ({
      name: f.name,
      size: f.size,
      type: f.type
    }));

    ws.send(JSON.stringify({
      type: 'create-room',
      roomId: roomCode,
      passwordHash: passwordHash,
      fileMetadata: fileMetadata
    }));
  } catch (e) {
    btnStartShare.disabled = false;
    btnStartShare.innerHTML = `<span>Start P2P Live Share</span>`;
  }
});

function handleSignalingMessage(msg) {
  console.log('[Signaling Received]', msg.type, msg);

  if (msg.type === 'error') {
    showToast(msg.message, 'error');
    btnStartShare.disabled = false;
    btnStartShare.innerHTML = `<span>Start P2P Live Share</span>`;
    btnConnectReceive.disabled = false;
    btnConnectReceive.innerHTML = `<span>Join & Start Download</span>`;
    return;
  }

  if (msg.type === 'room-created') {
    state.peerId = msg.peerId;
    senderConfigCard.style.display = 'none';
    senderActiveSession.style.display = 'flex';
    displayRoomCode.textContent = state.roomId;
    showToast(`Share room ${state.roomId} is ready!`, 'success');
  }

  // UPLOADER: Receiver joined -> Create WebRTC Offer
  if (msg.type === 'receiver-joined') {
    const receiverPeerId = msg.peerId;
    showToast(`Receiver connected! Initializing direct P2P link...`, 'info');
    updatePeerStatusUI(senderPeerStatus, 'connected', 'Peer Connected (Transferring)');

    const peer = new WebRTCPeer(
      receiverPeerId,
      true, // isInitiator
      (targetId, signalData) => {
        state.ws.send(JSON.stringify({
          type: 'signal',
          targetPeerId: targetId,
          signalData: signalData
        }));
      },
      (peerId, status) => {
        if (status === 'connected') {
          updatePeerStatusUI(senderPeerStatus, 'connected', 'P2P Direct Connected');
          senderTransferProgress.style.display = 'block';
          // Begin file transfer
          peer.sendFiles(state.selectedFiles).catch(err => {
            console.error('Send files error:', err);
            showToast('Transfer encountered an error.', 'error');
          });
        } else if (status === 'disconnected') {
          updatePeerStatusUI(senderPeerStatus, 'waiting', 'Waiting for Receiver...');
        }
      },
      (progress) => {
        updateSenderProgress(progress);
      },
      () => {}
    );

    state.peers[receiverPeerId] = peer;
    peer.createOffer();
  }

  // RECEIVER: Room joined successfully
  if (msg.type === 'room-joined') {
    state.peerId = msg.peerId;
    receiverConfigCard.style.display = 'none';
    receiverActiveSession.style.display = 'flex';
    renderReceiverManifest(msg.fileMetadata);
    updatePeerStatusUI(receiverPeerStatus, 'waiting', 'Connecting to Uploader P2P...');
    showToast('Joined room! Handshaking P2P connection...', 'success');

    // Setup receiver peer connection
    const uploaderId = msg.uploaderId;
    const peer = new WebRTCPeer(
      uploaderId,
      false, // not initiator
      (targetId, signalData) => {
        state.ws.send(JSON.stringify({
          type: 'signal',
          targetPeerId: targetId,
          signalData: signalData
        }));
      },
      (peerId, status) => {
        if (status === 'connected') {
          updatePeerStatusUI(receiverPeerStatus, 'connected', 'P2P Direct Link Active');
          receiverTransferProgress.style.display = 'block';
        } else if (status === 'disconnected') {
          updatePeerStatusUI(receiverPeerStatus, 'waiting', 'Uploader Disconnected');
        }
      },
      (progress) => {
        updateReceiverProgress(progress);
      },
      (fileMeta, blob) => {
        handleFileReceived(fileMeta, blob);
      }
    );

    state.peers[uploaderId] = peer;
  }

  // SIGNAL RELAY (Offer, Answer, ICE Candidates)
  if (msg.type === 'signal') {
    const senderId = msg.senderPeerId;
    const signalData = msg.signalData;
    const peer = state.peers[senderId];

    if (peer) {
      if (signalData.type === 'offer') {
        peer.handleOffer(signalData.sdp);
      } else if (signalData.type === 'answer') {
        peer.handleAnswer(signalData.sdp);
      } else if (signalData.type === 'candidate') {
        peer.handleCandidate(signalData.candidate);
      }
    }
  }

  if (msg.type === 'uploader-disconnected') {
    showToast(msg.message, 'error');
    updatePeerStatusUI(receiverPeerStatus, 'disconnected', 'Uploader Left Session');
  }

  if (msg.type === 'receiver-disconnected') {
    showToast(`Receiver disconnected.`, 'info');
    if (state.peers[msg.peerId]) {
      state.peers[msg.peerId].close();
      del state.peers[msg.peerId];
    }
    updatePeerStatusUI(senderPeerStatus, 'waiting', 'Waiting for Receiver...');
  }
}

// -------------------------------------------------------------
// RECEIVER WORKFLOW
// -------------------------------------------------------------
btnConnectReceive.addEventListener('click', async () => {
  const roomCode = receiveRoomCodeInput.value.trim().toUpperCase();
  const password = receivePasswordInput.value.trim();

  if (!roomCode) {
    showToast('Please enter the Room Code.', 'error');
    return;
  }
  if (!password) {
    showToast('Please enter the Room Password.', 'error');
    return;
  }

  btnConnectReceive.disabled = true;
  btnConnectReceive.innerHTML = `<span>Joining Room...</span>`;

  try {
    const ws = await connectWebSocket();
    const passwordHash = await sha256(password);
    state.isUploader = false;
    state.roomId = roomCode;

    ws.send(JSON.stringify({
      type: 'join-room',
      roomId: roomCode,
      passwordHash: passwordHash
    }));
  } catch (e) {
    btnConnectReceive.disabled = false;
    btnConnectReceive.innerHTML = `<span>Join & Start Download</span>`;
  }
});

function renderReceiverManifest(files) {
  receiverFileManifest.innerHTML = '';
  if (!files || files.length === 0) return;

  const totalSize = files.reduce((acc, f) => acc + f.size, 0);
  const header = document.createElement('div');
  header.style.marginBottom = '0.5rem';
  header.style.fontSize = '0.9rem';
  header.style.color = 'var(--text-muted)';
  header.textContent = `Files offered by uploader (${files.length} items, ${formatBytes(totalSize)}):`;
  receiverFileManifest.appendChild(header);

  files.forEach(file => {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.innerHTML = `
      <div class="file-info">
        <div class="file-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
          </svg>
        </div>
        <div class="file-details">
          <span class="file-name">${file.name}</span>
          <span class="file-meta">${formatBytes(file.size)}</span>
        </div>
      </div>
    `;
    receiverFileManifest.appendChild(item);
  });
}

function handleFileReceived(fileMeta, blob) {
  state.receivedFiles.push({ meta: fileMeta, blob });
  const url = URL.createObjectURL(blob);

  // Auto download file
  const a = document.createElement('a');
  a.href = url;
  a.download = fileMeta.name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  showToast(`Successfully received: ${fileMeta.name}`, 'success');

  // Render download card in list
  const item = document.createElement('div');
  item.className = 'file-item';
  item.style.borderColor = 'rgba(16, 185, 129, 0.4)';
  item.innerHTML = `
    <div class="file-info">
      <div class="file-icon" style="background: rgba(16, 185, 129, 0.15); color: var(--accent-emerald);">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M20 6L9 17l-5-5"/>
        </svg>
      </div>
      <div class="file-details">
        <span class="file-name">${fileMeta.name}</span>
        <span class="file-meta">${formatBytes(fileMeta.size)} - Downloaded</span>
      </div>
    </div>
    <a href="${url}" download="${fileMeta.name}" class="btn btn-secondary" style="padding: 0.4rem 0.8rem; font-size: 0.85rem;">
      Save Again
    </a>
  `;
  receivedDownloadsList.appendChild(item);
}

// -------------------------------------------------------------
// UI PROGRESS UPDATERS
// -------------------------------------------------------------
function updatePeerStatusUI(el, status, text) {
  if (!el) return;
  const ring = el.querySelector('.pulse-ring');
  const txt = el.querySelector('.status-text');
  if (ring) {
    ring.className = `pulse-ring ${status}`;
  }
  if (txt) {
    txt.textContent = text;
  }
}

function updateSenderProgress(p) {
  if (p.type === 'sending') {
    senderTransferFile.textContent = `Sending (${p.fileIndex + 1}/${p.totalFiles}): ${p.fileName}`;
    senderProgressFill.style.width = `${p.percent}%`;
    senderProgressPercent.textContent = `${p.percent}%`;
    senderProgressStats.innerHTML = `
      <span>${formatBytes(p.sentBytes)} / ${formatBytes(p.totalBytes)}</span>
      <span>${formatBytes(p.speed)}/s &bull; ETA: ${formatTime(p.eta)}</span>
    `;
  } else if (p.type === 'all-complete') {
    senderTransferFile.textContent = 'All files transferred successfully!';
    senderProgressFill.style.width = '100%';
    senderProgressPercent.textContent = '100%';
    senderProgressStats.innerHTML = `<span style="color: var(--accent-emerald); font-weight: 600;">Transfer Complete!</span>`;
    showToast('All files sent peer-to-peer successfully!', 'success');
  }
}

function updateReceiverProgress(p) {
  if (p.type === 'start') {
    receiverTransferFile.textContent = `Receiving: ${p.file.name}`;
    receiverProgressFill.style.width = '0%';
    receiverProgressPercent.textContent = '0%';
  } else if (p.type === 'transferring') {
    receiverTransferFile.textContent = `Receiving: ${p.file.name}`;
    receiverProgressFill.style.width = `${p.percent}%`;
    receiverProgressPercent.textContent = `${p.percent}%`;
    receiverProgressStats.innerHTML = `
      <span>${formatBytes(p.transferredBytes)} / ${formatBytes(p.totalBytes)}</span>
      <span>${formatBytes(p.speed)}/s &bull; ETA: ${formatTime(p.eta)}</span>
    `;
  } else if (p.type === 'all-complete') {
    receiverTransferFile.textContent = 'All downloads finished!';
    receiverProgressFill.style.width = '100%';
    receiverProgressPercent.textContent = '100%';
    receiverProgressStats.innerHTML = `<span style="color: var(--accent-emerald); font-weight: 600;">All files downloaded!</span>`;
  }
}

// -------------------------------------------------------------
// SHARE ACTIONS & QR CODE
// -------------------------------------------------------------
btnCopyCode.addEventListener('click', () => {
  if (state.roomId) {
    navigator.clipboard.writeText(state.roomId).then(() => {
      showToast('Room code copied to clipboard!', 'success');
    });
  }
});

btnCopyLink.addEventListener('click', () => {
  if (state.roomId) {
    const shareUrl = `${window.location.origin}/?room=${state.roomId}`;
    navigator.clipboard.writeText(shareUrl).then(() => {
      showToast('Shareable link copied to clipboard!', 'success');
    });
  }
});

btnShowQr.addEventListener('click', () => {
  if (!state.roomId) return;
  const shareUrl = `${window.location.origin}/?room=${state.roomId}`;
  qrRoomText.textContent = `Room: ${state.roomId} (Password: ${state.password})`;
  
  // Render QR Code using lightweight API or canvas
  qrCanvasContainer.innerHTML = '';
  const qrImg = document.createElement('img');
  qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(shareUrl)}`;
  qrImg.alt = 'QR Code';
  qrImg.style.display = 'block';
  qrCanvasContainer.appendChild(qrImg);

  qrModal.classList.add('active');
});

btnCloseQr.addEventListener('click', () => {
  qrModal.classList.remove('active');
});

qrModal.addEventListener('click', (e) => {
  if (e.target === qrModal) qrModal.classList.remove('active');
});

btnStopShare.addEventListener('click', () => {
  if (confirm('Are you sure you want to stop sharing and close the session?')) {
    window.location.reload();
  }
});

btnLeaveReceive.addEventListener('click', () => {
  window.location.href = window.location.origin;
});
