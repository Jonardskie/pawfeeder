import { useState } from 'react'
import { ref, set } from 'firebase/database'
import {
  Wifi, WifiOff, Camera, Cpu, RotateCcw, CheckCircle, AlertTriangle,
  Lock, Unlock, RefreshCw, RotateCw, Scale, Sliders, PackageCheck, Coins, Utensils
} from 'lucide-react'
import './Settings.css'

const BTN = { IDLE: 'idle', CONFIRM: 'confirm', SENDING: 'sending', DONE: 'done', ERROR: 'error' }
const ADMIN_STORAGE_KEY = 'pawfeeder_admin_unlocked'
const VALID_PINS = [
  import.meta.env.VITE_ADMIN_PIN || '1234',
  'pawfeeder123',
]

function AdminActionCard({
  db,
  title,
  icon: Icon,
  description,
  buttonLabel,
  color = 'blue',
  requireConfirm = false,
  confirmMessage = 'Are you sure you want to run this command?',
  successMessage = 'Command sent! ESP32 will execute within ~3 seconds.',
  onExecute,
}) {
  const [state, setState] = useState(BTN.IDLE)

  const handleClick = async () => {
    if (requireConfirm && state === BTN.IDLE) {
      setState(BTN.CONFIRM)
      return
    }
    if (requireConfirm && state !== BTN.CONFIRM) return

    if (!db) {
      setState(BTN.ERROR)
      setTimeout(() => setState(BTN.IDLE), 3000)
      return
    }

    setState(BTN.SENDING)
    try {
      await onExecute()
      setState(BTN.DONE)
      setTimeout(() => setState(BTN.IDLE), 3500)
    } catch (e) {
      console.error(e)
      setState(BTN.ERROR)
      setTimeout(() => setState(BTN.IDLE), 3000)
    }
  }

  return (
    <div className={`settings-card settings-card--${color}`}>
      <div className="settings-card-header">
        <div className={`settings-card-icon settings-card-icon--${color}`}>
          <Icon size={20} />
        </div>
        <div>
          <div className="settings-card-title">{title}</div>
          <div className="settings-card-desc">{description}</div>
        </div>
      </div>

      {state === BTN.DONE && (
        <div className="settings-alert settings-alert--success">
          <CheckCircle size={14} />
          <span>{successMessage}</span>
        </div>
      )}

      {state === BTN.CONFIRM && (
        <div className="settings-alert settings-alert--warn">
          <AlertTriangle size={14} />
          <span>{confirmMessage}</span>
        </div>
      )}

      <div className="settings-card-actions">
        {state === BTN.CONFIRM && (
          <button
            className="settings-btn settings-btn--ghost"
            onClick={() => setState(BTN.IDLE)}
          >
            Cancel
          </button>
        )}
        <button
          className={`settings-btn ${
            state === BTN.CONFIRM  ? 'settings-btn--danger'  :
            state === BTN.SENDING  ? 'settings-btn--sending' :
            state === BTN.DONE     ? 'settings-btn--done'    :
            state === BTN.ERROR    ? 'settings-btn--danger'  :
                                     'settings-btn--primary'
          }`}
          onClick={handleClick}
          disabled={state === BTN.SENDING || state === BTN.DONE}
        >
          {state === BTN.SENDING && <span className="settings-spinner" />}
          {state === BTN.DONE    && <CheckCircle size={14} />}
          {state === BTN.IDLE    && <Icon size={14} />}

          {state === BTN.IDLE    ? buttonLabel          :
           state === BTN.CONFIRM ? '⚠ Confirm'          :
           state === BTN.SENDING ? 'Sending...'         :
           state === BTN.DONE    ? 'Sent to ESP32 ✓'    :
                                   'Error — Try Again'}
        </button>
      </div>
    </div>
  )
}

export default function Settings({ db }) {
  const [isUnlocked, setIsUnlocked] = useState(() => {
    return sessionStorage.getItem(ADMIN_STORAGE_KEY) === 'true'
  })
  const [pinInput, setPinInput] = useState('')
  const [pinError, setPinError] = useState('')

  const handleUnlock = (e) => {
    e.preventDefault()
    if (VALID_PINS.includes(pinInput.trim())) {
      sessionStorage.setItem(ADMIN_STORAGE_KEY, 'true')
      setIsUnlocked(true)
      setPinInput('')
      setPinError('')
    } else {
      setPinError('Invalid Admin PIN. Try again.')
    }
  }

  const handleLock = () => {
    sessionStorage.removeItem(ADMIN_STORAGE_KEY)
    setIsUnlocked(false)
  }

  const sendAdminAction = (actionName) => {
    return set(ref(db, 'feeder/unit001/cmd/admin_action'), actionName)
  }

  // ── Locked Screen for Regular Visitors ────────────────────
  if (!isUnlocked) {
    return (
      <div className="settings-page">
        <div className="settings-lock-wrapper">
          <div className="settings-lock-card">
            <div className="settings-lock-icon">
              <Lock size={26} />
            </div>
            <h1 className="settings-lock-title">Admin Hardware Controls</h1>
            <p className="settings-lock-desc">
              Motor unclogging, reverse spin, scale calibration, and WiFi reset are restricted to administrators.
            </p>
            <form onSubmit={handleUnlock} className="settings-lock-form">
              <input
                type="password"
                className="settings-pin-input"
                placeholder="Enter Admin PIN / Password"
                value={pinInput}
                onChange={(e) => {
                  setPinInput(e.target.value)
                  if (pinError) setPinError('')
                }}
                autoFocus
              />
              {pinError && <div className="settings-pin-error">{pinError}</div>}
              <button type="submit" className="settings-btn settings-btn--primary settings-unlock-btn">
                <Unlock size={15} />
                Unlock Admin Panel
              </button>
            </form>
          </div>
        </div>
      </div>
    )
  }

  // ── Unlocked Admin Control Panel ──────────────────────────
  return (
    <div className="settings-page">
      <div className="settings-header settings-header--row">
        <div>
          <h1 className="settings-title">Admin Control &amp; Settings</h1>
          <p className="settings-subtitle">
            Remote hardware diagnostics, anti-clog motor controls, and scale calibration.
          </p>
        </div>
        <button className="settings-btn settings-btn--ghost" onClick={handleLock}>
          <Lock size={14} />
          Lock Admin
        </button>
      </div>

      {/* 1. Motor & Anti-Clog Auger Controls */}
      <section className="settings-section">
        <div className="settings-section-label">
          <RefreshCw size={15} /> Auger &amp; Motor Controls (Anti-Clog)
        </div>
        <div className="settings-grid">
          <AdminActionCard
            db={db}
            title="Unjam Auger (Reverse + Shake)"
            icon={RefreshCw}
            color="amber"
            description="Backs up the auger for 450ms at high torque, shakes back-and-forth 4 times to break bridged pellets, then pushes forward."
            buttonLabel="Run Unjam Shake"
            onExecute={() => sendAdminAction('unjam')}
          />

          <AdminActionCard
            db={db}
            title="Reverse Spin (2 Seconds)"
            icon={RotateCcw}
            color="rose"
            description="Spins the NEMA 17 stepper motor in reverse for 2 full seconds to pull wedged kibble back into the hopper throat."
            buttonLabel="Reverse Spin (2s)"
            onExecute={() => sendAdminAction('reverse')}
          />

          <AdminActionCard
            db={db}
            title="Forward Motor Test (2 Seconds)"
            icon={RotateCw}
            color="blue"
            description="Spins the auger forward for 2 seconds to verify TB6600 stepper torque and pellet flow."
            buttonLabel="Forward Spin (2s)"
            onExecute={() => sendAdminAction('forward')}
          />

          <AdminActionCard
            db={db}
            title="Admin Test Dispense (50g)"
            icon={Utensils}
            color="green"
            description="Triggers a full 50g closed-loop dispense cycle using the HX711 scale and anti-clog peck dither."
            buttonLabel="Dispense 50g"
            onExecute={() =>
              set(ref(db, 'feeder/unit001/cmd/dispense'), {
                active: true,
                grams: 50,
                ts: Date.now(),
              })
            }
          />
        </div>
      </section>

      {/* 2. Scale & Feeder Maintenance */}
      <section className="settings-section">
        <div className="settings-section-label">
          <Scale size={15} /> HX711 Scale &amp; Feeder Maintenance
        </div>
        <div className="settings-grid">
          <AdminActionCard
            db={db}
            title="Zero Scale (Tare to 0.0g)"
            icon={Scale}
            color="cyan"
            description="Takes 9 median-filtered readings and sets the current empty bowl weight as the 0.0g baseline."
            buttonLabel="Tare Scale (0.0g)"
            onExecute={() => sendAdminAction('tare')}
          />

          <AdminActionCard
            db={db}
            title="Calibrate Scale (200g Weight)"
            icon={Sliders}
            color="purple"
            requireConfirm
            confirmMessage="Make sure you have Tared first, and a 200g reference weight is sitting steadily on the bowl. Proceed?"
            description="Measures a 200g weight on the bowl, calculates the new calibrationFactor, and saves it permanently to ESP32 NVS memory."
            buttonLabel="Calibrate (200g)"
            onExecute={() => sendAdminAction('calibrate_200')}
          />

          <AdminActionCard
            db={db}
            title="Mark Hopper Refilled (100%)"
            icon={PackageCheck}
            color="green"
            description="Resets the storage hopper food level gauge back to 100% after topping up pet food."
            buttonLabel="Set Hopper 100%"
            onExecute={() => sendAdminAction('refill_100')}
          />

          <AdminActionCard
            db={db}
            title="Reset Coin Balance (₱0)"
            icon={Coins}
            color="amber"
            description="Clears any partial pending coin balance on the LCD back to ₱0."
            buttonLabel="Reset Balance"
            onExecute={() => sendAdminAction('reset_balance')}
          />
        </div>
      </section>

      {/* 3. WiFi Configuration */}
      <section className="settings-section">
        <div className="settings-section-label">
          <Wifi size={15} /> WiFi Configuration
        </div>
        <div className="settings-grid">
          <AdminActionCard
            db={db}
            title="Control ESP32 WiFi"
            icon={Cpu}
            color="blue"
            requireConfirm
            confirmMessage="This will disconnect the Control ESP32 from its current WiFi and open PawFeeder-Setup hotspot. Confirm?"
            successMessage="Command sent! Connect to PawFeeder-Setup (pw: pawfeeder123) and open 192.168.4.1."
            description="Resets WiFi on the main feeder board (stepper + LCD). Device restarts into AP setup mode."
            buttonLabel="Reset Control WiFi"
            onExecute={() => set(ref(db, 'feeder/unit001/cmd/reset_wifi'), true)}
          />
          <AdminActionCard
            db={db}
            title="ESP32-CAM WiFi"
            icon={Camera}
            color="purple"
            requireConfirm
            confirmMessage="This will disconnect the ESP32-CAM from its current WiFi and open PawFeeder-CAM-Setup hotspot. Confirm?"
            successMessage="Command sent! Connect to PawFeeder-CAM-Setup and open 192.168.4.1."
            description="Resets WiFi on the camera board. Device restarts into AP setup mode."
            buttonLabel="Reset CAM WiFi"
            onExecute={() => set(ref(db, 'feeder/unit001/cmd/reset_wifi_cam'), true)}
          />
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-label">
          <WifiOff size={15} /> How to reconfigure WiFi
        </div>
        <div className="settings-steps">
          <div className="settings-step">
            <span className="settings-step-num">1</span>
            Click <strong>Reset WiFi</strong> above → confirm → command sends to device
          </div>
          <div className="settings-step">
            <span className="settings-step-num">2</span>
            Device restarts and creates a hotspot (<strong>PawFeeder-Setup</strong>)
          </div>
          <div className="settings-step">
            <span className="settings-step-num">3</span>
            On your phone: WiFi settings → join <strong>PawFeeder-Setup</strong> (pw: pawfeeder123)
          </div>
          <div className="settings-step">
            <span className="settings-step-num">4</span>
            Browser opens → or go to <strong>192.168.4.1</strong> → pick new WiFi → save
          </div>
          <div className="settings-step">
            <span className="settings-step-num">5</span>
            Device reconnects to new WiFi automatically 🎉
          </div>
        </div>
      </section>
    </div>
  )
}
