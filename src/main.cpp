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

// Hotspot credentials
char ssid[] = "OPUS";
char pass[] = "567890123";

#define LED_PIN 2 // Onboard LED on ESP32 DevKit V1

// Control onboard LED from Blynk app, Virtual Pin V0.
// Add a Switch/Button widget on V0 in the Blynk dashboard.
// LED state is mirrored to V1 for feedback.
BLYNK_WRITE(V0) {
  int state = param.asInt() ? HIGH : LOW;
  digitalWrite(LED_PIN, state);
  Blynk.virtualWrite(V1, state);
  Serial.print("LED ");
  Serial.println(state ? "ON" : "OFF");
}

BLYNK_CONNECTED() {
  Blynk.syncVirtual(V0);
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  Serial.println("Connecting to WiFi + Blynk...");
  WiFi.setHostname("Narukami-Spark"); // Shows as Narukami-Spark on the hotspot client list
  Blynk.begin(BLYNK_AUTH_TOKEN, ssid, pass);
}

void loop() {
  Blynk.run();
}
