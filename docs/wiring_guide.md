# GSR TransImpedance Circuit — Wiring Guide

![BioMapping 2 TIA GSR circuit schematic — power-supply bypass, 0.5 V reference buffer (op-amp B), transimpedance amplifier (op-amp A), and differential connection to the ADS1115 over the Flipper I²C bus.](gsr_circuit.png)

## Phase 1: The I2C Bus

The SAM-M10Q connects via UART, leaving Pin 15 / Pin 16 free for the ADS1115 I²C bus.

* Pin 15 (PC1) — I2C **SDA**
* Pin 16 (PC0) — I2C **SCL**

## Phase 2: GPS Wiring

No wiring beyond UART TX/RX and 3.3V/GND.

## Phase 3: Installing the Biometric Sensor Circuit

Mount the ADS1115 and the dual op-amp onto the Flipper Zero Prototyping Board. Both op-amp channels are used — one as a voltage follower for V_ref, one as the TIA.

**Standard 8-pin dual op-amp pinout** (MCP602, MCP6002, MCP6042, and equivalents):
```
Pin 1 = Out A     Pin 8 = 3.3V
Pin 2 = In- A     Pin 7 = Out B
Pin 3 = In+ A     Pin 6 = In- B
Pin 4 = GND       Pin 5 = In+ B
```

* **Power & I2C (ADS1115):**
  * `VDD` -> **Pin 9 (3.3V)**
  * `GND` -> **Pin 8 (GND)**
  * `ADDR` -> **Pin 8 (GND)** *(hardcodes the I2C address to 0x48)*
  * `SDA` -> **Pin 15 (PC1)**
  * `SCL` -> **Pin 16 (PC0)**

* **Power & bypass (dual op-amp):**
  * Pin 8 -> **Pin 9 (3.3V)**
  * Pin 4 -> **Pin 8 (GND)**
  * **Mandatory:** solder one **100nF capacitor** directly across Pin 8 and Pin 4 to filter digital power spikes from the Flipper.

* **Generate the 0.5V bias (V_ref) with Op-Amp B (voltage follower):**
  * **56kΩ** from 3.3V to In+ B (pin 5).
  * **10kΩ** from In+ B (pin 5) to GND.
  * Tie Out B (pin 7) directly to In- B (pin 6).
  * *Pin 7 is now a buffered 0.5V reference (V_ref).*

* **Build the TIA with Op-Amp A:**
  * Connect V_ref (from Out B) to In+ A (pin 3).
  * Tie the **47kΩ** and the second **100nF capacitor** in parallel between Out A (pin 1) and In- A (pin 2). This is both the amplifier gain and a hardware low-pass filter against 50/60 Hz mains hum.

* **Connect electrodes & safety resistors:**
  * Electrode 1 (GND): GND -> **4.7kΩ** -> wire -> foil/finger 1.
  * Electrode 2 (signal): foil/finger 2 -> wire -> **4.7kΩ** -> In- A (pin 2).
  * *These resistors (9.4 kΩ total) keep skin current safe while holding the TIA output within ADC range across the span of human skin resistance.*

* **Differential connection to ADS1115:**
  * **AIN0** -> Out A (pin 1) — the amplified GSR signal.
  * **AIN1** -> Out B (pin 7) — the clean 0.5V V_ref.

The ADS1115 subtracts the 0.5V virtual-ground offset, isolating the amplified skin-current data while rejecting system noise.
