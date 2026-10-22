// ============================================================
//  I2C Address Scanner
//  Upload this first to find your LCD's I2C address.
//  Open Serial Monitor @ 115200 and check the output.
// ============================================================
#include <Wire.h>

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n== I2C Scanner ==");

  Wire.begin(32, 33);  // SDA=32, SCL=33  (your actual wiring)

  byte deviceCount = 0;
  for (byte addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    byte err = Wire.endTransmission();
    if (err == 0) {
      Serial.printf("Found I2C device at address: 0x%02X\n", addr);
      deviceCount++;
    }
  }

  if (deviceCount == 0) {
    Serial.println("\nNo I2C devices found!");
    Serial.println("Check wiring:");
    Serial.println("  LCD SDA → ESP32 GPIO 21");
    Serial.println("  LCD SCL → ESP32 GPIO 22");
    Serial.println("  LCD VCC → 5V  (NOT 3.3V!)");
    Serial.println("  LCD GND → GND");
  } else {
    Serial.printf("\nFound %d device(s).\n", deviceCount);
    Serial.println("Use the address above in your firmware.");
    Serial.println("Common LCD addresses: 0x27 or 0x3F");
  }
}

void loop() {}
