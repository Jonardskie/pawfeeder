// ============================================================
//  PawFeeder — Hardware Diagnostic & Test Run
//  Tests in real-time:
//   1. Allan 1239 ProMax Coin Slot (Pulses & Pin Voltage State)
//   2. NEMA Stepper Motor with L298N (Smooth Rotation Test)
//   3. HX711 Load Cell Scale (Live Weight Reading)
//   4. Physical Push Button (GPIO 5)
//  (NO BUZZER)
// ============================================================

#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include "HX711.h"

// ── Pin Definitions ─────────────────────────────────────────
#define COIN_PIN       18   // White wire from Coin Slot
#define BUTTON_PIN     5    // Push button to GND
#define LED_PIN        14   // Built-in / Status LED

// L298N Stepper Driver (NEMA Bipolar)
#define IN1 23
#define IN2 22
#define IN3 19
#define IN4 21

// HX711 Scale Pins
#define HX711_DOUT_PIN 25
#define HX711_SCK_PIN  26

// ── Peripherals ─────────────────────────────────────────────
LiquidCrystal_I2C lcd(0x27, 16, 2);
HX711 scale;
float calibrationFactor = 420.0;

// ── Coin Slot Pulse Tracking ────────────────────────────────
volatile int rawPulseCount = 0;
volatile unsigned long lastPulseMillis = 0;
volatile unsigned long lastCoinIsrTime = 0;
volatile bool isDispensing = false;

void IRAM_ATTR onCoinPulse() {
  unsigned long now = millis();
  // Filter out electrical spikes: real coin pulses are > 40ms apart and hold pin LOW
  if (!isDispensing && (now - lastCoinIsrTime > 40)) {
    if (digitalRead(COIN_PIN) == LOW) {
      rawPulseCount++;
      lastPulseMillis = now;
      lastCoinIsrTime = now;
    }
  }
}

// ── Half-Step Sequence for NEMA Stepper ─────────────────────
const int stepDelay = 3; // ms
const int stepSequence[8][4] = {
  {1, 0, 0, 0},
  {1, 0, 1, 0},
  {0, 0, 1, 0},
  {0, 1, 1, 0},
  {0, 1, 0, 0},
  {0, 1, 0, 1},
  {0, 0, 0, 1},
  {1, 0, 0, 1}
};

void stepperOff() {
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, LOW);
  digitalWrite(IN3, LOW);
  digitalWrite(IN4, LOW);
}

void stepMotor(int steps, bool clockwise = true) {
  for (int s = 0; s < steps; s++) {
    for (int i = 0; i < 8; i++) {
      int stepIndex = clockwise ? i : (7 - i);
      digitalWrite(IN1, stepSequence[stepIndex][0]);
      digitalWrite(IN2, stepSequence[stepIndex][1]);
      digitalWrite(IN3, stepSequence[stepIndex][2]);
      digitalWrite(IN4, stepSequence[stepIndex][3]);
      delay(stepDelay);
    }
  }
  stepperOff(); // Cut power immediately to avoid heating L298N
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n==================================================");
  Serial.println("   PAWFEEDER HARDWARE TEST & DIAGNOSTIC RUN       ");
  Serial.println("==================================================");

  // Stepper Pins
  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);
  pinMode(IN3, OUTPUT);
  pinMode(IN4, OUTPUT);
  stepperOff();

  // LED & Button
  pinMode(LED_PIN, OUTPUT);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  digitalWrite(LED_PIN, LOW);

  // Coin Pin (Internal Pull-Up)
  pinMode(COIN_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(COIN_PIN), onCoinPulse, FALLING);

  // LCD
  Wire.begin(32, 33);
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0); lcd.print("PawFeeder Test");
  lcd.setCursor(0, 1); lcd.print("Check Serial Monitor");

  // HX711 Scale
  scale.begin(HX711_DOUT_PIN, HX711_SCK_PIN);
  delay(200);
  if (scale.is_ready()) {
    scale.set_scale(calibrationFactor);
    scale.tare(10);
    Serial.println("[Scale] HX711 ready and tared to 0.0g ✓");
  } else {
    Serial.println("[Scale WARNING] HX711 not responding (check DT=25, SCK=26)");
  }

  // ── Flush all bootup transients before starting main loop ──
  noInterrupts();
  rawPulseCount = 0;
  lastPulseMillis = 0;
  lastCoinIsrTime = millis();
  interrupts();

  Serial.println("\n[SYSTEM READY]");
  Serial.printf("Current Coin Pin (D18) State: %s\n", digitalRead(COIN_PIN) == HIGH ? "HIGH (Normal/Idle for N.O.)" : "LOW (Warning: switch on N.C.?)");
  Serial.println("Instructions:");
  Serial.println(" 1. Drop a coin into the coin slot -> watch for pulse count.");
  Serial.println(" 2. Send 'm' in Serial Monitor -> test motor rotation (1 turn).");
  Serial.println(" 3. Send 't' in Serial Monitor -> tare the weight scale.");
  Serial.println(" 4. Press the physical button (GPIO 5) -> test manual trigger.");
  Serial.println("==================================================\n");
}

unsigned long lastStatusPrint = 0;

void loop() {
  unsigned long now = millis();

  // ── 1. Check for Serial Commands ──
  if (Serial.available()) {
    char ch = Serial.read();
    if (ch == 'm' || ch == 'M') {
      Serial.println("\n[MOTOR TEST] Spinning NEMA stepper 400 steps (1 full rev)...");
      lcd.setCursor(0, 0); lcd.print("Motor Testing... ");
      stepMotor(50, true);
      Serial.println("[MOTOR TEST] Done. Coils turned OFF (cool).");
      lcd.setCursor(0, 0); lcd.print("Motor OK!        ");
    } else if (ch == 't' || ch == 'T') {
      scale.tare(10);
      Serial.println("[Scale] Tared to 0.0g");
    } else if (ch == '1') {
      // Simulate P10 -> 50g
      runClosedLoopDispense(50, 10);
    } else if (ch == '3') {
      // Simulate P30 -> 150g
      runClosedLoopDispense(150, 30);
    } else if (ch == '5') {
      // Simulate P50 -> 250g
      runClosedLoopDispense(250, 50);
    } else if (ch == '7') {
      // Simulate P70 -> 350g
      runClosedLoopDispense(350, 70);
    } else if (ch == '9') {
      // Simulate P90 -> 450g
      runClosedLoopDispense(450, 90);
    }
  }

  // ── 2. Check Physical Button ──
  if (digitalRead(BUTTON_PIN) == LOW) {
    digitalWrite(LED_PIN, HIGH);
    Serial.println("\n[BUTTON PRESSED] Manual test triggered -> Dispensing 50g...");
    runClosedLoopDispense(50, 10);
    digitalWrite(LED_PIN, LOW);
    delay(500);
  }

  // ── 3. Coin Pulse Detection & Process ──
  // Aggregation window: waits 2.5s of idle after coin pulses
  static int lastSeenPulses = 0;
  if (rawPulseCount > 0) {
    if (rawPulseCount != lastSeenPulses) {
      lastSeenPulses = rawPulseCount;
      char cBuf[16]; snprintf(cBuf, sizeof(cBuf), "Coin: P%d PHP", rawPulseCount);
      char gBuf[16]; snprintf(gBuf, sizeof(gBuf), "Feed: %dg...", rawPulseCount * 5);
      lcd.setCursor(0, 0); lcd.print(cBuf);
      lcd.setCursor(0, 1); lcd.print(gBuf);
    }

    if (now - lastPulseMillis > 2500) {
      int pulses = 0;
      noInterrupts();
      pulses = rawPulseCount;
      rawPulseCount = 0;
      lastSeenPulses = 0;
      interrupts();

      int php = pulses;        // 1 pulse = 1 PHP directly from coin slot
      int foodGrams = php * 5; // 5g per 1 PHP

      Serial.println("\n**************************************************");
      Serial.printf(">>> [COIN ACCEPTED] P%d PHP! -> Target: %dg\n", php, foodGrams);
      Serial.println("**************************************************");

      runClosedLoopDispense(foodGrams, php);
    }
  }

  // ── 4. Periodic Live Status (every 2 seconds) ──
  if (now - lastStatusPrint >= 2000) {
    lastStatusPrint = now;
    int coinPinVal = digitalRead(COIN_PIN);
    float weight = scale.is_ready() ? scale.get_units(3) : 0.0;
    if (weight < 0.2 && weight > -0.2) weight = 0.0;

    Serial.printf("[Status] Coin Pin (D18): %-4s | Pulses: %d | Bowl Weight: %.1fg\n",
                  coinPinVal == HIGH ? "HIGH" : "LOW",
                  rawPulseCount,
                  weight);

    lcd.setCursor(0, 0);
    lcd.printf("D18:%-4s P:%-3d ", coinPinVal == HIGH ? "HIGH" : "LOW", rawPulseCount);
    lcd.setCursor(0, 1);
    lcd.printf("Bowl: %.1fg     ", weight);
  }
}

// ============================================================
//  Closed-Loop Dispense Process: Runs until scale reaches target
// ============================================================
void runClosedLoopDispense(int targetGrams, int php) {
  isDispensing = true;
  detachInterrupt(digitalPinToInterrupt(COIN_PIN)); // Disable coin interrupt during motor run

  float startWeight = scale.is_ready() ? scale.get_units(5) : 0.0;
  if (fabs(startWeight) < 0.3) startWeight = 0.0;

  Serial.printf("\n--- STARTING DISPENSE PROCESS ---\n");
  Serial.printf("Tier: P%d -> %dg\n", php, targetGrams);
  Serial.printf("Scale Start Weight: %.1fg\n", startWeight);

  char line1[16]; snprintf(line1, sizeof(line1), "P%d -> Target %dg", php, targetGrams);
  lcd.clear();
  lcd.setCursor(0, 0); lcd.print(line1);

  unsigned long startTime = millis();
  const unsigned long TIMEOUT_MS = 30000UL; // 30s max safety cutoff

  while (true) {
    // 1. Step motor in small batch (16 steps)
    for (int s = 0; s < 16; s++) {
      for (int i = 0; i < 8; i++) {
        digitalWrite(IN1, stepSequence[i][0]);
        digitalWrite(IN2, stepSequence[i][1]);
        digitalWrite(IN3, stepSequence[i][2]);
        digitalWrite(IN4, stepSequence[i][3]);
        delay(stepDelay);
      }
    }

    // 2. Read live bowl weight
    float curWeight = scale.is_ready() ? scale.get_units(2) : 0.0;
    float dispensed = curWeight - startWeight;
    if (dispensed < 0.0) dispensed = 0.0;

    // 3. LCD and Serial progress
    lcd.setCursor(0, 1);
    lcd.printf("+%.1fg / %dg    ", dispensed, targetGrams);
    Serial.printf("  [Dispensing] +%.1fg / %dg (Total: %.1fg)\n", dispensed, targetGrams, curWeight);

    // 4. STOP CONDITION: Reached the target gram!
    if (dispensed >= (float)targetGrams) {
      Serial.println("  ==> TARGET REACHED! Stopping motor immediately!");
      break;
    }

    // 5. SAFETY TIMEOUT:
    if (millis() - startTime > TIMEOUT_MS) {
      Serial.println("  ==> TIMEOUT! (Hopper empty or scale limit)");
      lcd.setCursor(0, 0); lcd.print("Empty Hopper?   ");
      delay(1500);
      break;
    }
  }

  stepperOff(); // Cut power to coils immediately

  float finalWeight = scale.is_ready() ? scale.get_units(5) : 0.0;
  float totalDispensed = finalWeight - startWeight;
  if (totalDispensed < 0.0) totalDispensed = 0.0;

  Serial.printf("--- DISPENSE FINISHED! Added: %.1fg | Bowl: %.1fg ---\n\n", totalDispensed, finalWeight);

  lcd.clear();
  lcd.setCursor(0, 0); lcd.print("Dispense Done!  ");
  lcd.setCursor(0, 1); lcd.printf("Added: %.1fg", totalDispensed);
  delay(1500);

  // Flush noise and re-enable interrupt
  noInterrupts();
  rawPulseCount = 0;
  lastPulseMillis = 0;
  lastCoinIsrTime = millis();
  interrupts();
  attachInterrupt(digitalPinToInterrupt(COIN_PIN), onCoinPulse, FALLING);
  isDispensing = false;
  Serial.println("[Ready] Waiting for next coin...\n");
}
