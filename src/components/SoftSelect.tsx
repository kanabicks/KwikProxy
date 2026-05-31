import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Кастомный селект в soft-стиле взамен нативного `<select>` (его выпадающий
 * список рисует ОС и не поддаётся стилизации — выглядел чужеродно).
 *
 * Триггер — кнопка с текущим значением и шевроном; меню рендерится через
 * ПОРТАЛ в body с `position: fixed`, поэтому не обрезается overflow'ом
 * настроек. Позиция считается от bounding-rect триггера: вниз по умолчанию,
 * вверх — если снизу мало места. Закрытие: клик вне, Escape, скролл.
 */

export type SoftOption = { value: string; label: ReactNode };

const MAX_H = 280;

export function SoftSelect({
  value,
  options,
  onChange,
  disabled,
  className,
  ariaLabel,
}: {
  value: string;
  options: SoftOption[];
  onChange: (v: string) => void;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{
    left: number;
    top: number;
    width: number;
    placement: "down" | "up";
  } | null>(null);

  const current = options.find((o) => o.value === value);

  const place = () => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const above = r.top;
    const placement: "down" | "up" =
      below < Math.min(MAX_H, 220) && above > below ? "up" : "down";
    setPos({
      left: r.left,
      top: placement === "down" ? r.bottom + 5 : r.top - 5,
      width: r.width,
      placement,
    });
  };

  const toggle = () => {
    if (disabled) return;
    if (open) {
      setOpen(false);
      return;
    }
    place();
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onScroll = () => setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`soft-select${open ? " is-open" : ""}${
          className ? " " + className : ""
        }`}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={toggle}
      >
        <span className="soft-select-value">{current?.label ?? value}</span>
        <svg className="soft-select-chevron" viewBox="0 0 24 24" aria-hidden>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className={`soft-select-menu soft-select-menu-${pos.placement}`}
            style={{
              left: pos.left,
              top: pos.placement === "down" ? pos.top : undefined,
              bottom:
                pos.placement === "up"
                  ? window.innerHeight - pos.top
                  : undefined,
              minWidth: pos.width,
              maxHeight: MAX_H,
            }}
            role="listbox"
          >
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={o.value === value}
                className={`soft-select-opt${
                  o.value === value ? " is-selected" : ""
                }`}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                <span className="soft-select-opt-label">{o.label}</span>
                {o.value === value && (
                  <svg className="soft-select-check" viewBox="0 0 24 24" aria-hidden>
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}
