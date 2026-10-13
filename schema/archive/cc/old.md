## GPIO / Wire Table

| From | To | Wire |
|------|----|------|
| Battery+ via fuse+switch | Buck IN+, Relay1 COM, Relay2 COM, Pump+ via Relay2 | Red 14-18AWG, star point |
| Battery- | Buck IN-, ESP32 GND, HVMOD GND, sensor GND | Black, common GND, one point |
| Buck 5V OUT | ESP32 VIN | Red/Black twisted |
| ESP32 GND | Relay GND, DHT GND, Level GND, OLED GND | Black |
| ESP32 GPIO5 | Relay1 IN1 | Yellow, opto-isolated |
| ESP32 GPIO18 | Relay2 IN2 | Orange |
| Relay1 NO | HVMOD VCC+ | Red |
| HVMOD HV+ | Corona emitter needles | HV silicone red, keep isolated, no sharp bends |
| HVMOD HV- | Collector mesh + Earth rod | Green/Yellow earth |
| ESP32 GPIO4 | DHT22 DATA + 10k pullup to 3.3V | Green |
| ESP32 3.3V | DHT VCC, OLED VCC, Level VCC | Red |
| ESP32 GPIO34 | Level sensor OUT | Blue |
| ESP32 GPIO35 | Interlock loop to GND, INPUT_PULLUP, LOW=trip | White |
| ESP32 GPIO21/22 | OLED SDA/SCL | Blue/Yellow |
| ESP32 WiFi | IoT dashboard | Wireless |

## Control Logic

1. Interlock OPEN -> HV OFF immediately, block IoT ON.
2. AUTO: humidity >85% + fog detected -> GPIO5 HIGH -> HV ON.
3. IoT override: MANUAL_ON / MANUAL_OFF / AUTO from cloud.
4. Tank FULL -> pump ON, HV stays per fog logic.
5. OLED + MQTT publish: humidity, HV state, tank, faults.

## Safety - Critical

- Fuse + main switch on Battery+.
- Relay JD-VCC isolated from ESP32 5V.
- Earth mesh separately, never share HV return with logic GND except single star point at supply.
- HV module low-current type only, enclosed, interlock kills DC input, not HV output directly.
- Thousands kV unrealistic / lethal. Use 10-30kV DC corona range.
