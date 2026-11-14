import { useCallback, useEffect, useState } from "react";
import { TaxNode, Taxonomy } from "../../shared/taxonomy";
import { api } from "../api";
import { DragHandle, SortableList } from "../components/Sortable";
import { Button, inputCls, PageTitle, PickChips, Spinner, toast } from "../components/ui";
import { usePath, navigate } from "../router";
import { refreshTaxonomy } from "../taxonomy";

type Data = Taxonomy & { usage: Record<string, number> };

export default function TaxonomyManager() {
  const path = usePath();
  const tab = new URLSearchParams(path.split("?")[1] || "").get("tab") === "attr" ? "attr" : "cat";
  const [data, setData] = useState<Data | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<Data>("/api/taxonomy?usage=1"));
    } catch (e) {
      toast((e as Error).message, "err");
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  /** 每次修改後重新載入，並通知其他頁面 */
  const run = useCallback(
    async (fn: () => Promise<unknown>, ok?: string) => {
      try {
        const r = (await fn()) as { garments_updated?: number } | undefined;
        const n = r?.garments_updated;
        if (ok || n) toast(n ? `${ok ?? "已更新"}（同時更新了 ${n} 件衣物）` : ok!);
        await load();
        refreshTaxonomy();
        return true;
      } catch (e) {
        toast((e as Error).message, "err");
        return false;
      }
    },
    [load],
  );

  const rename = (n: TaxNode, name: string) => run(() => api(`/api/taxonomy/${n.id}`, { method: "PATCH", json: { name } }), "已改名");
  const remove = (n: TaxNode, what: string, used = 0) => {
    const msg = used
      ? `刪除「${n.name}」？\n有 ${used} 件衣物正使用這個${what}，衣物不會被刪除，資料會保留「${n.name}」這個文字，但之後不能再從清單選擇。`
      : `刪除「${n.name}」？`;
    if (!confirm(msg)) return;
    run(() => api(`/api/taxonomy/${n.id}`, { method: "DELETE" }), "已刪除");
  };
  const reorder = (ids: string[]) => run(() => api("/api/taxonomy/reorder", { method: "POST", json: { ids } }));
  const add = (kind: string, name: string, parent_id?: string, extra?: Record<string, unknown>) =>
    run(() => api("/api/taxonomy", { method: "POST", json: { kind, name, parent_id, ...extra } }), "已新增");

  return (
    <div>
      <div className="pt-4">
        <button type="button" onClick={() => history.back()} className="text-[14px] text-amethyst-deep">
          ‹ 返回
        </button>
      </div>
      <PageTitle>分類管理</PageTitle>
      <p className="-mt-1 mb-3 text-[13px] text-mauve">按住 ☰ 拖拉排序；改名會連帶更新已入庫的衣物；刪除只會從清單移除，衣物不會被刪除。</p>

      <div className="mb-4 inline-flex rounded-full bg-field p-1 ring-1 ring-ink/10">
        {[
          ["cat", "主分類及子分類"],
          ["attr", "屬性"],
        ].map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => navigate(`/taxonomy${k === "attr" ? "?tab=attr" : ""}`, true)}
            className={`rounded-full px-4 py-1.5 text-[14px] ${tab === k ? "bg-head text-rose" : "text-ink"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {!data ? (
        <Spinner />
      ) : tab === "cat" ? (
        <>
          <SortableList
            items={data.categories}
            onReorder={reorder}
            render={(c, handle) => (
              <div className="rounded-2xl bg-field ring-1 ring-ink/5">
                <div className="flex items-center gap-1 py-1 pl-1 pr-3">
                  <DragHandle {...handle} />
                  <button type="button" className="min-w-0 flex-1 truncate py-2 text-left text-[15px] font-medium" onClick={() => setOpen(open === c.id ? null : c.id)}>
                    {c.name}
                    <span className="ml-2 text-[12px] font-normal text-mauve">
                      {c.subs.length} 個子分類｜{data.usage[c.id] ?? 0} 件
                    </span>
                  </button>
                  <span className="text-mauve">{open === c.id ? "▴" : "▾"}</span>
                </div>
                {open === c.id && (
                  <div className="border-t border-ink/5 p-3">
                    <NameEditor node={c} onSave={(n) => rename(c, n)} onDelete={() => remove(c, "主分類", data.usage[c.id])} />
                    <p className="mb-1.5 mt-4 text-[13px] text-mauve">子分類</p>
                    <SortableList
                      items={c.subs}
                      onReorder={reorder}
                      className="space-y-1"
                      render={(s, h) => (
                        <SubRow
                          node={s}
                          handle={h}
                          used={data.usage[s.id] ?? 0}
                          categories={data.categories}
                          onRename={(n) => rename(s, n)}
                          onDelete={() => remove(s, "子分類", data.usage[s.id])}
                          onMove={(pid) => run(() => api(`/api/taxonomy/${s.id}`, { method: "PATCH", json: { parent_id: pid } }), "已搬移")}
                        />
                      )}
                    />
                    <AddRow placeholder="新增子分類" onAdd={(n) => add("subcategory", n, c.id)} />
                  </div>
                )}
              </div>
            )}
          />
          <div className="mt-4">
            <AddRow placeholder="新增主分類" onAdd={(n) => add("category", n)} />
          </div>
        </>
      ) : (
        <>
          <SortableList
            items={data.attributes}
            onReorder={reorder}
            render={(a, handle) => (
              <div className="rounded-2xl bg-field ring-1 ring-ink/5">
                <div className="flex items-center gap-1 py-1 pl-1 pr-3">
                  <DragHandle {...handle} />
                  <button type="button" className="min-w-0 flex-1 truncate py-2 text-left text-[15px] font-medium" onClick={() => setOpen(open === a.id ? null : a.id)}>
                    {a.name}
                    <span className="ml-2 text-[12px] font-normal text-mauve">
                      {a.multi ? `多選${a.max_select ? `（最多 ${a.max_select}）` : ""}` : "單選"}｜
                      {a.show_for?.length ? a.show_for.map((id) => data.categories.find((c) => c.id === id)?.name).filter(Boolean).join("、") : "所有衣物"}
                    </span>
                  </button>
                  <span className="text-mauve">{open === a.id ? "▴" : "▾"}</span>
                </div>
                {open === a.id && (
                  <div className="border-t border-ink/5 p-3">
                    <NameEditor node={a} onSave={(n) => rename(a, n)} onDelete={() => remove(a, "屬性")} />
                    <AttrSettings attr={a} categories={data.categories} onSave={(body) => run(() => api(`/api/taxonomy/${a.id}`, { method: "PATCH", json: body }), "已儲存")} />
                    <p className="mb-1.5 mt-4 text-[13px] text-mauve">選項</p>
                    <SortableList
                      items={a.options}
                      onReorder={reorder}
                      className="space-y-1"
                      render={(o, h) => <SubRow node={o} handle={h} onRename={(n) => rename(o, n)} onDelete={() => remove(o, "選項")} />}
                    />
                    <AddRow placeholder="新增選項" onAdd={(n) => add("option", n, a.id)} />
                  </div>
                )}
              </div>
            )}
          />
          <div className="mt-4">
            <AddRow placeholder="新增屬性（例如：肩寬）" onAdd={(n) => add("attribute", n, undefined, { multi: false })} />
          </div>
          <p className="mt-3 text-[12px] text-mauve">「風格」「主要顏色」「次要顏色」「季節」是 AI 會填寫的欄位，可以改名及增減選項，但建議保留這四個屬性。</p>
        </>
      )}
    </div>
  );
}

function NameEditor({ node, onSave, onDelete }: { node: TaxNode; onSave: (name: string) => Promise<boolean>; onDelete: () => void }) {
  const [name, setName] = useState(node.name);
  useEffect(() => setName(node.name), [node.name]);
  const changed = name.trim() && name.trim() !== node.name;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input className={`${inputCls} min-w-0 flex-1 py-2`} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} aria-label="名稱" />
      <Button className="min-h-10 px-4 text-[14px]" disabled={!changed} onClick={() => onSave(name.trim())}>
        改名
      </Button>
      <Button variant="danger" className="min-h-10 px-4 text-[14px]" onClick={onDelete}>
        刪除
      </Button>
    </div>
  );
}

function SubRow({
  node,
  handle,
  used,
  categories,
  onRename,
  onDelete,
  onMove,
}: {
  node: TaxNode;
  handle: Parameters<typeof DragHandle>[0];
  used?: number;
  categories?: TaxNode[];
  onRename: (name: string) => Promise<boolean>;
  onDelete: () => void;
  onMove?: (parentId: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(node.name);
  useEffect(() => setName(node.name), [node.name]);
  return (
    <div className="flex items-center gap-1 rounded-xl bg-rose-soft pr-2">
      <DragHandle {...handle} />
      {editing ? (
        <form
          className="flex min-w-0 flex-1 items-center gap-1 py-1"
          onSubmit={async (e) => {
            e.preventDefault();
            if (name.trim() && name.trim() !== node.name && !(await onRename(name.trim()))) return;
            setEditing(false);
          }}
        >
          <input autoFocus className="min-w-0 flex-1 rounded-lg bg-field px-2 py-1.5 ring-1 ring-ink/10" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="px-2 text-[14px] text-amethyst-deep">
            完成
          </button>
        </form>
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate py-2 text-[14px]">
            {node.name}
            {used !== undefined && used > 0 && <span className="ml-1.5 text-[12px] text-mauve">{used} 件</span>}
          </span>
          {onMove && categories && (
            <select
              aria-label="搬到其他主分類"
              className="max-w-20 bg-transparent text-[12px] text-mauve"
              value=""
              onChange={(e) => e.target.value && onMove(e.target.value)}
            >
              <option value="">搬到…</option>
              {categories
                .filter((c) => c.id !== node.parent_id)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          )}
          <button type="button" className="px-2 text-[13px] text-amethyst-deep" onClick={() => setEditing(true)} aria-label={`修改 ${node.name}`}>
            ✎
          </button>
          <button type="button" className="px-2 text-[15px] text-wine" onClick={onDelete} aria-label={`刪除 ${node.name}`}>
            ×
          </button>
        </>
      )}
    </div>
  );
}

function AddRow({ placeholder, onAdd }: { placeholder: string; onAdd: (name: string) => Promise<boolean> }) {
  const [v, setV] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="mt-2 flex gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!v.trim() || busy) return;
        setBusy(true);
        if (await onAdd(v.trim())) setV("");
        setBusy(false);
      }}
    >
      <input className={`${inputCls} min-w-0 flex-1 py-2`} placeholder={placeholder} value={v} maxLength={40} onChange={(e) => setV(e.target.value)} />
      <Button type="submit" variant="soft" className="min-h-10 px-4 text-[14px]" disabled={!v.trim() || busy}>
        ＋ 新增
      </Button>
    </form>
  );
}

function AttrSettings({ attr, categories, onSave }: { attr: TaxNode; categories: TaxNode[]; onSave: (b: Record<string, unknown>) => Promise<boolean> }) {
  const [multi, setMulti] = useState(attr.multi);
  const [max, setMax] = useState(attr.max_select ? String(attr.max_select) : "");
  const [showFor, setShowFor] = useState<string[]>(attr.show_for ?? []);
  useEffect(() => {
    setMulti(attr.multi);
    setMax(attr.max_select ? String(attr.max_select) : "");
    setShowFor(attr.show_for ?? []);
  }, [attr]);
  const names = categories.map((c) => c.name);
  const changed =
    multi !== attr.multi || (max || "") !== (attr.max_select ? String(attr.max_select) : "") || showFor.slice().sort().join() !== (attr.show_for ?? []).slice().sort().join();
  return (
    <div className="mt-4 space-y-3 rounded-2xl bg-lace p-3 ring-1 ring-ink/5">
      <div className="flex flex-wrap items-center gap-3 text-[14px]">
        <label className="flex items-center gap-2">
          <input type="radio" checked={!multi} onChange={() => setMulti(false)} className="h-4 w-4 accent-[var(--aw-check)]" />
          單選
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" checked={multi} onChange={() => setMulti(true)} className="h-4 w-4 accent-[var(--aw-check)]" />
          多選
        </label>
        {multi && (
          <label className="flex items-center gap-1 text-mauve">
            最多
            <input type="number" min={1} max={20} inputMode="numeric" className="w-16 rounded-lg bg-field px-2 py-1 ring-1 ring-ink/10" value={max} onChange={(e) => setMax(e.target.value)} placeholder="不限" />個
          </label>
        )}
      </div>
      <div>
        <p className="mb-1.5 text-[13px] text-mauve">只在以下主分類顯示（不選＝所有衣物都顯示）</p>
        <PickChips
          multi
          options={names}
          value={showFor.map((id) => categories.find((c) => c.id === id)?.name).filter((x): x is string => Boolean(x))}
          onChange={(v) => setShowFor(v.map((n) => categories.find((c) => c.name === n)!.id))}
        />
      </div>
      <Button className="min-h-10 px-4 text-[14px]" disabled={!changed} onClick={() => onSave({ multi, max_select: multi && Number(max) > 0 ? Number(max) : null, show_for: showFor.length ? showFor : null })}>
        儲存設定
      </Button>
    </div>
  );
}
