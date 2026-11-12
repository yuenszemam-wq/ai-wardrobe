#!/usr/bin/env python3
"""Phase 3：擴充 Avatar V2 骨架（可重複執行）。
- 把 torso.png 拆成腰腹（torso）與上胸（chest），兩者之間以漸變重疊，新增 chest 骨骼。
- 放寬關節可動範圍（支援叉腰、提裙擺、伸手等站姿），加入可平移的節點（整體重心、肩膊、頭）。
- 新增側髮骨骼。
素材原圖不變；只寫入 body/chest.png、body/torso.png（由 body/torso_full.png 產生）及 rig.json。
"""
import json, os
from PIL import Image

ROOT = os.path.join(os.path.dirname(__file__), "..", "public", "doll", "avatar_v2")
rig_path = os.path.join(ROOT, "rig.json")
rig = json.load(open(rig_path, encoding="utf-8"))

full_path = os.path.join(os.path.dirname(__file__), "doll-src", "avatar_v2", "torso_full.png")
torso_path = os.path.join(ROOT, "body", "torso.png")
if not os.path.exists(full_path):
    Image.open(torso_path).save(full_path)
full = Image.open(full_path).convert("RGBA")
tp = rig["parts"]["torso"]
sy = full.height / tp["h"]
CUT = 560            # 畫布 y：上胸與腰腹的分界（胸下）
FEATHER = 22

def ramp(img, y0, y1, keep_above):
    """alpha 在 y0→y1（畫布座標）之間由 1 漸變到 0（keep_above=True 保留上方）"""
    out = img.copy()
    a = out.getchannel("A")
    px = a.load()
    for y in range(out.height):
        cy = tp["y"] + y / sy
        t = min(1.0, max(0.0, (cy - y0) / (y1 - y0)))
        k = (1 - t) if keep_above else t
        if k >= 1: continue
        for x in range(out.width):
            px[x, y] = int(px[x, y] * k)
    out.putalpha(a)
    return out

chest = ramp(full, CUT, CUT + FEATHER * 2, True)           # 上胸：下緣柔化
lower = ramp(full, CUT - FEATHER * 2, CUT - FEATHER, False)  # 腰腹：上緣在上胸之內
chest.save(os.path.join(ROOT, "body", "chest.png"))
lower.save(torso_path)

rig["version"] = 3
rig["parts"]["chest"] = {**tp, "src": "body/chest.png", "bone": "chest"}
bones = {b["id"]: b for b in rig["bones"]}
if "chest" not in bones:
    i = next(i for i, b in enumerate(rig["bones"]) if b["id"] == "torso") + 1
    rig["bones"].insert(i, {"id": "chest", "parent": "torso", "rest_position": [600, CUT], "rest_angle": 0, "pivot": [600, CUT], "min_angle": -10, "max_angle": 10, "attached_assets": ["chest"]})
    bones = {b["id"]: b for b in rig["bones"]}
for k in ("neck", "shoulder_r", "shoulder_l"):
    bones[k]["parent"] = "chest"
for lst in ("draw_order", "body_parts"):
    if "chest" not in rig[lst]:
        rig[lst].insert(rig[lst].index("torso") + 1, "chest")

LIMITS = {
    "root": (-10, 10), "pelvis": (-10, 10), "torso": (-12, 12), "chest": (-10, 10), "neck": (-14, 14), "head": (-22, 22),
    "shoulder_r": (-35, 95), "shoulder_l": (-95, 35), "elbow_r": (-135, 60), "elbow_l": (-60, 135), "wrist_r": (-50, 50), "wrist_l": (-50, 50),
    "hip_r": (-22, 30), "hip_l": (-30, 22), "knee_r": (-40, 40), "knee_l": (-40, 40), "ankle_r": (-30, 30), "ankle_l": (-30, 30),
    "hair_tail_r": (-25, 25), "hair_tail_l": (-25, 25),
}
for k, (lo, hi) in LIMITS.items():
    bones[k]["min_angle"], bones[k]["max_angle"] = lo, hi
OFFSETS = {"root": [260, 160], "pelvis": [30, 30], "chest": [16, 16], "head": [16, 16], "shoulder_r": [26, 26], "shoulder_l": [26, 26], "elbow_r": [12, 12], "elbow_l": [12, 12], "hip_r": [14, 14], "hip_l": [14, 14]}
for k, v in OFFSETS.items():
    bones[k]["max_offset"] = v
for side, part in (("r", "hair_side_r"), ("l", "hair_side_l")):
    bid = "hair_side_" + side
    p = rig["parts"][part]
    if bid not in bones:
        pivot = [p["x"] + p["w"] // 2, p["y"] + 6]
        rig["bones"].append({"id": bid, "parent": "head", "rest_position": pivot, "rest_angle": 0, "pivot": pivot, "min_angle": -14, "max_angle": 14, "attached_assets": [part]})
    p["bone"] = bid
ab = rig["anchor_bone"]
for k in ("shoulder_r", "shoulder_l", "bust", "bust_side_r", "bust_side_l"):
    ab[k] = "chest"
json.dump(rig, open(rig_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("rig v3:", len(rig["bones"]), "bones")
