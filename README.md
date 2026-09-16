# LiveShare P2P - Zero Bandwidth WebRTC File Sharing

A high-performance, direct peer-to-peer (P2P) file sharing application built with **Python WebSocket signaling** (FastAPI) and **WebRTC DataChannels**.

Files are transferred directly browser-to-browser with **0 bytes of file data flowing through the server**. The server only acts as a lightweight signaling coordinator to exchange room credentials (password verification) and WebRTC handshakes (SDP offers/answers and ICE candidates).

![P2P Architecture](https://img.shields.io/badge/Architecture-WebRTC%20P2P-indigo)
![Signaling](https://img.shields.io/badge/Signaling-Python%20WebSocket%20(FastAPI)-emerald)
![Deployment](https://img.shields.io/badge/Deployment-Render%20Free%20Tier-cyan)
![Bandwidth](https://img.shields.io/badge/Server%20Bandwidth-0%20Bytes-success)

---

## Key Features

- ⚡ **Direct Browser-to-Browser Transfer**: Uses `RTCDataChannel` with 64KB SCTP chunking and flow control buffer handling.
- 🔒 **Password-Protected Rooms**: Uploader sets a password upon creating a share session; receivers must provide the matching password hash to connect.
- 💸 **100% Free-Tier Friendly**: Because files never touch the server, you will never hit server bandwidth or disk quotas on Render's free tier.
- 📱 **QR Code & Shareable Links**: Instant mobile joining via camera QR scan or copyable links (`/?room=CODE`).
- 📊 **Real-time Transfer Metrics**: Live progress bars, transfer speeds (MB/s), ETA calculation, and download status.
- 🎨 **Modern Dark Glassmorphism UI**: Built with responsive vanilla CSS, glowing accents, and smooth micro-animations.

---

## How It Works

```
                     +---------------------------------------+
                     |  Python FastAPI WebSocket Signaling   |
                     |             (Render.com)              |
                     +-------------------+-------------------+
                                         ^
          1. Create Room + Password Hash | 2. Join Room + Password Verification
                                         | 3. SDP & ICE Candidate Handshake
                                         v
        +-------------------------------------------------+
        |                                                 |
+-------+--------+                               +--------+-------+
|  Uploader Peer | <===========================> |  Receiver Peer |
|   (Browser)    |   Direct WebRTC DataChannel   |   (Browser)    |
+----------------+    (Zero Server Bandwidth)    +----------------+
                    Fast 64KB End-to-End Chunks
```

1. **Uploader** selects files, generates/enters a **Room Code** and sets a **Password**.
2. **Uploader** registers the room on the Python WebSocket signaling server (password is hashed using SHA-256 via Web Crypto API).
3. **Receiver** visits the page, enters the **Room Code** and **Password**.
4. The signaling server verifies the password hash and connects the two peers.
5. **WebRTC handshake** begins:
   - Uploader creates an SDP Offer.
   - Signaling server relays the Offer to Receiver.
   - Receiver responds with an SDP Answer.
   - Both peers exchange STUN ICE candidates.
6. Once the WebRTC `RTCDataChannel` is open, files are streamed in binary chunks directly between peers.
7. Receiver auto-saves/downloads the incoming files.

---

## Local Development & Testing

### 1. Prerequisites
- Python 3.8+
- `pip`

### 2. Setup
```bash
# Clone the repository
git clone https://github.com/jisan789/liveshare.git
cd liveshare

# (Optional) Create virtual environment
python -m venv venv
# On Windows:
venv\Scripts\activate
# On Linux/macOS:
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

### 3. Run the Server
```bash
python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```
Open [http://localhost:8000](http://localhost:8000) in your browser.

---

## Deploying to Render (Free Tier)

This repository includes `render.yaml` and `Procfile` preconfigured for 1-click deployment on Render.

### Option A: Via GitHub (Recommended)
1. Push this repository to your GitHub account: `https://github.com/jisan789/liveshare.git`.
2. Go to your [Render Dashboard](https://dashboard.render.com/).
3. Click **New +** > **Web Service**.
4. Connect your GitHub repository `jisan789/liveshare`.
5. Configure the following:
   - **Name**: `liveshare-p2p` (or your preferred name)
   - **Environment**: `Python 3`
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `uvicorn main:app --host 0.0.0.0 --port $PORT`
   - **Instance Type**: `Free`
6. Click **Create Web Service**.

### Option B: Via Render Blueprint
1. Go to **New +** > **Blueprint**.
2. Select your repository `jisan789/liveshare`.
3. Render will read `render.yaml` and automatically configure the service.

> **Note**: Free tier instances on Render sleep after 15 minutes of inactivity. LiveShare includes an internal 25-second WebSocket heartbeat (`ping`/`pong`) to keep sessions active while users are transferring files.

---

## Security & Privacy

- **Zero Storage**: Files are never stored on disk, RAM, or cache of the server.
- **Direct Encryption**: WebRTC `RTCDataChannel` uses DTLS (Datagram Transport Layer Security) and SCTP encryption by default.
- **Password Protection**: Room access is protected by password authentication before signaling messages are routed.

---

## License

MIT License - feel free to use and customize for personal or commercial projects.