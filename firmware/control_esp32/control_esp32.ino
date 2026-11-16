// ============================================================
//  PawFeeder — Control ESP32 Firmware (FINAL v5.4 — Fast Coin Response + High-Power Auger)
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
portMUX_TYPE coinMux = portMUX_INITIALIZER_UNLOCKED;
volatile int coinPulseCount = 0;
volatile unsigned long lastPulseTime = 0;
volatile unsigned long pulseFallUs = 0;
volatile bool dispensing = false;

int totalCollectedPhp = 0;
int balancePhp        = 0;

Preferences prefs;

// Non-blocking CHANGE ISR: measures LOW pulse width without busy-waiting
void IRAM_ATTR coinInterrupt() {
  if (dispensing) return;

  unsigned long nowUs = micros();
  if (gpio_get_level((gpio_num_t)COIN_PIN) == 0) {
    pulseFallUs = nowUs;
  } else if (pulseFallUs != 0) {
    unsigned long duration = nowUs - pulseFallUs;
    pulseFallUs = 0;
    // Real coin pulse is >= 2ms (and <= 150ms); shorter spikes are noise
    if (duration >= 2000 && duration <= 150000) {
      portENTER_CRITICAL_ISR(&coinMux);
      coinPulseCount++;
      lastPulseTime = millis();
      portEXIT_CRITICAL_ISR(&coinMux);
    }
  }
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
bool readScaleMedianRaw(int samples, long &medianOut, unsigned long timeoutMs = 400, unsigned long interSampleDelayMs = 15) {
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
    if (i < samples - 1 && interSampleDelayMs > 0) delay(interSampleDelayMs);
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
int stepDelayUs       = 1350;  // Faster forward speed (~48% faster RPM)
int torqueStepDelayUs = 2200;  // High-torque speed for unjamming / reverse peck

#define RUN_CHUNK_MS         650   // Longer continuous power push per chunk
#define MICRO_BACK_MS        45    // Brief reverse "peck" every 4 chunks to prevent wedging
#define SETTLE_MS            55    // Fast scale settle time after motor stops
#define EARLY_STOP_G         0.0f
#define STALL_CHUNKS_LIMIT   4     // Trigger full unjam if weight doesn't rise for 4 chunks (~2.6s)
#define MIN_PROGRESS_G       1.5f  // Minimum weight gain (g) to count as flowing
#define COIN_SILENCE_MS      650   // Process coin burst 0.65s after last pulse
#define TIER_WAIT_MS         3000UL // Wait 3s after reaching a tier (<P90) for additional coins

// ── Balance timer ──────────────────────────────────────────
#define BALANCE_TIMEOUT_MS 120000UL   // 2 minutes

// ── Cooldown ───────────────────────────────────────────────
#define COOLDOWN_MS 30000UL
unsigned long lastDispenseTime = 0;

// ── Polling / heartbeat ────────────────────────────────────
#define POLL_INTERVAL_MS 2000UL
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
  if (totalPulses >= 8  && totalPulses <= 13) return 10; // ₱10
  if (totalPulses >= 17 && totalPulses <= 23) return 20; // ₱20
  if (totalPulses >= 27 && totalPulses <= 33) return 30; // ₱20 + ₱10
  if (totalPulses >= 37 && totalPulses <= 43) return 40; // ₱20 + ₱20
  if (totalPulses >= 47 && totalPulses <= 53) return 50; // ₱50 (or 20+20+10)
  if (totalPulses >= 57 && totalPulses <= 63) return 60; // ₱50 + ₱10 or 20+20+20
  if (totalPulses >= 67 && totalPulses <= 73) return 70; // ₱50 + ₱20 or 20+20+20+10
  if (totalPulses >= 77 && totalPulses <= 83) return 80; // ₱20*4
  if (totalPulses >= 87 && totalPulses <= 96) return 90; // ₱50 + ₱20 + ₱20

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

bool fbSet(const char* path, const String& jsonValue) {
  if (WiFi.status() != WL_CONNECTED) return false;
  HTTPClient http; String url = String(FIREBASE_DB_URL) + path + ".json";
  http.setReuse(false);
  http.begin(wifiClient, url); http.setTimeout(2500);
  http.addHeader("Content-Type", "application/json");
  int code = http.PUT(jsonValue); http.end();
  if (code != 200) wifiClient.stop();
  return (code == 200);
}

bool fbPatch(const char* path, const String& jsonObject) {
  if (WiFi.status() != WL_CONNECTED) return false;
  HTTPClient http; String url = String(FIREBASE_DB_URL) + path + ".json";
  http.setReuse(false);
  http.begin(wifiClient, url); http.setTimeout(2500);
  http.addHeader("Content-Type", "application/json");
  int code = http.sendRequest("PATCH", jsonObject); http.end();
  if (code != 200) wifiClient.stop();
  return (code == 200);
}

String fbGet(const char* path) {
  if (WiFi.status() != WL_CONNECTED) return "";
  HTTPClient http; String url = String(FIREBASE_DB_URL) + path + ".json";
  http.setReuse(false);
  http.begin(wifiClient, url); http.setTimeout(2500);
  int code = http.GET(); String payload = "";
  if (code == 200) payload = http.getString();
  else wifiClient.stop();
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
  Serial.println("\n== PawFeeder Control ESP32 v5.4 (Fast Coin Response + High-Power Auger) ==");

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
    wifiClient.setTimeout(3);
    lcdShow("Firebase...", "Connecting");
    String initJson = "{\"online\":true,\"food_level_pct\":75.0,\"total_collected_php\":" + String(totalCollectedPhp) + ",\"balance_php\":0}";
    if (fbPatch("/feeder/unit001/status", initJson)) { lcdShow("Firebase OK!", "All systems go"); }
    else { lcdShow("Firebase WARN", "Check Serial"); }
    delay(1000);
  }

  if (scale.is_ready()) tareScale();

  // Attach coin interrupt AFTER scale tare & WiFi setup so boot noise is ignored
  portENTER_CRITICAL(&coinMux);
  coinPulseCount = 0; lastPulseTime = 0; pulseFallUs = 0;
  portEXIT_CRITICAL(&coinMux);
  attachInterrupt(digitalPinToInterrupt(COIN_PIN), coinInterrupt, CHANGE);

  lcdShow("PawFeeder Ready", "Bowl:0.0g Feed");
  Serial.println("[v5.4] Commands: 't'=Tare, 'c'=Calibrate(200g), 'w'=Raw Weight, 'm'=Forward Test, 'v'=Reverse Test, 'u'=Unjam Shake, 'f 50'=Feed 50g, 'r'=Reset");
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
  static int lastCountdownSec = -1;

  int pendingPulses = 0;
  unsigned long lastPulseMs = 0;
  portENTER_CRITICAL(&coinMux);
  pendingPulses = coinPulseCount;
  lastPulseMs = lastPulseTime;
  portEXIT_CRITICAL(&coinMux);

  if (!dispensing && (pendingPulses > 0 || balancePhp > 0)) {
    long gapMs = (long)(now - lastPulseMs);

    // Process coin burst rapidly after COIN_SILENCE_MS of silence
    if (pendingPulses > 0 && gapMs >= COIN_SILENCE_MS && (now - lastCoinSnap) >= COIN_SILENCE_MS) {
      lastCoinSnap = now;
      int rawPulses = 0;
      portENTER_CRITICAL(&coinMux);
      rawPulses = coinPulseCount;
      coinPulseCount = 0;
      portEXIT_CRITICAL(&coinMux);

      Serial.printf(">> Read: %d pulses\n", rawPulses);

      if (rawPulses >= 3) {
        int coinPhp = parseCoinBurst(rawPulses);

        if (coinPhp <= 0) {
          lcdShow("Unknown coin", "Not accepted");
          delay(800);
          showBalanceLcd();
        } else {
          balancePhp += coinPhp;
          totalCollectedPhp += coinPhp;
          prefs.putInt("total_php", totalCollectedPhp);
          balanceStart = now;
          lastCountdownSec = -1;

          Serial.printf(">> Credited: P%d | Balance: P%d\n", coinPhp, balancePhp);

          // Max tier (>= P90): dispense immediately without waiting
          if (balancePhp >= 90) {
            int phpValue = 90;
            int foodGrams = tierToGrams(phpValue);
            balancePhp -= 90;

            char coinBuf[17]; snprintf(coinBuf, sizeof(coinBuf), "Coin: P%d PHP", phpValue);
            char foodBuf[17]; snprintf(foodBuf, sizeof(foodBuf), "Feed: %dg", foodGrams);
            lcdShow(coinBuf, foodBuf);
            delay(250);

            triggerDispense(foodGrams, "coin_slot");

            char coinEvent[48];
            snprintf(coinEvent, sizeof(coinEvent), "{\"php\":%d,\"grams\":%d}", phpValue, foodGrams);
            fbSet("/feeder/unit001/event/last_coin", coinEvent);
          } else if (!isTier(balancePhp)) {
            showBalanceLcd();
          }
        }
      }
      pendingPulses = 0;
    }

    // Option B: If at a tier (< P90), wait TIER_WAIT_MS in case user inserts more coins
    if (balancePhp > 0 && isTier(balancePhp) && pendingPulses == 0) {
      unsigned long elapsed = now - balanceStart;
      if (elapsed >= TIER_WAIT_MS) {
        int foodGrams = tierToGrams(balancePhp);
        int phpValue = balancePhp;
        balancePhp = 0;
        lastCountdownSec = -1;

        char coinBuf[17]; snprintf(coinBuf, sizeof(coinBuf), "Coin: P%d PHP", phpValue);
        char foodBuf[17]; snprintf(foodBuf, sizeof(foodBuf), "Feed: %dg", foodGrams);
        lcdShow(coinBuf, foodBuf);
        delay(250);

        triggerDispense(foodGrams, "coin_slot");

        char coinEvent[48];
        snprintf(coinEvent, sizeof(coinEvent), "{\"php\":%d,\"grams\":%d}", phpValue, foodGrams);
        fbSet("/feeder/unit001/event/last_coin", coinEvent);
      } else {
        int secsLeft = (int)((TIER_WAIT_MS - elapsed + 999) / 1000);
        if (secsLeft != lastCountdownSec) {
          lastCountdownSec = secsLeft;
          char l1[17]; snprintf(l1, sizeof(l1), "P%d (%dg)", balancePhp, tierToGrams(balancePhp));
          char l2[17]; snprintf(l2, sizeof(l2), "Feed in %ds...", secsLeft);
          lcdShow(l1, l2);
        }
      }
    }

    if (balancePhp > 0 && !isTier(balancePhp) && (now - balanceStart) >= BALANCE_TIMEOUT_MS) {
      int lost = balancePhp; balancePhp = 0;
      lastCountdownSec = -1;
      fbSet("/feeder/unit001/status/balance_php", "0");
      char unclaimJson[48];
      snprintf(unclaimJson, sizeof(unclaimJson), "{\"php\":%d,\"at\":%lu}", lost, now / 1000UL);
      fbSet("/feeder/unit001/event/unclaimed", unclaimJson);
      lcdShow("Balance expired", "P? refund"); delay(1500); lcdShow("PawFeeder Ready", "Bowl:0.0g Feed");
    }
  }

  // ── Poll Firebase Commands (Dispense + Web Admin Controls) ─
  // Skip network polling while user is actively inserting coins
  if (!dispensing && coinPulseCount == 0 && balancePhp == 0 && (now - lastPoll >= POLL_INTERVAL_MS)) {
    lastPoll = now;
    String active = fbGet("/feeder/unit001/cmd/dispense/active");
    active.trim();

    if (active == "true") {
      String gramsStr = fbGet("/feeder/unit001/cmd/dispense/grams");
      gramsStr.trim();
      int grams = gramsStr.toInt();
      fbSet("/feeder/unit001/cmd/dispense/active", "false");

      if (!dispensing) {
        if (grams == 901) {
          Serial.println("[Admin Web Cmd] 901 -> Unjam Auger Shake");
          unjamAuger();
          lcdShow("PawFeeder Ready", "Bowl:0.0g Feed");
        }
        else if (grams == 902) {
          Serial.println("[Admin Web Cmd] 902 -> Reverse Spin 2s");
          lcdShow("Admin Control", "Reverse Spin 2s");
          runMotorTimed(DIR_REVERSE, 2000, torqueStepDelayUs, false);
          digitalWrite(DIR_PIN, DIR_FORWARD);
          lcdShow("PawFeeder Ready", "Bowl:0.0g Feed");
        }
        else if (grams == 903) {
          Serial.println("[Admin Web Cmd] 903 -> Forward Spin 2s");
          lcdShow("Admin Control", "Forward Spin 2s");
          runMotorTimed(DIR_FORWARD, 2000, stepDelayUs, false);
          lcdShow("PawFeeder Ready", "Bowl:0.0g Feed");
        }
        else if (grams == 904) {
          Serial.println("[Admin Web Cmd] 904 -> Tare Scale");
          tareScale();
          lcdShow("Admin Tare!", "Scale: 0.0g");
          delay(900);
          lcdShow("PawFeeder Ready", "Bowl:0.0g Feed");
        }
        else if (grams == 905) {
          Serial.println("[Admin Web Cmd] 905 -> Calibrate 200g");
          calibrateScaleInteractive(200.0f);
        }
        else if (grams == 906) {
          Serial.println("[Admin Web Cmd] 906 -> Reset Coin Balance");
          balancePhp = 0;
          fbSet("/feeder/unit001/status/balance_php", "0");
          lcdShow("Admin Reset", "Balance: P0");
          delay(900);
          lcdShow("PawFeeder Ready", "Bowl:0.0g Feed");
        }
        else if (grams == 907) {
          Serial.println("[Admin Web Cmd] 907 -> Hopper Refilled 100%");
          foodLevelPct = 100.0f;
          fbSet("/feeder/unit001/status/food_level_pct", "100.0");
          lcdShow("Hopper Refilled", "Food: 100%");
          delay(1000);
          lcdShow("PawFeeder Ready", "Bowl:0.0g Feed");
        }
        else if (grams == 908) {
          Serial.println("[Admin Web Cmd] 908 -> Reset WiFi");
          lcdShow("Resetting WiFi", "Restarting...");
          WiFiManager wm;
          wm.resetSettings();
          delay(1000);
          ESP.restart();
        }
        else {
          // Normal food dispense (50g, 150g, 250g, 350g, 450g)
          if (grams <= 0) grams = 50;
          triggerDispense(grams, "remote");
        }
      }
    }
  }

  static unsigned long lastScaleLcd = 0;
  if (!dispensing && balancePhp == 0 && coinPulseCount == 0 && (now - lastScaleLcd >= 200)) {
    lastScaleLcd = now;
    float w = readBowlWeight();
    if (coinPulseCount == 0) {
      char liveBowl[17];
      snprintf(liveBowl, sizeof(liveBowl), "Bowl:%.1fg Feed", w);
      lcdShowLine2(liveBowl);
    }
  }

  if (!dispensing && coinPulseCount == 0 && balancePhp == 0 && (WiFi.status() == WL_CONNECTED) && (now - lastHeartbeat >= 5000)) {
    lastHeartbeat = now;
    char statusJson[160];
    snprintf(statusJson, sizeof(statusJson),
             "{\"bowl_weight_g\":%.1f,\"food_level_pct\":%.1f,\"online\":true,\"balance_php\":%d,\"uptime_s\":%lu,\"rssi\":%d}",
             currentWeightGrams, foodLevelPct, balancePhp, millis() / 1000UL, WiFi.RSSI());
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
  if (scale.is_ready()) readScaleRawSafe(); // discard transitional reading from while motor was spinning

  long med = 0;
  if (readScaleMedianRaw(3, med, 450, 5)) {
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
  delayMicroseconds(20);
  digitalWrite(PUL_PIN, LOW);
  delayMicroseconds(delayUs);
}

// Runs the stepper in `dir` for `durationMs` with a soft-start torque ramp
// Returns true if user pressed 'x' in Serial to abort
bool runMotorTimed(uint8_t dir, unsigned long durationMs, int targetDelayUs, bool allowSerialStop) {
  digitalWrite(DIR_PIN, dir);
  delayMicroseconds(25); // TB6600 DIR setup time before first PUL edge

  unsigned long start = millis();
  int startDelayUs = targetDelayUs + 1050; // Soft-start for max breakaway torque into fast cruise

  while (millis() - start < durationMs) {
    if (allowSerialStop && Serial.available()) {
      char c = Serial.read();
      if (c == 'x' || c == 'X') return true;
    }
    unsigned long elapsed = millis() - start;
    // Ramp up smoothly over the first 70ms of movement
    int currentDelay = (elapsed < 70)
                       ? (startDelayUs - (int)((long)(startDelayUs - targetDelayUs) * elapsed / 70))
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

  // Notify web app in real time that the machine has started dispensing
  char startJson[128];
  snprintf(startJson, sizeof(startJson),
           "{\"dispensing\":true,\"dispensed_g\":0.0,\"target_g\":%d,\"bowl_weight_g\":%.1f}",
           grams, weightBefore);
  fbPatch("/feeder/unit001/status", startJson);

  dispenseUntilWeight((float)grams, weightBefore);

  delay(250);
  float weightAfter = weightBefore;
  readCleanWeight(weightAfter);
  float actualDispensed = weightAfter - weightBefore;
  if (actualDispensed < 0.0f) actualDispensed = 0.0f;

  foodLevelPct -= (actualDispensed * 0.5f);
  if (foodLevelPct < 0.0f) foodLevelPct = 0.0f;

  digitalWrite(LED_PIN, LOW);

  // Re-arm coin interrupt before Firebase upload so coins inserted right after feeding aren't lost
  portENTER_CRITICAL(&coinMux);
  coinPulseCount = 0; lastPulseTime = 0; pulseFallUs = 0;
  portEXIT_CRITICAL(&coinMux);
  attachInterrupt(digitalPinToInterrupt(COIN_PIN), coinInterrupt, CHANGE);
  dispensing = false;

  char statusJson[176];
  snprintf(statusJson, sizeof(statusJson),
           "{\"dispensing\":false,\"dispensed_g\":%.1f,\"food_level_pct\":%.1f,\"bowl_weight_g\":%.1f,\"total_collected_php\":%d,\"balance_php\":%d}",
           actualDispensed, foodLevelPct, weightAfter, totalCollectedPhp, balancePhp);
  fbPatch("/feeder/unit001/status", statusJson);

  char eventJson[112];
  snprintf(eventJson, sizeof(eventJson),
           "{\"target_g\":%d,\"actual_g\":%.1f,\"bowl_g\":%.1f,\"source\":\"%s\"}",
           grams, actualDispensed, weightAfter, source);
  fbSet("/feeder/unit001/event/last_dispense", eventJson);

  char doneBuf[17]; snprintf(doneBuf, sizeof(doneBuf), "Added: %.0fg", actualDispensed);
  lcdShow("Done! Yum! :)", doneBuf); delay(1500);
  char idleBuf[17]; snprintf(idleBuf, sizeof(idleBuf), "Bowl:%.1fg Feed", weightAfter);
  lcdShow("PawFeeder Ready", idleBuf);
}

void dispenseUntilWeight(float targetGrams, float startWeight) {
  const unsigned long maxDispenseTimeMs = (unsigned long)(targetGrams * 350.0f) + 20000UL;
  unsigned long startTime = millis();
  unsigned long lastLiveSync = 0;
  float lastSyncedDispensed = -5.0f;
  float dispensed = 0.0f;
  float lastProgressWeight = 0.0f;
  int lastShown = -1;
  int failedReads = 0;
  int stalledChunks = 0;
  int chunkCounter = 0;
  bool manualStop = false;

  char initBuf[17]; snprintf(initBuf, sizeof(initBuf), "0g / %.0fg", targetGrams);
  lcdShow("Dispensing...", initBuf);

  while (true) {
    chunkCounter++;

    // 1. Preventive "Peck" Dither: every 4th chunk, step backward 45ms before pushing forward
    //    This relieves pressure on kibble before it can wedge against the tube wall.
    if (chunkCounter % 4 == 0) {
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

      // Live sync to Firebase every ~2.5s when weight changes so web progress bar stays in sync
      if ((millis() - lastLiveSync >= 2500UL) && (fabs(dispensed - lastSyncedDispensed) >= 2.0f)) {
        lastLiveSync = millis();
        lastSyncedDispensed = dispensed;
        char liveJson[96];
        snprintf(liveJson, sizeof(liveJson),
                 "{\"dispensing\":true,\"dispensed_g\":%.1f,\"bowl_weight_g\":%.1f}",
                 dispensed, w);
        fbPatch("/feeder/unit001/status", liveJson);
      }

      // 3. Verify target weight immediately with 3-sample median check (avoids an extra 650ms overshoot chunk)
      if (dispensed >= targetGrams - EARLY_STOP_G) {
        long verifyMed = 0;
        if (readScaleMedianRaw(3, verifyMed, 450, 5)) {
          float verifyW = (float)(verifyMed - tareBaseline) / calibrationFactor;
          if (fabs(verifyW) < 0.8f) verifyW = 0.0f;
          float verifyDispensed = verifyW - startWeight;
          if (verifyDispensed < 0.0f) verifyDispensed = 0.0f;
          dispensed = verifyDispensed;
          currentWeightGrams = verifyW;
          if (verifyDispensed >= targetGrams - EARLY_STOP_G) {
            Serial.printf("[Dispense] Target %.0fg reached! (dispensed=%.1fg)\n", targetGrams, verifyDispensed);
            break;
          }
        }
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
      Serial.printf("[Dispense] Scale read failed (%d/5)\n", failedReads);
      if (failedReads >= 5) {
        Serial.println("[Dispense] Stopping: HX711 failed 5 reads in a row!");
        break;
      }
    }

    if (millis() - startTime > maxDispenseTimeMs) {
      Serial.println("[Dispense] Stopping: Max dispense timeout reached.");
      break;
    }
  }
}