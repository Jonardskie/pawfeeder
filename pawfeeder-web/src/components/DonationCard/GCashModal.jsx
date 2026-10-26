import { useState, useEffect, useRef } from 'react'
import { ref, set, push, get } from 'firebase/database'
import { X, Copy, CheckCircle2, AlertTriangle, Heart, Send, ExternalLink, Download } from 'lucide-react'
import confetti from 'canvas-confetti'
import gcashQr from '../../assets/gcash_qr.jpg'
import './GCashModal.css'

const STEP = { QR: 'qr', VERIFY: 'verify', DISPENSING: 'dispensing', SUCCESS: 'success' }

const GCASH_NAME   = 'JONARD S.'
const GCASH_NUMBER = '09535497843'

export default function GCashModal({ tier, db, unitId = 'unit001', onClose }) {
  const [step, setStep]           = useState(STEP.QR)
  const [donorName, setDonorName] = useState('')
  const [refCode, setRefCode]     = useState('')
  const [message, setMessage]     = useState('')
  const [copied, setCopied]       = useState(false)
  const [redirectToast, setRedirectToast] = useState(false)
  const [error, setError]         = useState('')
  const [loading, setLoading]     = useState(false)
  const [countdown, setCountdown] = useState(0)
  const timerRef = useRef(null)

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (step !== STEP.DISPENSING) return
    const secs = Math.round(tier.grams * 0.06 + 6)
    setCountdown(secs)
    timerRef.current = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          clearInterval(timerRef.current)
          setStep(STEP.SUCCESS)
          fireConfetti()
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(timerRef.current)
  }, [step])

  function fireConfetti() {
    const end = Date.now() + 3500
    const frame = () => {
      confetti({ particleCount: 4, angle: 60,  spread: 55, origin: { x: 0 }, colors: ['#007bff','#00c896','#ffd700'] })
      confetti({ particleCount: 4, angle: 120, spread: 55, origin: { x: 1 }, colors: ['#007bff','#00c896','#ffd700'] })
      if (Date.now() < end) requestAnimationFrame(frame)
    }
    frame()
  }

  function copyNumber() {
    navigator.clipboard.writeText(GCASH_NUMBER)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // Check if user is on mobile (phone / tablet)
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  const isAndroid = /Android/i.test(navigator.userAgent)

  // Auto copy number + redirect to GCash app scheme
  function handleOpenGCash() {
    // 1. Copy GCash phone number to clipboard
    navigator.clipboard.writeText(GCASH_NUMBER)
    setCopied(true)
    setRedirectToast(true)

    if (isMobile) {
      if (isAndroid) {
        // Android Intent fallback to Play Store if not installed
        window.location.href = 'intent://#Intent;scheme=gcash;package=com.globe.gcash.android;end'
      } else {
        // iOS URL scheme
        window.location.href = 'gcash://'
      }
    }

    setTimeout(() => {
      setRedirectToast(false)
    }, 6000)
  }

  // Allow donor to download or save QR image to gallery
  function handleSaveQr() {
    const link = document.createElement('a')
    link.href = gcashQr
    link.download = `PawFeeder_GCash_QR_P${tier.php}.jpg`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  async function handleVerify() {
    setError('')
    const name = donorName.trim()
    const code = refCode.trim().toUpperCase()
    if (!name || name.length < 2) { setError('Please enter your full name.'); return }
    if (!code || code.length < 5) { setError('Please enter a valid GCash reference number.'); return }
    setLoading(true)
    try {
      if (db) {
        const snap = await get(ref(db, `feeder/${unitId}/donations`))
        if (snap.exists()) {
          const dup = Object.values(snap.val()).find(l => l.refCode && l.refCode.toUpperCase() === code)
          if (dup) {
            setError(`This reference code was already used by "${dup.donorName}" on ${new Date(dup.timestamp).toLocaleDateString()}. Each GCash reference can only be used once.`)
            setLoading(false)
            return
          }
        }
        await push(ref(db, `feeder/${unitId}/donations`), {
          donorName: name, refCode: code, message: message.trim(),
          amountPhp: tier.php, grams: tier.grams,
          timestamp: Date.now(), source: 'gcash_online',
        })
        await set(ref(db, `feeder/${unitId}/cmd/dispense`), {
          active: true, grams: tier.grams, source: 'gcash_donation', donor: name,
        })
      }
      setStep(STEP.DISPENSING)
    } catch (e) {
      console.error(e)
      setError('Connection error. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="gcash-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="gcash-modal">

        <button className="gcash-close" onClick={onClose} aria-label="Close"><X size={20} /></button>

        {/* STEP 1 — QR CODE & REDIRECT */}
        {step === STEP.QR && (
          <>
            <div className="gcash-header">
              <div className="gcash-logo-row">
                <div className="gcash-logo-badge">G</div>
                <div>
                  <div className="gcash-title">GCash Donation</div>
                  <div className="gcash-subtitle">Scan or Open App · Pay · Verify · Feed! 🐾</div>
                </div>
              </div>
            </div>

            <div className="gcash-amount-pill">
              <span className="gcash-amount-label">You are donating</span>
              <span className="gcash-amount-value">₱{tier.php}</span>
              <span className="gcash-amount-sub">→ {tier.grams}g of food for stray animals</span>
            </div>

            {/* Mobile App Launch or Laptop Scan Advice */}
            {isMobile ? (
              <div className="gcash-app-launch-card">
                <button className="gcash-launch-app-btn" onClick={handleOpenGCash}>
                  <ExternalLink size={18} />
                  Open GCash App & Auto-Copy Number
                </button>
                {redirectToast ? (
                  <div className="gcash-launch-toast animate-fade-in">
                    📋 <strong>{GCASH_NUMBER}</strong> copied to clipboard! Opening GCash app... Just paste number and enter <strong>₱{tier.php}</strong>.
                  </div>
                ) : (
                  <span className="gcash-launch-subtext">
                    Copies <strong>{GCASH_NUMBER}</strong> and opens your GCash app
                  </span>
                )}
              </div>
            ) : (
              <div className="gcash-app-launch-card gcash-app-launch-card--laptop">
                <div className="gcash-laptop-hint">
                  💻 <strong>Using a Laptop / Computer:</strong><br />
                  Open the <strong>GCash app on your mobile phone</strong>, tap <strong>Scan QR</strong>, and scan the QR code below!
                </div>
              </div>
            )}

            {/* QR Code with Save Option */}
            <div className="gcash-qr-wrapper">
              <img src={gcashQr} alt="GCash QR Code" className="gcash-qr-img" />
              <div className="gcash-qr-actions">
                <button className="gcash-save-qr-btn" onClick={handleSaveQr}>
                  <Download size={13} />
                  Save QR to Gallery
                </button>
              </div>
              <div className="gcash-qr-hint">
                In GCash: <strong>Scan QR</strong> from camera or gallery → Enter <strong>₱{tier.php}</strong>
              </div>
            </div>

            {/* Account Details Box */}
            <div className="gcash-details-box">
              <div className="gcash-detail-row">
                <span className="gcash-detail-label">Account Name</span>
                <span className="gcash-detail-val">{GCASH_NAME}</span>
              </div>
              <div className="gcash-detail-row">
                <span className="gcash-detail-label">Mobile Number</span>
                <div className="gcash-detail-copy-row">
                  <span className="gcash-detail-val gcash-number">{GCASH_NUMBER}</span>
                  <button className="gcash-copy-btn" onClick={copyNumber}>
                    {copied ? <CheckCircle2 size={13} /> : <Copy size={13} />}
                    {copied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </div>
              <div className="gcash-detail-row gcash-detail-row--amount">
                <span className="gcash-detail-label">Amount to Send</span>
                <span className="gcash-detail-val gcash-send-amount">₱{tier.php}.00</span>
              </div>
            </div>

            <div className="gcash-steps-hint">
              <div className="gcash-step-item"><span className="gcash-step-num">1</span> Tap <strong>Open GCash App</strong> or Scan QR</div>
              <div className="gcash-step-item"><span className="gcash-step-num">2</span> Enter exactly <strong>₱{tier.php}</strong> and confirm payment</div>
              <div className="gcash-step-item"><span className="gcash-step-num">3</span> Copy your <strong>13-digit Reference No.</strong> from the GCash receipt</div>
              <div className="gcash-step-item"><span className="gcash-step-num">4</span> Return here and tap <strong>Verify & Feed</strong> below!</div>
            </div>

            <button className="gcash-next-btn" onClick={() => setStep(STEP.VERIFY)}>
              <Send size={16} />
              I&apos;ve Sent ₱{tier.php} — Enter Reference No.
            </button>
          </>
        )}

        {/* STEP 2 — VERIFY REFERENCE */}
        {step === STEP.VERIFY && (
          <>
            <div className="gcash-header">
              <div className="gcash-logo-row">
                <div className="gcash-logo-badge gcash-logo-badge--green">✓</div>
                <div>
                  <div className="gcash-title">Verify Payment</div>
                  <div className="gcash-subtitle">Enter your GCash receipt details</div>
                </div>
              </div>
            </div>

            <div className="gcash-amount-pill gcash-amount-pill--verify">
              <span className="gcash-amount-label">Verifying</span>
              <span className="gcash-amount-value">₱{tier.php}</span>
              <span className="gcash-amount-sub">{tier.grams}g • {tier.label}</span>
            </div>

            <div className="gcash-form">
              <label className="gcash-label" htmlFor="gcash-donor-name">
                Your Name <span className="gcash-required">*</span>
              </label>
              <input
                id="gcash-donor-name"
                className="gcash-input"
                type="text"
                placeholder="e.g. Maria Santos"
                value={donorName}
                onChange={e => setDonorName(e.target.value)}
                maxLength={60}
                autoFocus
              />

              <label className="gcash-label" htmlFor="gcash-ref-code">
                GCash Reference Number <span className="gcash-required">*</span>
              </label>
              <input
                id="gcash-ref-code"
                className="gcash-input gcash-input--mono"
                type="text"
                placeholder="e.g. 1234567890123"
                value={refCode}
                onChange={e => setRefCode(e.target.value.replace(/[^a-zA-Z0-9]/g, ''))}
                maxLength={20}
              />
              <div className="gcash-input-hint">From your GCash receipt. Each code can only be used once.</div>

              <label className="gcash-label" htmlFor="gcash-message">
                Message for the Animals 🐾 <span className="gcash-optional">(optional)</span>
              </label>
              <textarea
                id="gcash-message"
                className="gcash-textarea"
                placeholder="e.g. Stay safe little ones! 🐶"
                value={message}
                onChange={e => setMessage(e.target.value)}
                maxLength={120}
                rows={2}
              />
              <div className="gcash-char-count">{message.length}/120</div>
            </div>

            {error && (
              <div className="gcash-error-box">
                <AlertTriangle size={14} />
                <span>{error}</span>
              </div>
            )}

            <div className="gcash-verify-actions">
              <button className="gcash-back-btn" onClick={() => { setStep(STEP.QR); setError('') }}>
                ← Back
              </button>
              <button className="gcash-verify-btn" onClick={handleVerify} disabled={loading}>
                {loading
                  ? <><span className="gcash-spinner" /> Verifying...</>
                  : <><Heart size={16} /> Feed the Animals!</>}
              </button>
            </div>
          </>
        )}

        {/* STEP 3 — DISPENSING */}
        {step === STEP.DISPENSING && (
          <div className="gcash-dispensing">
            <div className="gcash-dispensing-icon">
              <div className="gcash-paw-ring" />
              🐾
            </div>
            <div className="gcash-dispensing-title">Feeding the Animals!</div>
            <div className="gcash-dispensing-sub">
              Motor running • Dispensing <strong>{tier.grams}g</strong>
            </div>
            <div className="gcash-progress-bar">
              <div className="gcash-progress-fill" style={{ animationDuration: `${countdown + 1}s` }} />
            </div>
            <div className="gcash-dispensing-countdown">~{countdown}s remaining</div>
            <div className="gcash-dispensing-thanks">
              Thank you, <strong>{donorName}</strong>! 🧡<br />
              Your ₱{tier.php} donation is feeding stray animals right now.
            </div>
          </div>
        )}

        {/* STEP 4 — SUCCESS */}
        {step === STEP.SUCCESS && (
          <div className="gcash-success">
            <div className="gcash-success-icon">🎉</div>
            <div className="gcash-success-title">Mission Complete!</div>
            <div className="gcash-success-sub">
              <strong>{tier.grams}g</strong> of food dispensed for our furry friends!
            </div>
            <div className="gcash-success-card">
              <div className="gcash-success-row"><span>Donor</span><strong>{donorName}</strong></div>
              <div className="gcash-success-row"><span>Amount</span><strong>₱{tier.php}</strong></div>
              <div className="gcash-success-row"><span>Food</span><strong>{tier.grams}g dispensed</strong></div>
              {message && <div className="gcash-success-message">💬 &ldquo;{message}&rdquo;</div>}
            </div>
            <div className="gcash-success-logged">🔒 Donation logged on the Donor Wall</div>
            <button className="gcash-done-btn" onClick={onClose}>Close & See Live Feed 📷</button>
          </div>
        )}

      </div>
    </div>
  )
}
