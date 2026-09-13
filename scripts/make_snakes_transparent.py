"""make_snakes_transparent.py — убирает белый фон у PNG змейки Snippy.

Flood-fill от краёв: почти-белые связные области → прозрачность.
Заодно ресайз 1254→640px и оптимизация (быстрая загрузка на мобилках).

Запуск: /opt/homebrew/bin/python3 scripts/make_snakes_transparent.py
"""
from pathlib import Path
from collections import deque
from PIL import Image

SRC = Path(__file__).resolve().parents[1] / "frontend" / "public" / "snakes"
TARGET = 640          # итоговый размер
THRESHOLD = 242       # канал >= порога считается белым
TOLERANCE = 18        # допуск антиалиасных краёв

def make_transparent(img: Image.Image) -> Image.Image:
    img = img.convert("RGBA")
    w, h = img.size
    px = img.load()

    def is_white(p) -> bool:
        return p[0] >= THRESHOLD and p[1] >= THRESHOLD and p[2] >= THRESHOLD

    seen = bytearray(w * h)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if is_white(px[x, y]) and not seen[y * w + x]:
                seen[y * w + x] = 1; q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if is_white(px[x, y]) and not seen[y * w + x]:
                seen[y * w + x] = 1; q.append((x, y))

    while q:
        x, y = q.popleft()
        px[x, y] = (255, 255, 255, 0)
        for nx, ny in ((x+1,y),(x-1,y),(x,y+1),(x,y-1)):
            if 0 <= nx < w and 0 <= ny < h and not seen[ny*w+nx]:
                p = px[nx, ny]
                # белый заливаем полностью, светло-серую кайму — полупрозрачно
                if min(p[:3]) >= THRESHOLD:
                    seen[ny*w+nx] = 1; q.append((nx, ny))
                elif min(p[:3]) >= THRESHOLD - TOLERANCE:
                    seen[ny*w+nx] = 1
                    px[nx, ny] = (p[0], p[1], p[2], int(255 * (min(p[:3]) - (THRESHOLD - TOLERANCE)) / TOLERANCE))
                    q.append((nx, ny))
    return img

def main():
    files = sorted(SRC.glob("*.png"))
    print(f"Обработка {len(files)} файлов в {SRC}")
    for f in files:
        im = Image.open(f)
        out = make_transparent(im)
        out = out.resize((TARGET, TARGET), Image.LANCZOS)
        out.save(f, "PNG", optimize=True)
        print(f"  ✓ {f.name}: {im.size} → {TARGET}px, фон прозрачный")

if __name__ == "__main__":
    main()
