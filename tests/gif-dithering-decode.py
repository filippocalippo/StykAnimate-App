"""Independent Pillow and GIF-container verification of actual worker exports."""
from pathlib import Path
from io import BytesIO
import json
import struct
import zipfile
from PIL import Image, ImageFilter, ImageChops, ImageStat, ImageDraw

ROOT = Path(__file__).resolve().parents[1] / 'artifacts' / 'gif-dithering'
checks, metrics = [], []


def check(name, condition):
    assert condition, name
    checks.append(name)


def opaque(image):
    image = image.convert('RGBA')
    background = Image.new('RGBA', image.size, 'white')
    background.alpha_composite(image)
    return background.convert('RGB')


def mae(a, b):
    return sum(ImageStat.Stat(ImageChops.difference(a, b)).mean) / 3


def container(data):
    assert data[:6] in (b'GIF87a', b'GIF89a')
    packed = data[10]
    offset = 13 + (3 * 2 ** ((packed & 7) + 1) if packed & 128 else 0)
    frames = []
    delay = None
    while data[offset] != 0x3b:
        marker = data[offset]
        offset += 1
        if marker == 0x21:
            label = data[offset]
            offset += 1
            if label == 0xf9:
                delay = struct.unpack_from('<H', data, offset + 2)[0] * 10
            while data[offset]:
                offset += 1 + data[offset]
            offset += 1
        elif marker == 0x2c:
            x, y, width, height, flags = struct.unpack_from('<HHHHB', data, offset)
            offset += 9
            if flags & 128:
                offset += 3 * 2 ** ((flags & 7) + 1)
            frames.append({'x': x, 'y': y, 'width': width, 'height': height,
                           'localPalette': bool(flags & 128), 'delayMs': delay})
            offset += 1  # LZW minimum code size
            while data[offset]:
                offset += 1 + data[offset]
            offset += 1
        else:
            raise AssertionError(f'Invalid GIF block {marker:x}')
    return {'globalColors': 2 ** ((packed & 7) + 1) if packed & 128 else 0,
            'frames': frames, 'loopExtension': b'NETSCAPE2.0' in data}


report = json.loads((ROOT / 'report.json').read_text())
rows = []
for source in report['sources']:
    kind = Path(source['name']).stem
    size = source['width'], source['height']
    original = Image.frombytes('RGBA', size, (ROOT / source['name']).read_bytes())
    expected_alpha = original.getchannel('A').point(lambda a: 255 if a >= 128 else 0)
    reference = opaque(original)
    outputs = {}
    for mode in ('off', 'on'):
        data = (ROOT / f'{kind}-{mode}.gif').read_bytes()
        parsed = container(data)
        with Image.open(BytesIO(data)) as gif:
            decoded = gif.convert('RGBA')
            check(f'{kind}/{mode}: one correctly sized frame', gif.n_frames == 1 and gif.size == size)
        check(f'{kind}/{mode}: exact binary alpha', decoded.getchannel('A').tobytes() == expected_alpha.tobytes())
        check(f'{kind}/{mode}: animation palette is global', parsed['globalColors'] == 256 and not parsed['frames'][0]['localPalette'])
        result = opaque(decoded)
        outputs[mode] = result
        metrics.append({'kind': kind, 'dither': mode, 'bytes': len(data),
                        'mae': mae(reference, result),
                        'blur2MAE': mae(reference.filter(ImageFilter.BoxBlur(2)), result.filter(ImageFilter.BoxBlur(2)))})
    if kind != 'grayscale':
        check(f'{kind}: dither changes quantization', outputs['off'].tobytes() != outputs['on'].tobytes())
    else:
        check('grayscale: 255 actual shades', len(set(outputs['off'].getchannel('R').tobytes())) == 255)
        check('grayscale: low quantization error', mae(reference, outputs['off']) < .01)
    rows.append((kind, reference, outputs['off'], outputs['on']))

data = (ROOT / 'movement.gif').read_bytes()
animation_container = parsed = container(data)
check('animation: one palette and three full frames', parsed['globalColors'] == 256 and len(parsed['frames']) == 3 and all(not f['localPalette'] and (f['width'], f['height']) == (192, 96) for f in parsed['frames']))
check('animation: 24fps cumulative delays', [f['delayMs'] for f in parsed['frames']] == [40, 40, 50])
check('animation: loop disabled', not parsed['loopExtension'])
decoded = []
with Image.open(BytesIO(data)) as gif:
    for i in range(gif.n_frames):
        gif.seek(i)
        decoded.append(gif.convert('RGBA').copy())
for i in (1, 2):
    difference = ImageChops.difference(decoded[i - 1].convert('RGB'), decoded[i].convert('RGB'))
    difference.paste((0, 0, 0), (101, 37, 115, 49))
    check(f'animation: unchanged exterior stable at frame{i + 1}', difference.getbbox() is None)

with zipfile.ZipFile(ROOT / 'sequence.zip') as archive:
    names = [f'frame-{i:06d}.gif' for i in range(1, 4)]
    check('sequence: three ordered filenames plus manifest', archive.namelist() == names + ['animation.json'])
    manifest = json.loads(archive.read('animation.json'))
    check('sequence: timing metadata intact', manifest['fps'] == 24 and manifest['totalFrames'] == 3)
    for name in names:
        data = archive.read(name)
        parsed = container(data)
        with Image.open(BytesIO(data)) as gif:
            check(name + ': one frame, no loop, correct dimensions', gif.n_frames == 1 and gif.size == (192, 96) and not parsed['loopExtension'])

sheet = Image.new('RGB', (792, 3 * 182 + 30), '#eeeeee')
draw = ImageDraw.Draw(sheet)
for column, label in enumerate(('Original', 'Dither off', 'Sierra Lite')):
    draw.text((column * 264 + 8, 8), label, fill='#202020')
for row, (kind, *images) in enumerate(rows):
    y = row * 182 + 32
    draw.text((8, y), kind, fill='#202020')
    for column, image in enumerate(images):
        sheet.paste(image.resize((256, 128), Image.Resampling.NEAREST), (column * 264 + 4, y + 18))
sheet.save(ROOT / 'contact-sheet.png')
result = {'checks': checks, 'metrics': metrics, 'animation': animation_container,
          'scope': 'Pillow independently decodes actual worker GIF files; quantization is not claimed pixel-identical to native FFmpeg.'}
(ROOT / 'decoded.json').write_text(json.dumps(result, indent=2))
print(json.dumps({'checks': len(checks), 'metrics': metrics}, indent=2))
