"""Independent Pillow + ZIP validation of browser-generated image artifacts.

This is a verification dependency only. Production image exports use browser
workers and require neither Python imaging libraries nor the codec backend.
"""
from io import BytesIO
import json
from pathlib import Path
from zipfile import ZipFile

from PIL import Image

artifacts = Path(__file__).resolve().parents[1] / "artifacts"
result = {}
for extension in ("gif", "apng"):
    path = artifacts / f"image-export-test.{extension}"
    with Image.open(path) as image:
        assert image.size == (160, 90), (extension, image.size)
        assert image.n_frames == 8, (extension, image.n_frames)
        durations = []
        for index in range(image.n_frames):
            image.seek(index)
            rgba = image.convert("RGBA")
            pixel = rgba.getpixel((20, 20))
            assert pixel == ((255, 0, 0, 255) if index < 4 else (0, 0, 255, 255)), (extension, index, pixel)
            assert rgba.getpixel((1, 1))[3] == 0, (extension, index, "transparency")
            durations.append(image.info["duration"])
        expected = 330 if extension == "gif" else 8 * 1000 / 24
        assert abs(sum(durations) - expected) < 0.001, (extension, durations)
        result[extension] = {"frames": image.n_frames, "dimensions": image.size,
            "durations_ms": durations, "total_ms": sum(durations)}

for format_name, suffix in (("png-sequence", ".png"), ("jpeg-sequence", ".jpg")):
    with ZipFile(artifacts / f"image-export-test.{format_name}.zip") as archive:
        assert archive.testzip() is None
        assert len(archive.namelist()) == 9
        for index in range(8):
            filename = f"frame-{index + 1:06d}{suffix}"
            with Image.open(BytesIO(archive.read(filename))) as image:
                assert image.size == (160, 90), (filename, image.size)
                image.load()
                pixel = image.convert("RGB").getpixel((20, 20))
                assert pixel[0 if index < 4 else 2] > 240, (filename, pixel)
        manifest = json.loads(archive.read("animation.json"))
        assert manifest["fps"] == 24 and manifest["totalFrames"] == 8
        result[format_name] = {"frames": 8, "crc_validation": "passed", "metadata": manifest}

with Image.open(artifacts / "image-export-gradient.gif") as image:
    image.load()
    assert image.size == (256, 128)
    result["gradient"] = {"dimensions": image.size, "decode": "passed"}

(artifacts / "image-export-independent.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
print(json.dumps(result, indent=2))
