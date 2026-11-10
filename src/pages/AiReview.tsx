import { useCallback, useEffect, useMemo, useState } from "react";
import { Taxonomy } from "../../shared/taxonomy";
import { AI_STATUS_LABEL, AiNormalized, AiStatus, api, BRAND_CONFIDENCE_LABEL, displayName, formatDate, imageUrl, ReviewItem } from "../api";
import { AiHandoffButton, Button, Empty, inputCls, Link, PickChips, Spinner, toast } from "../components/ui";
import { usePath, navigate } from "../router";
import { optionNames, useTaxonomy } from "../taxonomy";

const TABS: { key: string; label: string; statuses: AiStatus[] }[] = [
  { key: "todo", label: "全部未完成", statuses: ["pending_ai", "ai_processing", "pending_review", "failed", "needs_rework"] },
  { key: "pending_review", label: "待人工確認", statuses: ["pending_review"] },
  { key: "pending_ai", label: "待 AI 辨認", statuses: ["pending_ai", "needs_rework"] },
  { key: "ai_processing", label: "AI 整理中", statuses: ["ai_processing"] },
  { key: "failed", label: "辨認失敗", statuses: ["failed"] },
  { key: "done", label: "已完成", statuses: ["done"] },
];

const FIELDS = [
  ["name", "名稱"],
  ["category", "主類別"],
  ["subcategory", "子類別"],
  ["style", "風格"],
  ["primary_color", "主色"],
  ["secondary_colors", "次要顏色"],
  ["pattern", "印花主題"],
  ["details", "裝飾細節"],
  ["season", "季節"],
  ["brand", "品牌"],
] as const;
type FieldKey = (typeof FIELDS)[number][0];

const STATUS_TONE: Record<AiStatus, string> = {
  pending_ai: "bg-velvet text-rose",
  ai_processing: "bg-amethyst text-white",
  pending_review: "bg-rose text-ink ring-1 ring-amethyst/40",
  done: "bg-white text-mauve ring-1 ring-ink/10",
  failed: "bg-wine text-white",
  needs_rework: "bg-ink text-rose",
};

interface ReviewData {
  items: ReviewItem[];
  counts: Record<AiStatus, number>;
}

/** 待整理（嵌入主頁）：分頁、多選、批量入庫、AI 建議對比 */
export default function ReviewPanel({ onChanged }: { onChanged?: () => void }) {
  const path = usePath();
  const tax = useTaxonomy();
  const [intakeOpen, setIntakeOpen] = useState(false);
  const params = useMemo(() => new URLSearchParams(path.split("?")[1] || ""), [path]);
  const tab = TABS.find((t) => t.key === params.get("tab")) ?? TABS[0];
  const sort = params.get("sort") || "newest";
  const [data, setData] = useState<ReviewData | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await api<ReviewData>(`/api/ai/review?ai_status=${tab.statuses.join(",")}&sort=${sort}`);
    setData(r);
    onChanged?.();
    setSelected((cur) => new Set([...cur].filter((id) => r.items.some((i) => i.id === id))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, sort]);

  useEffect(() => {
    setData(null);
    load().catch((e) => toast((e as Error).message, "err"));
  }, [load]);

  function setParam(k: string, v: string) {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    navigate(`/${p.toString() ? `?${p}` : ""}`, true, false);
  }

  const items = data?.items ?? [];
  const counts = data?.counts;
  const todoCount = counts ? counts.pending_ai + counts.ai_processing + counts.pending_review + counts.failed + counts.needs_rework : 0;
  const selectedItems = items.filter((i) => selected.has(i.id));
  const acceptable = selectedItems.filter((i) => i.ai_status === "pending_review" && i.suggestion?.status === "valid");

  async function bulk(action: "accept_all" | "rework" | "pending_ai") {
    if (!selectedItems.length || busy) return;
    setBusy(true);
    try {
      if (action === "accept_all") {
        const r = await api<{ results: { ok: boolean; error?: string }[] }>("/api/ai/decide-bulk", {
          method: "POST",
          json: { action: "accept_all", items: acceptable.map((i) => ({ garment_id: i.id, suggestion_id: i.suggestion!.suggestion_id, version: i.version })) },
        });
        const bad = r.results.filter((x) => !x.ok).length;
        toast(bad ? `已接受 ${r.results.length - bad} 件，${bad} 件失敗` : `已接受 ${r.results.length} 件（未確認的品牌不會寫入）`, bad ? "err" : "ok");
      } else {
        await api("/api/ai/status", { method: "POST", json: { garment_ids: selectedItems.map((i) => i.id), ai_status: action === "rework" ? "needs_rework" : "pending_ai" } });
        toast(action === "rework" ? "已標記需要重新處理" : "已退回待 AI 辨認");
      }
      setSelected(new Set());
      await load();
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  }

  async function bulkIntake(set: Record<string, string>, useAi: boolean) {
    if (!selectedItems.length || busy) return;
    setBusy(true);
    try {
      const r = await api<{ results: { ok: boolean; mode?: string; error?: string }[] }>("/api/garments/bulk-intake", {
        method: "POST",
        json: { garment_ids: selectedItems.map((i) => i.id), set, use_ai: useAi },
      });
      const ok = r.results.filter((x) => x.ok);
      const bad = r.results.length - ok.length;
      const ai = ok.filter((x) => x.mode === "ai").length;
      toast(bad ? `已入庫 ${ok.length} 件，${bad} 件失敗：${r.results.find((x) => !x.ok)?.error ?? ""}` : `已入庫 ${ok.length} 件${ai ? `（${ai} 件採用 AI 建議）` : ""}`, bad ? "err" : "ok");
      setSelected(new Set());
      setIntakeOpen(false);
      await load();
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="todo" className="paper mt-9 scroll-mt-20 px-4 pb-4 pt-7">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="font-serif text-xl font-bold tracking-[0.08em]">待整理</h2>
        <select className="rounded-full bg-white px-3 py-1.5 text-[13px] ring-1 ring-ink/10" value={sort} onChange={(e) => setParam("sort", e.target.value === "newest" ? "" : e.target.value)} aria-label="排序">
          <option value="newest">最新上傳</option>
          <option value="oldest">最舊上傳</option>
          <option value="number">按編號</option>
        </select>
      </div>

      <div className="scrollbar-none -mx-4 flex gap-2 overflow-x-auto px-4 py-1">
        {TABS.map((t) => {
          const n = counts ? t.statuses.reduce((s, st) => s + (counts[st] ?? 0), 0) : null;
          const active = t.key === tab.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setParam("tab", t.key === "todo" ? "" : t.key)}
              className={`shrink-0 rounded-full px-3.5 py-1.5 text-[13px] ${active ? "chip-on" : "chip"}`}
            >
              {t.label}
              {n !== null && <span className={active ? "ml-1 text-white/75" : "ml-1 text-mauve"}>{n}</span>}
            </button>
          );
        })}
      </div>

      {counts && counts.pending_ai + counts.needs_rework > 0 && (
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-[13px] text-mauve">{counts.pending_ai + counts.needs_rework} 件等待辨認</span>
          <AiHandoffButton compact count={counts.pending_ai + counts.needs_rework} />
        </div>
      )}

      {items.length > 0 && (
        <div className="sticky top-12 z-20 -mx-4 mt-3 flex flex-wrap items-center gap-2 bg-lace/95 px-4 py-2 backdrop-blur">
          <button
            type="button"
            className="text-[13px] text-amethyst-deep underline underline-offset-4"
            onClick={() => setSelected(selected.size === items.length ? new Set() : new Set(items.map((i) => i.id)))}
          >
            {selected.size === items.length ? "取消全選" : "全選"}
          </button>
          <span className="text-[13px] text-mauve">已選 {selected.size}</span>
          {selected.size > 0 && (
            <>
              <Button className="min-h-9 px-4 text-[13px]" disabled={busy} onClick={() => setIntakeOpen((v) => !v)}>
                批量入庫（{selected.size}）
              </Button>
              <Button variant="soft" className="min-h-9 px-4 text-[13px]" disabled={busy || !acceptable.length} onClick={() => bulk("accept_all")}>
                只接受 AI 建議（{acceptable.length}）
              </Button>
              <Button variant="ghost" className="min-h-9 px-4 text-[13px]" disabled={busy} onClick={() => bulk("rework")}>
                重新處理
              </Button>
            </>
          )}
        </div>
      )}

      {intakeOpen && selected.size > 0 && (
        <BulkIntakeSheet tax={tax} count={selected.size} withAi={acceptable.length} busy={busy} onCancel={() => setIntakeOpen(false)} onConfirm={bulkIntake} />
      )}

      <div className="mt-3">
        {!data ? (
          <Spinner />
        ) : items.length === 0 ? (
          <Empty title={tab.key === "todo" ? "沒有待整理的衣物" : "這裡沒有衣物"}>
            {todoCount === 0 ? (
              <>
                按右上角「＋ 上傳」選相，新衣物會自動出現在這裡。
              </>
            ) : (
              "可切換其他分頁查看。"
            )}
          </Empty>
        ) : (
          <ul className="space-y-3">
            {items.map((g) => (
              <ReviewCard
                key={g.id}
                g={g}
                selected={selected.has(g.id)}
                onToggle={() =>
                  setSelected((cur) => {
                    const n = new Set(cur);
                    if (n.has(g.id)) n.delete(g.id);
                    else n.add(g.id);
                    return n;
                  })
                }
                open={open === g.id}
                onOpen={() => setOpen(open === g.id ? null : g.id)}
                onChanged={load}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function BulkIntakeSheet({
  tax,
  count,
  withAi,
  busy,
  onCancel,
  onConfirm,
}: {
  tax: Taxonomy;
  count: number;
  withAi: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (set: Record<string, string>, useAi: boolean) => void;
}) {
  const [category, setCategory] = useState("");
  const [sub, setSub] = useState("");
  const [useAi, setUseAi] = useState(true);
  const subs = tax.categories.find((c) => c.name === category)?.subs.map((s) => s.name) ?? [];
  return (
    <div className="mt-3 space-y-3 rounded-3xl bg-rose-soft p-4">
      <p className="text-[14px]">
        把已選的 <b>{count}</b> 件轉為正式衣物。可以同時為全部指定分類（不選就保留各自的分類）。
      </p>
      <div>
        <p className="mb-1.5 text-[13px] text-mauve">主分類（可不選）</p>
        <PickChips options={tax.categories.map((c) => c.name)} value={category ? [category] : []} onChange={(v) => { setCategory(v[0] ?? ""); setSub(""); }} />
      </div>
      {subs.length > 0 && (
        <div>
          <p className="mb-1.5 text-[13px] text-mauve">子分類（可不選）</p>
          <PickChips options={subs} value={sub ? [sub] : []} onChange={(v) => setSub(v[0] ?? "")} />
        </div>
      )}
      {withAi > 0 && (
        <label className="flex items-start gap-2 text-[14px]">
          <input type="checkbox" checked={useAi} onChange={(e) => setUseAi(e.target.checked)} className="mt-0.5 h-5 w-5 accent-amethyst" />
          <span>
            其中 {withAi} 件有 AI 建議：同時接受 AI 建議
            <span className="block text-[12px] text-mauve">未確認的品牌不會寫入；上面指定的分類會優先。</span>
          </span>
        </label>
      )}
      <div className="flex gap-2">
        <Button disabled={busy} onClick={() => onConfirm({ ...(category ? { category } : {}), ...(sub ? { subcategory: sub } : {}) }, useAi)}>
          {busy ? "入庫中…" : `確認入庫 ${count} 件`}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          取消
        </Button>
      </div>
    </div>
  );
}

function brandBadge(n: AiNormalized | null | undefined) {
  if (!n) return { text: "品牌：未辨認", tone: "text-mauve" };
  const name = n.brand || n.brand_candidate;
  if (!name) return { text: "品牌：未找到", tone: "text-mauve" };
  return { text: `品牌：${BRAND_CONFIDENCE_LABEL[n.brand_confidence]}｜${name}`, tone: n.brand_confidence === "confirmed" ? "text-amethyst-deep" : "text-mauve" };
}

function ReviewCard({ g, selected, onToggle, open, onOpen, onChanged }: { g: ReviewItem; selected: boolean; onToggle: () => void; open: boolean; onOpen: () => void; onChanged: () => Promise<void> }) {
  const tax = useTaxonomy();
  const st = (g.ai_status || "pending_ai") as AiStatus;
  const n = g.suggestion?.status === "valid" ? g.suggestion.normalized : null;
  const brand = brandBadge(n);
  const reviewFields = n ? n.uncertain_fields.length + (n.needs_review ? 1 : 0) : 0;
  return (
    <li className={`rounded-3xl bg-white p-3 ring-1 ${selected ? "ring-2 ring-amethyst" : "ring-ink/5"}`}>
      <div className="flex gap-3">
        <button type="button" onClick={onToggle} aria-pressed={selected} aria-label="選取" className="relative shrink-0">
          <div className="arch relative h-28 w-21 overflow-hidden" style={{ width: "5.25rem" }}>
            {g.thumb_image_id || g.primary_image_id ? (
              <img src={imageUrl(g.thumb_image_id || g.primary_image_id)} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-contain p-1.5 pt-3" />
            ) : (
              <div className="absolute inset-0 grid place-items-center text-[11px] text-mauve">未有圖片</div>
            )}
          </div>
          <span className={`absolute left-1 top-1 grid h-6 w-6 place-items-center rounded-full text-xs ${selected ? "bg-amethyst text-white" : "bg-white/90 text-transparent ring-1 ring-ink/20"}`}>✓</span>
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <Link to={`/g/${g.id}`} className="min-w-0 truncate font-medium">
              {displayName(g)}
            </Link>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${STATUS_TONE[st]}`}>{AI_STATUS_LABEL[st]}</span>
          </div>
          <div className="mt-0.5 text-[12px] text-mauve">上傳 {formatDate(g.created_at)}</div>
          {n?.name && n.name !== g.name && <div className="mt-1 truncate text-[13px]">AI 建議：{n.name}</div>}
          <div className={`mt-1 text-[12px] ${brand.tone}`}>{brand.text}</div>
          <div className="mt-1 flex flex-wrap gap-x-3 text-[12px] text-mauve">
            <span>{g.has_processed ? "有去背圖" : "等待去背"}</span>
            {reviewFields > 0 && <span className="text-wine">需覆核 {n!.uncertain_fields.length || 1} 項</span>}
            {g.ai_status === "failed" && g.ai_error && <span className="text-wine">{g.ai_error}</span>}
            {g.suggestion?.status === "invalid" && g.suggestion.error_message && st !== "failed" && <span className="text-wine">上次提交無效：{g.suggestion.error_message}</span>}
          </div>
          {n && (
            <button type="button" onClick={onOpen} className="mt-2 text-[13px] text-amethyst-deep underline underline-offset-4">
              {open ? "收起對比" : "查看 AI 建議對比"}
            </button>
          )}
        </div>
      </div>
      {g.merge_target && <MergeSuggestion g={g} onDone={onChanged} />}
      {open && n && g.suggestion && <Compare g={g} n={n} suggestionId={g.suggestion.suggestion_id} onDone={onChanged} tax={tax} />}
    </li>
  );
}

/** AI 認為這張相與另一件是同一件衣服：確認後把這一件的圖片併入對方（透明圖作主圖） */
function MergeSuggestion({ g, onDone }: { g: ReviewItem; onDone: () => Promise<void> }) {
  const t = g.merge_target!;
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  // 有透明圖的一件作為保留的一件
  const keep = !t.has_processed && g.has_processed ? g : t;
  const drop = keep === t ? g : t;
  return (
    <div className="mt-3 flex items-center gap-3 rounded-2xl bg-rose-soft p-2.5">
      <div className="arch relative h-16 w-12 shrink-0 overflow-hidden" style={{ boxShadow: "none" }}>
        {(t.thumb_image_id || t.primary_image_id) && <img src={imageUrl(t.thumb_image_id || t.primary_image_id)} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-contain p-1 pt-2.5" />}
      </div>
      <div className="min-w-0 flex-1 text-[13px]">
        <p>
          AI 認為這與「<b>{displayName(t)}</b>」是同一件衣服
        </p>
        <div className="mt-1.5 flex flex-wrap gap-2">
          <Button
            className="min-h-8 px-3.5 text-[13px]"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api(`/api/garments/${keep.id}/merge`, { method: "POST", json: { source_id: drop.id } });
                toast("已合併成同一件衣物");
                await onDone();
              } catch (e) {
                toast((e as Error).message, "err");
                setBusy(false);
              }
            }}
          >
            合併
          </Button>
          <Button variant="ghost" className="min-h-8 px-3.5 text-[13px]" disabled={busy} onClick={() => setHidden(true)}>
            不是同一件
          </Button>
        </div>
      </div>
    </div>
  );
}

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (Array.isArray(v)) return v.length ? v.join("、") : "—";
  return String(v);
}

function Compare({ g, n, suggestionId, onDone, tax }: { g: ReviewItem; n: AiNormalized; suggestionId: number; onDone: () => Promise<void>; tax: Taxonomy }) {
  const locked = new Set(g.locked_fields ?? []);
  const original: Record<FieldKey, unknown> = {
    name: g.name_is_placeholder ? null : g.name,
    category: g.category,
    subcategory: g.subcategory,
    style: g.style,
    primary_color: g.primary_color,
    secondary_colors: g.secondary_colors,
    pattern: g.pattern,
    details: null,
    season: g.season,
    brand: g.brand,
  };
  const suggested: Record<FieldKey, unknown> = {
    name: n.name,
    category: n.category,
    subcategory: n.subcategory,
    style: n.style,
    primary_color: n.primary_color,
    secondary_colors: n.secondary_colors,
    pattern: n.pattern,
    details: n.details,
    season: n.season,
    brand: n.brand,
  };
  const has = (f: FieldKey) => {
    const v = suggested[f];
    return v !== null && v !== undefined && !(Array.isArray(v) && !v.length);
  };
  const [checked, setChecked] = useState<Set<FieldKey>>(() => new Set(FIELDS.map(([f]) => f).filter((f) => has(f) && !locked.has(f) && (f !== "brand" || n.brand_confidence === "confirmed"))));
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function decide(action: string, fields?: FieldKey[]) {
    setBusy(true);
    try {
      const cleanEdits = Object.fromEntries(Object.entries(edits).filter(([, v]) => v.trim() !== ""));
      await api(`/api/ai/garments/${g.id}/decide`, {
        method: "POST",
        json: { action, suggestion_id: suggestionId, version: g.version, fields, edits: Object.keys(cleanEdits).length ? cleanEdits : undefined },
      });
      toast(action === "rework" ? "已標記需要重新處理" : action === "keep_original" ? "已保留原資料" : "已更新衣物資料");
      await onDone();
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 border-t border-ink/10 pt-3">
      <table className="w-full table-fixed text-[13px]">
        <thead>
          <tr className="text-left text-[11px] text-mauve">
            <th className="w-8 pb-1" />
            <th className="w-[22%] pb-1 font-normal">欄位</th>
            <th className="pb-1 font-normal">原本</th>
            <th className="pb-1 font-normal">AI 建議</th>
          </tr>
        </thead>
        <tbody>
          {FIELDS.map(([f, label]) => {
            const isLocked = locked.has(f);
            const uncertain = n.uncertain_fields.includes(f);
            const brandBlocked = f === "brand" && n.brand_confidence !== "confirmed";
            return (
              <tr key={f} className="border-t border-ink/5 align-top">
                <td className="py-1.5">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-amethyst"
                    disabled={!has(f)}
                    checked={checked.has(f)}
                    onChange={(e) =>
                      setChecked((c) => {
                        const x = new Set(c);
                        if (e.target.checked) x.add(f);
                        else x.delete(f);
                        return x;
                      })
                    }
                    aria-label={`接受${label}`}
                  />
                </td>
                <td className="py-1.5 text-mauve">
                  {label}
                  {isLocked && <span className="ml-1 text-[10px] text-amethyst-deep">已鎖定</span>}
                </td>
                <td className="break-words py-1.5 pr-2">{fmt(original[f])}</td>
                <td className={`break-words py-1.5 ${uncertain ? "text-wine" : ""}`}>
                  {f === "brand" ? (
                    <>
                      {fmt(n.brand || n.brand_candidate)}
                      <span className={`ml-1 rounded-full px-1.5 text-[10px] ${n.brand_confidence === "confirmed" ? "bg-amethyst text-white" : "bg-rose text-ink"}`}>
                        {BRAND_CONFIDENCE_LABEL[n.brand_confidence]}
                      </span>
                      {brandBlocked && (n.brand_candidate || n.brand) && <div className="text-[11px] text-mauve">未確認，接受全部時不會寫入</div>}
                    </>
                  ) : (
                    <>
                      {fmt(suggested[f])}
                      {uncertain && <span className="ml-1 text-[10px]">（AI 不確定）</span>}
                    </>
                  )}
                  {editing && <EditField tax={tax} category={edits.category || (n.category ?? g.category)} field={f} value={edits[f] ?? ""} onChange={(v) => setEdits((e) => ({ ...e, [f]: v }))} />}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="mt-3 space-y-1 rounded-2xl bg-rose-soft p-3 text-[12px]">
        {(n.official_name || n.series_name || n.release_year) && (
          <p>
            {n.official_name && <>官方款式：{n.official_name}　</>}
            {n.series_name && <>系列：{n.series_name}　</>}
            {n.release_year && <>發售：{n.release_year}</>}
          </p>
        )}
        {n.source_urls.length > 0 && (
          <p className="break-all">
            來源{n.source_type ? `（${n.source_type}）` : ""}：
            {n.source_urls.map((u) => (
              <a key={u} href={u} target="_blank" rel="noreferrer noopener" className="mr-2 text-amethyst-deep underline">
                {u.replace(/^https?:\/\//, "").slice(0, 48)}
              </a>
            ))}
          </p>
        )}
        {n.brand_evidence_from_generated_image && <p className="text-wine">品牌證據來自 AI 生成／去背圖，印花細節可能與實物不同。</p>}
        {n.is_full_outfit && <p>AI 判斷：這是完整穿搭照</p>}
        {n.has_multiple_items && <p className="text-wine">AI 判斷：相片包含多件獨立衣物，建議人工拆分</p>}
        {n.ai_note && <p className="text-mauve">AI 備註：{n.ai_note}</p>}
        {n.brand_note && <p className="text-mauve">品牌備註：{n.brand_note}</p>}
        {(n.warnings ?? []).map((w) => (
          <p key={w} className="text-mauve">⚠ {w}</p>
        ))}
        <p className="text-mauve">來源：{g.suggestion?.source}｜{g.suggestion?.vision_checked ? "AI 已查看圖片" : "未確認 AI 有查看圖片"}</p>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button className="min-h-10 px-4 text-[14px]" disabled={busy} onClick={() => decide("accept_all")}>接受全部</Button>
        <Button variant="soft" className="min-h-10 px-4 text-[14px]" disabled={busy || (!checked.size && !Object.values(edits).some((v) => v.trim()))} onClick={() => decide("accept_fields", [...checked])}>
          只接受已勾選（{checked.size}）
        </Button>
        <Button variant="ghost" className="min-h-10 px-4 text-[14px]" disabled={busy} onClick={() => setEditing((v) => !v)}>
          {editing ? "完成修改" : "手動修改"}
        </Button>
        <Button variant="ghost" className="min-h-10 px-4 text-[14px]" disabled={busy} onClick={() => decide("keep_original")}>保留原資料</Button>
        <Button variant="ghost" className="min-h-10 px-4 text-[14px]" disabled={busy} onClick={() => decide("mark_unconfirmed")}>標記品牌未確認</Button>
        <Button variant="danger" className="min-h-10 px-4 text-[14px]" disabled={busy} onClick={() => decide("rework")}>重新處理</Button>
      </div>
      {editing && <p className="mt-2 text-[12px] text-mauve">手動修改的欄位會覆蓋 AI 建議並鎖定，之後 AI 不會再改動。</p>}
    </div>
  );
}

function EditField({ tax, category, field, value, onChange }: { tax: Taxonomy; category: string | null; field: FieldKey; value: string; onChange: (v: string) => void }) {
  const subs = tax.categories.find((c) => c.name === category)?.subs.map((s) => s.name) ?? [...new Set(tax.categories.flatMap((c) => c.subs.map((s) => s.name)))];
  const options =
    field === "category" ? tax.categories.map((c) => c.name) : field === "style" ? optionNames(tax, "style") : field === "subcategory" ? subs : field === "primary_color" ? optionNames(tax, "primary_color") : null;
  if (options)
    return (
      <select className={`${inputCls} mt-1 px-2 py-1.5 text-[13px]`} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">（不修改）</option>
        {options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    );
  return <input className={`${inputCls} mt-1 px-2 py-1.5 text-[13px]`} placeholder="（不修改）" value={value} onChange={(e) => onChange(e.target.value)} />;
}
