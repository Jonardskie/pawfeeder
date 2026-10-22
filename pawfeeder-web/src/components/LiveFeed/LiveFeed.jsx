import { useState, useRef, useCallback, useEffect } from 'react'
import { Maximize2, RefreshCw, WifiOff, Signal } from 'lucide-react'
import { ref, onValue } from 'firebase/database'
import { db } from '../../lib/firebase'
import { CAMERA_STREAM_URL } from '../../lib/constants'
import './LiveFeed.css'

const STATUS = {
  LOADING:   'loading',
  STREAMING: 'streaming',
  ERROR:     'error',
}

export default function LiveFeed() {
  const [status, setStatus]             = useState(STATUS.STREAMING)
  const [streamKey, setStreamKey]       = useState(0)
  const [streamBaseUrl, setStreamBaseUrl] = useState(CAMERA_STREAM_URL)
  const imgRef = useRef(null)

  // Listen to Firebase for real-time camera IP / stream URL published by the ESP32-CAM
  useEffect(() => {
    if (!db) return
    const camRef = ref(db, 'feeder/unit001/camera')
    const unsub = onValue(camRef, (snapshot) => {
      const data = snapshot.val()
      if (data?.stream_url) {
        setStreamBaseUrl(data.stream_url)
        setStatus(STATUS.STREAMING)
      } else if (data?.ip) {
        setStreamBaseUrl(`http://${data.ip}/stream`)
        setStatus(STATUS.STREAMING)
      }
    })
    return () => unsub()
  }, [])

  const streamUrl = `${streamBaseUrl}${streamKey > 0 ? (streamBaseUrl.includes('?') ? `&r=${streamKey}` : `?r=${streamKey}`) : ''}`

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
        <span className="livefeed-cam-label">ESP32-CAM</span>
      </div>

      {/* Viewport */}
      <div className="livefeed-viewport">

        {/* MJPEG stream — visibility controlled by CSS opacity */}
        <img
          ref={imgRef}
          key={streamKey}
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
            <p className="livefeed-overlay-sub">{streamBaseUrl}</p>
          </div>
        )}

        {/* Error overlay */}
        {status === STATUS.ERROR && (
          <div className="livefeed-overlay">
            <WifiOff size={36} color="var(--text-muted)" strokeWidth={1.5} />
            <p className="livefeed-overlay-text">Camera offline</p>
            <p className="livefeed-overlay-sub">
              Target: {streamBaseUrl}
            </p>
            <button className="livefeed-retry-btn" onClick={handleRetry}>
              <RefreshCw size={14} />
              Retry
            </button>
          </div>
        )}

        {/* Bottom bar */}
        {status === STATUS.STREAMING && (
          <div className="livefeed-bottom-bar">
            <div className="livefeed-bar-left">
              <Signal size={13} />
              <span>480p</span>
            </div>
            <button
              className="livefeed-fullscreen-btn"
              onClick={handleFullscreen}
              title="Fullscreen"
            >
              <Maximize2 size={14} />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
