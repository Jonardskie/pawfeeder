import { useState } from 'react'
import { ref, set } from 'firebase/database'
import { Zap, CheckCircle2, QrCode } from 'lucide-react'
import GCashModal from './GCashModal'
import './DonationCard.css'

const PORTIONS = [
  { grams: 50,  label: '₱10', php: 10, sub: '50g Snack',    id: 'p-50'  },
  { grams: 150, label: '₱30', php: 30, sub: '150g Meal',    id: 'p-150' },
  { grams: 250, label: '₱50', php: 50, sub: '250g Large',   id: 'p-250' },
  { grams: 350, label: '₱70', php: 70, sub: '350g X-Large', id: 'p-350' },
  { grams: 450, label: '₱90', php: 90, sub: '450g Max',     id: 'p-450' },
]

const STATE = { IDLE: 'idle', SENDING: 'sending', DISPENSING: 'dispensing', DONE: 'done', ERROR: 'error' }

export default function DonationCard({ db, unitId = 'unit001', currentBowlWeight = 0, online = true }) {
  const [selected, setSelected]   = useState(PORTIONS[1])
  const [dispState, setDispState] = useState(STATE.IDLE)
  const [gcashOpen, setGcashOpen] = useState(false)

  const handleDispense = async () => {
    if (dispState !== STATE.IDLE || !db) return
    setDispState(STATE.SENDING)

    try {
      await set(ref(db, `feeder/${unitId}/cmd/dispense`), {
        active: true,
        grams:  selected.grams,
        source: 'web_dashboard',
      })
      setDispState(STATE.DISPENSING)
      setTimeout(() => {
        setDispState(STATE.DONE)
        setTimeout(() => setDispState(STATE.IDLE), 3000)
      }, 4000)
    } catch (e) {
      console.error('Dispense error:', e)
      setDispState(STATE.ERROR)
      setTimeout(() => setDispState(STATE.IDLE), 3000)
    }
  }

  const isIdle       = dispState === STATE.IDLE
  const isSending    = dispState === STATE.SENDING
  const isDispensing = dispState === STATE.DISPENSING
  const isDone       = dispState === STATE.DONE
  const isError      = dispState === STATE.ERROR

  return (
    <>
      <div className="donation card">
        <div className="card-header">
          <div className="dispense-title-row">
            <span className="card-title">🍲 Dispense Food</span>
            <span className="badge badge-green">Weight-Controlled</span>
          </div>
          <span className="dispense-mode-label">Auto-Stop on Target</span>
        </div>

        <p className="donation-hint">
          Select target weight. The stepper motor will run and <strong>automatically shut off</strong> once the load cell measures the exact grams in the bowl.
        </p>

        {/* Portion Selection Grid */}
        <div className="donation-tiers">
          {PORTIONS.map(portion => (
            <button
              key={portion.id}
              id={portion.id}
              className={`donation-tier-btn ${selected.grams === portion.grams ? 'donation-tier-btn--active' : ''}`}
              onClick={() => setSelected(portion)}
              disabled={!isIdle}
            >
              <span className="donation-tier-php">{portion.label}</span>
              <span className="donation-tier-grams">{portion.sub}</span>
            </button>
          ))}
        </div>

        {/* Live Dispense Info Banner */}
        <div className="dispense-live-info">
          <div className="dispense-info-col">
            <span className="dispense-info-label">Target to Dispense:</span>
            <span className="dispense-info-val">{selected.grams}g</span>
          </div>
          <div className="dispense-info-col">
            <span className="dispense-info-label">Current Bowl:</span>
            <span className="dispense-info-val">{Number(currentBowlWeight).toFixed(1)}g</span>
          </div>
        </div>

        {/* ── Divider with two action buttons ── */}
        <div className="donation-actions">
          {/* Direct Dispense (admin / on-site) */}
          <button
            className={`donation-dispense-btn ${
              isDone       ? 'donation-dispense-btn--sent'       :
              isError      ? 'donation-dispense-btn--error'      :
              isDispensing ? 'donation-dispense-btn--dispensing' :
              isSending    ? 'donation-dispense-btn--sending'    :
              !db          ? 'donation-dispense-btn--sending'    :
                             'donation-dispense-btn--unlocked'
            }`}
            onClick={handleDispense}
            disabled={!isIdle || !db || !online}
            id="dispense-now-btn"
          >
            {(isSending || isDispensing) && <span className="donation-btn-spinner" />}
            {isDone && <CheckCircle2 size={18} />}
            {isIdle && db && <Zap size={18} />}

            {isSending    ? 'Sending...'                              :
             isDispensing ? `Dispensing ${selected.grams}g...`        :
             isDone       ? `Done ✓`                                  :
             isError      ? 'Failed — Retry'                          :
             !online      ? 'Feeder Offline'                          :
             !db          ? 'Connecting...'                           :
                            `Dispense ${selected.grams}g`}
          </button>

          {/* GCash Online Donation */}
          <button
            className="donation-gcash-btn"
            onClick={() => setGcashOpen(true)}
            disabled={!isIdle}
            id="gcash-donate-btn"
          >
            <QrCode size={18} />
            Donate via GCash
          </button>
        </div>

        <div className="donation-notice">
          <span>🔒</span>
          GCash donations are verified by reference number before dispensing
        </div>
      </div>

      {/* GCash Modal */}
      {gcashOpen && (
        <GCashModal
          tier={selected}
          db={db}
          unitId={unitId}
          onClose={() => setGcashOpen(false)}
        />
      )}
    </>
  )
}
