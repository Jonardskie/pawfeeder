import { useState, useEffect } from 'react'
import { ref, onValue } from 'firebase/database'
import './ActivityLog.css'

const FILTERS = ['all', 'gcash', 'coin']

function formatRelativeTime(ts) {
  if (!ts) return ''
  const diffSec = Math.floor((Date.now() - ts) / 1000)
  if (diffSec < 60) return 'Just now'
  const min = Math.floor(diffSec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const days = Math.floor(hr / 24)
  return `${days}d ago`
}

export default function ActivityLog({ db, unitId = 'unit001' }) {
  const [filter, setFilter] = useState('all')
  const [donations, setDonations] = useState([])

  useEffect(() => {
    if (!db) return
    const donRef = ref(db, `feeder/${unitId}/donations`)
    const unsub = onValue(donRef, (snapshot) => {
      if (snapshot.exists()) {
        const val = snapshot.val()
        const list = Object.entries(val).map(([key, item]) => ({
          id: key,
          ...item,
        }))
        // Sort descending by timestamp
        list.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
        setDonations(list)
      } else {
        setDonations([])
      }
    })
    return () => unsub()
  }, [db, unitId])

  const filtered = donations.filter(e => {
    if (filter === 'all') return true
    if (filter === 'gcash') return e.source === 'gcash_online' || e.refCode
    if (filter === 'coin') return e.source === 'coin' || e.source === 'coin_slot'
    return true
  })

  return (
    <div className="activity card">
      <div className="card-header">
        <span className="card-title">Recent Donations & Activity</span>
        <span className="badge badge-accent">{donations.length} total</span>
      </div>

      {/* Filter pills */}
      <div className="activity-filters">
        {FILTERS.map(f => (
          <button
            key={f}
            className={`activity-filter-pill ${filter === f ? 'activity-filter-pill--active' : ''}`}
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? 'All' : f === 'gcash' ? 'GCash' : 'Coin Slot'}
          </button>
        ))}
      </div>

      {/* Event list */}
      <div className="activity-list">
        {filtered.length === 0 ? (
          <p className="activity-empty">No activity records yet.</p>
        ) : (
          filtered.slice(0, 15).map(event => {
            const isGCash = event.source === 'gcash_online' || !!event.refCode
            return (
              <div key={event.id} className="activity-item animate-fade-in">
                <span className={`dot ${isGCash ? 'dot-green' : 'dot-muted'}`} />
                <div className="activity-item-info">
                  <span className="activity-item-grams">
                    {event.donorName ? <strong>{event.donorName}</strong> : `${event.grams || 50}g dispensed`}
                    {event.amountPhp ? ` • ₱${event.amountPhp}` : ''}
                  </span>
                  {event.message && (
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                      &ldquo;{event.message}&rdquo;
                    </span>
                  )}
                  <span className="activity-item-time">{formatRelativeTime(event.timestamp)}</span>
                </div>
                <span className={`badge ${isGCash ? 'badge-green' : 'badge-accent'} activity-item-badge`}>
                  {isGCash ? 'GCash' : 'Coin Slot'}
                </span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
