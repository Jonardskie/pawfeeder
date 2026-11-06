import { useState, useEffect, useRef } from 'react'
import { ref, set, push, get, onValue } from 'firebase/database'
import {
  X, Copy, CheckCircle2, AlertTriangle, Heart, Send,
  ExternalLink, Download, Upload, ShieldCheck, FileCheck2, Smartphone
} from 'lucide-react'
import confetti from 'canvas-confetti'
import gcashQr from '../../assets/gcash_qr.jpg'
import {
  GCASH_ACCOUNT,
  scanGcashReceipt,
  validateGcashRefCode,
} from '../../lib/receiptVerifier'
import './GCashModal.css'

const STEP = { QR: 'qr', VERIFY: 'verify', DISPENSING: 'dispensing', SUCCESS: 'success' }

const GCASH_NAME   = GCASH_ACCOUNT.maskedName
const GCASH_NUMBER = GCASH_ACCOUNT.number

export default function GCashModal({ tier, db, unitId = 'unit001', onClose }) {
  const [step, setStep]           = useState(STEP.QR)
  const [donorName, setDonorName] = useState('')
  const [refCode, setRefCode]     = useState('')
  const [senderLast4, setSenderLast4] = useState('')
  const [message, setMessage]     = useState('')
  const [copied, setCopied]       = useState(false)
  const [redirectToast, setRedirectToast] = useState(false)
  const [error, setError]         = useState('')
  const [loading, setLoading]     = useState(false)
  const [countdown, setCountdown] = useState(0)

  // Receipt OCR & Verification state
  const [receiptFile, setReceiptFile]       = useState(null)
  const [receiptPreview, setReceiptPreview] = useState('')
  const [scanning, setScanning]             = useState(false)
  const [scanProgress, setScanProgress]     = useState(0)
  const [scanResult, setScanResult]         = useState(null)
  const [manualMode, setManualMode]         = useState(false)

  // Real-time Bowl Weight & Dispense Status during STEP.DISPENSING
  const [liveBowlWeight, setLiveBowlWeight] = useState(null)
  const [startBowlWeight, setStartBowlWeight] = useState(null)

  const timerRef = useRef(null)
  const fileInputRef = useRef(null)

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Clean up object URL preview
  useEffect(() => {
    return () => {
      if (receiptPreview) URL.revokeObjectURL(receiptPreview)
    }
  }, [receiptPreview])

  // Listen to real-time ESP32 weight & dispense status during STEP.DISPENSING
  useEffect(() => {
    if (step !== STEP.DISPENSING) return
    const secs = Math.round(tier.grams * 0.08 + 8)
    setCountdown(secs)

    let unsubStatus = null
    let unsubActive = null
    let sawActiveTrue = false

    if (db) {
      const statusRef = ref(db, `feeder/${unitId}/status`)
      unsubStatus = onValue(statusRef, (snap) => {
        const d = snap.val()
        if (d && typeof d.bowl_weight_g === 'number') {
          setLiveBowlWeight(d.bowl_weight_g)
          setStartBowlWeight(prev => (prev === null ? d.bowl_weight_g : prev))
        }
      })

      const activeRef = ref(db, `feeder/${unitId}/cmd/dispense/active`)
      unsubActive = onValue(activeRef, (snap) => {
        const isActive = snap.val()
        if (isActive === true) {
          sawActiveTrue = true
        } else if (sawActiveTrue && isActive === false) {
          // ESP32 picked up the command and finished!
          clearInterval(timerRef.current)
          setTimeout(() => {
            setStep(STEP.SUCCESS)
            fireConfetti()
          }, 1200)
        }
      })
    }

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

    return () => {
      clearInterval(timerRef.current)
      if (unsubStatus) unsubStatus()
      if (unsubActive) unsubActive()
    }
  }, [step, db, unitId, tier.grams])

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

  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  const isAndroid = /Android/i.test(navigator.userAgent)

  function handleOpenGCash() {
    navigator.clipboard.writeText(GCASH_NUMBER)
    setCopied(true)
    setRedirectToast(true)

    if (isMobile) {
      if (isAndroid) {
        window.location.href = 'intent://#Intent;scheme=gcash;package=com.globe.gcash.android;end'
      } else {
        window.location.href = 'gcash://'
      }
    }

    setTimeout(() => {
      setRedirectToast(false)
    }, 6000)
  }

  function handleSaveQr() {
    const link = document.createElement('a')
    link.href = gcashQr
    link.download = `PawFeeder_GCash_QR_P${tier.php}.jpg`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  // Handle GCash Receipt Screenshot Upload + OCR Scan
  async function handleReceiptUpload(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setError('')

    if (!file.type.startsWith('image/')) {
      setError('Please upload a valid image screenshot (JPG or PNG).')
      return
    }

    if (receiptPreview) URL.revokeObjectURL(receiptPreview)
    setReceiptFile(file)
    setReceiptPreview(URL.createObjectURL(file))
    setScanning(true)
    setScanProgress(5)
    setScanResult(null)

    try {
      const result = await scanGcashReceipt(file, tier.php, (p) => setScanProgress(p))
      setScanResult(result)

      if (result.extractedRef) {
        setRefCode(result.extractedRef)
      }

      if (!result.hasGcashKeywords) {
        setError('This image does not look like a GCash receipt. Please upload the full GCash receipt screenshot.')
      } else if (result.detectedAmount && result.detectedAmount !== tier.php) {
        setError(`Receipt shows ₱${result.detectedAmount}.00, but you selected the ₱${tier.php} (${tier.grams}g) tier.`)
      } else if (!result.extractedRef) {
        setError('Could not automatically read the 13-digit Reference No. Please check or type it below.')
      }
    } catch (err) {
      console.error('Receipt scan error:', err)
      setError('Could not scan screenshot automatically. Please verify your 13-digit Reference No. below.')
    } finally {
      setScanning(false)
      setScanProgress(100)
    }
  }

  async function handleVerify() {
    setError('')
    const name = donorName.trim()
    if (!name || name.length < 2) {
      setError('Please enter your name.')
      return
    }

    // Require either a scanned receipt OR explicit manual mode with sender last 4 digits
    if (!receiptFile && !manualMode) {
      setError('Please upload your GCash receipt screenshot, or switch to manual verification below.')
      return
    }

    if (scanResult && !scanResult.hasGcashKeywords && !manualMode) {
      setError('Uploaded image is not a valid GCash receipt. Please upload a clear GCash receipt screenshot.')
      return
    }

    if (scanResult?.detectedAmount && scanResult.detectedAmount !== tier.php) {
      setError(`Receipt amount (₱${scanResult.detectedAmount}.00) does not match selected tier (₱${tier.php}.00).`)
      return
    }

    if (manualMode && !/^\d{4}$/.test(senderLast4.trim())) {
      setError('Please enter the last 4 digits of the GCash mobile number used to send the payment.')
      return
    }

    // Strict 13-digit reference code validation
    const refCheck = validateGcashRefCode(refCode)
    if (!refCheck.valid) {
      setError(refCheck.reason)
      return
    }
    const cleanRef = refCheck.cleaned

    setLoading(true)
    try {
      if (db) {
        const snap = await get(ref(db, `feeder/${unitId}/donations`))
        if (snap.exists()) {
          const allDonations = Object.values(snap.val())

          // 1. Check duplicate 13-digit Reference Code
          const dupRef = allDonations.find(
            l => l.refCode && String(l.refCode).replace(/\s|-/g, '') === cleanRef
          )
          if (dupRef) {
            setError(
              `Reference No. ${cleanRef} was already used by "${dupRef.donorName}" on ${new Date(dupRef.timestamp).toLocaleDateString()}. Each GCash receipt can only be used once.`
            )
            setLoading(false)
            return
          }

          // 2. Check duplicate Screenshot SHA-256 Hash
          if (scanResult?.imageHash) {
            const dupHash = allDonations.find(
              l => l.receiptHash && l.receiptHash === scanResult.imageHash
            )
            if (dupHash) {
              setError(
                `This exact receipt screenshot was already uploaded by "${dupHash.donorName}". Please upload your new GCash receipt.`
              )
              setLoading(false)
              return
            }
          }
        }

        // Log verified donation to Firebase
        await push(ref(db, `feeder/${unitId}/donations`), {
          donorName: name,
          refCode: cleanRef,
          senderLast4: manualMode ? senderLast4.trim() : null,
          receiptVerified: Boolean(
            scanResult?.hasGcashKeywords &&
            (scanResult?.recipientMatched || scanResult?.amountMatched)
          ),
          receiptHash: scanResult?.imageHash || null,
          message: message.trim(),
          amountPhp: tier.php,
          grams: tier.grams,
          timestamp: Date.now(),
          source: 'gcash_online',
        })

        // Trigger weight-controlled dispense on Control ESP32
        await set(ref(db, `feeder/${unitId}/cmd/dispense`), {
          active: true,
          grams: tier.grams,
          source: 'gcash_donation',
          donor: name,
          refCode: cleanRef,
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

  const dispensedSoFar =
    liveBowlWeight !== null && startBowlWeight !== null
      ? Math.max(0, liveBowlWeight - startBowlWeight)
      : null

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
                  <div className="gcash-subtitle">Scan or Open App · Pay · Verify Receipt · Feed! 🐾</div>
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
              <div className="gcash-step-item"><span className="gcash-step-num">2</span> Send <strong>₱{tier.php}.00</strong> to <strong>{GCASH_NAME}</strong> ({GCASH_NUMBER})</div>
              <div className="gcash-step-item"><span className="gcash-step-num">3</span> Save or screenshot your <strong>GCash Receipt</strong></div>
              <div className="gcash-step-item"><span className="gcash-step-num">4</span> Tap below to <strong>Scan Receipt & Feed</strong>!</div>
            </div>

            <button className="gcash-next-btn" onClick={() => setStep(STEP.VERIFY)}>
              <Send size={16} />
              I&apos;ve Sent ₱{tier.php} — Verify Receipt
            </button>
          </>
        )}

        {/* STEP 2 — VERIFY RECEIPT & REFERENCE */}
        {step === STEP.VERIFY && (
          <>
            <div className="gcash-header">
              <div className="gcash-logo-row">
                <div className="gcash-logo-badge gcash-logo-badge--green">
                  <ShieldCheck size={22} />
                </div>
                <div>
                  <div className="gcash-title">Verify GCash Receipt</div>
                  <div className="gcash-subtitle">Smart OCR checks recipient, amount & 13-digit Ref No.</div>
                </div>
              </div>
            </div>

            <div className="gcash-amount-pill gcash-amount-pill--verify">
              <span className="gcash-amount-label">Verifying</span>
              <span className="gcash-amount-value">₱{tier.php}</span>
              <span className="gcash-amount-sub">{tier.grams}g • To {GCASH_NAME}</span>
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

              {/* Receipt Screenshot Upload Box */}
              <label className="gcash-label">
                GCash Receipt Screenshot {!manualMode && <span className="gcash-required">*</span>}
              </label>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleReceiptUpload}
                style={{ display: 'none' }}
              />

              <div
                className={`gcash-upload-box ${receiptFile ? 'gcash-upload-box--has-file' : ''}`}
                onClick={() => fileInputRef.current?.click()}
              >
                {receiptPreview ? (
                  <div className="gcash-upload-preview-row">
                    <img src={receiptPreview} alt="Receipt preview" className="gcash-receipt-thumb" />
                    <div className="gcash-upload-meta">
                      <div className="gcash-upload-filename">
                        <FileCheck2 size={14} color="#00c896" />
                        <span>{receiptFile?.name}</span>
                      </div>
                      {scanning ? (
                        <div className="gcash-scan-progress-wrap">
                          <div className="gcash-scan-status">
                            <span className="gcash-spinner" /> Scanning receipt... {scanProgress}%
                          </div>
                          <div className="gcash-scan-bar">
                            <div className="gcash-scan-bar-fill" style={{ width: `${scanProgress}%` }} />
                          </div>
                        </div>
                      ) : scanResult ? (
                        <div className="gcash-scan-checks">
                          <span className={`gcash-check-pill ${scanResult.recipientMatched ? 'ok' : 'warn'}`}>
                            {scanResult.recipientMatched ? '✓ Recipient Matched' : '• Check Recipient'}
                          </span>
                          <span className={`gcash-check-pill ${scanResult.amountMatched ? 'ok' : 'warn'}`}>
                            {scanResult.amountMatched ? `✓ ₱${tier.php}.00 Verified` : '• Check Amount'}
                          </span>
                          <span className={`gcash-check-pill ${scanResult.extractedRef ? 'ok' : 'warn'}`}>
                            {scanResult.extractedRef ? '✓ 13-Digit Ref Extracted' : '• Enter Ref Below'}
                          </span>
                        </div>
                      ) : null}
                      <span className="gcash-upload-change">Tap to replace screenshot</span>
                    </div>
                  </div>
                ) : (
                  <div className="gcash-upload-empty">
                    <Upload size={22} className="gcash-upload-icon" />
                    <div className="gcash-upload-title">Upload GCash Receipt Screenshot</div>
                    <div className="gcash-upload-sub">
                      Auto-extracts your 13-digit Reference No. & verifies ₱{tier.php}.00 payment
                    </div>
                  </div>
                )}
              </div>

              {/* Toggle for Laptop users who paid on their phone */}
              <button
                type="button"
                className="gcash-manual-toggle"
                onClick={() => setManualMode(prev => !prev)}
              >
                <Smartphone size={13} />
                {manualMode
                  ? 'Use Receipt Screenshot Scanner instead'
                  : 'Paid on another phone? Verify manually with 13-digit Ref No.'}
              </button>

              {manualMode && (
                <>
                  <label className="gcash-label" htmlFor="gcash-sender-last4">
                    Last 4 Digits of Your GCash Mobile No. <span className="gcash-required">*</span>
                  </label>
                  <input
                    id="gcash-sender-last4"
                    className="gcash-input gcash-input--mono"
                    type="text"
                    inputMode="numeric"
                    placeholder="e.g. 6270"
                    value={senderLast4}
                    onChange={e => setSenderLast4(e.target.value.replace(/\D/g, '').slice(0, 4))}
                    maxLength={4}
                  />
                </>
              )}

              <label className="gcash-label" htmlFor="gcash-ref-code">
                13-Digit GCash Reference No. <span className="gcash-required">*</span>
              </label>
              <input
                id="gcash-ref-code"
                className="gcash-input gcash-input--mono"
                type="text"
                inputMode="numeric"
                placeholder="13 digits (e.g. 0012345678901)"
                value={refCode}
                onChange={e => setRefCode(e.target.value.replace(/\D/g, '').slice(0, 13))}
                maxLength={13}
              />
              <div className="gcash-input-hint">
                {refCode.length}/13 digits • Each GCash reference number & receipt can only be used once.
              </div>

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
                <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
                <span>{error}</span>
              </div>
            )}

            <div className="gcash-verify-actions">
              <button className="gcash-back-btn" onClick={() => { setStep(STEP.QR); setError('') }}>
                ← Back
              </button>
              <button
                className="gcash-verify-btn"
                onClick={handleVerify}
                disabled={loading || scanning}
              >
                {loading
                  ? <><span className="gcash-spinner" /> Verifying...</>
                  : scanning
                  ? <><span className="gcash-spinner" /> Scanning...</>
                  : <><Heart size={16} /> Verify &amp; Feed {tier.grams}g!</>}
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
              Motor running • Target: <strong>{tier.grams}g</strong>
              {dispensedSoFar !== null && (
                <> • Dispensed: <strong>{dispensedSoFar.toFixed(1)}g</strong></>
              )}
            </div>
            <div className="gcash-progress-bar">
              <div className="gcash-progress-fill" style={{ animationDuration: `${countdown + 1}s` }} />
            </div>
            <div className="gcash-dispensing-countdown">
              {liveBowlWeight !== null
                ? `Live Bowl Scale: ${liveBowlWeight.toFixed(1)}g (~${countdown}s remaining)`
                : `~${countdown}s remaining`}
            </div>
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
              <div className="gcash-success-row"><span>Amount</span><strong>₱{tier.php}.00</strong></div>
              <div className="gcash-success-row"><span>Ref No.</span><strong>{refCode}</strong></div>
              <div className="gcash-success-row"><span>Food</span><strong>{tier.grams}g dispensed</strong></div>
              {message && <div className="gcash-success-message">💬 &ldquo;{message}&rdquo;</div>}
            </div>
            <div className="gcash-success-logged">🔒 Verified donation logged on the Donor Wall</div>
            <button className="gcash-done-btn" onClick={onClose}>Close &amp; See Live Feed 📷</button>
          </div>
        )}

      </div>
    </div>
  )
}
