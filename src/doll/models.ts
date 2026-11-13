// 身體模型（Phase 3.6）：列表、按版本讀取（不可變版本長期快取）、建立 AvatarModel。
// 只讀 D1 的模型資料及縮圖；身體部件高清圖片由渲染器按需讀取，不會預載全部模型。
import { AvatarModel, DEFAULT_BODY_MODEL, ModelDef, buildModel, isBuiltinModel } from "../../shared/avatarModel";
import { AVATAR_V2_ID } from "../../shared/avatarV2";
import { api } from "../api";

export interface ModelSummary { id: string; name: string; revision: number; status: string; thumb: string | null; looks: number; templates: number; updated_at?: string; builtin?: boolean }
export const V2_SUMMARY: ModelSummary = { id: AVATAR_V2_ID, name: "Avatar V2（原本）", revision: DEFAULT_BODY_MODEL.revision, status: "active", thumb: "/doll/avatar_v2/thumbs/head_v2.png", looks: 0, templates: 0, builtin: true };
export interface ModelDetail extends ModelSummary { def: ModelDef }

export async function listModels(all = false): Promise<{ models: ModelSummary[]; default_model: string }> {
  const r = await api<{ models: ModelSummary[]; default_model: string }>("/api/doll/models" + (all ? "?all=1" : ""));
  return { models: [V2_SUMMARY, ...r.models], default_model: r.default_model };
}
export const getModel = (id: string) => api<ModelDetail>(`/api/doll/models/${id}`);

const cache = new Map<string, Promise<AvatarModel>>();
/** 讀取某個版本（沒有指定＝最新版本）。版本不可變，所以同一版本只會建立一次。 */
export function loadModel(id: string | null | undefined, rev?: number | null): Promise<AvatarModel> {
  if (!id || isBuiltinModel(id)) return Promise.resolve(DEFAULT_BODY_MODEL);
  if (!rev) return getModel(id).then((m) => remember(id, m.revision, Promise.resolve(buildModel(id, m.revision, m.def, m.name))));
  const key = id + "@" + rev;
  const hit = cache.get(key);
  if (hit) return hit;
  const p = api<{ name: string; revision: number; def: ModelDef }>(`/api/doll/models/${id}/revisions/${rev}`).then((r) => buildModel(id, r.revision, r.def, r.name));
  cache.set(key, p);
  p.catch(() => cache.delete(key));
  return p;
}
function remember(id: string, rev: number, p: Promise<AvatarModel>) { cache.set(id + "@" + rev, p); return p; }
export const modelRef = (m: AvatarModel) => ({ id: m.id, rev: m.revision });
export const modelLabel = (m: AvatarModel) => (isBuiltinModel(m.id) ? "Avatar V2" : m.name || "自訂身體");
