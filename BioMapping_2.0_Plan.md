# BioMapping 2.0 
# Christian Nold 2026

The Complete Build & Software Guide (ADS1115 Wheatstone Edition)

## 1. Introduction: What is BioMapping 2.0?
BioMapping 2.0 is a new version of Christian Nold's Bio Mapping project for the **Flipper Zero**. 
It allows you to walk through a city or landscape and record your body's physiological arousal responses mapped precisely to geographical coordinates. 

It translates your Galvanic Skin Response (GSR) fluctuations into **topographical elevation** within a GPX file. When you import your walk into Google Earth , your route will look flat while you were at your baseline, but "mountains" will appear where you experienced stress or arousal, and "valleys" or craters will map your deep relaxation.

This version of the guide utilises a dedicated 16-bit **ADS1115** Analog-to-Digital Converter combined with a **Wheatstone Bridge** circuit and an active hardware 5Hz noise filter to remove muscle noise and mains 50Hz hum.

---

## 2. Hardware Requirements
To build this, you need the following physical components:
* **Flipper Zero**
* **L76K GNSS Prototyping Shield:** Gives you a pre-wired GPS module alongside a blank 126-hole grid to build your custom circuit.
* **ADS1115 Breakout Board:** A high-precision 16-bit I2C ADC chip.
* **3x 100kΩ Precision Resistors (1% or 0.1% tolerance metal film):** Used to create a highly stable Wheatstone Bridge.
* **1x 0.33 µF (or 330 nF) Metallized Polypropylene Film Capacitor:** Used to create the anti-aliasing hardware filter.
* **GSR Finger Electrodes:** You can buy standard biometric finger clips or use simple velcro strips with conductive fabric/copper tape.
* **Jumper wires, a hobby knife (X-Acto), and solder.**

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
Mount the ADS1115 onto the prototyping grid and wire it as follows:

* **Power & I2C:**
  * `VDD` on ADS1115 -> **Pin 9 (3.3V)**
  * `GND` on ADS1115 -> **Pin 8 (GND)**
  * `ADDR` on ADS1115 -> **Pin 8 (GND)** *(Hardcodes the I2C address to `0x48`)*
  * `SCL` on ADS1115 -> **Pin 15 (PC1)**
  * `SDA` on ADS1115 -> **Pin 16 (PC0)**

* **The Wheatstone Bridge (GSR Circuit):**
  * **Leg 1 (The Reference):**
    * Solder **R1 (100kΩ)** from **Pin 9 (3.3V)** to a blank row.
    * Solder **R2 (100kΩ)** from that same row to **Pin 8 (GND)**.
    * Wire the junction between R1 and R2 to the **A1** pin on your ADS1115.
  * **Leg 2 (The Sensor):**
    * Solder **R3 (100kΩ)** from **Pin 9 (3.3V)** to a different blank row.
    * Connect **Electrode 1** to that same blank row.
    * Connect **Electrode 2** to **Pin 8 (GND)**.
    * Wire the junction between R3 and Electrode 1 to the **A0** pin on your ADS1115.

* **The Hardware Low-Pass Filter (Anti-Aliasing):**
  * Solder your **1µF Ceramic Capacitor** directly between the **A0** pin and the **A1** pin on the ADS1115. This physically destroys 50/60Hz electromagnetic noise from city power lines before the ADC digitizes the signal.

---

## 4. Software Architecture

Writing this app in C is now streamlined thanks to the dedicated ADS1115 chip. By utilizing a Wheatstone Bridge, we will configure the ADS1115 to perform a **differential read** (measuring the difference between A0 and A1) rather than an absolute voltage read. 

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

Raw differential voltage numbers aren't very useful because everyone's baseline skin resistance is different depending on how much they sweat. We only care about **sudden changes** (spikes in arousal or drops into relaxation). 

To find this, we use two math concepts operating on the 10 Hz data stream:

1. **Smoothing (Exponential Moving Average):** Raw electrical data is noisy. We smooth it out.
   `Smoothed_Value = (0.2 * Raw_Value) + (0.8 * Previous_Smoothed_Value)`
2. **Derivative (Rate of Change):** We subtract the previous smoothed value from the current smoothed value.
   `Rate_of_Change = Smoothed_Value - Previous_Smoothed_Value`

Because our hardware uses a signed differential read, the math is perfectly symmetrical:
* **Stress Response (Resistance Drops):** `Rate_of_Change` goes negative. We multiply this by a negative scaling factor to invert it into a **positive elevation** (Mountain).
* **Relaxation (Resistance Climbs):** `Rate_of_Change` goes positive. We scale this appropriately to represent **negative elevation** (Valley).

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
