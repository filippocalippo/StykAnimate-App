"""Strict Pivot 2/3 project payload reader.

The grammar follows Pivot 5's compatibility loaders, rather than searching for
plausible record boundaries. Native addresses below are preferred-base VAs:
0xAFFDEC (old figure), 0xAF68F4/0xAF82F8 (compact bitmap), 0x94144C
(old frame object), 0x94C79C (frame), 0xB11064 (v2 project).

Version 2 does not store timing or stable object IDs. Pivot supplies 13 FPS and
allocates a new ID for every occurrence. Version 3 stores frame holds and a
trailing millisecond interval. Holds are repetitions, never tween interpolation.
"""
from __future__ import annotations

import base64
import math
import struct
import zlib
from pathlib import Path
from typing import Any


class LegacyDecodeError(ValueError):
    """Malformed or explicitly unsupported legacy payload."""


class Reader:
    def __init__(self, data: bytes):
        self.data = data
        self.pos = 0
        self.bindings: dict[str, dict[str, Any]] = {}

    def take(self, n: int) -> bytes:
        if n < 0 or self.pos + n > len(self.data):
            raise LegacyDecodeError(f"Unexpected EOF at {self.pos}, need {n} bytes")
        result = self.data[self.pos:self.pos+n]
        self.pos += n
        return result

    def read(self, fmt: str, pointer: str | None = None):
        at = self.pos
        value = struct.unpack('<' + fmt, self.take(struct.calcsize('<' + fmt)))[0]
        if isinstance(value, float) and not math.isfinite(value):
            raise LegacyDecodeError(f"Non-finite {fmt} at {at}")
        if pointer is not None:
            self.bindings[pointer] = {'offset': at, 'format': fmt}
        return value

    def str8(self) -> str:
        return self.take(self.read('B')).decode('cp1252', errors='replace')


def _png_rgba(width: int, height: int, rgba: bytes) -> bytes:
    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (struct.pack('>I', len(payload)) + kind + payload +
                struct.pack('>I', zlib.crc32(kind + payload) & 0xffffffff))
    rows = b''.join(b'\0' + rgba[y*width*4:(y+1)*width*4] for y in range(height))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))


def _asset(blob: bytes, kind: str, name: str, assets_root, **metadata) -> dict:
    mime = {'png': 'image/png', 'bmp': 'image/bmp', 'jpeg': 'image/jpeg'}[kind]
    result = dict(metadata, kind=kind, name=name, mime_type=mime,
                  data_uri=f'data:{mime};base64,' + base64.b64encode(blob).decode('ascii'))
    if assets_root is not None:
        root = Path(assets_root)
        root.mkdir(parents=True, exist_ok=True)
        output = root / name
        output.write_bytes(blob)
        result['asset_path'] = str(output.resolve())
        result['asset_path_relative'] = name
    return result


def _compact_bitmap(r: Reader, name: str, assets_root=None) -> dict:
    """AF68F4: column-major 8-bit palette or 24-bit BGR pixels."""
    start = r.pos
    mode = r.read('B')
    width, height, key = r.read('H'), r.read('H'), r.read('I')
    if not 0 < width <= 32767 or not 0 < height <= 32767:
        raise LegacyDecodeError(f'Invalid compact bitmap dimensions at {start}')
    # Pixel buffers are bounded by the input before allocating RGBA output.
    indexed = mode == 3
    pixels = r.take(width * height * (1 if indexed else 3))
    palette = r.take(1024) if indexed else b''
    rgba = bytearray(width * height * 4)
    transparent = (key & 255, (key >> 8) & 255, (key >> 16) & 255)
    for x in range(width):
        for y in range(height):
            source = x * height + y
            if indexed:
                p = pixels[source] * 4
                red, green, blue = palette[p:p+3]
            else:
                p = source * 3
                blue, green, red = pixels[p:p+3]
            target = (y * width + x) * 4
            alpha = 0 if (red, green, blue) == transparent else 255
            rgba[target:target+4] = bytes((red, green, blue, alpha))
    result = _asset(_png_rgba(width, height, rgba), 'png', name, assets_root,
                    width=width, height=height, record_offset=start,
                    record_size=r.pos-start, legacy_pixel_mode=mode,
                    transparency_color_raw=key, pixel_layout='column_major',
                    pivot={'x': 0, 'y': height}, endpoint={'x': width, 'y': height})
    return result


def _bmp(r: Reader, name: str, assets_root=None) -> dict:
    start = r.pos
    if r.take(2) != b'BM':
        raise LegacyDecodeError(f'Expected BMP signature at {start}')
    size = r.read('I')
    if size < 26:
        raise LegacyDecodeError(f'Invalid BMP size at {start}')
    rest = r.take(size-6)
    blob = b'BM' + struct.pack('<I', size) + rest
    dib_size, = struct.unpack_from('<I', blob, 14)
    if dib_size == 12:
        width, height = struct.unpack_from('<HH', blob, 18)
    elif dib_size >= 40 and size >= 54:
        width, height = struct.unpack_from('<ii', blob, 18)
    else:
        raise LegacyDecodeError(f'Unsupported BMP DIB at {start}')
    if width <= 0 or height == 0:
        raise LegacyDecodeError(f'Unsupported BMP DIB at {start}')
    return _asset(blob, 'bmp', name, assets_root, width=width, height=abs(height),
                  record_offset=start, record_size=size)


def _jpeg(r: Reader, name: str, assets_root=None) -> dict:
    start = r.pos
    end = r.read('Q')
    if end <= r.pos:
        raise LegacyDecodeError(f'Invalid absolute JPEG end pointer at {start}')
    blob = r.take(end-r.pos)
    if not blob.startswith(b'\xff\xd8') or not blob.endswith(b'\xff\xd9'):
        raise LegacyDecodeError(f'Invalid JPEG boundaries at {start}')
    return _asset(blob, 'jpeg', name, assets_root, width=None, height=None,
                  record_offset=start, record_size=r.pos-start)


def _segment(r: Reader, figure_index: int, index: int, *, bind=True) -> dict:
    start = r.pos
    prefix = f'/figure_types/{figure_index}/segments/{index}' if bind else None
    def field(fmt, name):
        return r.read(fmt, None if prefix is None else prefix + '/' + name)
    parent = field('B', 'parent_id')
    sid = field('B', 'segment_id')
    ignored = r.read('H')
    length = field('f', 'length')
    angle = field('d', 'angle_rad')
    thickness = field('f', 'thickness')
    primitive = field('B', 'primitive_code')
    static = field('B', 'static_raw')
    padding = r.read('H')
    if primitive not in (0, 1, 2, 3, 4, 6):
        raise LegacyDecodeError(f'Unsupported old primitive {primitive} at {start+20}')
    if static not in (0, 1):
        raise LegacyDecodeError(f'Invalid static Boolean at {start+21}')
    kind = {0: 'line', 1: 'circle', 2: 'image', 3: 'circleFill', 4: 'circleClear', 6: 'squareLine'}[primitive]
    segment_type = 'circle' if primitive in (1, 3, 4) else ('image' if primitive == 2 else 'line')
    flags = (static << 8) | primitive
    return {
        'segment_order_index': index, 'segment_id': sid, 'parent_id': parent,
        'length': length, 'angle_rad': angle, 'thickness': thickness,
        'primitive_code': primitive, 'segment_type': segment_type, 'segment_kind': kind,
        'static_raw': static, 'is_static': bool(static), 'flags': flags,
        'flag_bits': {'is_static': bool(static), 'is_circle': primitive in (1, 3, 4),
                      'raw': flags, 'low_byte': primitive, 'high_byte': static},
        'color_rgb': [0, 0, 0], 'color_alpha': 1.0, 'transparency': 0,
        'bend_rad': 0.0, 'visible': primitive in (1, 2, 3, 4) or thickness > 0.01,
        'valid': True, 'z_order': index + 1, 'source_layout': 'legacy_24_native',
        'legacy_ignored_word': ignored, 'legacy_padding_word': padding,
        'record_offset': start, 'record_size': 24,
    }


def _figure(r: Reader, type_id: int, figure_index: int, assets_root=None, *, builtin=False) -> dict:
    start = r.pos
    count = r.read('B')
    if not count:
        raise LegacyDecodeError(f'Empty old figure at {start}')
    segments = []
    has_images = False
    for index in range(count):
        seg = _segment(r, figure_index, index, bind=not builtin)
        if seg['primitive_code'] == 2:
            has_images = True
            seg['image_asset_index'] = r.read('B')
            seg['sprite_index'] = seg['image_asset_index']
            # Compressed v2/v3 call AFFDEC with CL=1, omitting the image flip byte.
            seg['image_flip'] = 0
            seg['sprite_flip'] = 0
        segments.append(seg)
    images = []
    if has_images:
        image_count = r.read('B')
        for image_index in range(image_count):
            image = _compact_bitmap(r, f'figure_{type_id}_sprite_{image_index}.png', assets_root)
            image['image_index'] = image_index
            image['sprite_index'] = image_index
            images.append(image)
        for seg in segments:
            if seg['primitive_code'] == 2 and seg['image_asset_index'] >= image_count:
                raise LegacyDecodeError(f'Invalid sprite index in figure {type_id}')
    ids = [s['segment_id'] for s in segments]
    if len(set(ids)) != count or 0 in ids:
        raise LegacyDecodeError(f'Duplicate/root segment IDs in figure {type_id}')
    by_id = {s['segment_id']: s for s in segments}
    for seg in segments:
        visited = {seg['segment_id']}
        parent = seg['parent_id']
        while parent:
            if parent not in by_id or parent in visited:
                raise LegacyDecodeError(f'Invalid/cyclic parent graph in figure {type_id}')
            visited.add(parent)
            parent = by_id[parent]['parent_id']
    name = ('default_pivot2' if count == 10 else 'man') if builtin else r.str8()
    return {'figure_type_id': type_id, 'name': name, 'segment_count': count,
            'segments': segments, 'polyfills': [], 'bends': [], 'text_assets': [],
            'image_assets': images, 'has_side_table': has_images,
            'z_order_mode': 'record_order', 'record_offset': None if builtin else start,
            'record_size': 0 if builtin else r.pos-start, 'builtin': builtin}


def _builtin(version: int) -> dict:
    if version == 2:
        # Exact default_pivot2.stk geometry used by native legacy slot-1 remap.
        data = bytes.fromhex(
            '0a0001000000007042d221337f7cd912400000e04000000000'
            '0102000000001042d221337f7cd912400000e04001000000'
            '0103000000002042d221337f7cd902400000e04000000000'
            '0104000000002042182d4454fb21e93f0000e04000000000'
            '030500000000204266732d3852c100400000e04000000000'
            '040600000000204266732d3852c1f03f0000e04000000000'
            '00070000000048425e3855297a6aff3f0000e04000000000'
            '0008000000004842d221337f7cd9f23f0000e04000000000'
            '07090000000048425e3855297a6aff3f0000e04000000000'
            '080a000000004842d221337f7cd9f23f0000e04000000000')
    else:
        # V3 leaves native slot 1 in place (941492 skips the v2 remapping).
        # These values were independently read from native descriptor memory;
        # the shipped Legacy/man.stk is a different twelve-segment figure.
        values = [
            (0, 32., -1.5707963267948968, 14., 0, 0),
            (1, 32., -1.5707963267948968, 14., 0, 0),
            (2, 33., -1.5707963267948968, 14., 0, 0),
            (3, 20., 1.5707963267948966, 20., 1, 1),
            (2, 38., 2.356194490192345, 14., 0, 0),
            (2, 38., 0.7853981633974483, 14., 0, 0),
            (5, 40., 2.0943951023931957, 14., 0, 0),
            (6, 40., 1.0471975511965979, 14., 0, 0),
            (0, 50., 1.9634954084936207, 14., 0, 0),
            (0, 50., 1.1780972450961724, 14., 0, 0),
            (9, 50., 1.9634954084936207, 14., 0, 0),
            (10, 50., 1.1780972450961724, 14., 0, 0),
        ]
        data = bytes([len(values)]) + b''.join(
            struct.pack('<BBHfdfBBH', parent, i+1, 0, length, angle, thickness, primitive, static, 0)
            for i, (parent, length, angle, thickness, primitive, static) in enumerate(values))
    r = Reader(data)
    figure = _figure(r, 1, 0, builtin=True)
    figure['name'] = 'default_pivot2' if version == 2 else 'Default'
    if r.pos != len(data):
        raise LegacyDecodeError('Unexpected trailing bytes in built-in figure definition')
    # These records belong to a separate STK, so they have no PIV offset.
    for seg in figure['segments']:
        seg['record_offset'] = None
    return figure


def decode_v2(data: bytes, source_path: str = '', assets_root=None) -> dict:
    """Decode a decompressed v2 or v3 PIV payload; reject all unconsumed bytes."""
    r = Reader(data)
    version = r.read('B')
    if version not in (2, 3):
        raise LegacyDecodeError(f'Expected legacy PIV version 2/3, found {version}')
    has_background = r.read('B') if version == 2 else None
    if has_background not in (None, 0, 1):
        raise LegacyDecodeError('Invalid v2 background Boolean')
    width = r.read('I', '/canvas_width')
    height = r.read('I', '/canvas_height')
    if not width or not height:
        raise LegacyDecodeError('Canvas dimensions must be positive')
    backgrounds = []
    if version == 2 and has_background:
        marker = r.read('B')
        if marker != 0:
            raise LegacyDecodeError(f'Unsupported v2 background marker {marker}')
        asset = _bmp(r, 'background_1.bmp', assets_root)
        backgrounds.append(dict(asset, background_id=1, name='Background', image_assets=[dict(asset)]))
    if version == 3:
        slots = r.read('B')
        if not slots:
            raise LegacyDecodeError('Background table must include default slot 0')
        # AEFD3C immediately delegates every version below 5 to AEFF50:
        # v3 and v4 have exactly the same BMP/JPEG background grammar.
        for bg_id in range(1, slots):
            kind = r.read('B')
            if kind == 0:
                asset = _bmp(r, f'background_{bg_id}.bmp', assets_root)
            elif kind == 1:
                asset = _jpeg(r, f'background_{bg_id}.jpg', assets_root)
            else:
                raise LegacyDecodeError(f'Unsupported v3 background kind {kind}')
            name = r.str8()
            backgrounds.append(dict(asset, background_id=bg_id, name=name,
                                    legacy_kind=kind, image_assets=[dict(asset)]))
    figure_slots = r.read('B')
    if figure_slots < 2:
        raise LegacyDecodeError('Invalid legacy figure slot count')
    figures = [_builtin(version)]
    for type_id in range(2, figure_slots):
        figures.append(_figure(r, type_id, len(figures), assets_root))
    figures_by_id = {fig['figure_type_id']: fig for fig in figures}
    frame_start = r.pos
    frame_count = r.read('I')
    if frame_count > len(data) - r.pos:
        raise LegacyDecodeError('Frame count exceeds remaining payload')
    frames = []
    unique_id = 0
    for fi in range(frame_count):
        prefix = f'/keyframes/{fi}'
        duration = r.read('H', prefix + '/duration_raw') if version == 3 else 1
        background = r.read('B', prefix + '/background_id') if version == 3 else int(bool(has_background))
        if background > len(backgrounds):
            raise LegacyDecodeError(f'Unknown background {background} at frame {fi}')
        object_count = r.read('B')
        objects = []
        for oi in range(object_count):
            op = prefix + f'/objects/{oi}'
            offset = r.pos
            type_id = r.read('B')
            if type_id not in figures_by_id:
                raise LegacyDecodeError(f'Unsupported/unknown figure type {type_id} at {offset}')
            fig = figures_by_id[type_id]
            scale = r.read('f', op + '/scale')
            raw_color = r.read('I', op + '/color_override_raw')
            # Native +0x3c is an instance mirror flag (93C8BD XOR 1),
            # independent of each segment's asset index.
            image_text_flags = r.read('B', op + '/image_text_flags') if fig['image_assets'] else None
            angles = [r.read('d', op + f'/angles/{j}') for j in range(fig['segment_count'])]
            # Native 0x941620 substitutes special reset values from the figure.
            # Preserve fail-closed behavior until reset propagation is specified.
            if any(abs(angle) > 100 for angle in angles):
                raise LegacyDecodeError(f'Unsupported legacy angle-reset sentinel at frame {fi}, object {oi}')
            root_x, root_y = r.read('f', op + '/root_x'), r.read('f', op + '/root_y')
            unique_id += 1
            effective_color = raw_color if raw_color < 0x80000000 else 0
            obj = {'object_slot': oi, 'unique_id': unique_id, 'unique_id_source': 'generated_occurrence',
                   'figure_type_id': type_id, 'scale': scale, 'color_override_raw': raw_color,
                   'color_override_rgb': [effective_color & 255, effective_color >> 8 & 255, effective_color >> 16 & 255],
                   'color_override_alpha': 1.0, 'field28': 0, 'angles': angles,
                   'root_x': root_x, 'root_y': root_y, 'len_flag': 0, 'lengths': [],
                   'bend_flag': 0, 'bends': [], 'join': None, 'runtime_segments': [],
                   'record_offset': offset, 'record_size': r.pos-offset}
            if image_text_flags is not None:
                obj['image_text_flags'] = image_text_flags
            objects.append(obj)
        frames.append({'keyframe_index': fi, 'duration_raw': duration,
                       'duration_frames': max(1, duration), 'interpolation': 'hold',
                       'inbetweens': 0, 'duration_semantics': 'hold',
                       'background_mix': 0, 'background_id': background, 'background_id_b': None,
                       'objects': objects, 'object_draw_order': list(range(object_count)),
                       'camera': {'is_default': True, 'x': 0.0, 'y': 0.0, 'scale': 1.0}})
    frame_interval = r.read('I', '/frame_delay_ms') if version == 3 else None
    if version == 3 and not frame_interval:
        raise LegacyDecodeError('Zero legacy frame interval')
    fps = max(1, round(1000 / frame_interval)) if frame_interval else 13
    loop = None
    if version == 3 and len(data)-r.pos == 1:
        loop = r.read('B', '/legacy_tail_flag')
        if loop not in (0, 1):
            raise LegacyDecodeError('Invalid optional legacy trailing Boolean')
    if r.pos != len(data):
        raise LegacyDecodeError(f'Unexpected trailing bytes at {r.pos}: {len(data)-r.pos}')
    return {'source_path': str(source_path or ''), 'payload_size': len(data),
            'file_type': 'piv', 'format': f'piv_v{version}_legacy_exact',
            'version': version, 'decode_status': 'decoded', 'trace_assisted': False,
            'canvas_width': width, 'canvas_height': height, 'backgrounds': backgrounds,
            'figure_types': figures, 'keyframes': frames, 'fps': fps,
            'frame_delay_ms': frame_interval, 'legacy_tail_flag': loop,
            'fps_source': 'stored_millisecond_interval' if version == 3 else 'native_legacy_default',
            'trailing_bytes_hex': '', 'supports_viewer': True,
            'validation': {'exact_consumption': True, 'consumed_bytes': r.pos,
                           'frame_start': frame_start, 'object_count': unique_id},
            'limitations': ['v2/v3 do not store stable cross-frame object identities.'] if version == 3 else
                          ['v2 stores no frame rate; Pivot loads these projects at 13 FPS.',
                           'v2/v3 do not store stable cross-frame object identities.'],
            'notes': ['All record boundaries follow native compatibility grammar.',
                      'Old static flag is record byte 21; bytes 2/3 are ignored padding.',
                      'Frame durations repeat a pose without interpolation.'],
            '_bindings': r.bindings}


decode_payload = decode_v2
