import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { v4 as uuidv4 } from "uuid";

const LANGUAGES = [
  { code: "en-US", label: "English" },
  { code: "hi-IN", label: "Hindi" },
  { code: "es-ES", label: "Spanish" },
  { code: "fr-FR", label: "French" },
  { code: "de-DE", label: "German" },
  { code: "zh-CN", label: "Chinese" },
  { code: "ja-JP", label: "Japanese" },
  { code: "ar-SA", label: "Arabic" },
  { code: "pt-BR", label: "Portuguese" },
  { code: "ru-RU", label: "Russian" },
];

export default function Home() {
  const navigate = useNavigate();
  const [userName, setUserName] = useState("");
  const [roomId, setRoomId] = useState("");
  const [language, setLanguage] = useState("en-US");
  const [error, setError] = useState("");

  const validate = () => {
    if (!userName.trim()) { setError("Please enter your name."); return false; }
    setError("");
    return true;
  };

  const handleCreate = () => {
    if (!validate()) return;
    navigate(`/room/${uuidv4().slice(0, 8)}`, { state: { userName: userName.trim(), language } });
  };

  const handleJoin = () => {
    if (!validate()) return;
    if (!roomId.trim()) { setError("Please enter a Room ID to join."); return; }
    navigate(`/room/${roomId.trim()}`, { state: { userName: userName.trim(), language } });
  };

  return (
    <div className="home-container">
      <div className="home-card">

        {/* Logo */}
        <div className="logo">
          <div className="logo-icon">
            <svg viewBox="0 0 24 24" fill="none">
              <path d="M15 10l4.553-2.277A1 1 0 0121 8.723v6.554a1 1 0 01-1.447.894L15 14M4 8h11a1 1 0 011 1v6a1 1 0 01-1 1H4a1 1 0 01-1-1V9a1 1 0 011-1z"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <span className="logo-text">VideoCall</span>
        </div>

        <p className="home-subtitle">Crystal-clear HD calls, right in your browser.</p>

        {/* Feature chips */}
        <div className="feature-chips">
          {[["HD Video", true], ["Encrypted", true], ["No Install", true]].map(([label]) => (
            <span key={label} className="chip">
              <svg viewBox="0 0 24 24" fill="none">
                <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              {label}
            </span>
          ))}
        </div>

        {/* Name */}
        <div className="form-group">
          <label htmlFor="userName">Your Name</label>
          <div className="input-wrapper">
            <input
              id="userName"
              type="text"
              placeholder="Enter your name"
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              maxLength={30}
              autoComplete="off"
            />
            <svg className="input-icon" viewBox="0 0 24 24" fill="none">
              <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 3a4 4 0 100 8 4 4 0 000-8z"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
        </div>

        {/* Caption Language */}
        <div className="form-group">
          <label htmlFor="language">Your Language (Captions &amp; Voice)</label>
          <div className="select-wrapper">
            <select
              id="language"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
            >
              {LANGUAGES.map(({ code, label }) => (
                <option key={code} value={code}>{label}</option>
              ))}
            </select>
            <svg className="select-chevron" viewBox="0 0 24 24" fill="none">
              <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
        </div>

        <p className="section-label">Create a new room</p>
        <button className="btn btn-primary" onClick={handleCreate}>
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M15 10l4.553-2.277A1 1 0 0121 8.723v6.554a1 1 0 01-1.447.894L15 14M4 8h11a1 1 0 011 1v6a1 1 0 01-1 1H4a1 1 0 01-1-1V9a1 1 0 011-1z"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Start New Call
        </button>

        <div className="divider"><span>or join with a Room ID</span></div>

        {/* Room ID */}
        <div className="form-group">
          <label htmlFor="roomId">Room ID</label>
          <div className="input-wrapper">
            <input
              id="roomId"
              type="text"
              placeholder="Paste room ID here"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleJoin()}
              autoComplete="off"
            />
            <svg className="input-icon" viewBox="0 0 24 24" fill="none">
              <path d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </div>
        </div>

        <button className="btn btn-secondary" onClick={handleJoin}>
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4M10 17l5-5-5-5M15 12H3"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Join Room
        </button>

        {error && (
          <p className="error-msg">
            <svg viewBox="0 0 24 24" fill="none" style={{width:14,height:14,flexShrink:0}}>
              <path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            {error}
          </p>
        )}

      </div>
    </div>
  );
}
