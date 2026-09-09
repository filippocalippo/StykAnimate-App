"""Read-only, reproducible native Pivot export sampling evidence; no process launch."""
from pathlib import Path
import sys,json,hashlib,re
root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root.parent/'tools/research/vendor'))
import pefile,capstone
exe=root.parent/'Pivot Animator v5/pivot.exe'
sha=hashlib.sha256(exe.read_bytes()).hexdigest()
assert sha=='2c7911d3303cc28de2ac016c3f7575082aa47680e63a0fe8930ce8799de3df98'
pe=pefile.PE(str(exe),fast_load=True);base=pe.OPTIONAL_HEADER.ImageBase
md=capstone.Cs(capstone.CS_ARCH_X86,capstone.CS_MODE_32);md.skipdata=True
ranges={'image-choice':(0x9563cb,0x20),'image-2x-choice':(0x956552,0x22),'none-quality':(0x9566a6,0x36),
 'svg-disables-controls':(0x9562ac,0x34),'player-scale-and-size':(0x9514e6,0x11b),'2x-average':(0xaf401e,0x7d)}
regions={name:[f'{x.address:08x} {x.mnemonic} {x.op_str}' for x in md.disasm(pe.get_data(start-base,size),start)] for name,(start,size) in ranges.items()}
checks=[]
def check(name,ok):
 assert ok,name;checks.append(name)
check('Image option2 sets export player sample factor2',any('mov byte ptr [eax + 0x10], 2' in x for x in regions['image-2x-choice']))
check('Other image options set factor1',any('mov byte ptr [eax + 0x10], 1' in x for x in regions['image-2x-choice']))
check('No smoothing selects quality1, others quality2',any('mov esi, 1' in x for x in regions['none-quality']) and any('mov esi, 2' in x for x in regions['none-quality']))
check('SVG disables smoothing combo at published offset33c',any('[ebx + 0x33c]' in x for x in regions['svg-disables-controls']) and regions['svg-disables-controls'].count('009562d5 xor edx, edx')==1)
check('Native 2× downsampler sums four bytes and divides by4',sum('shr ebx, 2' in x for x in regions['2x-average'])==4)
choices=b'No Smoothing\x06\x0cSmooth Edges\x06\x0eSmooth Sprites\x00\tItemIndex\x02\x01'
check('Both native image/video menus default to smooth edges',bytes(pe.__data__).count(choices)==2)
out=root/'artifacts/native-static';out.mkdir(parents=True,exist_ok=True)
(out/'export-sampling.json').write_text(json.dumps({'executable':str(exe),'sha256':sha,'checks':checks,'regions':regions},indent=2))
print(json.dumps({'checks':checks,'sha256':sha},indent=2))

