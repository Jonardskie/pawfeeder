import { FOOD_LEVEL_LOW, FOOD_LEVEL_MEDIUM } from '../../lib/constants'
import './FoodLevelGauge.css'

function getLevelColor(pct) {
  if (pct <= FOOD_LEVEL_LOW)    return 'var(--red)'
  if (pct <= FOOD_LEVEL_MEDIUM) return 'var(--amber)'
  return 'var(--green)'
}

function getLevelLabel(pct) {
  if (pct <= FOOD_LEVEL_LOW)    return 'Low — Refill soon!'
  if (pct <= FOOD_LEVEL_MEDIUM) return 'Medium'
  return 'Good'
}

// SVG arc gauge math
const R = 52           // arc radius
const CX = 64, CY = 72 // center
const START_ANGLE = 210
const END_ANGLE   = 330
const TOTAL_SWEEP = START_ANGLE + END_ANGLE  // 180 used as arc range

function polarToXY(cx, cy, r, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180
  return {
    x: cx + r * Math.cos(rad),
    y: cy + r * Math.sin(rad),
  }
}

function describeArc(cx, cy, r, startAngle, endAngle) {
  const s = polarToXY(cx, cy, r, startAngle)
  const e = polarToXY(cx, cy, r, endAngle)
  const large = endAngle - startAngle > 180 ? 1 : 0
  return `M ${s.x} ${s.y} A ${r} ${r} 0 ${large} 1 ${e.x} ${e.y}`
}

export default function FoodLevelGauge({ levelPct = 68 }) {
  const pct    = Math.min(100, Math.max(0, levelPct))
  const color  = getLevelColor(pct)
  const label  = getLevelLabel(pct)

  // Arc from 150° to 390° (240° sweep total), fill proportionally
  const arcStart  = 150
  const arcEnd    = 390
  const fillEnd   = arcStart + (pct / 100) * (arcEnd - arcStart)

  const bgPath   = describeArc(CX, CY, R, arcStart, arcEnd)
  const fillPath = pct > 0 ? describeArc(CX, CY, R, arcStart, fillEnd) : ''

  // Approximate kg (assuming 4kg max hopper)
  const kgRemaining = ((pct / 100) * 4).toFixed(1)

  return (
    <div className="gauge card">
      <div className="card-header">
        <span className="card-title">Hopper Level</span>
        <span
          className={`badge ${
            pct <= FOOD_LEVEL_LOW ? 'badge-red' :
            pct <= FOOD_LEVEL_MEDIUM ? 'badge-amber' : 'badge-green'
          }`}
        >
          {label}
        </span>
      </div>

      <div className="gauge-wrap">
        <svg viewBox="0 0 128 96" className="gauge-svg">
          {/* Background track */}
          <path
            d={bgPath}
            fill="none"
            stroke="var(--bg-input)"
            strokeWidth="10"
            strokeLinecap="round"
          />
          {/* Fill arc */}
          {pct > 0 && (
            <path
              d={fillPath}
              fill="none"
              stroke={color}
              strokeWidth="10"
              strokeLinecap="round"
              style={{ filter: `drop-shadow(0 0 6px ${color})` }}
            />
          )}
        </svg>

        {/* Center text */}
        <div className="gauge-center">
          <span className="gauge-pct" style={{ color }}>{pct}%</span>
          <span className="gauge-kg">~{kgRemaining} kg remaining</span>
        </div>
      </div>

      {/* Warning threshold marker */}
      <div className="gauge-threshold">
        <div className="gauge-threshold-line" />
        <span className="gauge-threshold-label">
          Warning at {FOOD_LEVEL_LOW}%
        </span>
      </div>
    </div>
  )
}
