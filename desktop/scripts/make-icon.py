# -*- coding: utf-8 -*-
# Значок программы: зелёный квадрат со скруглёнными углами и белый плюс — тот же знак,
# что стоит в левом верхнем углу интерфейса. Файлы значка лежат в репозитории готовыми;
# этот сценарий нужен, только если знак захотят поменять.
#
# Запуск:  python scripts/make-icon.py   (нужен Pillow: pip install pillow)
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'assets')

ACCENT = (15, 118, 110, 255)  # --accent из client/src/index.css
WHITE = (255, 255, 255, 255)


def draw(size):
    # Рисуем вчетверо крупнее и уменьшаем: так края выходят гладкими, без «лесенки»
    k = 4
    s = size * k
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = round(s * 0.06)
    d.rounded_rectangle([pad, pad, s - pad, s - pad], radius=round(s * 0.22), fill=ACCENT)
    # Плюс: две скруглённые полосы
    arm = round(s * 0.075)   # половина толщины полосы
    half = round(s * 0.25)   # половина длины полосы
    c = s // 2
    r = round(s * 0.035)     # лёгкое скругление: с полным плюс превращался в кляксу
    d.rounded_rectangle([c - half, c - arm, c + half, c + arm], radius=r, fill=WHITE)
    d.rounded_rectangle([c - arm, c - half, c + arm, c + half], radius=r, fill=WHITE)
    return img.resize((size, size), Image.LANCZOS)


os.makedirs(OUT, exist_ok=True)
draw(512).save(os.path.join(OUT, 'icon.png'))
# В .ico кладём все размеры, которые Windows показывает: от значка в заголовке окна
# до крупной плитки. Каждый рисуется отдельно, а не уменьшается из большого —
# мелкие получаются чётче.
sizes = [16, 24, 32, 48, 64, 128, 256]
frames = [draw(n) for n in sizes]
frames[-1].save(os.path.join(OUT, 'icon.ico'), format='ICO', sizes=[(n, n) for n in sizes], append_images=frames[:-1])
print('готово:', ', '.join(sorted(f for f in os.listdir(OUT) if f.startswith('icon'))))
