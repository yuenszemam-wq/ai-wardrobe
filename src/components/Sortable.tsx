import { PointerEvent as ReactPointerEvent, ReactNode, useEffect, useRef, useState } from "react";

export interface HandleProps {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  style: { touchAction: "none"; cursor: "grab" };
  "aria-label": string;
}

/**
 * 拖拉排序清單（手機觸控、滑鼠都可用）。按住每行的把手（☰）上下拖動。
 * 拖動時即時重排；放手後才呼叫 onReorder。
 */
export function SortableList<T extends { id: string }>({
  items,
  onReorder,
  render,
  className = "space-y-1.5",
}: {
  items: T[];
  onReorder: (ids: string[]) => void;
  render: (item: T, handle: HandleProps, dragging: boolean) => ReactNode;
  className?: string;
}) {
  const [order, setOrder] = useState<string[]>(() => items.map((i) => i.id));
  const [dragId, setDragId] = useState<string | null>(null);
  const rows = useRef(new Map<string, HTMLLIElement>());
  const orderRef = useRef(order);
  orderRef.current = order;

  // 外部資料改變（例如新增／刪除）時同步
  const key = items.map((i) => i.id).join("|");
  useEffect(() => {
    if (!dragId) setOrder(items.map((i) => i.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  function start(id: string, e: ReactPointerEvent<HTMLElement>) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const before = orderRef.current.join("|");
    setDragId(id);
    navigator.vibrate?.(8);

    const move = (ev: PointerEvent) => {
      const y = ev.clientY;
      const cur = orderRef.current.filter((x) => x !== id);
      let idx = cur.length;
      for (let i = 0; i < cur.length; i++) {
        const r = rows.current.get(cur[i])?.getBoundingClientRect();
        if (r && y < r.top + r.height / 2) {
          idx = i;
          break;
        }
      }
      const next = [...cur.slice(0, idx), id, ...cur.slice(idx)];
      if (next.join("|") !== orderRef.current.join("|")) setOrder(next);
      // 拖到畫面邊緣時自動捲動
      if (y < 80) window.scrollBy(0, -8);
      else if (y > window.innerHeight - 110) window.scrollBy(0, 8);
    };
    const end = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
      setDragId(null);
      if (orderRef.current.join("|") !== before) onReorder(orderRef.current);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }

  const byId = new Map(items.map((i) => [i.id, i]));
  return (
    <ul className={className}>
      {order
        .map((id) => byId.get(id))
        .filter((x): x is T => Boolean(x))
        .map((item) => (
          <li
            key={item.id}
            ref={(el) => {
              if (el) rows.current.set(item.id, el);
              else rows.current.delete(item.id);
            }}
            className={dragId === item.id ? "relative z-10 rounded-2xl shadow-lg ring-2 ring-amethyst" : undefined}
          >
            {render(
              item,
              { onPointerDown: (e) => start(item.id, e), style: { touchAction: "none", cursor: "grab" }, "aria-label": "拖拉排序" },
              dragId === item.id,
            )}
          </li>
        ))}
    </ul>
  );
}

export function DragHandle(props: HandleProps) {
  return (
    <span {...props} role="button" tabIndex={-1} className="grid h-9 w-8 shrink-0 select-none place-items-center text-[17px] text-mauve">
      ☰
    </span>
  );
}
