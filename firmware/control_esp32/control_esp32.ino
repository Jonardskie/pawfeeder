// ============================================================
//  PawFeeder — Control ESP32 Firmware (FINAL v3 — TORQUE BOOST)
//  NEMA Stepper (L298N) + Allan 1239 ProMax Coin Slot + HX711 Scale
//  Closed-Loop Weight Dispense + WiFiManager + Firebase (No Buzzer)
//  Board: ESP32 Dev Module
// ============================================================
//
//  COIN TIERS (strict — no rounding):
//    P10 -> 50g   P30 -> 150g   P50 -> 250g
//    P70 -> 350g  P90 -> 450g
//
//  BALANCE BEHAVIOR:
//    - Coins accumulate in a running balance.
//    - If balance matches a tier -> dispense immediately (after 2.5s coin gap).
//    - If balance is NOT a tier -> hold balance, LCD "Balance Pxx / Need Py more",
//      start/restart a 2-minute countdown.
//    - If 2 minutes pass with no new coin AND balance is not a tier ->
//      reset balance to 0, log { php, at } to /event/unclaimed on Firebase.
//
//  v3 TORQUE BOOST (L298N + NEMA):
//   #1  stepDelayUs 1200 -> 3000  (slower = more torque per step)
//   #2  Removed ramp-up (full torque from step 1)
//   #3  Full-step sequence (2 coils always on = ~40% more torque)
//   #4  Re-energize coils between scale reads (no cooling between chunks)
//
//  v2 FIXES STILL PRESENT:
//   #A  ISR debounce 50 -> 150 ms (kills coin-slot idle hum / EMI pulses)
//   #B  parseCoinBurst: single-coin snap absorbs 1-3 noise pulses
//       (fixes "₱20 reads as ₱21")
//   #C  Debug print every 10 s showing balance + timer elapsed
//
//  GPIO PIN MAP
//  ─────────────────────────────────────────────────────────
//  NEMA Stepper (L298N): IN1=23  IN2=22  IN3=19  IN4=21
//  Coin Slot (Allan):    COIN=18 (D18 - Interrupt)
//  Weight Scale (HX711): DT=25 (D25)  SCK=26 (D26)
//  LCD I2C:              SDA=32  SCL=33  (address 0x27)
//  Status LED:           GPIO 14
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

// ── Stepper ────────────────────────────────────────────────
#define IN1 23
#define IN2 22
#define IN3 19
#define IN4 21

// ── LED ────────────────────────────────────────────────────
#define LED_PIN 14

// ── Coin acceptor ──────────────────────────────────────────
#define COIN_PIN 18
volatile int coinPulseCount = 0;
volatile unsigned long lastPulseTime = 0;
volatile unsigned long lastCoinInterruptTime = 0;
volatile bool dispensing = false;

int totalCollectedPhp = 0;
int balancePhp        = 0;

Preferences prefs;

void IRAM_ATTR coinInterrupt() {
  unsigned long now = millis();
  // [v2 #A] 150 ms debounce — accepts real coin pulses (50-60 ms apart),
  //          rejects idle hum from the acceptor (<100 ms apart).
  if (!dispensing && (now - lastCoinInterruptTime > 150)) {
    coinPulseCount++;
    lastPulseTime = now;
    lastCoinInterruptTime = now;
  }
}

// ── HX711 ──────────────────────────────────────────────────
#define HX711_DOUT_PIN 25
#define HX711_SCK_PIN  26
HX711 scale;
float calibrationFactor = 944.49;
float currentWeightGrams = 0.0;
long tareBaseline = 0;

void tareScale() {
  long sum = 0;
  for (int i = 0; i < 5; i++) {
    scale.wait_ready(200);
    sum += scale.read();
    delay(110);
  }
  tareBaseline = sum / 5;
  currentWeightGrams = 0.0;
}

// ── LCD ────────────────────────────────────────────────────
LiquidCrystal_I2C lcd(0x27, 16, 2);

// ── Stepper sequences ──────────────────────────────────────
// [v3 #1] Slower step delay = more torque per step
int stepDelayUs = 3000;

// [v3 #3] Full-step sequence — 2 coils always energized = max torque
int sequenceFull[4][4] = {
  {1, 1, 0, 0},
  {0, 1, 1, 0},
  {0, 0, 1, 1},
  {1, 0, 0, 1}
};

// ── Dispense tuning ────────────────────────────────────────
#define RUN_CHUNK_MS   250
#define SETTLE_MS      120
#define EARLY_STOP_G   0.0f

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
float foodLevelPct = 75.0;

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

bool isTier(int php) {
  return tierToGrams(php) > 0;
}

int nextTierAbove(int php) {
  const int tiers[] = {10, 30, 50, 70, 90};
  for (int i = 0; i < 5; i++) {
    if (tiers[i] > php) return tiers[i];
  }
  return -1;
}

// ============================================================
//  Coin parsing  (pulses == pesos)
// ============================================================
int parseCoinBurst(int totalPulses) {
  // Trim up to 6 trailing noise pulses on multi-coin bursts
  if (totalPulses > 50) {
    int mod = totalPulses % 10;
    if (mod > 0 && mod <= 6) totalPulses -= mod;
  }

  // [v2 #B] Snap single-coin bursts (absorbs 1-3 noise pulses)
  if (totalPulses <= 55) {
    if (totalPulses >= 8  && totalPulses <= 12) return 10;
    if (totalPulses >= 17 && totalPulses <= 23) return 20;
    if (totalPulses >= 47 && totalPulses <= 53) return 50;
  }

  const int denoms[] = {50, 20, 10, 5, 1};
  int remaining = totalPulses;
  int php = 0;

  for (int i = 0; i < 4; i++) {
    while (remaining >= denoms[i]) {
      remaining -= denoms[i];
      php       += denoms[i];
    }
  }
  if (remaining > 0) {
    const int small[] = {1, 5, 10, 20, 50};
    int best = 1, bestDiff = abs(remaining - 1);
    for (int j = 1; j < 5; j++) {
      int d = abs(remaining - small[j]);
      if (d < bestDiff) { bestDiff = d; best = small[j]; }
    }
    if (bestDiff <= 3) php += best;
  }
  return php;
}

// ============================================================
//  LCD / Firebase helpers
// ============================================================
void lcdShow(const char* line1, const char* line2 = "") {
  lcd.clear();
  lcd.setCursor(0, 0); lcd.print(line1);
  lcd.setCursor(0, 1); lcd.print(line2);
}

bool fbSet(const char* path, String jsonValue) {
  if (WiFi.status() != WL_CONNECTED) return false;
  HTTPClient http;
  String url = String(FIREBASE_DB_URL) + path + ".json";
  http.begin(wifiClient, url);
  http.setTimeout(8000);
  http.addHeader("Content-Type", "application/json");
  int code = http.PUT(jsonValue);
  http.end();
  return (code == 200);
}

bool fbPatch(const char* path, String jsonObject) {
  if (WiFi.status() != WL_CONNECTED) return false;
  HTTPClient http;
  String url = String(FIREBASE_DB_URL) + path + ".json";
  http.begin(wifiClient, url);
  http.setTimeout(8000);
  http.addHeader("Content-Type", "application/json");
  int code = http.sendRequest("PATCH", jsonObject);
  http.end();
  return (code == 200);
}

String fbGet(const char* path) {
  if (WiFi.status() != WL_CONNECTED) return "";
  HTTPClient http;
  String url = String(FIREBASE_DB_URL) + path + ".json";
  http.begin(wifiClient, url);
  http.setTimeout(8000);
  int code = http.GET();
  String payload = "";
  if (code == 200) payload = http.getString();
  http.end();
  return payload;
}

// Forward declarations
void stepperOff();
void energizeCoil(int stepIndex);
float readBowlWeight();
void triggerDispense(int grams, const char* source);
void dispenseUntilWeight(float targetGrams, float startWeight);
void showBalanceLcd();

// ============================================================
//  SETUP
// ============================================================
void setup() {
  Serial.begin(115200);
  Serial.println("\n== PawFeeder Control ESP32 (NEMA L298N + Coin + Scale) v3 ==");

  prefs.begin("pawfeeder", false);
  totalCollectedPhp = prefs.getInt("total_php", 0);
  Serial.printf("[NVS] Restored totalCollectedPhp = %d PHP\n", totalCollectedPhp);

  pinMode(IN1, OUTPUT); pinMode(IN2, OUTPUT);
  pinMode(IN3, OUTPUT); pinMode(IN4, OUTPUT);
  stepperOff();

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  pinMode(COIN_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(COIN_PIN), coinInterrupt, FALLING);
  Serial.println("[Coin Slot] Allan 1239 ProMax active on Pin D18 OK (150ms debounce)");

  Wire.begin(32, 33);
  Wire.setClock(400000);
  lcd.init();
  lcd.backlight();
  lcdShow("PawFeeder", "Starting...");
  Serial.println("LCD OK");

  lcdShow("Calibrating", "Weight Scale...");
  scale.begin(HX711_DOUT_PIN, HX711_SCK_PIN);

  unsigned long t0 = millis();
  while (!scale.is_ready() && millis() - t0 < 3000) delay(50);

  if (scale.is_ready()) {
    Serial.println("[Scale] Keep scale EMPTY... taring baseline");
    tareScale();
    Serial.printf("[Scale] Ready! Baseline: %ld\n", tareBaseline);
    lcdShow("Scale Ready!", "Tared to 0.0g");
  } else {
    Serial.println("[Scale] HX711 NOT FOUND -- check DOUT=25, SCK=26");
    lcdShow("Scale Warn", "Check D25/D26");
  }
  delay(1200);

  WiFiManager wm;
  wm.setConnectTimeout(20);
  wm.setConfigPortalTimeout(120);
  wm.setAPCallback([](WiFiManager* wm) {
    lcdShow("Connect phone:", "PawFeeder-Setup");
    Serial.println("[WiFi] Portal: PawFeeder-Setup pw: pawfeeder123 -> 192.168.4.1");
  });

  lcdShow("Connecting", "WiFi...");
  bool connected = wm.autoConnect("PawFeeder-Setup", "pawfeeder123");

  if (!connected) {
    Serial.println("[WiFi] No connection -- Offline Coin Mode");
    lcdShow("WiFi Offline", "Coin Mode Only");
    delay(2000);
  } else {
    Serial.printf("\nWiFi OK -- IP: %s\n", WiFi.localIP().toString().c_str());
    lcdShow("WiFi OK!", WiFi.localIP().toString().c_str());
    delay(1500);
    wifiClient.setInsecure();

    lcdShow("Firebase...", "Connecting");
    String initJson = "{\"online\":true,\"food_level_pct\":75.0,"
                      "\"total_collected_php\":" + String(totalCollectedPhp) + ","
                      "\"balance_php\":0}";
    bool ok = fbPatch("/feeder/unit001/status", initJson);
    if (ok) {
      Serial.println("[Firebase] Initial write OK");
      lcdShow("Firebase OK!", "All systems go");
    } else {
      Serial.println("[Firebase] Write failed");
      lcdShow("Firebase WARN", "Check Serial");
    }
    delay(1000);
  }

  noInterrupts();
  coinPulseCount = 0;
  lastPulseTime = 0;
  lastCoinInterruptTime = millis();
  interrupts();

  if (scale.is_ready()) {
    tareScale();
    Serial.printf("[Scale] Idle baseline: %ld\n", tareBaseline);
  }

  lcdShow("PawFeeder Ready", "Bowl:0.0g Feed ");
  Serial.println("Setup complete! Feeder is idle and ready for coins.");
  Serial.println("[v3] Torque boost: stepDelayUs=3000, full-step, no ramp.");
}

// ============================================================
//  LOOP
// ============================================================
void loop() {
  unsigned long now = millis();

  // ── Serial commands ───────────────────────────────────────
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    if (cmd == "t") {
      tareScale();
      Serial.println(">> [Scale] Re-zeroed to 0.0 g");
      lcdShow("Scale Tared!", "0.0g");
      delay(1000);
      lcdShow("PawFeeder Ready", "Bowl:0g Feed ");
    } else if (cmd.charAt(0) == 'c') {
      float known = cmd.substring(1).toFloat();
      if (known > 0) {
        long sum = 0;
        for (int i = 0; i < 20; i++) {
          scale.wait_ready(200);
          sum += scale.read();
          delay(20);
        }
        long raw = sum / 20;
        calibrationFactor = (float)(raw - tareBaseline) / known;
        Serial.printf(">> Calibrated! calibrationFactor = %.2f\n", calibrationFactor);
        char calBuf[16]; snprintf(calBuf, sizeof(calBuf), "Cal: %.1f", calibrationFactor);
        lcdShow("Calibrated!", calBuf);
        delay(1500);
        lcdShow("PawFeeder Ready", "Bowl:0g Feed ");
      } else {
        Serial.println(">> Usage: c250");
      }
    } else if (cmd == "b") {
      Serial.printf(">> Balance: P%d  (isTier=%d)\n", balancePhp, isTier(balancePhp));
    } else if (cmd == "r") {
      Serial.printf(">> Resetting balance P%d -> 0\n", balancePhp);
      balancePhp = 0;
      fbSet("/feeder/unit001/status/balance_php", "0");
      lcdShow("PawFeeder Ready", "Bowl:0g Feed ");
    } else if (cmd == "m") {
      // Manual motor test: type 'm' + Enter to spin motor 2 seconds
      Serial.println(">> [Motor Test] Spinning 2s at current settings...");
      unsigned long mStart = millis();
      int mi = 0;
      while (millis() - mStart < 2000) {
        energizeCoil(mi);
        delayMicroseconds(stepDelayUs);
        mi = (mi + 1) % 4;
      }
      stepperOff();
      Serial.println(">> [Motor Test] Done.");
    }
  }

  // ── Coin processing ───────────────────────────────────────
  static unsigned long lastCoinSnap   = 0;
  static unsigned long balanceStart   = 0;

  if (!dispensing && (coinPulseCount > 0 || balancePhp > 0)) {
    long gapMs = (long)(now - lastPulseTime);

    // ── One coin burst finished ────────────────────────────
    if (coinPulseCount > 0 && gapMs >= 900 && (now - lastCoinSnap) >= 900) {
      lastCoinSnap = now;

      int rawPulses = 0;
      noInterrupts();
      rawPulses      = coinPulseCount;
      coinPulseCount = 0;
      interrupts();

      int coinPhp = parseCoinBurst(rawPulses);

      if (coinPhp <= 0) {
        Serial.printf("[Coin Slot] %d pulses -> P0 — ignored\n", rawPulses);
        lcdShow("Unknown coin", "Not accepted");
        delay(800);
        showBalanceLcd();
      } else {
        balancePhp        += coinPhp;
        totalCollectedPhp += coinPhp;
        prefs.putInt("total_php", totalCollectedPhp);
        fbSet("/feeder/unit001/status/total_collected_php", String(totalCollectedPhp));
        fbSet("/feeder/unit001/status/balance_php",         String(balancePhp));

        Serial.printf("[Coin Slot] %d pulses -> P%d | Balance: P%d\n",
                      rawPulses, coinPhp, balancePhp);

        balanceStart = now;

        if (isTier(balancePhp)) {
          int foodGrams = tierToGrams(balancePhp);
          int phpValue  = balancePhp;
          balancePhp    = 0;
          fbSet("/feeder/unit001/status/balance_php", "0");

          Serial.println("\n==================================================");
          Serial.printf("[COIN TRANSACTION] P%d PHP -> Dispensing %dg\n", phpValue, foodGrams);
          Serial.println("==================================================");

          char coinBuf[16]; snprintf(coinBuf, sizeof(coinBuf), "Coin: P%d PHP", phpValue);
          char foodBuf[16]; snprintf(foodBuf, sizeof(foodBuf), "Feed: %dg", foodGrams);
          lcdShow(coinBuf, foodBuf);
          delay(800);

          triggerDispense(foodGrams, "coin_slot");

          String coinEvent = "{\"php\":" + String(phpValue) +
                             ",\"grams\":" + String(foodGrams) + "}";
          fbSet("/feeder/unit001/event/last_coin", coinEvent);
        } else {
          showBalanceLcd();
        }
      }
    }

    // ── Debug print every 10 s while balance is non-tier ──
    if (balancePhp > 0 && !isTier(balancePhp)) {
      static unsigned long lastDebug = 0;
      if (now - lastDebug > 10000) {
        lastDebug = now;
        unsigned long elapsed = now - balanceStart;
        Serial.printf("[Balance Timer] Balance=P%d  elapsed=%lus / %lus\n",
                      balancePhp, elapsed / 1000, BALANCE_TIMEOUT_MS / 1000);
      }
    }

    // ── 2-minute timeout on a non-tier balance ────────────
    if (balancePhp > 0 && !isTier(balancePhp) && (now - balanceStart) >= BALANCE_TIMEOUT_MS) {
      int lost   = balancePhp;
      balancePhp = 0;
      fbSet("/feeder/unit001/status/balance_php", "0");

      Serial.printf("[BALANCE TIMEOUT] P%d unclaimed — reset to 0\n", lost);

      String unclaimed = "{\"php\":" + String(lost) +
                         ",\"at\":"   + String((int)(now / 1000)) + "}";
      fbSet("/feeder/unit001/event/unclaimed", unclaimed);

      lcdShow("Balance expired", "P? refund");
      delay(1500);
      lcdShow("PawFeeder Ready", "Bowl:0g Feed ");
    }
  }

  // ── Firebase command polling ──────────────────────────────
  if (now - lastPoll >= POLL_INTERVAL_MS) {
    lastPoll = now;

    String resetWifi = fbGet("/feeder/unit001/cmd/reset_wifi");
    resetWifi.trim();
    if (resetWifi == "true") {
      fbSet("/feeder/unit001/cmd/reset_wifi", "false");
      Serial.println("[CMD] Remote WiFi reset");
      lcdShow("WiFi Reset!", "Setup mode...");
      delay(2000);
      WiFiManager wm;
      wm.resetSettings();
      ESP.restart();
    }

    String tareCmd = fbGet("/feeder/unit001/cmd/tare");
    tareCmd.trim();
    if (tareCmd == "true") {
      fbSet("/feeder/unit001/cmd/tare", "false");
      if (scale.is_ready()) {
        tareScale();
        Serial.println("[CMD] Remote tare OK");
        lcdShow("Scale Tared!", "0.0g");
        delay(1200);
        lcdShow("PawFeeder Ready", "Bowl:0g Feed ");
      }
    }

    String active = fbGet("/feeder/unit001/cmd/dispense/active");
    active.trim();
    if (active == "true") {
      String gramsStr = fbGet("/feeder/unit001/cmd/dispense/grams");
      int grams = gramsStr.toInt();
      if (grams <= 0) grams = 50;
      bool cooledDown = (lastDispenseTime == 0) ||
                        (millis() - lastDispenseTime >= COOLDOWN_MS);
      if (!dispensing && cooledDown) {
        Serial.printf("[Firebase] Remote dispense: %dg\n", grams);
        fbSet("/feeder/unit001/cmd/dispense/active", "false");
        triggerDispense(grams, "remote");
      } else {
        fbSet("/feeder/unit001/cmd/dispense/active", "false");
        Serial.println("[Firebase] Cooldown active — ignored");
      }
    }
  }

  // ── Live scale + LCD ──────────────────────────────────────
  static unsigned long lastScaleLcd = 0;
  if (!dispensing && balancePhp == 0 && (now - lastScaleLcd >= 150)) {
    lastScaleLcd = now;
    float w = readBowlWeight();
    if (coinPulseCount == 0) {
      char liveBowl[17];
      snprintf(liveBowl, sizeof(liveBowl), "Bowl:%.1fg Feed ", w);
      lcd.setCursor(0, 1);
      lcd.print(liveBowl);
    }
  }

  // ── Firebase status sync ──────────────────────────────────
  if (!dispensing && (WiFi.status() == WL_CONNECTED) && (now - lastHeartbeat >= 5000)) {
    lastHeartbeat = now;
    String statusJson = "{\"bowl_weight_g\":" + String(currentWeightGrams, 1) +
                        ",\"food_level_pct\":" + String(foodLevelPct, 1) +
                        ",\"online\":true" +
                        ",\"balance_php\":" + String(balancePhp) +
                        ",\"uptime_s\":" + String((int)(millis() / 1000)) +
                        ",\"rssi\":" + String(WiFi.RSSI()) + "}";
    fbPatch("/feeder/unit001/status", statusJson);
    Serial.printf("[Scale Sync] Weight: %.1f g | Balance: P%d\n",
                  currentWeightGrams, balancePhp);
  }
}

// ============================================================
//  Show balance LCD
// ============================================================
void showBalanceLcd() {
  if (balancePhp <= 0) {
    lcdShow("PawFeeder Ready", "Bowl:0g Feed ");
    return;
  }
  int next = nextTierAbove(balancePhp);
  char line1[17];
  snprintf(line1, sizeof(line1), "Balance P%d", balancePhp);
  if (next > 0) {
    char line2[17];
    snprintf(line2, sizeof(line2), "Need P%d more", next - balancePhp);
    lcdShow(line1, line2);
  } else {
    lcdShow(line1, "Insert more...");
  }
}

// ============================================================
//  Stepper helpers
// ============================================================
void stepperOff() {
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, LOW);
  digitalWrite(IN3, LOW);
  digitalWrite(IN4, LOW);
}

// [v3 #3/#4] Energize the current full-step coil pair
void energizeCoil(int stepIndex) {
  digitalWrite(IN1, sequenceFull[stepIndex][0]);
  digitalWrite(IN2, sequenceFull[stepIndex][1]);
  digitalWrite(IN3, sequenceFull[stepIndex][2]);
  digitalWrite(IN4, sequenceFull[stepIndex][3]);
}

// ============================================================
//  Weight helpers
// ============================================================
float readBowlWeight() {
  if (scale.is_ready()) {
    long raw = scale.read();
    long net = raw - tareBaseline;
    float w = (float)net / calibrationFactor;
    if (fabs(w) < 0.5) w = 0.0;
    currentWeightGrams = w;
  }
  return currentWeightGrams;
}

static bool readCleanWeight(float &wOut) {
  stepperOff();
  delay(SETTLE_MS);
  if (scale.is_ready()) scale.read();

  for (int attempt = 0; attempt < 2; attempt++) {
    if (scale.wait_ready_timeout(600)) {
      long raw = scale.read();
      float w  = (float)(raw - tareBaseline) / calibrationFactor;
      if (fabs(w) < 0.5f) w = 0.0f;
      wOut = w;
      return true;
    }
    Serial.println("  [Scale] HX711 stuck - power cycling");
    scale.power_down();
    delay(10);
    scale.power_up();
  }
  return false;
}

// ============================================================
//  Dispense wrapper
// ============================================================
void triggerDispense(int grams, const char* source) {
  dispensing = true;
  lastDispenseTime = millis();
  digitalWrite(LED_PIN, HIGH);

  detachInterrupt(digitalPinToInterrupt(COIN_PIN));

  float weightBefore = currentWeightGrams;
  if (scale.wait_ready_timeout(300)) {
    long raw = scale.read();
    long net = raw - tareBaseline;
    float w  = (float)net / calibrationFactor;
    if (fabs(w) < 0.5) w = 0.0;
    weightBefore = w;
    currentWeightGrams = w;
  }

  char buf[16]; snprintf(buf, sizeof(buf), "Target: %dg", grams);
  lcdShow(strcmp(source, "remote")    == 0 ? "Remote Feed!" :
          strcmp(source, "coin_slot") == 0 ? "Coin Feed!"   : "Dispensing...", buf);
  Serial.printf("\n[Dispense] Target: %dg from %s (Bowl Before: %.1fg)\n",
                grams, source, weightBefore);

  dispenseUntilWeight((float)grams, weightBefore);

  stepperOff();

  delay(1000);
  float weightAfter    = readBowlWeight();
  float actualDispensed = weightAfter - weightBefore;
  if (actualDispensed < 0.0) actualDispensed = 0.0;

  foodLevelPct -= (actualDispensed * 0.5f);
  if (foodLevelPct < 0) foodLevelPct = 0;

  digitalWrite(LED_PIN, LOW);

  fbSet("/feeder/unit001/status/food_level_pct", String(foodLevelPct, 1));
  fbSet("/feeder/unit001/status/bowl_weight_g",  String(weightAfter, 1));
  fbSet("/feeder/unit001/status/cooldown_until",
        String((int)((millis() + COOLDOWN_MS) / 1000)));

  String event = "{\"target_g\":" + String(grams) +
                 ",\"actual_g\":" + String(actualDispensed, 1) +
                 ",\"bowl_g\":"   + String(weightAfter, 1) +
                 ",\"source\":\""  + String(source) + "\"}";
  fbSet("/feeder/unit001/event/last_dispense", event);

  Serial.printf("[Dispense] Complete! Added: %.1fg | Total Bowl: %.1fg\n\n",
                actualDispensed, weightAfter);
  char doneBuf[16]; snprintf(doneBuf, sizeof(doneBuf), "Added: %.0fg", actualDispensed);
  lcdShow("Done! Yum! :)", doneBuf);
  delay(1500);

  char idleBuf[17]; snprintf(idleBuf, sizeof(idleBuf), "Bowl:%.0fg Feed ", weightAfter);
  lcdShow("PawFeeder Ready", idleBuf);

  noInterrupts();
  coinPulseCount = 0;
  lastPulseTime  = 0;
  lastCoinInterruptTime = millis();
  interrupts();
  attachInterrupt(digitalPinToInterrupt(COIN_PIN), coinInterrupt, FALLING);

  dispensing = false;
  Serial.println("[Feeder Ready] Waiting for next coin...\n");
}

// ============================================================
//  Closed-loop dispense  (v3: full-step, no ramp, re-energize)
// ============================================================
void dispenseUntilWeight(float targetGrams, float startWeight) {
  const unsigned long maxDispenseTimeMs = (unsigned long)(targetGrams * 300.0f) + 15000UL;
  unsigned long startTime = millis();

  int   stepIndex  = 0;      // 0..3 (full-step)
  float dispensed  = 0.0f;
  int   lastShown  = -1;
  int   failedReads = 0;
  bool  manualStop = false;

  Serial.printf("[Dispense Start] Target: %.0fg | Start bowl: %.1fg | Timeout: %lus\n",
                targetGrams, startWeight, maxDispenseTimeMs / 1000);
  Serial.printf("  [v3] stepDelayUs=%d full-step no-ramp\n", stepDelayUs);
  Serial.println("  Tip: type 'x' to emergency stop.");

  char initBuf[17];
  snprintf(initBuf, sizeof(initBuf), "0g / %.0fg", targetGrams);
  lcdShow("Dispensing...", initBuf);

  while (true) {
    // ── 1. RUN motor for RUN_CHUNK_MS (v3: no ramp, full-step) ──
    unsigned long chunkStart = millis();
    while (millis() - chunkStart < RUN_CHUNK_MS) {
      if (Serial.available()) {
        char c = Serial.read();
        if (c == 'x' || c == 'X') { manualStop = true; break; }
      }
      energizeCoil(stepIndex);
      delayMicroseconds(stepDelayUs);
      stepIndex = (stepIndex + 1) % 4;   // 4-step full-step cycle
    }
    if (manualStop) { Serial.println("  [STOP] Motor halted manually!"); break; }

    // ── 2. STOP + clean scale sample ──────────────────────
    float w;
    if (readCleanWeight(w)) {
      failedReads = 0;
      dispensed = w - startWeight;
      if (dispensed < 0.0f) dispensed = 0.0f;

      Serial.printf("  [Scale] bowl=%.1fg dispensed=%.1fg / %.0fg\n",
                    w, dispensed, targetGrams);

      int shown = (int)(dispensed + 0.5f);
      if (shown != lastShown) {
        lastShown = shown;
        char liveBuf[17];
        snprintf(liveBuf, sizeof(liveBuf), "%dg / %.0fg", shown, targetGrams);
        lcd.setCursor(0, 1);
        lcd.print(liveBuf);
        for (int k = strlen(liveBuf); k < 16; k++) lcd.print(" ");
      }

      if (dispensed >= targetGrams - EARLY_STOP_G) {
        Serial.printf("  [DONE] Target reached! Added: %.1fg\n", dispensed);
        break;
      }
    } else {
      failedReads++;
      Serial.printf("  [Scale] WARN: no sample (%d/5)\n", failedReads);
      if (failedReads >= 5) {
        Serial.println("  [ERROR] Scale not responding — stopping.");
        lcdShow("Scale Error!", "Check wiring");
        delay(1500);
        break;
      }
    }

    // ── [v3 #4] Re-energize coils so motor stays warm between chunks ──
    energizeCoil(stepIndex);

    // ── 3. Safety timeout ─────────────────────────────────
    if (millis() - startTime > maxDispenseTimeMs) {
      Serial.println("  [TIMEOUT] Safety stop.");
      lcdShow("Hopper Empty?", "Check Food");
      delay(1500);
      break;
    }
  }

  stepperOff();
  Serial.println("  NEMA motor stopped (cold idle).");
}