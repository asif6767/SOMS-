/*
 * SOMS Room Node — ESP32 firmware
 * Reads room sensors, drives relays, talks to SOMS backend.
 * SIMULATION_MODE 1: standalone Wokwi demo, no network needed.
 * SIMULATION_MODE 0: connects to WiFi and the real backend.
 * Requires: DHT sensor library, ArduinoJson, esp32 board package.
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <DHT.h>

// ============ 0. MODE SWITCH ============
#define SIMULATION_MODE 1   // 1 = standalone Wokwi demo, 0 = real backend-connected deployment

// ============ 1. NETWORK / BACKEND CONFIG ============
const char* WIFI_SSID      = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD  = "YOUR_WIFI_PASSWORD";
const char* BACKEND_HOST   = "http://192.168.1.50:4000";   // soms-backend REST base, no trailing slash
const char* AUTH_TOKEN     = "soms-dev-token";               // must match backend .env AUTH_TOKEN
const char* ROOM_ID        = "work1";                        // one of: drawing | work1 | work2
const char* DEVICE_ID      = "esp32-work1-01";

const unsigned long TELEMETRY_INTERVAL_MS    = 3000;
const unsigned long COMMAND_POLL_INTERVAL_MS = 2000;
const unsigned long WIFI_RETRY_INTERVAL_MS   = 5000;

// ============ 2. PIN MAP ============
#define PIN_DHT22            4
#define PIN_MQ135_AO         34
#define PIN_FLAME_AO         35
#define PIN_PIR              27
#define PIN_ACS712_FANBANK   32
#define PIN_ACS712_LIGHTBANK 33
#define PIN_RELAY_FANBANK    25
#define PIN_RELAY_LIGHTBANK  26
#define PIN_STATUS_LED       2
#define PIN_BUZZER           13

DHT dht(PIN_DHT22, DHT22);

bool relayFanBank   = false;
bool relayLightBank = false;

unsigned long lastTelemetryAt   = 0;
unsigned long lastCommandPollAt = 0;

unsigned long lastSimPrintAt    = 0;
unsigned long lastFanToggleAt   = 0;
unsigned long lastLightToggleAt = 0;
const unsigned long SIM_PRINT_INTERVAL_MS = 2000;
const unsigned long SIM_FAN_PERIOD_MS     = 10000;
const unsigned long SIM_LIGHT_PERIOD_MS   = 7000;

void setup() {
  Serial.begin(115200);
  pinMode(PIN_RELAY_FANBANK, OUTPUT);
  pinMode(PIN_RELAY_LIGHTBANK, OUTPUT);
  pinMode(PIN_STATUS_LED, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_PIR, INPUT);

  digitalWrite(PIN_RELAY_FANBANK, LOW);
  digitalWrite(PIN_RELAY_LIGHTBANK, LOW);
  digitalWrite(PIN_BUZZER, LOW);

  dht.begin();

#if SIMULATION_MODE
  Serial.println("=== SOMS Room Node — SIMULATION MODE ===");
  Serial.println("No WiFi/backend needed. Turn the pots and press the");
  Serial.println("button in the Wokwi diagram to see sensor readings and");
  Serial.println("the fan/light banks change below.");
  digitalWrite(PIN_STATUS_LED, HIGH);
#else
  Serial.println("=== SOMS Room Node — PRODUCTION MODE ===");
  connectWiFi();
#endif
}

void loop() {
#if SIMULATION_MODE
  runSimulationLoop();
#else
  runProductionLoop();
#endif
}

// ================================================================
// PRODUCTION PATH (SIMULATION_MODE 0)
// ================================================================
void runProductionLoop() {
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
    return;
  }

  unsigned long now = millis();

  if (now - lastTelemetryAt >= TELEMETRY_INTERVAL_MS) {
    lastTelemetryAt = now;
    sendTelemetry();
  }

  if (now - lastCommandPollAt >= COMMAND_POLL_INTERVAL_MS) {
    lastCommandPollAt = now;
    pollCommands();
  }
}

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.printf("[wifi] connecting to %s...\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_RETRY_INTERVAL_MS) {
    digitalWrite(PIN_STATUS_LED, !digitalRead(PIN_STATUS_LED));
    delay(250);
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[wifi] connected, IP=%s\n", WiFi.localIP().toString().c_str());
    digitalWrite(PIN_STATUS_LED, HIGH);
  } else {
    Serial.println("[wifi] retry...");
    digitalWrite(PIN_STATUS_LED, LOW);
  }
}

float readAcsAmps(int pin) {
  const float ACS712_SENSITIVITY_V_PER_A = 0.100;
  const float ADC_VREF = 3.3;
  const int ADC_MAX = 4095;
  const float DIVIDER_MULTIPLIER = 2.0;

  int raw = analogRead(pin);
  float voltageAtPin = (raw / (float)ADC_MAX) * ADC_VREF;
  float trueVoltage = voltageAtPin * DIVIDER_MULTIPLIER;
  float amps = (trueVoltage - 2.5) / ACS712_SENSITIVITY_V_PER_A;
  return amps < 0 ? 0 : amps;
}

void sendTelemetry() {
  float tempC = dht.readTemperature();
  float humidity = dht.readHumidity();
  int mq135Raw = analogRead(PIN_MQ135_AO);
  int flameRaw = analogRead(PIN_FLAME_AO);
  bool motion = digitalRead(PIN_PIR) == HIGH;
  float fanAmps = readAcsAmps(PIN_ACS712_FANBANK);
  float lightAmps = readAcsAmps(PIN_ACS712_LIGHTBANK);

  StaticJsonDocument<512> doc;
  doc["deviceId"] = DEVICE_ID;
  if (!isnan(tempC)) doc["temperatureC"] = tempC;
  if (!isnan(humidity)) doc["humidityPct"] = humidity;
  doc["mq135Raw"] = mq135Raw;
  doc["flameRaw"] = flameRaw;
  doc["motion"] = motion;
  doc["currentFanBankAmps"] = fanAmps;
  doc["currentLightBankAmps"] = lightAmps;
  doc["relayFanBank"] = relayFanBank ? "on" : "off";
  doc["relayLightBank"] = relayLightBank ? "on" : "off";
  doc["uptimeMs"] = millis();

  String body;
  serializeJson(doc, body);

  String url = String(BACKEND_HOST) + "/api/v1/hardware/" + ROOM_ID + "/telemetry";
  HTTPClient http;
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + AUTH_TOKEN);
  int code = http.POST(body);
  if (code != 200) {
    Serial.printf("[telemetry] POST failed, code=%d\n", code);
  }
  http.end();

  bool localFire = (4095 - flameRaw) / 4095.0 * 100.0 >= 70;
  digitalWrite(PIN_BUZZER, localFire ? HIGH : LOW);
}

void pollCommands() {
  String url = String(BACKEND_HOST) + "/api/v1/hardware/" + ROOM_ID + "/commands";
  HTTPClient http;
  http.begin(url);
  http.addHeader("Authorization", String("Bearer ") + AUTH_TOKEN);
  int code = http.GET();
  if (code == 200) {
    StaticJsonDocument<512> doc;
    DeserializationError err = deserializeJson(doc, http.getString());
    if (!err) {
      applyRelay(PIN_RELAY_FANBANK, relayFanBank, String(doc["relayFanBank"] | "off") == "on");
      applyRelay(PIN_RELAY_LIGHTBANK, relayLightBank, String(doc["relayLightBank"] | "off") == "on");
    }
  } else {
    Serial.printf("[commands] GET failed, code=%d\n", code);
  }
  http.end();
}

void applyRelay(int pin, bool &currentState, bool desiredOn) {
  if (currentState == desiredOn) return;
  currentState = desiredOn;
  digitalWrite(pin, desiredOn ? HIGH : LOW);
}

// ================================================================
// SIMULATION PATH (SIMULATION_MODE 1)
// ================================================================
void runSimulationLoop() {
  unsigned long now = millis();

  float tempC = dht.readTemperature();
  float humidity = dht.readHumidity();
  int mq135Raw = analogRead(PIN_MQ135_AO);
  int flameRaw = analogRead(PIN_FLAME_AO);
  bool motion = digitalRead(PIN_PIR) == HIGH;
  float fanAmps = readAcsAmps(PIN_ACS712_FANBANK);
  float lightAmps = readAcsAmps(PIN_ACS712_LIGHTBANK);

  if (now - lastFanToggleAt >= SIM_FAN_PERIOD_MS) {
    lastFanToggleAt = now;
    applyRelay(PIN_RELAY_FANBANK, relayFanBank, !relayFanBank);
  }
  if (now - lastLightToggleAt >= SIM_LIGHT_PERIOD_MS) {
    lastLightToggleAt = now;
    applyRelay(PIN_RELAY_LIGHTBANK, relayLightBank, !relayLightBank);
  }

  bool localFire = (4095 - flameRaw) / 4095.0 * 100.0 >= 70;
  digitalWrite(PIN_BUZZER, localFire ? HIGH : LOW);

  digitalWrite(PIN_STATUS_LED, motion ? ((now / 150) % 2) : HIGH);

  if (now - lastSimPrintAt >= SIM_PRINT_INTERVAL_MS) {
    lastSimPrintAt = now;
    Serial.println("----------------------------------------------------");
    Serial.printf("Room: %s | uptime: %lus\n", ROOM_ID, now / 1000);
    Serial.printf("Temp: %.1f C | Humidity: %.1f %%\n",
                  isnan(tempC) ? -1.0f : tempC, isnan(humidity) ? -1.0f : humidity);
    Serial.printf("MQ135 raw: %d | Flame raw: %d %s\n",
                  mq135Raw, flameRaw, localFire ? "<< FIRE THRESHOLD" : "");
    Serial.printf("PIR/motion: %s\n", motion ? "OCCUPIED" : "empty");
    Serial.printf("Fan bank:   %s | sensed current: %.2f A\n",
                  relayFanBank ? "ON " : "OFF", fanAmps);
    Serial.printf("Light bank: %s | sensed current: %.2f A\n",
                  relayLightBank ? "ON " : "OFF", lightAmps);
  }
}
