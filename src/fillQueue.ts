/**
 * 上傳後的「填寫資料」次序：記住剛上傳的衣物，逐件填寫（存在 sessionStorage，關閉分頁即清除）。
 */
const KEY = "aw:fill-queue";

function read(): string[] {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) || "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
function write(ids: string[]) {
  try {
    if (ids.length) sessionStorage.setItem(KEY, JSON.stringify(ids));
    else sessionStorage.removeItem(KEY);
  } catch {
    /* 私密瀏覽等情況忽略 */
  }
}

export const fillQueue = {
  start(ids: string[]) {
    write([...new Set(ids)]);
  },
  /** 這件衣物在填寫次序中的位置；不在次序中（或只有一件）則為 null */
  position(id: string): { index: number; total: number } | null {
    const ids = read();
    const index = ids.indexOf(id);
    return index >= 0 && ids.length > 1 ? { index, total: ids.length } : null;
  },
  next(id: string): string | null {
    const ids = read();
    const i = ids.indexOf(id);
    return i >= 0 && i + 1 < ids.length ? ids[i + 1] : null;
  },
  remove(id: string) {
    write(read().filter((x) => x !== id));
  },
  clear() {
    write([]);
  },
};
