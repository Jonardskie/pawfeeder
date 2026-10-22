import LiveFeed        from '../components/LiveFeed/LiveFeed'
import FoodLevelGauge  from '../components/FoodLevelGauge/FoodLevelGauge'
import BowlWeightCard  from '../components/BowlWeightCard/BowlWeightCard'
import DonationCard    from '../components/DonationCard/DonationCard'
import ActivityLog     from '../components/ActivityLog/ActivityLog'
import DeviceStatus    from '../components/DeviceStatus/DeviceStatus'
import './Dashboard.css'

export default function Dashboard({ db, deviceStatus }) {
  return (
    <div className="dashboard">
      {/* Left column */}
      <div className="dashboard-left">
        <LiveFeed />

        <div className="dashboard-bottom-row">
          <DonationCard
            db={db}
            currentBowlWeight={deviceStatus?.bowl_weight_g}
            online={deviceStatus?.online}
          />
          <BowlWeightCard
            db={db}
            weight={deviceStatus?.bowl_weight_g}
            online={deviceStatus?.online}
          />
        </div>
      </div>

      {/* Right column */}
      <div className="dashboard-right">
        <FoodLevelGauge levelPct={deviceStatus?.food_pct ?? 75} />
        <DeviceStatus
          online={deviceStatus?.online}
          rssi={deviceStatus?.rssi}
          uptime={deviceStatus?.uptime_s}
          bowlWeight={deviceStatus?.bowl_weight_g}
          totalCoins={deviceStatus?.total_coins_php}
          lastSeen={deviceStatus?.lastSeen}
        />
        <ActivityLog />
      </div>
    </div>
  )
}
