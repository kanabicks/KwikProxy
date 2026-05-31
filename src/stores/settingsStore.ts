import { create } from "zustand";

export type SortMode = "none" | "ping" | "name";
/**
 * Тема интерфейса. `system` — авто, синхронизируется с
 * `prefers-color-scheme` ОС (Win10/11 Settings → Personalization → Colors
 * → Choose your default app mode). При смене на лету — UI обновляется
 * без перезапуска. См. `useEffectiveSettings`.
 */
export type Theme =
  | "system"
  | "dark"
  | "light"
  | "midnight"
  | "sunset"
  | "sand";
export type Background = "crystal" | "tunnel" | "globe" | "particles";
export type ButtonStyle = "glass" | "flat" | "neon" | "metallic";

/**
 * VPN-движок. Mihomo-only архитектура — единственный движок.
 * - **mihomo** — Clash Meta форк. Built-in TUN, vless+REALITY/Vision,
 *   hy2, tuic, wireguard, AnyTLS, native PROCESS-NAME routing.
 *   Подписка запрашивается с UA `clash-verge/v2.0.0` — панели отдают
 *   clash YAML с routing-группами.
 *
 * Тип сохранён (а не заменён на литерал "mihomo" в каждом месте) для
 * совместимости с многочисленными call-site'ами в сторах и UI.
 */
export type Engine = "mihomo";

/**
 * Правило per-process routing (этап 8.D). Применяется только в Mihomo
 * через нативный matcher `PROCESS-NAME` + `find-process-mode: always`.
 * В Xray такие правила работать не умеют (на Windows нет нативной
 * поддержки) — UI показывает баннер «работает только в Mihomo».
 *
 * - **exe** — имя исполняемого файла без пути, в нижнем регистре
 *   (Mihomo сравнивает case-insensitive). Например `telegram.exe`.
 * - **action** — куда направить трафик процесса:
 *   - `proxy` — через VPN (даже если по другим правилам шёл бы direct);
 *   - `direct` — мимо VPN (даже если по гео-правилам шёл бы через proxy);
 *   - `block` — REJECT (соединение разрывается, процесс не имеет сети).
 * - **comment** — необязательная заметка пользователя для UI.
 */
export type AppRuleAction = "proxy" | "direct" | "block";
export type AppRule = {
  exe: string;
  action: AppRuleAction;
  comment?: string;
};

/**
 * Готовые «темы-пресеты» — отдельная ось настройки, не комбинация
 * существующих theme/background/buttonStyle. У каждого пресета своя
 * уникальная палитра (CSS-переменные через `data-preset` на <html>),
 * фиксированный 3D-фон и стиль кнопки.
 *
 * Когда выбран любой пресет кроме `none`, обычные селекты темы/фона/
 * стиля становятся недоступны (управляется пресетом).
 *
 * Названия — нейтральные ассоциации:
 *  - fluent    — стиль Microsoft Fluent (acrylic, синий акцент)
 *  - cupertino — стиль Apple (мягкие пастельные, минималистичные)
 *  - vice      — стиль 80s neon arcade (фуксия + cyan)
 *  - arcade    — игровая консоль (зелёный неон по тёмному)
 *  - glacier   — холодное матовое стекло, лёд
 */
export type Preset = "none" | "fluent" | "cupertino" | "vice" | "arcade" | "glacier";

/** Какой 3D-фон рендерить при активном пресете. */
export const PRESET_BACKGROUND: Record<Preset, Background> = {
  none:      "crystal",   // не используется (preset === none → берём из settings.background)
  fluent:    "globe",
  cupertino: "particles",
  vice:      "tunnel",
  arcade:    "crystal",
  glacier:   "particles",
};

/** Какой стиль кнопки применять при активном пресете. */
export const PRESET_BUTTON_STYLE: Record<Preset, ButtonStyle> = {
  none:      "glass",     // не используется
  fluent:    "glass",
  cupertino: "flat",
  vice:      "neon",
  arcade:    "neon",
  glacier:   "glass",
};

/**
 * Палитра кристалла/линий/частиц в Three.js per-preset. Используется
 * Scene3D вместо theme-палитры когда preset активен.
 */
export const PRESET_SCENE_PALETTE: Record<
  Exclude<Preset, "none">,
  { base: number; dim: number; solid: number; fog: number }
> = {
  fluent:    { base: 0x60a5fa, dim: 0x3b6cb0, solid: 0x14203a, fog: 0x0c1424 },
  cupertino: { base: 0xff375f, dim: 0xb87080, solid: 0xeae0e0, fog: 0xf0e7e7 },
  vice:      { base: 0xff37a8, dim: 0xa02370, solid: 0x2a0a3a, fog: 0x1a0a3a },
  arcade:    { base: 0x5cc62a, dim: 0x3a7a1f, solid: 0x1a261a, fog: 0x0a140a },
  glacier:   { base: 0x9bc9f0, dim: 0x5a8bb8, solid: 0x14222e, fog: 0x0c1827 },
};

export type Settings = {
  /** Авто-обновление подписки */
  autoRefresh: boolean;
  /** Интервал авто-обновления в часах */
  autoRefreshHours: number;
  /** Флаг "пользователь явно менял интервал". Если false — заголовок
   *  `profile-update-interval` подписки имеет приоритет. См. override-
   *  логику в плане 8.C. Сбрасывается через reset(). */
  autoRefreshHoursTouched: boolean;
  /** Обновлять подписку при запуске приложения */
  refreshOnOpen: boolean;
  /** Запускать пинг всех серверов при запуске */
  pingOnOpen: boolean;
  /** Авто-подключение к последнему выбранному серверу при запуске */
  connectOnOpen: boolean;
  /** Передавать HWID в заголовке x-hwid */
  sendHwid: boolean;
  /** User-Agent для HTTP-запроса подписки */
  userAgent: string;
  /** Сортировка серверов в списке */
  sort: SortMode;
  /** Разрешить подключения из LAN (inbound listen 0.0.0.0) */
  allowLan: boolean;
  /** Тема оформления (используется когда preset === "none"). */
  theme: Theme;
  /** Тип 3D-фона (используется когда preset === "none"). */
  background: Background;
  /** Стиль главной кнопки (используется когда preset === "none"). */
  buttonStyle: ButtonStyle;
  /**
   * Активный пресет. `none` — пользователь сам подбирает theme/bg/style.
   * Любое другое значение переопределяет всё разом.
   */
  preset: Preset;
  /** Override-флаги для server-driven UX (8.C, X-Kwik-*). Если
   *  false — соответствующее значение из заголовка подписки имеет
   *  приоритет над юзер-настройкой. Сбрасываются через reset(). */
  themeTouched: boolean;
  backgroundTouched: boolean;
  buttonStyleTouched: boolean;
  presetTouched: boolean;

  // ── Anti-DPI (этап 10) ──────────────────────────────────────────────
  /** TCP-фрагментация: режет TLS ClientHello (или другие пакеты) на
   *  куски, мешая DPI собрать его. Реализовано через freedom-outbound
   *  Xray с настройкой `fragment`. */
  antiDpiFragmentation: boolean;
  /** Какие пакеты фрагментировать: `tlshello` (default — только
   *  TLS handshake), `1-3` (первые 1-3 пакета), `all` (все). */
  antiDpiFragmentationPackets: string;
  /** Длина одного фрагмента в байтах: формат `min-max`. */
  antiDpiFragmentationLength: string;
  /** Задержка между фрагментами в миллисекундах: `min-max`. */
  antiDpiFragmentationInterval: string;
  /** UDP шумовые пакеты — фейковые UDP-пакеты для запутывания DPI. */
  antiDpiNoises: boolean;
  /** Тип содержимого: `rand` (случайные байты), `str` (строка),
   *  `hex` (hex-строка). */
  antiDpiNoisesType: string;
  /** Содержимое пакета или его размер в формате `min-max`. */
  antiDpiNoisesPacket: string;
  /** Задержка между шумовыми пакетами `min-max` (мс). */
  antiDpiNoisesDelay: string;
  /** Резолвить адрес VPN-сервера через DoH (минуя системный DNS).
   *  Помогает при DNS-блокировках Роскомнадзора. */
  antiDpiServerResolve: boolean;
  /** DoH endpoint для резолва адреса сервера. */
  antiDpiResolveDoH: string;
  /** Bootstrap-IP для самого DoH-сервера (чтобы он сам не резолвился
   *  через себя). */
  antiDpiResolveBootstrap: string;
  /** Один общий override-флаг для всей anti-DPI секции. Если
   *  false — настройки из заголовков подписки `fragmentation-*` /
   *  `noises-*` / `server-address-resolve-*` имеют приоритет. */
  antiDpiTouched: boolean;

  /** Маскировка имени TUN-адаптера (этап 12.E). Если on — каждое
   *  подключение в TUN-режиме создаёт адаптер с нейтральным именем
   *  (wlan99 / Local Area Connection N / Ethernet N) вместо
   *  `kwik-<pid>`. Защита от детекта VPN приложениями типа
   *  МАХ/ВК/Госуслуг по `GetAdaptersAddresses`. */
  tunMasking: boolean;

  /** TUN-only «strict mode» (этап 13.R). Если on — proxy-режим скрыт
   *  из UI, остаётся только TUN. Параноидальная опция: пользователь
   *  не хочет иметь живой SOCKS5 на loopback (даже на рандомном
   *  порту) и предпочитает чтобы трафик шёл строго через WinTUN
   *  адаптер. При активации — если текущий режим proxy, авто-переключаем
   *  на tun. Default off (proxy быстрее стартует и по умолчанию
   *  привычнее пользователям). */
  tunOnlyStrict: boolean;

  /** Kill switch (этап 13.D — WFP). Если on — при connect helper-сервис
   *  ставит фильтры в Windows Filtering Platform на уровне ядра:
   *  block-all + allowlist (loopback, опц. LAN, IP VPN-сервера, наши
   *  процессы по app-id). DYNAMIC session: фильтры **автоматически
   *  удаляются** если helper-процесс упал — пользователь не остаётся
   *  без интернета. Дополнительная страховка — cleanup orphan-фильтров
   *  на старте helper'а. */
  killSwitch: boolean;

  /** Strict-mode kill-switch (этап 13.S). Если on — даже сам xray/mihomo
   *  не имеет общего outbound-allow, только на server_ips. Блокирует
   *  direct-маршруты xray (например `geosite:ru → DIRECT`). Закрывает
   *  кейс «kill-switch on = ничего не идёт мимо VPN». ⚠️ Несовместим
   *  со split-routing конфигами где RU-сайты идут direct — они
   *  перестанут открываться. Default off для совместимости с типовыми
   *  ожиданиями (Mullvad/Nord/Proton-семантика). */
  killSwitchStrict: boolean;

  /** 13.Q: если активного routing-профиля нет — применять встроенный
   *  «минимальный RU» шаблон (geosite:ru → DIRECT, geoip:ru → DIRECT,
   *  geosite:category-ads-all → BLOCK). Default off для совместимости —
   *  пользователи которые не хотят split-routing не увидят неожиданного
   *  поведения. */
  autoApplyMinimalRuRules: boolean;

  /** DNS leak protection (этап 13.D step B). Если on — при активном
   *  kill-switch блокируется весь :53/UDP+TCP кроме нашего VPN-DNS.
   *  Защита от приложений которые делают DNS-запросы мимо VPN. ⚠️ В
   *  proxy-режиме может ломать приложения с собственным системным
   *  DNS — лучше использовать в TUN-режиме. */
  dnsLeakProtection: boolean;

  /** Принудительно блокировать весь IPv6 outbound пока VPN активен
   *  (этап 14.D). Защита от утечек на dual-stack ISP, где часть
   *  трафика идёт по нативному v6 минуя v4-туннель. Реализовано как
   *  часть kill-switch session: helper пропускает все v6 allow-фильтры
   *  (LAN, server, app, TUN) — base block-all v6 ловит весь outbound.
   *  Loopback `::1` остаётся разрешён. Toggle работает только при
   *  активном kill-switch — без него WFP-сессии нет. */
  forceDisableIpv6: boolean;

  /** #4: разрешить IPv6 внутри ядра mihomo (`ipv6: true` в конфиге + dns).
   *  По умолчанию false (анти-leak). Полезно если ноды доступны по IPv6
   *  или провайдер IPv6-only. ⚠️ Не путать с `forceDisableIpv6` — тот
   *  режет v6 в WFP-файрволе (kill-switch), этот управляет v6 в ядре.
   *  Если включён `forceDisableIpv6`, файрвол всё равно отрежет v6. */
  ipv6: boolean;

  /** #3: пользовательские DNS-серверы (свободный текст, разделители —
   *  запятая/пробел/перевод строки). DoH-URL (`https://...`), DoT
   *  (`tls://1.1.1.1`) или IP. Если непусто — перетирают `dns.nameserver`
   *  (высший приоритет над профилем/anti-DPI/дефолтом). Пусто — дефолтная
   *  логика. */
  customDns: string;

  /** Метод проверки текущего соединения (Settings → пинг). Для
   *  per-server пингов в drawer всегда используется TCP — этот
   *  параметр влияет только на ручной «тест соединения».
   *  - `tcp` — TCP-connect к host:port URL'а (быстрая проверка
   *    доступности, не использует прокси, baseline)
   *  - `http-get` / `http-head` — HTTP-запрос через активный SOCKS5
   *    inbound (если VPN в proxy-режиме) или через system route
   *    (TUN-режим). Полная цепочка TCP+TLS+HTTP. */
  pingMethod: "tcp" | "http-get" | "http-head";

  /** Устаревшая опция mux (multiplexing) от sing-box-движка. Mihomo её
   *  не использует — поля сохранены для совместимости и backup/restore,
   *  но на конфиг не влияют. */
  mux: boolean;
  /** Протокол mux: `smux` (default), `yamux`, `h2mux`. (не используется) */
  muxProtocol: "smux" | "yamux" | "h2mux";
  /** Макс. число параллельных потоков на одно TCP-соединение.
   *  (не используется) */
  muxMaxStreams: number;

  /** URL для HTTP-методов ping'а (см. `pingMethod`). Для TCP метода
   *  парсится только host:port. Default — Cloudflare's no-content
   *  endpoint, лёгкий и без редиректов. */
  pingUrl: string;

  /** Таймаут ping'а в секундах (3-15). Default 7. */
  pingTimeoutSec: number;

  /** Активный VPN-движок (этап 8.B). См. тип `Engine` выше. */
  engine: Engine;
  /** Override-флаг для server-driven UX. Если false — заголовок
   *  `X-Kwik-Engine` подписки имеет приоритет над юзер-выбором. */
  engineTouched: boolean;

  /** Touched-флаг для userAgent. Если false — `effectiveUserAgent`
   *  возвращает дефолт Mihomo (`clash-verge/v2.0.0` — clash YAML).
   *  Когда пользователь явно правит поле в UI → флаг ставится в true,
   *  и используется ровно то значение что вписано. */
  userAgentTouched: boolean;

  /** Правила per-process routing (этап 8.D). Применяются только в
   *  Mihomo. См. тип `AppRule` выше. Пустой массив — no-op. */
  appRules: AppRule[];

  // ── Глобальные горячие клавиши (этап 13.N) ─────────────────────────
  /** Accelerator (`Ctrl+Shift+V` и т.п.) для toggle VPN. `null` —
   *  не зарегистрирована. Tauri-формат: `Modifier+...+Key`, поддержка
   *  `CommandOrControl`, `Ctrl`, `Alt`, `Shift`, `Super`. */
  shortcutToggleVpn: string | null;
  /** Accelerator для show/hide главного окна (как клик по трею). */
  shortcutShowHide: string | null;
  /** Accelerator для переключения proxy ↔ TUN режима. */
  shortcutSwitchMode: string | null;

  /** Плавающее мини-окно (этап 13.O). Если on — отдельное окошко
   *  поверх всех с status-dot и live-скоростью передачи данных.
   *  Состояние применяется при старте приложения и при каждом
   *  toggle: фронт зовёт `show_floating_window` / `hide_floating_window`. */
  floatingWindow: boolean;

  /** Показывать индикатор памяти движка (mihomo) на главном
   *  экране рядом с bandwidth-метром. Working Set резидентной памяти
   *  процесса в МБ. Polling 1Hz через `bandwidth-tick` event (один
   *  pipeline). Default off — для тех кто не хочет «технический» вид. */
  showMemoryMonitor: boolean;

  /** Авто-проверка IP/DNS после успешного connect (этап 13.B/13.H).
   *  ipapi.co + Cloudflare DoH whoami.cloudflare за один тост.
   *  Сетевые запросы платные по latency (~1-2 сек), кому-то может
   *  не нравиться — toggle. По дефолту on. */
  autoLeakTest: boolean;

  // ── Доверенные Wi-Fi сети (этап 13.M) ──────────────────────────────
  /** Список SSID которые считаются «домашними» — там VPN автоматически
   *  выключается (если включён `trustedSsidAction === "disconnect"`).
   *  Сравнение точное и case-sensitive (Windows такие и хранит). */
  trustedSsids: string[];
  /** Что делать при подключении к Wi-Fi из `trustedSsids`:
   *  - `ignore` (default) — ничего;
   *  - `disconnect` — отключить активный VPN, флаг
   *    `autoDisconnectedBySsid` помечается чтобы при выходе из сети
   *    переподключиться обратно (если включено `autoConnectOnLeave`). */
  trustedSsidAction: "ignore" | "disconnect";
  /** Автоподключение когда уходим с доверенной сети обратно в
   *  обычную. Срабатывает только если VPN был отключён нами же
   *  по trusted-правилу (а не самим пользователем). */
  autoConnectOnLeave: boolean;

  /** Предпочитаемая нода в proxy-группах mihomo (8.F).
   *  Запоминается между сессиями: пользователь до connect выбрал
   *  «Latvia» в группе `→ Kwik VPN` — после connect мы
   *  автоматически переключаем эту группу на Latvia через external-
   *  controller. Записи скапливаются по разным группам — у каждой
   *  своя предпочитаемая нода. `null` значение в map не используется
   *  (отсутствие ключа = нет преференса).
   *
   *  Имена групп берутся из YAML подписки и нестабильны между
   *  провайдерами — при смене подписки старые ключи будут невалидны
   *  и просто проигнорируются. */
  preferredMihomoNodes: Record<string, string>;

  /** 14.A: авто-проверка обновлений приложения. Если on — при старте
   *  Kwik спрашивает GitHub Releases manifest (`latest.json`).
   *  Если новая версия — non-modal toast «доступна v X.Y.Z». Юзер
   *  кликает «обновить» — скачиваем + ставим NSIS passive-install,
   *  app сама перезапускается. Default on. */
  autoCheckUpdates: boolean;

  /** 14.A: версии которые юзер dismiss'нул через «позже». Пока эта
   *  версия — последняя в latest.json, баннер обновления скрыт.
   *  Когда выйдет следующая — снова показываем. Сбрасывается через
   *  reset(). */
  dismissedUpdateVersions: string[];

  /** 14.J: язык интерфейса. `auto` — детект из `navigator.language`
   *  (если начинается на `ru` → русский, иначе английский). `ru` / `en` —
   *  явный выбор пользователя. Изменение применяется сразу через
   *  `i18n.changeLanguage()`. */
  language: "auto" | "ru" | "en";

  /** Native Windows toast'ы через WinRT ToastNotifier (Action Center).
   *  Показываются ТОЛЬКО когда главное окно не visible (свёрнуто, скрыто
   *  в трее, на заднем плане). Когда окно открыто — используем обычный
   *  in-app `Toaster.tsx`, не дублируем. Default `true`. */
  nativeNotifications: boolean;
};

/**
 * UA по умолчанию для Mihomo-движка.
 *
 * Панели подписок (Marzban, 3x-ui, Remnawave) на `clash-verge/*` UA
 * отдают clash YAML с routing-группами в формате Mihomo (RU-сайты
 * direct, ads block и т.д.).
 */
export const DEFAULT_USER_AGENT_MIHOMO = "clash-verge/v2.0.0";

/** Дефолтный UA — Mihomo-only архитектура. */
export const DEFAULT_USER_AGENT = DEFAULT_USER_AGENT_MIHOMO;

/**
 * Эффективный UA для запроса подписки. Если пользователь явно правил
 * поле (`userAgentTouched`) — возвращаем его значение «как есть»,
 * иначе — дефолт Mihomo (`clash-verge/v2.0.0`).
 *
 * Параметр `engine` сохранён в сигнатуре для совместимости call-site'ов,
 * но не влияет на результат (движок всегда Mihomo).
 */
export function effectiveUserAgent(
  _engine: Engine,
  userAgent: string,
  userAgentTouched: boolean
): string {
  if (userAgentTouched) return userAgent;
  return DEFAULT_USER_AGENT_MIHOMO;
}

const DEFAULTS: Settings = {
  autoRefresh: false,
  autoRefreshHours: 1,
  autoRefreshHoursTouched: false,
  refreshOnOpen: false,
  pingOnOpen: true,
  connectOnOpen: false,
  sendHwid: true,
  userAgent: DEFAULT_USER_AGENT,
  sort: "none",
  allowLan: false,
  theme: "dark",
  background: "crystal",
  buttonStyle: "glass",
  preset: "none",
  themeTouched: false,
  backgroundTouched: false,
  buttonStyleTouched: false,
  presetTouched: false,

  // Anti-DPI: по дефолту всё выключено, разумные значения для случая
  // когда пользователь включит вручную.
  antiDpiFragmentation: false,
  antiDpiFragmentationPackets: "tlshello",
  antiDpiFragmentationLength: "10-20",
  antiDpiFragmentationInterval: "10-20",
  antiDpiNoises: false,
  antiDpiNoisesType: "rand",
  antiDpiNoisesPacket: "10-30",
  antiDpiNoisesDelay: "10-20",
  antiDpiServerResolve: false,
  antiDpiResolveDoH: "https://cloudflare-dns.com/dns-query",
  antiDpiResolveBootstrap: "1.1.1.1",
  antiDpiTouched: false,
  tunMasking: false,
  tunOnlyStrict: false,
  killSwitch: false,
  killSwitchStrict: false,
  autoApplyMinimalRuRules: false,
  dnsLeakProtection: false,
  forceDisableIpv6: false,
  ipv6: false,
  customDns: "",
  pingMethod: "tcp",
  pingUrl: "https://www.gstatic.com/generate_204",
  pingTimeoutSec: 7,
  mux: false,
  muxProtocol: "smux",
  muxMaxStreams: 8,
  engine: "mihomo",
  engineTouched: false,
  userAgentTouched: false,
  appRules: [],
  shortcutToggleVpn: "Ctrl+Shift+V",
  shortcutShowHide: "Ctrl+Shift+M",
  shortcutSwitchMode: null,
  floatingWindow: false,
  showMemoryMonitor: false,
  autoLeakTest: true,
  trustedSsids: [],
  trustedSsidAction: "ignore",
  autoConnectOnLeave: false,
  preferredMihomoNodes: {},
  autoCheckUpdates: true,
  dismissedUpdateVersions: [],
  language: "auto",
  nativeNotifications: true,
};

const KEY = "kwik.settings.v1";

const load = (): Settings => {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const merged: Settings = { ...DEFAULTS, ...parsed };
    // Mihomo-only миграция: любое legacy-значение движка ("xray" /
    // "sing-box") из старых конфигов принудительно переезжает на "mihomo"
    // — единственный поддерживаемый движок.
    merged.engine = "mihomo";
    // Mihomo-only миграция UA: старый дефолт был "Happ/2.7.0" (под sing-box/
    // Marzban xray-json). Если в localStorage остался legacy Happ-UA — это
    // не осознанный выбор пользователя, а старый дефолт, переводим на
    // clash-verge (дефолт Mihomo), сбрасываем touched.
    if (/^happ\//i.test((merged.userAgent || "").trim())) {
      merged.userAgent = DEFAULT_USER_AGENT_MIHOMO;
      merged.userAgentTouched = false;
    }
    // Убрали темы midnight/sunset/sand из UI — persisted значение мигрируем
    // на dark, чтобы select не показывал пустоту.
    if (["midnight", "sunset", "sand"].includes(merged.theme as string)) {
      merged.theme = "dark";
    }
    return merged;
  } catch {
    return DEFAULTS;
  }
};

const save = (s: Settings) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // приватный режим — игнорируем
  }
};

type Store = Settings & {
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  reset: () => void;
};

export const useSettingsStore = create<Store>((setState, get) => ({
  ...load(),
  set: (key, value) => {
    const next: Settings = { ...get(), [key]: value };
    // Override-флаги: пользователь явно поменял настройку → перестаём
    // подхватывать значение из заголовка подписки. См. 8.C override-логику.
    if (key === "autoRefreshHours") next.autoRefreshHoursTouched = true;
    if (key === "theme") next.themeTouched = true;
    if (key === "background") next.backgroundTouched = true;
    if (key === "buttonStyle") next.buttonStyleTouched = true;
    if (key === "preset") next.presetTouched = true;
    if (key === "engine") next.engineTouched = true;
    if (key === "userAgent") next.userAgentTouched = true;
    // Любая правка anti-DPI поля → touched (override от заголовков
    // подписки больше не применяется).
    if (
      key === "antiDpiFragmentation" ||
      key === "antiDpiFragmentationPackets" ||
      key === "antiDpiFragmentationLength" ||
      key === "antiDpiFragmentationInterval" ||
      key === "antiDpiNoises" ||
      key === "antiDpiNoisesType" ||
      key === "antiDpiNoisesPacket" ||
      key === "antiDpiNoisesDelay" ||
      key === "antiDpiServerResolve" ||
      key === "antiDpiResolveDoH" ||
      key === "antiDpiResolveBootstrap"
    ) {
      next.antiDpiTouched = true;
    }
    save(next);
    setState(next);
  },
  reset: () => {
    save(DEFAULTS);
    setState(DEFAULTS);
  },
}));
