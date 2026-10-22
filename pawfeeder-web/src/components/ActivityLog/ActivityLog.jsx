import { useState } from 'react'
import './ActivityLog.css'

const MOCK_EVENTS = [
  { id: 1, source: 'remote', grams: 150, minutesAgo: 2  },
  { id: 2, source: 'coin',   grams: 75,  minutesAgo: 18 },
  { id: 3, source: 'remote', grams: 30,  minutesAgo: 45 },
  { id: 4, source: 'bill',   grams: 300, minutesAgo: 92 },
  { id: 5, source: 'coin',   grams: 75,  minutesAgo: 134},
  { id: 6, source: 'remote', grams: 150, minutesAgo: 210},
]

const FILTERS = ['all', 'remote', 'on-site']

function formatTime(minutesAgo) {
  if (minutesAgo < 60) return `${minutesAgo}m ago`
  const h = Math.floor(minutesAgo / 60)
  const m = minutesAgo % 60
  return m > 0 ? `${h}h ${m}m ago` : `${h}h ago`
}

function isOnSite(source) {
  return source === 'coin' || source === 'bill'
}

export default function ActivityLog() {
  const [filter, setFilter] = useState('all')

  const filtered = MOCK_EVENTS.filter(e => {
    if (filter === 'all')     return true
    if (filter === 'remote')  return e.source === 'remote'
    if (filter === 'on-site') return isOnSite(e.source)
    return true
  })

  return (
    <div className="activity card">
      <div className="card-header">
        <span className="card-title">Recent Activity</span>
      </div>

      {/* Filter pills */}
      <div className="activity-filters">
        {FILTERS.map(f => (
          <button
            key={f}
            className={`activity-filter-pill ${filter === f ? 'activity-filter-pill--active' : ''}`}
            onClick={() => setFilter(f)}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {/* Event list */}
      <div className="activity-list">
        {filtered.length === 0 ? (
          <p className="activity-empty">No events match this filter.</p>
        ) : (
          filtered.map(event => (
            <div key={event.id} className="activity-item animate-fade-in">
              <span className={`dot ${isOnSite(event.source) ? 'dot-muted' : 'dot-green'}`} />
              <div className="activity-item-info">
                <span className="activity-item-grams">{event.grams}g dispensed</span>
                <span className="activity-item-time">{formatTime(event.minutesAgo)}</span>
              </div>
              <span className={`badge ${isOnSite(event.source) ? 'badge-accent' : 'badge-green'} activity-item-badge`}>
                {isOnSite(event.source)
                  ? event.source.charAt(0).toUpperCase() + event.source.slice(1)
                  : 'Remote'}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
