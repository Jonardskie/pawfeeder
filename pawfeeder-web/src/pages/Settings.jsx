import { useState } from 'react'
import { ref, set } from 'firebase/database'
import { Wifi, WifiOff, Camera, Cpu, RotateCcw, CheckCircle, AlertTriangle } from 'lucide-react'
import './Settings.css'

const BTN = { IDLE: 'idle', CONFIRM: 'confirm', SENDING: 'sending', DONE: 'done', ERROR: 'error' }

function ResetWifiCard({ db, title, icon: Icon, description, firebasePath, apName, color }) {
  const [state, setState] = useState(BTN.IDLE)

  const handleClick = async () => {
    if (state === BTN.IDLE) {
      setState(BTN.CONFIRM)
      return
    }
    if (state !== BTN.CONFIRM) return

    if (!db) { setState(BTN.ERROR); setTimeout(() => setState(BTN.IDLE), 3000); return }

    setState(BTN.SENDING)
    try {
      await set(ref(db, firebasePath), true)
      setState(BTN.DONE)
      setTimeout(() => setState(BTN.IDLE), 5000)
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
          Command sent! The device will restart and create <strong>{apName}</strong> hotspot.
          Connect your phone to it, then open <strong>192.168.4.1</strong> to set new WiFi.
        </div>
      )}

      {state === BTN.CONFIRM && (
        <div className="settings-alert settings-alert--warn">
          <AlertTriangle size={14} />
          This will disconnect the device from its current WiFi. Confirm?
        </div>
      )}

      <div className="settings-card-actions">
        {state === BTN.CONFIRM && (
          <button className="settings-btn settings-btn--ghost"
            onClick={() => setState(BTN.IDLE)}>
            Cancel
          </button>
        )}
        <button
          id={`reset-wifi-${color}`}
          className={`settings-btn ${
            state === BTN.CONFIRM  ? 'settings-btn--danger'   :
            state === BTN.SENDING  ? 'settings-btn--sending'  :
            state === BTN.DONE     ? 'settings-btn--done'     :
            state === BTN.ERROR    ? 'settings-btn--danger'   :
                                     'settings-btn--primary'
          }`}
          onClick={handleClick}
          disabled={state === BTN.SENDING || state === BTN.DONE}
        >
          {state === BTN.SENDING && <span className="settings-spinner" />}
          {state === BTN.DONE    && <CheckCircle size={14} />}
          {state === BTN.IDLE    && <RotateCcw size={14} />}

          {state === BTN.IDLE    ? 'Reset WiFi'         :
           state === BTN.CONFIRM ? '⚠ Confirm Reset'    :
           state === BTN.SENDING ? 'Sending...'          :
           state === BTN.DONE    ? 'Command Sent ✓'     :
                                   'Error — Try Again'}
        </button>
      </div>
    </div>
  )
}

export default function Settings({ db }) {
  return (
    <div className="settings-page">
      <div className="settings-header">
        <h1 className="settings-title">Settings</h1>
        <p className="settings-subtitle">
          Manage device configuration remotely via Firebase.
        </p>
      </div>

      <section className="settings-section">
        <div className="settings-section-label">
          <Wifi size={15} /> WiFi Configuration
        </div>
        <div className="settings-grid">
          <ResetWifiCard
            db={db}
            title="Control ESP32"
            icon={Cpu}
            description="Resets WiFi on the main feeder board (stepper + LCD). Device restarts into setup mode."
            firebasePath="feeder/unit001/cmd/reset_wifi"
            apName="PawFeeder-Setup"
            color="blue"
          />
          <ResetWifiCard
            db={db}
            title="ESP32-CAM"
            icon={Camera}
            description="Resets WiFi on the camera board. Device restarts into setup mode."
            firebasePath="feeder/unit001/cmd/reset_wifi_cam"
            apName="PawFeeder-CAM-Setup"
            color="purple"
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
