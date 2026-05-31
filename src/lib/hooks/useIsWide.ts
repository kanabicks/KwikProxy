import { useEffect, useState } from "react";

/**
 * `true` когда окно шире порога (десктопная двухпанельная раскладка).
 * Используется чтобы рендерить «тяжёлые» графики дашборда только на
 * широком/развёрнутом экране (на телефонной раскладке они не нужны и
 * не помещаются).
 */
export function useIsWide(minWidth = 980): boolean {
  const [wide, setWide] = useState(
    () => typeof window !== "undefined" && window.innerWidth >= minWidth
  );
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${minWidth}px)`);
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [minWidth]);
  return wide;
}
