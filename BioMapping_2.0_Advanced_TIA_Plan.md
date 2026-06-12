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
* **1x MCP6002** (or equivalent 3.3V rail-to-rail Dual Op-Amp)

**Passive Components (1% tolerance metal film recommended):**
* **1x 56kΩ Resistor** (For the voltage divider)
* **1x 10kΩ Resistor** (For the voltage divider)
* **1x 47kΩ Resistor** (For the TIA gain/feedback)
* **2x 100kΩ Resistors** (For safety inline with the electrodes)
* **2x 100nF (0.1µF) Ceramic Capacitors** (One for power bypass, one for the feedback filter)

**Biometric Interface:**
* **GSR Finger Electrodes:** Standard biometric finger clips or simple velcro strips with aluminum foil/copper tape.

---

## 3. The Wiring Guide & Hardware Surgery (Step-by-Step)

Because the Flipper's native hardware I2C pins (15 & 16) are hijacked by the L76K GPS board for Standby/Reset functions, we must perform minor "hardware surgery" to reclaim them for our ADS1115 sensor, and reroute the GPS controls to free pins.

### Phase 1: Freeing the I2C Bus (Trace Cuts)
1. **Locate the target:** Look at the PCB right next to **Pin 15 (PC1)** and **Pin 16 (PC0)**. Find the two small copper traces running from those pins toward the silver L76K module.
2. **Make the cut:** Use a sharp hobby knife to cut deeply across those traces, completely severing the copper connection. 
3. **Verify:** Use a multimeter in continuity mode. Pin 15 and Pin 16 should no longer have an electrical connection to the GPS module.

### Phase 2: Rerouting the GPS Controls
1. Locate the exposed **RESET** and **STANDBY** pads on the edges of the silver L76K module.
2. Solder a tiny jumper wire from the **STANDBY pad** to **Pin 6 (PB2)**.
3. Solder a tiny jumper wire from the **RESET pad** to **Pin 7 (PC3)**.

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

* **Generate the 0.5V Bias (V_ref) using Op-Amp A:**
  * Solder the **56kΩ Resistor** from 3.3V to MCP6002 Pin 3 (In+ A).
  * Solder the **10kΩ Resistor** from MCP6002 Pin 3 (In+ A) to GND.
  * Tie MCP6002 Pin 1 (Out A) directly to Pin 2 (In- A).
  * *Result: Pin 1 is now a rock-solid, buffered 0.5V Reference.*

* **Build the Transimpedance Amplifier (TIA) using Op-Amp B:**
  * Connect your V_ref (Pin 1) to MCP6002 Pin 5 (In+ B).
  * Tie the **47kΩ Resistor** and the second **100nF Capacitor** in parallel between Pin 7 (Out B) and Pin 6 (In- B). This acts as both the amplifier gain and a hardware low-pass filter to destroy 50/60Hz mains hum.

* **Connect Electrodes & Safety Resistors:**
  * Electrode 1 (GND): GND -> **100kΩ Resistor** -> Wire -> Foil/Finger 1.
  * Electrode 2 (SIGNAL): Foil/Finger 2 -> Wire -> **100kΩ Resistor** -> MCP6002 Pin 6 (In- B).
  * *These resistors ensure maximum skin current is capped at a completely safe 33 µA.*

* **Differential Connection to ADS1115:**
  * Connect **ADS1115 AIN0** to MCP6002 Pin 7 (Out B) (The amplified GSR signal).
  * Connect **ADS1115 AIN1** to MCP6002 Pin 1 (Out A) (The clean 0.5V V_ref).

By routing the signals this way, the ADS1115 subtracts the 0.5V virtual ground offset perfectly, isolating the amplified skin current data while completely rejecting external system noise!

---

## 4. Software Architecture

Writing this app in C is highly efficient with the ADS1115 in differential mode. We configure the ADS1115 to measure the exact difference between A0 and A1.

### Reading the ADS1115 via Hardware I2C
Your C code will use the Flipper's native I2C API to communicate with the ADS1115. Here is the core logic for your 10 Hz measurement loop:

```c
// 1. Tell the Flipper where the GPS controls moved to
furi_hal_gpio_init(&gpio_ext_pc3, GpioModeOutputPushPull, GpioPullNo, GpioSpeedLow); // RESET on Pin 7
furi_hal_gpio_init(&gpio_ext_pb2, GpioModeOutputPushPull, GpioPullNo, GpioSpeedLow); // STANDBY on Pin 6

// 2. Read the ADS1115 via Hardware I2C (Runs 10x per second)
uint8_t address = 0x48 << 1; // Flipper shifts I2C addresses by 1 bit
uint8_t reg_read[2];

// Ask the ADS1115 for the latest DIFFERENTIAL voltage between A0 and A1
// Ensure your config register is set to MUX = 000 (AINP = AIN0 and AINN = AIN1)
// Set the PGA (Programmable Gain Amplifier) to +/- 2.048V for maximum GSR resolution
furi_hal_i2c_read_mem(&furi_hal_i2c_handle_external, address, CONVERSION_REGISTER, reg_read, 2, 100);

// Combine the two bytes into a pristine 16-bit biometric number
int16_t differential_voltage = (reg_read[0] << 8) | reg_read[1];
```

### Challenge: SD Card Lag
Writing data to the Flipper's SD card takes a few milliseconds. If we write our GPS and GSR data to the card every single time we measure it, the app will freeze up.

**The Solution:** The 1-Second Buffer.
Your hardware timing code will run **10 times every second**. It will store those 10 readings in a temporary memory variable. Once a full second has passed, the app grabs the most recent GPS coordinate, averages the 10 GSR readings, and writes *one* single string to the SD card.

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
