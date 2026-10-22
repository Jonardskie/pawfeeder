import { useState, useRef, useCallback, useEffect } from 'react'
import { Maximize2, RefreshCw, WifiOff, Signal, Zap, Globe, Lightbulb } from 'lucide-react'
import { ref, onValue, set } from 'firebase/database'
import { db } from '../../lib/firebase'
import './LiveFeed.css'

const STATUS = {
  LOADING:   'loading',
  STREAMING: 'streaming',
  ERROR:     'error',
}

const CLOUD_STREAM_URL = 'https://pawfeeder-or3n.onrender.com/stream'
const CLOUD_LAMP_URL = 'https://pawfeeder-or3n.onrender.com/lamp'

export default function LiveFeed() {
  const [status, setStatus] = useState(STATUS.STREAMING)
  const [streamKey, setStreamKey] = useState(0)
  const [streamMode, setStreamMode] = useState(() => {
    return localStorage.getItem('pawfeeder_cam_mode') || 'cloud'
  })
  const [localIp, setLocalIp] = useState('192.168.100.237')
  const [nightLight, setNightLight] = useState(false)
  const [lampBusy, setLampBusy] = useState(false)
  const imgRef = useRef(null)

  // Listen to Firebase for real-time camera IP and lamp state
  useEffect(() => {
    if (!db) return
    const camRef = ref(db, 'feeder/unit001/camera')
    const unsub = onValue(camRef, (snapshot) => {
      const data = snapshot.val()
      if (data?.ip) {
        setLocalIp(data.ip)
      }
      if (data?.lamp !== undefined) {
        setNightLight(Boolean(data.lamp))
      }
    })
    return () => unsub()
  }, [])

  // Calculate active stream URL based on mode
  const activeBaseUrl = streamMode === 'local' 
    ? `http://${localIp}/stream` 
    : CLOUD_STREAM_URL

  const streamUrl = `${activeBaseUrl}${streamKey > 0 ? (activeBaseUrl.includes('?') ? `&r=${streamKey}` : `?r=${streamKey}`) : ''}`

  const handleModeChange = (mode) => {
    if (mode === streamMode) return
    setStreamMode(mode)
    localStorage.setItem('pawfeeder_cam_mode', mode)
    setStatus(STATUS.STREAMING)
    setStreamKey(k => k + 1)
  }

  const handleToggleNightLight = async () => {
    const nextState = !nightLight
    setNightLight(nextState)
    setLampBusy(true)

    // 1. Update Firebase
    if (db) {
      try {
        await set(ref(db, 'feeder/unit001/camera/lamp'), nextState)
      } catch (err) {
        console.warn('[Firebase] Lamp update failed:', err)
      }
    }

    // 2. Notify Cloud Relay
    fetch(`${CLOUD_LAMP_URL}?state=${nextState ? '1' : '0'}`)
      .catch(err => console.warn('[Cloud Lamp] Error:', err))

    // 3. If in local mode, also ping direct local IP
    if (streamMode === 'local') {
      fetch(`http://${localIp}/lamp?state=${nextState ? '1' : '0'}`, { mode: 'no-cors' })
        .catch(err => console.warn('[Local Lamp] Error:', err))
    }

    setTimeout(() => setLampBusy(false), 400)
  }

  const handleStreamError = useCallback(() => {
    setStatus(STATUS.ERROR)
  }, [])

  const handleRetry = useCallback(() => {
    setStatus(STATUS.STREAMING)
    setStreamKey(k => k + 1)
  }, [])

  const handleFullscreen = useCallback(() => {
    if (imgRef.current) {
      document.fullscreenElement
        ? document.exitFullscreen()
        : imgRef.current.requestFullscreen?.()
    }
  }, [])

  return (
    <div className="livefeed card">
      {/* Header */}
      <div className="livefeed-header">
        <div className="livefeed-title-row">
          <span className="card-title">Live Feed</span>
          {status === STATUS.STREAMING && (
            <span className="badge badge-red livefeed-live-badge">
              <span className="livefeed-live-dot" />
              LIVE
            </span>
          )}
        </div>

        {/* Dual Mode Switcher: Local Fast (LAN) vs Cloud Remote (Global) */}
        <div className="livefeed-mode-switcher">
          <button
            type="button"
            className={`livefeed-mode-btn ${streamMode === 'local' ? 'active' : ''}`}
            onClick={() => handleModeChange('local')}
            title="Fast direct stream for home WiFi (25-30 FPS ultra-smooth)"
          >
            <Zap size={13} className="mode-icon-zap" />
            <span>Local LAN</span>
          </button>
          <button
            type="button"
            className={`livefeed-mode-btn ${streamMode === 'cloud' ? 'active' : ''}`}
            onClick={() => handleModeChange('cloud')}
            title="Cloud relay stream accessible from mobile data anywhere in the world"
          >
            <Globe size={13} className="mode-icon-globe" />
            <span>Cloud Remote</span>
          </button>
        </div>
      </div>

      {/* Viewport */}
      <div className="livefeed-viewport">
        {/* MJPEG stream */}
        <img
          ref={imgRef}
          key={`${streamMode}-${streamKey}`}
          src={streamUrl}
          alt="ESP32-CAM live stream"
          className={`livefeed-img ${status === STATUS.STREAMING ? 'livefeed-img--visible' : ''}`}
          onError={handleStreamError}
        />

        {/* Loading overlay */}
        {status === STATUS.LOADING && (
          <div className="livefeed-overlay">
            <div className="livefeed-spinner" />
            <p className="livefeed-overlay-text">Connecting to camera...</p>
            <p className="livefeed-overlay-sub">{activeBaseUrl}</p>
          </div>
        )}

        {/* Error overlay */}
        {status === STATUS.ERROR && (
          <div className="livefeed-overlay">
            <WifiOff size={36} color="var(--text-muted)" strokeWidth={1.5} />
            <p className="livefeed-overlay-text">
              {streamMode === 'local' ? 'Local Camera Unreachable' : 'Cloud Camera Offline'}
            </p>
            <p className="livefeed-overlay-sub">
              {streamMode === 'local'
                ? `Make sure you are on home WiFi (Target: ${localIp})`
                : 'Target: pawfeeder-or3n.onrender.com'}
            </p>
            <div className="livefeed-error-actions">
              <button className="livefeed-retry-btn" onClick={handleRetry}>
                <RefreshCw size={14} />
                Retry
              </button>
              {streamMode === 'local' && (
                <button 
                  className="livefeed-switch-fallback-btn"
                  onClick={() => handleModeChange('cloud')}
                >
                  <Globe size={14} />
                  Switch to Cloud Mode
                </button>
              )}
            </div>
          </div>
        )}

        {/* Bottom bar controls */}
        {status === STATUS.STREAMING && (
          <div className="livefeed-bottom-bar">
            <div className="livefeed-bar-left">
              <Signal size={13} />
              <span>{streamMode === 'local' ? 'LAN 30 FPS' : 'Cloud 480p'}</span>
            </div>

            <div className="livefeed-bar-right">
              {/* Night Light Fill-LED Toggle */}
              <button
                type="button"
                className={`livefeed-control-btn livefeed-lamp-btn ${nightLight ? 'lamp-on' : ''}`}
                onClick={handleToggleNightLight}
                disabled={lampBusy}
                title={nightLight ? 'Turn off Night Light' : 'Turn on Night Light'}
              >
                <Lightbulb size={14} className={nightLight ? 'lamp-glow-icon' : ''} />
                <span>{nightLight ? 'Light ON' : 'Night Light'}</span>
              </button>

              {/* Fullscreen Button */}
              <button
                type="button"
                className="livefeed-control-btn livefeed-fullscreen-btn"
                onClick={handleFullscreen}
                title="Fullscreen"
              >
                <Maximize2 size={14} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
