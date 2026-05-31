import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type PingResult = { latency_ms: number | null };

/**
 * Периодически измеряет задержку до быстрого endpoint'а ЧЕРЕЗ VPN и копит
 * временной ряд — для графика стабильности пинга в дашборде. `null` в
 * ряду = таймаут/ошибка (рисуется разрывом).
 *
 * Активен только когда `enabled` (VPN подключён И график виден) — чтобы
 * не пинговать в фоне зря. При смене сессии (`sessionKey`) ряд сбрасывается.
 *
 * Метод — HTTP GET к `generate_204` (классический latency-probe). ВАЖНО:
 * TCP-метод `connection_ping` идёт raw-сокетом МИМО прокси — он мерил бы
 * прямую задержку, не через VPN. HTTP-метод с `socksPort` (proxy-режим)
 * идёт через наш SOCKS → через VPN; в TUN — системным роутом (тоже через
 * туннель). Так график отражает именно задержку VPN-пути.
 */

const TARGET = "http://www.gstatic.com/generate_204";
const INTERVAL_MS = 4000;
const MAX_SAMPLES = 30;

export function usePingSamples(
  enabled: boolean,
  socksPort: number | null,
  mode: string,
  sessionKey: number | null
): (number | null)[] {
  const [samples, setSamples] = useState<(number | null)[]>([]);
  const ref = useRef<(number | null)[]>([]);

  useEffect(() => {
    ref.current = [];
    setSamples([]);
  }, [sessionKey, enabled]);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const push = (v: number | null) => {
      ref.current = [...ref.current, v].slice(-MAX_SAMPLES);
      setSamples(ref.current);
    };

    const tick = async () => {
      try {
        const r = await invoke<PingResult>("connection_ping", {
          method: "http-get",
          url: TARGET,
          socksPort: mode === "proxy" ? socksPort : null,
          timeoutSecs: 3,
        });
        if (alive) push(r.latency_ms ?? null);
      } catch {
        if (alive) push(null);
      }
      if (alive) timer = setTimeout(() => void tick(), INTERVAL_MS);
    };
    void tick();

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, socksPort, mode]);

  return samples;
}
