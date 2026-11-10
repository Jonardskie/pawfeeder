// ============================================================
//  PawFeeder — Control ESP32 Firmware (FINAL v5.3 — Anti-Clog Auger + Stabilized Scale)
//  NEMA Stepper (TB6600) + Allan 1239 ProMax Coin Slot + HX711 Scale
//  Board: ESP32 Dev Module
// ============================================================

#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include "HX711.h"

// ── Firebase ───────────────────────────────────────────────
#define FIREBASE_DB_URL "https://paw-feeder-faed3-default-rtdb.firebaseio.com"

// ── TB6600 Stepper ─────────────────────────────────────────
#define PUL_PIN 21
#define DIR_PIN 19
#define DIR_FORWARD LOW    // Flip LOW/HIGH if your auger spins backwards
#define DIR_REVERSE HIGH

// ── Status LED ─────────────────────────────────────────────
#define LED_PIN 4

// ── Coin acceptor ──────────────────────────────────────────
#define COIN_PIN 18
volatile int coinPulseCount = 0;
volatile unsigned long lastPulseTime = 0;
volatile bool dispensing = false;

int totalCollectedPhp = 0;
int balancePhp        = 0;

Preferences prefs;

void IRAM_ATTR coinInterrupt() {
  if (dispensing) return;

  // 1. Measure how long the signal stays LOW (real pulse is >2ms)
  unsigned long startLow = micros();
  while (digitalRead(COIN_PIN) == LOW) {
    // Wait for it to go HIGH, but timeout after 10ms just in case
    if (micros() - startLow > 10000) break;
  }
  unsigned long duration = micros() - startLow;

  // 2. If the pulse was shorter than 2ms, it's NOISE. Ignore it.
  if (duration < 2000) return;

  // 3. If the pulse was longer than 2ms, it's a REAL COIN.
  coinPulseCount++;
  lastPulseTime = millis();
}

// ── HX711 Scale (Interrupt-Protected + Median Filtered) ────
#define HX711_DOUT_PIN 25
#define HX711_SCK_PIN  26
HX711 scale;
float calibrationFactor  = 944.49f;
float currentWeightGrams = 0.0f;
long  tareBaseline       = 0;

// Rolling 3-sample buffer for live idle LCD smoothing
long  rawRing[3]         = {0, 0, 0};
uint8_t rawRingIdx       = 0;
bool  rawRingFilled      = false;
unsigned long lastScaleReadyTime = 0;

// Sort helper for median calculation
static void sortLongs(long *arr, int n) {
  for (int i = 0; i < n - 1; i++) {
    for (int j = i + 1; j < n; j++) {
      if (arr[j] < arr[i]) {
        long tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
      }
    }
  }
}

// Interrupt-safe 24-bit read so WiFi / Coin ISR cannot stretch SCK > 60us
long readScaleRawSafe() {
  noInterrupts();
  long raw = scale.read();
  interrupts();
  return raw;
}

// Read N samples and return the middle (median) value to reject EMI spikes
bool readScaleMedianRaw(int samples, long &medianOut, unsigned long timeoutMs = 400) {
  if (samples < 1) samples = 1;
  if (samples > 15) samples = 15;
  long buf[15];
  int count = 0;

  for (int i = 0; i < samples; i++) {
    if (!scale.wait_ready_timeout(timeoutMs)) {
      // Wake HX711 in case SCK glitch put it into power-down mode
      scale.power_down();
      delay(5);
      scale.power_up();
      if (!scale.wait_ready_timeout(timeoutMs)) continue;
    }
    long r = readScaleRawSafe();
    // Reject stuck-rail 24-bit saturation values (-8388608 or +8388607) or 0
    if (r == 0 || r <= -8388600L || r >= 8388600L) continue;
    buf[count++] = r;
    if (i < samples - 1) delay(15);
  }

  if (count == 0) return false;
  sortLongs(buf, count);
  medianOut = buf[count / 2];
  lastScaleReadyTime = millis();
  return true;
}

void tareScale() {
  long med = 0;
  if (readScaleMedianRaw(9, med, 500)) {
    tareBaseline = med;
    for (int i = 0; i < 3; i++) rawRing[i] = med;
    rawRingFilled = true;
    currentWeightGrams = 0.0f;
    Serial.printf("[Scale] Tared! Baseline = %ld (calFactor = %.2f)\n", tareBaseline, calibrationFactor);
  } else {
    Serial.println("[Scale] Tare failed — HX711 not ready.");
  }
}

// ── LCD ────────────────────────────────────────────────────
LiquidCrystal_I2C lcd(0x27, 16, 2);

// ── Stepper Speed & Anti-Clog Tuning ───────────────────────
int stepDelayUs       = 2000;  // Normal forward cruising speed (us)
int torqueStepDelayUs = 2800;  // Slower step rate = HIGHER stepper torque for unjamming

#define RUN_CHUNK_MS         260   // Forward run per dispense chunk
#define MICRO_BACK_MS        40    // Brief reverse "peck" every 3 chunks to prevent wedging
#define SETTLE_MS            120   // Scale settle time after motor stops
#define EARLY_STOP_G         0.0f
#define STALL_CHUNKS_LIMIT   6     // Trigger full unjam if weight doesn't rise for 6 chunks (~1.6s)
#define MIN_PROGRESS_G       1.5f  // Minimum weight gain (g) to count as flowing

// ── Balance timer ──────────────────────────────────────────
#define BALANCE_TIMEOUT_MS 120000UL   // 2 minutes

// ── Cooldown ───────────────────────────────────────────────
#define COOLDOWN_MS 30000UL
unsigned long lastDispenseTime = 0;

// ── Polling / heartbeat ────────────────────────────────────
#define POLL_INTERVAL_MS 3500UL
unsigned long lastPoll      = 0;
unsigned long lastHeartbeat = 0;

// ── Food level ─────────────────────────────────────────────
float foodLevelPct = 75.0f;

// ── TLS client ─────────────────────────────────────────────
WiFiClientSecure wifiClient;

// ============================================================
//  Tier helpers
// ============================================================
int tierToGrams(int php) {
  switch (php) {
    case 10: return 50;
    case 30: return 150;
    case 50: return 250;
    case 70: return 350;
    case 90: return 450;
    default: return -1;
  }
}

bool isTier(int php) { return tierToGrams(php) > 0; }

int nextTierAbove(int php) {
  const int tiers[] = {10, 30, 50, 70, 90};
  for (int i = 0; i < 5; i++) { if (tiers[i] > php) return tiers[i]; }
  return -1;
}

// ============================================================
//  Coin parsing (STRICT SNAPPING)
// ============================================================
int parseCoinBurst(int totalPulses) {
  // Clean up trailing noise on large bursts
  if (totalPulses > 50) {
    int mod = totalPulses % 10;
    if (mod > 0 && mod <= 6) totalPulses -= mod;
  }

  // Strict mapping (The hardware filter should give us exact numbers now)
  if (totalPulses >= 8  && totalPulses <= 13) return 10;  // ₱10
  if (totalPulses >= 17 && totalPulses <= 23) return 20;  // ₱20
  if (totalPulses >= 47 && totalPulses <= 53) return 50;  // ₱50

  if (totalPulses >= 26 && totalPulses <= 38) return 40;  // 20+20
  if (totalPulses >= 56 && totalPulses <= 68) return 60;  // 50+10 or 20+20+20
  if (totalPulses >= 75 && totalPulses <= 85) return 80;  // 20+20+20+20
  if (totalPulses >= 86 && totalPulses <= 100) return 90; // 50+20+20

  return -1;
}

// ============================================================
//  LCD / Firebase helpers
// ============================================================
void lcdShow(const char* line1, const char* line2 = "") {
  char l1[17], l2[17];
  snprintf(l1, sizeof(l1), "%-16.16s", line1 ? line1 : "");
  snprintf(l2, sizeof(l2), "%-16.16s", line2 ? line2 : "");
  lcd.setCursor(0, 0); lcd.print(l1);
  lcd.setCursor(0, 1); lcd.print(l2);
}

void lcdShowLine2(const char* line2) {
  char l2[17];
  snprintf(l2, sizeof(l2), "%-16.16s", line2 ? line2 : "");
  lcd.setCursor(0, 1); lcd.print(l2);
}

bool fbSet(const char* path, String jsonValue) {
  if (WiFi.status() != WL_CONNECTED) return false;
  HTTPClient http; String url = String(FIREBASE_DB_URL) + path + ".json";
  http.begin(wifiClient, url); http.setTimeout(8000);
  http.addHeader("Content-Type", "application/json");
  int code = http.PUT(jsonValue); http.end();
  return (code == 200);
}

bool fbPatch(const char* path, String jsonObject) {
  if (WiFi.status() != WL_CONNECTED) return false;
  HTTPClient http; String url = String(FIREBASE_DB_URL) + path + ".json";
  http.begin(wifiClient, url); http.setTimeout(8000);
  http.addHeader("Content-Type", "application/json");
  int code = http.sendRequest("PATCH", jsonObject); http.end();
  return (code == 200);
}

String fbGet(const char* path) {
  if (WiFi.status() != WL_CONNECTED) return "";
  HTTPClient http; String url = String(FIREBASE_DB_URL) + path + ".json";
  http.begin(wifiClient, url); http.setTimeout(8000);
  int code = http.GET(); String payload = "";
  if (code == 200) payload = http.getString();
  http.end(); return payload;
}

void motorPulse(int delayUs = stepDelayUs);
bool runMotorTimed(uint8_t dir, unsigned long durationMs, int targetDelayUs, bool allowSerialStop = true);
void unjamAuger();
float readBowlWeight();
void triggerDispense(int grams, const char* source);
void dispenseUntilWeight(float targetGrams, float startWeight);
void showBalanceLcd();
void calibrateScaleInteractive(float knownGrams);

// ============================================================
//  SETUP
// ============================================================
void setup() {
  Serial.begin(115200);
  Serial.println("\n== PawFeeder Control ESP32 v5.3 (Anti-Clog Auger + Stabilized Scale) ==");

  prefs.begin("pawfeeder", false);
  totalCollectedPhp = prefs.getInt("total_php", 0);
  calibrationFactor = prefs.getFloat("cal_factor", 944.49f);
  if (isnan(calibrationFactor) || fabs(calibrationFactor) < 1.0f) {
    calibrationFactor = 944.49f;
  }
  Serial.printf("[NVS] totalCollectedPhp = %d PHP | calFactor = %.2f\n", totalCollectedPhp, calibrationFactor);

  pinMode(PUL_PIN, OUTPUT); pinMode(DIR_PIN, OUTPUT);
  digitalWrite(PUL_PIN, LOW); digitalWrite(DIR_PIN, DIR_FORWARD);
  pinMode(LED_PIN, OUTPUT); digitalWrite(LED_PIN, LOW);

  pinMode(COIN_PIN, INPUT_PULLUP);

  Wire.begin(32, 33); Wire.setClock(400000);
  lcd.init(); lcd.backlight(); lcdShow("PawFeeder", "Starting...");

  lcdShow("Calibrating", "Weight Scale...");
  scale.begin(HX711_DOUT_PIN, HX711_SCK_PIN);
  unsigned long t0 = millis();
  while (!scale.is_ready() && millis() - t0 < 3000) delay(50);

  if (scale.is_ready()) {
    tareScale();
    lcdShow("Scale Ready!", "Tared to 0.0g");
  } else {
    lcdShow("Scale Warn", "Check D25/D26");
  }
  delay(1200);

  WiFiManager wm; wm.setConnectTimeout(20); wm.setConfigPortalTimeout(120);
  lcdShow("Connecting", "WiFi...");
  bool connected = wm.autoConnect("PawFeeder-Setup", "pawfeeder123");

  if (!connected) {
    lcdShow("WiFi Offline", "Coin Mode Only");
    delay(2000);
  } else {
    lcdShow("WiFi OK!", WiFi.localIP().toString().c_str()); delay(1500);
    wifiClient.setInsecure();
    lcdShow("Firebase...", "Connecting");
    String initJson = "{\"online\":true,\"food_level_pct\":75.0,\"total_collected_php\":" + String(totalCollectedPhp) + ",\"balance_php\":0}";
    if (fbPatch("/feeder/unit001/status", initJson)) { lcdShow("Firebase OK!", "All systems go"); }
    else { lcdShow("Firebase WARN", "Check Serial"); }
    delay(1000);
  }

  if (scale.is_ready()) tareScale();

  // Attach coin interrupt AFTER scale tare & WiFi setup so boot noise is ignored
  noInterrupts(); coinPulseCount = 0; lastPulseTime = 0; interrupts();
  attachInterrupt(digitalPinToInterrupt(COIN_PIN), coinInterrupt, FALLING);

  lcdShow("PawFeeder Ready", "Bowl:0.0g Feed");
  Serial.println("[v5.3] Commands: 't'=Tare, 'c'=Calibrate(200g), 'w'=Raw Weight, 'm'=Forward Test, 'v'=Reverse Test, 'u'=Unjam Shake, 'f 50'=Feed 50g, 'r'=Reset");
}

// ============================================================
//  LOOP
// ============================================================
void loop() {
  unsigned long now = millis();

  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n'); cmd.trim();
    if (cmd == "t") {
      tareScale();
      lcdShow("Scale Tared!", "0.0g");
      delay(1000);
      lcdShow("PawFeeder Ready", "Bowl:0.0g Feed");
    }
    else if (cmd.startsWith("c")) {
      float refGrams = 200.0f;
      if (cmd.length() > 1) {
        float parsed = cmd.substring(1).toFloat();
        if (parsed > 1.0f) refGrams = parsed;
      }
      calibrateScaleInteractive(refGrams);
    }
    else if (cmd == "w") {
      long med = 0;
      if (readScaleMedianRaw(5, med, 300)) {
        float g = (float)(med - tareBaseline) / calibrationFactor;
        Serial.printf(">> Raw Median: %ld | Tare: %ld | Diff: %ld | Weight: %.2fg (cal=%.2f)\n",
                      med, tareBaseline, med - tareBaseline, g, calibrationFactor);
      } else {
        Serial.println(">> Scale not ready! Check D25/D26 wiring.");
      }
    }
    else if (cmd == "b") {
      Serial.printf(">> Balance: P%d\n", balancePhp);
    }
    else if (cmd == "r") {
      balancePhp = 0;
      fbSet("/feeder/unit001/status/balance_php", "0");
      lcdShow("PawFeeder Ready", "Bowl:0.0g Feed");
      Serial.println(">> Balance Reset");
    }
    else if (cmd == "m") {
      Serial.println(">> Motor Test (2s Forward)...");
      runMotorTimed(DIR_FORWARD, 2000, stepDelayUs, false);
      Serial.println(">> Motor Test Done.");
    }
    else if (cmd == "v") {
      Serial.println(">> Motor Test (2s Reverse)...");
      runMotorTimed(DIR_REVERSE, 2000, stepDelayUs, false);
      digitalWrite(DIR_PIN, DIR_FORWARD);
      Serial.println(">> Reverse Test Done.");
    }
    else if (cmd == "u") {
      Serial.println(">> Manual Unjam Shake...");
      unjamAuger();
      lcdShow("PawFeeder Ready", "Bowl:0.0g Feed");
    }
    else if (cmd.startsWith("f")) {
      int g = 50;
      if (cmd.length() > 1) {
        int parsed = cmd.substring(1).toInt();
        if (parsed > 0) g = parsed;
      }
      Serial.printf(">> Manual Serial Dispense: %dg\n", g);
      triggerDispense(g, "serial");
    }
  }

  static unsigned long lastCoinSnap = 0;
  static unsigned long balanceStart = 0;

  if (!dispensing && (coinPulseCount > 0 || balancePhp > 0)) {
    long gapMs = (long)(now - lastPulseTime);

    // Process coin burst after 1.5 seconds of silence
    if (coinPulseCount > 0 && gapMs >= 1500 && (now - lastCoinSnap) >= 1500) {
      lastCoinSnap = now;
      int rawPulses = 0;
      noInterrupts(); rawPulses = coinPulseCount; coinPulseCount = 0; interrupts();

      Serial.printf(">> Read: %d pulses\n", rawPulses);

      if (rawPulses >= 3) {
        int coinPhp = parseCoinBurst(rawPulses);

        if (coinPhp <= 0) {
          lcdShow("Unknown coin", "Not accepted");
          delay(800);
          showBalanceLcd();
          return;
        }

        balancePhp += coinPhp; totalCollectedPhp += coinPhp;
        prefs.putInt("total_php", totalCollectedPhp);
        fbSet("/feeder/unit001/status/total_collected_php", String(totalCollectedPhp));
        fbSet("/feeder/unit001/status/balance_php", String(balancePhp));
        balanceStart = now;

        Serial.printf(">> Credited: P%d | Balance: P%d\n", coinPhp, balancePhp);

        if (isTier(balancePhp)) {
          int foodGrams = tierToGrams(balancePhp); int phpValue = balancePhp; balancePhp = 0;
          fbSet("/feeder/unit001/status/balance_php", "0");
          char coinBuf[17]; snprintf(coinBuf, sizeof(coinBuf), "Coin: P%d PHP", phpValue);
          char foodBuf[17]; snprintf(foodBuf, sizeof(foodBuf), "Feed: %dg", foodGrams);
          lcdShow(coinBuf, foodBuf); delay(800); triggerDispense(foodGrams, "coin_slot");
          String coinEvent = "{\"php\":" + String(phpValue) + ",\"grams\":" + String(foodGrams) + "}";
          fbSet("/feeder/unit001/event/last_coin", coinEvent);
        } else {
          showBalanceLcd();
        }
      }
    }

    if (balancePhp > 0 && !isTier(balancePhp) && (now - balanceStart) >= BALANCE_TIMEOUT_MS) {
      int lost = balancePhp; balancePhp = 0;
      fbSet("/feeder/unit001/status/balance_php", "0");
      fbSet("/feeder/unit001/event/unclaimed", "{\"php\":" + String(lost) + ",\"at\":" + String((int)(now / 1000)) + "}");
      lcdShow("Balance expired", "P? refund"); delay(1500); lcdShow("PawFeeder Ready", "Bowl:0.0g Feed");
    }
  }

  if (now - lastPoll >= POLL_INTERVAL_MS) {
    lastPoll = now;
    String cmdPayload = fbGet("/feeder/unit001/cmd");
    cmdPayload.trim();

    if (cmdPayload.length() > 2 && cmdPayload != "null") {
      // 1. Check remote dispense command: "active":true
      if (cmdPayload.indexOf("\"active\":true") >= 0 || cmdPayload.indexOf("\"active\": true") >= 0) {
        int grams = 50;
        int gIdx = cmdPayload.indexOf("\"grams\":");
        if (gIdx >= 0) {
          int parsed = cmdPayload.substring(gIdx + 8).toInt();
          if (parsed > 0) grams = parsed;
        }
        fbSet("/feeder/unit001/cmd/dispense/active", "false");
        if (!dispensing && ((lastDispenseTime == 0) || (millis() - lastDispenseTime >= COOLDOWN_MS))) {
          triggerDispense(grams, "remote");
        }
      }

      // 2. Check bowl card quick tare: "tare":true
      if (cmdPayload.indexOf("\"tare\":true") >= 0 || cmdPayload.indexOf("\"tare\": true") >= 0) {
        fbSet("/feeder/unit001/cmd/tare", "false");
        if (!dispensing) {
          tareScale();
          lcdShow("Remote Tare!", "Scale: 0.0g");
          delay(900);
          lcdShow("PawFeeder Ready", "Bowl:0.0g Feed");
        }
      }

      // 3. Check WiFi reset command: "reset_wifi":true
      if (cmdPayload.indexOf("\"reset_wifi\":true") >= 0 || cmdPayload.indexOf("\"reset_wifi\": true") >= 0) {
        fbSet("/feeder/unit001/cmd/reset_wifi", "false");
        lcdShow("Resetting WiFi", "Restarting...");
        WiFiManager wm;
        wm.resetSettings();
        delay(1000);
        ESP.restart();
      }

      // 4. Check Admin Action commands from Web App Settings
      int actIdx = cmdPayload.indexOf("\"admin_action\":\"");
      if (actIdx >= 0 && !dispensing) {
        int startQuote = actIdx + 16;
        int endQuote = cmdPayload.indexOf("\"", startQuote);
        if (endQuote > startQuote) {
          String action = cmdPayload.substring(startQuote, endQuote);
          fbSet("/feeder/unit001/cmd/admin_action", "\"\"");
          Serial.printf("[Admin Web Cmd] Executing: %s\n", action.c_str());

          if (action == "unjam") {
            unjamAuger();
            lcdShow("PawFeeder Ready", "Bowl:0.0g Feed");
          }
          else if (action == "reverse") {
            lcdShow("Admin Control", "Reverse Spin 2s");
            runMotorTimed(DIR_REVERSE, 2000, torqueStepDelayUs, false);
            digitalWrite(DIR_PIN, DIR_FORWARD);
            lcdShow("PawFeeder Ready", "Bowl:0.0g Feed");
          }
          else if (action == "forward") {
            lcdShow("Admin Control", "Forward Spin 2s");
            runMotorTimed(DIR_FORWARD, 2000, stepDelayUs, false);
            lcdShow("PawFeeder Ready", "Bowl:0.0g Feed");
          }
          else if (action == "tare") {
            tareScale();
            lcdShow("Admin Tare!", "Scale: 0.0g");
            delay(900);
            lcdShow("PawFeeder Ready", "Bowl:0.0g Feed");
          }
          else if (action == "calibrate_200") {
            calibrateScaleInteractive(200.0f);
          }
          else if (action == "reset_balance") {
            balancePhp = 0;
            fbSet("/feeder/unit001/status/balance_php", "0");
            lcdShow("Admin Reset", "Balance: P0");
            delay(900);
            lcdShow("PawFeeder Ready", "Bowl:0.0g Feed");
          }
          else if (action == "refill_100") {
            foodLevelPct = 100.0f;
            fbSet("/feeder/unit001/status/food_level_pct", "100.0");
            lcdShow("Hopper Refilled", "Food: 100%");
            delay(1000);
            lcdShow("PawFeeder Ready", "Bowl:0.0g Feed");
          }
        }
      }
    }
  }

  static unsigned long lastScaleLcd = 0;
  if (!dispensing && balancePhp == 0 && (now - lastScaleLcd >= 200)) {
    lastScaleLcd = now;
    float w = readBowlWeight();
    if (coinPulseCount == 0) {
      char liveBowl[17];
      snprintf(liveBowl, sizeof(liveBowl), "Bowl:%.1fg Feed", w);
      lcdShowLine2(liveBowl);
    }
  }

  if (!dispensing && (WiFi.status() == WL_CONNECTED) && (now - lastHeartbeat >= 5000)) {
    lastHeartbeat = now;
    String statusJson = "{\"bowl_weight_g\":" + String(currentWeightGrams, 1) +
                        ",\"food_level_pct\":" + String(foodLevelPct, 1) +
                        ",\"online\":true,\"balance_php\":" + String(balancePhp) +
                        ",\"uptime_s\":" + String((int)(millis() / 1000)) +
                        ",\"rssi\":" + String(WiFi.RSSI()) + "}";
    fbPatch("/feeder/unit001/status", statusJson);
  }
}

void showBalanceLcd() {
  if (balancePhp <= 0) { lcdShow("PawFeeder Ready", "Bowl:0.0g Feed"); return; }
  int next = nextTierAbove(balancePhp);
  char line1[17]; snprintf(line1, sizeof(line1), "Balance P%d", balancePhp);
  if (next > 0) {
    char line2[17]; snprintf(line2, sizeof(line2), "Need P%d more", next - balancePhp);
    lcdShow(line1, line2);
  } else {
    lcdShow(line1, "Insert more...");
  }
}

// Non-blocking 3-sample median + EMA smoothing for idle display
float readBowlWeight() {
  if (scale.is_ready()) {
    long raw = readScaleRawSafe();
    lastScaleReadyTime = millis();
    if (raw != 0 && raw > -8388600L && raw < 8388800L) {
      rawRing[rawRingIdx] = raw;
      rawRingIdx = (rawRingIdx + 1) % 3;
      if (rawRingIdx == 0) rawRingFilled = true;

      long med = raw;
      if (rawRingFilled) {
        long sorted[3] = { rawRing[0], rawRing[1], rawRing[2] };
        sortLongs(sorted, 3);
        med = sorted[1];
      }

      float w = (float)(med - tareBaseline) / calibrationFactor;
      // Reject absurd single-frame spikes (> 2000g or < -200g)
      if (w > -200.0f && w < 2000.0f) {
        if (fabs(w) < 0.8f) w = 0.0f;
        currentWeightGrams = (w == 0.0f) ? 0.0f : (0.6f * w + 0.4f * currentWeightGrams);
        if (fabs(currentWeightGrams) < 0.8f) currentWeightGrams = 0.0f;
      }
    }
  } else if (millis() - lastScaleReadyTime > 1500) {
    // Auto-wake HX711 if SCK noise put it into sleep mode
    scale.power_down();
    delayMicroseconds(100);
    scale.power_up();
    lastScaleReadyTime = millis();
  }
  return currentWeightGrams;
}

// High-reliability settled median read used between motor chunks
static bool readCleanWeight(float &wOut) {
  delay(SETTLE_MS);
  if (scale.is_ready()) readScaleRawSafe(); // discard first transitional reading after motor stops

  long med = 0;
  if (readScaleMedianRaw(3, med, 450)) {
    float w = (float)(med - tareBaseline) / calibrationFactor;
    if (fabs(w) < 0.8f) w = 0.0f;
    wOut = w;
    currentWeightGrams = w;
    return true;
  }
  return false;
}

void calibrateScaleInteractive(float knownGrams) {
  Serial.printf("\n[Calibrate] Measuring %.1fg reference weight (keep scale steady)...\n", knownGrams);
  lcdShow("Calibrating...", "Keep steady!");
  long med = 0;
  if (!readScaleMedianRaw(11, med, 500)) {
    Serial.println("[Calibrate] ERROR: HX711 not ready.");
    lcdShow("Calib Failed", "Scale not ready");
    delay(1500);
    lcdShow("PawFeeder Ready", "Bowl:0.0g Feed");
    return;
  }
  long diff = med - tareBaseline;
  if (abs(diff) < 100) {
    Serial.printf("[Calibrate] ERROR: Raw diff (%ld) too small! Tare first ('t') with empty bowl, then place %.0fg and type 'c'.\n", diff, knownGrams);
    lcdShow("Calib Error", "Place weight!");
    delay(1500);
    lcdShow("PawFeeder Ready", "Bowl:0.0g Feed");
    return;
  }
  calibrationFactor = (float)diff / knownGrams;
  prefs.putFloat("cal_factor", calibrationFactor);
  currentWeightGrams = knownGrams;

  Serial.printf("[Calibrate] SUCCESS! Raw=%ld, Tare=%ld, Diff=%ld -> New calibrationFactor = %.2f (Saved to NVS)\n",
                med, tareBaseline, diff, calibrationFactor);
  char buf[17];
  snprintf(buf, sizeof(buf), "Cal: %.2f", calibrationFactor);
  lcdShow("Calib Saved!", buf);
  delay(1800);
  lcdShow("PawFeeder Ready", "Bowl:0.0g Feed");
}

// ============================================================
//  Stepper Motor + Anti-Clog Routines
// ============================================================
void motorPulse(int delayUs) {
  digitalWrite(PUL_PIN, HIGH);
  delayMicroseconds(5);
  digitalWrite(PUL_PIN, LOW);
  delayMicroseconds(delayUs);
}

// Runs the stepper in `dir` for `durationMs` with a soft-start torque ramp
// Returns true if user pressed 'x' in Serial to abort
bool runMotorTimed(uint8_t dir, unsigned long durationMs, int targetDelayUs, bool allowSerialStop) {
  digitalWrite(DIR_PIN, dir);
  delayMicroseconds(20); // TB6600 DIR setup time before first PUL edge

  unsigned long start = millis();
  int startDelayUs = targetDelayUs + 1200; // Soft-start slower for maximum breakaway torque

  while (millis() - start < durationMs) {
    if (allowSerialStop && Serial.available()) {
      char c = Serial.read();
      if (c == 'x' || c == 'X') return true;
    }
    unsigned long elapsed = millis() - start;
    // Ramp up over the first 45ms of movement
    int currentDelay = (elapsed < 45)
                       ? (startDelayUs - (int)((long)(startDelayUs - targetDelayUs) * elapsed / 45))
                       : targetDelayUs;
    motorPulse(currentDelay);
  }
  return false;
}

// Multi-stage unjamming routine when kibble bridges or wedges in the auger
void unjamAuger() {
  Serial.println("[Anti-Clog] Jam detected! Running Reverse + Shake unjam sequence...");
  lcdShow("Unjamming Food", "Backing up...");

  // 1. Back up slowly (high torque) for 450ms to pull wedged kibble out of the throat
  runMotorTimed(DIR_REVERSE, 450, torqueStepDelayUs, false);
  delay(60);

  // 2. Rapid back-and-forth agitation ("shake") to break kibble bridge in hopper
  lcdShow("Unjamming Food", "Shaking auger...");
  for (int i = 0; i < 4; i++) {
    runMotorTimed(DIR_FORWARD, 95, torqueStepDelayUs, false);
    delay(25);
    runMotorTimed(DIR_REVERSE, 75, torqueStepDelayUs, false);
    delay(25);
  }

  // 3. High-torque slow forward push (350ms) to clear the loosened kibble
  runMotorTimed(DIR_FORWARD, 350, torqueStepDelayUs, false);
  digitalWrite(DIR_PIN, DIR_FORWARD);
  delay(80);
}

void triggerDispense(int grams, const char* source) {
  dispensing = true; lastDispenseTime = millis(); digitalWrite(LED_PIN, HIGH);
  detachInterrupt(digitalPinToInterrupt(COIN_PIN));

  float weightBefore = currentWeightGrams;
  long medBefore = 0;
  if (readScaleMedianRaw(3, medBefore, 350)) {
    float w = (float)(medBefore - tareBaseline) / calibrationFactor;
    if (fabs(w) < 0.8f) w = 0.0f;
    weightBefore = w;
    currentWeightGrams = w;
  }

  char buf[17]; snprintf(buf, sizeof(buf), "Target: %dg", grams);
  lcdShow(strcmp(source, "remote") == 0 ? "Remote Feed!" : "Coin Feed!", buf);

  dispenseUntilWeight((float)grams, weightBefore);

  delay(800);
  float weightAfter = weightBefore;
  readCleanWeight(weightAfter);
  float actualDispensed = weightAfter - weightBefore;
  if (actualDispensed < 0.0f) actualDispensed = 0.0f;

  foodLevelPct -= (actualDispensed * 0.5f);
  if (foodLevelPct < 0.0f) foodLevelPct = 0.0f;

  digitalWrite(LED_PIN, LOW);
  fbSet("/feeder/unit001/status/food_level_pct", String(foodLevelPct, 1));
  fbSet("/feeder/unit001/status/bowl_weight_g",  String(weightAfter, 1));
  fbSet("/feeder/unit001/event/last_dispense",
        "{\"target_g\":" + String(grams) +
        ",\"actual_g\":" + String(actualDispensed, 1) +
        ",\"bowl_g\":" + String(weightAfter, 1) +
        ",\"source\":\"" + String(source) + "\"}");

  char doneBuf[17]; snprintf(doneBuf, sizeof(doneBuf), "Added: %.0fg", actualDispensed);
  lcdShow("Done! Yum! :)", doneBuf); delay(1500);
  char idleBuf[17]; snprintf(idleBuf, sizeof(idleBuf), "Bowl:%.1fg Feed", weightAfter);
  lcdShow("PawFeeder Ready", idleBuf);

  noInterrupts(); coinPulseCount = 0; lastPulseTime = 0; interrupts();
  attachInterrupt(digitalPinToInterrupt(COIN_PIN), coinInterrupt, FALLING);
  dispensing = false;
}

void dispenseUntilWeight(float targetGrams, float startWeight) {
  const unsigned long maxDispenseTimeMs = (unsigned long)(targetGrams * 350.0f) + 20000UL;
  unsigned long startTime = millis();
  float dispensed = 0.0f;
  float lastProgressWeight = 0.0f;
  int lastShown = -1;
  int failedReads = 0;
  int targetHitCount = 0;
  int stalledChunks = 0;
  int chunkCounter = 0;
  bool manualStop = false;

  char initBuf[17]; snprintf(initBuf, sizeof(initBuf), "0g / %.0fg", targetGrams);
  lcdShow("Dispensing...", initBuf);

  while (true) {
    chunkCounter++;

    // 1. Preventive "Peck" Dither: every 3rd chunk, step backward 40ms before pushing forward
    //    This relieves pressure on kibble before it can wedge against the tube wall.
    if (chunkCounter % 3 == 0) {
      if (runMotorTimed(DIR_REVERSE, MICRO_BACK_MS, torqueStepDelayUs, true)) { manualStop = true; break; }
      delay(15);
    }

    // 2. Forward dispense chunk with soft-start torque ramp
    if (runMotorTimed(DIR_FORWARD, RUN_CHUNK_MS, stepDelayUs, true)) {
      manualStop = true;
      break;
    }

    float w;
    if (readCleanWeight(w)) {
      failedReads = 0;
      dispensed = w - startWeight;
      if (dispensed < 0.0f) dispensed = 0.0f;

      int shown = (int)(dispensed + 0.5f);
      if (shown != lastShown) {
        lastShown = shown;
        char liveBuf[17];
        snprintf(liveBuf, sizeof(liveBuf), "%dg / %.0fg", shown, targetGrams);
        lcdShow("Dispensing...", liveBuf);
      }

      // 3. Check if target weight is reached (2 consecutive clean reads)
      if (dispensed >= targetGrams - EARLY_STOP_G) {
        targetHitCount++;
        if (targetHitCount >= 2) break;
      } else {
        targetHitCount = 0;
      }

      // 4. Auto Clog / Stall Detection: check if weight is increasing
      if (dispensed - lastProgressWeight >= MIN_PROGRESS_G) {
        lastProgressWeight = dispensed;
        stalledChunks = 0;
      } else {
        stalledChunks++;
        if (stalledChunks >= STALL_CHUNKS_LIMIT) {
          stalledChunks = 0;
          unjamAuger();
          char resumeBuf[17];
          snprintf(resumeBuf, sizeof(resumeBuf), "%dg / %.0fg", shown, targetGrams);
          lcdShow("Dispensing...", resumeBuf);
        }
      }
    } else {
      failedReads++;
      if (failedReads >= 5) break;
    }

    if (millis() - startTime > maxDispenseTimeMs) break;
  }
}
