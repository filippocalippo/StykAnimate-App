"""Explicitly convert an editable Pivot 2–4 document to a Pivot 5 project.

This does not replace the source-preserving legacy scalar writer. Conversion
materializes every old figure, including the version-specific default, and
expands held poses exactly as Pivot's native compatibility reader does.
Only embedded image resources are used; no URL or filesystem asset is read.
"""
from __future__ import annotations

import base64
import copy
import math
import struct
import zlib
from typing import Any

if __package__:
    from .piv_codec import PivError, _builtin_man, decode_piv_bytes
    from .piv_full_writer import encode_piv_project
    from .piv_asset_writer import resolve_image_bytes
    from .piv_legacy import _keyed_bitmap_png
else:
    from piv_codec import PivError, _builtin_man, decode_piv_bytes
    from piv_full_writer import encode_piv_project
    from piv_asset_writer import resolve_image_bytes
    from piv_legacy import _keyed_bitmap_png


def _integer(value: Any, label: str, low: int, high: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise PivError(f'{label} must be an integer in [{low}, {high}]')
    return value


def _fields(value: dict[str, Any], names: tuple[str, ...]) -> dict[str, Any]:
    return {name: copy.deepcopy(value[name]) for name in names if name in value}


def _finite_tree(value: Any) -> None:
    if isinstance(value, float) and not math.isfinite(value):
        raise PivError('Migrated geometry and styles must contain only finite numbers')
    if isinstance(value, dict):
        for item in value.values():
            _finite_tree(item)
    elif isinstance(value, list):
        for item in value:
            _finite_tree(item)


def _image_index(asset: dict[str, Any], fallback: int) -> int:
    return asset.get('asset_index', asset.get('table_index', asset.get('image_index', asset.get('sprite_index', fallback))))


def _has_inline(asset: dict[str, Any]) -> bool:
    return any(asset.get(key) is not None for key in ('data_base64', 'data_url', 'data_uri'))


def _hydrate_from_original(document: dict[str, Any], original: dict[str, Any]) -> None:
    """Recover omitted blobs only by original table identity, without disk I/O."""
    def hydrate(asset, old):
        if not _has_inline(asset) and old is not None:
            for key in ('data_base64', 'data_url', 'data_uri', 'color_key_applied'):
                if key in old:
                    asset[key] = copy.deepcopy(old[key])
    backgrounds = {b['background_id']: b for b in original.get('backgrounds', [])}
    for bg in document.get('backgrounds', []):
        hydrate(bg, backgrounds.get(bg.get('background_id')))
    figures = {f['figure_type_id']: f for f in original.get('figure_types', [])}
    for figure in document.get('figure_types', []):
        old = figures.get(figure.get('figure_type_id'), {})
        images = {_image_index(a, i): a for i, a in enumerate(old.get('image_assets', []))}
        for i, asset in enumerate(figure.get('image_assets', [])):
            hydrate(asset, images.get(_image_index(asset, i)))
        for i, asset in enumerate(figure.get('side_tables', [])):
            if asset.get('kind') == 'image':
                hydrate(asset, images.get(_image_index(asset, i)))


def _image(asset: dict[str, Any], *, sprite: bool, index: int = 0) -> dict[str, Any]:
    asset = copy.deepcopy(asset)
    if asset.get('render_limitations'):
        raise PivError('Unsupported legacy image conversion: ' + '; '.join(asset['render_limitations']))
    if not _has_inline(asset):
        raise PivError('Legacy migration requires embedded image data or the original source for recovery')
    # A decoded keyed BMP deliberately keeps its source BMP in data_uri and
    # its transparent PNG in data_url. The modern table must store the PNG.
    if 'data_url' not in asset and 'data_uri' in asset:
        asset['data_url'] = asset['data_uri']
    # Never pass legacy byte offsets to a modern source-span recovery routine.
    inline = _fields(asset, ('data_url', 'data_base64'))
    blob = resolve_image_bytes(inline, b'')
    if sprite and blob.startswith(b'BM') and any(key in asset for key in ('transparency_color_raw', 'transparent_color_raw')):
        asset['data_uri'] = 'data:image/bmp;base64,' + base64.b64encode(blob).decode('ascii')
        _keyed_bitmap_png(asset)
        if asset.get('render_limitations'):
            raise PivError('Unsupported legacy image conversion: ' + '; '.join(asset['render_limitations']))
        blob = resolve_image_bytes({'data_url': asset['data_url']}, b'')
    if blob.startswith(b'\x89PNG\r\n\x1a\n'):
        mime = 'image/png'
    elif blob.startswith(b'\xff\xd8'):
        mime = 'image/jpeg'
    elif blob.startswith(b'BM'):
        mime = 'image/bmp'
    else:
        raise PivError('Migration accepts embedded PNG, JPEG, or BMP images only')
    encoded = base64.b64encode(blob).decode('ascii')
    out = {'data_base64': encoded, 'data_url': f'data:{mime};base64,{encoded}', 'mime_type': mime}
    if sprite:
        start = asset.get('anchor_start', asset.get('pivot'))
        end = asset.get('anchor_end', asset.get('endpoint'))
        if not isinstance(start, dict) or not isinstance(end, dict):
            raise PivError('Legacy sprite requires both attachment anchors')
        out.update(kind='image', asset_index=_image_index(asset, index),
                   table_index=_image_index(asset, index),
                   anchor_start=copy.deepcopy(start), anchor_end=copy.deepcopy(end))
    return out


def _figure(figure: dict[str, Any], new_id: int) -> dict[str, Any]:
    out = {'figure_type_id': new_id, 'name': figure.get('name', 'Figure'),
           'implicit': False, 'segments': [], 'polyfills': copy.deepcopy(figure.get('polyfills', [])),
           'segment_decode': {'global_style': copy.deepcopy(figure.get('segment_decode', {}).get('global_style'))}}
    for segment in figure['segments']:
        s = _fields(segment, ('parent_id', 'segment_id', 'length', 'angle_rad', 'thickness',
            'primitive_code', 'color_rgb', 'color_alpha', 'transparency', 'secondary', 'bend_rad',
            'extra_u16', 'extra_u8_a', 'extra_u8_b', 'z_order', 'z_order_runtime_raw'))
        static = segment.get('is_static', bool(segment.get('static_raw', 0)))
        if not isinstance(static, bool):
            raise PivError('Segment is_static must be a boolean')
        s.update(is_static=static, aux_code=(segment.get('aux_code', 0) & 254) | int(static))
        if s.get('primitive_code') in (2, 5):
            s.setdefault('extra_u16', segment.get('image_asset_index', segment.get('sprite_index', 0)))
            s.setdefault('extra_u8_a', segment.get('image_flip', segment.get('sprite_flip', 0)))
            s.setdefault('extra_u8_b', 0)
        out['segments'].append(s)
    out['segment_count'] = len(out['segments'])
    for key in ('segment_z_raw', 'poly_z_raw'):
        if key in figure:
            out[key] = copy.deepcopy(figure[key])
    assets = figure.get('side_tables')
    if assets is None:
        assets = [*figure.get('image_assets', []), *figure.get('text_assets', [])]
    out['image_assets'], out['text_assets'] = [], []
    for index, asset in enumerate(assets):
        if asset.get('kind') == 'text':
            # Existing outline glyphs are portable; generating font outlines is
            # deliberately outside migration. The full writer validates them.
            text = _fields(asset, ('kind', 'asset_index', 'table_index', 'font_name', 'font_style',
                'alignment', 'text', 'glyphs', 'placements'))
            out['text_assets'].append(text)
        else:
            out['image_assets'].append(_image(asset, sprite=True, index=index))
    return out


def _migrate(document: dict[str, Any]) -> dict[str, Any]:
    version = document.get('version')
    if isinstance(version, bool) or version not in (2, 3, 4):
        raise PivError('Legacy migration accepts Pivot versions 2, 3, and 4 only')
    fps = _integer(document.get('fps'), 'FPS', 1, 1000)
    width = _integer(document.get('canvas_width'), 'Canvas width', 1, 100000)
    height = _integer(document.get('canvas_height'), 'Canvas height', 1, 100000)
    figures = document.get('figure_types')
    if not isinstance(figures, list) or not figures or len(figures) > 65533:
        raise PivError('Legacy migration requires 1–65533 figures')
    ids = [_integer(f.get('figure_type_id'), 'Figure ID', 1, 0x7fffffff) for f in figures]
    if len(set(ids)) != len(ids):
        raise PivError('Duplicate legacy figure type IDs')
    mapping = {old: i + 2 for i, old in enumerate(ids)}
    out = {'version': 5, 'canvas_width': width, 'canvas_height': height, 'fps': fps,
           'auto_easing': False, 'auto_easing_source': 'file', 'backgrounds': [],
           'figure_types': [_builtin_man()], 'keyframes': []}
    out['figure_types'].extend(_figure(f, mapping[f['figure_type_id']]) for f in figures)
    for bg in document.get('backgrounds', []):
        kind = bg.get('kind')
        kind = {'bmp': 0, 'png': 0, 'jpeg': 1, 'jpg': 1}.get(kind, kind)
        converted = {'background_id': bg['background_id'], 'name': bg.get('name', 'Background'), 'kind': kind}
        if kind in (0, 1):
            converted.update(_image(bg, sprite=False))
            # Native background kind 0 loads PNG/BMP; kind 1 loads JPEG.
            converted['kind'] = int(converted['mime_type'] == 'image/jpeg')
        elif kind in (2, 3, 4):
            converted.update(_fields(bg, ('color', 'color_a', 'color_b', 'x1', 'y1', 'x2', 'y2')))
        else:
            raise PivError('Unsupported legacy background kind')
        out['backgrounds'].append(converted)
    frames = document.get('keyframes')
    if not isinstance(frames, list) or not frames:
        raise PivError('Legacy migration requires at least one keyframe')
    frame_map, ticks = [], 0
    for original_index, frame in enumerate(frames):
        # Authored independent tracks can retain hidden source poses while the
        # legacy document is being materialized for its modern PIV export.
        hold = _integer(frame.get('duration_raw'), 'Legacy hold duration', 0, 65535)
        f = _fields(frame, ('background_id', 'background_id_b', 'background_mix', 'camera',
                           'object_draw_order', 'object_draw_order_unique_ids'))
        f['objects'] = []
        for obj in frame['objects']:
            o = _fields(obj, ('unique_id', 'figure_type_id', 'scale', 'field28', 'image_text_flags',
                'angles', 'root_x', 'root_y', 'len_flag', 'lengths', 'bend_flag', 'bends', 'join'))
            if o['figure_type_id'] not in mapping:
                raise PivError('Legacy object references an absent figure')
            o['figure_type_id'] = mapping[o['figure_type_id']]
            raw = _integer(obj.get('color_override_raw'), 'Legacy COLORREF', 0, 0xffffffff)
            o['color_override_raw'] = 0xff000000 | (0 if raw & 0x80000000 else raw & 0xffffff)
            o.setdefault('field28', 0)
            if any(not isinstance(a, (int, float)) or not math.isfinite(a) or abs(a) > 100 for a in o['angles']):
                raise PivError('Legacy angle-reset sentinels or non-finite angles cannot be migrated')
            f['objects'].append(o)
        indexes = []
        for duration in ([hold - 1, 1] if hold > 1 else [hold]):
            new = copy.deepcopy(f)
            indexes.append(len(out['keyframes']))
            new.update(keyframe_index=len(out['keyframes']), duration_raw=duration,
                       duration_frames=duration, inbetweens=duration - 1, duration_semantics='inbetweens')
            out['keyframes'].append(new)
        frame_map.append({'source_keyframe_index': original_index, 'keyframe_indexes': indexes})
        ticks += hold
    if len(out['keyframes']) > 1000000:
        raise PivError('Migrated project exceeds the keyframe count limit')
    delay = document.get('frame_delay_ms')
    out.update(total_output_frames=ticks, duration_seconds=ticks / fps)
    out['migration'] = {'source_version': version, 'figure_type_id_map': mapping,
        'keyframe_map': frame_map, 'held_pose_expansion': 'h > 1 becomes identical poses [h - 1, 1]',
        'source_frame_delay_ms': delay, 'target_frame_delay_ms': 1000 / fps,
        'preserves_native_export_fps': True,
        'interactive_interval_quantized': delay is not None and not math.isclose(delay, 1000 / fps),
        'notes': ['Legacy COLORREF is converted to an opaque modern color override.',
                  'All source figures, including the legacy default, are ordinary editable custom figures.',
                  'Pivot 5 stores integer FPS; legacy millisecond intervals retain their native rounded export FPS.']}
    _finite_tree(out)
    return out


def migrate_legacy_document(document: dict[str, Any]) -> dict[str, Any]:
    """Return an independent modern editable document with embedded media.

    Use ``migrate_legacy_bytes(source, document)`` when an API has materialized
    images to paths and omitted their inline bytes. Neither function reads those
    paths, fetches a URL, or modifies the caller's document or original source.
    """
    if not isinstance(document, dict):
        raise PivError('Legacy document must be an object')
    try:
        return _migrate(document)
    except (KeyError, TypeError, AttributeError, IndexError, ValueError, struct.error, OverflowError) as exc:
        if isinstance(exc, PivError):
            raise
        raise PivError(f'Cannot migrate legacy project: {exc}') from exc


def migrate_legacy_bytes(source: bytes, document: dict[str, Any] | None = None) -> bytes:
    """Serialize a separate Pivot 5 project from legacy source and optional edits."""
    original = decode_piv_bytes(source)
    if original['version'] not in (2, 3, 4):
        raise PivError('Legacy migration accepts Pivot versions 2, 3, and 4 only')
    if document is not None and not isinstance(document, dict):
        raise PivError('Legacy document must be an object')
    edited = copy.deepcopy(original if document is None else document)
    if edited.get('version') != original['version']:
        raise PivError('Edited document version does not match the original legacy source')
    if edited.get('source_sha256', original['source_sha256']) != original['source_sha256']:
        raise PivError('Edited document belongs to a different original source')
    try:
        _hydrate_from_original(edited, original)
    except (KeyError, TypeError, AttributeError, IndexError) as exc:
        raise PivError(f'Malformed legacy asset tables: {exc}') from exc
    modern = migrate_legacy_document(edited)
    # One empty keyframe, implicit modern figure slot, no background, easing off.
    scaffold = (struct.pack('<BIIHH', 5, modern['canvas_width'], modern['canvas_height'], 1, 2)
                + struct.pack('<IHBHHBI', 1, 1, 0, 0, 0, 1, modern['fps']) + b'\x01')
    return encode_piv_project(zlib.compress(scaffold), modern, force_rebuild=True)
