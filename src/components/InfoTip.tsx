import { useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Маленькая «i»-подсказка. Тултип рендерится через ПОРТАЛ в body с
 * `position: fixed` — поэтому не обрезается родительскими overflow и не
 * перекрывается соседними блоками (раньше CSS-::after уходил под лист
 * локаций на узкой раскладке).
 *
 * Позиция считается от bounding-rect иконки: по умолчанию НАД иконкой,
 * если сверху мало места — снизу. По горизонтали центрируется и
 * прижимается к краям окна (клемп), чтобы не вылезать за вьюпорт.
 */

const TIP_W = 250;
const MARGIN = 10;

export function InfoTip({
  text,
  label,
}: {
  text: string;
  label?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [tip, setTip] = useState<{
    left: number;
    top: number;
    placement: "top" | "bottom";
  } | null>(null);

  const show = () => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    // Центр по иконке, но клемпим чтобы коробка шириной TIP_W влезала.
    const half = Math.min(TIP_W, vw - MARGIN * 2) / 2;
    const left = Math.max(MARGIN + half, Math.min(vw - MARGIN - half, r.left + r.width / 2));
    // Над иконкой, если сверху есть место; иначе под.
    const placement: "top" | "bottom" = r.top > 130 ? "top" : "bottom";
    const top = placement === "top" ? r.top - 8 : r.bottom + 8;
    setTip({ left, top, placement });
  };
  const hide = () => setTip(null);

  return (
    <>
      <span
        ref={ref}
        className="mode-info"
        role="img"
        aria-label={label}
        tabIndex={0}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        // Клик по «i» не должен переключать режим (иконка внутри кнопки).
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
        }}
      >
        i
      </span>
      {tip &&
        createPortal(
          <div
            className={`info-tip info-tip-${tip.placement}`}
            style={{ left: tip.left, top: tip.top, width: TIP_W, maxWidth: `calc(100vw - ${MARGIN * 2}px)` }}
            role="tooltip"
          >
            {text}
          </div>,
          document.body
        )}
    </>
  );
}
