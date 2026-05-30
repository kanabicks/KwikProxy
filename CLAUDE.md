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
- **Логирование**: `tracing` с ротацией. Логи: `%TEMP%\NemefistoVPN\`.

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
│   │   └── bin/nemefisto_helper/  # SYSTEM-helper (TUN, WFP kill switch)
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

**0.5.0 (текущий)**: **Mihomo-only** (sing-box выпилен). Сетка нод
mihomo-профиля в soft-UI (`MihomoGroupsInline`) с пинг-тестом до connect
(TCP + ICMP fallback через `platform/icmp.rs`) и live-latency после.
Двухшаговый auto-updater: скачивание **без отключения VPN** → отдельное
подтверждение установки (`downloadUpdate` / `installUpdate`).

## Что осталось (значимое)
- **Редизайн добить**: SVG-флаги (regional-indicator не рендерятся в
  WebView2), судьба classic/swiss looks, полировка Settings, тест frameless
  на чистой машине.
- **14.B code signing** ⚠️ — без подписи SmartScreen ругается (релиз-блокер).
- **14.H** privacy policy + LICENSE (до публичного релиза).
- **11.A…G** routing-профили + geofiles + autorouting + deep-links (большой
  блок, не начат).
- **Mihomo-only хвосты**: вернуть 12.E маскировку TUN-имени для Mihomo;
  built-in TUN для URI-подписок (сейчас TUN только для full mihomo-profile).
- Опционально: 13.C failover, 13.E история, 13.F speed-test, 13.J Windows
  Hello, 13.P слияние подписок (частично), 13.Q auto-grouping, 13.G WFP
  per-app (большой).

## Долги / известные проблемы
- ~~TUN 15-сек задержка~~ ✅ закрыто (Mihomo, без warmup'а).
- ~~XHTTP не поддерживается~~ ✅ закрыто — Mihomo умеет XHTTP нативно.
- **12.E маскировка TUN-имени** — после выпила sing-box стала no-op
  (работала только в sing-box-ветке). Вернуть для Mihomo отдельно.
- **TUN для URI-подписок** недоступен — Mihomo built-in TUN работает только
  для full `mihomo-profile`. URI/base64-подписки — только proxy-режим.
- **xray-json с кастомным routing/balancer** не подключается (Mihomo не
  понимает формат) — connect даёт понятную ошибку, бейдж «!» в списке.
- **SVG-флаги**: regional-indicator emoji не рендерятся в WebView2 (даже с
  Noto Color Emoji) — нужны SVG-флаги.
