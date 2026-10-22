import { useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { ref, onValue } from 'firebase/database'
import { db } from './lib/firebase'
import DashboardLayout from './components/layout/DashboardLayout'
import Dashboard       from './pages/Dashboard'
import LiveFeedPage    from './pages/LiveFeedPage'
import Settings        from './pages/Settings'

// Placeholder pages
const Placeholder = ({ title }) => (
  <div style={{ color: 'var(--text-muted)', padding: '40px 0', textAlign: 'center' }}>
    <div style={{ fontSize: '2rem', marginBottom: 12 }}>🚧</div>
    <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{title}</div>
    <div style={{ fontSize: '0.8rem', marginTop: 6 }}>Coming in a future phase.</div>
  </div>
)

export default function App() {
  const [deviceStatus, setDeviceStatus] = useState({
    online:   false,
    rssi:     null,
    uptime_s: 0,
    food_pct: 75,
    bowl_weight_g: 0.0,
    total_coins_php: 0,
    lastSeen: 'Connecting...',
  })

  // ── Live device status from Firebase RTDB ─────────────────
  useEffect(() => {
    if (!db) return
    const statusRef = ref(db, 'feeder/unit001/status')
    const unsub = onValue(statusRef, (snap) => {
      const d = snap.val()
      if (!d) return
      setDeviceStatus({
        online:   d.online  ?? false,
        rssi:     d.rssi    ?? null,
        uptime_s: d.uptime_s ?? 0,
        food_pct: d.food_level_pct ?? 75,
        bowl_weight_g: d.bowl_weight_g ?? 0.0,
        total_coins_php: d.total_collected_php ? parseInt(d.total_collected_php) : 0,
        lastSeen: d.uptime_s
          ? `${d.uptime_s}s uptime`
          : 'Just connected',
      })
    })
    return () => unsub()
  }, [])

  return (
    <BrowserRouter>
      <DashboardLayout deviceStatus={deviceStatus}>
        <Routes>
          <Route path="/"         element={<Dashboard db={db} deviceStatus={deviceStatus} />} />
          <Route path="/feed"     element={<LiveFeedPage />} />
          <Route path="/donate"   element={<Placeholder title="Donate — coming soon" />} />
          <Route path="/logs"     element={<Placeholder title="Dispense Logs — coming soon" />} />
          <Route path="/settings" element={<Settings db={db} />} />
        </Routes>
      </DashboardLayout>
    </BrowserRouter>
  )
}
