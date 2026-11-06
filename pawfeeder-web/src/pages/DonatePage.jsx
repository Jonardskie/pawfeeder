import { useState, useEffect } from 'react'
import { ref, onValue } from 'firebase/database'
import { Heart, ShieldCheck, Coins, Utensils, Users } from 'lucide-react'
import DonationCard from '../components/DonationCard/DonationCard'
import './DonatePage.css'

export default function DonatePage({ db, deviceStatus, unitId = 'unit001' }) {
  const [donations, setDonations] = useState([])

  useEffect(() => {
    if (!db) return
    const donRef = ref(db, `feeder/${unitId}/donations`)
    const unsub = onValue(donRef, (snap) => {
      if (snap.exists()) {
        const list = Object.entries(snap.val()).map(([id, item]) => ({ id, ...item }))
        list.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
        setDonations(list)
      } else {
        setDonations([])
      }
    })
    return () => unsub()
  }, [db, unitId])

  const gcashDonations = donations.filter(d => d.source === 'gcash_online' || d.refCode)
  const totalGcashPhp  = gcashDonations.reduce((sum, d) => sum + (Number(d.amountPhp) || 0), 0)
  const totalGramsFed  = donations.reduce((sum, d) => sum + (Number(d.grams) || 0), 0)
  const totalCoinPhp   = Number(deviceStatus?.total_coins_php || 0)

  return (
    <div className="donate-page">
      <div className="donate-page-header">
        <div>
          <h1 className="donate-page-title">Feed Stray Animals Remotely 🐾</h1>
          <p className="donate-page-subtitle">
            100% of your GCash donation immediately dispenses weighed food into the community bowl.
          </p>
        </div>
      </div>

      {/* Community Impact Stats */}
      <div className="donate-stats-grid">
        <div className="donate-stat-card card">
          <div className="donate-stat-icon donate-stat-icon--blue">
            <Heart size={18} />
          </div>
          <div>
            <div className="donate-stat-label">GCash Donations</div>
            <div className="donate-stat-value">₱{totalGcashPhp}</div>
            <div className="donate-stat-sub">{gcashDonations.length} online donors</div>
          </div>
        </div>

        <div className="donate-stat-card card">
          <div className="donate-stat-icon donate-stat-icon--amber">
            <Coins size={18} />
          </div>
          <div>
            <div className="donate-stat-label">On-Site Coin Slot</div>
            <div className="donate-stat-value">₱{totalCoinPhp}</div>
            <div className="donate-stat-sub">
              {deviceStatus?.balance_php > 0
                ? `Active balance: ₱${deviceStatus.balance_php}`
                : 'Allan 1239 ProMax'}
            </div>
          </div>
        </div>

        <div className="donate-stat-card card">
          <div className="donate-stat-icon donate-stat-icon--green">
            <Utensils size={18} />
          </div>
          <div>
            <div className="donate-stat-label">Total Food Dispensed</div>
            <div className="donate-stat-value">{totalGramsFed}g</div>
            <div className="donate-stat-sub">Closed-loop HX711 scale</div>
          </div>
        </div>
      </div>

      <div className="donate-main-grid">
        {/* Left: Interactive Donation & Dispense Card */}
        <div className="donate-main-left">
          <DonationCard
            db={db}
            unitId={unitId}
            currentBowlWeight={deviceStatus?.bowl_weight_g}
            online={deviceStatus?.online}
          />
        </div>

        {/* Right: Community Donor Wall */}
        <div className="donate-wall card">
          <div className="card-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Users size={16} color="var(--accent)" />
              <span className="card-title">Community Donor Wall</span>
            </div>
            <span className="badge badge-green">{gcashDonations.length} Verified</span>
          </div>

          <div className="donate-wall-list">
            {gcashDonations.length === 0 ? (
              <div className="donate-wall-empty">
                Be the first to donate via GCash and leave a message for the animals! 🐶🐱
              </div>
            ) : (
              gcashDonations.slice(0, 20).map(d => (
                <div key={d.id} className="donate-wall-item">
                  <div className="donate-wall-avatar">
                    {(d.donorName || 'A').charAt(0).toUpperCase()}
                  </div>
                  <div className="donate-wall-content">
                    <div className="donate-wall-top">
                      <span className="donate-wall-name">{d.donorName || 'Anonymous'}</span>
                      <span className="donate-wall-amount">₱{d.amountPhp} • {d.grams}g</span>
                    </div>
                    {d.message && (
                      <div className="donate-wall-msg">&ldquo;{d.message}&rdquo;</div>
                    )}
                    <div className="donate-wall-meta">
                      <span>
                        {d.timestamp ? new Date(d.timestamp).toLocaleString() : ''}
                      </span>
                      {d.receiptVerified && (
                        <span className="donate-wall-verified">
                          <ShieldCheck size={12} /> Receipt Verified
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

