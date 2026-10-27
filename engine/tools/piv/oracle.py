#!/usr/bin/env python3
"""Record what the Python Pivot codec answers, for the Rust parity replay.

The Python codec (`backend/browser_service.py` over `backend/server.py`) is the
oracle of `engine/crates/styk-piv`. This script drives it through scenarios
(sequences of API requests against one fresh codec) and writes, per scenario,
every request and the response it got:

    <out>/<scenario>/steps.json      the requests, statuses and headers
    <out>/<scenario>/req-NNN.bin     request bodies made here (edited documents)
    <out>/<scenario>/res-NNN.bin     response bodies

`styk-piv replay <out>` then sends the same requests to the Rust codec and
compares. Request bodies that are corpus files are referenced by path, not copied.

    .venv/bin/python engine/tools/piv/oracle.py --out engine/target/piv-parity
    .venv/bin/python engine/tools/piv/oracle.py --out DIR --suite errors --only yuki

The private corpus is looked up in ~/Downloads (see CORPUS below) and in the
ignored `artifacts/` folder; suites that need it are skipped when it is absent.
The fixtures under `engine/crates/styk-piv/tests/fixtures` are always recorded.

Two settings make the oracle deterministic and equal to what a browser runs:
`STYK_DISABLE_NATIVE_SCAN=1` selects the portable Python frame scanner (the C++
one words its errors differently), and timing values are left as they are (the
replay ignores them).
"""
from __future__ import annotations

import argparse
import copy
import glob
import hashlib
import json
import os
import random
import re
import shutil
import struct
import sys
import time
import zlib
from pathlib import Path

os.environ["STYK_DISABLE_NATIVE_SCAN"] = "1"
REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "backend"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.dont_write_bytecode = True

import browser_service  # noqa: E402
import import_wire  # noqa: E402
import server  # noqa: E402
import piv_migrate  # noqa: E402
import fixtures  # noqa: E402

MIB = 1024 * 1024
NATIVE = {"Accept": import_wire.CONTENT_TYPE}
HOME = Path.home()
CORPUS = {
    "pivs": sorted(glob.glob(str(HOME / "Downloads/pivs/*.piv"))),
    "yuki": [str(HOME / "Downloads/Valthim - Yuki.piv")],
    "waffles": sorted(glob.glob(str(HOME / "Downloads/WafflesPack/**/*.piv"), recursive=True)
                      + glob.glob(str(HOME / "Downloads/WafflesPack/**/*.stk"), recursive=True)),
    "artifacts": sorted(glob.glob(str(REPO / "artifacts/**/*.piv"), recursive=True)
                        + glob.glob(str(REPO / "artifacts/**/*.stk"), recursive=True)),
}
FIXTURES = REPO / "engine/crates/styk-piv/tests/fixtures"


def corpus_files(*groups):
    return [p for g in groups for p in CORPUS[g] if os.path.isfile(p)]


def slug(text):
    return re.sub(r"[^A-Za-z0-9._-]+", "_", text).strip("_")[:90]


def make_codec(limits):
    if limits == "web":
        return browser_service.BrowserCodec()
    codec = browser_service.BrowserCodec(max_source=128 * MIB, max_document=256 * MIB, max_cache=384 * MIB)
    codec.store.max_retained_sources = 384 * MIB  # server.py's default for a desktop store
    return codec


class Scenario:
    """One fresh codec and the requests sent to it."""

    def __init__(self, recorder, name, limits="desktop"):
        self.recorder, self.name, self.limits = recorder, name, limits
        self.directory = recorder.out / slug(name)
        if self.directory.exists():
            shutil.rmtree(self.directory)
        self.directory.mkdir(parents=True)
        self.codec = make_codec(limits)
        self.steps = []

    def request(self, method, target, body=b"", headers=None, *, file=None, note=None, compare="auto"):
        """Send one request. `file` references a corpus file as the body instead of copying it."""
        if file is not None:
            body = Path(file).read_bytes()
        index = len(self.steps)
        started = time.perf_counter()
        status, response_headers, response = self.codec.request(method, target, headers, body)
        elapsed = time.perf_counter() - started
        step = {"method": method, "target": target, "headers": [[k, v] for k, v in (headers or {}).items()],
                "status": status, "response_headers": [[k, v] for k, v in response_headers.items()],
                "response": f"res-{index:03d}.bin", "response_length": len(response),
                "oracle_seconds": round(elapsed, 4), "compare": compare}
        if note:
            step["note"] = note
        if file is not None:
            step["body_file"] = str(file)
        elif body:
            step["body"] = f"req-{index:03d}.bin"
            (self.directory / step["body"]).write_bytes(body)
        (self.directory / step["response"]).write_bytes(response)
        self.steps.append(step)
        self.recorder.requests += 1
        return status, response_headers, response

    def close(self):
        (self.directory / "steps.json").write_text(json.dumps(
            {"name": self.name, "limits": self.limits, "steps": self.steps}, indent=1))
        self.codec.store.close()

    # Conveniences -----------------------------------------------------------------

    def import_file(self, path, name=None, headers=None, **kw):
        name = name or os.path.basename(path)
        return self.request("POST", "/api/import?filename=" + quote(name), headers=headers, file=path, **kw)

    def import_bytes(self, data, name, headers=None, **kw):
        return self.request("POST", "/api/import?filename=" + quote(name), data, headers, **kw)

    def export(self, document, format="piv", *, source_id=None, filename=None, figure=None, normalize=True, **kw):
        request = {"document": js_numbers(document) if normalize else document, "format": format}
        if source_id is not None:
            request["sourceId"] = source_id
        if filename is not None:
            request["filename"] = filename
        if figure is not None:
            request["figureTypeId"] = figure
        return self.request("POST", "/api/export", json.dumps(request, separators=(",", ":")).encode(), **kw)


js_numbers = fixtures.js_numbers


def quote(name):
    from urllib.parse import quote as q
    return q(name, safe="")


class Recorder:
    def __init__(self, out, only=None):
        self.out, self.only, self.requests, self.scenarios = Path(out), only, 0, 0
        self.out.mkdir(parents=True, exist_ok=True)

    def scenario(self, name, limits="desktop"):
        if self.only and not any(o.lower() in name.lower() for o in self.only):
            return None
        self.scenarios += 1
        print(f"  {name}", flush=True)
        return Scenario(self, name, limits)


# Deterministic edits ---------------------------------------------------------------

def first_object(document):
    for fi, frame in enumerate(document["keyframes"]):
        if frame["objects"]:
            return fi, frame["objects"][0]
    return None, None


def custom_figures(document):
    return [f for f in document["figure_types"] if f["figure_type_id"] != 1 and not f.get("implicit")]


def edit_move_root(doc):
    _, obj = first_object(doc)
    obj["root_x"] += 12.25
    obj["root_y"] -= 3.5


def edit_pose_angle(doc):
    _, obj = first_object(doc)
    obj["angles"][len(obj["angles"]) // 2] += 0.375


def edit_recolor_instance(doc):
    _, obj = first_object(doc)
    obj["color_override_raw"] = 0xFF2040C0
    obj["field28"] = 64


def edit_recolor_segment(doc):
    figure = custom_figures(doc)[0]
    segment = figure["segments"][0]
    segment["color_rgb"] = [200, 30, 90]
    segment["color_alpha"] = 0.5


def edit_add_instance(doc):
    fi, obj = first_object(doc)
    frame = doc["keyframes"][fi]
    clone = copy.deepcopy(obj)
    used = {o["unique_id"] for f in doc["keyframes"] for o in f["objects"]}
    clone["unique_id"] = max(used) + 1 if max(used) < 0xFFFFFFFF else next(i for i in range(1, 1 << 32) if i not in used)
    clone["root_x"] += 40.0
    clone["join"] = None
    frame["objects"].append(clone)
    frame.pop("object_draw_order", None)
    frame["object_draw_order_unique_ids"] = frame.get("object_draw_order_unique_ids", []) + [clone["unique_id"]]


def edit_remove_instance(doc):
    for frame in doc["keyframes"]:
        objects = frame["objects"]
        if len(objects) < 2:
            continue
        joined = {o["join"].get("target_unique_id") for o in objects if o.get("join")}
        victim = next((o for o in reversed(objects) if o["unique_id"] not in joined), None)
        if victim is None:
            continue
        objects.remove(victim)
        frame.pop("object_draw_order", None)
        frame["object_draw_order_unique_ids"] = [u for u in frame.get("object_draw_order_unique_ids", []) if u != victim["unique_id"]]
        return
    raise LookupError("no removable instance")


def edit_durations(doc):
    for index, frame in enumerate(doc["keyframes"][:12]):
        frame["duration_raw"] = (index * 3) % 7 + 1
        frame["inbetweens"] = frame["duration_raw"] - 1


def edit_canvas(doc):
    doc["canvas_width"] += 160
    doc["canvas_height"] += 90


def edit_fps_and_frames(doc):
    doc["fps"] = 30 if doc["fps"] != 30 else 25
    doc["keyframes"].insert(1, copy.deepcopy(doc["keyframes"][0]))
    if len(doc["keyframes"]) > 4:
        del doc["keyframes"][3]


def edit_segment_geometry(doc):
    figure = custom_figures(doc)[0]
    figure["segments"][0]["length"] += 7.5
    figure["segments"][-1]["thickness"] = 9.0
    figure["name"] = (figure.get("name") or "Figure")[:20] + " edit"


def edit_add_segment(doc):
    figure = custom_figures(doc)[0]
    ids = [s["segment_id"] for s in figure["segments"]]
    new_id = max(ids) + 1
    figure["segments"].append({"segment_id": new_id, "parent_id": ids[0], "length": 21.0, "angle_rad": 0.5,
                               "thickness": 6.0, "primitive_code": 0, "color_rgb": [10, 20, 30]})
    figure["segment_count"] = len(figure["segments"])
    tid = figure["figure_type_id"]
    for frame in doc["keyframes"]:
        for obj in frame["objects"]:
            if obj["figure_type_id"] == tid:
                obj["angles"].append(0.5)
                if obj.get("lengths"):
                    obj["lengths"].append(21.0)
                if obj.get("bends"):
                    obj["bends"].append(0.0)


def edit_remove_segment(doc):
    """Delete a leaf segment that no polygon, join or media table depends on."""
    for figure in custom_figures(doc):
        segments = figure["segments"]
        parents = {s["parent_id"] for s in segments}
        used = {v for p in figure.get("polyfills", []) for v in p["segment_ids"]}
        tid = figure["figure_type_id"]
        joined = {o["join"]["target_handle_id"] for f in doc["keyframes"] for o in f["objects"] if o.get("join")
                  and next((t for t in f["objects"] if t["unique_id"] == o["join"].get("target_unique_id")), {}).get("figure_type_id") == tid}
        for index in range(len(segments) - 1, -1, -1):
            s = segments[index]
            if len(segments) > 1 and s["segment_id"] not in parents | used | joined and s.get("primitive_code", 0) not in (2, 5):
                del segments[index]
                figure["segment_count"] = len(segments)
                for key in ("segment_z_raw",):
                    figure.pop(key, None)
                for frame in doc["keyframes"]:
                    for obj in frame["objects"]:
                        if obj["figure_type_id"] == tid:
                            for key in ("angles", "lengths", "bends"):
                                if obj.get(key):
                                    del obj[key][index]
                return
    raise LookupError("no removable segment")


def edit_layers(doc):
    figure = custom_figures(doc)[0]
    for segment in figure["segments"]:
        segment["z_order"] = len(figure["segments"]) + 1 - segment.get("z_order", 1)
        segment.pop("z_order_runtime_raw", None)
    figure.pop("segment_z_raw", None)


def edit_builtin(doc):
    figure = next(f for f in doc["figure_types"] if f["figure_type_id"] == 1)
    figure["segments"][3]["length"] = 26.0
    figure["segments"][0]["color_rgb"] = [0, 120, 255]


def edit_background(doc):
    doc["backgrounds"].append({"background_id": max([b["background_id"] for b in doc["backgrounds"]] + [0]) + 1,
                               "kind": 2, "color": 0x00804020, "name": "Parity"})
    doc["keyframes"][0]["background_id"] = doc["backgrounds"][-1]["background_id"]


def edit_camera(doc):
    doc["keyframes"][0]["camera"] = {"is_default": False, "x": 12.5, "y": -4.0, "angle_rad": 0.25, "scale": 1.5}
    doc["auto_easing"] = not doc.get("auto_easing", True)


def edit_lengths_and_join(doc):
    for frame in doc["keyframes"]:
        if len(frame["objects"]) >= 2:
            a, b = frame["objects"][0], frame["objects"][1]
            a["lengths"] = [17.25 + i for i in range(len(a["angles"]))]
            a["bends"] = [0.0625 * (i % 3) for i in range(len(a["angles"]))]
            figure = next(f for f in doc["figure_types"] if f["figure_type_id"] == a["figure_type_id"])
            if not a.get("join") and not b.get("join"):
                b["join"] = {"target_unique_id": a["unique_id"], "target_handle_id": figure["segments"][0]["segment_id"]}
            return
    raise LookupError("no frame with two objects")


EDITS = [edit_move_root, edit_pose_angle, edit_recolor_instance, edit_recolor_segment, edit_add_instance,
         edit_remove_instance, edit_durations, edit_canvas, edit_fps_and_frames, edit_segment_geometry,
         edit_add_segment, edit_remove_segment, edit_layers, edit_builtin, edit_background, edit_camera,
         edit_lengths_and_join]
QUICK_EDITS = [edit_move_root, edit_canvas]


# Suites ---------------------------------------------------------------------------

def imported(response):
    status, _, body = response
    return json.loads(body) if status == 200 and body[:1] == b"{" else None


def suite_import(rec, files, *, limits="desktop", exports=True):
    """JSON import, unchanged export (a), and the native-frame transport, per file."""
    for path in files:
        base = os.path.basename(path)
        kind = base.rsplit(".", 1)[-1].lower()
        s = rec.scenario(f"import-{limits}-{base}", limits)
        if s is None:
            continue
        result = imported(s.import_file(path, note="json import"))
        s.import_file(path, note="json import again (cache hit)")
        if result and exports:
            s.export(result["document"], kind, source_id=result["sourceId"], filename=base, normalize=False,
                     note="unchanged export, Python number text")
            s.export(result["document"], kind, source_id=result["sourceId"], note="unchanged export, JavaScript number text")
            s.request("GET", "/api/source?id=" + result["sourceId"], note="original source record")
        s.close()
        s = rec.scenario(f"native-{limits}-{base}", limits)
        if s is None:
            continue
        status, headers, body = s.import_file(path, headers=NATIVE, note="native-frame import")
        s.import_file(path, headers=NATIVE, note="native-frame import again (cache hit)")
        s.import_file(path, note="json import after native (lazy canonical document)")
        s.close()
        s = rec.scenario(f"json-then-native-{limits}-{base}", limits)
        if s is None:
            continue
        s.import_file(path, note="json import")
        s.import_file(path, headers=NATIVE, note="native-frame import of a cached json entry")
        s.close()


def suite_edits(rec, files, edits=None):
    """Edited exports (b) and import of what was exported (c)."""
    for path in files:
        base = os.path.basename(path)
        kind = base.rsplit(".", 1)[-1].lower()
        s = rec.scenario(f"edits-{base}")
        if s is None:
            continue
        result = imported(s.import_file(path, note="json import"))
        if not result:
            s.close()
            continue
        document, source_id = result["document"], result["sourceId"]
        size = len(json.dumps(document))
        chosen = edits or (EDITS if size < 60 * MIB else QUICK_EDITS)
        for edit in chosen:
            doc = copy.deepcopy(document)
            try:
                edit(doc)
            except (LookupError, KeyError, IndexError, TypeError, ValueError, StopIteration):
                continue
            status, _, output = s.export(doc, "piv", source_id=source_id, note=edit.__name__)
            if status == 200 and edit in (edit_move_root, edit_add_segment, edit_remove_segment, edit_builtin, edit_layers,
                                           edit_remove_instance, edit_lengths_and_join):
                again = imported(s.import_bytes(output, f"{edit.__name__}.piv", note=f"import of the {edit.__name__} export"))
                if again:
                    s.export(again["document"], "piv", source_id=again["sourceId"], note="unchanged export of the re-import")
        if kind == "piv":
            doc = copy.deepcopy(document)
            edit_move_root(doc)
            s.export(doc, "piv", source_id=source_id, normalize=False, note="edit_move_root with Python number text")
            s.export(doc, "piv", note="edit_move_root without a cached source (scaffold rebuild)")
            for figure in [f["figure_type_id"] for f in document["figure_types"]][:4]:
                status, _, stk = s.export(document, "stk", source_id=source_id, figure=figure, filename="figure.stk",
                                          note=f"stk export of figure {figure}")
                if status == 200:
                    again = imported(s.import_bytes(stk, f"figure-{figure}.stk", note="import of the exported stk"))
                    if again:
                        s.export(again["document"], "stk", source_id=again["sourceId"], figure=2, note="unchanged stk export")
                        s.export(again["document"], "piv", source_id=again["sourceId"], note="piv export of an stk import")
            s.export(document, "stk", source_id=source_id, note="stk export without a selected figure")
        else:
            doc = copy.deepcopy(document)
            doc["figure_types"][1]["segments"][0]["length"] += 0.25
            status, _, stk = s.export(doc, "stk", source_id=source_id, figure=2, note="edited stk export")
            if status == 200:
                again = imported(s.import_bytes(stk, "edited.stk", note="import of the edited stk"))
                if again:
                    s.export(again["document"], "stk", source_id=again["sourceId"], note="unchanged export of the re-import")
            s.export(document, "piv", source_id=source_id, note="piv export of an stk import")
        s.close()


def mutations(data, count, seed):
    """Deterministic damaged copies of a file: bit flips, byte sets, truncations, appends."""
    rng = random.Random(seed)
    out = []
    for index in range(count):
        mode = index % 6
        m = bytearray(data)
        if mode == 0:
            for _ in range(rng.randrange(1, 4)):
                m[rng.randrange(len(m))] ^= 1 << rng.randrange(8)
            out.append((f"flip-{index}", bytes(m)))
        elif mode == 1:
            out.append((f"cut-{index}", bytes(m[:rng.randrange(len(m))])))
        elif mode == 2:
            pos = rng.randrange(min(len(m), 512))
            m[pos] = rng.randrange(256)
            out.append((f"head-{index}", bytes(m)))
        elif mode == 3:
            pos = rng.randrange(len(m))
            m[pos:pos + rng.randrange(1, 9)] = rng.randbytes(rng.randrange(1, 9))
            out.append((f"splice-{index}", bytes(m)))
        elif mode == 4:
            out.append((f"append-{index}", bytes(m) + rng.randbytes(rng.randrange(1, 6))))
        else:
            pos = rng.randrange(len(m))
            m[pos] = 0xFF if m[pos] != 0xFF else 0
            out.append((f"ff-{index}", bytes(m)))
    return out


def payload_mutations(data, count, seed):
    """The same kinds of damage applied to the decompressed payload, then recompressed
    or left raw: these reach the grammar instead of failing in zlib."""
    payload, compressed = server.piv_codec._unpack_source(data)
    out = []
    for name, changed in mutations(payload, count, seed):
        if not changed:
            continue
        out.append((f"payload-{name}", zlib.compress(changed) if compressed and len(out) % 2 == 0 else changed))
    return out


def suite_errors(rec, files, per_file=40):
    for path in files:
        base = os.path.basename(path)
        data = Path(path).read_bytes()
        s = rec.scenario(f"errors-{base}")
        if s is None:
            continue
        seed = int(hashlib.sha256(base.encode()).hexdigest()[:8], 16)
        cases = mutations(data, per_file, seed)
        if base.lower().endswith(".piv"):
            cases += payload_mutations(data, per_file, seed + 1)
        else:
            inner = data[1:] if data[:1] in (b"\x79", b"\x7a") and data[1:2] == b"\x78" else None
            if inner is not None:
                try:
                    payload = zlib.decompress(inner)
                    cases += [(f"payload-{n}", data[:1] + zlib.compress(c)) for n, c in mutations(payload, per_file, seed + 1) if c]
                except zlib.error:
                    pass
        for index, (name, changed) in enumerate(cases):
            headers = NATIVE if index % 3 == 2 and base.lower().endswith(".piv") else None
            s.import_bytes(changed, base, headers, note=name)
        s.close()


def suite_fixtures(rec):
    """Generated legacy and modern files (the only suite that runs in a clean checkout)."""
    for path in sorted(FIXTURES.glob("*.piv")) + sorted(FIXTURES.glob("*.stk")):
        base, kind = path.name, path.suffix[1:]
        s = rec.scenario(f"fixture-{base}")
        if s is None:
            continue
        result = imported(s.import_file(path, note="json import"))
        s.import_file(path, headers=NATIVE, note="native-frame import (legacy stays json)")
        if result:
            document, source_id = result["document"], result["sourceId"]
            if base != "modern-wide-integers.piv":
                # Known difference, left out on purpose: Python tells `1e18` (a float, the exact value) from
                # `1000000000000000000` (an int), the engine's JSON reader does not and assumes a JavaScript client.
                s.export(document, kind, source_id=source_id, normalize=False, note="unchanged export, Python number text")
            s.export(document, kind, source_id=source_id, note="unchanged export")
            s.request("GET", "/api/source?id=" + source_id, note="source record")
            edits = [edit_move_root, edit_pose_angle, edit_canvas, edit_durations, edit_recolor_instance, edit_fps_and_frames,
                     edit_add_instance, edit_remove_instance, edit_segment_geometry, edit_add_segment, edit_builtin, edit_layers]
            for edit in edits:
                doc = copy.deepcopy(document)
                try:
                    edit(doc)
                except (LookupError, KeyError, IndexError, TypeError, ValueError, StopIteration):
                    continue
                status, _, output = s.export(doc, "piv", source_id=source_id, note=edit.__name__)
                if status == 200 and edit in (edit_move_root, edit_add_segment):
                    again = imported(s.import_bytes(output, f"{edit.__name__}.piv", note="import of the export"))
                    if again:
                        s.export(again["document"], "piv", source_id=again["sourceId"], note="unchanged export of the re-import")
            if document["version"] < 5:
                # The editor's explicit upgrade: a version 5 document that keeps its legacy source.
                modern = piv_migrate.migrate_legacy_document(copy.deepcopy(document))
                modern["source_sha256"], modern["source_path"] = document["source_sha256"], document["source_path"]
                modern.pop("migration", None)
                s.export(modern, "piv", source_id=source_id, note="upgraded to v5, unedited")
                modern["fps"] = 27
                first_object(modern)[1]["root_x"] += 37.25
                modern["keyframes"].append(copy.deepcopy(modern["keyframes"][0]))
                s.export(modern, "piv", source_id=source_id, note="upgraded to v5 and edited")
                modern["source_sha256"] = "0" * 64
                s.export(modern, "piv", source_id=source_id, note="upgrade with a foreign source fingerprint")
                wrong = copy.deepcopy(document)
                wrong["version"] = 5 - (document["version"] == 4) * 2
                first_object(wrong)[1]["root_x"] += 1
                s.export(wrong, "piv", source_id=source_id, note="legacy document with another version")
            for figure in [f["figure_type_id"] for f in document["figure_types"]][:3]:
                status, _, stk = s.export(document, "stk", source_id=source_id, figure=figure, note=f"stk export of figure {figure}")
                if status == 200:
                    s.import_bytes(stk, f"figure-{figure}.stk", note="import of the exported stk")
        s.close()
    for path in sorted(FIXTURES.glob("*.piv")) + sorted(FIXTURES.glob("*.stk")):
        s = rec.scenario(f"fixture-errors-{path.name}")
        if s is None:
            continue
        data = path.read_bytes()
        seed = int(hashlib.sha256(path.name.encode()).hexdigest()[:8], 16)
        cases = mutations(data, 36, seed)
        if path.suffix == ".piv":
            cases += payload_mutations(data, 36, seed + 1)
        for index, (name, changed) in enumerate(cases):
            s.import_bytes(changed, path.name, NATIVE if index % 4 == 3 else None, note=name)
        s.close()


def blank(width=640, height=480, fps=24):
    return server.bridge.scaffold({"canvas_width": width, "canvas_height": height, "fps": fps})


def source_bytes(index=0):
    """`test_source_lifetime.source_bytes`: a small modern file with an opaque trailer."""
    scaffold = blank()
    document = server.piv_codec.decode_piv_bytes(scaffold)
    figure = document["figure_types"][0]
    first = {"object_slot": 0, "unique_id": 1, "figure_type_id": 1, "scale": 1.0, "color_override_raw": 0, "field28": 0,
             "image_text_flags": 0, "opacity": 1.0, "angles": [s["angle_rad"] for s in figure["segments"]],
             "root_x": 100.0, "root_y": 150.0, "lengths": [], "bends": [], "len_flag": 0, "bend_flag": 0, "join": None}
    second = {**copy.deepcopy(first), "object_slot": 1, "unique_id": 2, "root_x": 250.0,
              "join": {"target_unique_id": 1, "target_object_slot": 0, "target_handle_id": 1}}
    frame = document["keyframes"][0]
    frame.update(objects=[first, second], object_draw_order=[1, 0], object_draw_order_unique_ids=[2, 1], duration_raw=4, inbetweens=3)
    hidden = copy.deepcopy(frame)
    hidden.update(duration_raw=0, inbetweens=-1)
    last = copy.deepcopy(frame)
    last.update(duration_raw=1, inbetweens=0)
    last["objects"][0]["root_x"] += 37.5
    document["keyframes"] = [frame, hidden, last]
    encoded = server.bridge.encode_piv_project(scaffold, document, force_rebuild=True)
    payload, _ = server.piv_codec._unpack_source(encoded)
    return zlib.compress(payload + b"\x00\xffunknown original bytes:" + str(index).encode("ascii"))


def suite_service(rec):
    """Routes, limits, the cache and leases (`test_browser_service`, `test_source_lifetime`)."""
    A, B, C = "a" * 32, "b" * 32, "c" * 32
    j = lambda value: json.dumps(value).encode()  # noqa: E731

    for limits in ("desktop", "web"):
        s = rec.scenario(f"service-routes-{limits}", limits)
        if s is not None:
            s.request("GET", "/api/health", compare="health")
            s.request("GET", "/api/health?x=1", headers={"Accept": "*/*"}, compare="health")
            s.request("GET", "/api/samples")
            s.request("POST", "/api/open", b'{"path":"x.piv"}')
            s.request("POST", "/api/cancel?id=abc")
            for method, target in (("GET", "/api/nope"), ("POST", "/api/health"), ("GET", "/api/import"), ("DELETE", "/api/export"),
                                   ("get", "/api/samples"), ("POST", "/"), ("GET", ""), ("GET", "http://localhost/api/samples"),
                                   ("GET", "//host/api/samples?x#y"), ("GET", "http://[::1/api/health"), ("PUT", "/api/source")):
                s.request(method, target)
            s.request("POST", "/api/import?filename=blank.piv", blank())
            s.request("POST", "/api/import", blank(), note="default filename")
            s.request("POST", "/api/import?filename=&x=1", blank(), note="blank filename falls back to the default")
            s.request("POST", "/api/import?filename=a%20b+c.PIV", blank(), note="percent and plus decoding, upper-case suffix")
            s.request("POST", "/api/import?filename=dir%5Csub%2Fna%3Ame%3F.piv", blank(), note="path and reserved characters")
            s.request("POST", "/api/import?filename=caf%C3%A9.piv", blank(), note="non-ASCII name")
            for name in ("x.txt", "noextension", ".piv", "a.piv.", "a..stk", "%00.piv", "x.pIv", "x.json", "x.styk", "x.stkz", "x.stykmov", "x.stK"):
                s.request("POST", "/api/import?filename=" + quote(name), b"not a pivot file at all", note=f"name {name!r}")
            s.request("POST", "/api/import?filename=empty.piv", b"")
            s.request("POST", "/api/import?filename=blank.piv", blank(), {"X-Styk-Source-Owner": "invalid"})
            s.request("POST", "/api/import?filename=blank.piv", blank(), {"X-Styk-Source-Owner": A})
            s.request("POST", "/api/import?filename=blank.piv", blank(), {"x-styk-source-owner": B, "ACCEPT": import_wire.CONTENT_TYPE + ", */*"})
            for body in (b"[1, 2]", b"", b"{", b"\xff", b'{"a":1,}', b"nul", b'{"document":3}', b'{"document":{},"format":"gif"}',
                         b'{"document":{}}', b'{"document":{"version":5}}', b'\xef\xbb\xbf{}', b'{"document":{"version":5},"format":null}',
                         b'{"a":"\\x"}', b'{"a":"\x01"}', b'[1 2]', b'{"a" 1}', b'"abc', b'{"a":1}x', b'  ', b'{"a":"\xe2\x82"}',
                         b'{"document":{"version":5,"canvas_width":640,"canvas_height":480,"fps":24,"figure_types":[],"keyframes":[]}}',
                         b'{"document":{"version":6,"canvas_width":640}}',
                         b'{"document":{"version":5,"canvas_width":0,"canvas_height":480}}',
                         b'{"document":{"version":5,"canvas_width":640,"canvas_height":480,"fps":0}}',
                         b'{"document":{"version":5,"canvas_width":640,"canvas_height":480,"fps":24,"figure_types":[1],"keyframes":[]}}'):
                s.request("POST", "/api/export", body)
            for path in ("/api/source/retain", "/api/source/release"):
                for body in (b"[]", b"x" * 4097, b'{"ownerId":"wrong"}', b"{}", b'{"ownerId":"' + A.encode() + b'"}',
                             b'{"ownerId":"' + A.upper().encode() + b'"}', b'{"ownerId":1}', b"{", b'{"sourceId":"missing","ownerId":"' + C.encode() + b'"}'):
                    s.request("POST", path, body)
            s.request("GET", "/api/source?id=missing")
            s.request("GET", "/api/source")
            s.close()

    s = rec.scenario("service-limits")
    if s is not None:
        small = browser_service.BrowserCodec(max_source=1024, max_document=2048)
        s.codec = small
        s.limits = "tiny"
        s.request("POST", "/api/import?filename=big.piv", b"x" * 1025)
        s.request("POST", "/api/import?filename=big.styk", b"x" * 2049)
        s.request("POST", "/api/import?filename=ok.styk", b"x" * 2048)
        s.request("POST", "/api/import?filename=big.JSON", b"x" * 1025)
        s.request("POST", "/api/export", b"x" * 2049)
        s.request("POST", "/api/import?filename=blank.piv", blank())
        s.close()

    s = rec.scenario("service-roundtrip")
    if s is not None:
        result = imported(s.import_bytes(blank(), "blank.piv"))
        document = result["document"]
        s.export(document, "piv", source_id=result["sourceId"], filename="blank.piv", normalize=False)
        s.export(document, "piv", source_id=result["sourceId"], filename="blank.piv")
        s.export(document, "piv", filename="dir/sub/My scene.v2.piv", note="no cached source: scaffold rebuild")
        for filename in ("", None, "..", "a/b/", " .x. ", "con:in?.piv", "café 漢.piv", "x" * 300, 5, ["a"], "/"):
            s.export(document, "piv", source_id=result["sourceId"], filename=filename, note=f"filename {filename!r}")
        s.export(document, "piv", source_id="expired")
        s.export(document, "piv", source_id=5, note="a non-string source id is not looked up but is truthy")
        s.export(document, "piv", source_id="", note="an empty source id is no source id")
        s.request("GET", "/api/source?id=" + result["sourceId"])
        s.request("GET", "/api/source?id=" + result["sourceId"] + "&id=other", note="first id wins")
        s.import_bytes(blank(), "blank.piv", NATIVE)
        s.import_bytes(blank(800, 600, 30), "other.piv", NATIVE)
        empty_frames = zlib.compress(struct.pack("<BIIHHII", 5, 640, 480, 1, 2, 0, 24) + b"\x01")
        again = imported(s.import_bytes(empty_frames, "empty-frames.piv"))
        s.import_bytes(empty_frames, "empty-frames.piv", NATIVE)
        s.export(again["document"], "piv", source_id=again["sourceId"])
        doc = copy.deepcopy(again["document"])
        doc["fps"] = 12
        s.export(doc, "piv", source_id=again["sourceId"], note="edit of a zero-keyframe file")
        raw = struct.pack("<BIIHHII", 5, 640, 480, 1, 2, 0, 24)
        s.import_bytes(raw, "raw-no-trailer.piv", note="uncompressed, auto-easing byte omitted")
        s.import_bytes(raw, "raw-no-trailer.piv", NATIVE)
        s.import_bytes(raw + b"\x00extra trailer", "raw-trailer.piv")
        s.import_bytes(raw + b"\x02", "bad-easing.piv")
        s.close()

    s = rec.scenario("service-leases")
    if s is not None:
        raw = source_bytes()
        opened = imported(s.import_bytes(raw, "active.piv", {"X-Styk-Source-Owner": A}))
        s.request("POST", "/api/source/retain", j({"sourceId": opened["sourceId"], "ownerId": B}))
        s.request("POST", "/api/source/retain", j({"sourceId": opened["sourceId"], "ownerId": A}))
        for index in range(server.MAX_CACHE_ENTRIES + 1):
            s.import_bytes(source_bytes(index + 1), "library.piv", note=f"evict {index}")
        s.request("GET", "/api/source?id=" + opened["sourceId"], note="leased original after eviction")
        s.export(opened["document"], "piv", source_id=opened["sourceId"], note="unchanged export from the lease")
        edited = copy.deepcopy(opened["document"])
        edited["keyframes"][0]["objects"][0]["root_x"] += 0.25
        edited["keyframes"][0]["objects"][1]["lengths"] = [17.25] * 12
        edited["fps"] = 23.75
        s.export(edited, "piv", source_id=opened["sourceId"], note="edited export from the lease (trailer kept)")
        s.import_bytes(raw, "renamed-copy.piv", {"X-Styk-Source-Owner": C}, note="re-import under another name keeps the leased name")
        s.request("POST", "/api/source/release", j({"ownerId": A}))
        s.request("GET", "/api/source?id=" + opened["sourceId"])
        s.request("POST", "/api/source/release", j({"ownerId": B}))
        s.request("POST", "/api/source/release", j({"ownerId": B}))
        s.request("POST", "/api/source/release", j({"ownerId": C}))
        for index in range(server.MAX_CACHE_ENTRIES + 1):
            s.import_bytes(source_bytes(index + 40), "library.piv", note=f"evict again {index}")
        s.request("GET", "/api/source?id=" + opened["sourceId"], note="expired after the last release")
        s.export(opened["document"], "piv", source_id=opened["sourceId"], note="export of an expired source")
        s.request("POST", "/api/source/retain", j({"sourceId": opened["sourceId"], "ownerId": A}))
        owners = [f"{i:032x}" for i in range(1, 20)]
        fresh = imported(s.import_bytes(source_bytes(99), "fresh.piv"))
        for owner in owners:
            s.request("POST", "/api/source/retain", j({"sourceId": fresh["sourceId"], "ownerId": owner}))
        s.close()

    s = rec.scenario("service-lease-budget")
    if s is not None:
        first, second = source_bytes(), source_bytes(1)
        s.codec.store.max_retained_sources = len(first)
        s.limits = f"retained:{len(first)}"
        one = imported(s.import_bytes(first, "first.piv", {"X-Styk-Source-Owner": A}))
        two = imported(s.import_bytes(second, "second.piv"))
        s.request("POST", "/api/source/retain", j({"sourceId": two["sourceId"], "ownerId": B}), note="over the lease budget")
        s.request("POST", "/api/source/retain", j({"sourceId": two["sourceId"], "ownerId": A}), note="replacement reuses the owner's budget")
        s.request("GET", "/api/source?id=" + one["sourceId"])
        s.import_bytes(source_bytes(2), "third.piv", {"X-Styk-Source-Owner": B}, note="import whose lease does not fit")
        s.close()

    s = rec.scenario("service-stk")
    if s is not None:
        document = imported(s.import_bytes(source_bytes(), "source.piv"))["document"]
        status, _, stk = s.export(document, "stk", figure=1, filename="named-figure")
        opened = imported(s.import_bytes(stk, "named-figure.stk", {"X-Styk-Source-Owner": A}))
        s.import_bytes(stk, "other name.stk", note="the name is part of an stk's identity")
        s.export(opened["document"], "stk", source_id=opened["sourceId"])
        s.export(opened["document"], "stk", source_id=opened["sourceId"], figure=2)
        s.export(opened["document"], "stk", source_id=opened["sourceId"], figure=1, note="another figure than the stk's own")
        s.export(opened["document"], "stk", source_id=opened["sourceId"], figure=7, note="a figure that does not exist")
        s.export(opened["document"], "piv", source_id=opened["sourceId"])
        s.request("GET", "/api/source?id=" + opened["sourceId"])
        s.close()


def suite_native(rec):
    """Native documents through the store: plain JSON projects, the early wrapper, saves."""
    s = rec.scenario("native-documents")
    if s is None:
        return
    j = lambda value: json.dumps(value).encode()  # noqa: E731
    opened = imported(s.import_bytes(source_bytes(), "active.piv"))
    document, source_id = opened["document"], opened["sourceId"]
    plain = j(document)
    s.import_bytes(plain, "copy.styk", note="plain JSON project")
    s.import_bytes(plain, "copy.json", note="json alias")
    s.import_bytes(b"\xef\xbb\xbf  " + plain, "bom.styk")
    s.import_bytes(j({"format": "stykanimate", "version": 1, "name": "Early", "document": document}), "early.styk", note="early wrapper")
    s.import_bytes(j({"format": "stykanimate", "version": 2, "document": document}), "early2.styk")
    s.import_bytes(j({"format": "stykanimate", "version": 1, "document": [1]}), "early3.styk")
    s.import_bytes(b"[1,2]", "list.styk")
    s.import_bytes(b"{}", "empty.styk")
    s.import_bytes(b'{"version":5', "broken.styk")
    s.import_bytes(b"STYKxxxx", "short.styk")
    s.import_bytes(b"STKZ" + bytes(60), "short.stkz")
    s.import_bytes(plain, "copy.stkz", note="plain JSON is not a figure container")
    status, _, native = s.export(document, "styk", source_id=source_id, filename="My save", compare="container")
    reopened = imported(s.import_bytes(native, "reopened.styk", note="container written by the Python service"))
    if reopened:
        s.export(reopened["document"], "piv", note="unchanged export from the embedded source")
        s.export(reopened["document"], "piv", source_id=reopened["sourceId"])
        changed = copy.deepcopy(reopened["document"])
        changed["keyframes"][0]["objects"][0]["root_x"] += 2.5
        s.export(changed, "piv", note="edited export from the embedded source")
        s.export(changed, "styk", source_id=reopened["sourceId"], compare="container")
        s.request("POST", "/api/source/retain", j({"sourceId": reopened["sourceId"], "ownerId": "d" * 32}), note="native sources are not leased")
        s.request("GET", "/api/source?id=" + reopened["sourceId"], note="a native entry has no binary source")
        older = copy.deepcopy(reopened["document"])
        older["_stykSource"].pop("document_digest_version")
        s.export(older, "piv", note="digest version 1 metadata")
        broken = copy.deepcopy(reopened["document"])
        broken["_stykSource"]["sha256"] = "0" * 64
        s.export(broken, "piv", note="embedded fingerprint mismatch")
        broken["_stykSource"]["source_base64"] = "@@@"
        s.export(broken, "piv", note="embedded source is not base64")
        broken["_stykSource"]["source_base64"] = 5
        s.export(broken, "piv")
    figure_document = copy.deepcopy(document)
    figure_document["keyframes"] = figure_document["keyframes"][:1]
    for obj in figure_document["keyframes"][0]["objects"]:
        obj["join"] = None
    for fmt in ("stkz", "stykmov"):
        status, _, body = s.export(figure_document, fmt, filename="Hero/one", compare="container")
        if status == 200:
            s.import_bytes(body, "hero." + fmt)
    s.export(document, "stkz", note="three keyframes are not a figure file")
    s.close()


DELETE = object()
THOROUGH = os.environ.get("STYK_PIV_THOROUGH") == "1"
REPLACEMENTS = [DELETE, None, "x", -1, 1.5, 0, True, [], {}, [1], 2 ** 40, 70000, "1"]


def walk_paths(value, prefix=(), depth=0, limit=7 if os.environ.get("STYK_PIV_THOROUGH") == "1" else 5):
    """Paths into a document: every key of the first element of each list, a few levels deep."""
    if depth >= limit:
        return
    if isinstance(value, dict):
        for key, item in value.items():
            yield prefix + (key,)
            yield from walk_paths(item, prefix + (key,), depth + 1, limit)
    elif isinstance(value, list) and value:
        index = len(value) - 1 if prefix and prefix[-1] in ("figure_types", "segments") else 0
        yield prefix + (index,)
        yield from walk_paths(value[index], prefix + (index,), depth + 1, limit)


def mutated(document, path, replacement):
    doc = copy.deepcopy(document)
    node = doc
    for key in path[:-1]:
        node = node[key]
    if replacement is DELETE:
        del node[path[-1]]
    else:
        node[path[-1]] = copy.deepcopy(replacement)
    return doc


SKIP_KEYS = {"data_base64", "data_url", "data_uri", "svg_path", "normalized_svg_path", "notes", "validation", "import_warnings",
             "source_path", "source_size", "payload_size", "file_type", "format", "decode_status", "trace_assisted", "supports_viewer",
             "limitations", "trailing_bytes_hex", "record_end", "byte_length", "sha256", "bounds", "glyphs", "placements"}


def suite_documents(rec, names=("modern-media.piv", "legacy-v4.piv", "legacy-v3.piv", "figure-media.stk")):
    """Malformed documents: one field removed or replaced by a value of another type, then exported."""
    for name in names:
        path = FIXTURES / name
        s = rec.scenario(f"documents-{name}")
        if s is None:
            continue
        result = imported(s.import_file(path))
        document, source_id = result["document"], result["sourceId"]
        if document["version"] == 5 and name.endswith(".piv"):
            # Make the edit go through the full writer whatever the mutation is.
            document["keyframes"][0]["objects"][0]["root_x"] += 1.0
        paths = [p for p in walk_paths(document) if not (set(map(str, p)) & SKIP_KEYS)]
        for index, path_ in enumerate(paths):
            for replacement in (REPLACEMENTS if THOROUGH else REPLACEMENTS[index % 3::3] + [DELETE, None]):
                try:
                    doc = mutated(document, path_, replacement)
                except (KeyError, IndexError, TypeError):
                    continue
                label = "/".join(map(str, path_)) + " = " + ("<deleted>" if replacement is DELETE else json.dumps(replacement))
                fmt = "stk" if name.endswith(".stk") or index % 7 == 6 else "piv"
                s.export(doc, fmt, source_id=source_id if index % 5 else None, figure=2 if fmt == "stk" else None, note=label)
        for path_ in [("glyphs",), ("placements",)]:
            for figure in document["figure_types"]:
                for asset in figure.get("text_assets", []):
                    for replacement in (DELETE, None, [], [{}], "x"):
                        doc = copy.deepcopy(document)
                        target = next(a for f in doc["figure_types"] for a in f.get("text_assets", []) if a.get("text") == asset.get("text"))
                        if replacement is DELETE:
                            target.pop(path_[0], None)
                        else:
                            target[path_[0]] = replacement
                        s.export(doc, "piv", source_id=source_id, note=f"text {path_[0]} = {replacement!r}")
        s.close()


def record(args):
    rec = Recorder(args.out, args.only)
    suites = args.suite or ["fixtures", "service", "native", "documents", "import", "edits", "errors"]
    have_corpus = bool(corpus_files("pivs", "yuki", "waffles"))
    started = time.time()
    for suite in suites:
        print(f"suite {suite}", flush=True)
        if suite == "fixtures":
            suite_fixtures(rec)
        elif suite == "service":
            suite_service(rec)
        elif suite == "native":
            suite_native(rec)
        elif suite == "documents":
            suite_documents(rec)
        elif not have_corpus:
            print("  skipped: the private corpus (~/Downloads/pivs, ~/Downloads/WafflesPack) is not on this machine")
        elif suite == "import":
            small = corpus_files("yuki", "waffles", "artifacts")
            suite_import(rec, small + (corpus_files("pivs") if not args.quick else []))
            suite_import(rec, corpus_files("yuki") + (corpus_files("pivs") if not args.quick else []), limits="web", exports=False)
        elif suite == "edits":
            files = corpus_files("yuki", "waffles", "artifacts")
            suite_edits(rec, files + (corpus_files("pivs") if not args.quick else []))
        elif suite == "errors":
            files = corpus_files("yuki", "waffles", "artifacts")
            piv = [p for p in files if p.endswith(".piv")][:8]
            stk = [p for p in files if p.endswith(".stk")][::9][:14]
            suite_errors(rec, piv + stk + ([min(corpus_files("pivs"), key=os.path.getsize)] if corpus_files("pivs") and not args.quick else []))
    print(f"recorded {rec.requests} requests in {rec.scenarios} scenarios in {time.time() - started:.0f} s -> {rec.out}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", required=True, help="directory to record into")
    parser.add_argument("--suite", action="append", choices=["fixtures", "service", "native", "documents", "import", "edits", "errors"])
    parser.add_argument("--only", action="append", help="record only scenarios whose name contains this text")
    parser.add_argument("--quick", action="store_true", help="leave out the large ~/Downloads/pivs files")
    record(parser.parse_args())


if __name__ == "__main__":
    main()
