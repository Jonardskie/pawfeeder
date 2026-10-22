// ── Camera stream URL ──────────────────────────────────────────
// Set VITE_CAMERA_URL in .env.local to your ESP32-CAM's IP.
// Example: VITE_CAMERA_URL=http://192.168.1.105/stream
export const CAMERA_STREAM_URL =
  import.meta.env.VITE_CAMERA_URL ?? 'http://192.168.1.105/stream'

export const CAMERA_SNAPSHOT_URL =
  import.meta.env.VITE_CAMERA_URL
    ? import.meta.env.VITE_CAMERA_URL.replace('/stream', '/snapshot')
    : 'http://192.168.1.105/snapshot'

// ── Unit ID (matches Firebase RTDB path) ──────────────────────
export const UNIT_ID = 'unit001'

// ── Donation tiers ────────────────────────────────────────────
export const DONATION_TIERS = [
  { php: 10, grams: 50,  label: '₱10', sub: '50g',  id: 'tier-10' },
  { php: 30, grams: 150, label: '₱30', sub: '150g', id: 'tier-30' },
  { php: 50, grams: 250, label: '₱50', sub: '250g', id: 'tier-50' },
  { php: 70, grams: 350, label: '₱70', sub: '350g', id: 'tier-70' },
  { php: 90, grams: 450, label: '₱90', sub: '450g', id: 'tier-90' },
]

// ── Food level thresholds ─────────────────────────────────────
export const FOOD_LEVEL_LOW      = 20  // % — show red warning
export const FOOD_LEVEL_MEDIUM   = 50  // % — show amber

// ── Dispense cooldown (ms) — must match firmware ───────────────
export const COOLDOWN_MS = 30_000
