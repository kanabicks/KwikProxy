import { openUrl } from "@tauri-apps/plugin-opener";
import { useSubscriptionStore } from "../stores/subscriptionStore";

/** Открыть личный кабинет подписки.
 *
 *  ВАЖНО (изменение поведения): URL берётся ТОЛЬКО из заголовка
 *  `profile-web-page-url`, который провайдер подписки прислал в HTTP-
 *  ответе. Если заголовка нет — функция ничего не делает (no-op).
 *
 *  Захардкоженный fallback (`web.kwik.online`) убран:
 *   - универсальный клиент не должен рекламировать конкретного
 *     провайдера;
 *   - для пользователей сторонних подписок ссылка на наш сайт не
 *     релевантна;
 *   - UI должен скрывать кнопку когда `useHasDashboardUrl() === false`. */
export function openDashboard() {
  const url = useSubscriptionStore.getState().meta?.webPageUrl;
  if (!url) return;
  void openUrl(url);
}

/** Hook для условного рендера кнопки «личный кабинет».
 *  Возвращает `true` только если подписка прислала
 *  `profile-web-page-url`. */
export function useHasDashboardUrl(): boolean {
  return !!useSubscriptionStore((s) => s.meta?.webPageUrl);
}

/** Открыть страницу поддержки.
 *
 *  URL берётся ТОЛЬКО из заголовка `support-url` подписки. Захардкоженный
 *  fallback убран: универсальный клиент не привязан к конкретному
 *  провайдеру, поддержку задаёт сама подписка. Если заголовка нет —
 *  no-op, а UI должен скрывать кнопку (`useHasSupportUrl() === false`). */
export function openSupport() {
  const url = useSubscriptionStore.getState().meta?.supportUrl;
  if (!url) return;
  void openUrl(url);
}

/** Hook для условного рендера кнопки «поддержка».
 *  Возвращает `true` только если подписка прислала `support-url`. */
export function useHasSupportUrl(): boolean {
  return !!useSubscriptionStore((s) => s.meta?.supportUrl);
}
