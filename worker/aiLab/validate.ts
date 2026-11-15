/**
 * AI Response Validator：不信任模型輸出。
 * JSON 解析 → 型別及長度 → taxonomy ID（主分類／子分類關係）→ 屬性適用性及單選／多選上限 → 清除未知欄位及 HTML／Script。
 * 輸出可直接交給現有 submitSuggestion（以名稱表示的欄位），並另附 attributes（只作建議顯示）。
 * 本檔只 import 型別（Node 可直接載入測試）。
 */
import type { Taxonomy } from "../../shared/taxonomy";

const ALLOWED = new Set(["schema_version", "suggested_name", "category_id", "subcategory_id", "primary_color_ids", "secondary_color_ids", "style_ids", "season_ids", "attributes", "pattern", "decorations", "brand_candidate", "brand_status", "description", "has_multiple_items", "is_full_outfit", "review_required", "uncertain_fields", "warnings"]);

/** 取出第一個平衡的 JSON 物件（容許模型前後多了文字或 ``` 標記） */
export function extractJson(text: string): unknown {
  if (!text || typeof text !== "string") throw new Error("empty");
  const t = text.replace(/```(?:json)?/gi, "");
  const start = t.indexOf("{");
  if (start < 0) throw new Error("no_json");
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return JSON.parse(t.slice(start, i + 1)); }
  }
  throw new Error("unbalanced");
}

/** 清除 HTML／Script／控制字元並限制長度 */
export function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/<[^>]*>/g, "").replace(/javascript:/gi, "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

export interface ValidatedAi {
  ok: boolean;
  error?: string;
  /** 交給 submitSuggestion 的欄位（名稱） */
  fields?: Record<string, unknown>;
  /** 進階屬性（id → 選項名稱），只作建議 */
  attributes?: Record<string, string | string[]>;
  warnings: string[];
}

export function validateAiOutput(raw: unknown, tax: Taxonomy): ValidatedAi {
  const warnings: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "AI 回傳不是 JSON 物件", warnings };
  const o = raw as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !ALLOWED.has(k));
  if (unknown.length) warnings.push(`已移除未知欄位：${unknown.slice(0, 10).map((k) => cleanText(k, 30)).join("、")}`);
  if (o.schema_version !== undefined && o.schema_version !== 1) return { ok: false, error: "schema_version 不正確", warnings };

  const uncertain = new Set<string>();
  const cat = typeof o.category_id === "string" ? tax.categories.find((c) => c.id === o.category_id) : undefined;
  if (o.category_id != null && !cat) { warnings.push("主分類 ID 不存在，已留空"); uncertain.add("category"); }
  let sub: { id: string; name: string } | undefined;
  if (typeof o.subcategory_id === "string") {
    if (!cat) { warnings.push("沒有有效主分類，子分類已留空"); uncertain.add("subcategory"); }
    else {
      sub = cat.subs.find((s) => s.id === o.subcategory_id);
      if (!sub) {
        const elsewhere = tax.categories.some((c) => c.subs.some((s) => s.id === o.subcategory_id));
        warnings.push(elsewhere ? "子分類不屬於所選主分類，已留空" : "子分類 ID 不存在，已留空");
        uncertain.add("subcategory");
      }
    }
  }
  const catId = cat?.id ?? null;
  const attrDef = (id: string) => tax.attributes.find((a) => a.id === id);
  const applies = (a: { show_for: string[] | null }) => !a.show_for || !a.show_for.length || (catId !== null && a.show_for.includes(catId));
  /** 把 option id 陣列轉成名稱，檢查存在、適用及上限 */
  const pick = (attrId: string, v: unknown, field: string): string[] => {
    const a = attrDef(attrId); if (!a) return [];
    const ids = Array.isArray(v) ? v : v == null ? [] : [v];
    const names: string[] = [];
    for (const id of ids) {
      const opt = typeof id === "string" ? a.options.find((x) => x.id === id) : undefined;
      if (!opt) { warnings.push(`${a.name}：選項不存在，已忽略`); uncertain.add(field); continue; }
      if (!names.includes(opt.name)) names.push(opt.name);
    }
    if (names.length && !applies(a)) { warnings.push(`${a.name} 不適用於此分類，已忽略`); return []; }
    const max = a.multi ? a.max_select ?? 99 : 1;
    if (names.length > max) { warnings.push(`${a.name} 超過上限 ${max} 個，只保留前 ${max} 個`); names.length = max; }
    return names;
  };
  const primary = pick("primary_color", o.primary_color_ids, "primary_color");
  const secondary = pick("secondary_colors", o.secondary_color_ids, "secondary_colors").filter((c) => !primary.includes(c));
  const style = pick("style", o.style_ids, "style");
  const season = pick("season", o.season_ids, "season");

  const attributes: Record<string, string | string[]> = {};
  if (o.attributes && typeof o.attributes === "object" && !Array.isArray(o.attributes)) {
    for (const [k, v] of Object.entries(o.attributes as Record<string, unknown>).slice(0, 30)) {
      const a = attrDef(k);
      if (!a || ["primary_color", "secondary_colors", "style", "season", "brand_confidence"].includes(k)) { warnings.push("已忽略不在字典內的屬性"); continue; }
      const names = pick(k, v, k);
      if (names.length) attributes[k] = a.multi ? names : names[0];
    }
  }

  for (const f of Array.isArray(o.uncertain_fields) ? o.uncertain_fields.slice(0, 20) : []) {
    const s = cleanText(f, 40); if (s && /^[a-z_]+$/.test(s)) uncertain.add(s.replace(/_ids?$/, "").replace(/^suggested_/, ""));
  }
  for (const w of Array.isArray(o.warnings) ? o.warnings.slice(0, 5) : []) { const s = cleanText(w, 200); if (s) warnings.push(`AI：${s}`); }

  const decorations = (Array.isArray(o.decorations) ? o.decorations : []).slice(0, 10).map((d) => cleanText(d, 30)).filter(Boolean) as string[];
  const description = cleanText(o.description, 400);
  const pattern = cleanText(o.pattern, 60);
  const brandCandidate = cleanText(o.brand_candidate, 60);
  const multi = o.has_multiple_items === true;
  const name = cleanText(o.suggested_name, 60);
  const attrText = Object.entries(attributes).map(([k, v]) => `${attrDef(k)!.name} ${Array.isArray(v) ? v.join("、") : v}`).join("、");
  const details = [description, decorations.length ? `裝飾：${decorations.join("、")}` : null, attrText ? `屬性：${attrText}` : null].filter(Boolean).join("｜") || null;

  const fields: Record<string, unknown> = {
    name, category: cat?.name ?? null, subcategory: sub?.name ?? null,
    style: style.length ? style.join("、") : null,
    primary_color: primary.length ? primary.join("、") : null,
    secondary_colors: secondary.length ? secondary : null,
    pattern, season: season.length ? season.join("、") : null,
    details: details ? details.slice(0, 500) : null,
    is_full_outfit: o.is_full_outfit === true,
    has_multiple_items: multi,
    needs_review: true,
    uncertain_fields: [...uncertain].slice(0, 20),
    ai_note: "Workers AI 自動辨認；未經人工確認",
    // 品牌：只作候選，永不確認（validate 會把未確認品牌放到 brand_candidate，不寫入 brand）
    ...(brandCandidate ? { brand: brandCandidate, brand_confidence: "unconfirmed", brand_note: "圖片上可見的文字，未經確認" } : {}),
  };
  const any = name || cat || primary.length || style.length || pattern;
  if (!any) return { ok: false, error: "AI 沒有提供任何可用欄位", warnings };
  return { ok: true, fields, attributes, warnings };
}
