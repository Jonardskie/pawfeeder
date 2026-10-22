  // ============================================================
  //  PawFeeder — ESP32-CAM Firmware
  //  AI Thinker module | MJPEG live stream
  //  Board: AI Thinker ESP32-CAM
  // ============================================================
  //
  //  FLASHING NOTE:
  //    Connect FTDI adapter: TX->U0RXD, RX->U0TXD, GND->GND
  //    Bridge IO0 -> GND before powering on to enter flash mode
  //    Remove IO0->GND jumper AFTER flashing, then reset
  //
  //  ENDPOINTS (after connected to WiFi):
  //    http://<ip>/stream    — MJPEG live video stream
  //    http://<ip>/snapshot  — Single JPEG capture
  //    http://<ip>/status    — JSON: IP, WiFi signal, uptime
  // ============================================================

  #include "esp_camera.h"
  #include <WiFi.h>
  #include <WiFiManager.h>
  #include <WiFiClientSecure.h>
  #include <HTTPClient.h>
  #include "soc/soc.h"             // Needed to disable brownout detector
  #include "soc/rtc_cntl_reg.h"    // Needed to disable brownout detector

  // Firebase RTDB URL (same as control ESP32)
  #define FIREBASE_DB_URL "https://paw-feeder-faed3-default-rtdb.firebaseio.com"

  // ── WiFi Configuration ─────────────────────────────────────
  // Option A (Fastest & 100% Reliable): Enter your 2.4GHz WiFi name & password here
  // Option B: Leave empty "" to use the "PawFeeder-CAM-Setup" phone portal
  const char* WIFI_SSID = "MPT MAUI STATION";      // Enter your WiFi name here
  const char* WIFI_PASS = "chichoy26";  // Enter your WiFi password here

  // ── Outbound Cloud Video Relay Configuration ───────────────
  // The ESP32 pushes frames OUTBOUND to this relay.
  // Works from behind ANY home router or mobile data worldwide!
  bool CLOUD_RELAY_ENABLED = true;
  String RELAY_UPLOAD_URL = "https://pawfeeder-or3n.onrender.com/upload";

  WiFiServer server(80);
  WiFiClientSecure wifiClient;
  WiFiClientSecure relayClient;
  bool relayClientInited = false;

  // ── Indicator LEDs ─────────────────────────────────────────
  #define FLASH_LED_PIN 4   // Front white LED flash
  #define RED_LED_PIN   33  // Tiny red status LED on the back of ESP32-CAM (Active LOW)

  // Firebase GET helper
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

  bool fbSet(const char* path, String val) {
    HTTPClient http;
    String url = String(FIREBASE_DB_URL) + path + ".json";
    http.begin(wifiClient, url);
    http.addHeader("Content-Type", "application/json");
    int code = http.PUT(val);
    http.end();
    return (code == 200);
  }

  // Poll timer for Firebase commands (only when no client streaming)
  #define CAM_POLL_MS 5000UL
  unsigned long lastCamPoll = 0;

  // ── AI Thinker ESP32-CAM Pin Definitions ──────────────────
  #define PWDN_GPIO_NUM     32
  #define RESET_GPIO_NUM    -1
  #define XCLK_GPIO_NUM      0
  #define SIOD_GPIO_NUM     26
  #define SIOC_GPIO_NUM     27
  #define Y9_GPIO_NUM       35
  #define Y8_GPIO_NUM       34
  #define Y7_GPIO_NUM       39
  #define Y6_GPIO_NUM       36
  #define Y5_GPIO_NUM       21
  #define Y4_GPIO_NUM       19
  #define Y3_GPIO_NUM       18
  #define Y2_GPIO_NUM        5
  #define VSYNC_GPIO_NUM    25
  #define HREF_GPIO_NUM     23
  #define PCLK_GPIO_NUM     22

  void setup() {
    // 1. Disable brownout detector immediately so power dips don't freeze the chip
    WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);

    // 2. Allow 5V power rail to settle before initializing camera & radio
    delay(500);

    Serial.begin(115200);
    delay(200);
    Serial.println("\n== PawFeeder ESP32-CAM ==");

    // Onboard status LEDs
    pinMode(RED_LED_PIN, OUTPUT);
    digitalWrite(RED_LED_PIN, LOW); // Turn ON red LED during boot/connecting (active LOW)

    pinMode(FLASH_LED_PIN, OUTPUT);
    digitalWrite(FLASH_LED_PIN, LOW); // Flash LED off by default

    // ── Camera config ─────────────────────────────────────────
    camera_config_t config;
    config.ledc_channel = LEDC_CHANNEL_0;
    config.ledc_timer   = LEDC_TIMER_0;
    config.pin_d0       = Y2_GPIO_NUM;
    config.pin_d1       = Y3_GPIO_NUM;
    config.pin_d2       = Y4_GPIO_NUM;
    config.pin_d3       = Y5_GPIO_NUM;
    config.pin_d4       = Y6_GPIO_NUM;
    config.pin_d5       = Y7_GPIO_NUM;
    config.pin_d6       = Y8_GPIO_NUM;
    config.pin_d7       = Y9_GPIO_NUM;
    config.pin_xclk     = XCLK_GPIO_NUM;
    config.pin_pclk     = PCLK_GPIO_NUM;
    config.pin_vsync    = VSYNC_GPIO_NUM;
    config.pin_href     = HREF_GPIO_NUM;
    config.pin_sscb_sda = SIOD_GPIO_NUM;
    config.pin_sscb_scl = SIOC_GPIO_NUM;
    config.pin_pwdn     = PWDN_GPIO_NUM;
    config.xclk_freq_hz = 20000000;         // 20MHz for high FPS sensor readout
    config.pixel_format = PIXFORMAT_JPEG;
    config.grab_mode    = CAMERA_GRAB_LATEST; // Always grab latest frame to prevent queue lag

    if (psramFound()) {
      config.frame_size   = FRAMESIZE_HVGA; // 480x320 — ideal for buttery-smooth 15-20 FPS cloud video
      config.jpeg_quality = 10;             // High crisp quality (lower compression artifacts)
      config.fb_count     = 2;
      config.fb_location  = CAMERA_FB_IN_PSRAM;
    } else {
      config.frame_size   = FRAMESIZE_QVGA; // 320x240 — fallback if no PSRAM
      config.jpeg_quality = 16;
      config.fb_count     = 1;
      config.fb_location  = CAMERA_FB_IN_DRAM;
    }

    esp_err_t err = esp_camera_init(&config);
    if (err != ESP_OK) {
      Serial.printf("Camera init failed: 0x%x\n", err);
      Serial.println("Check power (needs stable 5V) and IO0 jumper removed.");
      return;
    }
    Serial.println("Camera initialized OK");

    // ── Sensor DSP enhancements (crisp edges, vivid color, low-light clarity) ──
    sensor_t* s = esp_camera_sensor_get();
    if (s) {
      s->set_vflip(s, 0);         // 1 = flip vertically if needed
      s->set_hmirror(s, 0);       // 1 = mirror horizontally
      s->set_brightness(s, 1);    // Brightness (-2 to 2)
      s->set_contrast(s, 1);      // +1 contrast for crisp food bowl details
      s->set_saturation(s, 1);    // +1 saturation for rich colors
      s->set_special_effect(s, 0);// Normal
      s->set_whitebal(s, 1);      // Auto white balance on
      s->set_awb_gain(s, 1);      // AWB gain on
      s->set_wb_mode(s, 0);       // Auto WB mode
      s->set_exposure_ctrl(s, 1); // Auto exposure on
      s->set_aec2(s, 1);          // Enhanced DSP auto exposure
      s->set_gainceiling(s, GAINCEILING_4X); // Cleaner low-light (removes heavy sensor noise)
      s->set_bpc(s, 1);           // Bad pixel correction (eliminates noisy sensor dots)
      s->set_wpc(s, 1);           // White pixel correction
      s->set_raw_gma(s, 1);       // Gamma curve correction (better shadow/highlight balance)
      s->set_lenc(s, 1);          // Lens shading correction (brightens dark lens corners)
      s->set_dcw(s, 1);           // Downsize interpolation filter (sharp edges)
    }

    // ── WiFi Connection ───────────────────────────────────────
    bool connected = false;

    // 1. If credentials provided in code, connect directly (fastest & most reliable)
    if (strlen(WIFI_SSID) > 0) {
      Serial.printf("[CAM WiFi] Connecting directly to '%s'...\n", WIFI_SSID);
      WiFi.mode(WIFI_STA);
      WiFi.begin(WIFI_SSID, WIFI_PASS);
      unsigned long startAttempt = millis();
      while (WiFi.status() != WL_CONNECTED && (millis() - startAttempt < 20000)) {
        delay(400);
        Serial.print(".");
        digitalWrite(RED_LED_PIN, !digitalRead(RED_LED_PIN)); // blink red LED
      }
      connected = (WiFi.status() == WL_CONNECTED);
      if (connected) Serial.println("\n[CAM WiFi] Connected directly!");
    }

    // 2. Fallback to WiFiManager portal if not connected
    if (!connected) {
      WiFiManager wm;
      wm.setConnectTimeout(20);
      wm.setConfigPortalTimeout(120);

      wm.setAPCallback([](WiFiManager* wm) {
        Serial.println("[CAM WiFi] Config portal open!");
        Serial.println("  Join WiFi: PawFeeder-CAM-Setup");
        Serial.println("  Password:  pawfeeder123");
        Serial.println("  Then open: http://192.168.4.1");
      });

      Serial.print("[CAM WiFi] Connecting via saved credentials/portal");
      connected = wm.autoConnect("PawFeeder-CAM-Setup", "pawfeeder123");

      if (!connected) {
        Serial.println("\n[CAM WiFi] Timeout — restarting");
        delay(2000);
        ESP.restart();
      }
    }

    Serial.println("\nWiFi connected!");
    Serial.printf("  IP  : http://%s\n", WiFi.localIP().toString().c_str());
    Serial.printf("  RSSI: %d dBm\n", WiFi.RSSI());
    Serial.println("\nEndpoints:");
    Serial.printf("  Stream   : http://%s/stream\n",   WiFi.localIP().toString().c_str());
    Serial.printf("  Snapshot : http://%s/snapshot\n", WiFi.localIP().toString().c_str());
    Serial.printf("  Status   : http://%s/status\n",   WiFi.localIP().toString().c_str());

    // Visual confirmation: blink 3 times and turn off red LED
    for (int i = 0; i < 3; i++) {
      digitalWrite(RED_LED_PIN, LOW); delay(100);
      digitalWrite(RED_LED_PIN, HIGH); delay(100);
    }

    wifiClient.setInsecure();  // skip SSL cert check for Firebase HTTPS
    server.begin();

    // Publish camera IP and active live stream URL to Firebase
    String publicStreamUrl = CLOUD_RELAY_ENABLED 
                           ? RELAY_UPLOAD_URL.substring(0, RELAY_UPLOAD_URL.lastIndexOf('/')) + "/stream"
                           : "http://" + WiFi.localIP().toString() + "/stream";

    fbSet("/feeder/unit001/camera/ip", "\"" + WiFi.localIP().toString() + "\"");
    fbSet("/feeder/unit001/camera/stream_url", "\"" + publicStreamUrl + "\"");
    fbSet("/feeder/unit001/camera/online", "true");
    Serial.printf("[Firebase] Camera online! Stream URL: %s ✓\n", publicStreamUrl.c_str());
  }


  // ── Outbound Cloud Frame Push Helper ───────────────────────
  int activeViewers = 0;
  unsigned long lastRelayPush = 0;
  HTTPClient httpRelay;
  bool httpRelayConnected = false;

  void pushFrameToRelay() {
    unsigned long now = millis();
    // Dynamic Frame Rate:
    // If active viewers > 0: stream as fast as network allows (0ms delay) for maximum smoothness
    // If 0 viewers: heartbeat snapshot every 1.5s to conserve bandwidth
    unsigned long interval = (activeViewers > 0) ? 0 : 1500;
    if (now - lastRelayPush < interval) return;
    lastRelayPush = now;

    camera_fb_t* fb = esp_camera_fb_get();
    if (!fb) return;

    // Connect or reuse persistent HTTPS connection (avoids repeated 300ms TLS handshakes!)
    if (!httpRelayConnected) {
      if (!relayClientInited) {
        relayClient.setInsecure();
        relayClientInited = true;
      }
      if (RELAY_UPLOAD_URL.startsWith("https://")) {
        httpRelay.begin(relayClient, RELAY_UPLOAD_URL);
      } else {
        httpRelay.begin(RELAY_UPLOAD_URL);
      }
      httpRelay.setReuse(true);
      httpRelay.setTimeout(2500);
      httpRelayConnected = true;
    }

    httpRelay.addHeader("Content-Type", "image/jpeg");
    httpRelay.addHeader("Connection", "keep-alive");

    int code = httpRelay.POST((uint8_t*)fb->buf, fb->len);
    if (code == 200) {
      String resp = httpRelay.getString();
      int vPos = resp.indexOf("\"viewers\":");
      if (vPos >= 0) {
        activeViewers = resp.substring(vPos + 10).toInt();
      }
    } else {
      // Reconnect on network drop or timeout
      httpRelay.end();
      relayClient.stop();
      httpRelayConnected = false;
    }

    esp_camera_fb_return(fb);
  }

  void loop() {
    // 1. Direct local connection handler (if accessed within home network)
    WiFiClient client = server.available();
    if (client) {
      String request = "";
      unsigned long reqStart = millis();
      while (client.connected() && millis() - reqStart < 1500) {
        if (client.available()) {
          char c = client.read();
          request += c;
          if (request.endsWith("\r\n\r\n")) break;
        }
      }

      Serial.printf("Local Request: %s\n", request.substring(0, request.indexOf('\n')).c_str());

      if (request.indexOf("GET /stream") >= 0) {
        handleStream(client);
      } else if (request.indexOf("GET /snapshot") >= 0) {
        handleSnapshot(client);
      } else if (request.indexOf("GET /status") >= 0) {
        handleStatus(client);
      } else {
        client.println("HTTP/1.1 302 Found");
        client.printf("Location: http://%s/stream\r\n", WiFi.localIP().toString().c_str());
        client.println("Connection: close\r\n");
      }
      client.stop();
    }

    // 2. Outbound Cloud Video Relay (Punches through routers & firewalls to cloud)
    if (CLOUD_RELAY_ENABLED && WiFi.status() == WL_CONNECTED) {
      pushFrameToRelay();
    }
  }

  // ============================================================
  //  MJPEG stream — renders live in <img> tag in the web app
  // ============================================================
  void handleStream(WiFiClient& client) {
    client.println("HTTP/1.1 200 OK");
    client.println("Content-Type: multipart/x-mixed-replace; boundary=frame");
    client.println("Access-Control-Allow-Origin: *");  // required for web app CORS
    client.println("Cache-Control: no-cache");
    client.println("Connection: keep-alive");
    client.println();

    Serial.println("Streaming started...");

    int failCount = 0;
    while (client.connected()) {
      camera_fb_t* fb = esp_camera_fb_get();
      if (!fb) {
        failCount++;
        if (failCount > 15) {
          Serial.println("Too many frame capture failures — closing stream");
          break;
        }
        delay(20);
        continue;
      }
      failCount = 0;

      client.println("--frame");
      client.println("Content-Type: image/jpeg");
      client.printf("Content-Length: %u\r\n", fb->len);
      client.println();
      
      size_t written = client.write(fb->buf, fb->len);
      client.println();

      esp_camera_fb_return(fb);

      if (written == 0 || !client.connected()) {
        Serial.println("Stream client write failed or disconnected");
        break;
      }

      // Small delay (~25-30fps) to let WiFi stack transmit without DMA queue overflow
      delay(10);
    }

    client.stop();
    Serial.println("Stream client disconnected and socket closed.");
  }

  // ============================================================
  //  Single JPEG snapshot
  // ============================================================
  void handleSnapshot(WiFiClient& client) {
    camera_fb_t* fb = esp_camera_fb_get();
    if (!fb) {
      client.println("HTTP/1.1 503 Service Unavailable");
      client.println();
      client.println("Camera capture failed");
      return;
    }

    client.println("HTTP/1.1 200 OK");
    client.println("Content-Type: image/jpeg");
    client.printf("Content-Length: %u\r\n", fb->len);
    client.println("Access-Control-Allow-Origin: *");
    client.println("Connection: close");
    client.println();
    client.write(fb->buf, fb->len);

    esp_camera_fb_return(fb);
    Serial.printf("Snapshot served (%u bytes)\n", fb->len);
  }

  // ============================================================
  //  JSON status endpoint — backend can poll this
  // ============================================================
  void handleStatus(WiFiClient& client) {
    String json = "{";
    json += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
    json += "\"rssi\":"  + String(WiFi.RSSI()) + ",";
    json += "\"ssid\":\"" + String(WiFi.SSID()) + "\",";
    json += "\"uptime_s\":" + String(millis() / 1000) + ",";
    json += "\"psram\":"  + String(psramFound() ? "true" : "false") + ",";
    json += "\"stream_url\":\"http://" + WiFi.localIP().toString() + "/stream\"";
    json += "}";

    client.println("HTTP/1.1 200 OK");
    client.println("Content-Type: application/json");
    client.println("Access-Control-Allow-Origin: *");
    client.println("Connection: close");
    client.println();
    client.println(json);

    Serial.println("Status served.");
  }
