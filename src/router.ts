import { useEffect, useState } from "react";

export function navigate(to: string, replace = false, scroll = true) {
  if (replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  window.dispatchEvent(new Event("aw:navigate"));
  if (scroll) window.scrollTo({ top: 0 });
}

export function usePath(): string {
  const [path, setPath] = useState(location.pathname + location.search);
  useEffect(() => {
    const on = () => setPath(location.pathname + location.search);
    window.addEventListener("popstate", on);
    window.addEventListener("aw:navigate", on);
    return () => {
      window.removeEventListener("popstate", on);
      window.removeEventListener("aw:navigate", on);
    };
  }, []);
  return path;
}

export function match(pattern: string, path: string): Record<string, string> | null {
  const clean = path.split("?")[0].replace(/\/+$/, "") || "/";
  const p = pattern.split("/");
  const a = clean.split("/");
  if (p.length !== a.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(":")) params[p[i].slice(1)] = decodeURIComponent(a[i]);
    else if (p[i] !== a[i]) return null;
  }
  return params;
}
