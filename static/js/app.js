/**
 * LiveShare App UI and WebSocket Signaling Orchestration
 * Password-only flow with live available rooms discovery.
 */

// Helper: Format bytes to human readable string
function formatBytes(bytes, decimals = 1) {
  if (!+bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

// Helper: Hash password with SHA-256
async function sha256(str) {
  const buffer = new TextEncoder().encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// App State
const state = {
  activeTab: 'send',
  selectedFiles: [],
  ws: null,
  isUploader: false,
  roomId: null,
  peerId: null,
  peers: {}, // peerId -> WebRTCPeer
  pingInterval: null,
  activeRooms: [],
  targetRoomForUnlock: null
};

// DOM Elements
const tabSendBtn = document.getElementById('tab-send-btn');
const tabReceiveBtn = document.getElementById('tab-receive-btn');
const sendSection = document.getElementById('send-section');
const receiveSection = document.getElementById('receive-section');
const roomsCountBadge = document.getElementById('rooms-count-badge');

// Sender Elements
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const fileListContainer = document.getElementById('file-list');
const sendPasswordInput = document.getElementById('send-password');
const btnStartShare = document.getElementById('btn-start-share');
const senderActiveSession = document.getElementById('sender-active-session');
const senderConfigCard = document.getElementById('sender-config-card');
const senderPeerStatus = document.getElementById('sender-peer-status');
const senderTransferProgress = document.getElementById('sender-transfer-progress');
const senderProgressFill = document.getElementById('sender-progress-fill');
const senderProgressPercent = document.getElementById('sender-progress-percent');
const senderProgressStats = document.getElementById('sender-progress-stats');
const senderTransferFile = document.getElementById('sender-transfer-file');
const btnStopShare = document.getElementById('btn-stop-share');

// Receiver Elements
const availableRoomsList = document.getElementById('available-rooms-list');
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

// Unlock Modal Elements
const unlockModal = document.getElementById('unlock-modal');
const btnCloseUnlock = document.getElementById('btn-close-unlock');
const unlockRoomDesc = document.getElementById('unlock-room-desc');
const modalUnlockPassword = document.getElementById('modal-unlock-password');
const btnConfirmUnlock = document.getElementById('btn-confirm-unlock');

// Toast Notification
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
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

// File Selection & Drag-and-Drop
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
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
          </svg>
        </div>
        <div class="file-details">
          <span class="file-name" title="${file.name}">${file.name}</span>
          <span class="file-meta">${formatBytes(file.size)}</span>
        </div>
      </div>
      <button class="file-remove-btn" title="Remove" onclick="removeFile(${index})">&times;</button>
    `;
    fileListContainer.appendChild(item);
  });
}

window.removeFile = function(index) {
  state.selectedFiles.splice(index, 1);
  renderSelectedFiles();
};

// WebSocket Signaling Connection
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
      console.error('WebSocket error:', err);
      reject(err);
    };

    ws.onclose = () => {
      if (state.pingInterval) clearInterval(state.pingInterval);
    };

    ws.onmessage = (event) => {
      handleSignalingMessage(JSON.parse(event.data));
    };
  });
}

// Connect immediately on page load to receive live rooms updates
window.addEventListener('DOMContentLoaded', () => {
  connectWebSocket().catch(err => console.log('Initial WS connect waiting...'));
});

// -------------------------------------------------------------
// SENDER WORKFLOW (Password Only)
// -------------------------------------------------------------
btnStartShare.addEventListener('click', async () => {
  const password = sendPasswordInput.value.trim();

  if (!password) {
    showToast('Please set a password for the receiver.', 'error');
    sendPasswordInput.focus();
    return;
  }
  if (state.selectedFiles.length === 0) {
    showToast('Please select at least one file to share.', 'error');
    return;
  }

  btnStartShare.disabled = true;
  btnStartShare.textContent = 'Starting Share...';

  try {
    const ws = await connectWebSocket();
    const passwordHash = await sha256(password);
    state.isUploader = true;

    const fileMetadata = state.selectedFiles.map(f => ({
      name: f.name,
      size: f.size,
      type: f.type
    }));

    ws.send(JSON.stringify({
      type: 'create-room',
      passwordHash: passwordHash,
      fileMetadata: fileMetadata
    }));
  } catch (e) {
    btnStartShare.disabled = false;
    btnStartShare.textContent = 'Start Sharing';
    showToast('Could not start share session.', 'error');
  }
});

// -------------------------------------------------------------
// RECEIVER AVAILABLE ROOMS UI & UNLOCK FLOW
// -------------------------------------------------------------
function renderAvailableRooms(rooms) {
  state.activeRooms = rooms;
  
  if (rooms.length > 0) {
    roomsCountBadge.style.display = 'inline-block';
    roomsCountBadge.textContent = rooms.length;
  } else {
    roomsCountBadge.style.display = 'none';
  }

  if (!rooms || rooms.length === 0) {
    availableRoomsList.innerHTML = `
      <div class="empty-state">
        <div class="pulse-ring waiting" style="margin: 0 auto 0.75rem;"></div>
        <p>Searching for live shares...</p>
        <span style="font-size: 0.75rem; color: var(--text-subtle);">When an uploader starts sharing, it will appear here instantly.</span>
      </div>
    `;
    return;
  }

  availableRoomsList.innerHTML = '';
  rooms.forEach(room => {
    const item = document.createElement('div');
    item.className = 'room-card-item';
    
    const fileSummary = room.fileCount === 1 
      ? `1 file (${formatBytes(room.totalSize)})` 
      : `${room.fileCount} files (${formatBytes(room.totalSize)})`;

    item.innerHTML = `
      <div class="room-card-info">
        <div class="room-card-title">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-cyan);">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
          </svg>
          Live Share #${room.roomId.replace('SHARE-', '')}
        </div>
        <div class="room-card-meta">${fileSummary}</div>
      </div>
      <button class="room-unlock-btn" onclick="openUnlockModal('${room.roomId}', '${fileSummary}')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
        </svg>
        Unlock
      </button>
    `;
    availableRoomsList.appendChild(item);
  });
}

window.openUnlockModal = function(roomId, fileSummary) {
  state.targetRoomForUnlock = roomId;
  unlockRoomDesc.textContent = `${fileSummary}. Enter the uploader's password to connect.`;
  modalUnlockPassword.value = '';
  unlockModal.classList.add('active');
  setTimeout(() => modalUnlockPassword.focus(), 100);
};

btnCloseUnlock.addEventListener('click', () => {
  unlockModal.classList.remove('active');
});

unlockModal.addEventListener('click', (e) => {
  if (e.target === unlockModal) unlockModal.classList.remove('active');
});

modalUnlockPassword.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnConfirmUnlock.click();
});

btnConfirmUnlock.addEventListener('click', async () => {
  const password = modalUnlockPassword.value.trim();
  const roomId = state.targetRoomForUnlock;

  if (!password) {
    showToast('Please enter the room password.', 'error');
    modalUnlockPassword.focus();
    return;
  }

  btnConfirmUnlock.disabled = true;
  btnConfirmUnlock.textContent = 'Verifying...';

  try {
    const ws = await connectWebSocket();
    const passwordHash = await sha256(password);
    state.isUploader = false;
    state.roomId = roomId;

    ws.send(JSON.stringify({
      type: 'join-room',
      roomId: roomId,
      passwordHash: passwordHash
    }));
  } catch (e) {
    btnConfirmUnlock.disabled = false;
    btnConfirmUnlock.textContent = 'Unlock & Download';
  }
});

// -------------------------------------------------------------
// SIGNALING MESSAGE HANDLER
// -------------------------------------------------------------
function handleSignalingMessage(msg) {
  // Live Rooms Broadcast
  if (msg.type === 'active-rooms-update') {
    renderAvailableRooms(msg.rooms || []);
    return;
  }

  if (msg.type === 'error') {
    showToast(msg.message, 'error');
    btnStartShare.disabled = false;
    btnStartShare.textContent = 'Start Sharing';
    btnConfirmUnlock.disabled = false;
    btnConfirmUnlock.textContent = 'Unlock & Download';
    return;
  }

  // UPLOADER: Room created
  if (msg.type === 'room-created') {
    state.roomId = msg.roomId;
    state.peerId = msg.peerId;
    senderConfigCard.style.display = 'none';
    senderActiveSession.style.display = 'flex';
    showToast('Share is now live! Receivers can unlock on the Receive tab.', 'success');
  }

  // UPLOADER: Receiver joined room -> Start WebRTC Offer
  if (msg.type === 'receiver-joined') {
    const receiverPeerId = msg.peerId;
    showToast('Receiver connected! Starting P2P file transfer...', 'info');
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
          updatePeerStatusUI(senderPeerStatus, 'connected', 'Direct Transfer Active');
          senderTransferProgress.style.display = 'block';
          peer.sendFiles(state.selectedFiles).catch(err => {
            console.error('Send error:', err);
            showToast('Transfer error encountered.', 'error');
          });
        } else if (status === 'disconnected') {
          updatePeerStatusUI(senderPeerStatus, 'waiting', 'Waiting for receiver...');
        }
      },
      (progress) => updateSenderProgress(progress),
      () => {}
    );

    state.peers[receiverPeerId] = peer;
    peer.createOffer();
  }

  // RECEIVER: Room unlocked & joined
  if (msg.type === 'room-joined') {
    unlockModal.classList.remove('active');
    btnConfirmUnlock.disabled = false;
    btnConfirmUnlock.textContent = 'Unlock & Download';

    state.peerId = msg.peerId;
    receiverConfigCard.style.display = 'none';
    receiverActiveSession.style.display = 'flex';
    renderReceiverManifest(msg.fileMetadata);
    updatePeerStatusUI(receiverPeerStatus, 'waiting', 'Establishing direct P2P link...');
    showToast('Unlocked! Receiving files directly...', 'success');

    const uploaderId = msg.uploaderId;
    const peer = new WebRTCPeer(
      uploaderId,
      false, // receiver is not initiator
      (targetId, signalData) => {
        state.ws.send(JSON.stringify({
          type: 'signal',
          targetPeerId: targetId,
          signalData: signalData
        }));
      },
      (peerId, status) => {
        if (status === 'connected') {
          updatePeerStatusUI(receiverPeerStatus, 'connected', 'Direct Transfer Active');
          receiverTransferProgress.style.display = 'block';
        } else if (status === 'disconnected') {
          updatePeerStatusUI(receiverPeerStatus, 'waiting', 'Uploader disconnected');
        }
      },
      (progress) => updateReceiverProgress(progress),
      (fileMeta, blob) => handleFileReceived(fileMeta, blob)
    );

    state.peers[uploaderId] = peer;
  }

  // SIGNAL RELAY
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
    updatePeerStatusUI(receiverPeerStatus, 'disconnected', 'Session Ended');
  }

  if (msg.type === 'receiver-disconnected') {
    if (state.peers[msg.peerId]) {
      state.peers[msg.peerId].close();
      delete state.peers[msg.peerId];
    }
    updatePeerStatusUI(senderPeerStatus, 'waiting', 'Waiting for receiver...');
  }
}

// -------------------------------------------------------------
// RECEIVER FILE DOWNLOAD HANDLERS
// -------------------------------------------------------------
function renderReceiverManifest(files) {
  receiverFileManifest.innerHTML = '';
  if (!files || files.length === 0) return;

  files.forEach(file => {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.innerHTML = `
      <div class="file-info">
        <div class="file-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
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
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileMeta.name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  showToast(`Downloaded: ${fileMeta.name}`, 'success');

  const item = document.createElement('div');
  item.className = 'file-item';
  item.style.borderColor = 'rgba(16, 185, 129, 0.4)';
  item.innerHTML = `
    <div class="file-info">
      <div class="file-icon" style="color: var(--accent-emerald);">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M20 6L9 17l-5-5"/>
        </svg>
      </div>
      <div class="file-details">
        <span class="file-name">${fileMeta.name}</span>
        <span class="file-meta">${formatBytes(fileMeta.size)} &bull; Saved</span>
      </div>
    </div>
    <a href="${url}" download="${fileMeta.name}" class="btn btn-secondary" style="padding: 0.35rem 0.75rem; font-size: 0.8rem;">
      Save Again
    </a>
  `;
  receivedDownloadsList.appendChild(item);
}

// -------------------------------------------------------------
// PROGRESS & STATUS HELPERS
// -------------------------------------------------------------
function updatePeerStatusUI(el, status, text) {
  if (!el) return;
  const ring = el.querySelector('.pulse-ring');
  const txt = el.querySelector('.status-text');
  if (ring) ring.className = `pulse-ring ${status}`;
  if (txt) txt.textContent = text;
}

function updateSenderProgress(p) {
  if (p.type === 'sending') {
    senderTransferFile.textContent = `Sending (${p.fileIndex + 1}/${p.totalFiles}): ${p.fileName}`;
    senderProgressFill.style.width = `${p.percent}%`;
    senderProgressPercent.textContent = `${p.percent}%`;
    senderProgressStats.innerHTML = `
      <span>${formatBytes(p.sentBytes)} / ${formatBytes(p.totalBytes)}</span>
      <span>${formatBytes(p.speed)}/s</span>
    `;
  } else if (p.type === 'all-complete') {
    senderTransferFile.textContent = 'All files transferred!';
    senderProgressFill.style.width = '100%';
    senderProgressPercent.textContent = '100%';
    senderProgressStats.innerHTML = `<span style="color: var(--accent-emerald); font-weight: 600;">Complete</span>`;
    showToast('All files sent successfully!', 'success');
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
      <span>${formatBytes(p.speed)}/s</span>
    `;
  } else if (p.type === 'all-complete') {
    receiverTransferFile.textContent = 'All downloads finished!';
    receiverProgressFill.style.width = '100%';
    receiverProgressPercent.textContent = '100%';
    receiverProgressStats.innerHTML = `<span style="color: var(--accent-emerald); font-weight: 600;">Complete</span>`;
  }
}

btnStopShare.addEventListener('click', () => {
  window.location.reload();
});

btnLeaveReceive.addEventListener('click', () => {
  window.location.reload();
});
