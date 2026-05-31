import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

/**
 * 13.I — подписка на `bandwidth-tick` (эмитится бэкендом раз в секунду,
 * payload `{ up_bps, down_bps }` в байтах/сек). Поддерживает:
 *  - текущую скорость ↑/↓;
 *  - историю последних N тиков (для спарклайна в дашборде);
 *  - накопленный объём трафика за сессию (интеграл bps·1с ≈ байты).
 *
 * `sessionKey` — любое значение, смена которого = новая сессия (обычно
 * `connectedAt`). При смене история и накопленный объём сбрасываются.
 * `active=false` (VPN выключен) обнуляет всё и не держит лишних апдейтов.
 */

export type BandwidthSample = { up: number; down: number };

export type BandwidthState = {
  /** Текущая скорость, байт/сек. */
  up: number;
  down: number;
  /** История последних `HISTORY_LEN` тиков — старые в начале. */
  history: BandwidthSample[];
  /** Накопленный объём за сессию, байт. */
  totalUp: number;
  totalDown: number;
};

const HISTORY_LEN = 40;

const EMPTY: BandwidthState = {
  up: 0,
  down: 0,
  history: [],
  totalUp: 0,
  totalDown: 0,
};

export function useBandwidth(
  active: boolean,
  sessionKey: number | null
): BandwidthState {
  const [state, setState] = useState<BandwidthState>(EMPTY);
  // Держим актуальное состояние в ref, чтобы listener-замыкание не
  // пересоздавалось на каждый тик (подписку вешаем один раз).
  const ref = useRef<BandwidthState>(EMPTY);

  // Сброс при новой сессии / выключении.
  useEffect(() => {
    ref.current = EMPTY;
    setState(EMPTY);
  }, [sessionKey, active]);

  useEffect(() => {
    if (!active) return;
    let unlisten: (() => void) | undefined;
    let alive = true;
    void listen<{ up_bps: number; down_bps: number }>(
      "bandwidth-tick",
      (e) => {
        const up = Math.max(0, e.payload.up_bps);
        const down = Math.max(0, e.payload.down_bps);
        const prev = ref.current;
        const history = [...prev.history, { up, down }].slice(-HISTORY_LEN);
        const next: BandwidthState = {
          up,
          down,
          history,
          totalUp: prev.totalUp + up,
          totalDown: prev.totalDown + down,
        };
        ref.current = next;
        setState(next);
      }
    ).then((fn) => {
      if (alive) unlisten = fn;
      else fn();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [active]);

  return state;
}

/** Форматировать скорость (байт/сек) в человекочитаемое «X КБ/с» / «X МБ/с». */
export function formatSpeed(bps: number): string {
  if (bps < 1024) return `${Math.round(bps)} Б/с`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(0)} КБ/с`;
  return `${(bps / (1024 * 1024)).toFixed(1)} МБ/с`;
}

/** Форматировать объём (байт) в «X МБ» / «X ГБ». */
export function formatVolume(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} ГБ`;
}
