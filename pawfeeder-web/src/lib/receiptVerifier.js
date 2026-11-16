// ============================================================
//  GCash Receipt OCR & Security Verifier
//  Target Account: JONARD S. | 09535497843
// ============================================================

export const GCASH_ACCOUNT = {
  maskedName: 'JONARD S.',
  number: '09535497843',
  formattedNumber: '+63 953 549 7843',
  userIdSuffix: '',
}

/**
 * Compute SHA-256 hash of an uploaded image file so the exact same image
 * can never be reused across multiple donations.
 */
export async function computeImageHash(file) {
  const buffer = await file.arrayBuffer()
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Strict validation for 13-digit GCash Reference Numbers.
 * Real GCash reference numbers are 13 digits (e.g. "0012 345 678901" -> "0012345678901").
 */
export function validateGcashRefCode(rawCode) {
  const cleaned = String(rawCode || '').replace(/\s|-/g, '')

  if (!/^\d{13}$/.test(cleaned)) {
    return {
      valid: false,
      cleaned,
      reason: 'GCash Reference Numbers must be exactly 13 digits (numbers only).',
    }
  }

  // Block all-same digits (e.g. 1111111111111, 0000000000000)
  if (/^(\d)\1{12}$/.test(cleaned)) {
    return {
      valid: false,
      cleaned,
      reason: 'Invalid reference number pattern detected.',
    }
  }

  // Block sequential test numbers (1234567890123, 9876543210987, etc.)
  const bannedSequences = [
    '1234567890123',
    '0123456789012',
    '9876543210987',
    '1231231231231',
    '1000000000000',
  ]
  if (bannedSequences.includes(cleaned)) {
    return {
      valid: false,
      cleaned,
      reason: 'Sequential or placeholder reference numbers are not allowed.',
    }
  }

  // Block if a single digit makes up >= 10 of the 13 digits
  const counts = {}
  for (const ch of cleaned) counts[ch] = (counts[ch] || 0) + 1
  if (Math.max(...Object.values(counts)) >= 10) {
    return {
      valid: false,
      cleaned,
      reason: 'Reference number appears invalid (too many repeated digits).',
    }
  }

  return { valid: true, cleaned, reason: null }
}

/**
 * Cached Tesseract.js script + worker singleton so OCR runs in ~2-3s instead of ~20s
 */
let tesseractScriptPromise = null
let ocrWorkerPromise = null
let activeProgressCb = null

function loadTesseractScript() {
  if (window.Tesseract) return Promise.resolve()
  if (tesseractScriptPromise) return tesseractScriptPromise

  tesseractScriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-tesseract-cdn]')
    if (existing) {
      existing.addEventListener('load', resolve)
      existing.addEventListener('error', reject)
      return
    }
    const script = document.createElement('script')
    script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js'
    script.async = true
    script.setAttribute('data-tesseract-cdn', 'true')
    script.onload = resolve
    script.onerror = () => {
      tesseractScriptPromise = null
      reject(new Error('Failed to load OCR scanner. Check your internet connection.'))
    }
    document.head.appendChild(script)
  })
  return tesseractScriptPromise
}

async function getOcrWorker() {
  if (ocrWorkerPromise) return ocrWorkerPromise

  ocrWorkerPromise = (async () => {
    await loadTesseractScript()
    const worker = await window.Tesseract.createWorker('eng', 1, {
      logger: (m) => {
        if (m.status === 'recognizing text' && typeof m.progress === 'number') {
          activeProgressCb?.(Math.max(20, Math.round(m.progress * 100)))
        }
      },
    })
    return worker
  })().catch((err) => {
    ocrWorkerPromise = null
    throw err
  })

  return ocrWorkerPromise
}

/**
 * Pre-warm Tesseract script and worker while donor is viewing the QR step
 */
export function preloadOcrScanner() {
  getOcrWorker().catch(() => {})
}

/**
 * Downscale large phone screenshots (~900px max width) & apply high-contrast grayscale
 * on an offscreen canvas so Tesseract runs 4-6x faster with better accuracy.
 */
async function preprocessImageForOcr(file) {
  return new Promise((resolve) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      const MAX_WIDTH = 900
      const scale = img.width > MAX_WIDTH ? MAX_WIDTH / img.width : 1
      const w = Math.round(img.width * scale)
      const h = Math.round(img.height * scale)

      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        resolve(file)
        return
      }
      ctx.filter = 'grayscale(1) contrast(1.4) brightness(1.05)'
      ctx.drawImage(img, 0, 0, w, h)
      canvas.toBlob(
        (blob) => resolve(blob || file),
        'image/jpeg',
        0.85
      )
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(file)
    }
    img.src = url
  })
}

function withTimeout(promise, ms, label = 'Timed out') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ])
}

async function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const dataUrl = String(reader.result || '')
      const commaIdx = dataUrl.indexOf(',')
      resolve(commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : '')
    }
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

async function scanViaCloudApi(preparedBlob, expectedPhp, onProgress) {
  onProgress?.(35)
  const imageBase64 = await blobToBase64(preparedBlob)
  onProgress?.(55)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 9000)

  try {
    const res = await fetch('/api/verify-receipt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageBase64,
        mimeType: preparedBlob.type || 'image/jpeg',
        expectedPhp,
      }),
      signal: controller.signal,
    })
    onProgress?.(85)
    if (!res.ok) {
      throw new Error(`Cloud OCR HTTP ${res.status}`)
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

async function recognizeTextFromImage(file, onProgress) {
  onProgress?.(10)
  const [worker, preparedImage] = await withTimeout(
    Promise.all([getOcrWorker(), preprocessImageForOcr(file)]),
    8000,
    'OCR scanner timed out while loading. Please enter your 13-digit Ref No. below.'
  )
  onProgress?.(25)
  activeProgressCb = onProgress
  try {
    const result = await withTimeout(
      worker.recognize(preparedImage),
      10000,
      'Receipt scan took too long. Please enter your 13-digit Ref No. below.'
    )
    return result.data.text || ''
  } finally {
    activeProgressCb = null
  }
}

/**
 * Scan and verify a GCash Receipt screenshot against:
 * 1. Authentic GCash Receipt keywords
 * 2. Recipient match (JONARD S. / 09535497843)
 * 3. Expected Donation Amount (e.g. ₱10.00, ₱30.00, ₱50.00, ₱70.00, ₱90.00)
 * 4. 13-digit Reference Number extraction (4-3-6 grouped or 13 contiguous digits)
 */
export async function scanGcashReceipt(file, expectedPhp, onProgress) {
  const imageHash = await computeImageHash(file)
  onProgress?.(15)
  const preparedBlob = await preprocessImageForOcr(file)

  let cloudResult = null
  let rawText = ''

  try {
    cloudResult = await scanViaCloudApi(preparedBlob, expectedPhp, onProgress)
    rawText = cloudResult?.rawText || ''
  } catch (cloudErr) {
    console.warn('[Cloud OCR fallback -> local Tesseract]', cloudErr?.message)
    rawText = await recognizeTextFromImage(file, onProgress)
  }

  const combinedText = [
    rawText,
    cloudResult?.recipientText || '',
    cloudResult?.extractedRef || '',
    cloudResult?.detectedAmount ? `${cloudResult.detectedAmount}.00` : '',
  ].join('\n')

  const upper = combinedText.toUpperCase()
  const digitsOnly = combinedText.replace(/\D/g, '')

  // 1. Check if it looks like a GCash receipt
  const hasGcashKeywords =
    Boolean(cloudResult?.hasGcashKeywords) ||
    upper.includes('REF') ||
    upper.includes('AMOUNT') ||
    upper.includes('TOTAL') ||
    upper.includes('SENT') ||
    upper.includes('GCASH') ||
    upper.includes('INSTAPAY') ||
    upper.includes('EXPRESS')

  // 2. Check Recipient (09535497843 / +63 953 549 7843 / JONARD S.)
  const recipientMatched =
    digitsOnly.includes('9535497843') ||
    digitsOnly.includes('953549') ||
    digitsOnly.includes('5497843') ||
    upper.includes('953 549') ||
    upper.includes('549 7843') ||
    upper.includes('JONARD') ||
    /JO[\s*•.]*RD/.test(upper)

  // 3. Check Amount (e.g. "30.00" for ₱30)
  const amountRegex = new RegExp(`(?<!\\d)${expectedPhp}[.,]\\s*00(?!\\d)`)
  const amountMatched =
    Number(cloudResult?.detectedAmount) === Number(expectedPhp) ||
    amountRegex.test(combinedText) ||
    upper.includes(`PHP ${expectedPhp}`) ||
    upper.includes(`P${expectedPhp}.00`) ||
    upper.includes(`₱${expectedPhp}`)

  // Check if a different tier amount was found instead
  const allTiers = [10, 30, 50, 70, 90]
  let detectedAmount = amountMatched ? expectedPhp : (cloudResult?.detectedAmount ? Number(cloudResult.detectedAmount) : null)
  if (!detectedAmount) {
    for (const t of allTiers) {
      const r = new RegExp(`(?<!\\d)${t}[.,]\\s*00(?!\\d)`)
      if (r.test(combinedText)) {
        detectedAmount = t
        break
      }
    }
  }

  // 4. Extract 13-digit Reference Number
  let extractedRef = cloudResult?.extractedRef && /^\d{13}$/.test(String(cloudResult.extractedRef).replace(/\D/g, ''))
    ? String(cloudResult.extractedRef).replace(/\D/g, '')
    : null

  // First look near "Ref" keyword
  if (!extractedRef) {
    const refSectionMatch = combinedText.match(/Ref(?:erence)?[\s.:No#]*([0-9][0-9\s-]{11,18}[0-9])/i)
    if (refSectionMatch) {
      const candidate = refSectionMatch[1].replace(/\D/g, '')
      if (candidate.length === 13) {
        extractedRef = candidate
      } else if (candidate.length > 13) {
        extractedRef = candidate.slice(0, 13)
      }
    }
  }

  // Fallback: Look for GCash 4-3-6 digit grouping anywhere in text
  if (!extractedRef) {
    const groupedMatch = combinedText.match(/(?<!\d)(\d{4})[\s-]+(\d{3})[\s-]+(\d{6})(?!\d)/)
    if (groupedMatch) {
      extractedRef = `${groupedMatch[1]}${groupedMatch[2]}${groupedMatch[3]}`
    }
  }

  // Fallback: Look for any 13-digit sequence that isn't the phone number
  if (!extractedRef) {
    const thirteenMatches = combinedText.match(/(?<!\d)\d{13}(?!\d)/g) || []
    for (const m of thirteenMatches) {
      if (!m.includes('9535497843')) {
        extractedRef = m
        break
      }
    }
  }

  return {
    imageHash,
    rawText: combinedText,
    hasGcashKeywords,
    recipientMatched,
    amountMatched,
    detectedAmount,
    extractedRef,
  }
}
