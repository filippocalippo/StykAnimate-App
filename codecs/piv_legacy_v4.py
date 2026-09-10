"""Strict Pivot 4 project reader.

The grammar follows Pivot 5.2's backward-compatible readers at native virtual
addresses AFFDEC (figure), AF87AC (sprite), 94144C (instance), 94C79C (frame)
and B10C14 (project). Offsets in bindings refer to the uncompressed payload.
No stream scanning or corpus-specific frame/figure boundaries are used.
"""
from __future__ import annotations

import base64
import math
from pathlib import Path
import struct
from typing import Any


_BUILTIN_VALUES = (
    (0,32.,-1.5707963267948968,14.,0,0),(1,32.,-1.5707963267948968,14.,0,0),
    (2,33.,-1.5707963267948968,14.,0,0),(3,20.,1.5707963267948966,20.,1,1),
    (2,38.,2.356194490192345,14.,0,0),(2,38.,0.7853981633974483,14.,0,0),
    (5,40.,2.0943951023931957,14.,0,0),(6,40.,1.0471975511965979,14.,0,0),
    (0,50.,1.9634954084936207,14.,0,0),(0,50.,1.1780972450961724,14.,0,0),
    (9,50.,1.9634954084936207,14.,0,0),(10,50.,1.1780972450961724,14.,0,0),
)
# Native slot 1 is initialized once and shared by project versions 3..5.
# It is NOT the different 12-segment figure in the shipped Legacy/man.stk.
# Values are independently captured in reports/native_builtin_type1.json.
_BUILTIN_MAN = bytes([12]) + b''.join(
    struct.pack('<BBHfdfBBH', parent, i + 1, 0, length, angle, thick, kind, static, 0)
    for i, (parent, length, angle, thick, kind, static) in enumerate(_BUILTIN_VALUES)
)


class Reader:
    def __init__(self, data: bytes):
        self.data = data
        self.pos = 0
        self.bindings: dict[str, dict[str, Any]] = {}

    def read(self, size: int) -> bytes:
        if size < 0 or self.pos + size > len(self.data):
            raise ValueError(f"Truncated Pivot 4 payload at byte {self.pos}: need {size} bytes")
        result = self.data[self.pos:self.pos + size]
        self.pos += size
        return result

    def value(self, fmt: str, path: str | None = None):
        start = self.pos
        value = struct.unpack('<' + fmt, self.read(struct.calcsize('<' + fmt)))[0]
        if fmt in ('f', 'd') and not math.isfinite(value):
            raise ValueError(f"Non-finite {path or fmt} at byte {start}")
        if path is not None:
            self.bindings[path] = {'offset': start, 'format': fmt}
        return value

    def string(self) -> str:
        return self.read(self.value('B')).decode('latin-1')


def _image(reader: Reader, kind: str, name: str, assets_root: Path | None = None) -> dict:
    start = reader.pos
    if kind == 'bmp':
        if reader.data[start:start + 2] != b'BM':
            raise ValueError(f"Expected BMP header at byte {start}")
        if start + 26 > len(reader.data):
            raise ValueError(f"Truncated BMP at byte {start}")
        size, = struct.unpack_from('<I', reader.data, start + 2)
        if size < 26:
            raise ValueError(f"Invalid BMP size {size} at byte {start}")
        blob = reader.read(size)
        dib_size, = struct.unpack_from('<I', blob, 14)
        if dib_size == 12:
            width, height = struct.unpack_from('<HH', blob, 18)
        elif dib_size >= 40 and size >= 54:
            width, height = struct.unpack_from('<ii', blob, 18)
            height = abs(height)
        else:
            raise ValueError(f"Unsupported BMP DIB header size {dib_size}")
        if width <= 0 or height <= 0:
            raise ValueError(f"Invalid BMP dimensions {width}x{height}")
        mime = 'image/bmp'
    else:
        # Pivot's JPEG end pointer is absolute within the uncompressed stream.
        end = reader.value('Q')
        if end <= reader.pos:
            raise ValueError(f"Invalid JPEG end pointer {end} at byte {start}")
        blob = reader.read(end - reader.pos)
        if not blob.startswith(b'\xff\xd8') or not blob.endswith(b'\xff\xd9'):
            raise ValueError(f"Invalid JPEG boundaries at byte {start}")
        width = height = None
        mime = 'image/jpeg'
    asset = {'kind': kind, 'mime_type': mime, 'width': width, 'height': height,
             'data_uri': 'data:' + mime + ';base64,' + base64.b64encode(blob).decode('ascii'),
             'source_offset': start, 'source_size': reader.pos - start}
    if assets_root is not None:
        assets_root.mkdir(parents=True, exist_ok=True)
        path = assets_root / (name + ('.jpg' if kind == 'jpeg' else '.bmp'))
        path.write_bytes(blob)
        asset.update(asset_path=str(path.resolve()), asset_path_relative=path.name)
    return asset


def _figure(reader: Reader, figure_id: int, index: int, assets_root: Path | None,
            builtin: bool = False) -> dict:
    start = reader.pos
    count = reader.value('B')
    if count == 0:
        raise ValueError(f"Zero-segment figure {figure_id} at byte {start}")
    segments, sprite_refs = [], []
    for order in range(count):
        pos = reader.pos
        prefix = f'/figure_types/{index}/segments/{order}'
        parent = reader.value('B')
        segment_id = reader.value('B')
        unused_flags = reader.value('H')
        length = reader.value('f', None if builtin else prefix + '/length')
        angle = reader.value('d', None if builtin else prefix + '/angle_rad')
        thickness = reader.value('f', None if builtin else prefix + '/thickness')
        primitive = reader.value('B')
        static = reader.value('B')
        reserved = reader.value('H')
        if primitive not in (0, 1, 2, 3, 4, 6):
            raise ValueError(f"Unsupported legacy primitive {primitive} at byte {pos + 20}")
        if segment_id == 0 or segment_id > count or parent > count:
            raise ValueError(f"Invalid topology in figure {figure_id} at segment {order}")
        kind = {0: 'line', 1: 'circle', 2: 'image', 3: 'circleFill', 4: 'circleClear', 6: 'squareLine'}[primitive]
        segment_type = 'circle' if primitive in (1, 3, 4) else ('image' if primitive == 2 else 'line')
        flags = (0x100 if static else 0) | primitive
        seg = {'segment_order_index': order, 'segment_id': segment_id, 'parent_id': parent,
               'length': length, 'angle_rad': angle, 'thickness': thickness,
               'primitive_code': primitive, 'segment_type': segment_type, 'segment_kind': kind,
               'flags': flags, 'is_static': bool(static), 'static_raw': static,
               'flag_bits': {'is_static': bool(static), 'is_circle': primitive in (1, 3, 4), 'raw': flags},
               'color_rgb': [0, 0, 0], 'color_alpha': 1.0, 'transparency': 0,
               'bend_rad': 0.0, 'visible': primitive in (1, 2, 3, 4) or thickness > 0.01,
               'valid': True, 'z_order': order + 1, 'z_order_runtime_raw': order,
               'record_offset': None if builtin else pos, 'source_layout': 'piv_v4_legacy24',
               'legacy_unused_flags': unused_flags, 'legacy_reserved': reserved}
        if not builtin:
            reader.bindings[prefix + '/static_raw'] = {'offset': pos + 21, 'format': 'B'}
        if primitive == 2:
            seg['sprite_index'] = reader.value('B')
            seg['sprite_flip'] = reader.value('B')
            seg['image_asset_index'] = seg['sprite_index']
            seg['image_flip'] = seg['sprite_flip']
            sprite_refs.append(seg['sprite_index'])
        segments.append(seg)
    ids = {s['segment_id'] for s in segments}
    if len(ids) != count:
        raise ValueError(f"Duplicate segment IDs in figure {figure_id}")
    parents = {s['segment_id']: s['parent_id'] for s in segments}
    for node in ids:
        chain = set()
        while node:
            if node in chain:
                raise ValueError(f"Cyclic segment topology in figure {figure_id}")
            chain.add(node)
            node = parents[node]
    images = []
    if sprite_refs:
        sprite_count = reader.value('B')
        for si in range(sprite_count):
            transparent_color = reader.value('I')
            asset = _image(reader, 'bmp', f'figure_{figure_id}_sprite_{si}', assets_root)
            asset.update(sprite_index=si, transparent_color_raw=transparent_color,
                         transparent_color_rgb=[transparent_color & 255, (transparent_color >> 8) & 255,
                                                (transparent_color >> 16) & 255])
            asset.update(image_index=si, transparency_color_raw=transparent_color,
                         pivot={'x': 0, 'y': asset['height']},
                         endpoint={'x': asset['width'], 'y': asset['height']})
            images.append(asset)
        if any(si >= len(images) for si in sprite_refs):
            raise ValueError(f"Missing sprite resource in figure {figure_id}")
    return {'figure_type_id': figure_id, 'name': 'Default' if builtin else reader.string(),
            'segment_count': count, 'segments': segments, 'polyfills': [], 'bends': [],
            'image_assets': images, 'text_assets': [], 'has_side_table': bool(images),
            'segment_decode': {'layout': 'piv_v4_legacy24', 'records_start': None if builtin else start,
                               'records_end': None if builtin else reader.pos},
            'z_order_mode': 'record_order', 'builtin': builtin}


def decode_v4(data: bytes, source_path: str = '', assets_root: Path | None = None) -> dict:
    """Decode a decompressed version-4 PIV payload, requiring exact consumption."""
    reader = Reader(data)
    if reader.value('B') != 4:
        raise ValueError('decode_v4 requires a Pivot version 4 payload')
    assets_root = None if assets_root is None else Path(assets_root)
    width = reader.value('I', '/canvas_width')
    height = reader.value('I', '/canvas_height')
    if width == 0 or height == 0:
        raise ValueError('Pivot canvas dimensions must be positive')
    bg_slots = reader.value('B')
    if bg_slots == 0:
        raise ValueError('Pivot background table must contain default slot 0')
    backgrounds = []
    for bg_id in range(1, bg_slots):
        kind = reader.value('B')
        if kind not in (0, 1):
            raise ValueError(f'Unsupported Pivot 4 background kind {kind} at byte {reader.pos - 1}')
        asset = _image(reader, 'bmp' if kind == 0 else 'jpeg', f'background_{bg_id}', assets_root)
        asset.update(background_id=bg_id, kind=kind, name=reader.string())
        backgrounds.append(asset)
    figure_slots = reader.value('H')
    if figure_slots < 2:
        raise ValueError('Pivot 4 figure table must include empty and builtin slots')
    figures = [_figure(Reader(_BUILTIN_MAN), 1, 0, None, builtin=True)]
    for figure_id in range(2, figure_slots):
        figures.append(_figure(reader, figure_id, len(figures), assets_root))
    by_id = {f['figure_type_id']: f for f in figures}
    frame_start = reader.pos
    frame_count = reader.value('I')
    if frame_count == 0 or frame_count > (len(data) - reader.pos) // 5:
        raise ValueError(f'Invalid Pivot 4 frame count {frame_count}')
    frames = []
    for fi in range(frame_count):
        fp = f'/keyframes/{fi}'
        duration = reader.value('H', fp + '/duration_raw')
        if duration == 0:
            raise ValueError(f'Zero frame duration at frame {fi}')
        bg_id = reader.value('B', fp + '/background_id')
        if bg_id >= bg_slots:
            raise ValueError(f'Missing background {bg_id} at frame {fi}')
        object_count = reader.value('H')
        objects = []
        for oi in range(object_count):
            op = fp + f'/objects/{oi}'
            unique_id = reader.value('I')
            type_id = reader.value('H')
            if type_id not in by_id:
                raise ValueError(f'Missing figure type {type_id} at frame {fi}, object {oi}')
            figure = by_id[type_id]
            scale = reader.value('f', op + '/scale')
            color_raw = reader.value('I', op + '/color_override_raw')
            transparency = reader.value('B', op + '/field28')
            image_text_flags = reader.value('B', op + '/image_text_flags') if figure['image_assets'] else 0
            count = figure['segment_count']
            angles = [reader.value('d', op + f'/angles/{si}') for si in range(count)]
            if any(abs(angle) > 100 for angle in angles):
                # Native 941612..941654 interprets this as a reset sentinel and
                # derives the pose through B009FC/943650, rather than sin/cos.
                # No supplied v4 fixture uses this uncommon recovery encoding.
                raise ValueError(f'Unsupported legacy angle-reset sentinel at frame {fi}, object {oi}')
            root_x = reader.value('f', op + '/root_x')
            root_y = reader.value('f', op + '/root_y')
            length_flag = reader.value('B')
            lengths = [reader.value('f', op + f'/lengths/{si}') for si in range(count)] if length_flag else []
            join_flag = reader.value('B')
            join = None
            if join_flag:
                join = {'target_object_slot': reader.value('H'), 'target_handle_id': reader.value('B')}
            color = color_raw if color_raw < 0x80000000 else 0
            objects.append({'object_slot': oi, 'unique_id': unique_id, 'figure_type_id': type_id,
                            'scale': scale, 'color_override_raw': color_raw,
                            'color_override_rgb': [color & 255, (color >> 8) & 255, (color >> 16) & 255],
                            'field28': transparency, 'image_text_flags': image_text_flags,
                            'angles': angles, 'root_x': root_x, 'root_y': root_y,
                            'len_flag': length_flag, 'lengths': lengths, 'bend_flag': 0, 'bends': [],
                            'join': join, 'join_flag_raw': join_flag})
        order = [reader.value('H') for _ in range(object_count)]
        if sorted(order) != list(range(object_count)):
            raise ValueError(f'Object draw order is not a permutation at frame {fi}')
        for obj in objects:
            if obj['join'] is not None:
                target_slot = obj['join']['target_object_slot']
                if target_slot >= len(objects):
                    raise ValueError(f'Join target outside frame {fi}')
                target = objects[target_slot]
                if obj['join']['target_handle_id'] > by_id[target['figure_type_id']]['segment_count']:
                    raise ValueError(f'Join handle outside target figure at frame {fi}')
                obj['join']['target_unique_id'] = target['unique_id']
        frames.append({'keyframe_index': fi, 'duration_raw': duration, 'duration_frames': duration,
                       'inbetweens': 0, 'duration_semantics': 'hold',
                       'background_mix': 0, 'background_id': bg_id, 'background_id_b': None,
                       'objects': objects, 'object_draw_order': order,
                       'camera': {'is_default': True, 'x': 0.0, 'y': 0.0, 'scale': 1.0}})
    delay_ms = reader.value('I', '/frame_delay_ms')
    if delay_ms == 0:
        raise ValueError('Pivot 4 frame delay must be positive')
    optional_flag = None
    if len(data) - reader.pos == 1:
        optional_flag = reader.value('B')
    if reader.pos != len(data):
        raise ValueError(f'Unexpected trailing data at byte {reader.pos}: {len(data) - reader.pos} bytes')
    return {'source_path': str(source_path), 'file_type': 'piv', 'format': 'piv_v4_exact',
            'decode_status': 'decoded', 'trace_assisted': False, 'version': 4,
            'canvas_width': width, 'canvas_height': height, 'backgrounds': backgrounds,
            'figure_types': figures, 'keyframes': frames, 'fps': round(1000 / delay_ms),
            'frame_delay_ms': delay_ms, 'optional_trailing_flag': optional_flag,
            'timeline_frame_count': sum(f['duration_raw'] for f in frames),
            'payload_size': len(data), '_bindings': reader.bindings,
            'validation': {'consumed_bytes': reader.pos, 'trailing_bytes': 0,
                           'frame_start': frame_start, 'exact_consumption': True},
            'notes': ['Version 4 duration values repeat held poses; they are not interpolated frames.',
                      'FPS is the native rounded 1000/frame_delay_ms conversion.',
                      'Legacy static state comes from record byte 21; record bytes 2 and 3 are unused.',
                      'Sprite assets preserve bitmap color-key transparency metadata.']}
