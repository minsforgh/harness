"""단색 배경 위 그림을 자른다. 바깥 배경과 이어진 곳(과 넓게 갇힌 배경)만 투명하게 하고 안쪽은 색이 배경과 비슷해도 불투명으로 둔다.
사용: python cut_solid.py <spec.json>
spec: {"sheet": "원본.png", "out": "저장 폴더", "prefix": "이름_", "pad": 4,
       "parts": {"부위": [x0, y0, x1, y1], ...}, "keep": ["갇힌 배경도 채울 부위"]}
그림 한 장을 통째로 자르려면 parts에 그림 전체 사각형 하나를 넣는다. 배경색은 테두리 4픽셀의 중앙값이다.
원본: MaxwellDemon Assets/Entropy/Art/Tools~/cut_solid.py (2026-11-06)"""
import json, os, sys
from collections import deque
import numpy as np
from PIL import Image, ImageFilter

def flood(bgm, seeds):
    h, w = bgm.shape; out = np.zeros((h, w), bool); q = deque()
    for y, x in seeds:
        if bgm[y, x] and not out[y, x]: out[y, x] = True; q.append((y, x))
    while q:
        y, x = q.popleft()
        for ny, nx in ((y+1, x), (y-1, x), (y, x+1), (y, x-1)):
            if 0 <= ny < h and 0 <= nx < w and bgm[ny, nx] and not out[ny, nx]:
                out[ny, nx] = True; q.append((ny, nx))
    return out

def comps(m):
    h, w = m.shape; lab = np.zeros((h, w), np.int32); sizes = [0]; cur = 0
    for y in range(h):
        for x in np.flatnonzero(m[y] & (lab[y] == 0)):
            if lab[y, x]: continue
            cur += 1; q = deque([(y, x)]); lab[y, x] = cur; n = 0
            while q:
                cy, cx = q.popleft(); n += 1
                for ny, nx in ((cy+1, cx), (cy-1, cx), (cy, cx+1), (cy, cx-1)):
                    if 0 <= ny < h and 0 <= nx < w and m[ny, nx] and not lab[ny, nx]:
                        lab[ny, nx] = cur; q.append((ny, nx))
            sizes.append(n)
    return lab, np.array(sizes)

def cut(rgb, bg, keep_holes=False, tol=16, hole_min=500):
    dist = np.abs(rgb - bg).sum(axis=2)
    bgm = dist < tol
    h, w = bgm.shape
    seeds = [(0, x) for x in range(w)] + [(h-1, x) for x in range(w)] + [(y, 0) for y in range(h)] + [(y, w-1) for y in range(h)]
    out = flood(bgm, seeds)
    if not keep_holes:
        lab, sizes = comps(bgm & ~out)
        big = sizes >= hole_min; big[0] = False
        out |= big[lab]
    # 본체에서 떨어진 작은 덩어리(이름표 글자)는 지운다.
    lab, sizes = comps(~out)
    if sizes.size > 1:
        keep = sizes >= max(400, sizes[1:].max() * 0.05); keep[0] = False
        solid = keep[lab]
    else:
        solid = ~out
    # 바깥과 닿은 가장자리만 배경과 섞인 정도로 알파를 준다.
    near = np.asarray(Image.fromarray((~solid * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(3))) > 0
    al = solid.astype(np.float32)
    edge = solid & near
    al[edge] = np.clip((dist[edge] - 8.0) / 40.0, 0.25, 1.0)
    # 원본에 스티커처럼 그려진 밝은 테두리를 바깥에서부터 깎는다.
    lum = rgb.mean(axis=2)
    for _ in range(3):
        op = al > 0.05
        nb = np.asarray(Image.fromarray((~op * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(3))) > 0
        e = op & nb & (lum > bg.mean() - 4)
        if not e.any(): break
        al[e] = 0
    safe = np.maximum(al, 1e-3)[..., None]
    col = np.clip((rgb - (1 - al[..., None]) * bg) / safe, 0, 255)
    col = np.where(al[..., None] > 0, col, 0)
    return np.dstack([col, al * 255]).astype(np.uint8)

def main(spec_path):
    spec = json.load(open(spec_path, encoding="utf-8"))
    a = np.asarray(Image.open(spec["sheet"]).convert("RGB")).astype(np.float32)
    border = np.concatenate([a[:4].reshape(-1, 3), a[-4:].reshape(-1, 3), a[:, :4].reshape(-1, 3), a[:, -4:].reshape(-1, 3)])
    bg = np.median(border, axis=0)
    os.makedirs(spec["out"], exist_ok=True); pad = spec.get("pad", 4); H, W = a.shape[:2]
    for name, (x0, y0, x1, y1) in spec["parts"].items():
        x0, y0, x1, y1 = max(0, x0-pad), max(0, y0-pad), min(W-1, x1+pad), min(H-1, y1+pad)
        out = cut(a[y0:y1+1, x0:x1+1], bg, name in spec.get("keep", []))
        Image.fromarray(out, "RGBA").save(os.path.join(spec["out"], spec["prefix"] + name + ".png"))
        print(name, out.shape[1], out.shape[0])

if __name__ == "__main__":
    main(sys.argv[1])
