// ============================================================
//  PawFeeder — Live Weight Display on LCD
//  Simple diagnostic: shows real-time grams on LCD + Serial
//  Press GPIO 5 button to re-tare (zero the scale)
//  Board: ESP32 Dev Module
// ============================================================
//  Wiring:
//  HX711 DOUT  → GPIO 25    HX711 SCK → GPIO 26
//  LCD SDA     → GPIO 32    LCD SCL   → GPIO 33
//  Tare Button → GPIO 5 (INPUT_PULLUP)
// ============================================================

#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include "HX711.h"

// ── Pins ───────────────────────────────────────────────────
#define HX711_DOUT_PIN  25
#define HX711_SCK_PIN   26

// ── Calibration ────────────────────────────────────────────
float calibrationFactor = 892.5;

// ── Objects ────────────────────────────────────────────────
LiquidCrystal_I2C lcd(0x27, 16, 2);
HX711 scale;

long tareBaseline = 0;
bool tareInitialized = false;

void setup() {
  Serial.begin(115200);
  delay(500);

  // LCD
  Wire.begin(32, 33);
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0); lcd.print("Live Scale Test");
  lcd.setCursor(0, 1); lcd.print("Initializing...");

  // HX711
  scale.begin(HX711_DOUT_PIN, HX711_SCK_PIN);

  Serial.println("\n==============================");
  Serial.println("  PawFeeder Live Weight Test");
  Serial.println("==============================");

  // Give HX711 up to 2.5 seconds to complete initial conversion
  Serial.print("Connecting to HX711");
  unsigned long startWait = millis();
  while (!scale.is_ready() && (millis() - startWait < 2500)) {
    Serial.print(".");
    delay(100);
  }
  Serial.println();

  if (scale.is_ready()) {
    Serial.println("✓ HX711 connected! Taring in 2 seconds...");
    lcd.setCursor(0, 0); lcd.print("HX711 Ready!    ");
    lcd.setCursor(0, 1); lcd.print("Taring...       ");
    delay(2000);

    // Initial clean tare
    long sum = 0;
    for (int i = 0; i < 5; i++) {
      scale.wait_ready(200);
      sum += scale.read();
      delay(110);
    }
    tareBaseline = sum / 5;
    tareInitialized = true;

    Serial.printf("✓ Tare done! Baseline: %ld\n", tareBaseline);
    lcd.setCursor(0, 0); lcd.print("Raw:            ");
    lcd.setCursor(0, 1); lcd.print("0.0 g           ");
  } else {
    Serial.println("[ERROR] HX711 not responding! Check GPIO 25 and 26.");
    lcd.setCursor(0, 0); lcd.print("HX711 ERROR!    ");
    lcd.setCursor(0, 1); lcd.print("Check GPIO25/26 ");
    while (true) delay(1000);
  }

  Serial.println("Tip: Type 't' in Serial Monitor anytime to re-tare.\n");
}

void loop() {
  // ── Serial Tare Command: type 't' then Enter ──────────────
  if (Serial.available()) {
    char c = Serial.read();
    if (c == 't' || c == 'T') {
      Serial.println("\n>>> [TARE] Zeroing scale baseline...");
      lcd.setCursor(0, 0); lcd.print("Zeroing...      ");
      lcd.setCursor(0, 1); lcd.print("Hold still...   ");
      delay(300);
      long sum = 0;
      for (int i = 0; i < 5; i++) {
        scale.wait_ready(200);
        sum += scale.read();
        delay(110);
      }
      tareBaseline = sum / 5;
      Serial.printf(">>> [TARE] Done! New baseline: %ld\n\n", tareBaseline);
    }
  }

  // ── Read Scale (Single sample per 120ms cycle) ─────────────
  if (scale.wait_ready_timeout(150)) {
    long raw = scale.read();

    long net = raw - tareBaseline;
    float grams = (float)net / calibrationFactor;
    if (grams < 0.0) grams = -grams; // Inverted polarity

    // ── LCD Display ──────────────────────────────────────────
    char line1[17];
    char line2[17];
    snprintf(line1, sizeof(line1), "Raw:%8ld    ", raw);
    snprintf(line2, sizeof(line2), "%.1fg (net:%ld) ", grams, net);

    lcd.setCursor(0, 0); lcd.print(line1);
    lcd.setCursor(0, 1); lcd.print(line2);

    // ── Serial Monitor ───────────────────────────────────────
    Serial.printf("Raw ADC: %8ld | Net: %7ld | Weight: %6.1f g\n", raw, net, grams);
  }

  delay(120);
}
