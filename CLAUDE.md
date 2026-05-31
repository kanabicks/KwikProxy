# VPN-клиент под Windows — контекст проекта

> Детальные спеки этапов, формат routing-профилей, таблицы заголовков и
> кросс-платформенный план — в [`docs/ROADMAP.md`](docs/ROADMAP.md)
> (не грузится каждую сессию, читать по необходимости).

## О проекте
VPN-клиент под Windows на базе **Mihomo** (форк Clash Meta). Главная цель —
«VPN одной кнопкой» с подключением менее чем за 2 секунды и минимумом
вопросов к пользователю. В планах — портирование на macOS, iOS, Android,
поэтому UI отделён от системного слоя (`platform/` изолирован, `#[cfg(windows)]`
на платформо-зависимом коде).

> **0.5.0 — Mihomo-only.** Раньше было два движка (sing-box default + Mihomo).
> sing-box **полностью выпилен** ради единого ядра («не делать солянку»).
> Mihomo покрывает всё: vless+REALITY/Vision, vmess, trojan, ss, hy2, TUIC,
> wireguard, **AnyTLS**, **XHTTP**, native per-process routing, built-in TUN.

**Все ответы, комментарии в коде, сообщения коммитов и пояснения — на
русском языке.** Технические термины (Tauri, sidecar, TUN и т.п.) — как есть.

## Технологический стек
- **Фреймворк**: Tauri 2 (ради будущей кроссплатформенности)
- **Фронтенд**: React 19 + TypeScript (strict) + Zustand + plain CSS
- **Бэкенд**: Rust (async через tokio)
- **VPN-ядро (единственное)**: **Mihomo** (форк Clash Meta) как sidecar.
  vless+REALITY/Vision, vmess, trojan, ss, hy2, TUIC, wireguard, AnyTLS,
  XHTTP, native per-process routing (`PROCESS-NAME`). Built-in TUN (gVisor,
  WinTUN) через helper SYSTEM-spawn (13.L).
- **TUN-драйвер**: WinTUN. Mihomo built-in TUN создаёт адаптер напрямую.
- **Безопасное хранилище**: Windows Credential Manager через `keyring-rs`
  v3 (⚠️ feature `windows-native` ОБЯЗАТЕЛЬНА — без неё mock-store и
  подписка «исчезает» при перезапуске).
- **Логирование**: `tracing` с ротацией. Логи: `%TEMP%\KwikVPN\`.

> Подписка запрашивается с UA `clash-verge/v2.0.0` → панели (Marzban /
> Remnawave / 3x-ui / clash) отдают clash YAML, который парсится в
> `config/subscription::parse_clash_yaml`. Full-mihomo профиль (с
> `proxy-groups`) идёт passthrough'ем целиком через
> `config/mihomo_config::patch_full_yaml`; URI/base64-списки строятся через
> `mihomo_config::build`. Конфиг Mihomo генерируется в `config/mihomo_config.rs`.

## Архитектурные принципы
1. **Долгоживущие ресурсы**: движок и WinTUN создаются при connect,
   закрываются при disconnect. Mihomo стартует быстро — warmup не нужен.
2. **State machine коннекта**: Idle → Warming → Ready → Connecting →
   Connected → Ready. Никогда не возвращаемся в Idle пока app запущено.
3. **Оптимистичный UI**: UI сразу отражает намерение, бэкенд догоняет в фоне.
4. **Умные дефолты, минимум вопросов**: при первом запуске спрашиваем только
   URL подписки. Всё остальное имеет разумные дефолты.
5. **Быстрый старт без прогрева**: первый клик «Connect» — ~1.5s до первого
   пакета через VPN.
6. **Server-driven UX**: провайдер может задать дефолты (тема, движок,
   маршрутизация, объявления) через HTTP-заголовки. Пользователь всегда
   может переопределить (`effective = userOverride ?? subHints ?? default`).
7. **Никакой телеметрии и remote control**: все логи локальные, код открыт.
   Deep-link и заголовки подписки — строгий whitelist (не могут запускать
   процессы, читать файлы вне стандартных путей, отключать Settings,
   скрывать серверы).
8. **Защита от локального детекта**: (9.H) рандомизация портов inbound
   `[30000, 60000)`; (9.G) SOCKS5 password-auth для TUN/LAN; (12.E)
   маскировка имени TUN-адаптера. Угроза: https://habr.com/ru/news/1020902/.

## Соглашения по коду
- **Rust**: `anyhow::Result` для прикладных ошибок, `thiserror` для
  библиотечных. Фоновые задачи через `tokio::spawn`. Публичные функции — с
  doc-комментариями на русском. **Никаких `unwrap()` в продакшен-коде** —
  только в тестах и где гарантированно невозможна паника (с комментарием).
- **TypeScript**: strict mode. Валидация через `zod`. Компоненты
  функциональные, hooks-стиль.
- **Именование**: snake_case в Rust, camelCase в TS, kebab-case в файлах фронта.

## Структура проекта
```
/
├── src/                    # React фронтенд
│   ├── components/         # SoftHome (главный экран soft-UI), TitleBar, Settings…
│   ├── stores/             # Zustand stores (subscriptionStore, settingsStore…)
│   ├── lib/                # Утилиты, типы, IPC-обёртки
│   ├── soft.css            # Дизайн-система «soft» (data-look="soft")
│   └── App.tsx
├── src-tauri/              # Rust бэкенд
│   ├── src/
│   │   ├── lib.rs / main.rs
│   │   ├── vpn/            # State machine, mihomo (sidecar), TUN, ping, leak-test
│   │   ├── config/         # Парсинг подписок, mihomo_config, routing
│   │   ├── platform/       # Windows-специфичный код (изолированно)
│   │   ├── ipc/            # Tauri commands
│   │   └── bin/kwik_helper/  # SYSTEM-helper (TUN, WFP kill switch)
│   ├── binaries/           # mihomo.exe, wintun.dll, geo*.dat
│   └── Cargo.toml
├── docs/ROADMAP.md         # Детальные спеки этапов
└── CLAUDE.md
```

## Принципы работы со мной (для Claude Code)
1. **Двигайся поэтапно.** Разбивай задачи на маленькие проверяемые шаги.
2. **Перед каждым шагом** кратко объясни на русском, что и почему. Для
   крупного объёма кода дождись «ок»; для мелких правок — не нужно.
3. **После каждого шага** запускай `cargo check` (Rust) и `npm run build`
   или `tsc --noEmit` (фронт). Сообщай результат.
4. **Ошибка сборки** — чини сам, максимум 3 попытки. Не вышло — стоп, объясни.
5. **Не выдумывай API.** Не уверен в синтаксисе свежей библиотеки — попроси
   ссылку на документацию или проверь через web fetch.
6. **Никаких заглушек `// TODO: implement later`** в основном пути. Не
   реализовано — скажи текстом, не прячь в коде.
7. **Перед коммитом** показывай краткое summary (абзац), не diff. Коммить
   только когда прошу.

## Архитектура VPN-ядра: Mihomo-only
**Единственный движок — Mihomo.** sing-box выпилен в 0.5.0. В коде нет
выбора движка, UA всегда `clash-verge`, `connect()` всегда поднимает Mihomo.
Если подписка отдаёт несовместимый формат (xray-json с кастомным
routing/balancer, который Mihomo не понимает) — `connect()` возвращает
понятную ошибку, в списке сервер помечен бейджем «!».

## Статус: что сделано

**Ядро / Mihomo-only (0.5.0)**: sing-box полностью удалён (config/vpn/helper
модули, бинарь из бандла, engine-выбор в UI). helper `PROTOCOL_VERSION → 12`.
Подписка через clash-verge UA → `parse_clash_yaml` (full-profile passthrough
+ URI-build). Превью серверов — на mihomo-конфиге.

**Наследие парсера/движков** (история до 0.5.0): 8.A универсальный парсер;
8.B Mihomo sidecar; 8.C server-driven заголовки + UI-бейджи «из подписки»;
8.D per-process routing (Mihomo `PROCESS-NAME`). До 0.5.0 дефолтным ядром
был sing-box (0.1.2 миграция с Xray) — теперь выпилен.

**Защита/сеть**: 9.B/9.C/9.E детект VPN-конфликтов + orphan cleanup;
9.D/9.F/9.G/9.H proxy-backup, уникальное имя TUN, SOCKS5-auth, рандом
портов; 10 anti-DPI (фрагментация/шумы/DoH); 12.E маскировка TUN;
13.D WFP kill switch (5-уровневая защита + live-toggle + strict-ready);
4-слойная network reliability (bulletproof clear_proxy, session self-heal,
кнопка «восстановить сеть», pre-flight checks в connect).

**UX/фичи**: Этап 6 (Credential Manager + autostart + network watcher);
13.A трей + close-to-tray; 13.B/13.H leak-test; 13.I bandwidth-метр;
13.K hy2 salamander; 13.L Mihomo built-in TUN; 13.M SSID auto-mode;
13.N global shortcuts; 13.O floating window; 12.A/12.C сброс настроек +
фильтр серверов.

**Production**: 14.A auto-updater (ed25519, GitHub Releases latest.json);
14.F export diagnostics; 14.I CI release workflow.

**0.3.x**: keyring windows-native fix (подписка не исчезает); кеш серверов
в localStorage (instant-старт); multi-subscription store.

**0.4.0**: новый UI «soft / cards» + frameless-окно с кастомным TitleBar.
Дизайн-система в `src/soft.css` (`data-look="soft"`), динамическая компенсация
maximize через Rust `--maxpad`, анимации открытия/закрытия sheets и Settings.

**0.5.0**: **Mihomo-only** (sing-box выпилен). Сетка нод
mihomo-профиля в soft-UI (`MihomoGroupsInline`) с пинг-тестом до connect
(TCP + ICMP fallback через `platform/icmp.rs`) и live-latency после.
Двухшаговый auto-updater: скачивание **без отключения VPN** → отдельное
подтверждение установки (`downloadUpdate` / `installUpdate`).

**0.7.0 (текущий) — ребрендинг Nemefisto → Kwik**: убрано любое упоминание
nemefisto (внешне и в коде). productName `Kwik`, identifier
`com.kwik.vpn-client`, scheme `kwik://`, helper `kwik-helper`/сервис
`KwikHelper`/pipe `\\.\pipe\kwik-helper`, каталог данных `KwikVPN`,
credential-префикс `kwik.*`, autostart `Kwik VPN Autostart`, TUN-префикс
`kwik-`, заголовки `X-Kwik-*` (чистый разрыв), репо `kanabicks/KwikProxy`,
updater endpoint на `KwikProxy`. WFP GUID-**значения** не менялись (только
display-строки) — детект orphan-фильтров цел. **One-shot миграция
существующей установки** (без ручных шагов): `secure_storage::migrate_legacy`
(+ IPC `secure_storage_migrate_legacy`, вызов из `loadSecureCreds`),
`src/lib/migrateLegacyStorage.ts` (localStorage namespace, импорт первым в
`main.tsx`), `migrate_legacy_data_dirs` (rename каталога), `service::install`
сносит legacy-сервис, `autostart::cleanup_legacy` переносит/сносит задачу,
`tun.rs` чистит legacy `nemefisto-*` адаптеры. Хардкод-URL
(`DASHBOARD_URL`/`SUPPORT_URL`) убраны — всё приходит от провайдера через
заголовки подписки. Осталось вручную: rename репо на GitHub, локальной папки;
логотип бренд-нейтральный (текста нет) — менять опционально.

**0.6.4 — UI-полиш**: анимация появления/ухода дашборда соединения
(CSS-transition opacity/translateY; на узком экране ещё max-height/margin —
секция локаций плавно подвигается, не прыгает); фикс подсветки ноды при
connect (показываем preferred всегда, без скачка на первую ноду); фикс
горизонтального дёрганья на узком экране (скроллбар нулевой ширины у
`.soft-rows`/`.soft-aside` — контент не сдвигается при появлении прокрутки).

**0.6.3 — чистая сборка**: удалён мёртвый код в helper
(`routing.rs`: 15 функций-остатков external tun2socks — `add_route`,
`assign_ip`, `set_dns`, `get_default_route`, `wait_for_interface` и т.д.;
struct `DefaultRoute`), лишние `use CommandExt` (×4, creation_flags — inherent
у tokio::Command), поле `matched_by_alias` в `tun.rs`. Сборка без warning'ов
(было 20). Живое оставлено: `delete_route_with_nexthop` (9.E), `cleanup_orphan_tun`.

**0.6.2 — кастомные дропдауны**: нативные `<select>` заменены на
`SoftSelect` (триггер + портальное меню в soft-стиле: белый лист, лайм-hover,
галочка выбора, flip вверх/вниз, закрытие по клику-вне/Escape/скроллу).
Применён ко всем селектам настроек (тема, app-rule action, язык, trusted-ssid,
интервал routing).

**0.6.1 — per-app UX + чистка меню тем**: #3 пикер запущенных
процессов (`list_processes` → soft-модалка с пастельными аватарами/поиском);
#4 живой трафик по приложениям (`app_traffic_stats` через mihomo
`/connections` → бары + «+ правило»); фикс: `build()` берёт controller
port/secret → mihomo API работает и для URI-серверов. Чистка Settings →
«интерфейс»: убраны пресет/фон/стиль-кнопки (мертвы в soft-look), остались
тема (light/dark/system)/язык/floating/память.

**0.6.0 — аудит routing 11.x + split-DNS + расширенные
возможности mihomo**: см. блок «11.A…G routing» и «Доп. mihomo-фичи» в
разделе «Что осталось» (split-DNS 11.E, sniffer, global-client-fingerprint,
TUN strict-route, DOMAIN-REGEX, DNS fallback, ECH passthrough, IPv6-тоггл,
свой DNS, PROCESS-PATH, LAN-direct + route-exclude, respect-rules).

**0.5.2 — закрытие хвостов Mihomo-only + SVG-флаги**:
- **12.E маскировка TUN-имени для Mihomo** — `tun.device` ставится в
  замаскированное имя (`wlan99` / `Ethernet 7` / `Local Area Connection N`)
  через `mihomo_config::masked_tun_name`; работает и в `build` (URI), и в
  `patch_full_yaml` (full-profile). Kill-switch детект адаптера падает на
  Description/IP когда alias замаскирован.
- **TUN для URI/base64-подписок** — `mihomo_config::build` синтезирует
  `tun:` секцию (built-in TUN) с `dns-hijack`; bail «только mihomo-profile»
  снят, `builtin_tun = tun_mode`. PROCESS-NAME app-rules теперь точны и для
  URI (mihomo владеет адаптером, видит реальный PID) — устаревшее
  предупреждение в Settings убрано.
- **SVG-флаги** (`src/lib/flags.tsx` + пакет `flag-icons`) — детект страны
  по regional-indicator паре / названию / ISO-токену (только отдельный
  2-буквенный токен, иначе ловило «fi» в «Kwik») → SVG-флаг
  (`<FlagIcon>`/`<FlagByCode>`). Решает «emoji-флаги не рендерятся в
  WebView2». Встроены в карточки нод, заголовки групп, список серверов.
- **Дашборд соединения** (`ConnectionDashboard`, левая панель при connect):
  имя локации, скорости ↑/↓ (13.I), время сессии, трафик, exit-IP+страна.
  На узком экране — компактная плашка (2 строки), на широком — полный набор
  графиков (`DashboardCharts`): area-трафик с **бесшовным скроллом**
  (фикс-окно + компенсирующий сдвиг `<g>`), стабильность пинга
  (`usePingSamples` через VPN-путь), кольцо квоты, спидометр. Все на SVG,
  сглаживание Catmull-Rom + EMA (`lib/chartPath.ts`).
- **Правая панель**: `SubStrip` (трафик/срок/«осталось N ГБ»/поддержка-
  премиум с валидацией URL) под заголовком «Локации»; `NodePingOverview`
  (бары задержек с relative-масштабом + стаггер-анимация); `AnnounceBanner`.
- **UX-полиш**: подсказки «i» на режимах (портальный `InfoTip`, не
  обрезается), кастомный тонкий скроллбар (soft), плавный maximize/restore
  (transition inset/radius), анимация появления дашборда (grid 0fr→1fr).

## Что осталось (значимое)
- **Редизайн добить**: судьба classic/swiss looks, полировка Settings, тест
  frameless на чистой машине.
- **14.B code signing** ⚠️ — без подписи SmartScreen ругается (релиз-блокер).
- **14.H** privacy policy + LICENSE (до публичного релиза).
- **11.A…G** routing-профили — ✅ **аудит проведён 2026-06-01, ядро рабочее**
  (модель/стор/scheduler/UI/deep-links/применение правил при connect). Две
  дыры закрыты: (1) профиль теперь применяется и в full-mihomo-profile
  passthrough (`FullYamlPatch.routing_profile` + `detect_proxy_target`),
  (2) geo `.dat` копируются в data-dir mihomo (`geofiles::provision_into`,
  `geodata-mode: true`) — раньше mihomo их не видел и падал на geo-правилах.
  **11.E split-DNS** ✅ — DNS-поля профиля транслируются в mihomo `dns:`
  (`build_dns`: remote DoH + bootstrap, domestic `nameserver-policy`,
  `hosts`, `fake-ip`+filter; full-profile — аддитивный `merge_profile_dns`).
- **Батч mihomo-фич** ✅ (по запросу «использовать всё что умеет ядро»):
  #1 `sniffer` (SNI/Host/QUIC, override-destination) — фундамент domain-
  правил и fake-ip; #2 `global-client-fingerprint: chrome` (uTLS, per-proxy
  fp приоритетнее); #3 TUN `strict-route` (анти-leak); #4 `DOMAIN-REGEX`
  (`regex:` теперь поддержан); #5 DNS `fallback`+`fallback-filter`
  (geoip RU, анти-подмена); #7 `tcp-concurrent`+`unified-delay`; #8
  `profile.store-selected/store-fake-ip`. В full-profile всё через
  `or_insert` (провайдерский выбор приоритетнее). **Не сделано**: #6
  rule-providers для URI (нет источника rule-set URL в формате профиля),
  #9 url-test/fallback-группы (= 13.C failover, нужен multi-node),
  #10 протоколы snell/ssr/mieru/ssh + smux (нет спроса от панелей).
- **Аудит по офиц. wiki mihomo (2026-06-01)** + добавлено: базовые DIRECT
  для приватных/loopback/link-local диапазонов перед MATCH (`local_direct_rules`)
  и TUN `route-exclude-address` — иначе `strict-route` ломал LAN/роутер;
  DNS `respect-rules: true` + `proxy-server-nameserver` (проксируемые домены
  резолвятся внутри туннеля, хост ноды — отдельно без петли). Осознанно НЕ
  делаем (нет входных данных/спроса или нужен multi-node): listeners,
  proxy-providers, url-test/fallback-группы, доп. rule-типы (DST-PORT/
  IP-ASN/PROCESS-PATH/AND-OR-NOT/SUB-RULE), ECH/tfo/mptcp/smux per-proxy,
  ntp, keep-alive-тюнинг — full-profile passthrough их и так сохраняет.
- **Доп. mihomo-фичи (2026-06-01, по запросу)**: #1 failover — только из
  конфига провайдера (url-test/fallback группы переживают passthrough; свою
  для URI не синтезируем); #2 **ECH** passthrough в `apply_stream` (из
  URI-параметра `ech` или объекта `ech-opts`); #5 **PROCESS-PATH** в
  app-rules (`app_rule_to_mihomo`: путь с разделителем → PROCESS-PATH, имя →
  PROCESS-NAME); #4 **IPv6-тоггл** (`settings.ipv6` → root/dns; в full-profile
  override провайдерского false); #3 **свой DNS** (`settings.customDns` →
  высший приоритет для `dns.nameserver`, profile domestic-policy сохраняется).
  Прокинуто через `connect(ipv6, custom_dns)`; настройки в `settingsStore`
  (+ backup-allowlist) и Settings → «сеть».
- **Per-app UX (после 0.6.0, не закоммичено)**: #3 пикер запущенных
  процессов (`list_processes` через EnumProcesses+K32GetModuleFileNameExW →
  soft-модалка с буквенными аватарами/поиском/выбором имя-vs-путь); #4 живой
  трафик по приложениям (`app_traffic_stats` агрегирует mihomo `/connections`
  по процессу → бары ↑/↓ + быстрая «+ правило»). Попутный фикс: `build()`
  теперь принимает controller-порт/secret — endpoint mihomo_api совпадает
  и для URI-серверов (раньше был mixed_port+1 c другим UUID → API не работал).
- Опционально: 13.C failover, 13.E история, 13.F speed-test, 13.J Windows
  Hello, 13.P слияние подписок (частично), 13.Q auto-grouping, 13.G WFP
  per-app (большой).

## Долги / известные проблемы
- ~~TUN 15-сек задержка~~ ✅ закрыто (Mihomo, без warmup'а).
- ~~XHTTP не поддерживается~~ ✅ закрыто — Mihomo умеет XHTTP нативно.
- ~~12.E маскировка TUN-имени~~ ✅ закрыто в 0.5.2 (через `tun.device`).
- ~~TUN для URI-подписок~~ ✅ закрыто в 0.5.2 (синтез `tun:` в `build`).
- ~~SVG-флаги~~ ✅ закрыто в 0.5.2 (`flag-icons` + `FlagIcon`).
- **xray-json с кастомным routing/balancer** не подключается (Mihomo не
  понимает формат) — connect даёт понятную ошибку, бейдж «!» в списке.
- 12.D backup/restore, 14.D IPv6-leak, 14.E crash-recovery, 14.G onboarding —
  ✅ реализованы (ранее статус в роадмапе был устаревшим).
- ~~routing-профиль игнорировался в full-mihomo-profile~~ ✅ закрыто 2026-06-01.
- ~~geofiles качались, но mihomo их не видел~~ ✅ закрыто 2026-06-01
  (`provision_into` + `geodata-mode`).
