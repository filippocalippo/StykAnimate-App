"""Writes zstd test frames (<n>.zst) with their original data (<n>.raw) into a
directory, using libzstd through ctypes. Prints SKIPPED and exits 0 when
libzstd is not available.

Usage: python3 gen_zstd_cases.py <output directory>
"""
import ctypes, ctypes.util, json, os, random, sys


def load():
    for name in ('libzstd.so.1', 'libzstd.so', ctypes.util.find_library('zstd')):
        if not name:
            continue
        try:
            return ctypes.CDLL(name)
        except OSError:
            continue
    return None


lib = load()
if lib is None:
    print('SKIPPED: libzstd not available')
    sys.exit(0)

lib.ZSTD_createCCtx.restype = ctypes.c_void_p
lib.ZSTD_CCtx_setParameter.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int]
lib.ZSTD_compress2.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_size_t, ctypes.c_char_p, ctypes.c_size_t]
lib.ZSTD_compress2.restype = ctypes.c_size_t
lib.ZSTD_compressBound.restype = ctypes.c_size_t
lib.ZSTD_compressBound.argtypes = [ctypes.c_size_t]
lib.ZSTD_isError.argtypes = [ctypes.c_size_t]
lib.ZSTD_freeCCtx.argtypes = [ctypes.c_void_p]
LEVEL, CONTENT_SIZE, CHECKSUM = 100, 200, 201


def compress(data, level, checksum, content_size):
    ctx = lib.ZSTD_createCCtx()
    lib.ZSTD_CCtx_setParameter(ctx, LEVEL, level)
    lib.ZSTD_CCtx_setParameter(ctx, CHECKSUM, 1 if checksum else 0)
    lib.ZSTD_CCtx_setParameter(ctx, CONTENT_SIZE, 1 if content_size else 0)
    cap = lib.ZSTD_compressBound(len(data))
    buf = ctypes.create_string_buffer(cap)
    n = lib.ZSTD_compress2(ctx, buf, cap, data, len(data))
    lib.ZSTD_freeCCtx(ctx)
    if lib.ZSTD_isError(n):
        raise RuntimeError('zstd compression failed')
    return buf.raw[:n]


random.seed(7)
words = ['figure', 'keyframe', 'angles', 'parent', 'length', 'thickness', 'style', 'visible', 'layer', 'fps']


def jsonish(n):
    items = []
    while sum(len(x) for x in items) < n:
        items.append(json.dumps({
            'id': random.randrange(1 << 20), 'name': random.choice(words) + str(random.randrange(100)),
            'angles': [round(random.uniform(-3.14, 3.14), random.choice([2, 4, 8])) for _ in range(random.randrange(1, 20))],
            'flags': [random.random() < .5 for _ in range(5)]}))
    return (','.join(items))[:n].encode()


cases = [b'', b'a', b'hello world ' * 3, bytes(100000), os.urandom(5000), os.urandom(300000),
         bytes(random.choice(b'abcde') for _ in range(50000))]
cases += [jsonish(n) for n in (100, 1000, 20000, 140000, 700000)]
cases.append(b''.join(bytes([i % 7 + 65]) * (1 + i % 13) for i in range(40000)))
cases.append(bytes((i * i >> 3) % 251 for i in range(200000)))

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
k = 0
for data in cases:
    for level in (1, 3, 9, 19, -3):
        for checksum, content_size in ((False, True), (True, True), (True, False)):
            with open(os.path.join(out, 'c%d.zst' % k), 'wb') as f:
                f.write(compress(data, level, checksum, content_size))
            with open(os.path.join(out, 'c%d.raw' % k), 'wb') as f:
                f.write(data)
            k += 1
print('%d zstd cases' % k)
