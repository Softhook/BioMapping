"""Draw docs/error.svg (the README's GSR error graph) from a reference sweep.

Usage, from the repo root:
    python3 scripts/make_error_svg.py [docs/reference_test_resultsN.csv]

Defaults to the newest docs/reference_test_results*.csv. The sweep must
have the usual 20 resistors, 10 kΩ to 9 MΩ. Point colours: green up to
0.2 %, blue up to 0.5 %, amber up to 1 %, red above. The green zone runs
from the 10 kΩ point to the 1 MΩ point. If the zone limits change, update
the README's accuracy zones to match.
"""
import csv, glob, os, re, sys
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D=os.path.join(ROOT,"docs")+os.sep
def _newest():
    files=glob.glob(D+"reference_test_results*.csv")
    return max(files,key=lambda f:int(re.search(r"(\d*)\.csv$",f).group(1) or 1))
SRC=sys.argv[1] if len(sys.argv)>1 else _newest()
rows=[r for r in csv.reader(open(SRC,encoding="utf-8")) if len(r)>=4 and r[1].isdigit()]
pts=[(r[0].replace(" kΩ","k").replace(" MΩ","M"), (float(r[2])-float(r[1]))/float(r[1])*100) for r in rows]
# x position on a true log scale: 10 kΩ at x=30, 9 MΩ at x=755
import math
R=[1e9/float(r[1]) for r in rows]
_lo,_hi=math.log10(1e4),math.log10(9e6)
X=[round(30+(math.log10(v)-_lo)/(_hi-_lo)*725,1) for v in R]
Y0,PX=260,80
def y(e): return Y0-e*PX
assert len(pts)==20, f"expected 20 resistors, got {len(pts)}"
first=open(SRC,encoding="utf-8").readline().strip()
m=re.search(r"on (.+?) \((.+)\)",first)
subtitle=(f"Reference sweep {m.group(1)} ({m.group(2).split(':')[0]})" if m else "Reference sweep")+", 0.1 % resistors from 10 kΩ to 9 MΩ"
def colour(e):
    a=abs(e)
    if a<=0.2: return "#16a34a","#15803d"
    if a<=0.5: return "#2563eb","#1e293b"
    if a<=1.0: return "#d97706","#b45309"
    return "#dc2626","#b91c1c"
grid=[(3.0,""),(2.0,""),(1.0,""),(0.5,""),(0.2,""),(-0.5,"")]
o=[]
o.append('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 450" style="background: #ffffff; font-family: system-ui, -apple-system, sans-serif;">')
o.append('  <rect width="900" height="450" fill="#ffffff" />')
o.append('  <text x="50" y="40" fill="#1e293b" font-size="18" font-weight="700">BioMapping 2.0 — Measurement Error (%) Across Resistance Range</text>')
o.append(f'  <text x="50" y="65" fill="#64748b" font-size="12">{subtitle}</text>')
o.append('  <g transform="translate(80, 95)">')
o.append('    <g stroke="#e2e8f0" stroke-width="1">')
for e,_ in grid: o.append(f'      <line x1="0" y1="{y(e):g}" x2="760" y2="{y(e):g}" stroke-dasharray="4" />')
o.append(f'      <line x1="0" y1="{Y0}" x2="760" y2="{Y0}" stroke="#cbd5e1" stroke-width="2" />')
o.append('    </g>')
o.append('    <g fill="#64748b" font-size="11" text-anchor="end">')
for e in [3.0,2.0,1.0,0.5,0.2,0.0,-0.5]: o.append(f'      <text x="-12" y="{y(e)+4:g}">{e:.1f}%</text>')
o.append('    </g>')
# primary zone: 10k to 1M
x0,x1=X[0],X[13]  # zone edges sit on the 10 kΩ and 1 MΩ points
o.append(f'    <rect x="{x0}" y="-10" width="{x1-x0}" height="335" fill="#16a34a" fill-opacity="0.12" stroke="#15803d" stroke-dasharray="4" stroke-width="1" stroke-opacity="0.4" />')
o.append(f'    <text x="{(x0+x1)/2:g}" y="10" fill="#14532d" font-size="11" font-weight="700" text-anchor="middle">Primary Zone: 10 kΩ – 1 MΩ (≤ ±0.2% Error)</text>')
d=" ".join(("M" if i==0 else "L")+f" {X[i]},{y(e):.1f}" for i,(_,e) in enumerate(pts))
o.append(f'    <path d="{d}" fill="none" stroke="#2563eb" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />')
o.append('    <g font-size="10" font-weight="500" fill="#1e293b">')
show={"10k","47k","1M","3.3M","9M"}
for i,(name,e) in enumerate(pts):
    fill,txt=colour(e)
    cy=y(e)
    label=name+(" (" + ("+" if e>0 else "") + f"{e:.2f}%)" if name in show else "")
    if name=="9M": label=f"9MΩ (+{e:.1f}%)"
    above = (i%2==0) if i<14 else True
    if name=="4.7M": above=False
    ty = cy-10 if above else cy+20
    bold=' font-weight="700"' if name in ("47k","9M") else ""
    o.append(f'      <!-- {name} ({e:+.2f}%) -->')
    o.append(f'      <circle cx="{X[i]}" cy="{cy:.1f}" r="4.5" fill="{fill}" /><text x="{X[i]}" y="{ty:.1f}" text-anchor="middle" fill="{txt}"{bold}>{label}</text>')
o.append('    </g>')
o.append('    <line x1="0" y1="325" x2="760" y2="325" stroke="#64748b" stroke-width="1.5" />')
o.append('  </g>')
o.append('</svg>')
open(D+"error.svg","w",encoding="utf-8").write("\n".join(o)+"\n")
print("wrote", D+"error.svg", "from", os.path.relpath(SRC,ROOT))
