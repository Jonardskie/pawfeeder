import { useState } from 'react'
import { Scale, RotateCcw, CheckCircle2 } from 'lucide-react'
import { ref, set } from 'firebase/database'
import './BowlWeightCard.css'

export default function BowlWeightCard({ db, weight = 0, online = false }) {
  const [taring, setTaring] = useState(false)
  const currentWeight = Math.max(0, Number(weight) || 0)

  // Max scale visual limit for bowl (200g)
  const MAX_BOWL_CAPACITY = 200
  const fillPercent = Math.min(100, Math.round((currentWeight / MAX_BOWL_CAPACITY) * 100))

  const handleTare = async () => {
    if (!db || taring) return
    setTaring(true)
    try {
      await set(ref(db, 'feeder/unit001/cmd/tare'), true)
      setTimeout(() => setTaring(false), 2000)
    } catch (e) {
      console.error('Tare failed:', e)
      setTaring(false)
    }
  }

  const getStatusBadge = () => {
    if (!online) return { label: 'Offline', color: 'badge-muted' }
    if (currentWeight < 5) return { label: 'Bowl Empty', color: 'badge-amber' }
    if (currentWeight < 80) return { label: 'Food Available', color: 'badge-green' }
    return { label: 'Full Bowl', color: 'badge-cyan' }
  }

  const status = getStatusBadge()

  return (
    <div className="bowl-card card">
      <div className="card-header">
        <div className="bowl-card-title-wrap">
          <span className="card-title">Live Bowl Scale</span>
          {online && (
            <span className="bowl-live-pulse" title="Live load cell sensor active">
              <span className="bowl-live-dot" />
              LIVE
            </span>
          )}
        </div>
        <span className={`badge ${status.color}`}>
          {status.label}
        </span>
      </div>

      <div className="bowl-weight-main">
        <div className="bowl-weight-icon-wrap">
          <Scale size={28} className="bowl-scale-icon" />
        </div>
        <div className="bowl-weight-digits">
          <span className="bowl-weight-val">{currentWeight.toFixed(1)}</span>
          <span className="bowl-weight-unit">grams</span>
        </div>
      </div>

      {/* Visual Capacity Bar */}
      <div className="bowl-progress-section">
        <div className="bowl-progress-labels">
          <span>0.0g (Empty)</span>
          <span>{fillPercent}% ({currentWeight.toFixed(1)}g)</span>
          <span>200.0g (Full)</span>
        </div>
        <div className="bowl-progress-track">
          <div
            className="bowl-progress-fill"
            style={{
              width: `${Math.max(4, fillPercent)}%`,
              backgroundColor: currentWeight < 5 ? 'var(--amber)' : 'var(--green)'
            }}
          />
        </div>
      </div>

      {/* Quick Tare Action */}
      <div className="bowl-card-footer">
        <button
          className="bowl-tare-btn"
          onClick={handleTare}
          disabled={!online || taring}
          title="Zero out the scale (assumes bowl is empty)"
        >
          <RotateCcw size={13} className={taring ? 'spin-icon' : ''} />
          {taring ? 'Zeroing Scale...' : 'Zero Scale (Tare)'}
        </button>
        <span className="bowl-footer-hint">
          {online ? 'Updates automatically via HX711' : 'Waiting for device...'}
        </span>
      </div>
    </div>
  )
}
