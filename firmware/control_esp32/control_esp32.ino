// ============================================================
//  PawFeeder — Control ESP32 Firmware
//  NEMA Stepper (L298N) + Allan 1239 ProMax Coin Slot + HX711 Scale
//  Closed-Loop Weight Dispense + WiFiManager + Firebase (No Buzzer)
//  Board: ESP32 Dev Module
// ============================================================
//
//  GPIO PIN MAP
//  ─────────────────────────────────────────────────────────
//  NEMA Stepper (L298N): IN1=23  IN2=22  IN3=19  IN4=21
//  Coin Slot (Allan):    COIN=18 (D18 - Interrupt)
//  Weight Scale (HX711): DT=25 (D25)  SCK=26 (D26)
//  LCD I2C:              SDA=32  SCL=33  (address 0x27)
//  Test Button:          GPIO 5  (INPUT_PULLUP)
//  Status LED:           GPIO 14
// ============================================================

#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <WiFi.h>
#include <WiFiManager.h>        // tzapu/WiFiManager
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include "HX711.h"

// ── Firebase DB URL ────────────────────────────────────────
#define FIREBASE_DB_URL "https://paw-feeder-faed3-default-rtdb.firebaseio.com"

// ── L298N Stepper Pins (NEMA Bipolar) ──────────────────────
#define IN1 23
#define IN2 22
#define IN3 19
#define IN4 21

// ── Button & Status LED ────────────────────────────────────
#define BUTTON_PIN 5
#define LED_PIN    14

// ── Allan Universal 1239 ProMax Coin Acceptor ──────────────
#define COIN_PIN 18  // Pin D18 on ESP32 (Interrupt)
volatile int coinPulseCount = 0;
volatile unsigned long lastPulseTime = 0;
volatile unsigned long lastCoinInterruptTime = 0;
volatile bool dispensing = false;
int totalCollectedPhp = 0;

void IRAM_ATTR coinInterrupt() {
  unsigned long now = millis();
  // Filter out electrical spikes: real coin pulses are > 40ms apart and hold pin LOW
  if (!dispensing && (now - lastCoinInterruptTime > 40)) {
    if (digitalRead(COIN_PIN) == LOW) {
      coinPulseCount++;
      lastPulseTime = now;
      lastCoinInterruptTime = now;
    }
  }
}

// ── Weight Scale (HX711) ───────────────────────────────────
#define HX711_DOUT_PIN 25  // Pin D25 on ESP32
#define HX711_SCK_PIN  26  // Pin D26 on ESP32
HX711 scale;
float calibrationFactor = 420.0; // Adjust after calibration
float currentWeightGrams = 0.0;

// ── LCD ────────────────────────────────────────────────────
LiquidCrystal_I2C lcd(0x27, 16, 2);

// ── Bipolar NEMA Stepping Configuration (Fast & Smooth Continuous Rotation) ──
int stepDelayUs = 1200; // Microseconds per half-step (1000-1400us gives fast 180+ RPM continuous torque)
int sequence[8][4] = {
  {1, 0, 0, 0},
  {1, 0, 1, 0},
  {0, 0, 1, 0},
  {0, 1, 1, 0},
  {0, 1, 0, 0},
  {0, 1, 0, 1},
  {0, 0, 0, 1},
  {1, 0, 0, 1}
};

// ── Cooldown ───────────────────────────────────────────────
#define COOLDOWN_MS 30000UL
unsigned long lastDispenseTime = 0;

// ── Timers ─────────────────────────────────────────────────
#define POLL_INTERVAL_MS      2000UL   // check Firebase every 2s
#define HEARTBEAT_INTERVAL_MS 10000UL
unsigned long lastPoll      = 0;
unsigned long lastHeartbeat = 0;

// ── Food Level & Bowl Weight ───────────────────────────────
float foodLevelPct = 75.0;

// ── WiFiClientSecure ───────────────────────────────────────
WiFiClientSecure wifiClient;

// ============================================================
//  LCD helper
// ============================================================
void lcdShow(const char* line1, const char* line2 = "") {
  lcd.clear();
  lcd.setCursor(0, 0); lcd.print(line1);
  lcd.setCursor(0, 1); lcd.print(line2);
}

// ============================================================
//  Firebase HTTP helpers
// ============================================================
bool fbSet(const char* path, String jsonValue) {
  HTTPClient http;
  String url = String(FIREBASE_DB_URL) + path + ".json";
  http.begin(wifiClient, url);
  http.addHeader("Content-Type", "application/json");
  int code = http.PUT(jsonValue);
  http.end();
  return (code == 200);
}

String fbGet(const char* path) {
  HTTPClient http;
  String url = String(FIREBASE_DB_URL) + path + ".json";
  http.begin(wifiClient, url);
  int code = http.GET();
  String payload = "";
  if (code == 200) payload = http.getString();
  http.end();
  return payload;
}

// Forward declarations
void stepperOff();
float readBowlWeight();
void triggerDispense(int grams, const char* source);
void dispenseUntilWeight(float targetGrams, float startWeight);

// ============================================================
//  SETUP
// ============================================================
void setup() {
  Serial.begin(115200);
  Serial.println("\n== PawFeeder Control ESP32 (NEMA L298N + Coin + Scale) ==");

  // Stepper Pins (L298N)
  pinMode(IN1, OUTPUT); pinMode(IN2, OUTPUT);
  pinMode(IN3, OUTPUT); pinMode(IN4, OUTPUT);
  stepperOff();

  // Button & Status LED (No Buzzer)
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  // ── Allan Universal 1239 ProMax Coin Acceptor ────────────
  pinMode(COIN_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(COIN_PIN), coinInterrupt, FALLING);
  Serial.println("[Coin Slot] Allan 1239 ProMax active on Pin D18 ✓");

  // LCD
  Wire.begin(32, 33);
  lcd.init();
  lcd.backlight();
  lcdShow("PawFeeder", "Starting...");
  Serial.println("LCD OK");

  // ── Initialize HX711 Weight Scale (High-Accuracy) ────────
  lcdShow("Calibrating", "Weight Scale...");
  scale.begin(HX711_DOUT_PIN, HX711_SCK_PIN);

  unsigned long t0 = millis();
  while (!scale.is_ready() && millis() - t0 < 3000) delay(50);

  if (scale.is_ready()) {
    scale.set_scale(calibrationFactor);
    Serial.println("[Scale] Keep scale EMPTY... taring (15 samples)");
    scale.tare(15); // Average 15 readings for precision zero
    Serial.println("[Scale] Ready! Weight = 0.0 g ✓");
    lcdShow("Scale Ready!", "Tared to 0.0g");
  } else {
    Serial.println("[Scale] HX711 NOT FOUND — check DOUT=25, SCK=26, VCC, GND");
    lcdShow("Scale Warn", "Check D25/D26");
  }
  delay(1200);

  // ── Hold button on boot → reset saved WiFi ────────────────
  if (digitalRead(BUTTON_PIN) == LOW) {
    lcdShow("Hold 3s to", "reset WiFi...");
    unsigned long holdStart = millis();
    while (digitalRead(BUTTON_PIN) == LOW) {
      if (millis() - holdStart >= 3000) {
        WiFiManager wm;
        wm.resetSettings();
        lcdShow("WiFi cleared!", "Restarting...");
        Serial.println("[WiFi] Settings cleared!");
        delay(1500);
        ESP.restart();
      }
    }
  }

  // ── WiFiManager ───────────────────────────────────────────
  WiFiManager wm;
  wm.setConnectTimeout(20);
  wm.setConfigPortalTimeout(120);

  wm.setAPCallback([](WiFiManager* wm) {
    lcdShow("Connect phone:", "PawFeeder-Setup");
    Serial.println("[WiFi] Portal open — join: PawFeeder-Setup pw: pawfeeder123");
    Serial.println("[WiFi] Then open 192.168.4.1 in your browser");
  });

  lcdShow("Connecting", "WiFi...");
  bool connected = wm.autoConnect("PawFeeder-Setup", "pawfeeder123");

  if (!connected) {
    Serial.println("[WiFi] Timeout — restarting");
    lcdShow("WiFi timeout", "Restarting...");
    delay(2000);
    ESP.restart();
  }

  Serial.printf("\nWiFi OK — IP: %s\n", WiFi.localIP().toString().c_str());
  lcdShow("WiFi OK!", WiFi.localIP().toString().c_str());
  delay(1500);

  // Skip SSL verification for simple REST IoT
  wifiClient.setInsecure();

  // Push initial status to Firebase
  lcdShow("Firebase...", "Connecting");
  bool ok = fbSet("/feeder/unit001/status/online",   "true")
          & fbSet("/feeder/unit001/status/food_level_pct", "75.0");

  if (ok) {
    Serial.println("[Firebase] Initial write OK ✓");
    lcdShow("Firebase OK!", "All systems go");
  } else {
    Serial.println("[Firebase] Write failed — check DB URL");
    lcdShow("Firebase WARN", "Check Serial");
  }

  delay(1000);

  // ── Flush all bootup and WiFi radio transients before starting main loop ──
  noInterrupts();
  coinPulseCount = 0;
  lastPulseTime = 0;
  lastCoinInterruptTime = millis();
  interrupts();

  lcdShow("PawFeeder Ready", "Insert Coin / Feed");
  Serial.println("Setup complete! Feeder is idle and ready for coins.");
}

// ============================================================
//  LOOP
// ============================================================
void loop() {
  unsigned long now = millis();

  // ── Serial Monitor Commands (Live Calibration & Tare) ──
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    if (cmd == "t") {
      scale.tare(15);
      Serial.println(">> [Scale] Re-zeroed to 0.0 g");
      lcdShow("Scale Tared!", "0.0g");
      delay(1000);
      lcdShow("PawFeeder Ready", "Bowl: 0g (Feed)");
    } else if (cmd.charAt(0) == 'c') {
      float known = cmd.substring(1).toFloat();
      if (known > 0) {
        scale.set_scale(1.0);
        float raw = scale.get_value(20);
        calibrationFactor = raw / known;
        scale.set_scale(calibrationFactor);
        Serial.printf(">> [Scale] Calibrated! float calibrationFactor = %.2f;\n", calibrationFactor);
        char calBuf[16]; snprintf(calBuf, sizeof(calBuf), "Cal: %.1f", calibrationFactor);
        lcdShow("Calibrated!", calBuf);
        delay(1500);
        lcdShow("PawFeeder Ready", "Bowl: 0g (Feed)");
      } else {
        Serial.println(">> Usage: c500  (known weight in grams)");
      }
    }
  }

  // ── Coin Acceptor Processing (Allan 1239 ProMax) ───────────
  // Scheme: P10 -> 50g, P30 -> 150g, P50 -> 250g, P70 -> 350g, P90 -> 450g (5g per 1 PHP)
  // Shows live accumulated PHP while user is inserting coins, then dispenses once idle for 2.5s.
  static int lastDisplayedPulses = 0;
  if (!dispensing && coinPulseCount > 0) {
    if (coinPulseCount != lastDisplayedPulses) {
      lastDisplayedPulses = coinPulseCount;
      char coinStr[16]; snprintf(coinStr, sizeof(coinStr), "Coin: P%d PHP", coinPulseCount);
      char feedStr[16]; snprintf(feedStr, sizeof(feedStr), "Feed: %dg...", coinPulseCount * 5);
      lcdShow(coinStr, feedStr);
    }

    if (now - lastPulseTime > 2500) {
      int pulses = 0;
      noInterrupts();
      pulses = coinPulseCount;
      coinPulseCount = 0;
      lastDisplayedPulses = 0;
      interrupts();

      if (pulses > 0) {
        int phpValue = pulses;        // 1 pulse = 1 PHP directly from coin slot
        int foodGrams = phpValue * 5;  // 5g per 1 PHP
        totalCollectedPhp += phpValue;

        Serial.printf("\n[COIN ACCEPTED] P%d inserted! -> Dispensing %dg food (Total Collected: P%d)\n",
                      phpValue, foodGrams, totalCollectedPhp);
        
        char coinBuf[16]; snprintf(coinBuf, sizeof(coinBuf), "Coin: +P%d PHP", phpValue);
        char foodBuf[16]; snprintf(foodBuf, sizeof(foodBuf), "Feed: %dg", foodGrams);
        lcdShow(coinBuf, foodBuf);
        delay(800);

        // Trigger closed-loop weight dispense (stops only when target grams reached)
        triggerDispense(foodGrams, "coin_slot");

        // Update total collected in Firebase
        fbSet("/feeder/unit001/status/total_collected_php", String(totalCollectedPhp));
        String coinEvent = "{\"php\":" + String(phpValue) + ",\"grams\":" + String(foodGrams) + "}";
        fbSet("/feeder/unit001/event/last_coin", coinEvent);
      }
    }
  }

  // ── Physical button ───────────────────────────────────────
  static bool lastBtn = HIGH;
  bool curBtn = digitalRead(BUTTON_PIN);
  if (lastBtn == HIGH && curBtn == LOW) {
    delay(50);
    if (digitalRead(BUTTON_PIN) == LOW) {
      bool cooledDown = (lastDispenseTime == 0) ||
                        (now - lastDispenseTime >= COOLDOWN_MS);
      if (!dispensing && cooledDown) {
        triggerDispense(50, "button");
      } else if (!cooledDown) {
        unsigned long rem = (COOLDOWN_MS - (now - lastDispenseTime)) / 1000;
        char buf[16]; snprintf(buf, sizeof(buf), "Wait %lus", rem);
        lcdShow("Cooldown!", buf);
        delay(2000);
        lcdShow("PawFeeder Ready", "Btn=Test feed");
      }
    }
  }
  lastBtn = curBtn;

  // ── Poll Firebase for commands ────────────────────────────
  if (now - lastPoll >= POLL_INTERVAL_MS) {
    lastPoll = now;

    // 1. Remote WiFi reset
    String resetWifi = fbGet("/feeder/unit001/cmd/reset_wifi");
    resetWifi.trim();
    if (resetWifi == "true") {
      fbSet("/feeder/unit001/cmd/reset_wifi", "false");
      Serial.println("[CMD] Remote WiFi reset triggered!");
      lcdShow("WiFi Reset!", "Setup mode...");
      delay(2000);
      WiFiManager wm;
      wm.resetSettings();
      ESP.restart();
    }

    // 2. Remote Scale Tare command
    String tareCmd = fbGet("/feeder/unit001/cmd/tare");
    tareCmd.trim();
    if (tareCmd == "true") {
      fbSet("/feeder/unit001/cmd/tare", "false");
      if (scale.is_ready()) {
        scale.tare(15);
        Serial.println("[CMD] Remote tare scale executed ✓");
        lcdShow("Scale Tared!", "0.0g");
        delay(1200);
        lcdShow("PawFeeder Ready", "Bowl: 0g (Feed)");
      }
    }

    // 3. Remote Dispense command
    String active = fbGet("/feeder/unit001/cmd/dispense/active");
    active.trim();

    if (active == "true") {
      String gramsStr = fbGet("/feeder/unit001/cmd/dispense/grams");
      int grams = gramsStr.toInt();
      if (grams <= 0) grams = 50;

      bool cooledDown = (lastDispenseTime == 0) ||
                        (millis() - lastDispenseTime >= COOLDOWN_MS);

      if (!dispensing && cooledDown) {
        Serial.printf("[Firebase] Remote dispense requested: %dg\n", grams);
        fbSet("/feeder/unit001/cmd/dispense/active", "false");
        triggerDispense(grams, "remote");
      } else {
        fbSet("/feeder/unit001/cmd/dispense/active", "false");
        Serial.println("[Firebase] Cooldown active — ignored.");
      }
    }
  }

  // ── Fast Weight Sync to Firebase (Triggers immediately on change >= 0.5g) ──
  static unsigned long lastWeightPoll = 0;
  static float lastSyncedWeight = -999.0;
  if (!dispensing && now - lastWeightPoll >= 500) {
    lastWeightPoll = now;
    float currentWeight = readBowlWeight();

    if (fabs(currentWeight - lastSyncedWeight) >= 0.5 || now - lastHeartbeat >= 4000) {
      lastSyncedWeight = currentWeight;
      lastHeartbeat = now;
      fbSet("/feeder/unit001/status/bowl_weight_g", String(currentWeight, 1));
      fbSet("/feeder/unit001/status/food_level_pct", String(foodLevelPct, 1));
      fbSet("/feeder/unit001/status/online", "true");
      fbSet("/feeder/unit001/status/uptime_s", String((int)(millis() / 1000)));
      fbSet("/feeder/unit001/status/rssi", String(WiFi.RSSI()));
      
      Serial.printf("[Scale Sync] Weight: %8.1f g (Synced to Web App)\n", currentWeight);
    }
  }
}

// ============================================================
//  Weight Scale Helper (High-Precision 5-Sample Filter)
// ============================================================
float readBowlWeight() {
  if (scale.is_ready()) {
    float w = scale.get_units(5); // 5-sample precision average
    if (fabs(w) < 0.3) w = 0.0;   // Noise deadband
    currentWeightGrams = w;
  }
  return currentWeightGrams;
}

// ============================================================
//  Dispense (Closed-Loop Weight Control)
// ============================================================
void triggerDispense(int grams, const char* source) {
  dispensing = true;
  lastDispenseTime = millis();
  digitalWrite(LED_PIN, HIGH);

  // 1. Physically detach coin interrupt so motor EMI noise cannot trigger extra cycles
  detachInterrupt(digitalPinToInterrupt(COIN_PIN));

  float weightBefore = readBowlWeight();

  char buf[16]; snprintf(buf, sizeof(buf), "Target: %dg", grams);
  lcdShow(strcmp(source, "remote") == 0 ? "Remote Feed!" :
          strcmp(source, "coin_slot") == 0 ? "Coin Feed!" : "Dispensing...", buf);
  Serial.printf("\n[Dispense] Target: %dg from %s (Bowl Before: %.1fg)\n", grams, source, weightBefore);

  // 2. Closed-loop: motor turns and stops the exact instant target weight is reached
  dispenseUntilWeight((float)grams, weightBefore);

  // 3. Guarantee motor is dead-stopped
  stepperOff();

  delay(600); // Allow dropped food to settle
  float weightAfter = readBowlWeight();
  float actualDispensed = weightAfter - weightBefore;
  if (actualDispensed < 0.0) actualDispensed = 0.0;

  foodLevelPct -= (actualDispensed * 0.5f);
  if (foodLevelPct < 0) foodLevelPct = 0;

  digitalWrite(LED_PIN, LOW);

  // Log to Firebase
  fbSet("/feeder/unit001/status/food_level_pct", String(foodLevelPct, 1));
  fbSet("/feeder/unit001/status/bowl_weight_g",  String(weightAfter, 1));
  fbSet("/feeder/unit001/status/cooldown_until",
        String((int)((millis() + COOLDOWN_MS) / 1000)));

  // Log last dispense event as JSON
  String event = "{\"target_g\":" + String(grams) +
                 ",\"actual_g\":" + String(actualDispensed, 1) +
                 ",\"bowl_g\":" + String(weightAfter, 1) +
                 ",\"source\":\"" + String(source) + "\"}";
  fbSet("/feeder/unit001/event/last_dispense", event);

  Serial.printf("[Dispense] Complete! Added: %.1fg | Total Bowl: %.1fg\n\n", actualDispensed, weightAfter);
  char doneBuf[16]; snprintf(doneBuf, sizeof(doneBuf), "Added: %.0fg", actualDispensed);
  lcdShow("Done! Yum! :)", doneBuf);
  delay(1500);

  char idleBuf[16]; snprintf(idleBuf, sizeof(idleBuf), "Bowl: %.0fg (Feed)", weightAfter);
  lcdShow("PawFeeder Ready", idleBuf);

  // 4. Flush any residual noise and re-enable coin interrupt for the next coin
  noInterrupts();
  coinPulseCount = 0;
  lastPulseTime = 0;
  lastCoinInterruptTime = millis();
  interrupts();
  attachInterrupt(digitalPinToInterrupt(COIN_PIN), coinInterrupt, FALLING);

  dispensing = false;
  Serial.println("[Feeder Ready] Waiting for next coin...\n");
}

// ============================================================
//  Closed-Loop Stepper Dispense (NEMA via L298N)
//  High-Speed Continuous Rotation without stuttering pauses
//  Rotates motor continuously until (currentWeight - startWeight) >= targetGrams
// ============================================================
void dispenseUntilWeight(float targetGrams, float startWeight) {
  unsigned long startTime = millis();
  const unsigned long MAX_DISPENSE_TIME_MS = 25000UL; // 25s safety timeout

  float currentWeight = startWeight;
  float dispensedSoFar = 0.0;
  int stepIndex = 0;
  unsigned long lastLcdUpdate = 0;
  unsigned long lastScaleCheck = 0;

  Serial.printf("[Dispense Start] Target: %.1fg (Starting Bowl Weight: %.1fg)\n", targetGrams, startWeight);

  // Initial LCD display
  char initialBuf[16];
  snprintf(initialBuf, sizeof(initialBuf), "0g / %.0fg", targetGrams);
  lcdShow("Dispensing...", initialBuf);

  // ── High-Speed Continuous Rotation Loop ───────────────────
  while (true) {
    // 1. Fire single microsecond step
    digitalWrite(IN1, sequence[stepIndex][0]);
    digitalWrite(IN2, sequence[stepIndex][1]);
    digitalWrite(IN3, sequence[stepIndex][2]);
    digitalWrite(IN4, sequence[stepIndex][3]);
    delayMicroseconds(stepDelayUs);

    stepIndex = (stepIndex + 1) % 8;

    // 2. Periodic checks every 32 steps (~38ms) to maintain continuous speed
    if (stepIndex == 0) {
      unsigned long now = millis();

      // Read scale non-blockingly without halting motor
      if (now - lastScaleCheck >= 40) {
        lastScaleCheck = now;
        if (scale.is_ready()) {
          float w = scale.get_units(1); // Ultra-fast 1-sample read
          if (fabs(w) < 0.3) w = 0.0;
          currentWeight = w;
          dispensedSoFar = currentWeight - startWeight;
          if (dispensedSoFar < 0.0) dispensedSoFar = 0.0;
        }
      }

      // 3. Update LCD periodically (every 350ms) without I2C motor stalling
      if (now - lastLcdUpdate >= 350) {
        lastLcdUpdate = now;
        char liveBuf[16];
        snprintf(liveBuf, sizeof(liveBuf), "%.0fg / %.0fg", dispensedSoFar, targetGrams);
        lcd.setCursor(0, 0); lcd.print("Dispensing...   ");
        lcd.setCursor(0, 1); lcd.print(liveBuf);
        for (int k = strlen(liveBuf); k < 16; k++) lcd.print(" ");

        Serial.printf("  [Dispensing] Added: %.1fg / %.0fg (Bowl: %.1fg)\n",
                      dispensedSoFar, targetGrams, currentWeight);
      }

      // 4. STOP CONDITION: Target weight reached!
      if (dispensedSoFar >= targetGrams) {
        Serial.printf("  ✓ Target weight reached! Added: %.1fg (Stopping motor)\n", dispensedSoFar);
        break;
      }

      // 5. SAFETY TIMEOUT: Container empty or mechanical jam protection
      if (now - startTime > MAX_DISPENSE_TIME_MS) {
        Serial.println("  ⚠️ Safety timeout reached! Stopping NEMA motor to prevent burnout.");
        lcdShow("Hopper Empty?", "Check Food");
        delay(1500);
        break;
      }
    }
  }

  stepperOff();
  Serial.println("  NEMA motor stopped and L298N coils powered off (cold idle).");
}

void stepperOff() {
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, LOW);
  digitalWrite(IN3, LOW);
  digitalWrite(IN4, LOW);
}
