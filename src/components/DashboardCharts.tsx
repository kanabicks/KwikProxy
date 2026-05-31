import { useEffect, useMemo, useState } from "react";
import {
  formatSpeed,
  formatVolume,
  type BandwidthSample,
} from "../lib/hooks/useBandwidth";
import { ema, smoothLine, smoothArea } from "../lib/chartPath";

// Фиксированное окно точек — стабильный шаг по X для бесшовной прокрутки.
const CAP = 40;
const TICK_MS = 1000; // частота bandwidth-tick (POLL_INTERVAL в backend)

/**
 * Набор графиков для широкого/развёрнутого экрана (рендерится в дашборде
 * только при `useIsWide()`). Всё на чистом SVG — без зависимостей, тёмная
 * палитра под левую панель.
 *
 *  1. Area-график трафика ↑/↓ (последние ~40с).
 *  2. График стабильности пинга (latency во времени).
 *  3. Кольцо квоты трафика (used/total).
 *  4. Спидометр текущей скорости загрузки.
 */

// ─── 1. Area-график трафика ───────────────────────────────────────────────
function ThroughputChart({ history }: { history: BandwidthSample[] }) {
  const W = 520;
  const H = 110;
  const stepX = W / (CAP - 1);

  const paths = useMemo(() => {
    // Дополняем слева нулями до фиксированного окна CAP — стабильный шаг X.
    const tail = history.slice(-CAP);
    const pad = Math.max(0, CAP - tail.length);
    const dnV = ema([...Array(pad).fill(0), ...tail.map((s) => s.down)]);
    const upV = ema([...Array(pad).fill(0), ...tail.map((s) => s.up)]);
    const max = Math.max(1, ...dnV, ...upV);
    const y = (v: number) => H - (v / max) * (H - 8) - 4;
    // Лишняя точка слева (i=-1) — чтобы при сдвиге вправо не было пустого
    // края (бесшовная прокрутка).
    const dnPts: [number, number][] = [];
    const upPts: [number, number][] = [];
    for (let i = -1; i < CAP; i++) {
      const di = Math.max(0, i);
      dnPts.push([i * stepX, y(dnV[di])]);
      upPts.push([i * stepX, y(upV[di])]);
    }
    return {
      down: smoothLine(dnPts),
      up: smoothLine(upPts),
      fill: smoothArea(dnPts, H),
    };
  }, [history, stepX]);

  // Непрерывная прокрутка: на новом семпле данные сдвигаются влево, а <g>
  // мгновенно сдвигаем вправо на stepX (визуально без изменений) и плавно
  // анимируем к 0 за TICK_MS — линия едет влево ровно, без рывков.
  const [slide, setSlide] = useState({ x: 0, anim: false });
  useEffect(() => {
    setSlide({ x: stepX, anim: false });
    let r2 = 0;
    const r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() => setSlide({ x: 0, anim: true }));
    });
    return () => {
      cancelAnimationFrame(r1);
      cancelAnimationFrame(r2);
    };
  }, [history, stepX]);

  return (
    <svg
      className="chart-thr"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      <defs>
        <linearGradient id="thrFill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="rgba(216,236,90,0.32)" />
          <stop offset="100%" stopColor="rgba(216,236,90,0)" />
        </linearGradient>
      </defs>
      <g
        style={{
          transform: `translateX(${slide.x}px)`,
          transition: slide.anim ? `transform ${TICK_MS}ms linear` : "none",
        }}
      >
        <path d={paths.fill} fill="url(#thrFill)" stroke="none" />
        <path d={paths.down} className="chart-line chart-line-dn" />
        <path d={paths.up} className="chart-line chart-line-up" />
      </g>
    </svg>
  );
}

// ─── 2. График стабильности пинга ─────────────────────────────────────────
function PingChart({ samples }: { samples: (number | null)[] }) {
  const W = 520;
  const H = 90;
  const segs = useMemo(() => {
    const vals = samples.filter((v): v is number => v != null);
    if (vals.length < 2) return null;
    const max = Math.max(60, ...vals);
    const stepX = samples.length > 1 ? W / (samples.length - 1) : W;
    const y = (v: number) => H - (v / max) * (H - 10) - 5;
    // Разрываем линию на сегменты по null (таймауты), каждый — гладкой кривой.
    const out: string[] = [];
    let cur: [number, number][] = [];
    samples.forEach((v, i) => {
      if (v == null) {
        if (cur.length > 1) out.push(smoothLine(cur));
        cur = [];
      } else {
        cur.push([i * stepX, y(v)]);
      }
    });
    if (cur.length > 1) out.push(smoothLine(cur));
    return out;
  }, [samples]);

  return (
    <svg
      className="chart-ping"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      {segs?.map((d, i) => (
        <path key={i} d={d} className="chart-line chart-line-ping" />
      ))}
    </svg>
  );
}

// ─── 3. Кольцо квоты ──────────────────────────────────────────────────────
function QuotaRing({ used, total }: { used: number; total: number }) {
  const R = 32;
  const C = 2 * Math.PI * R;
  const ratio = total > 0 ? Math.min(1, used / total) : 0;
  const remaining = total > 0 ? Math.max(0, total - used) : 0;
  const warn = total > 0 && ratio > 0.85;
  const unlimited = total <= 0;
  const center = unlimited ? "∞" : formatVolume(remaining);
  const sub = unlimited ? "безлимит" : "осталось";

  return (
    <div className="chart-ring-box">
      <svg viewBox="0 0 80 80" className="chart-ring" aria-hidden>
        <circle cx="40" cy="40" r={R} className="chart-ring-track" />
        {!unlimited && (
          <circle
            cx="40"
            cy="40"
            r={R}
            className={`chart-ring-prog${warn ? " is-warn" : ""}`}
            strokeDasharray={`${(ratio * C).toFixed(1)} ${C.toFixed(1)}`}
            transform="rotate(-90 40 40)"
          />
        )}
      </svg>
      <div className="chart-ring-center">
        <span className={`chart-ring-val${warn ? " is-warn" : ""}`}>{center}</span>
        <span className="chart-ring-sub">{sub}</span>
      </div>
    </div>
  );
}

// ─── 4. Спидометр скорости загрузки ───────────────────────────────────────
function SpeedGauge({ down, peak }: { down: number; peak: number }) {
  // Полукруг (180°) радиусом r; arc-длина = π·r.
  const r = 34;
  const cx = 44;
  const cy = 44;
  const arc = Math.PI * r;
  const max = Math.max(peak, down, 1);
  const ratio = Math.min(1, down / max);
  // sweep-flag 1 → верхняя полуокружность (по часовой от левой точки идём
  // через ВЕРХ к правой — дуга над базовой линией).
  const track = `M${cx - r},${cy} A${r},${r} 0 0 1 ${cx + r},${cy}`;

  return (
    <div className="chart-gauge-box">
      <svg viewBox="0 0 88 54" className="chart-gauge" aria-hidden>
        <path d={track} className="chart-gauge-track" />
        <path
          d={track}
          className="chart-gauge-prog"
          strokeDasharray={`${(ratio * arc).toFixed(1)} ${arc.toFixed(1)}`}
        />
      </svg>
      <div className="chart-gauge-center">
        <span className="chart-gauge-val">{formatSpeed(down)}</span>
        <span className="chart-gauge-sub">↓ скорость</span>
      </div>
    </div>
  );
}

// ─── Контейнер ────────────────────────────────────────────────────────────
export function DashboardCharts({
  history,
  down,
  up,
  used,
  total,
  pingSamples,
}: {
  history: BandwidthSample[];
  down: number;
  up: number;
  used: number;
  total: number;
  pingSamples: (number | null)[];
}) {
  const peak = useMemo(
    () => Math.max(1, ...history.flatMap((s) => [s.up, s.down])),
    [history]
  );
  const lastPing = [...pingSamples].reverse().find((v) => v != null) ?? null;

  return (
    <div className="dash-charts">
      <div className="dash-chart">
        <div className="dash-chart-head">
          <span className="dash-chart-title">трафик</span>
          <span className="dash-chart-legend">
            <i className="lg lg-dn" /> {formatSpeed(down)}
            <i className="lg lg-up" /> {formatSpeed(up)}
          </span>
        </div>
        <ThroughputChart history={history} />
      </div>

      <div className="dash-chart">
        <div className="dash-chart-head">
          <span className="dash-chart-title">стабильность пинга</span>
          <span className="dash-chart-legend">
            {lastPing != null ? `${lastPing} ms` : "—"}
          </span>
        </div>
        <PingChart samples={pingSamples} />
      </div>

      <div className="dash-charts-row">
        <div className="dash-chart dash-chart-mini">
          <QuotaRing used={used} total={total} />
        </div>
        <div className="dash-chart dash-chart-mini">
          <SpeedGauge down={down} peak={peak} />
        </div>
      </div>
    </div>
  );
}
