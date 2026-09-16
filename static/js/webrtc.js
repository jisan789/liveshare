/**
 * LiveShare WebRTC DataChannel Engine
 * Handles PeerConnection setup, STUN negotiation, and high-speed chunked P2P transfer with flow control.
 */

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ]
};

const CHUNK_SIZE = 64 * 1024; // 64 KB per chunk
const BUFFER_THRESHOLD = 2 * 1024 * 1024; // 2 MB buffer safety limit

class WebRTCPeer {
  constructor(peerId, isInitiator, onSignal, onStatusChange, onProgress, onFileReceived) {
    this.peerId = peerId;
    this.isInitiator = isInitiator;
    this.onSignal = onSignal;
    this.onStatusChange = onStatusChange;
    this.onProgress = onProgress;
    this.onFileReceived = onFileReceived;

    this.pc = new RTCPeerConnection(RTC_CONFIG);
    this.dataChannel = null;
    this.currentReceivingFile = null;
    this.receivedChunks = [];
    this.receivedBytes = 0;
    this.transferStartTime = 0;

    this._initPeerConnection();
  }

  _initPeerConnection() {
    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.onSignal(this.peerId, {
          type: 'candidate',
          candidate: event.candidate
        });
      }
    };

    this.pc.onconnectionstatechange = () => {
      console.log(`[WebRTC] Peer ${this.peerId} state:`, this.pc.connectionState);
      this.onStatusChange(this.peerId, this.pc.connectionState);
    };

    if (this.isInitiator) {
      // Uploader creates the data channel
      this.dataChannel = this.pc.createDataChannel('fileTransfer', {
        ordered: true
      });
      this._setupDataChannel();
    } else {
      // Receiver waits for the data channel
      this.pc.ondatachannel = (event) => {
        this.dataChannel = event.channel;
        this._setupDataChannel();
      };
    }
  }

  _setupDataChannel() {
    this.dataChannel.binaryType = 'arraybuffer';
    this.dataChannel.bufferedAmountLowThreshold = 512 * 1024; // 512 KB

    this.dataChannel.onopen = () => {
      console.log(`[WebRTC] DataChannel OPEN with ${this.peerId}`);
      this.onStatusChange(this.peerId, 'connected');
    };

    this.dataChannel.onclose = () => {
      console.log(`[WebRTC] DataChannel CLOSED with ${this.peerId}`);
      this.onStatusChange(this.peerId, 'disconnected');
    };

    this.dataChannel.onerror = (error) => {
      console.error(`[WebRTC] DataChannel ERROR:`, error);
    };

    this.dataChannel.onmessage = (event) => {
      this._handleDataChannelMessage(event.data);
    };
  }

  _handleDataChannelMessage(data) {
    if (typeof data === 'string') {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'file-start') {
          this.currentReceivingFile = msg;
          this.receivedChunks = [];
          this.receivedBytes = 0;
          this.transferStartTime = Date.now();
          console.log(`[WebRTC] Starting receipt of file:`, msg.name);
          this.onProgress({
            type: 'start',
            file: msg,
            percent: 0,
            speed: 0,
            eta: 0
          });
        } else if (msg.type === 'file-end') {
          console.log(`[WebRTC] File download complete:`, this.currentReceivingFile.name);
          const blob = new Blob(this.receivedChunks, {
            type: this.currentReceivingFile.mimeType || 'application/octet-stream'
          });
          this.onFileReceived(this.currentReceivingFile, blob);
          this.currentReceivingFile = null;
          this.receivedChunks = [];
        } else if (msg.type === 'all-transfers-done') {
          this.onProgress({ type: 'all-complete' });
        }
      } catch (e) {
        console.error('Error parsing control message:', e);
      }
    } else if (data instanceof ArrayBuffer) {
      if (!this.currentReceivingFile) return;

      this.receivedChunks.push(data);
      this.receivedBytes += data.byteLength;

      const totalSize = this.currentReceivingFile.size;
      const percent = Math.min(100, Math.round((this.receivedBytes / totalSize) * 100));
      const elapsedTime = (Date.now() - this.transferStartTime) / 1000;
      const speed = elapsedTime > 0 ? this.receivedBytes / elapsedTime : 0;
      const remainingBytes = totalSize - this.receivedBytes;
      const eta = speed > 0 ? Math.ceil(remainingBytes / speed) : 0;

      this.onProgress({
        type: 'transferring',
        file: this.currentReceivingFile,
        percent,
        transferredBytes: this.receivedBytes,
        totalBytes: totalSize,
        speed,
        eta
      });
    }
  }

  async createOffer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.onSignal(this.peerId, {
      type: 'offer',
      sdp: this.pc.localDescription
    });
  }

  async handleOffer(offerSdp) {
    await this.pc.setRemoteDescription(new RTCSessionDescription(offerSdp));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.onSignal(this.peerId, {
      type: 'answer',
      sdp: this.pc.localDescription
    });
  }

  async handleAnswer(answerSdp) {
    await this.pc.setRemoteDescription(new RTCSessionDescription(answerSdp));
  }

  async handleCandidate(candidate) {
    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.warn('Error adding ICE candidate:', e);
    }
  }

  async sendFiles(fileList) {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      throw new Error('WebRTC DataChannel is not open');
    }

    for (let fileIndex = 0; fileIndex < fileList.length; fileIndex++) {
      const file = fileList[fileIndex];
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

      // Send file metadata header
      this.dataChannel.send(JSON.stringify({
        type: 'file-start',
        fileId: `f_${Date.now()}_${fileIndex}`,
        name: file.name,
        size: file.size,
        mimeType: file.type,
        totalChunks
      }));

      const startTime = Date.now();
      let sentBytes = 0;

      // Stream file in chunks using FileReader
      for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
        const slice = file.slice(offset, offset + CHUNK_SIZE);
        const buffer = await slice.arrayBuffer();

        // Flow control: wait if buffer exceeds threshold
        if (this.dataChannel.bufferedAmount > BUFFER_THRESHOLD) {
          await new Promise((resolve) => {
            this.dataChannel.onbufferedamountlow = () => {
              this.dataChannel.onbufferedamountlow = null;
              resolve();
            };
          });
        }

        this.dataChannel.send(buffer);
        sentBytes += buffer.byteLength;

        const percent = Math.min(100, Math.round((sentBytes / file.size) * 100));
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = elapsed > 0 ? sentBytes / elapsed : 0;
        const remainingBytes = file.size - sentBytes;
        const eta = speed > 0 ? Math.ceil(remainingBytes / speed) : 0;

        this.onProgress({
          type: 'sending',
          fileIndex,
          fileName: file.name,
          totalFiles: fileList.length,
          percent,
          sentBytes,
          totalBytes: file.size,
          speed,
          eta
        });
      }

      // Signal completion for this file
      this.dataChannel.send(JSON.stringify({ type: 'file-end' }));
      // Small pause between multiple files
      await new Promise((r) => setTimeout(r, 100));
    }

    this.dataChannel.send(JSON.stringify({ type: 'all-transfers-done' }));
    this.onProgress({ type: 'all-complete' });
  }

  close() {
    if (this.dataChannel) {
      this.dataChannel.close();
    }
    if (this.pc) {
      this.pc.close();
    }
  }
}
