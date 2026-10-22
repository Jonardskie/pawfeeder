import { Wifi, Clock, Scale, Coins, Database } from 'lucide-react'
import './DeviceStatus.css'

function RssiLabel(rssi) {
  if (!rssi) return 'Offline'
  if (rssi >= -60) return 'Excellent'
  if (rssi >= -70) return 'Good'
  if (rssi >= -80) return 'Fair'
  return 'Weak'
}

function formatUptime(seconds) {
  if (!seconds) return '0m'
  const m = Math.floor(seconds / 60)
  const h = Math.floor(m / 60)
  if (h > 0) return `${h}h ${m % 60}m`
  return `${m}m`
}

export default function DeviceStatus({ online = false, rssi = null, uptime = 0, bowlWeight = 0, totalCoins = 0, lastSeen = '' }) {
  const tiles = [
    {
      id:    'status-wifi',
      icon:  <Wifi size={16} strokeWidth={1.8} />,
      label: 'WiFi Signal',
      value: rssi ? `${rssi} dBm` : 'Offline',
      sub:   RssiLabel(rssi),
      ok:    online && rssi >= -78,
    },
    {
      id:    'status-weight',
      icon:  <Scale size={16} strokeWidth={1.8} />,
      label: 'Bowl Scale',
      value: `${Number(bowlWeight).toFixed(1)}g`,
      sub:   Number(bowlWeight) > 5 ? 'Food in bowl' : 'Bowl empty',
      ok:    online,
    },
    {
      id:    'status-coins',
      icon:  <Coins size={16} strokeWidth={1.8} />,
      label: 'Coins Inserted',
      value: `₱${totalCoins}`,
      sub:   'Allan 1239 ProMax',
      ok:    true,
    },
    {
      id:    'status-uptime',
      icon:  <Clock size={16} strokeWidth={1.8} />,
      label: 'Uptime',
      value: formatUptime(uptime),
      sub:   online ? 'Online now' : lastSeen,
      ok:    online,
    },
  ]

  return (
    <div className="devstatus card">
      <div className="card-header">
        <span className="card-title">Device Status</span>
        <span className="badge badge-green">Unit 001</span>
      </div>
      <div className="devstatus-grid">
        {tiles.map(tile => (
          <div key={tile.id} id={tile.id} className="devstatus-tile">
            <div className="devstatus-tile-top">
              <span className="devstatus-tile-icon">{tile.icon}</span>
              <span className={`dot ${tile.ok ? 'dot-green' : 'dot-amber'}`} />
            </div>
            <div className="devstatus-tile-label">{tile.label}</div>
            <div className={`devstatus-tile-value ${tile.ok ? '' : 'devstatus-tile-value--warn'}`}>
              {tile.value}
            </div>
            <div className="devstatus-tile-sub">{tile.sub}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
