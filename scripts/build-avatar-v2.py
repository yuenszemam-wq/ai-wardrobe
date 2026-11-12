#!/usr/bin/env python3
"""Avatar V2：由一張完整人物圖自動拆出可動 2D 角色部件。

用法（可重複執行，結果固定）：
    python3 scripts/build-avatar-v2.py [--src scripts/doll-src/avatar_v2] [--out public/doll/avatar_v2]

輸入（scripts/doll-src/avatar_v2/）：
    source_full.png     完整人物圖（唯一美術基準）
    reference_bald.png  無髮參考圖（只用來補回被頭髮遮住的頭皮、額頭、耳朵及頸側）

輸出（public/doll/avatar_v2/）：
    avatar_base_v2.png           1200×1800 透明基準圖
    body/*.png  hair/twin_tails_long/*.png   緊密裁切的部件（位置記錄在 rig.json）
    rig.json                     骨架、關節、部件位置、繪畫次序、衣物錨點
  docs/avatar_v2/*.png           assembly／joint_debug／pose_test 預覽（不會部署）

只在開發環境執行（需要 Pillow、numpy、opencv）。不讀寫 D1／R2，不使用任何 AI 生成。
所有像素均直接取自兩張輸入圖；「synthesized」標記的範圍是用鄰近像素延伸（inpaint）補出來的，
並非原圖內容，見 README。
"""
import argparse
import json
import math
import os

import cv2
import numpy as np
from PIL import Image, ImageDraw

W, H = 1200, 1800

# ───────── 人工量度的座標（1200×1800 畫布；_r＝角色本人的右邊＝畫面左邊） ─────────
JOINT = {
    "root": (600, 800),
    "pelvis": (600, 800),
    "torso": (600, 735),
    "neck": (600, 352),
    "head": (600, 300),
    "shoulder_r": (477, 393), "elbow_r": (425, 650), "wrist_r": (314, 885),
    "shoulder_l": (724, 393), "elbow_l": (775, 650), "wrist_l": (882, 885),
    "hip_r": (518, 862), "knee_r": (541, 1238), "ankle_r": (521, 1650),
    "hip_l": (682, 862), "knee_l": (651, 1238), "ankle_l": (660, 1650),
    "hair_tail_r": (489, 95), "hair_tail_l": (711, 95),
}
RADIUS = {  # 關節重疊圓的半徑
    "shoulder": 38, "elbow": 35, "wrist": 24, "hip": 78, "knee": 46, "ankle": 31, "tail": 22,
}
ARM_CUT_R, ARM_CUT_L = 492, 709          # 手臂與軀幹的分界（腋下摺線）
WAIST_TOP, WAIST_BOTTOM = 712, 752       # 軀幹／骨盆重疊帶（只有皮膚，沒有衣物邊）
NECK_TOP, NECK_BOTTOM = 255, 372
BALD_FILL_BOTTOM = 352                   # 這條線以上，被頭髮遮住的身體用無髮圖補
# 內褲褲腳線（由外到內），腿在這條線以下
HEM_R = [(430, 806), (447, 812), (500, 822), (540, 840), (570, 856), (590, 868), (600, 872)]
HEM_L = [(770, 806), (753, 812), (700, 822), (660, 840), (630, 856), (610, 868), (600, 872)]
JAW = [(455, 0), (745, 0), (745, 236), (700, 240), (682, 256), (662, 276), (640, 290), (620, 298), (600, 302),
       (580, 298), (560, 290), (538, 276), (518, 256), (500, 240), (455, 236)]
EYE_R = [(514, 198), (524, 188), (532, 182), (565, 182), (565, 189), (582, 190), (584, 205), (574, 218), (555, 222), (535, 220), (520, 210)]
EYE_L = [(618, 190), (636, 189), (636, 182), (668, 181), (680, 186), (690, 193), (688, 208), (678, 217), (660, 221), (640, 219), (626, 212), (619, 203)]
EYE_X0, EYE_X1 = 531, 680                  # 這範圍以外的外眼角被側髮蓋住，改用無髮圖的眼線
FACE_WINDOW = [(522, 110), (678, 110), (678, 200), (522, 200)]   # 瀏海縫隙可能露出額頭的範圍
EAR_R = [(494, 194), (510, 194), (510, 240), (494, 240)]
EAR_L = [(690, 194), (708, 194), (708, 240), (690, 240)]
# 馬尾與頭上頭髮的分界線
TAIL_R_LINE = [(504, 0), (504, 20), (494, 60), (487, 95), (492, 140), (497, 200), (495, 240), (497, 335), (497, 380)]
TAIL_L_LINE = [(696, 0), (696, 20), (706, 60), (713, 95), (708, 140), (703, 200), (705, 240), (703, 335), (703, 380)]
HAIR_BOTTOM = 730                         # 頭髮最低位置（之下不會有頭髮）
BEHIND = 26                               # 馬尾在身體後面向內延伸的距離
TAIL_BELOW = 380                          # 這條線以下的頭髮全部屬於馬尾
SIDE_X_R, SIDE_X_L, SIDE_TOP = 524, 676, 128   # 側髮範圍

ANGLE_LIMIT = {  # 度；第一版只做小幅度正面站姿調整
    "root": (0, 0), "pelvis": (-4, 4), "torso": (-5, 5), "neck": (-6, 6), "head": (-10, 10),
    "shoulder_r": (-22, 28), "shoulder_l": (-28, 22), "elbow_r": (-25, 25), "elbow_l": (-25, 25), "wrist_r": (-20, 20), "wrist_l": (-20, 20),
    "hip_r": (-4, 12), "hip_l": (-12, 4), "knee_r": (-10, 10), "knee_l": (-10, 10), "ankle_r": (-12, 12), "ankle_l": (-12, 12),
    "hair_tail_r": (-8, 8), "hair_tail_l": (-8, 8),
}
PARENT = {
    "root": None, "pelvis": "root", "torso": "pelvis", "neck": "torso", "head": "neck",
    "shoulder_r": "torso", "elbow_r": "shoulder_r", "wrist_r": "elbow_r",
    "shoulder_l": "torso", "elbow_l": "shoulder_l", "wrist_l": "elbow_l",
    "hip_r": "pelvis", "knee_r": "hip_r", "ankle_r": "knee_r",
    "hip_l": "pelvis", "knee_l": "hip_l", "ankle_l": "knee_l",
    "hair_tail_r": "head", "hair_tail_l": "head",
}
# 部件 → 骨骼；次序＝由底到面的繪畫次序
BODY_ORDER = [
    ("pelvis_under", "pelvis"),
    ("foot_r", "ankle_r"), ("foot_l", "ankle_l"),
    ("lower_leg_r", "knee_r"), ("lower_leg_l", "knee_l"),
    ("upper_leg_r", "hip_r"), ("upper_leg_l", "hip_l"),
    ("pelvis", "pelvis"),
    ("torso", "torso"),
    ("hand_r", "wrist_r"), ("hand_l", "wrist_l"),
    ("lower_arm_r", "elbow_r"), ("lower_arm_l", "elbow_l"),
    ("upper_arm_r", "shoulder_r"), ("upper_arm_l", "shoulder_l"),
    ("neck", "neck"),
    ("head", "head"),
]
HAIR_BACK = [("hair_tail_r", "hair_tail_r"), ("hair_tail_l", "hair_tail_l"), ("hair_back_base", "head")]
HAIR_FRONT = [("hair_side_r", "head"), ("hair_side_l", "head"), ("hair_bangs", "head")]


def K(r):
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))


def poly_mask(points):
    m = np.zeros((H, W), np.uint8)
    cv2.fillPoly(m, [np.array(points, np.int32)], 1)
    return m


def disc(center, r):
    m = np.zeros((H, W), np.uint8)
    cv2.circle(m, (int(center[0]), int(center[1])), int(r), 1, -1)
    return m


YY, XX = np.mgrid[0:H, 0:W].astype(np.float32)


def proj(a, b):
    """每個像素在 a→b 方向上的投影比例（0＝a，1＝b）"""
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    return ((XX - ax) * dx + (YY - ay) * dy) / float(dx * dx + dy * dy)


def left_of(line, extend_below=None):
    """折線左邊的範圍（按每一行的 x 界線）"""
    ys = np.array([p[1] for p in line], np.float32)
    xs = np.array([p[0] for p in line], np.float32)
    bx = np.interp(np.arange(H), ys, xs)
    m = XX < bx[:, None]
    m &= YY <= ys.max()
    return m


def hem_y(line):
    xs = np.array([p[0] for p in line], np.float32)
    ys = np.array([p[1] for p in line], np.float32)
    order = np.argsort(xs)
    return np.interp(np.arange(W), xs[order], ys[order])


def soft(mask, grow=3, sigma=1.4):
    """部件遮罩：先外擴再羽化，令相鄰部件在分界處都有完整不透明度（靜止時不會出現半透明接縫）"""
    m = mask.astype(np.uint8)
    if grow:
        m = cv2.dilate(m, K(grow))
    return cv2.GaussianBlur(m.astype(np.float32), (0, 0), sigma)


def feather_edge(mask, width):
    """向內羽化（用於會在旋轉後露出的內部切邊）"""
    m = mask.astype(np.uint8)
    d = cv2.distanceTransform(m, cv2.DIST_L2, 5)
    return np.clip(d / float(width), 0, 1)


def load_source(path):
    """清除低透明度霧化雜點、把近乎不透明的像素拉到完全不透明，再等比例放大到 1200×1800。"""
    im = Image.open(path).convert("RGBA")
    a = np.asarray(im).astype(np.float32)
    al = np.clip((a[..., 3] - 24) / (248 - 24), 0, 1)
    n, lab, st, _ = cv2.connectedComponentsWithStats((al > 0.02).astype(np.uint8), 8)
    keep = np.zeros(n, bool)
    keep[1:] = st[1:, 4] >= 400
    al = al * keep[lab]
    rgb = a[..., :3] / 255.0
    sw, sh = im.size
    scale = min(W / sw, H / sh)
    nw, nh = round(sw * scale), round(sh * scale)
    pm = np.dstack([rgb * al[..., None], al])
    pm = cv2.resize(pm, (nw, nh), interpolation=cv2.INTER_LANCZOS4)
    canvas = np.zeros((H, W, 4), np.float32)
    ox, oy = (W - nw) // 2, (H - nh) // 2
    canvas[oy:oy + nh, ox:ox + nw] = pm
    al2 = np.clip(canvas[..., 3], 0, 1)
    rgb2 = np.where(al2[..., None] > 1e-4, canvas[..., :3] / np.maximum(al2[..., None], 1e-4), 0)
    return np.clip(rgb2, 0, 1), al2, {"source_size": [sw, sh], "scale": scale, "offset": [ox, oy]}


def hair_candidates(rgb, al):
    hsv = cv2.cvtColor((rgb * 255).astype(np.uint8), cv2.COLOR_RGB2HSV).astype(np.float32)
    h, s, v = hsv[..., 0] * 2, hsv[..., 1] / 255, hsv[..., 2] / 255
    return ((v < 0.62) | ((s > 0.30) & ((h > 315) | (h < 8)) & (v > 0.5))) & (al > 0.3)


def extend_color(rgb, known, fill, blur=2.0):
    """把 known 範圍最近的像素顏色複製到 fill 範圍，再輕微模糊（不會混入其他部位的顏色）。"""
    _, labels = cv2.distanceTransformWithLabels((~known).astype(np.uint8), cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL)
    lut = np.zeros(labels.max() + 1, np.int64)
    lut[labels[known]] = np.flatnonzero(known.ravel())
    flat = rgb.reshape(-1, 3)
    out = rgb.copy()
    hole = fill & ~known
    out[hole] = flat[lut[labels[hole]]]
    if blur:
        sm = cv2.GaussianBlur(out, (0, 0), blur)
        out[hole] = sm[hole]
    return out


def to_rgba8(rgb, al):
    return (np.dstack([np.clip(rgb, 0, 1), np.clip(al, 0, 1)]) * 255 + 0.5).astype(np.uint8)


def over(dst, src):
    """src 疊在 dst 上（兩者為 float RGBA 0–1，非預乘）"""
    sa = src[..., 3:4]
    da = dst[..., 3:4]
    oa = sa + da * (1 - sa)
    rgb = np.where(oa > 1e-6, (src[..., :3] * sa + dst[..., :3] * da * (1 - sa)) / np.maximum(oa, 1e-6), 0)
    return np.dstack([rgb, oa[..., 0]])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="scripts/doll-src/avatar_v2")
    ap.add_argument("--out", default="public/doll/avatar_v2")
    ap.add_argument("--preview", default="docs/avatar_v2")
    args = ap.parse_args()
    out = args.out
    for d in ("body", "hair/twin_tails_long"):
        os.makedirs(os.path.join(out, d), exist_ok=True)
    prev = args.preview
    os.makedirs(prev, exist_ok=True)

    full, fa, meta = load_source(os.path.join(args.src, "source_full.png"))
    bald, ba, _ = load_source(os.path.join(args.src, "reference_bald.png"))
    Image.fromarray(to_rgba8(full, fa)).save(os.path.join(out, "avatar_base_v2.png"), optimize=True)

    # ── 1. 分開頭髮與身體 ──
    cf = hair_candidates(full, fa)
    solid = fa > 0.5
    eyes = (poly_mask(EYE_R) | poly_mask(EYE_L)).astype(bool)
    eyes_wide = cv2.dilate(eyes.astype(np.uint8), K(2)).astype(bool) & (YY >= 181) & (XX >= EYE_X0) & (XX <= EYE_X1)   # 外眼角被側髮蓋住的不取
    eyes &= eyes_wide
    hsv0 = cv2.cvtColor((full * 255).astype(np.uint8), cv2.COLOR_RGB2HSV).astype(np.float32)
    # 瀏海範圍內，只有夠亮夠淡的才算皮膚；淺啡色髮尾及瀏海投在額頭的陰影跟隨頭髮層
    fringe = poly_mask(FACE_WINDOW).astype(bool) & ~eyes_wide
    # 馬尾上偏粉的淺色高光不是皮膚（皮膚色相偏橙）
    hue0 = hsv0[..., 0] * 2
    cf |= solid & ((XX < 470) | (XX > 730)) & (YY < HAIR_BOTTOM) & (hue0 > 300) & (hue0 < 358) & (hsv0[..., 1] / 255 > 0.09)
    cf |= fringe & solid & ~((hsv0[..., 2] / 255 > 0.93) & (hsv0[..., 1] / 255 < 0.2))
    light = (solid & ~cf).astype(np.uint8)
    n, lab = cv2.connectedComponents(cv2.erode(light, K(2)), connectivity=4)
    body = np.zeros((H, W), np.uint8)
    for x, y in [(600, 500), (600, 250), (440, 520), (760, 520), (540, 1000), (660, 1000)]:
        body |= (lab == lab[y, x]).astype(np.uint8)
    body = cv2.dilate(body, K(2)) & light
    ff = body.copy()
    cv2.floodFill(ff, np.zeros((H + 2, W + 2), np.uint8), (0, 0), 1)
    body |= (ff == 0).astype(np.uint8)                      # 身體內的洞（蝴蝶結線條、肚臍等）
    # 頭髮之間露出的皮膚（瀏海縫隙的額頭、耳朵）：淺色、面積夠大、位於指定範圍內 → 不是頭髮
    win = (poly_mask(FACE_WINDOW) | poly_mask(EAR_R) | poly_mask(EAR_L)).astype(bool)
    n2, lab2, st2, _ = cv2.connectedComponentsWithStats((light.astype(bool) & win & ~body.astype(bool)).astype(np.uint8), 4)
    skin_gap = np.isin(lab2, [i for i in range(1, n2) if st2[i, 4] >= 40])
    # 輪廓線歸身體（外擴 2px）；但緊貼厚實髮束的地方只取 1px，避免把頭髮顏色帶到手臂邊
    hair0 = (fa > 0.02) & ~cv2.dilate(body, K(1)).astype(bool)
    thick0 = cv2.dilate(cv2.erode(hair0.astype(np.uint8), K(3)), K(3)).astype(bool)
    outline = (cv2.dilate(body, K(2)).astype(bool) & ~thick0) | cv2.dilate(body, K(1)).astype(bool)
    body_vis = (outline | eyes | cv2.dilate(skin_gap.astype(np.uint8), K(1)).astype(bool)) & (fa > 0.05)
    hair_bin = (fa > 0.02) & ~body_vis
    # 身體輪廓線及半透明邊不是頭髮：貼近身體、又不屬於厚實髮束的薄邊 → 歸身體
    thick = cv2.dilate(cv2.erode(hair_bin.astype(np.uint8), K(3)), K(5)).astype(bool) & hair_bin
    pinkish = (hsv0[..., 1] / 255 > 0.30) & (hsv0[..., 2] / 255 > 0.5) & (fa > 0.5)
    rim = hair_bin & ~thick & ~pinkish & cv2.dilate(body, K(4)).astype(bool)
    hair_bin &= ~rim
    # 頭髮只可能在 HAIR_BOTTOM 以上，而且是成片的；其餘零碎（手指縫、腳趾線）歸身體
    n3, lab3, st3, _ = cv2.connectedComponentsWithStats(hair_bin.astype(np.uint8), 8)
    small = np.isin(lab3, [i for i in range(1, n3) if st3[i, 4] < 200])
    stray = hair_bin & (small | (YY > HAIR_BOTTOM))
    hair_bin &= ~stray
    body_vis |= rim | stray
    body_vis |= eyes_wide & (fa > 0.05) & ~thick
    hair_bin &= ~body_vis

    # ── 2. 身體底圖：可見部分用完整圖；頭髮遮住的頭、耳、頸側用無髮圖補 ──
    both = (fa > 0.9) & (ba > 0.9) & ~cf & ~hair_candidates(bald, ba) & (YY > 215) & (YY < 345) & (np.abs(XX - 600) < 70)
    gain = np.median(full[both] / np.maximum(bald[both], 1e-3), axis=0)
    bald_m = np.clip(bald * gain, 0, 1)
    # 無髮圖的眼睛位置及大小與完整圖略有不同：先把無髮圖的眼睛抹成膚色，眼睛一律用完整圖的
    inner = cv2.erode(((ba > 0.5) & poly_mask(JAW).astype(bool)).astype(np.uint8), K(9)).astype(bool)   # 不碰臉的輪廓線及耳朵
    eye_box = (poly_mask([(512, 170), (596, 170), (596, 230), (512, 230)]) | poly_mask([(604, 170), (688, 170), (688, 230), (604, 230)])).astype(bool) & inner
    bald_dark = cv2.dilate((hair_candidates(bald, ba) | ((bald @ np.array([0.2126, 0.7152, 0.0722], np.float32)) < 0.78)).astype(np.uint8), K(1)).astype(bool)
    bn, blab, bst, _ = cv2.connectedComponentsWithStats((bald_dark & eye_box).astype(np.uint8), 8)
    erase = cv2.dilate(np.isin(blab, [i for i in range(1, bn) if bst[i, 4] >= 60]).astype(np.uint8), K(4)).astype(bool) & cv2.dilate(inner.astype(np.uint8), K(3)).astype(bool) & (XX >= EYE_X0 + 3) & (XX <= EYE_X1 - 3)
    bald_skin = (ba > 0.9) & ~bald_dark & ~erase
    bald_m = extend_color(bald_m, bald_skin, erase, blur=3.0)
    zone = cv2.GaussianBlur((YY < BALD_FILL_BOTTOM).astype(np.float32), (0, 0), 2.0)
    head_zone = YY < BALD_FILL_BOTTOM + 8
    near_hair = cv2.dilate(hair_bin.astype(np.uint8), K(3)).astype(bool)
    vis_head = body_vis & ~(near_hair & ~eyes_wide)
    vis_w = np.where(head_zone, cv2.GaussianBlur(vis_head.astype(np.float32), (0, 0), 1.2),
                     cv2.GaussianBlur(body_vis.astype(np.float32), (0, 0), 1.0))
    full_layer = np.dstack([full, fa * vis_w])
    bald_layer = np.dstack([bald_m, ba * zone])
    body_base = over(bald_layer, full_layer)
    body_rgb, body_a = body_base[..., :3], body_base[..., 3]
    body_sil = body_a > 0.5

    # ── 3. 頭髮層：原圖的頭髮像素；馬尾在身體後面，被身體遮住的部分向內延伸補色 ──
    J = JOINT
    tail_r = (left_of(TAIL_R_LINE) | ((YY > TAIL_BELOW) & (XX < 600)))
    tail_l = (~left_of(TAIL_L_LINE) & (YY <= TAIL_L_LINE[-1][1])) | ((YY > TAIL_BELOW) & (XX >= 600))
    hair_known = hair_bin & (fa > 0.6)
    tail_hair = hair_bin & (tail_r | tail_l)
    d_tail = cv2.distanceTransform((~tail_hair).astype(np.uint8), cv2.DIST_L2, 5)
    behind = (d_tail < BEHIND) & body_sil & ~hair_bin & (tail_r | tail_l)
    hair_rgb = extend_color(full, hair_known, (cv2.dilate(hair_bin.astype(np.uint8), K(BEHIND + 4)) > 0) & ~hair_known, blur=8.0)
    hair_rgb[hair_known] = full[hair_known]
    behind_w = np.clip((BEHIND - d_tail) / 12.0, 0, 1) * behind
    hair_soft = np.clip(cv2.GaussianBlur(cv2.dilate(hair_bin.astype(np.uint8), K(1)).astype(np.float32), (0, 0), 1.0), 0, 1)
    front_fix = np.clip(1 - vis_w, 0, 1) * cv2.dilate(hair_bin.astype(np.uint8), K(5)) * head_zone * ~(tail_r | tail_l)
    hair_a = np.maximum(fa * np.maximum(hair_soft, front_fix), behind_w)
    hair_rgb = np.where((front_fix > 0.01)[..., None] & ~hair_known[..., None] & (fa > 0.3)[..., None], full, hair_rgb)
    is_hair = np.clip(cv2.GaussianBlur((hair_bin | behind).astype(np.float32), (0, 0), 0.8), 0, 1)   # 重新著色只作用於真正的頭髮

    # 挑染（粉色）遮罩：0＝主髮色，1＝挑染
    hsv = cv2.cvtColor((hair_rgb * 255).astype(np.uint8), cv2.COLOR_RGB2HSV).astype(np.float32)
    hh, ss, vv = hsv[..., 0] * 2, hsv[..., 1] / 255, hsv[..., 2] / 255
    redness = hair_rgb[..., 0] - (hair_rgb[..., 1] + hair_rgb[..., 2]) / 2
    accent = np.clip((vv - 0.52) / 0.16, 0, 1) * np.clip((ss - 0.24) / 0.14, 0, 1) * np.clip((redness - 0.10) / 0.10, 0, 1)
    accent *= ((hh > 300) | (hh < 12)).astype(np.float32)
    accent = cv2.GaussianBlur(accent, (0, 0), 1.2)

    # ── 4. 身體部件遮罩 ──
    parts = {}
    notes = {}
    synth = np.zeros((H, W), bool)   # 補色範圍（預覽用）

    def limb_chain(side_mask, a, b, c, ra, rb, rc, names):
        """上段 a→b、下段 b→c、末端（c 之後）。回傳三個布林遮罩。"""
        up = side_mask & (((proj(a, b) >= 0) & (proj(a, b) <= 1)) | disc(a, ra).astype(bool) | disc(b, rb).astype(bool))
        up &= ~((proj(b, c) > 0.25))                         # 不可伸到下段
        low = side_mask & (((proj(a, b) > 1) & (proj(b, c) <= 1)) | disc(b, rb).astype(bool) | disc(c, rc).astype(bool))
        low &= (proj(a, b) > 0.75)
        end = side_mask & ((proj(b, c) > 1) | disc(c, rc).astype(bool)) & (proj(b, c) > 0.8)
        return up, low, end

    cut = body_sil & ~((XX >= ARM_CUT_R) & (XX <= ARM_CUT_L) & (YY < 560)) & (YY > 340)
    _, clab = cv2.connectedComponents(cut.astype(np.uint8), connectivity=4)
    arm_r = (clab == clab[520, 440]) | (body_sil & disc(J["shoulder_r"], RADIUS["shoulder"]).astype(bool))
    arm_l = (clab == clab[520, 760]) | (body_sil & disc(J["shoulder_l"], RADIUS["shoulder"]).astype(bool))
    for side, arm in (("r", arm_r), ("l", arm_l)):
        up, low, hand = limb_chain(arm, J["shoulder_" + side], J["elbow_" + side], J["wrist_" + side], RADIUS["shoulder"], RADIUS["elbow"], RADIUS["wrist"], None)
        parts["upper_arm_" + side] = soft(up)
        parts["lower_arm_" + side] = soft(low)
        parts["hand_" + side] = soft(hand)

    trunk = body_sil & ~(clab == clab[520, 440]) & ~(clab == clab[520, 760])
    print("手臂連通區像素：", int((clab == clab[520, 440]).sum()), int((clab == clab[520, 760]).sum()), "軀幹：", int(trunk.sum()))
    hem = np.minimum(hem_y(HEM_R), hem_y(HEM_L))             # 每個 x 的褲腳線 y
    below_hem = YY > hem[None, :]
    for side, sign in (("r", -1), ("l", 1)):
        half = (XX < 600) if side == "r" else (XX >= 600)
        hip, knee, ankle = J["hip_" + side], J["knee_" + side], J["ankle_" + side]
        leg = trunk & half & (below_hem | disc(hip, RADIUS["hip"]).astype(bool)) & (YY > hip[1] - RADIUS["hip"])
        up = leg & ((YY <= knee[1]) | disc(knee, RADIUS["knee"]).astype(bool))
        low = leg & (((YY > knee[1]) & (YY <= ankle[1])) | disc(knee, RADIUS["knee"]).astype(bool) | disc(ankle, RADIUS["ankle"]).astype(bool)) & (YY > knee[1] - RADIUS["knee"])
        foot = leg & ((YY > ankle[1]) | disc(ankle, RADIUS["ankle"]).astype(bool)) & (YY > ankle[1] - RADIUS["ankle"])
        parts["upper_leg_" + side] = soft(up)
        parts["lower_leg_" + side] = soft(low)
        parts["foot_" + side] = soft(foot)

    sh_discs = disc(J["shoulder_r"], RADIUS["shoulder"]).astype(bool) | disc(J["shoulder_l"], RADIUS["shoulder"]).astype(bool)
    torso_core = (trunk | (body_sil & sh_discs)) & (YY > 322) & (YY < WAIST_BOTTOM)
    parts["torso"] = soft(torso_core) * np.clip((WAIST_BOTTOM - YY) / 14.0, 0, 1)        # 下緣向上羽化
    pelvis_core = trunk & (YY > WAIST_TOP) & ~below_hem
    parts["pelvis"] = soft(pelvis_core, grow=2)
    under = trunk & (YY > WAIST_TOP) & (YY < hem[None, :] + 34)
    parts["pelvis_under"] = soft(under) * np.clip((hem[None, :] + 34 - YY) / 16.0, 0, 1)
    neck_core = body_sil & (XX > 552) & (XX < 648) & (YY > NECK_TOP) & (YY < NECK_BOTTOM)
    parts["neck"] = soft(neck_core) * np.clip((NECK_BOTTOM - YY) / 14.0, 0, 1)
    head_core = body_sil & poly_mask(JAW).astype(bool)
    parts["head"] = soft(head_core, grow=1, sigma=1.0)

    # ── 5. 各部件自己的顏色層（需要補色的地方） ──
    part_rgb = {}
    # 大腿：褲腳線以上、髖關節圓內原本是內褲，改用大腿膚色向上延伸（旋轉時露出的是皮膚）
    for side in ("r", "l"):
        m = parts["upper_leg_" + side] > 0.01
        fill = m & ~below_hem
        known = m & (YY > hem[None, :] + 5)
        part_rgb["upper_leg_" + side] = extend_color(body_rgb, known & body_sil & (body_a > 0.98), fill, blur=4.0)
        synth |= fill
    notes["upper_leg_r"] = notes["upper_leg_l"] = "褲腳線以上（藏在內褲下）的皮膚是由大腿膚色延伸補出"
    # 頸：下巴後面本來是臉，改用下巴陰影下方的頸部膚色向上延伸
    m = parts["neck"] > 0.01
    fill = m & poly_mask(JAW).astype(bool)
    known = m & (YY > 306)
    part_rgb["neck"] = extend_color(body_rgb, known & body_sil & (body_a > 0.98), fill, blur=3.0)
    synth |= fill
    notes["neck"] = "下巴後面（被頭遮住）的頸部是由可見頸部延伸補出"
    notes["head"] = "被頭髮遮住的額頭、頭皮、耳朵及眉毛取自無髮參考圖（已按膚色校正），並非完整圖原有像素"

    # ── 6. 頭髮部件 ──
    hair_all = (hair_a > 0.004)
    tail_r_m = hair_all & (tail_r | disc(J["hair_tail_r"], RADIUS["tail"]).astype(bool))
    tail_l_m = hair_all & (tail_l | disc(J["hair_tail_l"], RADIUS["tail"]).astype(bool))
    cap = hair_all & ~tail_r & ~tail_l
    cap_wide = hair_all & ((~tail_r & ~tail_l) | disc(J["hair_tail_r"], RADIUS["tail"]).astype(bool) | disc(J["hair_tail_l"], RADIUS["tail"]).astype(bool))
    skull = cv2.erode(((ba > 0.5) & poly_mask(JAW).astype(bool)).astype(np.uint8), K(2)).astype(bool)
    side_r = cap & (XX < SIDE_X_R) & (YY > SIDE_TOP) & (skull | (YY > 190))
    side_l = cap & (XX > SIDE_X_L) & (YY > SIDE_TOP) & (skull | (YY > 190))
    lower = cap & (YY > 232)
    side_r |= lower & (XX < 600)
    side_l |= lower & (XX >= 600)
    bangs = cap & skull & ~side_r & ~side_l
    back = cap_wide & ~skull & ~side_r & ~side_l
    # 後髮在頭後面再向內延伸，頭部轉動時不會露出空隙
    back_ext = cv2.dilate(back.astype(np.uint8), K(18)).astype(bool) & skull & (YY < 200)
    hparts = {
        "hair_tail_r": soft(tail_r_m), "hair_tail_l": soft(tail_l_m),
        "hair_back_base": soft(back | back_ext), "hair_side_r": soft(side_r), "hair_side_l": soft(side_l), "hair_bangs": soft(bangs),
    }
    hair_alpha = {k: np.minimum(v, 1) * hair_a for k, v in hparts.items()}
    hair_alpha["hair_back_base"] = np.minimum(hparts["hair_back_base"], 1) * np.maximum(hair_a, back_ext * fa)
    notes["hair_tail_r"] = notes["hair_tail_l"] = "被肩膊及手臂遮住的馬尾部分（約 26px）是由鄰近髮色延伸補出"

    # ── 7. 輸出部件 ──
    rig_parts = {}
    layers = {}   # name -> full-canvas RGBA float（預覽及驗證用）

    def emit(name, rgb, alpha, bone, group, folder, extra=None):
        alpha = np.clip(alpha, 0, 1)
        alpha[alpha < 0.012] = 0
        ys, xs = np.where(alpha > 0)
        x0, x1, y0, y1 = max(0, xs.min() - 2), min(W, xs.max() + 3), max(0, ys.min() - 2), min(H, ys.max() + 3)
        rgba = to_rgba8(rgb, alpha)
        Image.fromarray(rgba[y0:y1, x0:x1]).save(os.path.join(out, folder, name + ".png"), optimize=True)
        layers[name] = np.dstack([np.clip(rgb, 0, 1), alpha]).astype(np.float32)
        info = {"src": f"{folder}/{name}.png", "x": int(x0), "y": int(y0), "w": int(x1 - x0), "h": int(y1 - y0), "bone": bone, "group": group}
        if name in notes:
            info["synthesized"] = notes[name]
        if extra:
            info.update(extra)
        rig_parts[name] = info
        return (x0, y0, x1, y1)

    for name, bone in BODY_ORDER:
        emit(name, part_rgb.get(name, body_rgb), np.minimum(parts[name], 1) * body_a, bone, "body", "body")
    hdir = "hair/twin_tails_long"
    for name, bone in HAIR_BACK + HAIR_FRONT:
        box = emit(name, hair_rgb, hair_alpha[name], bone, "hair", hdir)
        x0, y0, x1, y1 = box
        mk = np.dstack([accent, is_hair, np.zeros_like(accent), np.ones_like(accent)])
        Image.fromarray((np.clip(mk, 0, 1) * 255 + 0.5).astype(np.uint8)[y0:y1, x0:x1]).save(os.path.join(out, hdir, name + "_accent.png"), optimize=True)
        rig_parts[name]["accent_mask"] = f"{hdir}/{name}_accent.png"

    draw_order = [n for n, _ in HAIR_BACK] + [n for n, _ in BODY_ORDER] + [n for n, _ in HAIR_FRONT]

    # 髮色參考亮度（重新著色時用來保留明暗）
    hm = (hair_a > 0.9)
    lum = hair_rgb @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    ref_main = float(np.median(lum[hm & (accent < 0.1)]))
    ref_accent = float(np.median(lum[hm & (accent > 0.8)]))
    main_rgb = [float(x) for x in np.median(hair_rgb[hm & (accent < 0.1)], axis=0)]
    accent_rgb = [float(x) for x in np.median(hair_rgb[hm & (accent > 0.8)], axis=0)]

    # 衣物對位用錨點（由本圖量度；l／r 為角色本人的左右）
    def span(y):
        xs = np.where(trunk[y])[0]
        return int(xs.min()), int(xs.max())
    wl, wr = span(690)
    hl, hr_ = span(830)
    anchors = {
        "head_top": [600, 40], "chin": [600, 299], "neck": [600, 345],
        "neck_side_r": [571, 335], "neck_side_l": [637, 335],
        "shoulder_r": [450, 380], "shoulder_l": [751, 380],
        "bust": [600, 470], "bust_side_r": [498, 478], "bust_side_l": [703, 478],
        "waist": [600, 690], "waist_side_r": [wl, 690], "waist_side_l": [wr, 690],
        "hip": [600, 830], "hip_side_r": [hl, 830], "hip_side_l": [hr_, 830],
        "elbow_r": list(J["elbow_r"]), "elbow_l": list(J["elbow_l"]), "wrist_r": list(J["wrist_r"]), "wrist_l": list(J["wrist_l"]),
        "hand_r": [272, 945], "hand_l": [926, 945],
        "knee_r": list(J["knee_r"]), "knee_l": list(J["knee_l"]), "ankle_r": list(J["ankle_r"]), "ankle_l": list(J["ankle_l"]),
        "floor": [600, 1782],
    }
    anchor_bone = {
        "head_top": "head", "chin": "head", "neck": "neck", "neck_side_r": "neck", "neck_side_l": "neck",
        "shoulder_r": "torso", "shoulder_l": "torso", "bust": "torso", "bust_side_r": "torso", "bust_side_l": "torso",
        "waist": "torso", "waist_side_r": "torso", "waist_side_l": "torso", "hip": "pelvis", "hip_side_r": "pelvis", "hip_side_l": "pelvis",
        "elbow_r": "shoulder_r", "elbow_l": "shoulder_l", "wrist_r": "elbow_r", "wrist_l": "elbow_l", "hand_r": "wrist_r", "hand_l": "wrist_l",
        "knee_r": "hip_r", "knee_l": "hip_l", "ankle_r": "knee_r", "ankle_l": "knee_l", "floor": "root",
    }

    bones = []
    for b in ["root", "pelvis", "torso", "neck", "head", "shoulder_r", "elbow_r", "wrist_r", "shoulder_l", "elbow_l", "wrist_l",
              "hip_r", "knee_r", "ankle_r", "hip_l", "knee_l", "ankle_l", "hair_tail_r", "hair_tail_l"]:
        bones.append({
            "id": b, "parent": PARENT[b], "rest_position": list(J[b]), "rest_angle": 0, "pivot": list(J[b]),
            "min_angle": ANGLE_LIMIT[b][0], "max_angle": ANGLE_LIMIT[b][1],
            "attached_assets": [n for n in draw_order if rig_parts[n]["bone"] == b],
        })
    rig = {
        "version": 1, "avatar_id": "avatar_v2", "canvas": {"w": W, "h": H},
        "source": {"file": "source_full.png", **meta, "reference": "reference_bald.png"},
        "convention": "座標＝1200×1800 畫布像素；_r／_l＝角色本人的右／左（_r 在畫面左邊）；角度＝度，正數為畫面順時針；pivot 為靜止姿勢下的關節旋轉中心",
        "bones": bones, "parts": rig_parts, "draw_order": draw_order,
        "body_parts": [n for n, _ in BODY_ORDER], "hair_back": [n for n, _ in HAIR_BACK], "hair_front": [n for n, _ in HAIR_FRONT],
        "hair": {"style": "twin_tails_long", "ref_luma": {"main": round(ref_main, 4), "accent": round(ref_accent, 4)},
                 "original": {"main": [round(c, 4) for c in main_rgb], "accent": [round(c, 4) for c in accent_rgb]}},
        "anchors": anchors, "anchor_bone": anchor_bone,
    }
    with open(os.path.join(out, "rig.json"), "w", encoding="utf-8") as f:
        json.dump(rig, f, ensure_ascii=False, indent=1)

    # ── 8. 預覽及還原度檢查 ──
    def compose(pose=None, bg=None, names=None):
        acc = np.zeros((H, W, 4), np.float32)
        mats = fk(rig, pose or {})
        for name in (names or draw_order):
            lay = layers[name]
            M = mats[rig_parts[name]["bone"]]
            if not np.allclose(M, np.eye(3)[:2]):
                pm = np.dstack([lay[..., :3] * lay[..., 3:4], lay[..., 3]])
                pm = cv2.warpAffine(pm, M, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
                a = pm[..., 3:4]
                lay = np.dstack([np.where(a > 1e-4, pm[..., :3] / np.maximum(a, 1e-4), 0), a[..., 0]])
            acc = over(acc, lay)
        return acc

    def on_bg(rgba, color=(0.93, 0.90, 0.95)):
        a = rgba[..., 3:4]
        return (np.clip(rgba[..., :3] * a + np.array(color, np.float32) * (1 - a), 0, 1) * 255 + 0.5).astype(np.uint8)

    rest = compose()
    Image.fromarray(to_rgba8(rest[..., :3], rest[..., 3])).save(os.path.join(prev, "assembly_preview.png"), optimize=True)
    src = np.dstack([full, fa])
    diff = np.abs(on_bg(rest).astype(np.int32) - on_bg(src).astype(np.int32)).max(axis=2)
    report = {
        "mean_abs_diff": round(float(diff.mean()), 4), "pixels_over_16": int((diff > 16).sum()), "pixels_over_48": int((diff > 48).sum()),
        "max_diff": int(diff.max()), "alpha_mean_abs_diff": round(float(np.abs(rest[..., 3] - fa).mean()), 5),
        "figure_pixels": int((fa > 0.5).sum()),
    }
    with open(os.path.join(prev, "assembly_report.json"), "w") as f:
        json.dump(report, f, indent=1)
    print("還原度：", report)
    dv = on_bg(src).copy()
    dv[diff > 16] = (255, 0, 0)
    Image.fromarray(np.hstack([on_bg(src), on_bg(rest), dv])).save(os.path.join(prev, "assembly_compare.png"), optimize=True)

    # 關節圖
    dbg = Image.fromarray(on_bg(rest)).convert("RGB")
    dr = ImageDraw.Draw(dbg)
    for b in bones:
        if b["parent"]:
            dr.line([tuple(J[b["parent"]]), tuple(J[b["id"]])], fill=(40, 120, 255), width=3)
    for b in bones:
        x, y = J[b["id"]]
        dr.ellipse([x - 7, y - 7, x + 7, y + 7], fill=(255, 60, 90), outline=(255, 255, 255), width=2)
        dr.text((x + 10, y - 6), b["id"], fill=(20, 20, 60))
    dbg.save(os.path.join(prev, "joint_debug_preview.png"), optimize=True)

    # 無髮身體＋補色範圍
    bodyonly = compose(names=[n for n, _ in BODY_ORDER])
    bo = on_bg(bodyonly)
    hair_only = on_bg(compose(names=[n for n, _ in HAIR_BACK + HAIR_FRONT]))
    Image.fromarray(np.hstack([bo, hair_only])).save(os.path.join(prev, "layers_preview.png"), optimize=True)

    poses = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "shared", "avatar-v2-poses.json"), encoding="utf-8"))
    tiles = []
    for p in poses:
        img = Image.fromarray(on_bg(compose(p["pose"]))).resize((W // 2, H // 2), Image.LANCZOS)
        ImageDraw.Draw(img).text((12, 10), p["id"], fill=(60, 30, 80))
        tiles.append(np.asarray(img))
    extreme = {b["id"]: b["max_angle"] for b in bones}
    img = Image.fromarray(on_bg(compose(extreme))).resize((W // 2, H // 2), Image.LANCZOS)
    ImageDraw.Draw(img).text((12, 10), "all joints at max", fill=(60, 30, 80))
    tiles.append(np.asarray(img))
    extreme = {b["id"]: b["min_angle"] for b in bones}
    img = Image.fromarray(on_bg(compose(extreme))).resize((W // 2, H // 2), Image.LANCZOS)
    ImageDraw.Draw(img).text((12, 10), "all joints at min", fill=(60, 30, 80))
    tiles.append(np.asarray(img))
    rows = [np.hstack(tiles[i:i + 4]) for i in range(0, len(tiles), 4)]
    wmax = max(r.shape[1] for r in rows)
    rows = [np.pad(r, ((0, 0), (0, wmax - r.shape[1]), (0, 0)), constant_values=255) for r in rows]
    Image.fromarray(np.vstack(rows)).save(os.path.join(prev, "pose_test_preview.png"), optimize=True)
    print("部件：", len(rig_parts), "｜輸出：", out)


def fk(rig, pose):
    """Forward Kinematics（與 shared/avatarRig.ts 相同的算法）：回傳每個骨骼的 2×3 仿射矩陣（畫布座標）。"""
    by = {b["id"]: b for b in rig["bones"]}
    cache = {}

    def world(bid):
        if bid in cache:
            return cache[bid]
        b = by[bid]
        ang = max(b["min_angle"], min(b["max_angle"], float(pose.get(bid, 0))))
        t = math.radians(ang)
        c, s = math.cos(t), math.sin(t)
        px, py = b["pivot"]
        local = np.array([[c, -s, px - c * px + s * py], [s, c, py - s * px - c * py], [0, 0, 1]], np.float64)
        m = local if b["parent"] is None else world(b["parent"]) @ local
        cache[bid] = m
        return m

    return {bid: world(bid)[:2].astype(np.float32) for bid in by}


if __name__ == "__main__":
    main()
