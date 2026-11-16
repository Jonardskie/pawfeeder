// Vercel Serverless Function: Fast GCash Receipt OCR / Vision Verification
// Uses GEMINI_API_KEY (recommended, ~1s) if configured in Vercel Env Vars,
// otherwise falls back to OCR.space API (~1.5-2.5s).

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const { imageBase64, mimeType = 'image/jpeg', expectedPhp } = req.body || {}
    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return res.status(400).json({ error: 'Missing imageBase64' })
    }

    const geminiKey = process.env.GEMINI_API_KEY
    if (geminiKey) {
      const prompt = [
        'Inspect this Philippine GCash payment receipt screenshot.',
        'Return ONLY valid JSON with these exact keys:',
        '{',
        '  "hasGcashKeywords": boolean (true if this is a GCash / InstaPay receipt),',
        '  "recipientText": string (recipient name/number shown, e.g. "JONARD S. 09535497843" or ""),',
        '  "detectedAmount": number | null (the peso amount sent, e.g. 10, 30, 50, 70, 90),',
        '  "extractedRef": string | null (13-digit Ref No. digits only, no spaces, or null),',
        '  "rawText": string (short plain-text transcription of key lines)',
        '}',
        `Expected amount is PHP ${expectedPhp || 'any'}.`,
      ].join('\n')

      const gRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  { text: prompt },
                  {
                    inline_data: {
                      mime_type: mimeType,
                      data: imageBase64,
                    },
                  },
                ],
              },
            ],
            generationConfig: {
              responseMimeType: 'application/json',
              temperature: 0,
            },
          }),
        }
      )

      if (gRes.ok) {
        const gJson = await gRes.json()
        const text = gJson?.candidates?.[0]?.content?.parts?.[0]?.text || '{}'
        try {
          const parsed = JSON.parse(text)
          return res.status(200).json({ provider: 'gemini', ...parsed })
        } catch {
          return res.status(200).json({ provider: 'gemini', rawText: text })
        }
      }
    }

    // Fallback: OCR.space (works out-of-the-box without requiring a Gemini key)
    const ocrKey = process.env.OCR_SPACE_API_KEY || 'helloworld'
    const form = new URLSearchParams()
    form.set('apikey', ocrKey)
    form.set('base64Image', `data:${mimeType};base64,${imageBase64}`)
    form.set('language', 'eng')
    form.set('OCREngine', '2')
    form.set('scale', 'true')

    const ocrRes = await fetch('https://api.ocr.space/parse/image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    })

    if (!ocrRes.ok) {
      return res.status(502).json({ error: `Cloud OCR returned ${ocrRes.status}` })
    }

    const ocrData = await ocrRes.json()
    const rawText = ocrData?.ParsedResults?.[0]?.ParsedText || ''
    if (!rawText && ocrData?.IsErroredOnProcessing) {
      return res.status(502).json({ error: ocrData?.ErrorMessage?.[0] || 'OCR processing failed' })
    }

    return res.status(200).json({ provider: 'ocrspace', rawText })
  } catch (err) {
    console.error('[verify-receipt] Error:', err)
    return res.status(500).json({ error: err?.message || 'Internal server error' })
  }
}
