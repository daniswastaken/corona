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

#define RELAY_PIN 26 // Relay control pin (active-HIGH: HIGH = closed/ON)
#define LED_PIN 2   // Onboard LED mirrors relay state

// Control relay from Blynk app, Virtual Pin V0.
// Add a Switch/Button widget on V0 in the Blynk dashboard.
// Relay state is mirrored to V1 and the onboard LED for feedback.
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
  digitalWrite(RELAY_PIN, LOW); // Start with relay open (active-HIGH)
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  Serial.println("Connecting to WiFi + Blynk...");
  WiFi.setHostname("Narukami-Spark"); // Shows as Narukami-Spark on the hotspot client list
  Blynk.begin(BLYNK_AUTH_TOKEN, ssid, pass);
}

void loop() {
  Blynk.run();
}
