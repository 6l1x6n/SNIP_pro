"""
shard_index.py — режет vectors.bin и chunks.json на шарды ≤4 MiB
(лимит Pages — 25 MiB на файл; мельче — надёжнее для POST-батчей к Pages API),
обновляет manifest.json (поля shards.vectors / shards.chunks). Идемпотентно:
повторный запуск склеивает шарды обратно в монолиты и режет заново.
"""
import json
import struct
import sys
from pathlib import Path

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "/Users/alikhan/Documents/Projects/SNIP_pro/frontend/public/index")
MAX = 4 * 1024 * 1024  # 4 MiB на шард: рвётся соединение на больших POST-батчах к Pages API

manifest = json.loads((OUT / "manifest.json").read_text(encoding="utf-8"))

# ---------- vectors.bin (идемпотентно: если исходника нет — склеиваем шарды) ----------
if not (OUT / "vectors.bin").exists():
    out = bytearray()
    count_total, k = 0, 0
    while (OUT / f"vectors_{k}.bin").exists():
        raw = (OUT / f"vectors_{k}.bin").read_bytes()
        _, dim0, n = struct.unpack_from("<4sII", raw, 0)
        if k == 0:
            out += raw[:12]
        out += raw[12:]
        count_total += n
        k += 1
    out[8:12] = struct.pack("<I", count_total)
    (OUT / "vectors.bin").write_bytes(bytes(out))
    print(f"склеено из {k} шардов: {count_total} векторов")

raw = (OUT / "vectors.bin").read_bytes()
magic, dim, count = struct.unpack_from("<4sII", raw, 0)
assert magic == b"SNV1", "не тот формат"
scales_off, scales_len = 12, 4 * count
data_off, data_len = scales_off + scales_len, count * dim
assert len(raw) == data_off + data_len, f"размер {len(raw)} != {data_off + data_len}"

per_shard_vec = max(1, MAX // (4 + dim))  # векторов на шард: scales(4) + int8(dim)
n_shards = (count + per_shard_vec - 1) // per_shard_vec
for f in OUT.glob("vectors_*.bin"):
    f.unlink()
written = 0
for k in range(n_shards):
    a, b = k * per_shard_vec, min((k + 1) * per_shard_vec, count)
    n = b - a
    shard = struct.pack("<4sII", b"SNV1", dim, n) + raw[scales_off + 4 * a: scales_off + 4 * b] \
            + raw[data_off + a * dim: data_off + b * dim]
    (OUT / f"vectors_{k}.bin").write_bytes(shard)
    written += n
    print(f"vectors_{k}.bin: {n} x {dim}d ({len(shard)/1e6:.1f} MB)")
assert written == count
if n_shards > 1:
    (OUT / "vectors.bin").unlink()

# ---------- chunks.json (идемпотентно: если исходника нет — склеиваем шарды) ----------
if not (OUT / "chunks.json").exists():
    parts = []
    k = 0
    while (OUT / f"chunks_{k}.json").exists():
        parts.extend(json.loads((OUT / f"chunks_{k}.json").read_text(encoding="utf-8")))
        k += 1
    (OUT / "chunks.json").write_text(json.dumps(parts, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"склеено из {k} шардов: {len(parts)} чанков")

chunks = json.loads((OUT / "chunks.json").read_text(encoding="utf-8"))
chunk_bytes = (OUT / "chunks.json").stat().st_size // max(1, len(chunks)) + 1
chunk_shards = max(1, (len(chunks) * chunk_bytes + MAX - 1) // MAX)
for f in OUT.glob("chunks_*.json"):
    f.unlink()
per = (len(chunks) + chunk_shards - 1) // chunk_shards
for k in range(chunk_shards):
    part = chunks[k * per: (k + 1) * per]
    (OUT / f"chunks_{k}.json").write_text(json.dumps(part, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"chunks_{k}.json: {len(part)} чанков")
if chunk_shards > 1:
    (OUT / "chunks.json").unlink()

manifest["shards"] = {"vectors": n_shards, "chunks": chunk_shards}
(OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"manifest: shards.vectors={n_shards}, shards.chunks={chunk_shards}")
print("✅ готово")
