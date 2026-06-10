import { useEffect } from "react";
import { useEffectiveSettings } from "./useEffectiveSettings";

/**
 * Синхронизирует effective `theme` с атрибутом `data-theme` на <html>.
 * Effective = override-логика из useEffectiveSettings (юзер-настройка
 * перебивает заголовок подписки, иначе используется заголовок).
 *
 * CSS-переменные определены в `:root[data-theme="..."]` (App.css) и
 * переопределяются soft-слоем (`[data-look="soft"]`, soft.css).
 */
export function useApplyTheme() {
  const { theme } = useEffectiveSettings();

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    return () => {
      delete root.dataset.theme;
    };
  }, [theme]);
}
