import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useVpnStore } from "../stores/vpnStore";
import { useSubscriptionStore } from "../stores/subscriptionStore";
import { useSettingsStore } from "../stores/settingsStore";
import {
  useBandwidth,
  formatSpeed,
  formatVolume,
} from "../lib/hooks/useBandwidth";
import { useIsWide } from "../lib/hooks/useIsWide";
import { usePingSamples } from "../lib/hooks/usePingSamples";
import { DashboardCharts } from "./DashboardCharts";
import { FlagByCode, FlagIcon, cleanLabel } from "../lib/flags";

/**
 * Дашборд активного соединения — рендерится в левой панели (`soft-aside`)
 * под кнопкой/режимом, ТОЛЬКО когда VPN подключён. Заполняет пустое место
 * на широком экране полезным:
 *  - скорость ↑/↓ в реальном времени (13.I bandwidth);
 *  - мини-график трафика (спарклайн последних ~40с);
 *  - время сессии (от `vpnStore.connectedAt`);
 *  - объём трафика за сессию (накопленный интеграл);
 *  - exit-IP + страна/флаг (один leak-test после connect).
 */

type ExitInfo = {
  ip: string | null;
  country_code: string | null;
  country_name: string | null;
  city: string | null;
};

/** «1:23:45» / «12:05» из миллисекунд. */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function ConnectionDashboard() {
  const status = useVpnStore((s) => s.status);
  const connectedAt = useVpnStore((s) => s.connectedAt);
  const socksPort = useVpnStore((s) => s.socksPort);
  const mode = useVpnStore((s) => s.mode);
  const selectedIndex = useVpnStore((s) => s.selectedIndex);
  const servers = useSubscriptionStore((s) => s.servers);
  const meta = useSubscriptionStore((s) => s.meta);
  const preferred = useSettingsStore((s) => s.preferredMihomoNodes);
  const isRunning = status === "running";
  const wide = useIsWide();

  // Имя активной локации: для URI — имя выбранного сервера; для
  // mihomo-профиля — выбранная нода (preferredMihomoNodes). null → не
  // показываем (страну всё равно видно в «выход»).
  const activeName = useMemo<string | null>(() => {
    const sel = selectedIndex != null ? servers[selectedIndex] : null;
    if (!sel) return null;
    if (sel.protocol === "mihomo-profile") {
      const vals = Object.values(preferred).filter(Boolean);
      return vals[0] ?? null;
    }
    return sel.name;
  }, [selectedIndex, servers, preferred]);

  const bw = useBandwidth(isRunning, connectedAt);
  // Семплим пинг только когда графики реально видны (широкий экран + connect).
  const pingSamples = usePingSamples(
    isRunning && wide,
    socksPort,
    mode,
    connectedAt
  );

  // Таймер сессии — тикаем раз в секунду.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isRunning]);

  // Exit-IP: один запрос leak_test после подключения. Перезапрашиваем при
  // смене сессии (connectedAt). В proxy-режиме идём через наш SOCKS, в
  // TUN — через системный роут (socksPort=null).
  const [exit, setExit] = useState<ExitInfo | null>(null);
  const reqKey = useRef<number | null>(null);
  useEffect(() => {
    if (!isRunning || connectedAt == null) {
      setExit(null);
      return;
    }
    if (reqKey.current === connectedAt) return;
    reqKey.current = connectedAt;
    setExit(null);
    let alive = true;
    void invoke<ExitInfo>("leak_test", {
      socksPort: mode === "proxy" ? socksPort : null,
    })
      .then((r) => {
        if (alive) setExit(r);
      })
      .catch(() => {
        /* нет инета / leak-test упал — просто не показываем exit-IP */
      });
    return () => {
      alive = false;
    };
  }, [isRunning, connectedAt, mode, socksPort]);

  if (!isRunning) return null;

  const elapsed = connectedAt != null ? now - connectedAt : 0;
  const place =
    [exit?.country_name, exit?.city].filter(Boolean).join(", ") ||
    exit?.country_code ||
    "";

  // ── Узкий экран: компактная, но информативная плашка (без графиков) ──
  if (!wide) {
    return (
      <div className="dash-wrap">
        <section className="dash dash-compact" aria-label="Состояние соединения">
          <div className="dashc-row">
            {activeName && (
              <FlagIcon name={activeName} className="dashc-flag" />
            )}
            <span className="dashc-name">
              {activeName ? cleanLabel(activeName) : "Подключено"}
            </span>
            <span className="dashc-speeds">
              <span className="dashc-dl">↓ {formatSpeed(bw.down)}</span>
              <span className="dashc-ul">↑ {formatSpeed(bw.up)}</span>
            </span>
          </div>
          <div className="dashc-meta">
            <span>{formatDuration(elapsed)}</span>
            <span className="dashc-dot">·</span>
            <span>{formatVolume(bw.totalDown + bw.totalUp)}</span>
            {exit?.ip && (
              <>
                <span className="dashc-dot">·</span>
                <FlagByCode code={exit.country_code} className="dashc-exit-flag" />
                <span className="dashc-place">{place || exit.ip}</span>
              </>
            )}
          </div>
        </section>
      </div>
    );
  }

  // ── Широкий/развёрнутый экран: полный дашборд с графиками ──
  return (
    <div className="dash-wrap">
      <section className="dash" aria-label="Состояние соединения">
        {activeName && (
          <div className="dash-loc">
            <FlagIcon name={activeName} className="dash-loc-flag" />
            <span className="dash-loc-name">{cleanLabel(activeName)}</span>
          </div>
        )}
        <div className="dash-speeds">
          <div className="dash-speed">
            <span className="dash-speed-arrow dash-dl" aria-hidden>↓</span>
            <span className="dash-speed-val">{formatSpeed(bw.down)}</span>
          </div>
          <div className="dash-speed">
            <span className="dash-speed-arrow dash-ul" aria-hidden>↑</span>
            <span className="dash-speed-val">{formatSpeed(bw.up)}</span>
          </div>
        </div>

        <div className="dash-stats">
          <div className="dash-stat">
            <span className="dash-stat-label">сессия</span>
            <span className="dash-stat-val">{formatDuration(elapsed)}</span>
          </div>
          <div className="dash-stat">
            <span className="dash-stat-label">трафик</span>
            <span className="dash-stat-val">
              {formatVolume(bw.totalDown + bw.totalUp)}
            </span>
          </div>
          <div className="dash-stat dash-stat-exit">
            <span className="dash-stat-label">выход</span>
            <span className="dash-stat-val dash-exit">
              {exit?.ip ? (
                <>
                  <FlagByCode code={exit.country_code} className="dash-exit-flag" />
                  <span className="dash-exit-place">{place || exit.ip}</span>
                </>
              ) : (
                <span className="dash-exit-pending">…</span>
              )}
            </span>
          </div>
        </div>

        <DashboardCharts
          history={bw.history}
          down={bw.down}
          up={bw.up}
          used={meta?.used ?? 0}
          total={meta?.total ?? 0}
          pingSamples={pingSamples}
        />
      </section>
    </div>
  );
}
