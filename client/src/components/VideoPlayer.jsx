function initials(name = "") {
  return name.trim().split(/\s+/).map((w) => w[0]).join("").toUpperCase().slice(0, 2) || "?";
}

export default function VideoPlayer({
  videoRef,
  label,
  userName = "",
  isLocal = false,
  isMuted = false,       // audio muted on the <video> element (local = always true)
  isMicOff = false,      // remote peer has muted their mic
  isCameraOff = false,
  compact = false,
  showConn = false,
}) {
  return (
    <div className={`video-tile ${isLocal ? "local-tile" : "remote-tile"} ${compact ? "compact" : ""}`}>

      {/* Video element */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={isMuted}
        className={`video-el ${isCameraOff ? "hidden" : ""}`}
        style={{ imageRendering: "high-quality" }}
      />

      {/* Camera-off overlay — shows avatar with initials */}
      {isCameraOff && (
        <div className="camera-off-placeholder">
          <div className={`avatar-circle ${compact ? "small" : ""}`}>
            {initials(userName)}
          </div>
          {!compact && <span className="camera-off-name">{label}</span>}
        </div>
      )}

      {/* Muted mic badge — top-right corner (only for remote peer) */}
      {isMicOff && !isLocal && (
        <div className="muted-badge" title="Microphone off">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M1 1l22 22M9 9v3a3 3 0 005.12 2.12M15 9.34V4a3 3 0 00-5.94-.6M17 16.95A7 7 0 015 12v-2m14 0v2a7 7 0 01-.11 1.23M12 19v3M8 23h8"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
      )}

      {/* Name + status label — bottom left */}
      <div className="video-label">
        {showConn && <span className="conn-dot" />}
        <span className="video-label-name">{label}</span>
        {isMicOff && !isLocal && (
          <span className="label-status-icon" title="Muted">
            <svg viewBox="0 0 24 24" fill="none">
              <path d="M1 1l22 22M9 9v3a3 3 0 005.12 2.12M15 9.34V4a3 3 0 00-5.94-.6M17 16.95A7 7 0 015 12v-2m14 0v2a7 7 0 01-.11 1.23M12 19v3M8 23h8"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </span>
        )}
        {isCameraOff && (
          <span className="label-status-icon" title="Camera off">
            <svg viewBox="0 0 24 24" fill="none">
              <path d="M16 16v1a2 2 0 01-2 2H3a2 2 0 01-2-2V7a2 2 0 012-2h2m5.66 0H14a2 2 0 012 2v3.34l1 1L23 7v10M1 1l22 22"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </span>
        )}
      </div>

    </div>
  );
}
