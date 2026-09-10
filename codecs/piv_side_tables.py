"""Exact modern Pivot figure image/text side-table reader and writer.

The layout comes from Pivot 5's aff7f8 -> af864c / 939ab4 / 92ef08
loaders. Offsets passed to this module are in the *whole decompressed stream*;
image payload endpoints are absolute stream positions, not byte lengths.

Text is stored with font-independent vector glyph outlines. The outline opcode
stream packs two four-bit commands per byte, low nibble first. Its node count
counts a cubic as three nodes, and other commands as one. Coordinates follow
all opcodes. This is not the usual fixed-size nibble-array representation.

Rendering contract verified in VA AF79DC (images), 938808/9395CC (text):
* ``extra_u8_a`` reverses parent/tip endpoints and adds pi to rotation.
* ``extra_u8_b XOR object.image_text_flags`` reflects across the baseline.
* Images uniformly scale by world endpoint distance / anchor point distance;
  their source origin is anchor_start, their source axis is end minus start.
* Text uses normalized_svg_path with lower-left origin. Horizontal scale is
  world endpoint distance / bounds.width; vertical scale is object.scale.
  Segment thickness does not control image/text height.
* ``bounds`` includes cubic control points, matching FMX VA 550C64; repeated
  glyphs use float32-translated rectangles unioned by VA 938674. Large centered
  layout offsets (around 32768 in speech bubbles) disappear after normalization.

Corpus validation: all 21 PNG assets and 15 text assets in supplied V5 projects
parse and serialize byte-for-byte. Relocated image endpoint serialization,
text placement mutation, and truncated-input rejection were also checked.
"""
from __future__ import annotations

import base64
import math
import struct
from typing import Any


class SideTableError(ValueError):
    """Malformed or unsupported image/text table, with an exact byte offset."""


class _Reader:
    def __init__(self, data: bytes, pos: int):
        self.data, self.pos = data, pos

    def take(self, n: int, label: str) -> bytes:
        if n < 0 or self.pos < 0 or n > len(self.data) - self.pos:
            raise SideTableError(f"Invalid {label} at {self.pos}: need {n} bytes")
        value = self.data[self.pos:self.pos+n]
        self.pos += n
        return value

    def unpack(self, fmt: str, label: str):
        return struct.unpack(fmt, self.take(struct.calcsize(fmt), label))

    def u8(self, label: str) -> int:
        return self.take(1, label)[0]

    def u16(self, label: str) -> int:
        return self.unpack('<H', label)[0]

    def u32(self, label: str) -> int:
        return self.unpack('<I', label)[0]

    def string(self, label: str) -> tuple[str, list[int]]:
        n = self.u32(label + '.length')
        blob = self.take(n * 2, label)
        # Delphi indexes UTF-16 code units, including surrogate pairs separately.
        units = list(struct.unpack(f'<{n}H', blob)) if n else []
        return blob.decode('utf-16-le', errors='surrogatepass'), units


_COMMAND_NAMES = ('M', 'L', 'C', 'Z', 'V', 'H')
_VALUE_COUNTS = (2, 2, 6, 0, 1, 1)


def _read_path(r: _Reader) -> dict[str, Any]:
    start = r.pos
    count = r.u32('glyph.node_count')
    # At least one byte per six expanded nodes, even when every command is C.
    if count > (len(r.data) - r.pos) * 6:
        raise SideTableError(f"Impossible glyph node count {count} at {start}")
    codes: list[int] = []
    expanded = 0
    while expanded < count:
        packed = r.u8('glyph.opcodes')
        for code in (packed & 15, packed >> 4):
            if code > 5:
                raise SideTableError(f"Unknown glyph opcode {code} at {r.pos - 1}")
            codes.append(code)
            expanded += 3 if code == 2 else 1
            if expanded >= count:
                break
    if expanded != count:
        raise SideTableError(f"Cubic crosses glyph node count at {start}")
    commands = []
    for code in codes:
        n = _VALUE_COUNTS[code]
        values = list(r.unpack('<' + 'f' * n, 'glyph.coordinates')) if n else []
        if not all(math.isfinite(value) for value in values):
            raise SideTableError(f"Nonfinite glyph coordinate at {r.pos}")
        commands.append({'op': _COMMAND_NAMES[code], 'values': values})
    return {'node_count': count, 'commands': commands,
            'source_start': start, 'source_end': r.pos}


def _format_float(n: float) -> str:
    return format(n, '.9g')


def glyph_svg_path(glyph: dict[str, Any], x: float = 0, y: float = 0) -> str:
    """SVG path in the persisted glyph coordinate system, optionally translated."""
    pieces = []
    for command in glyph['commands']:
        op, values = command['op'], list(command['values'])
        if op in ('M', 'L', 'C'):
            values = [value + (x if i % 2 == 0 else y) for i, value in enumerate(values)]
        elif op == 'H':
            values = [values[0] + x]
        elif op == 'V':
            values = [values[0] + y]
        pieces.append(op + ' '.join(_format_float(value) for value in values))
    return ' '.join(pieces)


def text_svg_path(asset: dict[str, Any]) -> str:
    """Combine stored glyph paths and exact per-character placement as SVG data."""
    pieces = []
    for placement in asset['placements']:
        if not placement['visible']:
            continue
        glyph = asset['glyphs'][placement['glyph_index']]
        pieces.append(glyph_svg_path(glyph, placement['x'], placement['y']))
    return ' '.join(pieces)


def _path_bounds(glyph: dict[str, Any]) -> dict[str, float] | None:
    """FMX's bounds include cubic control points (VA550C64), excluding close."""
    points = []
    current_x = current_y = start_x = start_y = 0.0
    for command in glyph['commands']:
        op, values = command['op'], command['values']
        if op in ('M', 'L', 'C'):
            points.extend(zip(values[0::2], values[1::2]))
            current_x, current_y = values[-2:]
            if op == 'M':
                start_x, start_y = current_x, current_y
        elif op == 'H':
            current_x = values[0]
            points.append((current_x, current_y))
        elif op == 'V':
            current_y = values[0]
            points.append((current_x, current_y))
        elif op == 'Z':
            current_x, current_y = start_x, start_y
    if not points:
        return None
    xs, ys = zip(*points)
    return {'left': min(xs), 'top': min(ys), 'right': max(xs), 'bottom': max(ys)}


def _f32(value: float) -> float:
    return struct.unpack('<f', struct.pack('<f', value))[0]


def _text_bounds(asset: dict[str, Any]) -> dict[str, float]:
    boxes = []
    for placement in asset['placements']:
        bounds = asset['glyphs'][placement['glyph_index']]['bounds']
        if bounds is not None:
            # Each rectangle translation is persisted to float32 in the loader.
            boxes.append({key: _f32(value + placement['x' if key in ('left', 'right') else 'y'])
                          for key, value in bounds.items()})
    bounds = {key: (min(box[key] for box in boxes) if key in ('left', 'top')
                    else max(box[key] for box in boxes)) if boxes else 0.0
              for key in ('left', 'top', 'right', 'bottom')}
    bounds['width'] = _f32(bounds['right'] - bounds['left'])
    bounds['height'] = _f32(bounds['bottom'] - bounds['top'])
    return bounds


def _read_text(r: _Reader, index: int) -> dict[str, Any]:
    start = r.pos
    font_name, _ = r.string('text.font_name')
    font_style = r.u8('text.font_style')
    alignment = r.u32('text.alignment')
    text, units = r.string('text.content')
    glyph_count = r.u8('text.glyph_count')
    glyphs = [_read_path(r) for _ in range(glyph_count)]
    unique = list(dict.fromkeys(units))
    if len(unique) != glyph_count:
        raise SideTableError(
            f"Text at {start} has {len(unique)} unique UTF-16 code units but {glyph_count} glyphs")
    glyph_by_unit = {unit: i for i, unit in enumerate(unique)}
    placements = []
    for char_index, unit in enumerate(units):
        glyph_index = glyph_by_unit[unit]
        visible = bool(glyphs[glyph_index]['node_count'])
        x, y = r.unpack('<ff', 'text.character_offset') if visible else (0.0, 0.0)
        if not math.isfinite(x) or not math.isfinite(y):
            raise SideTableError(f"Nonfinite text placement at {r.pos - 8}")
        placements.append({'character_index': char_index, 'utf16_code_unit': unit,
                           'glyph_index': glyph_index, 'visible': visible, 'x': x, 'y': y})
    for glyph, unit in zip(glyphs, unique):
        glyph['utf16_code_unit'] = unit
        glyph['svg_path'] = glyph_svg_path(glyph)
        glyph['bounds'] = _path_bounds(glyph)
    asset = {'kind': 'text', 'asset_index': index, 'table_index': index,
             'font_name': font_name, 'font_style': font_style,
             'bold': bool(font_style & 1), 'italic': bool(font_style & 2),
             'underline': bool(font_style & 4), 'strikeout': bool(font_style & 8),
             'alignment': alignment, 'text': text, 'glyphs': glyphs,
             'placements': placements, 'source_start': start, 'source_end': r.pos}
    asset['svg_path'] = text_svg_path(asset)
    asset['bounds'] = _text_bounds(asset)
    asset['normalized_svg_path'] = ' '.join(
        glyph_svg_path(glyphs[placement['glyph_index']],
                       placement['x'] - asset['bounds']['left'],
                       placement['y'] - asset['bounds']['bottom'])
        for placement in placements if placement['visible'])
    asset['normalized_origin'] = 'lower_left'
    return asset


def _image_metadata(blob: bytes) -> dict[str, Any]:
    # FMX image streams normally contain a standard encoded image directly.
    # Preserve unknown image formats rather than guessing a framing boundary.
    if blob.startswith(b'\x89PNG\r\n\x1a\n'):
        result = {'mime_type': 'image/png', 'extension': '.png'}
        if len(blob) >= 24:
            result['width'], result['height'] = struct.unpack_from('>II', blob, 16)
        return result
    if blob.startswith(b'\xff\xd8'):
        result = {'mime_type': 'image/jpeg', 'extension': '.jpg'}
        pos = 2
        while pos + 4 <= len(blob):
            if blob[pos] != 0xff:
                break
            while pos < len(blob) and blob[pos] == 0xff:
                pos += 1
            if pos >= len(blob):
                break
            marker = blob[pos]
            pos += 1
            if marker in (0xd8, 0xd9, 0x01) or 0xd0 <= marker <= 0xd7:
                continue
            if pos + 2 > len(blob):
                break
            length = int.from_bytes(blob[pos:pos+2], 'big')
            if length < 2 or pos + length > len(blob):
                break
            if marker in (0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf) and length >= 7:
                result['height'], result['width'] = struct.unpack_from('>HH', blob, pos + 3)
                break
            if marker == 0xda:
                break
            pos += length
        return result
    if blob.startswith(b'BM'):
        result = {'mime_type': 'image/bmp', 'extension': '.bmp'}
        if len(blob) >= 26:
            result['width'], result['height'] = struct.unpack_from('<ii', blob, 18)
            result['height'] = abs(result['height'])
        return result
    if blob.startswith((b'GIF87a', b'GIF89a')):
        result = {'mime_type': 'image/gif', 'extension': '.gif'}
        if len(blob) >= 10:
            result['width'], result['height'] = struct.unpack_from('<HH', blob, 6)
        return result
    return {'mime_type': 'application/octet-stream', 'extension': '.bin'}


def _read_image(r: _Reader, index: int) -> dict[str, Any]:
    start = r.pos
    ax, ay, bx, by = r.unpack('<iiii', 'image.anchor_points')
    end = r.unpack('<Q', 'image.absolute_end')[0]
    image_start = r.pos
    blob = r.take(end - r.pos, 'image.encoded_data')
    encoded = base64.b64encode(blob).decode('ascii')
    asset = {'kind': 'image', 'asset_index': index, 'table_index': index,
             'anchor_start': {'x': ax, 'y': ay}, 'anchor_end': {'x': bx, 'y': by},
             'anchor_length': math.hypot(bx - ax, by - ay),
             'anchor_angle_rad': math.atan2(by - ay, bx - ax),
             'source_start': start, 'source_end': end, 'image_start': image_start,
             'data_base64': encoded, **_image_metadata(blob)}
    if asset['mime_type'].startswith('image/'):
        asset['data_url'] = 'data:' + asset['mime_type'] + ';base64,' + encoded
    return asset


def _primitive(segment: dict[str, Any]) -> int:
    return int(segment.get('primitive_code', segment.get('primitive', -1)))


def parse_side_tables(data: bytes, pos: int, segments: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    """Read conditional image then text tables immediately after figure bends.

    The returned assets use separate zero-based indexes for each kind. A segment
    points into its kind's table through extra_u16 (or extra[0]); extra_u8_a/b
    are preserved by the segment parser and do not alter this table's layout.
    No bytes are consumed for a kind that is not used by any segment.
    """
    r = _Reader(data, pos)
    kinds = {_primitive(segment) for segment in segments}
    assets = []
    for primitive, kind, reader in ((2, 'image', _read_image), (5, 'text', _read_text)):
        if primitive not in kinds:
            continue
        count = r.u16(kind + '.table_count')
        table_assets = [reader(r, index) for index in range(count)]
        assets.extend(table_assets)
        for segment in segments:
            if _primitive(segment) != primitive:
                continue
            extra = segment.get('extra')
            reference = int(segment.get('extra_u16', extra[0] if extra else 0))
            if reference >= count or reference < 0:
                raise SideTableError(f"{kind} segment refers to asset {reference}, table has {count}")
            table_assets[reference].setdefault('segment_ids', []).append(int(segment['segment_id']))
    return assets, r.pos


def _write_string(value: str) -> bytes:
    blob = value.encode('utf-16-le', errors='surrogatepass')
    return struct.pack('<I', len(blob) // 2) + blob


def _write_path(glyph: dict[str, Any]) -> bytes:
    commands = glyph['commands']
    codes = [_COMMAND_NAMES.index(command['op']) for command in commands]
    count = sum(3 if code == 2 else 1 for code in codes)
    out = bytearray(struct.pack('<I', count))
    for i in range(0, len(codes), 2):
        out.append(codes[i] | (codes[i+1] << 4 if i+1 < len(codes) else 0))
    for command, code in zip(commands, codes):
        values = command['values']
        if len(values) != _VALUE_COUNTS[code]:
            raise SideTableError(f"Wrong number of values for glyph {command['op']}")
        out.extend(struct.pack('<' + 'f' * len(values), *values))
    return bytes(out)


def encode_side_tables(assets: list[dict[str, Any]], pos: int,
                       segments: list[dict[str, Any]]) -> bytes:
    """Serialize decoded tables; relocate image endpoints to absolute ``pos``.

    Text edits require coherent glyphs and placements. It is deliberately an
    error to edit a string and accidentally retain offsets/outlines for another
    string. Existing outlines and per-character positions remain editable.
    """
    kinds = {_primitive(segment) for segment in segments}
    out = bytearray()
    for primitive, kind in ((2, 'image'), (5, 'text')):
        if primitive not in kinds:
            continue
        table = sorted((asset for asset in assets if asset['kind'] == kind), key=lambda asset: asset['asset_index'])
        if [asset['asset_index'] for asset in table] != list(range(len(table))):
            raise SideTableError(f"Non-contiguous {kind} asset indexes")
        out.extend(struct.pack('<H', len(table)))
        for asset in table:
            if kind == 'image':
                a, b = asset['anchor_start'], asset['anchor_end']
                blob = base64.b64decode(asset['data_base64'], validate=True)
                out.extend(struct.pack('<iiii', a['x'], a['y'], b['x'], b['y']))
                out.extend(struct.pack('<Q', pos + len(out) + 8 + len(blob)))
                out.extend(blob)
                continue
            text_blob = asset['text'].encode('utf-16-le', errors='surrogatepass')
            units = list(struct.unpack('<' + 'H' * (len(text_blob)//2), text_blob))
            unique = list(dict.fromkeys(units))
            if len(unique) != len(asset['glyphs']) or len(units) != len(asset['placements']):
                raise SideTableError('Edited text requires matching glyphs and character placements')
            out.extend(_write_string(asset['font_name']))
            out.extend(struct.pack('<BI', asset['font_style'], asset['alignment']))
            out.extend(_write_string(asset['text']))
            out.extend(struct.pack('<B', len(asset['glyphs'])))
            for glyph, unit in zip(asset['glyphs'], unique):
                if glyph.get('utf16_code_unit', unit) != unit:
                    raise SideTableError('Edited text requires matching glyph characters')
                out.extend(_write_path(glyph))
            for placement, unit in zip(asset['placements'], units):
                index = unique.index(unit)
                if placement.get('utf16_code_unit', unit) != unit or placement['glyph_index'] != index:
                    raise SideTableError('Edited text requires matching character placements')
                if asset['glyphs'][index]['commands']:
                    out.extend(struct.pack('<ff', placement['x'], placement['y']))
    return bytes(out)
