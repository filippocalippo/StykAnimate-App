"""Quantify custom GIF pixels against the shipped FFmpeg CLI, not Pivot's older DLL."""
from pathlib import Path
import json
import subprocess
from PIL import Image, ImageChops, ImageStat, ImageFilter, ImageDraw

APP = Path(__file__).resolve().parents[1]
ROOT = APP / 'artifacts' / 'gif-dithering'
ENCODER = APP / 'build' / 'video-encoder' / 'ffmpeg.exe'
report = json.loads((ROOT / 'report.json').read_text())
results, rows = [], []


def run(arguments):
    return subprocess.run([str(ENCODER), '-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1', *arguments],
                          check=True, capture_output=True, timeout=20)


def white(image):
    result = Image.new('RGBA', image.size, 'white')
    result.alpha_composite(image.convert('RGBA'))
    return result.convert('RGB')


def mae(a, b):
    return sum(ImageStat.Stat(ImageChops.difference(a, b)).mean) / 3


for source in report['sources']:
    kind = Path(source['name']).stem
    size = source['width'], source['height']
    raw = bytearray((ROOT / source['name']).read_bytes())
    # Canvas draws clear hidden RGB for alpha-zero pixels before the worker reads
    # them; match that visible-source boundary for this codec-only comparison.
    for i in range(0, len(raw), 4):
        if raw[i + 3] == 0:
            raw[i:i + 3] = b'\0\0\0'
    original = Image.frombytes('RGBA', size, bytes(raw))
    source_path = ROOT / f'{kind}-ffmpeg-input.png'
    original.save(source_path)
    palette = ROOT / f'{kind}-ffmpeg-palette.png'
    run(['-y', '-i', str(source_path), '-vf', 'palettegen=stats_mode=full', '-frames:v', '1', str(palette)])
    originals = []
    for mode in ('off', 'on'):
        target = ROOT / f'{kind}-ffmpeg-{mode}.gif'
        run(['-y', '-i', str(source_path), '-i', str(palette), '-lavfi',
             'paletteuse=diff_mode=rectangle:dither=' + ('sierra2_4a' if mode == 'on' else 'none'),
             '-frames:v', '1', '-loop', '-1', str(target)])
        with Image.open(target) as image:
            reference = image.convert('RGBA')
        with Image.open(ROOT / f'{kind}-{mode}.gif') as image:
            custom = image.convert('RGBA')
        a, b, original_white = white(custom), white(reference), white(original)
        ab, bb = a.tobytes(), b.tobytes()
        changed = sum(ab[i:i + 3] != bb[i:i + 3] for i in range(0, len(ab), 3))
        results.append({'kind': kind, 'dither': mode,
                        'customVersusBundledMAE': mae(a, b), 'changedPixels': changed,
                        'changedPercent': changed * 100 / (size[0] * size[1]),
                        'binaryAlphaEqual': custom.getchannel('A').tobytes() == reference.getchannel('A').tobytes(),
                        'customSourceMAE': mae(a, original_white), 'bundledSourceMAE': mae(b, original_white),
                        'customBlur2MAE': mae(a.filter(ImageFilter.BoxBlur(2)), original_white.filter(ImageFilter.BoxBlur(2))),
                        'bundledBlur2MAE': mae(b.filter(ImageFilter.BoxBlur(2)), original_white.filter(ImageFilter.BoxBlur(2)))})
        originals.extend([a, b])
    rows.append((kind, *originals))

sheet = Image.new('RGB', (1056, 576), '#eeeeee')
draw = ImageDraw.Draw(sheet)
for col, label in enumerate(('Custom off', 'Bundled off', 'Custom Sierra Lite', 'Bundled Sierra Lite')):
    draw.text((col * 264 + 8, 8), label, fill='#202020')
for row, (kind, *images) in enumerate(rows):
    y = row * 182 + 32
    draw.text((8, y), kind, fill='#202020')
    for col, image in enumerate(images):
        sheet.paste(image.resize((256, 128), Image.Resampling.NEAREST), (col * 264 + 4, y + 18))
sheet.save(ROOT / 'ffmpeg-comparison.png')
version = subprocess.run([str(ENCODER), '-version'], check=True, capture_output=True, text=True, timeout=10).stdout.splitlines()[0]
output = {'encoder': version, 'metrics': results,
          'scope': 'Codec comparison uses identical canvas-compatible RGBA and options with bundled FFmpeg 7.1. Pivot uses FFmpeg 4.4, so this is not a native Pivot pixel oracle.'}
(ROOT / 'ffmpeg-comparison.json').write_text(json.dumps(output, indent=2))
print(json.dumps(output, indent=2))
