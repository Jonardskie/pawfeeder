// ============================================================
//  GCash Receipt OCR & Security Verifier
//  Target Account: K** AL**N S. | 09556856270 | ID: ••••9TC2YV
// ============================================================

export const GCASH_ACCOUNT = {
  maskedName: 'K** AL**N S.',
  number: '09556856270',
  formattedNumber: '+63 955 685 6270',
  userIdSuffix: '9TC2YV',
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
 * Load Tesseract.js via CDN on demand (keeps bundle light and works without extra npm packages)
 */
async function recognizeTextFromImage(file, onProgress) {
  if (!window.Tesseract) {
    onProgress?.(10)
    await new Promise((resolve, reject) => {
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
      script.onerror = () => reject(new Error('Failed to load OCR scanner. Check your internet connection.'))
      document.head.appendChild(script)
    })
  }

  const result = await window.Tesseract.recognize(file, 'eng', {
    logger: (m) => {
      if (m.status === 'recognizing text' && typeof m.progress === 'number') {
        onProgress?.(Math.max(15, Math.round(m.progress * 100)))
      }
    },
  })
  return result.data.text || ''
}

/**
 * Scan and verify a GCash Receipt screenshot against:
 * 1. Authentic GCash Receipt keywords
 * 2. Recipient match (K** AL**N S. / 09556856270 / 955 685 / 6270 / 9TC2YV)
 * 3. Expected Donation Amount (e.g. ₱10.00, ₱30.00, ₱50.00, ₱70.00, ₱90.00)
 * 4. 13-digit Reference Number extraction (4-3-6 grouped or 13 contiguous digits)
 */
export async function scanGcashReceipt(file, expectedPhp, onProgress) {
  const imageHash = await computeImageHash(file)
  const rawText = await recognizeTextFromImage(file, onProgress)
  const upper = rawText.toUpperCase()
  const digitsOnly = rawText.replace(/\D/g, '')

  // 1. Check if it looks like a GCash receipt
  const hasGcashKeywords =
    upper.includes('REF') ||
    upper.includes('AMOUNT') ||
    upper.includes('TOTAL') ||
    upper.includes('SENT') ||
    upper.includes('GCASH') ||
    upper.includes('INSTAPAY') ||
    upper.includes('EXPRESS')

  // 2. Check Recipient (09556856270 / +63 955 685 6270 / K** AL**N S. / 9TC2YV)
  const recipientMatched =
    digitsOnly.includes('9556856270') ||
    digitsOnly.includes('955685') ||
    digitsOnly.includes('6856270') ||
    upper.includes('955 685') ||
    upper.includes('685 6270') ||
    upper.includes('9TC2YV') ||
    /K[\s*•.]*AL[\s*•.]*N/.test(upper) ||
    upper.includes('AL**N')

  // 3. Check Amount (e.g. "30.00" for ₱30)
  const amountRegex = new RegExp(`(?<!\\d)${expectedPhp}[.,]\\s*00(?!\\d)`)
  const amountMatched =
    amountRegex.test(rawText) ||
    upper.includes(`PHP ${expectedPhp}`) ||
    upper.includes(`P${expectedPhp}.00`) ||
    upper.includes(`₱${expectedPhp}`)

  // Check if a different tier amount was found instead
  const allTiers = [10, 30, 50, 70, 90]
  let detectedAmount = amountMatched ? expectedPhp : null
  if (!detectedAmount) {
    for (const t of allTiers) {
      const r = new RegExp(`(?<!\\d)${t}[.,]\\s*00(?!\\d)`)
      if (r.test(rawText)) {
        detectedAmount = t
        break
      }
    }
  }

  // 4. Extract 13-digit Reference Number
  // GCash receipts typically format Ref No. as "XXXX XXX XXXXXX" (4-3-6 digits) or 13 contiguous digits
  let extractedRef = null

  // First look near "Ref" keyword
  const refSectionMatch = rawText.match(/Ref(?:erence)?[\s.:No#]*([0-9][0-9\s-]{11,18}[0-9])/i)
  if (refSectionMatch) {
    const candidate = refSectionMatch[1].replace(/\D/g, '')
    if (candidate.length === 13) {
      extractedRef = candidate
    } else if (candidate.length > 13) {
      extractedRef = candidate.slice(0, 13)
    }
  }

  // Fallback: Look for GCash 4-3-6 digit grouping anywhere in text
  if (!extractedRef) {
    const groupedMatch = rawText.match(/(?<!\d)(\d{4})[\s-]+(\d{3})[\s-]+(\d{6})(?!\d)/)
    if (groupedMatch) {
      extractedRef = `${groupedMatch[1]}${groupedMatch[2]}${groupedMatch[3]}`
    }
  }

  // Fallback: Look for any 13-digit sequence that isn't the phone number
  if (!extractedRef) {
    const thirteenMatches = rawText.match(/(?<!\d)\d{13}(?!\d)/g) || []
    for (const m of thirteenMatches) {
      if (!m.includes('9556856270')) {
        extractedRef = m
        break
      }
    }
  }

  return {
    imageHash,
    rawText,
    hasGcashKeywords,
    recipientMatched,
    amountMatched,
    detectedAmount,
    extractedRef,
  }
}
