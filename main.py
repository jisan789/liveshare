import asyncio
import json
import logging
import os
import secrets
import time
from typing import Dict, Any, Optional
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

# Logging configuration
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("liveshare")

app = FastAPI(title="LiveShare P2P", description="Zero-bandwidth P2P file sharing with WebRTC and WebSocket signaling")

# Static files directory
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
if not os.path.exists(STATIC_DIR):
    os.makedirs(STATIC_DIR, exist_ok=True)


class Room:
    def __init__(self, room_id: str, password_hash: str, file_metadata: list):
        self.room_id = room_id
        self.password_hash = password_hash
        self.file_metadata = file_metadata
        self.uploader_ws: Optional[WebSocket] = None
        self.uploader_id: Optional[str] = None
        self.receivers: Dict[str, WebSocket] = {}  # peer_id -> WebSocket
        self.created_at = time.time()
        self.last_active = time.time()

    def update_activity(self):
        self.last_active = time.time()


class ConnectionManager:
    def __init__(self):
        self.rooms: Dict[str, Room] = {}

    def get_room(self, room_id: str) -> Optional[Room]:
        return self.rooms.get(room_id)

    def create_room(self, room_id: str, password_hash: str, file_metadata: list, ws: WebSocket, uploader_id: str) -> Room:
        room = Room(room_id=room_id, password_hash=password_hash, file_metadata=file_metadata)
        room.uploader_ws = ws
        room.uploader_id = uploader_id
        self.rooms[room_id] = room
        logger.info(f"Room [{room_id}] created by uploader [{uploader_id}]. Active rooms: {len(self.rooms)}")
        return room

    def remove_room(self, room_id: str):
        if room_id in self.rooms:
            del self.rooms[room_id]
            logger.info(f"Room [{room_id}] deleted. Active rooms: {len(self.rooms)}")

    async def send_json_safe(self, ws: WebSocket, data: dict) -> bool:
        try:
            await ws.send_json(data)
            return True
        except Exception as e:
            logger.warning(f"Error sending message to client: {e}")
            return False

    async def broadcast_to_receivers(self, room: Room, data: dict):
        for peer_id, ws in list(room.receivers.items()):
            await self.send_json_safe(ws, data)


manager = ConnectionManager()


# Periodic room cleanup for stale rooms (older than 4 hours)
async def cleanup_stale_rooms():
    while True:
        await asyncio.sleep(600)  # run every 10 min
        now = time.time()
        stale_ids = [r_id for r_id, room in manager.rooms.items() if now - room.last_active > 14400]
        for r_id in stale_ids:
            logger.info(f"Cleaning up stale room [{r_id}]")
            manager.remove_room(r_id)


@app.on_event("startup")
async def startup_event():
    asyncio.create_task(cleanup_stale_rooms())


@app.get("/health")
async def health_check():
    return {"status": "ok", "active_rooms": len(manager.rooms)}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    current_room_id: Optional[str] = None
    current_peer_id: Optional[str] = None
    is_uploader: bool = False

    try:
        while True:
            raw_data = await websocket.receive_text()
            try:
                msg = json.loads(raw_data)
            except json.JSONDecodeError:
                await manager.send_json_safe(websocket, {"type": "error", "message": "Invalid JSON format"})
                continue

            msg_type = msg.get("type")

            # Heartbeat ping/pong to keep connection alive on cloud platforms
            if msg_type == "ping":
                await manager.send_json_safe(websocket, {"type": "pong"})
                continue

            # 1. UPLOADER CREATING ROOM
            if msg_type == "create-room":
                room_id = msg.get("roomId", "").strip().upper()
                password_hash = msg.get("passwordHash", "")
                file_metadata = msg.get("fileMetadata", [])
                peer_id = msg.get("peerId", f"uploader_{secrets.token_hex(4)}")

                if not room_id or not password_hash:
                    await manager.send_json_safe(websocket, {
                        "type": "error",
                        "message": "Room Code and Password are required."
                    })
                    continue

                if room_id in manager.rooms:
                    await manager.send_json_safe(websocket, {
                        "type": "error",
                        "message": f"Room code '{room_id}' is already active. Please pick another code."
                    })
                    continue

                room = manager.create_room(room_id, password_hash, file_metadata, websocket, peer_id)
                current_room_id = room_id
                current_peer_id = peer_id
                is_uploader = True

                await manager.send_json_safe(websocket, {
                    "type": "room-created",
                    "roomId": room_id,
                    "peerId": peer_id
                })

            # 2. RECEIVER JOINING ROOM
            elif msg_type == "join-room":
                room_id = msg.get("roomId", "").strip().upper()
                password_hash = msg.get("passwordHash", "")
                peer_id = msg.get("peerId", f"receiver_{secrets.token_hex(4)}")

                room = manager.get_room(room_id)
                if not room:
                    await manager.send_json_safe(websocket, {
                        "type": "error",
                        "message": f"Room '{room_id}' not found. Make sure the uploader has created it and is online."
                    })
                    continue

                if room.password_hash != password_hash:
                    await manager.send_json_safe(websocket, {
                        "type": "error",
                        "message": "Incorrect password for this share room."
                    })
                    continue

                # Register receiver in room
                room.receivers[peer_id] = websocket
                room.update_activity()
                current_room_id = room_id
                current_peer_id = peer_id
                is_uploader = False

                logger.info(f"Receiver [{peer_id}] joined room [{room_id}]. Total receivers: {len(room.receivers)}")

                # Acknowledge receiver
                await manager.send_json_safe(websocket, {
                    "type": "room-joined",
                    "roomId": room_id,
                    "peerId": peer_id,
                    "fileMetadata": room.file_metadata,
                    "uploaderId": room.uploader_id
                })

                # Notify uploader that a receiver joined, initiating WebRTC offer
                if room.uploader_ws:
                    await manager.send_json_safe(room.uploader_ws, {
                        "type": "receiver-joined",
                        "peerId": peer_id
                    })

            # 3. WEBRTC SIGNALING RELAY (Offer, Answer, ICE Candidates)
            elif msg_type == "signal":
                target_peer_id = msg.get("targetPeerId")
                signal_data = msg.get("signalData")
                room = manager.get_room(current_room_id) if current_room_id else None

                if not room:
                    await manager.send_json_safe(websocket, {"type": "error", "message": "Room no longer exists."})
                    continue

                room.update_activity()

                payload = {
                    "type": "signal",
                    "senderPeerId": current_peer_id,
                    "signalData": signal_data
                }

                if is_uploader:
                    # Uploader sending to specific receiver
                    target_ws = room.receivers.get(target_peer_id)
                    if target_ws:
                        await manager.send_json_safe(target_ws, payload)
                    else:
                        logger.warning(f"Target receiver [{target_peer_id}] not found in room [{current_room_id}]")
                else:
                    # Receiver sending to uploader
                    if room.uploader_ws:
                        await manager.send_json_safe(room.uploader_ws, payload)
                    else:
                        logger.warning(f"Uploader not found in room [{current_room_id}]")

            # 4. UPDATE METADATA (e.g. if uploader adds/removes files)
            elif msg_type == "update-metadata":
                if is_uploader and current_room_id:
                    room = manager.get_room(current_room_id)
                    if room:
                        room.file_metadata = msg.get("fileMetadata", [])
                        await manager.broadcast_to_receivers(room, {
                            "type": "metadata-updated",
                            "fileMetadata": room.file_metadata
                        })

    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected: peer [{current_peer_id}] in room [{current_room_id}]")
    except Exception as e:
        logger.error(f"WebSocket exception: {e}")
    finally:
        if current_room_id and current_room_id in manager.rooms:
            room = manager.rooms[current_room_id]
            if is_uploader:
                # Uploader left, notify all receivers and close room
                logger.info(f"Uploader left room [{current_room_id}]. Closing room for all receivers.")
                await manager.broadcast_to_receivers(room, {
                    "type": "uploader-disconnected",
                    "message": "The uploader has disconnected. The share session has ended."
                })
                manager.remove_room(current_room_id)
            else:
                # Receiver left, notify uploader
                if current_peer_id in room.receivers:
                    del room.receivers[current_peer_id]
                    logger.info(f"Receiver [{current_peer_id}] removed from room [{current_room_id}]")
                    if room.uploader_ws:
                        await manager.send_json_safe(room.uploader_ws, {
                            "type": "receiver-disconnected",
                            "peerId": current_peer_id
                        })


# Serve Static Assets
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def read_root():
    index_file = os.path.join(STATIC_DIR, "index.html")
    if os.path.exists(index_file):
        return FileResponse(index_file)
    return {"message": "LiveShare P2P Signaling Server is running. UI loading..."}


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
