"""Allocation-conscious native PIV frame reader for the desktop codec process.

The canonical parser still reads the header, figures, assets and trailer. This
specialization reads precisely the same v5 frame grammar and returns precisely
the same ordinary dict/list model. It omits only scalar-editor bindings, which
the web backend's FastReader already omits, and batches adjacent numeric fields
through CPython's compiled struct decoder.
"""
from __future__ import annotations

import math
import struct
import threading

import piv_codec
import native_scan
from piv_codec import PivError


_COUNT = struct.Struct("<I")
_FRAME = struct.Struct("<HBH")
_SHORT = struct.Struct("<H")
_BYTE = struct.Struct("<B")
_OBJECT = struct.Struct("<IHfIB")
_JOIN = struct.Struct("<HH")
_CAMERA = struct.Struct("<ffdf")
_context = threading.local()
NATIVE_POSE_BUDGET = 2560 * 1024 * 1024


def decode_for_native_wire(source: bytes, *, source_path: str = "", assets_dir=None,
                           with_payload: bool = False) -> dict | tuple[dict, bytes | None]:
    """Validate a source and decode its assets without expanding native v5 poses.

    This report is exclusively for the negotiated native-frame transport. Its
    v5 keyframes contain only duration shells; the transport sends the original
    validated frame bytes. Normal JSON import/export must use decode_piv_bytes.
    Legacy inputs still receive their complete established decoded documents.
    With with_payload=True, returns (report, validated_v5_payload) so transport
    can reuse the already inflated bytes. Legacy payload is None. Both captures
    are thread local, restored on success/failure, and never retained globally.
    """
    previous = getattr(_context, "native_wire", False)
    previous_payload = getattr(_context, "payload", None)
    _context.native_wire = True
    _context.payload = None
    try:
        report = piv_codec.decode_piv_bytes(source, source_path=source_path, assets_dir=assets_dir)
        return (report, _context.payload) if with_payload else report
    finally:
        _context.native_wire = previous
        _context.payload = previous_payload


def scan_keyframes(reader, figures: list, bg_slots: int, *, max_pose_bytes: int | None = None) -> list:
    """Use the optional native validator, preserving the portable Python path."""
    maximum = NATIVE_POSE_BUDGET if max_pose_bytes is None else max_pose_bytes
    if isinstance(maximum, bool) or not isinstance(maximum, int) or maximum < 0:
        raise ValueError("Native pose budget must be a nonnegative integer")
    frames = native_scan.scan_keyframes(reader, figures, bg_slots, max_pose_bytes=maximum)
    if frames is not None:
        return frames
    return scan_keyframes_python(reader, figures, bg_slots, max_pose_bytes=maximum)


def scan_keyframes_python(reader, figures: list, bg_slots: int, *, max_pose_bytes: int | None = None) -> list:
    """Validate the complete v5 frame grammar without building editable poses.

    Per-frame identities and joins are retained just long enough to validate
    order, targets, cycles and outgoing interpolation. Numeric pose tuples are
    checked and discarded immediately; no float list, object dict or aliases
    are created for the browser to decode again from the original frame bytes.
    """
    max_pose_bytes = NATIVE_POSE_BUDGET if max_pose_bytes is None else max_pose_bytes
    if isinstance(max_pose_bytes, bool) or not isinstance(max_pose_bytes, int) or max_pose_bytes < 0:
        raise ValueError("Native pose budget must be a nonnegative integer")
    pose_bytes = 0
    data, pos = reader.data, reader.pos
    size, finite = len(data), math.isfinite
    types, arrays, orders = {}, {}, {}
    for figure in figures:
        count = figure["segment_count"]
        if count not in arrays:
            arrays[count] = (struct.Struct(f"<{count}dffH"),
                struct.Struct(f"<{count}fH"), struct.Struct(f"<{count}dB"))
        types[figure["figure_type_id"]] = (
            bool(figure.get("image_assets") or figure.get("text_assets")),
            {0, *(segment["segment_id"] for segment in figure["segments"])}, count, *arrays[count])

    def reserve_pose(byte_count):
        nonlocal pose_bytes
        pose_bytes += byte_count
        if pose_bytes > max_pose_bytes:
            raise PivError(f"Native scene exceeds the {max_pose_bytes // (1024 * 1024)} MiB pose budget")

    def take(decoder):
        nonlocal pos
        end = pos + decoder.size
        if end > size:
            raise PivError(f"Unexpected EOF at payload offset {pos:#x}")
        values = decoder.unpack_from(data, pos)
        pos = end
        return values

    try:
        count, = take(_COUNT)
        if count > 1000000:
            raise PivError(f"Implausible keyframe count {count} at {pos-4:#x}")
        reserve_pose(count * 512)
        frames, previous_types, previous_duration = [], {}, 0
        for fi in range(count):
            start = pos
            duration, mix, bg = take(_FRAME)
            bg_b = take(_SHORT)[0] if mix else None
            if bg >= bg_slots or (bg_b is not None and bg_b >= bg_slots):
                raise PivError(f"Unknown background in frame {fi} at {start:#x}")
            obj_count, = take(_SHORT)
            reserve_pose(obj_count * 512)
            identities, frame_types, join_slots, join_handles = [], [], [], []
            previous_signed_uid = -0x80000001
            for oi in range(obj_count):
                obj_start = pos
                uid, tid, scale, _color, _transparency = take(_OBJECT)
                descriptor = types.get(tid)
                if descriptor is None:
                    raise PivError(f"Unknown figure type {tid} in frame {fi}, object {oi} at {obj_start:#x}")
                if not finite(scale):
                    raise PivError(f"Non-finite /keyframes/{fi}/objects/{oi}/scale")
                signed_uid = uid if uid < 0x80000000 else uid - 0x100000000
                if signed_uid <= previous_signed_uid:
                    raise PivError(f"Object IDs must be unique and sorted as signed integers in frame {fi}")
                previous_signed_uid = signed_uid
                if previous_duration > 1:
                    prior_type = previous_types.get(uid)
                    if prior_type is not None and prior_type != tid:
                        raise PivError(f"Cannot interpolate a changed figure type for object {uid} in frame {fi-1}")
                has_media, _handles, sc, pose_struct, lengths_struct, bends_struct = descriptor
                if has_media:
                    take(_BYTE)
                reserve_pose(sc * 24)
                pose = take(pose_struct)
                if not all(map(finite, pose)):
                    raise PivError(f"Non-finite pose in frame {fi}, object {oi}")
                if pose[-1]:
                    reserve_pose(sc * 24)
                    lengths = take(lengths_struct)
                    if not all(map(finite, lengths)):
                        raise PivError(f"Non-finite lengths in frame {fi}, object {oi}")
                    bf = lengths[-1]
                else:
                    bf = take(_SHORT)[0]
                if bf:
                    reserve_pose(sc * 24)
                    bends = take(bends_struct)
                    if not all(map(finite, bends)):
                        raise PivError(f"Non-finite bends in frame {fi}, object {oi}")
                    join_flag = bends[-1]
                else:
                    join_flag = take(_BYTE)[0]
                if join_flag:
                    reserve_pose(64)
                    slot, handle = take(_JOIN)
                    if slot >= obj_count:
                        raise PivError(f"Invalid joined object slot {slot} in frame {fi}")
                    join_slots.append(slot)
                    join_handles.append(handle)
                else:
                    join_slots.append(-1)
                    join_handles.append(0)
                identities.append(uid)
                frame_types.append(tid)
            for oi, slot in enumerate(join_slots):
                if slot >= 0 and join_handles[oi] not in types[frame_types[slot]][1]:
                    raise PivError(f"Unknown joined target handle in frame {fi}")
            # 0 = unseen, 1 = current traversal, 2 = completed. Every vertex is
            # visited at most twice, including a 65,535-object join chain.
            checked = bytearray(obj_count)
            for oi in range(obj_count):
                cursor = oi
                while cursor >= 0 and checked[cursor] == 0:
                    checked[cursor] = 1
                    cursor = join_slots[cursor]
                if cursor >= 0 and checked[cursor] == 1:
                    raise PivError(f"Cyclic object joins in frame {fi}")
                cursor = oi
                while cursor >= 0 and checked[cursor] == 1:
                    checked[cursor] = 2
                    cursor = join_slots[cursor]
            order_decoder = orders.get(obj_count)
            if order_decoder is None:
                order_decoder = orders.setdefault(obj_count, struct.Struct(f"<{obj_count}H"))
            order = take(order_decoder)
            if sorted(order) != list(range(obj_count)):
                raise PivError(f"Invalid object draw-order permutation in frame {fi} at {pos:#x}")
            default, = take(_BYTE)
            if not default and not all(map(finite, take(_CAMERA))):
                raise PivError(f"Non-finite camera in frame {fi}")
            frames.append({"duration_raw": duration, "objects": []})
            previous_types = dict(zip(identities, frame_types)) if duration > 1 else {}
            previous_duration = duration
        return frames
    finally:
        reader.pos = pos


def read_keyframes(reader, figures: list, bg_slots: int) -> list:
    """Decode v5 keyframes with canonical bounds and semantic validation.

    The reader cursor is committed even on failure, matching the diagnostic
    convention of the original parser. Definitions have already been validated
    by the canonical figure reader, so their handle sets can be shared across
    every pose instead of being reconstructed for each joined object.
    """
    if getattr(_context, "native_wire", False):
        _context.payload = reader.data
        return scan_keyframes(reader, figures, bg_slots)
    data, pos = reader.data, reader.pos
    size = len(data)
    finite = math.isfinite
    types = {}
    arrays = {}
    for figure in figures:
        count = figure["segment_count"]
        if count not in arrays:
            arrays[count] = (struct.Struct(f"<{count}dffH"),
                struct.Struct(f"<{count}fH"), struct.Struct(f"<{count}dB"))
        types[figure["figure_type_id"]] = (count,
            bool(figure.get("image_assets") or figure.get("text_assets")),
            {0, *(segment["segment_id"] for segment in figure["segments"])},
            *arrays[count])

    def take(decoder):
        nonlocal pos
        end = pos + decoder.size
        if end > size:
            raise PivError(f"Unexpected EOF at payload offset {pos:#x}")
        values = decoder.unpack_from(data, pos)
        pos = end
        return values

    try:
        count, = take(_COUNT)
        if count > 1000000:
            raise PivError(f"Implausible keyframe count {count} at {pos-4:#x}")
        frames = []
        for fi in range(count):
            start = pos
            duration, mix, bg = take(_FRAME)
            bg_b = take(_SHORT)[0] if mix else None
            if bg >= bg_slots or (bg_b is not None and bg_b >= bg_slots):
                raise PivError(f"Unknown background in frame {fi} at {start:#x}")
            obj_count, = take(_SHORT)
            objects = []
            for oi in range(obj_count):
                obj_start = pos
                uid, tid, scale, color, transparency = take(_OBJECT)
                descriptor = types.get(tid)
                if descriptor is None:
                    raise PivError(f"Unknown figure type {tid} in frame {fi}, object {oi} at {obj_start:#x}")
                if not finite(scale):
                    raise PivError(f"Non-finite /keyframes/{fi}/objects/{oi}/scale")
                sc, has_media, _handles, pose_struct, lengths_struct, bends_struct = descriptor
                media_flags = take(_BYTE)[0] if has_media else None
                pose = take(pose_struct)
                # The final value is uint16 len_flag; every preceding value is
                # a float. map executes the finite predicate without a Python
                # generator frame per number, including subnormal/negative zero.
                if not all(map(finite, pose)):
                    raise PivError(f"Non-finite pose in frame {fi}, object {oi}")
                lf = pose[-1]
                if lf:
                    length_values = take(lengths_struct)
                    if not all(map(finite, length_values)):
                        raise PivError(f"Non-finite lengths in frame {fi}, object {oi}")
                    lengths, bf = list(length_values[:-1]), length_values[-1]
                else:
                    lengths, bf = [], take(_SHORT)[0]
                if bf:
                    bend_values = take(bends_struct)
                    if not all(map(finite, bend_values)):
                        raise PivError(f"Non-finite bends in frame {fi}, object {oi}")
                    bends, join_flag = list(bend_values[:-1]), bend_values[-1]
                else:
                    bends, join_flag = [], take(_BYTE)[0]
                join = None
                if join_flag:
                    slot, handle = take(_JOIN)
                    if slot >= obj_count:
                        raise PivError(f"Invalid joined object slot {slot} in frame {fi}")
                    join = {"target_object_slot": slot, "target_handle_id": handle}
                obj = {"object_slot": oi, "unique_id": uid, "figure_type_id": tid,
                    "scale": scale, "color_override_raw": color, "field28": transparency}
                if has_media:
                    obj["image_text_flags"] = media_flags
                obj.update(angles=list(pose[:sc]), root_x=pose[sc], root_y=pose[sc+1],
                    color_override_rgb=[color & 255, (color >> 8) & 255, (color >> 16) & 255],
                    color_override_mix=color >> 24, transparency=transparency,
                    opacity=1.-transparency/255., len_flag=lf, lengths=lengths,
                    bend_flag=bf, bends=bends, join=join, record_offset=obj_start, record_end=pos)
                objects.append(obj)
            for obj in objects:
                join = obj["join"]
                if join is not None:
                    target = objects[join["target_object_slot"]]
                    if join["target_handle_id"] not in types[target["figure_type_id"]][2]:
                        raise PivError(f"Unknown joined target handle in frame {fi}")
                    join["target_unique_id"] = target["unique_id"]
            # Joined figures form a directed forest. Memoizing completed paths
            # preserves cycle detection while making a long join chain O(n).
            checked = set()
            for oi in range(obj_count):
                cursor, pending = oi, set()
                while cursor not in checked:
                    if cursor in pending:
                        raise PivError(f"Cyclic object joins in frame {fi}")
                    pending.add(cursor)
                    join = objects[cursor]["join"]
                    if join is None:
                        break
                    cursor = join["target_object_slot"]
                checked.update(pending)
            unique_ids = [obj["unique_id"] for obj in objects]
            signed = lambda uid: uid if uid < 0x80000000 else uid - 0x100000000
            if len(set(unique_ids)) != len(unique_ids) or unique_ids != sorted(unique_ids, key=signed):
                raise PivError(f"Object IDs must be unique and sorted as signed integers in frame {fi}")
            order = list(take(struct.Struct(f"<{obj_count}H")))
            if sorted(order) != list(range(obj_count)):
                raise PivError(f"Invalid object draw-order permutation in frame {fi} at {pos:#x}")
            default, = take(_BYTE)
            camera = {"is_default": bool(default), "x": 0., "y": 0., "angle_rad": 0., "scale": 1.}
            if not default:
                values = take(_CAMERA)
                if not all(map(finite, values)):
                    raise PivError(f"Non-finite camera in frame {fi}")
                camera.update(zip(("x", "y", "angle_rad", "scale"), values))
            frames.append(dict(keyframe_index=fi, duration_raw=duration, inbetweens=duration-1,
                hidden=duration == 0, background_mix=mix, background_id=bg, background_id_b=bg_b,
                objects=objects, object_draw_order=order,
                object_draw_order_unique_ids=[objects[i]["unique_id"] for i in order],
                camera=camera, record_offset=start, record_end=pos))
        return frames
    finally:
        reader.pos = pos
