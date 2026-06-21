# VideoCall — React + WebRTC + Python + Socket.io

A browser-based, peer-to-peer video calling app. Two people can video-call each other in real time by sharing a Room ID.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 (Vite), React Router v6 |
| Peer-to-peer media | WebRTC (browser native) |
| Signaling | Socket.io v4 |
| Backend | Python (FastAPI + python-socketio) |
| Live captions & translation | Web Speech API + Google Gemini |

## Project Structure

```
videoCallingApp/
├── server/          ← Python signaling server (port 5000)
│   ├── main.py
│   ├── requirements.txt
│   └── .env         ← GEMINI_API_KEY for translation
└── client/          ← React frontend (port 5173)
    └── src/
        ├── socket.js
        ├── App.jsx
        └── components/
            ├── Home.jsx
            ├── Room.jsx
            └── VideoPlayer.jsx
```

## Getting Started

### 1. Start the signaling server

```bash
cd server
pip install -r requirements.txt
python main.py
```

Create a `server/.env` file with your Gemini API key for live translation:

```
GEMINI_API_KEY=your-key-here
```

The server starts on `http://localhost:5000`.

### 2. Start the React client

```bash
cd client
npm install
npm run dev
```

The app opens at `https://localhost:5173`.

### 3. Make a call

1. Open `https://localhost:5173` in **two browser tabs** (Chrome or Edge — required for live captions).
2. In the first tab: enter your name → choose a caption language → click **Start New Call** → copy the Room ID.
3. In the second tab: enter a name → choose a different caption language → paste the Room ID → click **Join Room**.
4. Both browsers will start the video call automatically. Speak with the mic unmuted and CC enabled to see live captions.

## Features

- HD video + audio via WebRTC (peer-to-peer, no media relay needed on LAN)
- Live captions with cross-language translation (Gemini)
- Mute / unmute microphone
- Enable / disable camera
- Leave call button
- Room ID copy-to-clipboard
- Responsive dark-theme UI
- Supports up to 2 participants per room
