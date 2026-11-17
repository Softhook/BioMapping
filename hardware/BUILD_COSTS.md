# Building the boards: options and costs

Rough costs for getting the Flipper and Cardputer boards made. Prices were checked in November 2026 and change often, so treat them as a guide and get real quotes before ordering.

## What is on each board

Almost every part is surface-mount (soldered onto the face of the board):

| Parts | Package | Notes |
|---|---|---|
| Resistors and capacitors | 0805 (2.0 × 1.25 mm) | Standard pads |
| U1 op-amp (OPA2333) | SOIC-8 | Easy with an iron |
| U2 ADC (ADS1115) | MSOP-10 | Pins 0.5 mm apart: fiddly by hand, fine with flux and a fine tip |
| U3 regulator (Cardputer only) | SOT-23-5 | |
| BT1 backup cell (MS421R) | Reflow-solderable, 4.8 mm | Goes through the oven like any other part |
| D1 diode | SOD-323 | |
| U4 GPS (SAM-M10Q) | Pads underneath | Needs an oven, hotplate or hot air |
| J2 cuff socket | Surface-mount JST PH | |

Only the angled pin headers are through-hole (J1, plus J4 on the Flipper). They hold the board in place, so they stay through-hole for strength. Assemblers fit them for a small extra fee.

Each board's `bom.csv` gives the maker's part number and the LCSC number for every part.

## Choosing pads to suit the build

The boards use standard pads throughout, set up for machine assembly. To build by hand instead, switch to KiCad's hand-soldering pads (`..._HandSolder` versions of the 0805, SOD-323 and SAM-M8Q footprints) in `pcbtools/schematic.py` and rerun `./pcb build`.

## Option 1: UK assembler

For a first batch of **5 boards**, expect roughly **£350–£700 in total, or £70–£140 per board**.

| Item | Rough cost |
|---|---|
| One-off setup (solder stencil, machine programming, first-board inspection) | £150–£350 |
| Bare 2-layer boards, 5 off | £30–£130 |
| Parts, per board | £20–£30 |
| Fitting the through-hole headers | £10–£40 |

The setup charge is the same whether you order 5 boards or 100, so it dominates a small batch. At 50 boards the price might drop to around £30–£40 per board.

Ask each assembler to list stencil, setup, testing and through-hole fitting separately, as these are where quotes differ most.

## Option 2: Chinese assembly service (for example JLCPCB)

Often **£60–£150 for 5 assembled boards** including postage, plus UK import VAT. It's cheaper than a UK assembler, but you have less control, and the GPS chip may not be in their stock.

## Option 3: Build them yourself

- Parts: about **£25 per board**
- Bare boards: **£10–£30** for 5
- A hotplate or hot-air tool for the GPS chip: **£30–£60**, if you don't already have one

## Parts cost

| Part | Approximate price, one off |
|---|---|
| SAM-M10Q GPS | about £11 + VAT (Digi-Key UK) |
| ADS1115 | a few pounds |
| Everything else (about 20 parts) | a few pounds in total |

The GPS chip is the main cost, and stock is patchy: several suppliers show none, and some listings quote 16-week lead times. Check stock first, and consider buying the chips yourself and sending them to the assembler.

## Things to raise with an assembler

- **Backup cell (BT1).** The MS421R is made to go through the soldering oven, but LCSC doesn't stock it, so for JLCPCB buy it yourself (Farnell 3534555) and send it with the GPS modules. Without it the GPS still works, but takes longer to find its position after power-up.
- **GPS module soldering.** u-blox gives a soldering profile and warns against washing the board with water, alcohol or an ultrasonic cleaner afterwards. Pass this on (see `docs/datasheets/sam-m10q_integrationmanual.pdf`).
- **Through-hole headers.** Usually soldered by hand and charged by the minute.

## Suggested order

1. Order the **Flipper board** first. It is closest to the working hand-soldered prototype.
2. Build one and compare it with the prototype on a walk.
3. Before ordering the **Cardputer board**, measure a real Cardputer: header height, which socket row is which, and the screw hole positions (see "Check before ordering (Cardputer)" in [README.md](README.md)).

## Sources

- [Altimex: How much does PCB assembly cost?](https://altimex.co.uk/blog/how-much-does-pcb-assembly-cost/)
- [RayPCB: PCB assembly cost guide](https://www.raypcb.com/what-affect-pcb-assembly-cost/)
- [Fast Turn PCBs: assembly cost breakdown](https://www.fastturnpcbs.com/blog/pcb-assembly-cost-breakdown/)
- [ApplePCB: prototype assembly cost](https://www.applepcb.com/how-much-does-prototype-pcb-assembly-cost)
- [PCB Panel: UK bare-board prices](https://www.pcbpanel.co.uk/)
- [Digi-Key UK: SAM-M10Q-00B](https://www.digikey.co.uk/en/products/detail/u-blox/SAM-M10Q-00B/16672678)
- [Richardson RFPD: SAM-M10Q-00B](https://shop.richardsonrfpd.com/Products/Product/SAM-M10Q-00B-CT)
- [LCSC: SAM-M10Q-00B](https://www.lcsc.com/product-image/C5443880.html)
- [Digi-Key FR: SAM-M10Q-00B (lead time)](https://www.digikey.fr/en/products/detail/u-blox/SAM-M10Q-00B/16672680)
