/**
 * Утилиты для плавных SVG-графиков.
 *
 * `ema` — экспоненциальное сглаживание значений (гасит резкие спайки,
 * убирает «дёрганье» 1Hz-семплов трафика).
 *
 * `smoothLine` / `smoothArea` — строят путь через точки гладкой кубической
 * кривой (Catmull-Rom → Безье) вместо ломаной из прямых отрезков.
 */

/** Экспоненциальное скользящее среднее. alpha ↑ = ближе к сырым данным. */
export function ema(values: number[], alpha = 0.4): number[] {
  if (values.length === 0) return [];
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) {
    out.push(alpha * values[i] + (1 - alpha) * out[i - 1]);
  }
  return out;
}

type Pt = [number, number];

/** Гладкая линия через точки (Catmull-Rom сплайн в виде кубических Безье). */
export function smoothLine(pts: Pt[]): string {
  const n = pts.length;
  if (n === 0) return "";
  if (n === 1) return `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

/** Гладкая область: та же кривая + замыкание вниз к базовой линии `baseY`. */
export function smoothArea(pts: Pt[], baseY: number): string {
  if (pts.length < 2) return "";
  const line = smoothLine(pts);
  const lastX = pts[pts.length - 1][0];
  const firstX = pts[0][0];
  return `${line} L${lastX.toFixed(1)},${baseY} L${firstX.toFixed(1)},${baseY} Z`;
}
