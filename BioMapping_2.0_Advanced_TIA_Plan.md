# BioMapping 2.0 
# Christian Nold 2026

The Complete Build & Software Guide (ADS1115 Transimpedance Amplifier Edition)

## 1. Introduction: What is BioMapping 2.0?
BioMapping 2.0 is a new version of Christian Nold's Bio Mapping project for the **Flipper Zero**. 
It allows you to walk through a city or landscape and record your body's physiological arousal responses mapped precisely to geographical coordinates. 

It translates your Galvanic Skin Response (GSR) fluctuations into **topographical elevation** within a GPX file. When you import your walk into Google Earth, your route will look flat while you were at your baseline, but "mountains" will appear where you experienced stress or arousal, and "valleys" or craters will map your deep relaxation.

This version of the device uses a dedicated 16-bit **ADS1115** Analog-to-Digital Converter combined with a robust, highly stable **Transimpedance Amplifier (TIA)** circuit. By utilizing a dual op-amp for active voltage buffering and hardware low-pass filtering, we achieve a highly precise, noise-resistant way to measure the tiny changes in human sweat gland activity.

---

## 2. Hardware Requirements
To build this, you need the following physical components:

**Core Boards:**
* **Flipper Zero**
* **L76K GNSS Prototyping Shield:** Gives you a pre-wired GPS module alongside a blank 126-hole grid to build your custom circuit.
* **ADS1115 Breakout Board:** A high-precision 16-bit I2C ADC chip.

**Active Components:**
* **1x MCP6042** (or equivalent 3.3V rail-to-rail Dual Op-Amp)

**Passive Components:**
* **1x 56kΩ Resistor** (For the voltage divider 0.1% tolerance metal film recommended)
* **1x 10kΩ Resistor** (For the voltage divider 0.1% tolerance metal film recommended)
* **1x 47kΩ Resistor** (For the TIA gain/feedback 1% tolerance metal film recommended)
* **2x 4.7kΩ Resistors** (For safety inline with the electrodes 1% tolerance metal film recommended)
* **2x 100nF (0.1µF) Ceramic Capacitors** (One for power bypass, one for the feedback filter)

**Biometric Interface:**
* **GSR Finger Electrodes:** Standard biometric finger clips or simple velcro strips with aluminum foil/copper tape.

---

## 3. The Wiring Guide & Hardware Surgery (Step-by-Step)

### Phase 1: Freeing the I2C Bus (Trace Cuts) ✅ COMPLETE
The two copper traces connecting **Pin 15 (PC1)** and **Pin 16 (PC0)** to the L76K GPS module have been physically cut. These pins are now free for exclusive use by the ADS1115 I2C bus.

* Pin 15 (PC1) — **no longer connected to GPS** → used for I2C **SCL**
* Pin 16 (PC0) — **no longer connected to GPS** → used for I2C **SDA**

### Phase 2: GPS Hardware Reroute — Not Required ✅
No additional wiring is needed. The L76K cannot be put to sleep via software, so no STANDBY or RESET wires need to be soldered. The GPS runs continuously. Software reset commands are available over UART for error recovery — see **Section 4a**.

### Phase 3: Installing the Biometric Sensor Circuit
Mount the ADS1115 and the MCP6002 onto the prototyping grid and wire them. We will use both channels (A and B) of the MCP6002.

*(MCP6002 Reference: Pin 1=Out A, 2=In- A, 3=In+ A, 4=GND, 8=3.3V, 7=Out B, 6=In- B, 5=In+ B)*

* **Power & I2C (ADS1115):**
  * `VDD` on ADS1115 -> **Pin 9 (3.3V)**
  * `GND` on ADS1115 -> **Pin 8 (GND)**
  * `ADDR` on ADS1115 -> **Pin 8 (GND)** *(Hardcodes the I2C address to 0x48)*
  * `SCL` on ADS1115 -> **Pin 15 (PC1)**
  * `SDA` on ADS1115 -> **Pin 16 (PC0)**

* **Power & Bypass (MCP6002):**
  * Pin 8 -> **Pin 9 (3.3V)**
  * Pin 4 -> **Pin 8 (GND)**
  * **Mandatory:** Solder one **100nF capacitor** directly across Pin 8 and Pin 4 to filter digital power spikes from the Flipper.

* **Generate the 0.5V Bias (V_ref) using Op-Amp B (Voltage Follower):**
  * Solder the **56kΩ Resistor** from 3.3V to MCP6002 Pin 5 (In+ B).
  * Solder the **10kΩ Resistor** from MCP6002 Pin 5 (In+ B) to GND.
  * Tie MCP6002 Pin 7 (Out B) directly to Pin 6 (In- B).
  * *Result: Pin 7 is now a rock-solid, buffered 0.5V Reference (V_ref).*

* **Build the Transimpedance Amplifier (TIA) using Op-Amp A:**
  * Connect your V_ref (Pin 7) to MCP6002 Pin 3 (In+ A).
  * Tie the **47kΩ Resistor** and the second **100nF Capacitor** in parallel between Pin 1 (Out A) and Pin 2 (In- A). This acts as both the amplifier gain and a hardware low-pass filter to destroy 50/60Hz mains hum.

* **Connect Electrodes & Safety Resistors:**
  * Electrode 1 (GND): GND -> **4.7kΩ Resistor** -> Wire -> Foil/Finger 1.
  * Electrode 2 (SIGNAL): Foil/Finger 2 -> Wire -> **4.7kΩ Resistor** -> MCP6002 Pin 2 (In- A).
  * *These resistors (9.4 kΩ total) ensure maximum skin current is safe while keeping the TIA output within the ADC range for the full span of human skin resistance.*

* **Differential Connection to ADS1115:**
  * Connect **ADS1115 AIN0** to MCP6002 Pin 1 (Out A) (The amplified GSR signal).
  * Connect **ADS1115 AIN1** to MCP6002 Pin 7 (Out B) (The clean 0.5V V_ref).

By routing the signals this way, the ADS1115 subtracts the 0.5V virtual ground offset perfectly, isolating the amplified skin current data while completely rejecting external system noise!

---

## 4. Software Architecture

Writing this app in C is highly efficient with the ADS1115 in differential mode. We configure the ADS1115 to measure the exact difference between A0 and A1.

### Reading the ADS1115 with Dynamic PGA Auto-Ranging
To capture the full dynamic range of human skin resistance with maximum sensitivity and resolution, the software implements active **PGA (Programmable Gain Amplifier) Auto-Ranging** using the normal differential pins (AIN0 and AIN1) on the ADS1115.

The core module `gsr_sensor.c` runs a background thread to read the ADS1115 at 860 SPS, applying the following logic:
1. **Dynamic Gain Scaling:** 
   - **Range Down (Avoid Clipping):** If the absolute differential voltage exceeds 30,000 counts (~91.5% of full scale), the PGA gain index is immediately decreased (e.g. from ±0.512V to ±1.024V) to widen the range.
   - **Range Up (Increase Resolution):** If the absolute reading remains below 4,096 counts (~12.5% of full scale) for 5 consecutive ticks, the PGA gain index is increased (e.g. from ±2.048V to ±1.024V) to narrow the range.
2. **Output Normalization:** To ensure downstream filters (EMA and Derivative) receive a consistent signal, all hardware readings are normalized back to a common baseline of the ±0.256V range (where 1 LSB = 7.8125 µV) regardless of the active hardware gain setting.
3. **Trimmed-Mean Filtering:** Out of 86 fast samples (representing a 100 ms window), the highest 6 and lowest 6 are discarded, and the remaining 74 samples are averaged to eliminate transient spikes and 50/60Hz mains hum.
4. **Conductance Conversion:** The filtered voltage is translated into physical skin conductance in nanosiemens (nS) using the TIA circuit equation.

Here is the core logic for writing the dynamic PGA configuration and reading the raw ADC conversion registers:

```c
// Configure the ADS1115 config register dynamically:
// - MUX = 000 (AIN0-AIN1 differential mode)
// - PGA = active PGA gain index (ranges from 0x80 to 0x8A dynamically)
// - MODE = 0 (Continuous conversion mode)
// - DR = 111 (860 samples per second)
uint8_t cfg[2] = { 0x80u | (active_pga << 1), 0xE3 }; 
furi_hal_i2c_write_mem(&furi_hal_i2c_handle_external, ADS1115_I2C_ADDR, ADS1115_CONFIG_REG, cfg, 2, 50);

// Read the raw 16-bit differential conversion value
uint8_t data[2];
furi_hal_i2c_read_mem(&furi_hal_i2c_handle_external, ADS1115_I2C_ADDR, ADS1115_CONV_REG, data, 2, 50);
int16_t hw_val = (int16_t)((data[0] << 8) | data[1]);
```

### Challenge: SD Card Lag
Writing data to the Flipper's SD card takes a few milliseconds. If we write our GPS and GSR data to the card every single time we measure it, the app will freeze up.

**The Solution:** The 1-Second Buffer.
Your hardware timing code will run **10 times every second**. It will store those 10 readings in a temporary memory variable. Once a full second has passed, the app grabs the most recent GPS coordinate, averages the 10 GSR readings, and writes *one* single string to the SD card.

---

## 4a. GPS Error Recovery via PCAS Commands

The L76K GPS runs continuously — it cannot be put to sleep via software. The L76K uses Quectel's **PCAS** protocol. The only software control available is sending reset commands over UART to recover from a GPS hang or force a fresh satellite lock.

```c
// Helper — send a PCAS command over the GPS UART
static void gps_send_pcas(const char* cmd) {
    furi_hal_uart_tx(FuriHalUartIdLPUART1, (uint8_t*)cmd, strlen(cmd));
}
```

### Reset Commands

| Action | Command | When to use |
|---|---|---|
| **Hot Start** | `$PCAS10,0*1C\r\n` | GPS is outputting stale/frozen data — restarts quickly using cached satellite info |
| **Factory Reset** | `$PCAS10,3*1F\r\n` | GPS is completely hung or unresponsive — clears everything and starts fresh |

```c
// GPS outputting stale data — hot restart, keeps satellite cache for fast re-lock:
gps_send_pcas("$PCAS10,0*1C\r\n");

// GPS completely hung — factory reset, clears all data:
gps_send_pcas("$PCAS10,3*1F\r\n");
```

---

## 5. Signal Processing: Finding Mountains and Valleys

Raw differential voltage numbers reflect your baseline sweat levels. We only care about **sudden changes** (spikes in arousal or drops into relaxation). 

To find this, we use two math concepts operating on the 10 Hz data stream:

1. **Smoothing (Exponential Moving Average):** Raw electrical data is noisy. We smooth it out.
   `Smoothed_Value = (0.2 * Raw_Value) + (0.8 * Previous_Smoothed_Value)`
2. **Derivative (Rate of Change):** We subtract the previous smoothed value from the current smoothed value.
   `Rate_of_Change = Smoothed_Value - Previous_Smoothed_Value`

In our TIA setup:
* **Stress Response (Resistance Drops):** Skin conductance increases, pushing more current through the feedback resistor. `V_out` rises, making the differential read increase. `Rate_of_Change` goes heavily positive. We scale this into a **positive elevation** (Mountain).
* **Relaxation (Resistance Climbs):** Current drops, `V_out` falls closer to `V_ref`. `Rate_of_Change` goes negative. We scale this to represent **negative elevation** (Valley).

---

## 6. The GPX File Export

When the user presses "Record", the app creates a file named `biomap_walk.gpx` on the SD card.

Instead of traditional elevation, we inject our processed `Rate_of_Change` math into the XML elevation `<ele>` tag. We multiply it by a scaling factor so the topography looks impressive on a map.

**The resulting file structure looks like this:**
```xml
<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="FlipperZero BioMapping">
  <trk>
    <name>Stress & Relaxation Walk</name>
    <trkseg>
      <!-- This point is flat baseline (Neutral) -->
      <trkpt lat="51.507200" lon="-0.127600">
        <ele>0.0</ele> 
        <time>2026-06-05T13:33:12Z</time>
      </trkpt>
      
      <!-- This point shows a massive stress spike (Arousal = Mountain) -->
      <trkpt lat="51.507250" lon="-0.127650">
        <ele>145.5</ele> 
        <time>2026-06-05T13:33:13Z</time>
      </trkpt>

      <!-- This point shows deep recovery (Relaxation = Valley) -->
      <trkpt lat="51.507300" lon="-0.127700">
        <ele>-60.2</ele> 
        <time>2026-06-05T13:33:14Z</time>
      </trkpt>
    </trkseg>
  </trk>
</gpx>
```

---

## 7. The User Interface

The Flipper's 128x64 black-and-white screen will be heavily utilized to give the user live feedback while walking.

* **Top Bar:** Shows the GPS lock status (a blinking satellite icon until the L76K module finds satellites) and the current speed.
* **The Graph:** A live, left-scrolling line graph. A horizontal line runs through the middle of the screen representing zero change. As the user encounters stress, the line spikes upward. During deep relaxation, the line dips below the center.
* **Controls:**
  * `OK (Center Button)`: Starts and stops the GPX recording.
  * `Up/Down`: Zooms in and out on the graph so the user can scale the sensitivity of the spikes.
  * `Back`: Safely closes the `.gpx` file so it doesn't corrupt, and exits the app.
