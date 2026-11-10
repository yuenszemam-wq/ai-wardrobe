import { useEffect, useRef, useState } from "react";

/** Only claim a downward, single-finger gesture beginning at the page top. */
export function usePullRefresh(refresh: () => void, disabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [distance, setDistance] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || disabled) { setDistance(0); return; }
    let start: { x: number; y: number } | null = null;
    let pull = 0;
    const reset = () => { start = null; pull = 0; setDistance(0); };
    const begin = (event: TouchEvent) => {
      reset();
      if (window.scrollY > 0 || event.touches.length !== 1) return;
      if ((event.target as Element).closest('input, textarea, select, button, a, [role="dialog"]')) return;
      start = { x: event.touches[0].clientX, y: event.touches[0].clientY };
    };
    const move = (event: TouchEvent) => {
      if (!start) return;
      if (event.touches.length !== 1 || window.scrollY > 0) { reset(); return; }
      const dx = event.touches[0].clientX - start.x;
      const dy = event.touches[0].clientY - start.y;
      if (dy < 0 || Math.abs(dx) > Math.max(10, dy)) { reset(); return; }
      if (dy < 8) return;
      if (event.cancelable) event.preventDefault();
      pull = Math.min(90, dy * 0.5);
      setDistance(pull);
    };
    const end = () => { const ready = pull >= 60; reset(); if (ready) refresh(); };
    const previous = document.documentElement.style.overscrollBehaviorY;
    document.documentElement.style.overscrollBehaviorY = 'none';
    el.addEventListener('touchstart', begin, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', reset);
    return () => {
      document.documentElement.style.overscrollBehaviorY = previous;
      el.removeEventListener('touchstart', begin);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end);
      el.removeEventListener('touchcancel', reset);
    };
  }, [refresh, disabled]);
  return { ref, distance };
}
