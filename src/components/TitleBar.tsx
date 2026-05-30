import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Кастомный титлбар для frameless-окна (decorations:false).
 *
 * Полоса сверху — drag-зона (`data-tauri-drag-region`); справа — понятные
 * оконные кнопки (свернуть / развернуть / закрыть) в стиле Windows, но
 * чистые и минималистичные. Плюс невидимые resize-хваты по краям и углам
 * (startResizeDragging) — окно полноценно ресайзится без рамки ОС.
 */

const win = () => getCurrentWindow();

const RESIZE: {
  cls: string;
  dir: Parameters<ReturnType<typeof getCurrentWindow>["startResizeDragging"]>[0];
}[] = [
  { cls: "n", dir: "North" },
  { cls: "s", dir: "South" },
  { cls: "e", dir: "East" },
  { cls: "w", dir: "West" },
  { cls: "ne", dir: "NorthEast" },
  { cls: "nw", dir: "NorthWest" },
  { cls: "se", dir: "SouthEast" },
  { cls: "sw", dir: "SouthWest" },
];

/** Синхронизировать флаг maximize на <html> (CSS поджимает карту/титлбар). */
async function syncMaximized() {
  try {
    const m = await getCurrentWindow().isMaximized();
    document.documentElement.dataset.maximized = m ? "true" : "false";
  } catch {
    /* нет доступа — игнорируем */
  }
}

export function TitleBar() {
  // Отслеживаем maximize: в развёрнутом виде frameless-окно на Windows
  // вылезает за края экрана (~8px), и контент у краёв обрезается. Ставим
  // флаг на <html>, CSS поджимает карту и титлбар внутрь.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void syncMaximized();
    void getCurrentWindow()
      .onResized(() => void syncMaximized())
      .then((u) => {
        unlisten = u;
      });
    // Подстраховка на случай если событие не успело подписаться к моменту
    // первого maximize.
    const t = window.setTimeout(() => void syncMaximized(), 500);
    return () => {
      unlisten?.();
      window.clearTimeout(t);
    };
  }, []);

  return (
    <>
      <div className="titlebar" data-tauri-drag-region>
        <div className="win-controls">
          <button
            type="button"
            className="win-btn"
            aria-label="свернуть"
            title="Свернуть"
            onClick={() => void win().minimize()}
          >
            <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden>
              <line x1="1.5" y1="6" x2="9.5" y2="6" stroke="currentColor" strokeWidth="1.1" />
            </svg>
          </button>
          <button
            type="button"
            className="win-btn"
            aria-label="развернуть"
            title="Развернуть"
            onClick={async () => {
              await win().toggleMaximize();
              await syncMaximized();
            }}
          >
            <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden fill="none">
              <rect x="1.6" y="1.6" width="7.8" height="7.8" rx="1.4" stroke="currentColor" strokeWidth="1.1" />
            </svg>
          </button>
          <button
            type="button"
            className="win-btn win-close"
            aria-label="закрыть"
            title="Закрыть"
            onClick={() => void win().close()}
          >
            <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden>
              <line x1="2" y1="2" x2="9" y2="9" stroke="currentColor" strokeWidth="1.2" />
              <line x1="9" y1="2" x2="2" y2="9" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </button>
        </div>
      </div>

      <div className="resize-layer" aria-hidden>
        {RESIZE.map(({ cls, dir }) => (
          <div
            key={cls}
            className={`rz rz-${cls}`}
            onMouseDown={(e) => {
              e.preventDefault();
              void win().startResizeDragging(dir);
            }}
          />
        ))}
      </div>
    </>
  );
}
