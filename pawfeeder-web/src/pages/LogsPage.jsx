import { useState, useEffect } from 'react'
import { ref, onValue } from 'firebase/database'
import { ScrollText, Search, ShieldCheck, Scale } from 'lucide-react'
import './LogsPage.css'

export default function LogsPage({ db, unitId = 'unit001' }) {
  const [donations, setDonations]       = useState([])
  const [lastDispense, setLastDispense] = useState(null)
  const [filter, setFilter]             = useState('all')
  const [search, setSearch]             = useState('')

  useEffect(() => {
    if (!db) return
    const donRef = ref(db, `feeder/${unitId}/donations`)
    const unsubDon = onValue(donRef, (snap) => {
      if (snap.exists()) {
        const list = Object.entries(snap.val()).map(([id, item]) => ({ id, ...item }))
        list.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
        setDonations(list)
      } else {
        setDonations([])
      }
    })

    const dispRef = ref(db, `feeder/${unitId}/event/last_dispense`)
    const unsubDisp = onValue(dispRef, (snap) => {
      if (snap.exists()) setLastDispense(snap.val())
    })

    return () => {
      unsubDon()
      unsubDisp()
    }
  }, [db, unitId])

  const filtered = donations.filter(item => {
    if (filter === 'gcash' && !(item.source === 'gcash_online' || item.refCode)) return false
    if (filter === 'coin' && !(item.source === 'coin' || item.source === 'coin_slot')) return false
    if (filter === 'admin' && item.source !== 'admin_manual') return false

    if (search.trim()) {
      const q = search.trim().toLowerCase()
      const nameMatch = (item.donorName || '').toLowerCase().includes(q)
      const refMatch  = (item.refCode || '').toLowerCase().includes(q)
      const msgMatch  = (item.message || '').toLowerCase().includes(q)
      return nameMatch || refMatch || msgMatch
    }
    return true
  })

  return (
    <div className="logs-page">
      <div className="logs-page-header">
        <div>
          <h1 className="logs-page-title">Dispense &amp; Donation Logs</h1>
          <p className="logs-page-subtitle">
            Complete audit trail of GCash donations, reference numbers, and feeder dispenses.
          </p>
        </div>
      </div>

      {/* Latest Hardware Dispense Telemetry Banner */}
      {lastDispense && (
        <div className="logs-telemetry-banner card">
          <div className="logs-telemetry-left">
            <Scale size={18} color="var(--green)" />
            <div>
              <div className="logs-telemetry-title">Last Hardware Dispense Cycle (ESP32 + HX711)</div>
              <div className="logs-telemetry-sub">
                Source: <strong>{lastDispense.source || 'feeder'}</strong>
              </div>
            </div>
          </div>
          <div className="logs-telemetry-metrics">
            <div className="logs-metric">
              <span>Target</span>
              <strong>{lastDispense.target_g ?? 0}g</strong>
            </div>
            <div className="logs-metric">
              <span>Actual Added</span>
              <strong>{lastDispense.actual_g ?? 0}g</strong>
            </div>
            <div className="logs-metric">
              <span>Final Bowl</span>
              <strong>{lastDispense.bowl_g ?? 0}g</strong>
            </div>
          </div>
        </div>
      )}

      {/* Search & Filters Card */}
      <div className="logs-card card">
        <div className="logs-toolbar">
          <div className="logs-search-wrap">
            <Search size={15} className="logs-search-icon" />
            <input
              type="text"
              className="logs-search-input"
              placeholder="Search donor name, 13-digit Ref No., or message..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>

          <div className="logs-filter-group">
            {['all', 'gcash', 'coin', 'admin'].map(f => (
              <button
                key={f}
                className={`activity-filter-pill ${filter === f ? 'activity-filter-pill--active' : ''}`}
                onClick={() => setFilter(f)}
              >
                {f === 'all' ? 'All' : f === 'gcash' ? 'GCash' : f === 'coin' ? 'Coin Slot' : 'Admin'}
              </button>
            ))}
          </div>
        </div>

        <div className="logs-table-wrap">
          {filtered.length === 0 ? (
            <div className="logs-empty">
              <ScrollText size={28} color="var(--text-muted)" />
              <p>No matching log entries found.</p>
            </div>
          ) : (
            <table className="logs-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Donor / Source</th>
                  <th>Amount &amp; Portion</th>
                  <th>GCash Ref No.</th>
                  <th>Verification</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(item => {
                  const isGCash = item.source === 'gcash_online' || !!item.refCode
                  const isCoin  = item.source === 'coin' || item.source === 'coin_slot'
                  return (
                    <tr key={item.id}>
                      <td className="logs-td-time">
                        {item.timestamp ? new Date(item.timestamp).toLocaleString() : '—'}
                      </td>
                      <td>
                        <div className="logs-donor-name">{item.donorName || 'Anonymous'}</div>
                        {item.message && (
                          <div className="logs-donor-msg">&ldquo;{item.message}&rdquo;</div>
                        )}
                      </td>
                      <td>
                        <strong>{item.amountPhp ? `₱${item.amountPhp}` : 'Free'}</strong>
                        <span className="logs-grams"> • {item.grams || 50}g</span>
                      </td>
                      <td className="logs-td-mono">
                        {item.refCode || '—'}
                      </td>
                      <td>
                        {isGCash ? (
                          <span className="badge badge-green" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <ShieldCheck size={12} />
                            {item.receiptVerified ? 'OCR Verified' : 'Ref Verified'}
                          </span>
                        ) : isCoin ? (
                          <span className="badge badge-accent">Coin Slot</span>
                        ) : (
                          <span className="badge badge-muted">Admin PIN</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

