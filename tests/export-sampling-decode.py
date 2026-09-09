"""Decode all actual sampled GIF/APNG and ZIP sequence files from the browser test."""
from pathlib import Path
from PIL import Image,ImageChops
import io,json,zipfile
folder=Path(__file__).resolve().parents[1]/'artifacts/export-sampling'
checks=[];pixels={}
def check(name,ok):
 assert ok,name; checks.append(name)
for mode in ['edges','none','sprites']:
 for fmt in ['gif','apng']:
  with Image.open(folder/f'{fmt}-{mode}.{fmt}') as image:
   check(f'{fmt} {mode} decodes exactly3 frames at128×96',image.n_frames==3 and image.size==(128,96))
   frames=[]
   for i in range(3):image.seek(i);frames.append(image.convert('RGBA').copy())
   check(f'{fmt} {mode} retains movement in encoded frames',ImageChops.difference(frames[0],frames[2]).getbbox() is not None)
 for fmt in ['png','jpeg','gif','svg']:
  with zipfile.ZipFile(folder/f'{fmt}-sequence-{mode}.zip') as archive:
   names=[name for name in archive.namelist() if name!='animation.json'];check(f'{fmt} {mode} has3 numbered entries',len(names)==3 and names==sorted(names))
   if fmt=='svg':
    check(f'SVG {mode} embeds sprite data and stays vector-independent',all(b'data:image/' in archive.read(name) and b'shape-rendering="crispEdges"' not in archive.read(name) for name in names))
   else:
    frames=[Image.open(io.BytesIO(archive.read(name))).convert('RGBA') for name in names]
    check(f'{fmt} {mode} decodes requested dimensions',all(image.size==(128,96) for image in frames))
    if fmt=='png':pixels[mode]=frames[0]
for a,b in [('edges','sprites'),('none','sprites')]:
 check(f'Encoded PNG preserves sampling difference {a} vs {b}',ImageChops.difference(pixels[a],pixels[b]).getbbox() is not None)
(folder/'decoded.json').write_text(json.dumps({'checks':checks},indent=2));print(json.dumps({'checks':len(checks)}))

