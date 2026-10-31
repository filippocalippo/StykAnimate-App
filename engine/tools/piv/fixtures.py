#!/usr/bin/env python3
"""Small generated Pivot files for the styk-piv tests.

The repository holds no Pivot files of its own and the real corpus is private,
so the crate's tests use these: every legacy version (2, 3, 4), a modern file
that exercises each record kind (images, text outlines, polygons, bends, layer
order, joins, cameras, an opaque trailer), files that need recovery (duplicate
object IDs, image records without pixels), and STK figures in each container.

Each file is assembled field by field from the grammar the Python decoders read
(`codecs/piv_codec.py`, `piv_legacy_v2.py`, `piv_legacy_v4.py`,
`piv_side_tables.py`), not exported by the codec under test, and checked here
against the Python decoder before it is written.

Beside the files it writes what the Python codec answers, which the Rust tests
compare against without needing Python: `expected.json` (document fingerprints
and export hashes per file, and the PNG bytes of keyed legacy sprites) and
`upgraded-legacy-v*.json` (the version 5 document the editor makes of each
legacy fixture).

    .venv/bin/python engine/tools/piv/fixtures.py            # regenerate
    .venv/bin/python engine/tools/piv/fixtures.py --check    # verify the committed files
"""
from __future__ import annotations

import base64
import copy
import decimal
import hashlib
import json
import struct
import sys
import zlib
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
OUT = REPO / "engine/crates/styk-piv/tests/fixtures"


def png(width, height, rgba_rows):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    rows = b"".join(b"\0" + bytes(row) for row in rgba_rows)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


def small_png():
    return png(3, 2, [[255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0], [10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255]])


def jpeg():
    # APP metadata holding a false end marker, two scans, stuffed bytes and a restart marker.
    return (b"\xff\xd8\xff\xe1\x00\x08meta\xff\xd9" b"\xff\xda\x00\x02abc\xff\x00\xd9\xff\xd0def"
            b"\xff\xc4\x00\x04hi\xff\xda\x00\x02xyz\xff\xd9")


def bmp24(width, height, pixel, top_down=False):
    stride = (width * 3 + 3) // 4 * 4
    rows = bytearray()
    for y in range(height):
        row = bytearray(stride)
        for x in range(width):
            r, g, b = pixel(x, y)
            row[x * 3:x * 3 + 3] = bytes((b, g, r))
        rows += row
    offset = 54
    return (struct.pack("<2sIHHI", b"BM", offset + len(rows), 0, 0, offset)
            + struct.pack("<IiiHHIIiiII", 40, width, -height if top_down else height, 1, 24, 0, len(rows), 2835, 2835, 0, 0) + bytes(rows))


def bmp8(width, height, palette, index):
    stride = (width + 3) // 4 * 4
    rows = bytearray()
    for y in range(height):
        row = bytearray(stride)
        for x in range(width):
            row[x] = index(x, y)
        rows += row
    table = b"".join(bytes((b, g, r, 0)) for r, g, b in palette)
    offset = 54 + len(table)
    return (struct.pack("<2sIHHI", b"BM", offset + len(rows), 0, 0, offset)
            + struct.pack("<IiiHHIIiiII", 40, width, height, 1, 8, 0, len(rows), 2835, 2835, len(palette), 0) + table + bytes(rows))


KEY = (10, 200, 30)
KEY_RAW = KEY[0] | KEY[1] << 8 | KEY[2] << 16


def checker(x, y):
    return KEY if (x + y) % 3 == 0 else ((x * 40) % 256, (y * 60) % 256, 128)


def legacy_segment(parent, sid, length, angle, thickness, primitive=0, static=0, unused=0, reserved=0):
    return struct.pack("<BBHfdfBBH", parent, sid, unused, length, angle, thickness, primitive, static, reserved)


def str8(text):
    data = text.encode("cp1252")
    return bytes([len(data)]) + data


# Legacy version 2 and 3 ------------------------------------------------------------

def compact_bitmap(mode, width, height, key, pixel):
    """Column-major pixels: 8-bit palette (mode 3) or 24-bit BGR."""
    out = bytearray(struct.pack("<BHHI", mode, width, height, key))
    if mode == 3:
        palette = [KEY, (255, 0, 0), (0, 0, 255), (240, 240, 240)]
        for x in range(width):
            for y in range(height):
                out.append((x * 2 + y) % len(palette))
        table = bytearray(1024)
        for i, (r, g, b) in enumerate(palette):
            table[i * 4:i * 4 + 3] = bytes((r, g, b))
        out += table
    else:
        for x in range(width):
            for y in range(height):
                r, g, b = pixel(x, y)
                out += bytes((b, g, r))
    return bytes(out)


def v2_figures():
    """Two custom figures (types 2 and 3): lines and circles, then one with two sprites."""
    plain = bytes([4]) + legacy_segment(0, 1, 40.0, -1.25, 9.0) + legacy_segment(1, 2, 25.5, 0.5, 6.0, 1) \
        + legacy_segment(1, 3, 30.0, 2.0, 0.005, 0, 1) + legacy_segment(3, 4, 12.0, -0.5, 4.0, 3) + str8("Walker")
    sprite = bytes([3]) + legacy_segment(0, 1, 50.0, 0.0, 8.0) + legacy_segment(1, 2, 20.0, 1.0, 5.0, 2) + bytes([1]) \
        + legacy_segment(1, 3, 22.0, -1.0, 5.0, 2) + bytes([0])
    sprite += bytes([2]) + compact_bitmap(3, 5, 4, KEY_RAW, checker) + compact_bitmap(1, 3, 3, KEY_RAW, checker) + str8("Sprité")
    return plain + sprite


def v2_object(type_id, scale, color, angles, x, y, flags=None):
    out = struct.pack("<BfI", type_id, scale, color)
    if flags is not None:
        out += bytes([flags])
    return out + struct.pack(f"<{len(angles)}d", *angles) + struct.pack("<ff", x, y)


BUILTIN_V2 = [1.5, 1.5, 2.25, 0.78, 2.1, 1.05, 1.96, 1.18, 1.96, 1.18]
BUILTIN_V3 = [-1.57, -1.57, -1.57, 1.57, 2.35, 0.78, 2.09, 1.04, 1.96, 1.17, 1.96, 1.17]


def legacy_v2(background=True):
    p = bytearray(struct.pack("<BBII", 2, int(background), 480, 360))
    if background:
        p += b"\0" + bmp24(4, 3, lambda x, y: (x * 60, y * 80, 200))
    p += bytes([4]) + v2_figures()
    frames = [
        [v2_object(1, 1.0, 0, BUILTIN_V2, 120.0, 200.0), v2_object(2, 0.75, 0x0000FF, [-1.25, 0.5, 2.0, -0.5], 300.5, 150.25)],
        [v2_object(3, 1.5, 0x80000000, [0.0, 1.0, -1.0], 60.0, 90.0, 1)],
        [],
        [v2_object(2, 1.0, 0x112233, [-1.0, 0.25, 1.75, -0.75], 310.0, 160.0), v2_object(1, 1.0, 0xFFFFFFFF, [a + 0.1 for a in BUILTIN_V2], 130.0, 205.0),
         v2_object(3, 1.0, 0, [0.1, 0.9, -1.1], 62.0, 91.0, 0)],
    ]
    p += struct.pack("<I", len(frames))
    for objects in frames:
        p += bytes([len(objects)]) + b"".join(objects)
    return bytes(p)


def legacy_v3(tail=1):
    p = bytearray(struct.pack("<BII", 3, 500, 400))
    p += bytes([3]) + b"\0" + bmp8(5, 4, [KEY, (0, 0, 0), (255, 255, 255)], lambda x, y: (x + y) % 3) + str8("Paper")
    body = jpeg()
    p += b"\1" + struct.pack("<Q", len(p) + 1 + 8 + len(body)) + body + str8("Photo")
    p += bytes([4]) + v2_figures()
    frames = [
        (1, 0, [v2_object(1, 1.0, 0, BUILTIN_V3, 100.0, 220.0)]),
        (4, 1, [v2_object(2, 1.25, 0x00FF00, [-1.25, 0.5, 2.0, -0.5], 250.0, 180.0), v2_object(3, 1.0, 0, [0.0, 1.0, -1.0], 70.0, 95.0, 1)]),
        (0, 2, []),
        (2, 2, [v2_object(1, 0.5, 0x123456, [a - 0.2 for a in BUILTIN_V3], 110.0, 225.0)]),
    ]
    p += struct.pack("<I", len(frames))
    for duration, bg, objects in frames:
        p += struct.pack("<HBB", duration, bg, len(objects)) + b"".join(objects)
    p += struct.pack("<I", 77)
    if tail is not None:
        p += bytes([tail])
    return bytes(p)


# Legacy version 4 ------------------------------------------------------------------

def legacy_v4():
    p = bytearray(struct.pack("<BIIB", 4, 640, 480, 3))
    p += b"\0" + bmp24(3, 2, lambda x, y: (200, x * 100, y * 100)) + str8("Board")
    body = jpeg() + b"old data after the image\xff\xd9"
    p += b"\1" + struct.pack("<Q", len(p) + 1 + 8 + len(body)) + body + str8("Sky")
    p += struct.pack("<H", 4)
    # Figure 2: lines, a circle and a static node.
    p += bytes([4]) + legacy_segment(0, 1, 45.0, -1.5, 10.0, 0, 0, 7) + legacy_segment(1, 2, 20.0, 0.4, 6.0, 1) \
        + legacy_segment(1, 3, 33.0, 2.2, 0.004, 0, 1, 0, 9) + legacy_segment(3, 4, 14.0, -0.3, 5.0, 6) + str8("Runner")
    # Figure 3: two sprites, 24-bit (top-down) and 8-bit palette, colour keyed.
    p += bytes([3]) + legacy_segment(0, 1, 60.0, 0.0, 8.0) + legacy_segment(1, 2, 25.0, 1.0, 5.0, 2) + bytes([1, 1]) \
        + legacy_segment(2, 3, 18.0, -1.0, 5.0, 2) + bytes([0, 0])
    p += bytes([2]) + struct.pack("<I", KEY_RAW) + bmp24(5, 3, checker, top_down=True)
    p += struct.pack("<I", KEY_RAW) + bmp8(6, 4, [KEY, (255, 0, 0), (0, 0, 255), (9, 9, 9)], lambda x, y: (x + 2 * y) % 4) + str8("Banner")

    def obj(uid, tid, scale, color, alpha, angles, x, y, lengths=None, join=None, flags=None):
        out = struct.pack("<IHfIB", uid, tid, scale, color, alpha)
        if flags is not None:
            out += bytes([flags])
        out += struct.pack(f"<{len(angles)}d", *angles) + struct.pack("<ff", x, y)
        out += bytes([1 if lengths else 0]) + (struct.pack(f"<{len(lengths)}f", *lengths) if lengths else b"")
        return out + (b"\1" + struct.pack("<HB", *join) if join else b"\0")

    frames = [
        (1, 0, [obj(1, 1, 1.0, 0, 0, BUILTIN_V3, 320.0, 240.0)], [0]),
        (3, 1, [obj(1, 1, 1.0, 0x0000FF, 40, [a + 0.05 for a in BUILTIN_V3], 322.0, 241.0),
                obj(2, 2, 0.8, 0x80000000, 0, [-1.5, 0.4, 2.2, -0.3], 0.0, 0.0, [45.5, 20.25, 33.0, 14.0], (0, 4)),
                obj(0xFFFFFFF0, 3, 1.2, 0x336699, 255, [0.0, 1.0, -1.0], 500.0, 100.0, None, None, 1)], [2, 0, 1]),
        (65535, 2, [obj(7, 3, 1.0, 0, 0, [0.2, 0.8, -0.8], 480.0, 110.0, [60.0, 26.0, 18.5], None, 0),
                    obj(8, 2, 1.0, 0, 0, [-1.4, 0.3, 2.1, -0.2], 5.0, 6.0, None, (0, 1))], [1, 0]),
        (2, 0, [], []),
    ]
    p += struct.pack("<I", len(frames))
    for duration, bg, objects, order in frames:
        p += struct.pack("<HBH", duration, bg, len(objects)) + b"".join(objects) + struct.pack(f"<{len(order)}H", *order)
    p += struct.pack("<I", 66) + b"\1"
    return bytes(p)


# Modern (version 5) ----------------------------------------------------------------

def utf16(text):
    data = text.encode("utf-16-le")
    return struct.pack("<I", len(data) // 2) + data


def glyph(commands):
    """Outline: node count, opcodes two per byte (low nibble first), then coordinates."""
    codes = ["MLCZVH".index(op) for op, _ in commands]
    out = bytearray(struct.pack("<I", sum(3 if c == 2 else 1 for c in codes)))
    for i in range(0, len(codes), 2):
        out.append(codes[i] | (codes[i + 1] << 4 if i + 1 < len(codes) else 0))
    for _, values in commands:
        out += struct.pack(f"<{len(values)}f", *values)
    return bytes(out)


def text_record(font, style, alignment, text, glyphs, placements):
    out = utf16(font) + struct.pack("<BI", style, alignment) + utf16(text) + bytes([len(glyphs)])
    out += b"".join(glyphs)
    units = struct.unpack(f"<{len(text.encode('utf-16-le')) // 2}H", text.encode("utf-16-le"))
    unique = list(dict.fromkeys(units))
    for unit, (x, y) in zip(units, placements):
        if glyphs[unique.index(unit)][:4] != b"\0\0\0\0":
            out += struct.pack("<ff", x, y)
    return out


def modern_frame(objects, *, duration=1, bg=0, mix=0, bg_b=0, order=None, camera=None):
    data = bytearray(struct.pack("<HBH", duration, mix, bg))
    if mix:
        data += struct.pack("<H", bg_b)
    data += struct.pack("<H", len(objects))
    for o in objects:
        data += struct.pack("<IHfIB", o["uid"], o["tid"], o.get("scale", 1.0), o.get("color", 0), o.get("alpha", 0))
        if "media" in o:
            data += bytes([o["media"]])
        angles = o["angles"]
        data += struct.pack(f"<{len(angles)}d", *angles) + struct.pack("<ff", o.get("x", 0.0), o.get("y", 0.0))
        lengths, bends = o.get("lengths"), o.get("bends")
        data += struct.pack("<H", o.get("lf", 1) if lengths else 0) + (struct.pack(f"<{len(lengths)}f", *lengths) if lengths else b"")
        data += struct.pack("<H", o.get("bf", 1) if bends else 0) + (struct.pack(f"<{len(bends)}d", *bends) if bends else b"")
        join = o.get("join")
        data += b"\1" + struct.pack("<HH", *join) if join else b"\0"
    order = list(range(len(objects))) if order is None else order
    data += struct.pack(f"<{len(objects)}H", *order)
    data += b"\1" if camera is None else b"\0" + struct.pack("<ffdf", *camera)
    return bytes(data)


MAN = [-1.5707963267948968, -1.5707963267948968, -1.5707963267948968, 1.5707963267948966, 2.356194490192345, 0.7853981633974483,
       2.0943951023931957, 1.0471975511965979, 1.9634954084936207, 1.1780972450961724, 1.9634954084936207, 1.1780972450961724]


def modern_media(compressed=True, wide=False):
    """Every record kind of the version 5 grammar in one small project.

    `wide` stores integers between 2^53 and 2^64, which JavaScript spells with
    padded digits: a client's document then never fingerprints as the source.
    """
    p = bytearray(struct.pack("<BII", 5, 800, 600))
    # Backgrounds: image, colour, two gradients.
    p += struct.pack("<H", 5)
    image = small_png()
    p += b"\0" + struct.pack("<Q", len(p) + 1 + 8 + len(image)) + image + str8("Photo")
    p += b"\2" + struct.pack("<I", 0x00336699) + str8("Blue")
    p += b"\3" + struct.pack("<IIffff", 0x00FF0000, 0x000000FF, 0.0, 0.0, 1.0, 1.0) + str8("Lin€ar")
    p += b"\4" + struct.pack("<IIffff", 0x00102030, 0x00405060, 0.5, 0.25, -0.0, 0.75) + str8("")
    p += struct.pack("<H", 6)
    # Figure 2: everything explicit (flags 0): sparse joint IDs, colours, secondary paint, polygons, bends, layers.
    segs = [  # parent, id, length, angle, thickness, primitive, aux, rgb, transparency, secondary
        (0, 5, 40.0, -1.25, 9.0, 0, 0, (10, 20, 30), 0, None),
        (5, 9, 25.5, 0.5, 6.0, 1, 1, (200, 0, 0), 64, ((1, 2, 3), 4)),
        (5, 2, 30.0, 2.0, 0.005, 3, 0, (0, 200, 0), 0, None),
        (2, 7, 12.0, -0.5, 4.0, 6, 2, (0, 0, 200), 255, ((255, 254, 253), 0)),
        (9, 12, 18.0, 1.1, 3.0, 4, 0, (9, 9, 9), 1, None),
    ]
    p += struct.pack("<BH", 0, len(segs))
    for parent, sid, length, angle, thick, prim, aux, rgb, alpha, secondary in segs:
        p += struct.pack("<HHfdfBB", parent, sid, length, angle, thick, prim, aux) + bytes(rgb) + bytes([alpha])
        p += b"\0" if secondary is None else b"\1" + bytes(secondary[0]) + bytes([secondary[1]])
    p += struct.pack("<H", 2) + struct.pack("<Hd", 1, 0.35) + struct.pack("<Hd", 4, -0.2)
    p += struct.pack("<H", 2)
    p += struct.pack("<H", 3) + bytes((1, 2, 3)) + bytes([128]) + struct.pack("<3H", 5, 9, 2)
    p += struct.pack("<H", 4) + bytes((250, 240, 230)) + bytes([0]) + struct.pack("<4H", 0, 7, 12, 5)
    p += struct.pack("<5H", 6, 0, 4, 2, 5) + struct.pack("<2H", 1, 3)
    p += str8("Explicit")
    # Figure 3: implicit everything (lines, default paint, sequential IDs and layers).
    p += struct.pack("<BH", 1 | 2 | 4 | 8 | 16 | 32 | 128, 3)
    for parent, length, angle in ((0, 50.0, 0.0), (1, 20.0, 1.0), (2, 22.0, -1.0)):
        p += struct.pack("<HfdF".replace("F", "f"), parent, length, angle, 5.0)
    p += struct.pack("<H", 0) + struct.pack("<H", 0) + str8("Implicit")
    # Figure 4: an image and a text segment, an outline style, sequential IDs.
    p += struct.pack("<BH", 2 | 4 | 8 | 32 | 64 | 128, 4)
    for parent, length, angle, thick, prim in ((0, 60.0, 0.0, 8.0, 0), (1, 25.0, 1.0, 5.0, 2), (1, 30.0, -1.0, 5.0, 5), (3, 10.0, 0.5, 2.0, 2)):
        p += struct.pack("<HfdfB", parent, length, angle, thick, prim)
        if prim in (2, 5):
            p += struct.pack("<HBB", 1 if prim == 2 and parent == 3 else 0, int(prim == 5), int(parent == 3))
    p += struct.pack("<H", 0)
    p += struct.pack("<H", 2)
    for anchors in ((0, 200, 300, 200), (-5, 7, 40, -33)):
        p += struct.pack("<iiii", *anchors)
        p += struct.pack("<Q", len(p) + 8 + len(image)) + image
    a = glyph([("M", (1.0, 2.0)), ("L", (3.5, 2.0)), ("C", (4.0, 2.5, 4.5, 3.0, 5.0, 3.5)), ("H", (0.5,)), ("V", (-1.25,)), ("Z", ())])
    b = glyph([("M", (0.0, 0.0)), ("L", (2.0, 4.0)), ("Z", ())])
    space = glyph([])
    p += struct.pack("<H", 1) + text_record("Arial", 5, 1, "ab aé", [a, b, space, glyph([("M", (9.0, 9.0)), ("L", (1e-5, 123456.75))])],
                                            [(32768.0, 10.0), (32775.5, 10.0), (0, 0), (32790.25, 10.0), (32800.0, -2.5)])
    p += struct.pack("<H", 0)
    p += struct.pack("<4H", 3, 2, 1, 0)
    p += struct.pack("<f", 1.5) + bytes((7, 8, 9)) + bytes([32]) + str8("Media")
    # Figure 5: one segment (a figure every key can switch to).
    p += struct.pack("<BH", 1 | 2 | 4 | 8 | 16 | 32 | 128, 1) + struct.pack("<Hfdf", 0, 15.0, 0.25, 3.0) + struct.pack("<HH", 0, 0) + str8("Dot")
    explicit = [-1.25, 0.5, 2.0, -0.5, 1.1]
    frames = [
        modern_frame([{"uid": 1, "tid": 1, "angles": MAN, "x": 400.0, "y": 300.0}], duration=3),
        modern_frame([{"uid": 1, "tid": 1, "angles": [a + 0.1 for a in MAN], "x": -0.0, "y": 300.5, "scale": 1.25, "color": 0x80FF8040, "alpha": 3},
                      {"uid": 0xFFFFFFFF, "tid": 2, "angles": explicit, "x": 100.0, "y": 80.0, "lengths": [40.5, 25.0, 30.0, 12.0, 18.25], "lf": 65535,
                       "bends": [0.0, 0.35, -0.0, 0.0, -0.2], "bf": 37, "join": (0, 12)},
                      {"uid": 0, "tid": 4, "media": 1, "angles": [0.0, 1.0, -1.0, 0.5], "x": 500.0, "y": 100.0, "join": (1, 9)},
                      {"uid": 0x80000000, "tid": 3, "angles": [0.0, 1.0, -1.0], "x": 60.0, "y": 90.0}],
                     duration=0, bg=1, mix=1, bg_b=3, order=[3, 0, 2, 1], camera=(12.5, -4.0, 0.25, 1.5)),
        modern_frame([], duration=65535, bg=4),
        modern_frame([{"uid": 0xFFFFFFFF, "tid": 5, "angles": [1e-300], "x": 1e-35, "y": 2.0},
                      # Values whose JSON text differs between Python and JavaScript: beyond 2^53 and beyond 1e21.
                      {"uid": 7, "tid": 5, "angles": [-1e25], "x": 1e18 if wide else 1e20, "y": -3e30,
                       "scale": 2.0 ** 60 + 2.0 ** 37 if wide else 16777216.0, "lengths": [9007199254740992.0]},
                      {"uid": 1, "tid": 4, "media": 255, "angles": [0.1, 0.9, -1.1, 0.4], "x": 510.0, "y": 105.0}], bg=2, camera=(-0.0, 13.0, -1.5, 0.75)),
    ]
    p += struct.pack("<I", len(frames)) + b"".join(frames)
    p += struct.pack("<I", 33) + b"\0\xffopaque trailer bytes"
    return zlib.compress(bytes(p)) if compressed else bytes(p)


def modern_identities():
    """Duplicate object IDs inside keyframes (the reader renames the extra occurrences)."""
    p = bytearray(struct.pack("<BIIHH", 5, 640, 480, 1, 2))
    rows = [(0xFFFFFFFF, 10, 10, 10, 0, 0x80000000), (0xFFFFFFFF, 10, 10, 10, 0, 0x80000000),
            (1, 2, 3, 0, 0x80000000, 0xFFFFFFFF), (10, 20, 30, 40, 50, 60)]
    frames = []
    for fi, (ids, duration) in enumerate(zip(rows, (4, 0, 3, 1))):
        objects = [{"uid": uid, "tid": 1, "angles": MAN, "x": 100.0 + 60 * slot + fi, "y": 200.0,
                    **({"join": (2, 1)} if slot == 4 else {})} for slot, uid in enumerate(ids)]
        frames.append(modern_frame(objects, duration=duration, order=[4, 1, 5, 0, 3, 2]))
    p += struct.pack("<I", len(frames)) + b"".join(frames) + struct.pack("<IB", 24, 1)
    return zlib.compress(bytes(p))


def modern_missing_image(mode):
    """An image record without pixels: its end pointer unpatched, omitted, or empty."""
    flags = 190
    p = bytearray(struct.pack("<BIIHH", 5, 320, 240, 1, 3))
    p += struct.pack("<BH", flags, 1) + struct.pack("<HfdfB", 0, 50.0, 0.0, 1.0, 2) + struct.pack("<HBBHH", 0, 0, 0, 0, 1)
    p += struct.pack("<iiii", 0, 200, 300, 200)
    pointer = len(p)
    if mode != "omitted":
        p += struct.pack("<Q", pointer if mode == "unpatched" else pointer + 8)
    p += b"\0\0" + str8("Empty image")
    p += struct.pack("<I", 1) + modern_frame([{"uid": 77, "tid": 2, "media": 5, "angles": [-0.0], "x": 150.0, "y": 20.0}])
    p += struct.pack("<IB", 24, 0)
    return bytes(p) if mode == "omitted" else zlib.compress(bytes(p))


def modern_type_change():
    """One object ID that changes to a differently sized figure between keys."""
    p = bytearray(struct.pack("<BIIHH", 5, 640, 480, 1, 3))
    p += struct.pack("<BH", 1 | 2 | 4 | 8 | 16 | 32 | 128, 1) + struct.pack("<Hfdf", 0, 32.0, -1.5, 14.0) + struct.pack("<HH", 0, 0) + str8("Replacement")
    frames = []
    for index, duration in enumerate((4, 3, 1)):
        tid = 1 if index == 0 else 2
        frames.append(modern_frame([
            {"uid": 10, "tid": tid, "angles": MAN if tid == 1 else [-1.5], "x": 150.0 + index * 40, "y": 240.0},
            {"uid": 20, "tid": 2, "angles": [-1.5], "x": 350.0 + index * 40, "y": 240.0, "lengths": [32.0], "bends": [0.0]},
            {"uid": 30, "tid": 2, "angles": [-1.5], "x": 0.0, "y": 240.0, "join": (0, 1)}], duration=duration, order=[2, 0, 1]))
    p += struct.pack("<I", len(frames)) + b"".join(frames) + struct.pack("<IB", 24, 1)
    return zlib.compress(bytes(p))


def blank():
    p = struct.pack("<BIIHH", 5, 640, 480, 1, 2) + struct.pack("<IHBHHBI", 1, 1, 0, 0, 0, 1, 24) + b"\x01"
    return zlib.compress(p)


# STK figures -----------------------------------------------------------------------

def stk_modern():
    """A modern figure stream: explicit joint IDs with a parent that appears later, and bends."""
    segments = [(2, 1, 20.0, 0.3, 0.0), (0, 2, 35.5, -1.2, 0.25), (2, 7, 12.25, 2.0, 0.0), (7, 4, 9.0, 0.0, -0.4)]
    payload = bytearray(struct.pack("<BH", 1 | 2 | 4 | 8 | 16 | 128, len(segments)))
    for parent, sid, length, angle, _ in segments:
        payload += struct.pack("<HHfdf", parent, sid, length, angle, 4.0)
    bends = [(i, bend) for i, (*_, bend) in enumerate(segments) if bend]
    payload += struct.pack("<H", len(bends)) + b"".join(struct.pack("<Hd", i, b) for i, b in bends) + struct.pack("<H", 0)
    return b"\x79" + zlib.compress(bytes(payload))


def stk_media():
    """A modern figure stream with an image, a text and an outline style."""
    image = small_png()
    p = bytearray(struct.pack("<BH", 2 | 4 | 8 | 16 | 32 | 64 | 128, 3))
    for parent, length, angle, thick, prim in ((0, 60.0, 0.0, 8.0, 0), (1, 25.0, 1.0, 5.0, 2), (1, 30.0, -1.0, 5.0, 5)):
        p += struct.pack("<HfdfB", parent, length, angle, thick, prim)
        if prim in (2, 5):
            p += struct.pack("<HBB", 0, 0, 1)
    p += struct.pack("<H", 0) + struct.pack("<H", 1) + struct.pack("<iiii", 0, 10, 20, 10) + struct.pack("<Q", len(p) + 2 + 2 + 16 + 8 + len(image)) + image
    p += struct.pack("<H", 1) + text_record("Segoe UI", 0, 0, "Hi", [glyph([("M", (0.0, 0.0)), ("L", (0.0, 8.0)), ("Z", ())]),
                                                                    glyph([("M", (1.0, 0.0)), ("V", (6.0,))])], [(0.0, 0.0), (5.0, 0.0)])
    p += struct.pack("<H", 0) + struct.pack("<f", 2.0) + bytes((1, 2, 3)) + bytes([0])
    return b"\x7a" + zlib.compress(bytes(p))


def stk_legacy_records():
    return [legacy_segment(0, 1, 40.0, -1.5, 9.0), legacy_segment(1, 2, 25.5, 0.5, 6.0, 1), legacy_segment(1, 3, 30.0, 2.0, 0.005, 0, 1),
            legacy_segment(3, 4, 12.0, -0.5, 4.0, 3, 0, 0x0100)]


def stk_legacy(layout):
    records = stk_legacy_records()
    body = bytes([len(records)]) + b"".join(records)
    if layout == "count":
        return body
    if layout == "version":
        return b"\x01" + body
    return b"\x79" + zlib.compress(body)


FILES = {
    "blank.piv": blank,
    "legacy-v2.piv": legacy_v2,
    "legacy-v2-no-background.piv": lambda: zlib.compress(legacy_v2(False)),
    "legacy-v3.piv": legacy_v3,
    "legacy-v3-zlib.piv": lambda: zlib.compress(legacy_v3(None)),
    "legacy-v4.piv": lambda: zlib.compress(legacy_v4()),
    "legacy-v4-raw.piv": legacy_v4,
    "modern-media.piv": modern_media,
    "modern-media-raw.piv": lambda: modern_media(False),
    "modern-wide-integers.piv": lambda: modern_media(wide=True),
    "modern-identities.piv": modern_identities,
    "modern-missing-image-unpatched.piv": lambda: modern_missing_image("unpatched"),
    "modern-missing-image-omitted.piv": lambda: modern_missing_image("omitted"),
    "modern-missing-image-empty.piv": lambda: modern_missing_image("empty"),
    "modern-type-change.piv": modern_type_change,
    "figure-modern.stk": stk_modern,
    "figure-media.stk": stk_media,
    "figure-legacy-count.stk": lambda: stk_legacy("count"),
    "figure-legacy-version.stk": lambda: stk_legacy("version"),
    "figure-legacy-zlib.stk": lambda: stk_legacy("zlib"),
}


def verify(name, data):
    """The Python codec must read every fixture."""
    sys.path.insert(0, str(REPO / "backend"))
    import browser_service
    status, _, body = browser_service.BrowserCodec().request("POST", "/api/import?filename=" + name, None, data)
    if status != 200:
        raise SystemExit(f"{name}: the Python codec rejects it: {body[:300]!r}")


# What the Python codec answers ------------------------------------------------------

def js_numbers(value):
    """The document as a JavaScript client sends it back: `JSON.parse` then `JSON.stringify`.

    Every number is a double. An integer below 1e21 is written as plain digits (the
    shortest digits that round-trip, padded with zeros, so not its exact value above
    2^53); negative zero is written `0`; from 1e21 on the text is in exponent form.
    """
    if type(value) is float:
        if value.is_integer() and abs(value) < 1e21:
            return int(value) if abs(value) < 2 ** 53 else int(decimal.Decimal(repr(value)))
        return value
    if type(value) is int and not -2 ** 53 < value < 2 ** 53:
        return js_numbers(float(value))
    if isinstance(value, dict):
        return {key: js_numbers(item) for key, item in value.items()}
    if isinstance(value, list):
        return [js_numbers(item) for item in value]
    return value


class Lcg:
    """A generator the Rust tests repeat exactly (`tests/common`)."""

    def __init__(self, seed):
        self.state = seed

    def below(self, limit):
        self.state = (self.state * 6364136223846793005 + 1442695040888963407) & 0xFFFFFFFFFFFFFFFF
        return (self.state >> 33) % limit


def keyed_bmp(rng, width, height, bits, top_down, share):
    """A colour-keyed sprite bitmap: `share` percent of its pixels are the key colour."""
    stride = ((width * bits + 31) // 32) * 4
    palette = b""
    if bits <= 8:
        colors = [KEY]
        for _ in range((1 << bits) - 1):
            red = rng.below(256)
            green = rng.below(256)
            colors.append((red, green, rng.below(256)))
        palette = b"".join(bytes((b, g, r, 0)) for r, g, b in colors)
    rows = bytearray()
    for _ in range(height):
        row = bytearray(stride)
        for x in range(width):
            keyed = rng.below(100) < share
            if bits <= 8:
                index = 0 if keyed else rng.below(1 << bits)
                row[x * bits // 8] |= index << (8 - bits - (x * bits % 8))
            else:
                red, green, blue = KEY
                if not keyed:
                    red = rng.below(256)
                    green = rng.below(256)
                    blue = rng.below(256)
                at = x * (bits // 8)
                row[at:at + 3] = bytes((blue, green, red))
                if bits == 32:
                    row[at + 3] = rng.below(256)
        rows += row
    offset = 54 + len(palette)
    return (struct.pack("<2sIHHI", b"BM", offset + len(rows), 0, 0, offset)
            + struct.pack("<IiiHHIIiiII", 40, width, -height if top_down else height, 1, bits, 0, len(rows), 2835, 2835, 0, 0)
            + palette + bytes(rows))


def keyed_bitmap_digest():
    """SHA-256 over the PNG the legacy reader makes of each generated sprite, in order."""
    import piv_legacy
    rng, digest = Lcg(4), hashlib.sha256()
    for bits in (1, 4, 8, 24, 32):
        for width in (1, 3, 7, 16, 33):
            for height in (1, 5):
                for top_down in (False, True):
                    for share in (0, 40, 100):
                        asset = {"data_uri": "data:image/bmp;base64," + base64.b64encode(keyed_bmp(rng, width, height, bits, top_down, share)).decode("ascii"),
                                 "transparency_color_raw": KEY_RAW}
                        piv_legacy._keyed_bitmap_png(asset)
                        digest.update(base64.b64decode(asset["data_url"].split(",", 1)[1]))
    return digest.hexdigest()


def expectations():
    """Facts about each fixture as the Python codec reports them, for tests that run without Python.

    Per file: the fingerprint of its decoded document, and the SHA-256 of three
    exports a JavaScript client would ask for (unchanged; frame rate and first
    object moved; first custom segment lengthened, as a figure file).
    """
    sys.path.insert(0, str(REPO / "backend"))
    import browser_service

    def sha(data):
        return hashlib.sha256(data).hexdigest()

    files = {}
    for name, build in FILES.items():
        data, kind = build(), name.rsplit(".", 1)[1]
        codec = browser_service.BrowserCodec()

        def export(document, format, figure=None):
            request = {"document": js_numbers(document), "format": format, "sourceId": imported["sourceId"]}
            if figure is not None:
                request["figureTypeId"] = figure
            status, _, body = codec.request("POST", "/api/export", None, json.dumps(request, separators=(",", ":")).encode())
            return sha(body) if status == 200 else f"{status} {json.loads(body)['code']}"

        imported = json.loads(codec.request("POST", "/api/import?filename=" + name, None, data)[2])
        record = codec.request("GET", "/api/source?id=" + imported["sourceId"], None, b"")[2]
        metadata = json.loads(record[12:12 + struct.unpack_from("<I", record, 8)[0]])
        document = imported["document"]
        entry = {"source_sha256": sha(data), "document_sha256": metadata["document_sha256"], "unchanged": export(document, kind)}
        moved = copy.deepcopy(document)
        moved["fps"] = 27
        target = next((frame["objects"][0] for frame in moved["keyframes"] if frame["objects"]), None)
        if target is not None:
            target["root_x"] += 37.25
        entry["moved"] = export(moved, "piv")
        custom = next((figure for figure in document["figure_types"] if figure["figure_type_id"] != 1 and figure["segments"]), None)
        if custom is not None:
            longer = copy.deepcopy(document)
            figure = next(f for f in longer["figure_types"] if f["figure_type_id"] == custom["figure_type_id"])
            figure["segments"][0]["length"] += 0.25
            entry["figure"] = export(longer, "stk", custom["figure_type_id"])
        files[name] = entry
    return {"files": files, "keyed_bitmaps_sha256": keyed_bitmap_digest()}


def upgraded(name):
    """The version 5 document the editor makes of a legacy fixture (`migrate_legacy_document`),
    keeping the provenance of its legacy source, as a JavaScript client would send it."""
    sys.path.insert(0, str(REPO / "backend"))
    import browser_service
    import piv_migrate
    imported = json.loads(browser_service.BrowserCodec().request("POST", "/api/import?filename=" + name, None, FILES[name]())[2])
    legacy = imported["document"]
    modern = piv_migrate.migrate_legacy_document(copy.deepcopy(legacy))
    modern["source_sha256"], modern["source_path"] = legacy["source_sha256"], legacy["source_path"]
    return json.dumps(js_numbers(modern), separators=(",", ":"), ensure_ascii=False) + "\n"


def main():
    check = "--check" in sys.argv
    OUT.mkdir(parents=True, exist_ok=True)
    for name, build in FILES.items():
        data = build()
        verify(name, data)
        path = OUT / name
        if check:
            if not path.is_file() or path.read_bytes() != data:
                raise SystemExit(f"{path} is missing or differs from what fixtures.py generates")
        else:
            path.write_bytes(data)
        print(f"{'ok' if check else 'wrote'} {name} ({len(data)} bytes)")
    answers = {"expected.json": json.dumps(expectations(), indent=1, sort_keys=True) + "\n"}
    for name in ("legacy-v2.piv", "legacy-v3.piv", "legacy-v4.piv"):
        answers["upgraded-" + name.replace(".piv", ".json")] = upgraded(name)
    for name, text in answers.items():
        path = OUT / name
        if check:
            if not path.is_file() or path.read_text(encoding="utf-8") != text:
                raise SystemExit(f"{path} is missing or differs from what the Python codec answers")
        else:
            path.write_text(text, encoding="utf-8")
        print(f"{'ok' if check else 'wrote'} {name}")


if __name__ == "__main__":
    main()
