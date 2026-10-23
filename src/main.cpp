/* Blynk device info - must stay at the very top, before includes */
#define BLYNK_TEMPLATE_ID "TMPL67SjmdwPd"
#define BLYNK_TEMPLATE_NAME "ESP32 DevKit V1"
#define BLYNK_AUTH_TOKEN "Vb5akzU3MyIOxIWGE1aeOhmdd9v01pKg"

#define BLYNK_PRINT Serial

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <BlynkSimpleEsp32.h>
#include <Wire.h>

char ssid[] = "OPUS";
char pass[] = "567890123";

// Pin mapping from kicad/esp32_project.kicad_sch
#define RELAY_PIN 26      // active-HIGH
#define LED_PIN 2
#define LASER_PIN 19      // always on for fog detection
#define LDR_PIN 34
#define WIND_SPEED_PIN 23 // reed, interrupt
#define WIND_VANE_PIN 36  // unused, no vane on hardware
#define SHT31_ADDR 0x44   // ADDR low

// Blynk pins: V0 relay switch, V1 relay state, V2 temp C, V3 humidity %,
// V4 wind m/s, V5 wind deg, V6 light 0..4095, V7 fog 0/1

#define FOG_THRESHOLD 2000 // below this = fog blocks laser
#define SEND_INTERVAL 2000UL
#define WIND_MIN_MS 1.0f
// Sensor reads 80% when real is 90-100% => scale error, not offset
#define HUM_SCALE 1.2f // raw * SCALE + OFFSET; 80 -> 96
#define HUM_OFFSET 0.0f
// shortcut: scale tuned from one observation (peak), no second reference point;
// upgrade path = measure one low RH point too, solve scale+offset from both
// shortcut: 20s window = 10 ticks of SEND_INTERVAL, so real window 20s +/- 2s;
// upgrade path = millis() timestamp diff if exact timing matters
#define CONFIRM_TICKS 10

BlynkTimer timer;

bool relayOn = false;
uint8_t condTicks = 0; // consecutive ticks in current direction

volatile uint32_t windPulses = 0;
volatile uint32_t lastWindPulse = 0;
IRAM_ATTR void windISR() {
  uint32_t now = millis();
  if (now - lastWindPulse > 50) { // strong debounce for reed bounce
    lastWindPulse = now;
    windPulses++;
  }
}

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
  h = h * HUM_SCALE + HUM_OFFSET;
  if (h < 0.0f) h = 0.0f;   // clamp into Blynk gauge range
  if (h > 100.0f) h = 100.0f;
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

  int light = analogRead(LDR_PIN);
  bool fog = light < FOG_THRESHOLD;
  bool valid = fog && ms >= WIND_MIN_MS;

  if (ok) {
    Blynk.virtualWrite(V2, temp);
    Blynk.virtualWrite(V3, hum);
  }
  Blynk.virtualWrite(V4, ms);
  Blynk.virtualWrite(V5, 0); // no direction vane on anemometer
  Blynk.virtualWrite(V6, light);
  Blynk.virtualWrite(V7, fog);

  // Symmetric debounce: 20s in new direction before relay flips; any tick
  // against the desired direction resets the count
  if (valid == relayOn) {
    condTicks = 0;
  } else if (++condTicks >= CONFIRM_TICKS) {
    relayOn = valid;
    condTicks = 0;
    digitalWrite(RELAY_PIN, relayOn);
    digitalWrite(LED_PIN, relayOn);
    Blynk.virtualWrite(V0, relayOn);
    Blynk.virtualWrite(V1, relayOn);
    Serial.printf("RELAY %s (fog=%d wind=%.2f light=%d)\n",
                  relayOn ? "CLOSED" : "OPEN", fog, ms, light);
  }

  Serial.printf("T=%.2f H=%.2f wind=%.2f m/s light=%d fog=%d pulses=%lu windPin=%d\n",
                temp, hum, ms, light, fog ? 1 : 0, (unsigned long)count, digitalRead(WIND_SPEED_PIN));
}

BLYNK_WRITE(V0) {
  bool on = param.asInt();
  relayOn = on; // manual override must win over debounce state
  condTicks = 0;
  digitalWrite(RELAY_PIN, on);
  digitalWrite(LED_PIN, on);
  Blynk.virtualWrite(V1, on);
  Serial.printf("RELAY %s\n", on ? "CLOSED" : "OPEN");
}

BLYNK_CONNECTED() {
  Blynk.syncVirtual(V0);
}

void setup() {
  Serial.begin(115200);
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, LOW); // start safe: relay open
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
  pinMode(LASER_PIN, OUTPUT);
  digitalWrite(LASER_PIN, HIGH); // fog detection needs laser on

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
