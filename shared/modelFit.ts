// 把衣物在一個身體上的位置換算到另一個身體（Phase 3.6）。
// 只是初始建議：按兩個身體的身體地標（頭頂、下巴、頸、肩、胸、腰、臀、膝、踝、地面）把衣物的實際內容上下緣
// 對到相同部位，闊度按同一高度的身體闊度比例調整。網格、遮罩、部件圖都是圖片相對座標，可以原樣沿用。
import type { Rig } from "./avatarRig";
import { Content, Fit, SY_LIMIT, FIT_LIMIT, TemplateData, Piece } from "./doll";

type P = [number, number];
const avg = (a: P, b: P): P => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
interface Landmark { y: number; c: number; half: number }
/** 由上至下的身體地標：高度、中心、半闊 */
function landmarks(rig: Rig): Landmark[] {
  const A = rig.anchors;
  const sh = avg(A.shoulder_l, A.shoulder_r), kn = avg(A.knee_l, A.knee_r), an = avg(A.ankle_l, A.ankle_r);
  const rows: Landmark[] = [
    { y: A.head_top[1], c: A.head_top[0], half: 110 },
    { y: A.chin[1], c: A.chin[0], half: (A.neck_side_l[0] - A.neck_side_r[0]) / 2 + 40 },
    { y: A.neck[1], c: A.neck[0], half: (A.neck_side_l[0] - A.neck_side_r[0]) / 2 },
    { y: sh[1], c: sh[0], half: (A.shoulder_l[0] - A.shoulder_r[0]) / 2 },
    { y: A.bust[1], c: A.bust[0], half: (A.bust_side_l[0] - A.bust_side_r[0]) / 2 },
    { y: A.waist[1], c: A.waist[0], half: (A.waist_side_l[0] - A.waist_side_r[0]) / 2 },
    { y: A.hip[1], c: A.hip[0], half: (A.hip_side_l[0] - A.hip_side_r[0]) / 2 },
    { y: kn[1], c: kn[0], half: (A.knee_l[0] - A.knee_r[0]) / 2 + 55 },
    { y: an[1], c: an[0], half: (A.ankle_l[0] - A.ankle_r[0]) / 2 + 45 },
    { y: A.floor[1], c: A.floor[0], half: (A.ankle_l[0] - A.ankle_r[0]) / 2 + 60 },
  ];
  // 保持由上至下遞增（異常的自訂錨點不會令換算反轉）
  for (let i = 1; i < rows.length; i++) if (rows[i].y <= rows[i - 1].y) rows[i] = { ...rows[i], y: rows[i - 1].y + 1 };
  return rows.map((r) => ({ ...r, half: Math.max(8, Math.abs(r.half)) }));
}
function segment(rows: Landmark[], y: number): [number, number] {
  let i = 0;
  while (i < rows.length - 2 && y > rows[i + 1].y) i++;
  return [i, (y - rows[i].y) / (rows[i + 1].y - rows[i].y)];
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export interface BodyMap { y: (y: number) => number; x: (x: number, y: number) => number; widthRatio: (y: number) => number; identity: boolean }
/** 身體 A 的畫布座標 → 身體 B（靜止姿勢） */
export function bodyMap(src: Rig, dst: Rig): BodyMap {
  const a = landmarks(src), b = landmarks(dst);
  const identity = a.every((r, i) => Math.abs(r.y - b[i].y) < 0.05 && Math.abs(r.c - b[i].c) < 0.05 && Math.abs(r.half - b[i].half) < 0.05);
  const at = (rows: Landmark[], i: number, t: number) => ({ c: lerp(rows[i].c, rows[i + 1].c, t), half: lerp(rows[i].half, rows[i + 1].half, Math.min(1, Math.max(0, t))) });
  const mapY = (y: number) => { const [i, t] = segment(a, y); return lerp(b[i].y, b[i + 1].y, t); };
  return {
    identity,
    y: identity ? (y) => y : mapY,
    x: identity ? (x) => x : (x, y) => { const [i, t] = segment(a, y); const s = at(a, i, t), d = at(b, i, t); return d.c + ((x - s.c) / s.half) * d.half; },
    widthRatio: identity ? () => 1 : (y) => { const [i, t] = segment(a, y); return at(b, i, t).half / at(a, i, t).half; },
  };
}
const round = (n: number) => Math.round(n * 10) / 10;
/** 衣物位置：按身體地標換算到另一個身體。兩個身體相同時原樣回傳。 */
export function transferFit(fit: Fit, content: Content, src: Rig, dst: Rig, map = bodyMap(src, dst)): Fit {
  if (map.identity) return fit;
  const ar = content.ar > 0 ? content.ar : 4 / 3;
  const sy0 = fit.sy ?? 1, h = fit.w * ar * sy0;
  const top = fit.cy - h / 2 + content.y0 * h, bottom = fit.cy - h / 2 + content.y1 * h, mid = (top + bottom) / 2;
  const nt = map.y(top), nb = map.y(bottom);
  const scaleY = Math.max(0.3, (nb - nt) / Math.max(1, bottom - top));
  const sx = Math.min(2.5, Math.max(0.4, map.widthRatio(mid)));
  const w = Math.min(FIT_LIMIT.maxW, Math.max(FIT_LIMIT.minW, fit.w * sx));
  const sy = Math.min(SY_LIMIT.max, Math.max(SY_LIMIT.min, (sy0 * scaleY * fit.w) / w));
  const nh = w * ar * sy;
  const cxContent = fit.cx - fit.w / 2 + ((content.x0 + content.x1) / 2) * fit.w;
  const ncx = map.x(cxContent, mid);
  const left = ncx - ((content.x0 + content.x1) / 2) * w;
  return { cx: round(left + w / 2), cy: round(nt - content.y0 * nh + nh / 2), w: round(w), rotation: fit.rotation, ...(Math.abs(sy - 1) > 0.0005 ? { sy: Math.round(sy * 1000) / 1000 } : {}), ...(fit.mesh ? { mesh: fit.mesh } : {}) };
}
/** 套裝部件的預設位置：中心點按身體地標換算，闊度按該高度的身體闊度比例（部件沒有獨立的圖片內容資料） */
export function transferPieces(pieces: Piece[] | undefined, src: Rig, dst: Rig): Piece[] | undefined {
  if (!pieces) return pieces;
  const map = bodyMap(src, dst);
  if (map.identity) return pieces;
  return pieces.map((p) => {
    if (!p.fit) return p;
    const w = Math.min(FIT_LIMIT.maxW, Math.max(FIT_LIMIT.minW, p.fit.w * Math.min(2.5, Math.max(0.4, map.widthRatio(p.fit.cy)))));
    return { ...p, fit: { ...p.fit, cx: round(map.x(p.fit.cx, p.fit.cy)), cy: round(map.y(p.fit.cy)), w: round(w) } };
  });
}
/** 另一個身體的衣物預設 → 這個身體的初始建議（標記 converted，狀態不算已校正） */
export function transferTemplateData(d: TemplateData, src: Rig, dst: Rig, content: Content, from: string): TemplateData {
  const map = bodyMap(src, dst);
  const variants: TemplateData["variants"] = {};
  for (const [k, v] of Object.entries(d.variants)) variants[k] = v.fit ? { ...v, fit: transferFit(v.fit, content, src, dst, map) } : v;
  const { status: _status, ...rest } = d;
  void _status;
  return { ...rest, variants, ...(d.pieces ? { pieces: transferPieces(d.pieces, src, dst)!.map(({ status: _s, ...p }) => p) } : {}), converted: true, converted_from: from };
}
