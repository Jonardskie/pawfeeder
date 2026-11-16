import { useState, useEffect, useRef } from 'react'
import { ref, set, onValue } from 'firebase/database'
import {
  Wifi, WifiOff, Camera, Cpu, RotateCcw, CheckCircle, AlertTriangle,
  Lock, Unlock, RefreshCw, RotateCw, Scale, Sliders, PackageCheck, Coins, Utensils,
  Smartphone, Upload, Save
} from 'lucide-react'
import { GCASH_ACCOUNT } from '../lib/receiptVerifier'
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

function compressQrToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      const MAX_DIM = 450
      const scale = Math.max(img.width, img.height) > MAX_DIM
        ? MAX_DIM / Math.max(img.width, img.height)
        : 1
      const w = Math.round(img.width * scale)
      const h = Math.round(img.height * scale)
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) return reject(new Error('Canvas unavailable'))
      ctx.drawImage(img, 0, 0, w, h)
      resolve(canvas.toDataURL('image/jpeg', 0.85))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Invalid image file'))
    }
    img.src = url
  })
}

function GCashRecipientCard({ db }) {
  const [maskedName, setMaskedName] = useState(GCASH_ACCOUNT.maskedName)
  const [number, setNumber] = useState(GCASH_ACCOUNT.number)
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [saveState, setSaveState] = useState(BTN.IDLE)
  const [errMsg, setErrMsg] = useState('')
  const qrInputRef = useRef(null)

  useEffect(() => {
    if (!db) return
    const cfgRef = ref(db, 'feeder/unit001/config/gcash')
    const unsub = onValue(cfgRef, (snap) => {
      const val = snap.val()
      if (val) {
        if (val.maskedName) setMaskedName(val.maskedName)
        if (val.number) setNumber(val.number)
        setQrDataUrl(val.qrDataUrl || '')
      }
    })
    return () => unsub()
  }, [db])

  const handleQrFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setErrMsg('')
    try {
      const compressed = await compressQrToDataUrl(file)
      setQrDataUrl(compressed)
    } catch (err) {
      setErrMsg(err?.message || 'Could not load QR image.')
    }
  }

  const handleSave = async (e) => {
    e.preventDefault()
    setErrMsg('')
    const cleanNum = number.replace(/\D/g, '')
    const cleanName = maskedName.trim()
    if (!cleanName || cleanName.length < 2) {
      setErrMsg('Please enter the GCash account name.')
      return
    }
    if (!/^09\d{9}$/.test(cleanNum)) {
      setErrMsg('GCash number must be 11 digits starting with 09 (e.g. 09535497843).')
      return
    }
    if (!db) {
      setSaveState(BTN.ERROR)
      return
    }

    setSaveState(BTN.SENDING)
    try {
      await set(ref(db, 'feeder/unit001/config/gcash'), {
        maskedName: cleanName,
        number: cleanNum,
        qrDataUrl: qrDataUrl || '',
        updatedAt: Date.now(),
      })
      setSaveState(BTN.DONE)
      setTimeout(() => setSaveState(BTN.IDLE), 3500)
    } catch (err) {
      console.error(err)
      setErrMsg('Failed to save to Firebase.')
      setSaveState(BTN.ERROR)
      setTimeout(() => setSaveState(BTN.IDLE), 3000)
    }
  }

  return (
    <form className="settings-card settings-card--blue" onSubmit={handleSave}>
      <div className="settings-card-header">
        <div className="settings-card-icon settings-card-icon--cyan">
          <Smartphone size={20} />
        </div>
        <div>
          <div className="settings-card-title">Active GCash Recipient Account</div>
          <div className="settings-card-desc">
            Changes the GCash name, mobile number, QR code, and OCR recipient verification live for all donors.
          </div>
        </div>
      </div>

      <div className="settings-gcash-grid">
        <div className="settings-gcash-field">
          <label className="settings-gcash-label" htmlFor="admin-gcash-name">
            GCash Account Name (as shown on receipt)
          </label>
          <input
            id="admin-gcash-name"
            type="text"
            className="settings-gcash-input"
            placeholder="e.g. JONARD S."
            value={maskedName}
            onChange={(e) => setMaskedName(e.target.value)}
            maxLength={50}
          />
        </div>

        <div className="settings-gcash-field">
          <label className="settings-gcash-label" htmlFor="admin-gcash-number">
            GCash Mobile Number (11 digits)
          </label>
          <input
            id="admin-gcash-number"
            type="text"
            inputMode="numeric"
            className="settings-gcash-input settings-gcash-input--mono"
            placeholder="09XXXXXXXXX"
            value={number}
            onChange={(e) => setNumber(e.target.value.replace(/\D/g, '').slice(0, 11))}
            maxLength={11}
          />
        </div>
      </div>

      <div className="settings-gcash-qr-row">
        <input
          ref={qrInputRef}
          type="file"
          accept="image/*"
          onChange={handleQrFile}
          style={{ display: 'none' }}
        />
        <button
          type="button"
          className="settings-btn settings-btn--ghost"
          onClick={() => qrInputRef.current?.click()}
        >
          <Upload size={14} />
          {qrDataUrl ? 'Change Custom QR Image' : 'Upload New QR Image (Optional)'}
        </button>
        {qrDataUrl && (
          <>
            <img src={qrDataUrl} alt="Custom QR Preview" className="settings-gcash-qr-thumb" />
            <button
              type="button"
              className="settings-btn settings-btn--ghost"
              onClick={() => setQrDataUrl('')}
            >
              Reset Default QR
            </button>
          </>
        )}
      </div>

      {errMsg && (
        <div className="settings-alert settings-alert--warn">
          <AlertTriangle size={14} />
          <span>{errMsg}</span>
        </div>
      )}

      {saveState === BTN.DONE && (
        <div className="settings-alert settings-alert--success">
          <CheckCircle size={14} />
          <span>Saved! All online donations now go to <strong>{maskedName} ({number})</strong>.</span>
        </div>
      )}

      <div className="settings-card-actions">
        <button
          type="submit"
          className={`settings-btn ${
            saveState === BTN.SENDING ? 'settings-btn--sending' :
            saveState === BTN.DONE    ? 'settings-btn--done'    :
                                        'settings-btn--primary'
          }`}
          disabled={saveState === BTN.SENDING}
        >
          {saveState === BTN.SENDING && <span className="settings-spinner" />}
          {saveState === BTN.DONE    && <CheckCircle size={14} />}
          {saveState === BTN.IDLE    && <Save size={14} />}
          {saveState === BTN.SENDING ? 'Saving...' :
           saveState === BTN.DONE    ? 'Saved Live ✓' :
                                       'Save GCash Account'}
        </button>
      </div>
    </form>
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

  const sendAdminCode = (code) => {
    return set(ref(db, 'feeder/unit001/cmd/dispense'), {
      active: true,
      grams: code,
      source: 'web_admin',
    })
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

      {/* 0. GCash Recipient Account */}
      <section className="settings-section">
        <div className="settings-section-label">
          <Smartphone size={15} /> Online Donation Recipient (GCash)
        </div>
        <GCashRecipientCard db={db} />
      </section>

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
            onExecute={() => sendAdminCode(901)}
          />

          <AdminActionCard
            db={db}
            title="Reverse Spin (2 Seconds)"
            icon={RotateCcw}
            color="rose"
            description="Spins the NEMA 17 stepper motor in reverse for 2 full seconds to pull wedged kibble back into the hopper throat."
            buttonLabel="Reverse Spin (2s)"
            onExecute={() => sendAdminCode(902)}
          />

          <AdminActionCard
            db={db}
            title="Forward Motor Test (2 Seconds)"
            icon={RotateCw}
            color="blue"
            description="Spins the auger forward for 2 seconds to verify TB6600 stepper torque and pellet flow."
            buttonLabel="Forward Spin (2s)"
            onExecute={() => sendAdminCode(903)}
          />

          <AdminActionCard
            db={db}
            title="Admin Test Dispense (50g)"
            icon={Utensils}
            color="green"
            description="Triggers a full 50g closed-loop dispense cycle using the HX711 scale and anti-clog peck dither."
            buttonLabel="Dispense 50g"
            onExecute={() => sendAdminCode(50)}
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
            onExecute={() => sendAdminCode(904)}
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
            onExecute={() => sendAdminCode(905)}
          />

          <AdminActionCard
            db={db}
            title="Mark Hopper Refilled (100%)"
            icon={PackageCheck}
            color="green"
            description="Resets the storage hopper food level gauge back to 100% after topping up pet food."
            buttonLabel="Set Hopper 100%"
            onExecute={() => sendAdminCode(907)}
          />

          <AdminActionCard
            db={db}
            title="Reset Coin Balance (₱0)"
            icon={Coins}
            color="amber"
            description="Clears any partial pending coin balance on the LCD back to ₱0."
            buttonLabel="Reset Balance"
            onExecute={() => sendAdminCode(906)}
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
            onExecute={() => sendAdminCode(908)}
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
