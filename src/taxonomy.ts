import { useEffect, useState } from "react";
import { buildTaxonomy, defaultTaxonomyRows, Taxonomy } from "../shared/taxonomy";
import { api } from "./api";

// 分類字典：全 App 共用一份，修改後廣播 aw:taxonomy 重新載入
let cached: Taxonomy | null = null;
let inflight: Promise<Taxonomy> | null = null;
const fallback = buildTaxonomy(defaultTaxonomyRows());

export function loadTaxonomy(force = false): Promise<Taxonomy> {
  if (cached && !force) return Promise.resolve(cached);
  if (!inflight || force) {
    inflight = api<Taxonomy>("/api/taxonomy")
      .then((t) => {
        cached = t;
        return t;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export function refreshTaxonomy() {
  cached = null;
  loadTaxonomy(true)
    .then(() => window.dispatchEvent(new Event("aw:taxonomy")))
    .catch(() => undefined);
}

/** 讀取分類字典；載入前先用預設值，不會卡住畫面 */
export function useTaxonomy(): Taxonomy {
  const [tax, setTax] = useState<Taxonomy>(cached ?? fallback);
  useEffect(() => {
    let alive = true;
    const on = () => cached && alive && setTax(cached);
    loadTaxonomy()
      .then((t) => alive && setTax(t))
      .catch(() => undefined);
    window.addEventListener("aw:taxonomy", on);
    return () => {
      alive = false;
      window.removeEventListener("aw:taxonomy", on);
    };
  }, []);
  return tax;
}

export const optionNames = (tax: Taxonomy, attrId: string) => tax.attributes.find((a) => a.id === attrId)?.options.map((o) => o.name) ?? [];
