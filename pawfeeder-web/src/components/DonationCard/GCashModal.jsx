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
  preloadOcrScanner,
  scanGcashReceipt,
  validateGcashRefCode,
} from '../../lib/receiptVerifier'
import './GCashModal.css'

const STEP = { QR: 'qr', VERIFY: 'verify', DISPENSING: 'dispensing', SUCCESS: 'success' }

export default function GCashModal({ tier, db, unitId = 'unit001', onClose }) {
  const [gcashAccount, setGcashAccount] = useState({
    maskedName: GCASH_ACCOUNT.maskedName,
    number: GCASH_ACCOUNT.number,
    qrSrc: gcashQr,
  })
  const GCASH_NAME   = gcashAccount.maskedName
  const GCASH_NUMBER = gcashAccount.number
  const activeQrSrc  = gcashAccount.qrSrc || gcashQr

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
  const [liveDispensedG, setLiveDispensedG] = useState(null)
  const [machinePhase, setMachinePhase] = useState('waiting') // 'waiting' | 'running' | 'done'

  const timerRef = useRef(null)
  const fileInputRef = useRef(null)

  useEffect(() => {
    preloadOcrScanner()
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Subscribe to dynamic GCash recipient config from Firebase
  useEffect(() => {
    if (!db) return
    const cfgRef = ref(db, `feeder/${unitId}/config/gcash`)
    const unsub = onValue(cfgRef, (snap) => {
      const val = snap.val()
      if (val && (val.number || val.maskedName)) {
        setGcashAccount({
          maskedName: val.maskedName || GCASH_ACCOUNT.maskedName,
          number: val.number || GCASH_ACCOUNT.number,
          qrSrc: val.qrDataUrl || gcashQr,
        })
      }
    })
    return () => unsub()
  }, [db, unitId])

  // Clean up object URL preview
  useEffect(() => {
    return () => {
      if (receiptPreview) URL.revokeObjectURL(receiptPreview)
    }
  }, [receiptPreview])

  // Listen to real-time ESP32 weight & dispense status during STEP.DISPENSING
  useEffect(() => {
    if (step !== STEP.DISPENSING) return
    const secs = Math.round(tier.grams * 0.25 + 25)
    setCountdown(secs)
    setMachinePhase('waiting')
    setLiveDispensedG(0)

    let unsubStatus = null
    let sawDispensingTrue = false

    if (db) {
      const statusRef = ref(db, `feeder/${unitId}/status`)
      unsubStatus = onValue(statusRef, (snap) => {
        const d = snap.val()
        if (!d) return

        if (typeof d.bowl_weight_g === 'number') {
          setLiveBowlWeight(d.bowl_weight_g)
          setStartBowlWeight(prev => (prev === null ? d.bowl_weight_g : prev))
        }

        if (typeof d.dispensed_g === 'number' && sawDispensingTrue) {
          setLiveDispensedG(Math.max(0, d.dispensed_g))
        }

        if (d.dispensing === true) {
          sawDispensingTrue = true
          setMachinePhase('running')
        } else if (sawDispensingTrue && d.dispensing === false) {
          // ESP32 finished the full dispense cycle!
          setMachinePhase('done')
          setLiveDispensedG(typeof d.dispensed_g === 'number' ? d.dispensed_g : tier.grams)
          clearInterval(timerRef.current)
          setTimeout(() => {
            setStep(STEP.SUCCESS)
            fireConfetti()
          }, 800)
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
    link.href = activeQrSrc
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
      const result = await scanGcashReceipt(file, tier.php, (p) => setScanProgress(p), gcashAccount)
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
      setError(err?.message || 'Auto-scan timed out. Please type your 13-digit Reference No. above and click Verify & Feed!')
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
    liveDispensedG !== null && machinePhase !== 'waiting'
      ? Math.max(0, liveDispensedG)
      : liveBowlWeight !== null && startBowlWeight !== null
      ? Math.max(0, liveBowlWeight - startBowlWeight)
      : 0

  const progressPct =
    machinePhase === 'done'
      ? 100
      : machinePhase === 'running'
      ? Math.min(98, Math.max(8, Math.round((dispensedSoFar / tier.grams) * 100)))
      : 6

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
                  <div className="gcash-title">Pay with GCash • ₱{tier.php} ({tier.grams}g)</div>
                  <div className="gcash-subtitle">1. Pay  •  2. Upload Receipt  •  3. Feed! 🐾</div>
                </div>
              </div>
            </div>

            <div className="gcash-scroll-body">
              <div className="gcash-qr-grid">
                {/* Left: QR Code with Save Option */}
                <div className="gcash-qr-wrapper">
                  <img src={activeQrSrc} alt="GCash QR Code" className="gcash-qr-img" />
                  <button className="gcash-save-qr-btn" onClick={handleSaveQr}>
                    <Download size={12} />
                    Save QR
                  </button>
                </div>

                {/* Right: Account Details, Mobile Launch & Steps */}
                <div className="gcash-qr-side">
                  {isMobile ? (
                    <div className="gcash-app-launch-card">
                      <button className="gcash-launch-app-btn" onClick={handleOpenGCash}>
                        <ExternalLink size={16} />
                        Open GCash App &amp; Copy No.
                      </button>
                      {redirectToast && (
                        <div className="gcash-launch-toast animate-fade-in">
                          📋 <strong>{GCASH_NUMBER}</strong> copied! Enter <strong>₱{tier.php}</strong>.
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="gcash-app-launch-card gcash-app-launch-card--laptop">
                      <div className="gcash-laptop-hint">
                        💻 Open <strong>GCash on your phone</strong> → tap <strong>Scan QR</strong>
                      </div>
                    </div>
                  )}

                  <div className="gcash-details-box">
                    <div className="gcash-detail-row">
                      <span className="gcash-detail-label">Account Name</span>
                      <span className="gcash-detail-val">{GCASH_NAME}</span>
                    </div>
                    <div className="gcash-detail-row">
                      <span className="gcash-detail-label">Mobile No.</span>
                      <div className="gcash-detail-copy-row">
                        <span className="gcash-detail-val gcash-number">{GCASH_NUMBER}</span>
                        <button className="gcash-copy-btn" onClick={copyNumber}>
                          {copied ? <CheckCircle2 size={12} /> : <Copy size={12} />}
                          {copied ? 'Copied!' : 'Copy'}
                        </button>
                      </div>
                    </div>
                    <div className="gcash-detail-row gcash-detail-row--amount">
                      <span className="gcash-detail-label">Amount</span>
                      <span className="gcash-detail-val gcash-send-amount">₱{tier.php}.00 → {tier.grams}g</span>
                    </div>
                  </div>

                  <div className="gcash-steps-hint">
                    <div className="gcash-step-item"><span className="gcash-step-num">1</span> Scan QR / Copy</div>
                    <div className="gcash-step-item"><span className="gcash-step-num">2</span> Send <strong>₱{tier.php}</strong></div>
                    <div className="gcash-step-item"><span className="gcash-step-num">3</span> Save Receipt</div>
                    <div className="gcash-step-item"><span className="gcash-step-num">4</span> Tap Next</div>
                  </div>
                </div>
              </div>
            </div>

            <div className="gcash-modal-footer">
              <button className="gcash-next-btn" onClick={() => setStep(STEP.VERIFY)}>
                <Send size={16} />
                Next: Upload Receipt →
              </button>
            </div>
          </>
        )}

        {/* STEP 2 — VERIFY RECEIPT & REFERENCE */}
        {step === STEP.VERIFY && (
          <>
            <div className="gcash-header">
              <div className="gcash-logo-row">
                <div className="gcash-logo-badge gcash-logo-badge--green">
                  <ShieldCheck size={20} />
                </div>
                <div>
                  <div className="gcash-title">Upload Receipt • ₱{tier.php} ({tier.grams}g)</div>
                  <div className="gcash-subtitle">Upload your GCash receipt to feed the animals</div>
                </div>
              </div>
            </div>

            <div className="gcash-scroll-body">
              <div className="gcash-form">
                <div className="gcash-form-row">
                  <div className="gcash-field">
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
                  </div>

                  <div className="gcash-field">
                    <label className="gcash-label" htmlFor="gcash-ref-code">
                      13-Digit GCash Ref No. <span className="gcash-required">*</span>
                    </label>
                    <input
                      id="gcash-ref-code"
                      className="gcash-input gcash-input--mono"
                      type="text"
                      inputMode="numeric"
                      placeholder="13 digits (auto-filled)"
                      value={refCode}
                      onChange={e => setRefCode(e.target.value.replace(/\D/g, '').slice(0, 13))}
                      maxLength={13}
                    />
                  </div>
                </div>

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
                              {scanResult.extractedRef ? '✓ 13-Digit Ref Extracted' : '• Enter Ref Above'}
                            </span>
                          </div>
                        ) : null}
                        <span className="gcash-upload-change">Tap to replace screenshot</span>
                      </div>
                    </div>
                  ) : (
                    <div className="gcash-upload-empty">
                      <Upload size={18} className="gcash-upload-icon" />
                      <div className="gcash-upload-title">Tap to Upload GCash Receipt</div>
                      <div className="gcash-upload-sub">
                        Auto-fills your 13-digit Ref No. ({refCode.length}/13 digits)
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
                  <div className="gcash-field">
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
                  </div>
                )}

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
                  rows={1}
                />
              </div>

              {error && (
                <div className="gcash-error-box">
                  <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
                  <span>{error}</span>
                </div>
              )}
            </div>

            <div className="gcash-modal-footer">
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
                    ? <><span className="gcash-spinner" /> Sending...</>
                    : scanning
                    ? <><span className="gcash-spinner" /> Reading...</>
                    : <><Heart size={16} /> Confirm &amp; Feed {tier.grams}g! 🐾</>}
                </button>
              </div>
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
            <div className="gcash-dispensing-title">
              {machinePhase === 'waiting'
                ? 'Connecting to Feeder...'
                : machinePhase === 'done'
                ? 'Dispense Complete!'
                : 'Feeding the Animals!'}
            </div>
            <div className="gcash-dispensing-sub">
              {machinePhase === 'waiting' ? (
                <>Sending <strong>{tier.grams}g</strong> command to ESP32...</>
              ) : (
                <>
                  Motor running • Target: <strong>{tier.grams}g</strong> • Dispensed:{' '}
                  <strong>{dispensedSoFar.toFixed(1)}g</strong> ({progressPct}%)
                </>
              )}
            </div>
            <div className="gcash-progress-bar">
              <div
                className="gcash-progress-fill"
                style={{
                  width: `${progressPct}%`,
                  animation: 'none',
                  transition: 'width 0.4s ease',
                }}
              />
            </div>
            <div className="gcash-dispensing-countdown">
              {liveBowlWeight !== null
                ? `Live Bowl Scale: ${liveBowlWeight.toFixed(1)}g • Safety timeout: ${countdown}s`
                : `Waiting for live scale... (${countdown}s)`}
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
