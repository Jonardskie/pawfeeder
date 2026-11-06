import { useState } from 'react'
import { ref, set, push } from 'firebase/database'
import { Zap, CheckCircle2, QrCode, Lock, Unlock, KeyRound, X } from 'lucide-react'
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
const ADMIN_PIN = import.meta.env.VITE_ADMIN_PIN || '1234'

export default function DonationCard({ db, unitId = 'unit001', currentBowlWeight = 0, online = true }) {
  const [selected, setSelected]   = useState(PORTIONS[1])
  const [dispState, setDispState] = useState(STATE.IDLE)
  const [gcashOpen, setGcashOpen] = useState(false)

  // Admin PIN state for direct manual dispense
  const [adminUnlocked, setAdminUnlocked] = useState(() => {
    return sessionStorage.getItem('pawfeeder_admin_unlocked') === 'true'
  })
  const [showPinPrompt, setShowPinPrompt] = useState(false)
  const [pinInput, setPinInput]           = useState('')
  const [pinError, setPinError]           = useState('')

  const handleUnlockSubmit = (e) => {
    e.preventDefault()
    if (pinInput.trim() === ADMIN_PIN) {
      setAdminUnlocked(true)
      sessionStorage.setItem('pawfeeder_admin_unlocked', 'true')
      setShowPinPrompt(false)
      setPinInput('')
      setPinError('')
    } else {
      setPinError('Incorrect Admin PIN')
    }
  }

  const handleLockAdmin = () => {
    setAdminUnlocked(false)
    sessionStorage.removeItem('pawfeeder_admin_unlocked')
    setShowPinPrompt(false)
  }

  const handleDispense = async () => {
    if (!adminUnlocked) {
      setShowPinPrompt(true)
      setPinError('')
      return
    }
    if (dispState !== STATE.IDLE || !db) return
    setDispState(STATE.SENDING)

    try {
      await set(ref(db, `feeder/${unitId}/cmd/dispense`), {
        active: true,
        grams:  selected.grams,
        source: 'web_admin',
      })
      await push(ref(db, `feeder/${unitId}/donations`), {
        donorName: 'Admin Manual Feed',
        amountPhp: 0,
        grams: selected.grams,
        timestamp: Date.now(),
        source: 'admin_manual',
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
            <span className="card-title">🍲 Donate &amp; Dispense Food</span>
            <span className="badge badge-green">Weight-Controlled</span>
          </div>
          <span className="dispense-mode-label">Auto-Stop on Target</span>
        </div>

        <p className="donation-hint">
          Select a portion tier to feed stray animals. The stepper motor runs and <strong>automatically shuts off</strong> once the load cell measures the exact grams in the bowl.
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
            <span className="dispense-info-label">Selected Tier:</span>
            <span className="dispense-info-val">₱{selected.php} → {selected.grams}g</span>
          </div>
          <div className="dispense-info-col">
            <span className="dispense-info-label">Current Bowl:</span>
            <span className="dispense-info-val">{Number(currentBowlWeight).toFixed(1)}g</span>
          </div>
        </div>

        {/* ── Action buttons ── */}
        <div className="donation-actions">
          {/* Primary Public Action: GCash Online Donation */}
          <button
            className="donation-gcash-btn"
            onClick={() => setGcashOpen(true)}
            disabled={!isIdle}
            id="gcash-donate-btn"
          >
            <QrCode size={18} />
            Donate ₱{selected.php} via GCash ({selected.grams}g)
          </button>

          {/* Admin-Protected Direct Dispense */}
          <button
            className={`donation-dispense-btn ${
              !adminUnlocked ? 'donation-dispense-btn--locked'   :
              isDone         ? 'donation-dispense-btn--sent'       :
              isError        ? 'donation-dispense-btn--error'      :
              isDispensing   ? 'donation-dispense-btn--dispensing' :
              isSending      ? 'donation-dispense-btn--sending'    :
              !db            ? 'donation-dispense-btn--sending'    :
                               'donation-dispense-btn--unlocked'
            }`}
            onClick={handleDispense}
            disabled={!isIdle || !db || (adminUnlocked && !online)}
            id="dispense-now-btn"
            title={adminUnlocked ? 'Admin Direct Dispense' : 'Requires Admin PIN'}
          >
            {(isSending || isDispensing) && <span className="donation-btn-spinner" />}
            {isDone && <CheckCircle2 size={16} />}
            {isIdle && db && (adminUnlocked ? <Zap size={16} /> : <Lock size={15} />)}

            {isSending       ? 'Sending...'                       :
             isDispensing    ? `Dispensing ${selected.grams}g...` :
             isDone          ? 'Done ✓'                           :
             isError         ? 'Failed — Retry'                   :
             !adminUnlocked  ? 'Admin Direct Feed'                :
             !online         ? 'Feeder Offline'                   :
             !db             ? 'Connecting...'                    :
                               `Admin Feed ${selected.grams}g`}
          </button>
        </div>

        {/* Inline Admin PIN Prompt */}
        {showPinPrompt && !adminUnlocked && (
          <form className="donation-pin-box animate-fade-in" onSubmit={handleUnlockSubmit}>
            <div className="donation-pin-header">
              <span className="donation-pin-title">
                <KeyRound size={13} /> Enter Admin PIN for Manual Dispense
              </span>
              <button
                type="button"
                className="donation-pin-close"
                onClick={() => { setShowPinPrompt(false); setPinError('') }}
              >
                <X size={14} />
              </button>
            </div>
            <div className="donation-pin-row">
              <input
                type="password"
                inputMode="numeric"
                className="donation-pin-input"
                placeholder="4-digit PIN (default: 1234)"
                value={pinInput}
                onChange={e => { setPinInput(e.target.value); setPinError('') }}
                maxLength={8}
                autoFocus
              />
              <button type="submit" className="donation-pin-submit">
                <Unlock size={13} /> Unlock
              </button>
            </div>
            {pinError && <span className="donation-pin-error">{pinError}</span>}
          </form>
        )}

        <div className="donation-notice">
          <span>🔒</span>
          <span>
            GCash donations are verified via Receipt OCR &amp; 13-digit Reference No.
            {adminUnlocked && (
              <button type="button" className="donation-lock-link" onClick={handleLockAdmin}>
                Lock Admin Mode
              </button>
            )}
          </span>
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
