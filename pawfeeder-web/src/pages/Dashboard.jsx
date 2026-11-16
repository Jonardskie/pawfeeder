import { Wifi, WifiOff, Signal, Scale, Coins, Clock } from 'lucide-react'
import LiveFeed     from '../components/LiveFeed/LiveFeed'
import DonationCard from '../components/DonationCard/DonationCard'
import ActivityLog  from '../components/ActivityLog/ActivityLog'
import './Dashboard.css'

export default function Dashboard({ db, deviceStatus }) {
  const online     = deviceStatus?.online ?? false
  const rssi       = deviceStatus?.rssi ?? null
  const bowlWeight = Number(deviceStatus?.bowl_weight_g ?? 0)
  const totalCoins = Number(deviceStatus?.total_coins_php ?? 0)
  const uptime     = Number(deviceStatus?.uptime_s ?? 0)

  const formatUptime = (s) => {
    if (s < 60) return `${s}s`
    if (s < 3600) return `${Math.floor(s / 60)}m`
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  }

  return (
    <div className="dashboard-shell">
      {/* Compact Icon Status Strip */}
      <div className="dashboard-status-strip">
        <div className={`status-chip ${online ? 'status-chip--online' : 'status-chip--offline'}`}>
          {online ? <Wifi size={13} /> : <WifiOff size={13} />}
          <span>{online ? 'Feeder Online' : 'Feeder Offline'}</span>
        </div>

        {rssi !== null && (
          <div className="status-chip" title="WiFi Signal Strength">
            <Signal size={13} />
            <span>{rssi} dBm</span>
          </div>
        )}

        <div className="status-chip" title="Current Bowl Weight">
          <Scale size={13} />
          <span>{bowlWeight.toFixed(1)}g</span>
        </div>

        <div className="status-chip" title="On-Site Coin Slot Total">
          <Coins size={13} />
          <span>₱{totalCoins}</span>
        </div>

        <div className="status-chip" title="Device Uptime">
          <Clock size={13} />
          <span>{formatUptime(uptime)}</span>
        </div>
      </div>

      {/* Clean 2-Column Workspace */}
      <div className="dashboard">
        <div className="dashboard-left">
          <LiveFeed />
          <ActivityLog db={db} />
        </div>

        <div className="dashboard-right">
          <DonationCard
            db={db}
            currentBowlWeight={deviceStatus?.bowl_weight_g}
            online={online}
          />
        </div>
      </div>
    </div>
  )
}
