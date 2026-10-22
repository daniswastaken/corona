/* Blynk device info - must stay at the very top, before includes */
#define BLYNK_TEMPLATE_ID "TMPL67SjmdwPd"
#define BLYNK_TEMPLATE_NAME "ESP32 DevKit V1"
#define BLYNK_AUTH_TOKEN "Vb5akzU3MyIOxIWGE1aeOhmdd9v01pKg"

/* Comment this out to disable prints and save space */
#define BLYNK_PRINT Serial

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <BlynkSimpleEsp32.h>
#include <Wire.h>

// Hotspot credentials
char ssid[] = "OPUS";
char pass[] = "567890123";

// ---- Pin mapping (from kicad/esp32_project.kicad_sch) ----
#define RELAY_PIN 26     // Relay module IN  (active-HIGH)
#define LED_PIN 2        // Onboard LED mirrors relay state
#define LASER_PIN 19     // KY-008 laser S (always on for fog detection)
#define LDR_PIN 34       // LDR module OUT (analog)
#define WIND_SPEED_PIN 23 // Anemometer SPEED reed (interrupt)
#define WIND_VANE_PIN 36  // Anemometer VANE potentiometer (analog)
#define SHT31_ADDR 0x44   // I2C address (ADDR low)

// ---- Blynk virtual pins ----
// V0 relay control (switch), V1 relay state (LED)
// V2 temperature C, V3 humidity %, V4 wind speed m/s
// V5 wind direction deg, V6 light level (0..4095), V7 fog (0/1)

#define FOG_THRESHOLD 2000 // LDR reading below this => fog blocks laser
#define SEND_INTERVAL 2000UL

BlynkTimer timer;

volatile uint32_t windPulses = 0;
volatile uint32_t lastWindPulse = 0;
IRAM_ATTR void windISR() {
  uint32_t now = millis();
  if (now - lastWindPulse > 50) { // strong debounce for reed bounce
    lastWindPulse = now;
    windPulses++;
  }
}

// ---- SHT31 minimal driver ----
bool readSHT31(float &t, float &h) {
  Wire.beginTransmission(SHT31_ADDR);
  Wire.write(0x2C);
  Wire.write(0x06); // high repeatability
  if (Wire.endTransmission() != 0) return false;
  delay(20);
  Wire.requestFrom((int)SHT31_ADDR, 6);
  if (Wire.available() < 6) return false;
  uint8_t d[6];
  for (int i = 0; i < 6; i++) d[i] = Wire.read();
  uint16_t rawT = ((uint16_t)d[0] << 8) | d[1];
  uint16_t rawH = ((uint16_t)d[3] << 8) | d[4];
  t = -45.0f + 175.0f * (float)rawT / 65535.0f;
  h = 100.0f * (float)rawH / 65535.0f;
  return true;
}

void sendSensorData() {
  float temp = 0, hum = 0;
  bool ok = readSHT31(temp, hum);

  // wind speed from pulse count over SEND_INTERVAL
  uint32_t count = windPulses;
  windPulses = 0;
  // Empirical calibration: ~4 m/s at ~17.6 pulses/s
  float ms = ((float)count / ((float)SEND_INTERVAL / 1000.0f)) * 0.227f;

  // Anemometer has only a pulse (speed) output; no direction vane.
  float windDir = 0.0f;

  int light = analogRead(LDR_PIN);
  bool fog = light < FOG_THRESHOLD;

  if (ok) {
    Blynk.virtualWrite(V2, temp);
    Blynk.virtualWrite(V3, hum);
  }
  Blynk.virtualWrite(V4, ms);
  Blynk.virtualWrite(V5, 0);
  Blynk.virtualWrite(V6, light);
  Blynk.virtualWrite(V7, fog ? 1 : 0);

  // Auto relay based on fog (and reflect on dashboard)
  if (fog) {
    digitalWrite(RELAY_PIN, HIGH);
    digitalWrite(LED_PIN, HIGH);
    Blynk.virtualWrite(V0, 1);
    Blynk.virtualWrite(V1, 1);
  } else {
    digitalWrite(RELAY_PIN, LOW);
    digitalWrite(LED_PIN, LOW);
    Blynk.virtualWrite(V0, 0);
    Blynk.virtualWrite(V1, 0);
  }

  Serial.printf("T=%.2f H=%.2f wind=%.2f m/s light=%d fog=%d pulses=%lu windPin=%d\n",
                temp, hum, ms, light, fog ? 1 : 0, (unsigned long)count, digitalRead(WIND_SPEED_PIN));
}

// Control relay from Blynk app, Virtual Pin V0.
BLYNK_WRITE(V0) {
  int on = param.asInt() ? 1 : 0;
  digitalWrite(RELAY_PIN, on ? HIGH : LOW); // Active-HIGH module
  digitalWrite(LED_PIN, on ? HIGH : LOW);
  Blynk.virtualWrite(V1, on);
  Serial.print("RELAY ");
  Serial.println(on ? "CLOSED" : "OPEN");
}

BLYNK_CONNECTED() {
  Blynk.syncVirtual(V0);
}

void setup() {
  Serial.begin(115200);
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, LOW); // Start with relay open
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
  pinMode(LASER_PIN, OUTPUT);
  digitalWrite(LASER_PIN, HIGH); // Laser on for fog detection

  pinMode(WIND_SPEED_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(WIND_SPEED_PIN), windISR, RISING);

  Wire.begin(); // SDA=21, SCL=22 (matches schematic)

  analogReadResolution(12);

  Serial.println("Connecting to WiFi + Blynk...");
  WiFi.setHostname("Narukami-Spark");
  Blynk.begin(BLYNK_AUTH_TOKEN, ssid, pass);

  timer.setInterval(SEND_INTERVAL, sendSensorData);
}

void loop() {
  Blynk.run();
  timer.run();
}
