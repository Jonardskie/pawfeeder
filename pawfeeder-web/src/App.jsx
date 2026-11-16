import { useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { ref, onValue } from 'firebase/database'
import { db } from './lib/firebase'
import DashboardLayout from './components/layout/DashboardLayout'
import Dashboard       from './pages/Dashboard'
import LiveFeedPage    from './pages/LiveFeedPage'
import DonatePage      from './pages/DonatePage'
import LogsPage        from './pages/LogsPage'
import Settings        from './pages/Settings'

export default function App() {
  const [theme, setTheme] = useState(() => {
    return localStorage.getItem('pawfeeder_theme') || 'dark'
  })

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('pawfeeder_theme', theme)
  }, [theme])

  const toggleTheme = () => setTheme(prev => (prev === 'dark' ? 'light' : 'dark'))

  const [deviceStatus, setDeviceStatus] = useState({
    online:   false,
    rssi:     null,
    uptime_s: 0,
    food_pct: 75,
    bowl_weight_g: 0.0,
    total_coins_php: 0,
    balance_php: 0,
    lastSeen: 'Connecting...',
  })

  // ── Pre-warm Cloud Camera Relay on app open ───────────────
  useEffect(() => {
    fetch('https://pawfeeder-or3n.onrender.com/', { mode: 'no-cors' }).catch(() => {})
  }, [])

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
        balance_php: d.balance_php ? parseInt(d.balance_php) : 0,
        lastSeen: d.uptime_s
          ? `${d.uptime_s}s uptime`
          : 'Just connected',
      })
    })
    return () => unsub()
  }, [])

  return (
    <BrowserRouter>
      <DashboardLayout deviceStatus={deviceStatus} theme={theme} onToggleTheme={toggleTheme}>
        <Routes>
          <Route path="/"         element={<Dashboard db={db} deviceStatus={deviceStatus} />} />
          <Route path="/feed"     element={<LiveFeedPage />} />
          <Route path="/donate"   element={<DonatePage db={db} deviceStatus={deviceStatus} />} />
          <Route path="/logs"     element={<LogsPage db={db} />} />
          <Route path="/settings" element={<Settings db={db} />} />
        </Routes>
      </DashboardLayout>
    </BrowserRouter>
  )
}
