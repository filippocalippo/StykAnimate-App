"""Independently decode downloads produced by the actual app's export buttons."""
from pathlib import Path
from PIL import Image
import io,json,zipfile
folder=Path(__file__).resolve().parents[1]/'artifacts/export-sampling-app'
checks=[]
def check(name,ok):
 assert ok,name
 checks.append(name)
def centroid(image):
 image=image.convert('RGBA'); values=image.getchannel('A').tobytes(); weight=sum(values)
 return sum((i%image.width)*a for i,a in enumerate(values))/weight
def partial(image):
 return sum(0<a<255 for a in image.convert('RGBA').getchannel('A').tobytes())
for mode in ['edges','none','sprites']:
 with Image.open(folder/f'line-{mode}.png') as image:
  check(f'{mode} root PNG dimensions and coverage decode',image.size==(128,96) and ((partial(image)==0)==(mode=='none')))
 with Image.open(folder/f'line-{mode}.apng') as image:
  frames=[]
  for i in range(image.n_frames):image.seek(i);frames.append(image.convert('RGBA').copy())
  check(f'{mode} root APNG decodes three moving frames',len(frames)==3 and abs(centroid(frames[2])-centroid(frames[0])-8)<1)
with Image.open(folder/'working-draft.png') as draft,Image.open(folder/'stored-animation.apng') as stored:
 check('Current still is40px beyond stored animation pose',abs(centroid(draft)-centroid(stored)-40)<1)
 with zipfile.ZipFile(folder/'stored-frames.zip') as archive:
  names=sorted(n for n in archive.namelist() if n.endswith('.png'))
  frames=[Image.open(io.BytesIO(archive.read(n))).convert('RGBA') for n in names]
  check('PNG sequence contains three stored poses and excludes working draft',len(frames)==3 and abs(centroid(frames[0])-centroid(stored))<.001 and abs(centroid(frames[2])-centroid(frames[0])-8)<1)
with Image.open(folder/'sprite-none.png') as sprite:
 check('No smoothing downloaded sprite has binary geometry coverage',partial(sprite)==0)
check('Root SVG download remains vector geometry',(folder/'line.svg').read_text(encoding='utf-8').find('<path')>=0)
(folder/'decoded.json').write_text(json.dumps({'checks':checks},indent=2),encoding='utf-8')
print(json.dumps({'checks':len(checks)}))
