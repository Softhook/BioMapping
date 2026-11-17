"""Read an Eagle schematic or library (.sch / .lbr), such as SparkFun's open
hardware files, without Eagle. Used to find which parts SparkFun really fit
(e.g. the MS421R backup cell on GPS-21834) and to copy footprint pads.

  ./pcb eagle <file>                     every part: library, device, value, SparkFun PROD_ID
  ./pcb eagle <file> --nets REF [REF..]  the nets those parts sit on, with every pin on each
  ./pcb eagle <file> --package NAME      a footprint's pads and shapes (Eagle units: mm, y UP;
                                         flip y when copying into KiCad, where y points down)

Fetch SparkFun files with e.g.
  gh api repos/sparkfun/SparkFun_u-blox_SAM-M10Q/contents/Hardware/SparkFun_u-blox_SAM-M10Q.sch \\
         -H 'Accept: application/vnd.github.raw' > sam.sch
The files are outside data: keep them in their own folder."""
import sys
import xml.etree.ElementTree as ET

def parts(root):
    devs = {}
    for lib in root.iter("library"):
        for ds in lib.iter("deviceset"):
            for d in ds.iter("device"):
                for tech in d.iter("technology"):
                    attrs = {a.get("name"): a.get("value") for a in tech.findall("attribute")}
                    devs[(lib.get("name"), ds.get("name"), d.get("name"))] = (d.get("package"), attrs.get("PROD_ID", ""))
    for p in root.iter("part"):
        if p.get("library") in ("SparkFun-Aesthetics",) or p.get("deviceset") in ("GND", "3.3V", "5V", "VCC"):
            continue
        pkg, prod = devs.get((p.get("library"), p.get("deviceset"), p.get("device")), ("?", ""))
        print(f'{p.get("name"):10s} {p.get("deviceset")}{p.get("device")}  value={p.get("value")}  '
              f'package={pkg}  {prod}')

def nets(root, refs):
    for n in root.iter("net"):
        pins = [(p.get("part"), p.get("pin")) for p in n.iter("pinref")]
        if any(r in refs for r, _ in pins):
            print(n.get("name"), " ".join(f"{r}.{pin}" for r, pin in pins if not r.startswith(("GND", "SUPPLY"))))

def package(root, name):
    for pk in root.iter("package"):
        if pk.get("name") != name:
            continue
        for e in pk:
            if e.tag in ("smd", "pad"):
                print(e.tag, {k: e.get(k) for k in ("name", "x", "y", "dx", "dy", "drill", "rot", "layer") if e.get(k)})
            elif e.tag == "polygon":
                print("polygon layer", e.get("layer"), [(v.get("x"), v.get("y")) for v in e.findall("vertex")])
            elif e.tag in ("rectangle", "circle"):
                print(e.tag, dict(e.attrib))
        return
    sys.exit(f"no package {name}")

def main(path, nets_of=None, package_name=None):
    root = ET.parse(path).getroot()
    if nets_of:
        nets(root, set(nets_of))
    elif package_name:
        package(root, package_name)
    else:
        parts(root)
