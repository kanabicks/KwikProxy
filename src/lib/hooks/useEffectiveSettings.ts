import { useSettingsStore, type Theme } from "../../stores/settingsStore";
import { useSubscriptionStore } from "../../stores/subscriptionStore";
import { useSystemTheme } from "./useSystemTheme";

/**
 * Override-логика 8.C для server-driven UX:
 *
 *   effective[key] = userTouched[key]
 *     ? userOverride[key]
 *     : subscriptionMeta[key] ?? userOverride[key]
 *
 * Если пользователь явно менял настройку (флаг `*Touched=true`),
 * используется его значение; иначе — из заголовка подписки;
 * иначе — текущее значение settings store (= дефолт).
 *
 * После удаления classic/swiss look'ов (0.7.x) единственная
 * server-driven настройка внешнего вида — тема (X-Kwik-Theme).
 */

const THEME_VALUES = ["system", "dark", "light"] as const;

/** Сужает строку из meta до union-литерала, если она в whitelist. */
function pick<T extends string>(
  value: string | null | undefined,
  allowed: readonly T[]
): T | null {
  if (!value) return null;
  return (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

export type EffectiveSettings = {
  theme: Theme;
  /** Поля, реально пришедшие из подписки (для UI-бейджей «из подписки»). */
  fromSubscription: {
    theme: boolean;
  };
};

export function useEffectiveSettings(): EffectiveSettings {
  const theme = useSettingsStore((s) => s.theme);
  const systemTheme = useSystemTheme();
  const themeTouched = useSettingsStore((s) => s.themeTouched);
  const meta = useSubscriptionStore((s) => s.meta);

  const metaTheme = pick(meta?.theme, THEME_VALUES);
  const useMetaTheme = !themeTouched && metaTheme !== null;

  // Резолвим "system" в реальное dark/light по prefers-color-scheme.
  // Делаем ПОСЛЕ override-логики — даже если в подписке прислан
  // `theme: "system"`, мы тоже подставим текущее системное значение.
  const rawTheme = useMetaTheme ? (metaTheme as Theme) : theme;
  const resolvedTheme: Theme =
    rawTheme === "system" ? (systemTheme as Theme) : rawTheme;

  return {
    theme: resolvedTheme,
    fromSubscription: {
      theme: useMetaTheme,
    },
  };
}
