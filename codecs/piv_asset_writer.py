"""Hydrate and validate V5 assets for full project serialization.

Only explicit ``workspace_root`` enables filesystem reads. A materialized path
must resolve inside that root, including after symlink/junction resolution.
Inline image data wins over paths and original source spans; contradictory
inline representations raise an error rather than silently losing an edit.

The input payload is the *decompressed original project*. Image source spans
use absolute offsets in that payload. ``encode_hydrated_side_tables`` relocates
the embedded image endpoints to their final position in a newly written file.
"""
from __future__ import annotations

import base64
import binascii
from copy import deepcopy
import math
import os
from pathlib import Path
import struct
from typing import Any

try:
    from . import piv_side_tables as tables
except ImportError:
    import piv_side_tables as tables


class AssetWriteError(tables.SideTableError):
    """An asset cannot be hydrated or safely serialized."""


def _integer(value: Any, label: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise AssetWriteError(f'{label} must be an integer')
    if not minimum <= value <= maximum or (isinstance(value, float) and not math.isfinite(value)) or int(value) != value:
        raise AssetWriteError(f'{label} must be an integer in [{minimum}, {maximum}]')
    return int(value)


def _float32(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise AssetWriteError(f'{label} must be a finite number')
    try:
        if not math.isfinite(value):
            raise AssetWriteError(f'{label} must be a finite number')
        rounded = struct.unpack('<f', struct.pack('<f', value))[0]
    except (OverflowError, struct.error) as exc:
        raise AssetWriteError(f'{label} is outside the float32 range') from exc
    if not math.isfinite(rounded):
        raise AssetWriteError(f'{label} is outside the float32 range')
    return rounded


def _base64(value: Any, label: str) -> bytes:
    if not isinstance(value, str):
        raise AssetWriteError(f'{label} must be a base64 string')
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise AssetWriteError(f'Invalid {label}') from exc


def _inline_bytes(asset: dict[str, Any]) -> bytes | None:
    values = []
    if asset.get('data_base64') is not None:
        values.append(_base64(asset['data_base64'], 'data_base64'))
    for key in ('data_url','data_uri'):
        if asset.get(key) is None:
            continue
        value = asset[key]
        if not isinstance(value, str) or not value.startswith('data:') or ',' not in value:
            raise AssetWriteError('data_url must be a base64 data URL, not a remote URL')
        header, encoded = value.split(',', 1)
        parts = header[5:].split(';')
        if parts[-1].lower() != 'base64':
            raise AssetWriteError('data_url must use base64 encoding')
        mime = parts[0].lower()
        if not (mime.startswith('image/') or mime == 'application/octet-stream'):
            raise AssetWriteError('data_url must contain image data')
        values.append(_base64(encoded, 'data_url base64 payload'))
    if not values:
        return None
    if any(value != values[0] for value in values[1:]):
        raise AssetWriteError('Conflicting data_base64 and data_url; remove or update the stale representation')
    return values[0]


def _source_span(asset: dict[str, Any], payload: bytes) -> bytes | None:
    if asset.get('image_start') is None and asset.get('source_end') is None:
        return None
    if asset.get('image_start') is None or asset.get('source_end') is None:
        raise AssetWriteError('Original image recovery requires both image_start and source_end')
    start = _integer(asset['image_start'], 'image_start', 0, len(payload))
    end = _integer(asset['source_end'], 'source_end', start, len(payload))
    return payload[start:end]


def _workspace_file(asset: dict[str, Any], workspace_root: str | Path) -> bytes | None:
    # The absolute path from the decoder is authoritative. Relative paths are
    # only a fallback and are interpreted relative to the explicit root.
    value = next((asset[key] for key in ('asset_path', 'image_path', 'asset_path_relative')
                  if asset.get(key) is not None), None)
    if value is None:
        return None
    if not isinstance(value, (str, Path)) or not str(value):
        raise AssetWriteError('Image asset path must be a nonempty filesystem path')
    try:
        root = Path(workspace_root).resolve(strict=True)
        if not root.is_dir():
            raise AssetWriteError('workspace_root must be an existing directory')
        path = Path(value)
        # Disallow URI schemes and Windows alternate data streams. A drive
        # prefix in an absolute Windows path is handled by pathlib's anchor.
        if any(':' in part for part in path.parts[1 if path.anchor else 0:]):
            raise AssetWriteError('Image asset path cannot be a URI or alternate data stream')
        candidate = path if path.is_absolute() else root / path
        lexical = Path(os.path.abspath(candidate))
        if not lexical.is_relative_to(root):
            raise AssetWriteError('Image asset path escapes workspace_root')
        # Resolve even before existence checks, so traversal never reaches a
        # filesystem read. A second strict resolution follows existing links.
        resolved = candidate.resolve(strict=False)
        if not resolved.is_relative_to(root):
            raise AssetWriteError('Image asset path escapes workspace_root')
        resolved = candidate.resolve(strict=True)
        if not resolved.is_relative_to(root):
            raise AssetWriteError('Image asset symlink or junction escapes workspace_root')
        if not resolved.is_file():
            raise AssetWriteError('Image asset path must point to a file')
        return resolved.read_bytes()
    except AssetWriteError:
        raise
    except (OSError, RuntimeError, ValueError) as exc:
        raise AssetWriteError(f'Cannot read workspace image asset: {value}') from exc


def resolve_image_bytes(asset: dict[str, Any], original_payload: bytes,
                        workspace_root: str | Path | None = None) -> bytes:
    """Resolve image bytes for a sprite or background without requiring anchors.

    Priority: explicit inline data; materialized file when workspace_root is
    supplied; original image_start/source_end span. With no workspace_root,
    paths are never read and an original span can recover a materialized asset.
    Invalid explicit inline data or an unsafe supplied workspace path is an
    error, not a reason to silently revert to the original image.
    """
    if not isinstance(asset, dict):
        raise AssetWriteError('Image asset must be an object')
    if not isinstance(original_payload, bytes):
        raise AssetWriteError('original_payload must be decompressed bytes')
    value = _inline_bytes(asset)
    if value is None and workspace_root is not None:
        value = _workspace_file(asset, workspace_root)
    if value is None:
        value = _source_span(asset, original_payload)
    if value is None:
        raise AssetWriteError('Image has no inline data, original source span, or permitted workspace file')
    if not value:
        raise AssetWriteError('Encoded image data cannot be empty')
    return value


def _original_record(asset: dict[str, Any], payload: bytes, index: int) -> dict[str, Any]:
    start = asset.get('source_start')
    if start is None and asset['kind'] == 'image' and asset.get('image_start') is not None:
        start = _integer(asset['image_start'], 'image_start', 24, len(payload)) - 24
    if start is None:
        return {}
    start = _integer(start, 'asset.source_start', 0, len(payload))
    if not payload:
        return {}
    try:
        reader = tables._Reader(payload, start)
        recovered = (tables._read_image if asset['kind'] == 'image' else tables._read_text)(reader, index)
    except (ValueError, struct.error, IndexError) as exc:
        raise AssetWriteError(f'Cannot recover original {asset["kind"]} record at {start}') from exc
    if asset.get('source_end') is not None and reader.pos != asset['source_end']:
        raise AssetWriteError(f'Original {asset["kind"]} record end disagrees with source_end')
    return recovered


def _validate_text(asset: dict[str, Any]) -> None:
    for field in ('font_name', 'text'):
        if not isinstance(asset.get(field), str):
            raise AssetWriteError(f'Text asset {field} must be a string')
    asset['font_style'] = _integer(asset.get('font_style', 0), 'font_style', 0, 255)
    asset['alignment'] = _integer(asset.get('alignment', 0), 'alignment', 0, 0xffffffff)
    asset.update(bold=bool(asset['font_style'] & 1), italic=bool(asset['font_style'] & 2),
                 underline=bool(asset['font_style'] & 4), strikeout=bool(asset['font_style'] & 8))
    blob = asset['text'].encode('utf-16-le', errors='surrogatepass')
    units = list(struct.unpack('<' + 'H' * (len(blob) // 2), blob))
    unique = list(dict.fromkeys(units))
    glyphs, placements = asset.get('glyphs'), asset.get('placements')
    if not isinstance(glyphs, list) or len(glyphs) != len(unique) or len(glyphs) > 255:
        raise AssetWriteError('Text requires one glyph per distinct UTF-16 code unit, at most 255')
    if not isinstance(placements, list) or len(placements) != len(units):
        raise AssetWriteError('Text requires one placement per UTF-16 code unit')
    for gi, (glyph, unit) in enumerate(zip(glyphs, unique)):
        if not isinstance(glyph, dict) or not isinstance(glyph.get('commands'), list):
            raise AssetWriteError(f'Glyph {gi} requires a commands array')
        if glyph.get('utf16_code_unit', unit) != unit:
            raise AssetWriteError(f'Glyph {gi} does not match the edited text')
        glyph['utf16_code_unit'] = unit
        count = 0
        for ci, command in enumerate(glyph['commands']):
            if not isinstance(command, dict) or command.get('op') not in tables._COMMAND_NAMES:
                raise AssetWriteError(f'Invalid glyph {gi} command {ci}')
            code = tables._COMMAND_NAMES.index(command['op'])
            values = command.get('values')
            if not isinstance(values, list) or len(values) != tables._VALUE_COUNTS[code]:
                raise AssetWriteError(f'Invalid coordinate count for glyph {gi} command {ci}')
            command['values'] = [_float32(value, f'glyph {gi} command {ci} coordinate') for value in values]
            count += 3 if code == 2 else 1
        glyph['node_count'] = _integer(count, 'glyph node count', 0, 0xffffffff)
        glyph['bounds'] = tables._path_bounds(glyph)
        glyph['svg_path'] = tables.glyph_svg_path(glyph)
    index_by_unit = {unit: index for index, unit in enumerate(unique)}
    for pi, (placement, unit) in enumerate(zip(placements, units)):
        if not isinstance(placement, dict):
            raise AssetWriteError(f'Text placement {pi} must be an object')
        index = index_by_unit[unit]
        if placement.get('utf16_code_unit', unit) != unit or placement.get('glyph_index', index) != index:
            raise AssetWriteError(f'Text placement {pi} does not match the edited text')
        visible = bool(glyphs[index]['commands'])
        placement.update(character_index=pi, utf16_code_unit=unit, glyph_index=index, visible=visible)
        if visible:
            placement['x'] = _float32(placement.get('x'), f'text placement {pi}.x')
            placement['y'] = _float32(placement.get('y'), f'text placement {pi}.y')
        else:
            placement['x'] = placement['y'] = 0.0
    asset['bounds'] = tables._text_bounds(asset)
    asset['svg_path'] = tables.text_svg_path(asset)
    asset['normalized_svg_path'] = ' '.join(
        tables.glyph_svg_path(glyphs[placement['glyph_index']],
                             placement['x'] - asset['bounds']['left'],
                             placement['y'] - asset['bounds']['bottom'])
        for placement in placements if placement['visible'])
    asset['normalized_origin'] = 'lower_left'


def hydrate_side_tables(assets: list[dict[str, Any]], original_payload: bytes,
                        workspace_root: str | Path | None = None) -> list[dict[str, Any]]:
    """Return validated asset copies containing everything required for writing.

    Missing text fields/anchor points can be recovered from an original record
    using source_start/source_end. Explicit glyph or placement arrays replace
    the original arrays, and their editable coordinates are preserved. Derived
    glyph bounds/SVG and image dimensions are recomputed after edits.
    """
    if not isinstance(assets, list) or not isinstance(original_payload, bytes):
        raise AssetWriteError('assets must be a list and original_payload must be bytes')
    result = []
    indexes: dict[str, set[int]] = {'image': set(), 'text': set()}
    for original in assets:
        if not isinstance(original, dict) or original.get('kind') not in indexes:
            raise AssetWriteError('Side-table asset kind must be image or text')
        asset = deepcopy(original)
        kind = asset['kind']
        index = _integer(asset.get('asset_index', asset.get('table_index', len(indexes[kind]))),
                         kind + '.asset_index', 0, 65534)
        table_index = _integer(asset.get('table_index', index), kind + '.table_index', 0, 65534)
        if table_index != index:
            raise AssetWriteError('asset_index and table_index disagree')
        if index in indexes[kind]:
            raise AssetWriteError(f'Duplicate {kind} asset index {index}')
        indexes[kind].add(index)
        mandatory = ('anchor_start', 'anchor_end') if kind == 'image' else ('font_name', 'font_style', 'alignment', 'text', 'glyphs', 'placements')
        needs_recovery = any(field not in asset for field in mandatory)
        if kind == 'image':
            needs_recovery |= any(isinstance(asset.get(field), dict) and
                                  any(axis not in asset[field] for axis in ('x', 'y'))
                                  for field in ('anchor_start', 'anchor_end'))
        if needs_recovery:
            recovered = _original_record(asset, original_payload, index)
            # Recover metadata only: original inline data must never override a
            # replacement file or supplied source span during byte resolution.
            recovered.pop('data_base64', None)
            recovered.pop('data_url', None)
            for field in ('anchor_start', 'anchor_end'):
                if isinstance(asset.get(field), dict) and isinstance(recovered.get(field), dict):
                    recovered[field].update(asset[field])
                    asset.pop(field)
            recovered.update(asset)
            asset = recovered
        asset.update(kind=kind, asset_index=index, table_index=index)
        if kind == 'image':
            data = resolve_image_bytes(asset, original_payload, workspace_root)
            for field in ('anchor_start', 'anchor_end'):
                point = asset.get(field)
                if not isinstance(point, dict):
                    raise AssetWriteError(f'Image asset requires {field}')
                asset[field] = {axis: _integer(point.get(axis), field + '.' + axis, -0x80000000, 0x7fffffff)
                                for axis in ('x', 'y')}
            a, b = asset['anchor_start'], asset['anchor_end']
            asset['anchor_length'] = math.hypot(b['x'] - a['x'], b['y'] - a['y'])
            asset['anchor_angle_rad'] = math.atan2(b['y'] - a['y'], b['x'] - a['x'])
            asset['data_base64'] = base64.b64encode(data).decode('ascii')
            for field in ('width', 'height', 'data_url'):
                asset.pop(field, None)
            asset.update(tables._image_metadata(data))
            if asset['mime_type'].startswith('image/'):
                asset['data_url'] = 'data:' + asset['mime_type'] + ';base64,' + asset['data_base64']
        else:
            _validate_text(asset)
        result.append(asset)
    for kind, present in indexes.items():
        if present != set(range(len(present))):
            raise AssetWriteError(f'Non-contiguous {kind} table indexes')
        if len(present) > 65535:
            raise AssetWriteError(f'Too many {kind} assets for a u16 table count')
    return result


def encode_hydrated_side_tables(assets: list[dict[str, Any]], pos: int,
                                segments: list[dict[str, Any]], original_payload: bytes = b'',
                                workspace_root: str | Path | None = None) -> bytes:
    """Hydrate, validate segment references, and encode with relocated endpoints."""
    pos = _integer(pos, 'side-table output offset', 0, 0xffffffffffffffff)
    hydrated = hydrate_side_tables(assets, original_payload, workspace_root)
    if not isinstance(segments, list):
        raise AssetWriteError('segments must be a list')
    counts = {kind: sum(asset['kind'] == kind for asset in hydrated) for kind in ('image', 'text')}
    used = set()
    for segment in segments:
        if not isinstance(segment, dict):
            raise AssetWriteError('Each segment must be an object')
        primitive = segment.get('primitive_code', segment.get('primitive'))
        if primitive not in (2, 5):
            continue
        kind = 'image' if primitive == 2 else 'text'
        used.add(kind)
        extra = segment.get('extra')
        reference = segment.get('extra_u16', extra[0] if isinstance(extra, (list, tuple)) and extra else 0)
        reference = _integer(reference, kind + ' segment asset reference', 0, 65535)
        if reference >= counts[kind]:
            raise AssetWriteError(f'{kind} segment references {reference}, table contains {counts[kind]} assets')
    for kind, count in counts.items():
        if count and kind not in used:
            raise AssetWriteError(f'{kind} assets have no segment of the corresponding primitive kind')
    try:
        return tables.encode_side_tables(hydrated, pos, segments)
    except (ValueError, OverflowError, struct.error, KeyError, TypeError) as exc:
        raise AssetWriteError(f'Cannot encode side tables: {exc}') from exc
