# Nemefisto — детальный roadmap и спеки этапов

> Архив детальных спецификаций. **Не грузится в контекст каждую сессию** —
> читай по необходимости при работе над конкретной фичей. Краткий статус и
> рабочие принципы — в корневом `CLAUDE.md` (source of truth по приоритетам).
>
> ⚠️ **ИСТОРИЧЕСКОЕ.** Большая часть спеков ниже описывает **двухядерную**
> архитектуру (sing-box + Mihomo), которая существовала до 0.5.0. В 0.5.0
> проект перешёл на **Mihomo-only** — sing-box полностью выпилен. Поэтому
> таблицы совместимости движков, sing-box passthrough, XHTTP-bail, выбор
> `X-Nemefisto-Engine`, per-engine UA и т.п. **больше не актуальны** —
> читать как историю. Актуальная архитектура — в корневом `CLAUDE.md`.

---

## Этап 8 — Двухядерная архитектура и server-driven config

**Цель**: уникальная фича приложения — два VPN-движка на выбор + конфигурация
дефолтов через HTTP-заголовки подписки + per-process routing.

### Архитектура движков

- **Xray** — текущий движок. Сильные стороны: REALITY / Vision / XHTTP /
  HTTPUpgrade, низколатентный обход DPI. С 1.8.16+ **поддерживает
  Hysteria2 outbound**, с 1.8.6+ — **WireGuard outbound**. То есть для
  большинства современных подписок Mihomo не обязателен.
- **Mihomo** (форк Clash Meta) — добавляется. Уникальная зона: **TUIC**,
  **AnyTLS**, гибкий routing с native `PROCESS-NAME` matcher (per-process
  без WFP). Дублирует поддержку других протоколов с Xray.

Один пользователь использует **одно ядро на сессию**. Выбор:
1. Из заголовка `X-Nemefisto-Engine` подписки;
2. Иначе из настроек пользователя;
3. По дефолту Xray.

Серверы из подписки помечаются полем `engine_compat`. Если выбранное ядро
несовместимо с сервером — UI показывает предупреждение и предлагает
переключить движок.

### Корректная таблица совместимости протоколов (после миграции 0.1.2)

| Протокол / транспорт | sing-box (default) | Mihomo |
|---|---|---|
| VLESS, VMess, Trojan, SS, SOCKS5 | ✅ | ✅ |
| **Hysteria2** | ✅ | ✅ |
| **WireGuard** | ✅ (через `endpoints[]`) | ✅ |
| **TUIC** | ✅ | ✅ |
| **AnyTLS** | ❌ (только Mihomo) | ✅ |
| Transport: TCP, WS, gRPC, h2 | ✅ | ✅ |
| Transport: **XHTTP** | ❌ (xray-only, нужен Mihomo) | ✅ (1.18+) |
| Transport: **HTTPUpgrade** | ✅ | ✅ |
| Security: TLS, REALITY | ✅ | ✅ |
| Vision (XTLS) | ✅ | ✅ |
| Built-in TUN (WinTUN, gVisor) | ✅ через helper SYSTEM-spawn | ✅ через helper SYSTEM-spawn |
| Per-process routing (`PROCESS-NAME`) | ❌ | ✅ нативно |

### Универсальный парсер подписок

`src-tauri/src/config/subscription.rs` распознаёт:
- base64-список ссылок (vless / vmess / trojan / ss / hysteria2 / tuic / wireguard / socks);
- raw текстовый список ссылок (по строке);
- готовый Xray JSON-массив (Marzban-style — UA `Happ/2.7.0`);
- готовый Xray JSON-объект (одиночный полный конфиг с inbounds/outbounds/routing);
- готовый Mihomo YAML-конфиг;
- mixed формат (base64 со смесью + спец-строки маршрутизации);
- спец-строки в теле подписки (см. раздел deep-links в этапе 11).

Любая запись приводится к единому `ProxyEntry` с маркером совместимости
с движками.

### Server-driven config (HTTP-заголовки)

При запросе подписки сервер может вернуть заголовки, которые задают
**defaults** для клиента. Все заголовки опциональны, клиент игнорирует
неизвестные ключи.

#### 1. Стандартные заголовки подписок (де-факто индустриальный стандарт — 3x-ui / Marzban / x-ui / sing-box)

| Заголовок | Формат | Назначение |
|---|---|---|
| `subscription-userinfo` | `upload=X;download=Y;total=Z;expire=T` | Статистика трафика и unix-timestamp срока истечения. UI показывает «использовано X из Y, истекает через N дней» |
| `profile-title` | текст или `base64:...` | Имя подписки (≤25 символов). Используется вместо URL в UI |
| `profile-description` | текст или `base64:...` | Описание подписки |
| `profile-update-interval` | число (часы) | Интервал автообновления подписки. Перекрывает наш `autoRefreshHours`, если пользователь не менял вручную |
| `support-url` | URL | Ссылка на поддержку. UI показывает кнопку «поддержка» в карточке подписки |
| `profile-web-page-url` | URL | Ссылка на сайт подписки. Заменяет нашу захардкоженную «личный кабинет» |
| `premium-url` | URL | Ссылка на премиум. UI показывает кнопку «премиум» если задана |
| `announce` | текст или `base64:...` | Текстовое объявление от провайдера (≤200 символов). Показывается баннером сверху |
| `announce-url` | URL | Кликабельная ссылка для объявления |
| `content-disposition` | `attachment; filename="..."` | Fallback для имени подписки если `profile-title` не задан |
| `sort-order` | `ping` \| `name` \| `none` | Сортировка серверов по умолчанию |

#### 2. Заголовки Nemefisto (наше расширение для тонкой настройки UX)

| Заголовок | Значение |
|---|---|
| `X-Nemefisto-Engine` | `xray` \| `mihomo` |
| `X-Nemefisto-Mode` | `proxy` \| `tun` |
| `X-Nemefisto-Theme` | `dark` \| `light` \| `midnight` \| `sunset` \| `sand` |
| `X-Nemefisto-Background` | `crystal` \| `tunnel` \| `globe` \| `particles` |
| `X-Nemefisto-Button-Style` | `glass` \| `flat` \| `neon` \| `metallic` |
| `X-Nemefisto-Preset` | `none` \| `fluent` \| `cupertino` \| `vice` \| `arcade` \| `glacier` |
| `X-Nemefisto-Routes` | base64-encoded JSON с domain/ip-правилами |
| `X-Nemefisto-App-Rules` | base64-encoded JSON с per-process правилами |

#### Заголовки запроса (что мы отправляем)

```
User-Agent: Nemefisto/<version>/<platform>
Accept: */*
Accept-Language: ru-RU
x-app-version: <semver>
x-device-locale: <язык>
x-client: Nemefisto
```

Если включена отправка HWID:

```
x-hwid: <hwid>
x-device-os: Windows | macOS | Linux | iOS | Android
x-ver-os: <версия ОС>
x-device-model: <модель устройства>
```

#### Override-логика

```
effective[key] = userOverride[key] ?? subscriptionHints[key] ?? defaults[key]
```

- Если пользователь не трогал настройку — используется значение из заголовков.
- Если пользователь явно переключил — используется его выбор (override).
- Если заголовков нет — поведение как сейчас, всё ручками.

В UI рядом с настройками показывается badge «из подписки» когда значение
пришло из заголовков и не переопределено пользователем.

#### Безопасность заголовков

- **Только whitelist ключей.** Любые другие заголовки игнорируются.
- Заголовки **не могут**: запускать процессы, читать/писать файлы вне
  стандартных путей приложения, отключать Settings, скрывать серверы из
  списка, изменять URL подписки.
- Заголовки **могут**: задавать UI-настройки, выбирать движок и режим,
  предоставлять правила routing'а (которые потом проверяются и
  применяются к Xray/Mihomo конфигу).

### Per-process routing

**Правила вида `<exe-name> → PROXY | DIRECT | BLOCK`.**

Реализация:
- **Mihomo**: нативно через matcher `PROCESS-NAME` (требует
  `find-process-mode: always` в YAML). Просто конвертируем `appRules`
  в правила Mihomo при генерации конфига.
- **Xray**: на Windows нативно не поддерживается. Если выбран Xray и
  заданы appRules — UI показывает предупреждение «правила приложений
  работают только с Mihomo».

Хранение в settings:

```ts
appRules: Array<{
  exe: string;          // "telegram.exe"
  action: "proxy" | "direct" | "block";
  comment?: string;
}>
```

UI: Settings → раздел «правила приложений» → список + кнопка «добавить»
с file-picker'ом для выбора exe.

### Этапы реализации

- **8.A** — универсальный парсер подписок (vmess / trojan / ss / hy2 / tuic / wireguard / socks + Mihomo YAML + полные Xray JSON).
- **8.A.1** — *(срочный hotfix, см. ниже)* завершение Xray-поддержки: hy2/wireguard outbounds + xhttp/httpupgrade transports + правка `engine_compat` для hy2/wireguard.
- **8.B** — Mihomo как второй sidecar; UI-селект движка; helper-coordination для TUN с любым ядром. **Уникальная зона Mihomo сократилась до TUIC + AnyTLS + native per-process** — но всё ещё нужен.
- **8.C** — заголовки подписки (стандартные + Nemefisto) + override-логика + UI-бейджи «из подписки» + UI для `subscription-userinfo` / `announce` / `support-url` / `premium-url`.
- **8.D** — per-process routing (Mihomo-only через PROCESS-NAME) с UI-редактором правил. Альтернативная реализация через WFP (Windows-native, для обоих движков) — см. этап 13.G.
- **8.E** — релизный NSIS-installer (см. ниже).

### 8.A.1 — Завершение поддержки протоколов и транспортов

**Срочный hotfix** к коммиту `6fcb4d9` (этап 8.A): ошибочно маркировал
hy2 и wireguard как Mihomo-only, тогда как современный Xray умеет оба.
Также не были добавлены два важных Xray-транспорта.

Изменения в коде:

1. **`config/subscription.rs`** — `engine_compat` для парсеров:
   - `parse_hysteria2()` → `engines_both()` (было `engines_mihomo_only()`);
   - `parse_wireguard()` → `engines_both()` (было `engines_mihomo_only()`);
   - функция `engines_mihomo_only` остаётся — теперь только для **TUIC**
     и **AnyTLS** (yaml_proxy_to_entry helper).

2. **`config/xray_config.rs`** — добавить новые `build_*` функции:
   - `build_hysteria2(entry)` — VLESS-style outbound с `protocol:
     "hysteria2"`, settings включают `password` + `obfs` (если
     задано в raw) + `serverName` + `alpn: ["h3"]`.
   - `build_wireguard(entry)` — `protocol: "wireguard"`, settings:
     `secretKey`, `address` (массив `"10.0.0.2/32"`), `peers` с
     `publicKey`, `endpoint` = server:port, `mtu`, `reserved`
     (если есть).
   - Подключить в `build_outbound()`: убрать `bail!` для hy2/wireguard.

3. **`config/xray_config.rs`** — расширить `build_stream()` новыми
   transport-ами:
   - `"xhttp"` →
     ```rust
     let path = raw["path"].as_str().unwrap_or("/");
     let host = raw["host"].as_str().unwrap_or("");
     let mode = raw["mode"].as_str().unwrap_or("auto");
     // mode: auto | packet-up | stream-up | stream-one
     let mut x = json!({ "path": path, "mode": mode });
     if !host.is_empty() { x["host"] = host.into(); }
     s["xhttpSettings"] = x;
     ```
   - `"httpupgrade"` →
     ```rust
     let path = raw["path"].as_str().unwrap_or("/");
     let host = raw["host"].as_str().unwrap_or("");
     let mut hu = json!({ "path": path });
     if !host.is_empty() { hu["host"] = host.into(); }
     s["httpupgradeSettings"] = hu;
     ```

После 8.A.1 пользователи смогут подключаться к hy2/wireguard
серверам в Xray-only клиенте, **без необходимости 8.B (Mihomo)**.
Это убирает блокирующее «требуется Mihomo» сообщение для большинства
современных подписок.

### 8.E — Релизный NSIS-installer

Цель: один setup.exe который пользователь скачивает с сайта,
дважды кликает, и приложение готово к работе.

- Все sidecar (sing-box, mihomo, wintun.dll) добавляются в
  `tauri.conf.json` через `externalBin` или `resources`.
- `nemefisto-helper.exe` собирается отдельно release-сборкой и
  включается в bundle.
- `helper_bootstrap.rs` ищет helper в `<install-dir>/` или
  в `<install-dir>/resources/`, не только в exe-dir.
- `webviewInstallMode: "downloadBootstrapper"` — auto-install
  WebView2 при отсутствии (Win10 без обновлений).
- Кастомная иконка и метаданные NSIS (название, описание, версия,
  издатель).
- Опциональная страница «Запустить Nemefisto после установки» в
  wizard.
- Output: `Nemefisto_<version>_x64-setup.exe` в
  `src-tauri/target/release/bundle/nsis/`.

---

## Этап 9 — Защита от конфликтов с другими VPN-клиентами

**Цель**: приложение не падает и не оставляет систему в сломанном
состоянии когда параллельно активен другой VPN, заняты порты, остались
orphan-ресурсы от прошлых сессий.

### 9.A — Авто-выбор свободных портов (готово)
- `find_free_port(start)` сканит вверх до первого свободного.
- Дополнительно: команда `get_port_conflict_info()` возвращает имя
  процесса, занявшего стандартный порт — UI показывает в логах.
- Стартовая точка с этапа 9.H — псевдослучайный порт `[30000, 60000)`,
  не фиксированные `1080/1087`.

### 9.B — Детект известных VPN-клиентов
При старте приложения и при connect перебираем процессы. Знакомые
имена (Happ, OutlineClient, OpenVPNGUI, wireguard, nordvpn, ExpressVPN,
ProtonVPN, mullvad, v2rayN, Clash, Hiddify, INCY, и др.) — показываем
неблокирующий warning-banner.

Implementation: `EnumProcesses` Win32 API в `platform/processes.rs`.

### 9.C — Детект конфликтов routing-таблицы
Перед спавном TUN helper проверяет наличие сторонних TUN-адаптеров
с активными half-default или 0.0.0.0/0 маршрутами. Если найдено —
bail с сообщением «отключите другой VPN». Опциональный force-mode для
продвинутых пользователей.

### 9.D — System proxy backup/restore
При connect (mode=proxy) сохранять предыдущие значения registry-keys
`ProxyEnable` / `ProxyServer` / `ProxyOverride` в
`%LOCALAPPDATA%\NemefistoVPN\proxy_backup.json`. При disconnect —
восстанавливать. На случай краша — детект backup-файла на старте app
с предложением восстановить.

### 9.E — Cleanup orphan-ресурсов на старте
- Helper-сервис при старте: удалить все WinTUN-адаптеры с префиксом
  `nemefisto-` (best-effort через `Remove-NetAdapter`); вычистить
  routing-rules с нашим NextHop=198.18.0.1.
- Main app при старте: detect proxy_backup.json и предложить restore.

### 9.F — Уникальное имя TUN (готово)
Каждая сессия создаёт `nemefisto-<pid>` — двойной запуск приложения
не конфликтует.

### 9.G — SOCKS5 inbound authentication

**Цель**: защита от использования нашего локального SOCKS5 прокси
сторонним процессом / устройством в LAN.

Сейчас наш inbound — `auth: noauth`, что позволяет:
- любому процессу на машине в proxy/TUN-режиме гонять свой трафик
  через VPN (включая малварь);
- в LAN-режиме — любому устройству в Wi-Fi сети использовать клиент
  как открытый прокси.

Решение: при старте генерируется случайный пароль (UUID v4),
inbound настраивается с `auth: password`. Пароль знает только наше
приложение и его компоненты.

Применение по режимам:
- **TUN-режим**: ставим всегда (прозрачно для пользователя).
- **LAN-режим** (`allow_lan: true`): обязательно. UI показывает
  сгенерированный логин/пароль с кнопкой копирования.
- **Proxy-режим (loopback, default)**: оставляем `noauth`. Windows
  registry для системного прокси не поддерживает `user:pass@host:port`
  синтаксис. Loopback и так только локально-доступен.

### 9.H — Рандомизация портов inbound (готово)

**Цель**: защита от локального сканирования VPN-клиента.

Любое приложение на машине без админ-прав может за миллисекунды
просканировать стандартные SOCKS-порты (`7890`, `1080`, `1087`) и
обнаружить запущенный VPN-клиент. Это активно применяется для детекта
VPN-пользователей (см. https://habr.com/ru/news/1020902/).

Решение: при подключении inbound'ы стартуют с псевдослучайных
портов в диапазоне `[30000, 60000)`. В связке с **9.G** (SOCKS5 auth
для TUN/LAN) даёт двойную защиту.

---

## Этап 10 — Anti-DPI обвязка

**Цель**: повысить процент успешных подключений в условиях агрессивного
DPI (Россия, Иран, Китай). Все механизмы опциональны.

> После миграции 0.1.2 переписано под sing-box-нативный `tls.fragment`
> + DoH-bootstrap.

### 10.A — TCP-фрагментация
Делит TLS ClientHello на куски, мешая DPI собрать его обратно.

**HTTP-заголовки подписки:**

| Заголовок | Формат | Значение |
|---|---|---|
| `fragmentation-enable` | `0` \| `1` | Включить/выключить |
| `fragmentation-packets` | `tlshello` \| `1-3` \| `all` | Какие пакеты фрагментировать |
| `fragmentation-length` | `min-max` (байты) | Размер фрагмента |
| `fragmentation-interval` | `min-max` (мс) | Задержка между фрагментами |

**Дефолты** при `fragmentation-enable: 1`: `packets: tlshello`,
`length: 10-20`, `interval: 10-20`.

### 10.B — Шумовые пакеты (noises)
Фейковые UDP-пакеты для запутывания DPI.

| Заголовок | Формат | Значение |
|---|---|---|
| `noises-enable` | `0` \| `1` | Включить/выключить |
| `noises-type` | `rand` \| `str` \| `hex` | Тип содержимого |
| `noises-packet` | строка или `min-max` | Содержимое или размер |
| `noises-delay` | `min-max` (мс) | Задержка между пакетами |

### 10.C — Server-address-resolve через DoH
Перед подключением к серверу VPN резолвим его адрес через DoH (минуя
системный DNS, который может быть отравлен/заблокирован).

| Заголовок | Формат | Значение |
|---|---|---|
| `server-address-resolve-enable` | `0` \| `1` | Включить |
| `server-address-resolve-dns-domain` | URL | DoH endpoint |
| `server-address-resolve-dns-ip` | IP | Bootstrap IP для DoH-сервера |

---

## Этап 11 — Routing-профили, geofiles и расширенные deep-links

**Цель**: пользователь может импортировать профиль маршрутизации одним
кликом из ссылки, профиль автоматически обновляется по расписанию.

### 11.A — Формат routing-профиля

JSON-документ, совместимый с типовыми панелями:

```json
{
  "Name": "RoscomVPN",
  "GlobalProxy": "true",
  "LastUpdated": "1700000000",
  "DomainStrategy": "IPIfNonMatch",

  "RemoteDNSType": "DoH",
  "RemoteDNSDomain": "https://cloudflare-dns.com/dns-query",
  "RemoteDNSIP": "1.1.1.1",
  "DomesticDNSType": "DoH",
  "DomesticDNSDomain": "https://dns.google/dns-query",
  "DomesticDNSIP": "8.8.8.8",
  "DnsHosts": { "example.com": "1.2.3.4" },
  "FakeDNS": "false",

  "DirectSites": ["geosite:ru"],
  "DirectIp":    ["geoip:ru", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
  "ProxySites":  [],
  "ProxyIp":     [],
  "BlockSites":  ["geosite:category-ads-all"],
  "BlockIp":     [],

  "Geoipurl":   "https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geoip.dat",
  "Geositeurl": "https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geosite.dat",
  "useChunkFiles": false
}
```

**Поля:**
- `GlobalProxy` — весь трафик через прокси (`true`) или только по правилам.
- `DomainStrategy` — `AsIs` / `IPIfNonMatch` / `IPOnDemand`.
- `DirectSites` / `DirectIp` / `ProxySites` / `ProxyIp` / `BlockSites` / `BlockIp` — массивы правил (`geosite:XX`, `geoip:XX`, домены, IP/CIDR).
- `RemoteDNS*` — DNS для проксированного трафика.
- `DomesticDNS*` — DNS для прямого трафика (split DNS).
- `DnsHosts` — статические DNS-записи.
- `FakeDNS` — виртуальные IP для доменов (Mihomo only).

### 11.B — Geofiles с оптимизацией через .sha256

Скачиваем `geoip.dat` и `geosite.dat` с GitHub (Loyalsoldier/v2ray-rules-dat).
Кладём в `%LOCALAPPDATA%\NemefistoVPN\geofiles\`.

**Алгоритм обновления:**
1. Скачиваем `geoip.dat.sha256` (64 hex-символа).
2. Сравниваем с сохранённым хешем.
3. Если совпадает — пропускаем скачивание `.dat` (экономия 5–15 МБ).
4. Если нет — качаем `.dat`, сохраняем новый хеш.
5. Fallback: если `.sha256` недоступен, сравниваем `LastUpdated`.

**Опция `useChunkFiles: true`** (для мобильных, на десктопе игнорируется):
парсим protobuf-файл и оставляем только упомянутые в правилах теги.

### 11.C — Autorouting vs Routing (два режима)

- **Routing** — статический профиль. Передаётся как base64 в заголовке
  `routing` или ссылка `nemefisto://routing/onadd/{base64}`. Обновляется
  только при ручном перезапросе подписки.
- **Autorouting** — URL-источник, профиль скачивается отдельно и
  обновляется автоматически по интервалу. В UI помечается иконкой облака.

**Заголовки подписки:**

| Заголовок | Формат | Назначение |
|---|---|---|
| `routing` | base64 / URL | Статический профиль маршрутизации |
| `autorouting` | URL | URL-источник с периодическим обновлением |

**Интервалы автообновления**: 12 ч / 24 ч (default) / 3 дня / 7 дней.

**Приоритет источников** (если задано несколько):
1. Заголовок `autorouting`
2. Body-строка `://autorouting/...`
3. Заголовок `routing`
4. Body-строка `://routing/...` (base64)

### 11.D — Расширенные deep-links

Расширяем обработчик `nemefisto://` командами:

#### Управление VPN
| Команда | Действие |
|---|---|
| `nemefisto://connect` или `nemefisto://open` | Подключить VPN |
| `nemefisto://disconnect` или `nemefisto://close` | Отключить VPN |
| `nemefisto://toggle` | Переключить состояние |
| `nemefisto://status` | Открыть приложение, показать статус |

#### Импорт конфигураций
| Команда | Что делает |
|---|---|
| `nemefisto://import/{data}` | Auto-detect: URL подписки или одиночная ссылка |
| `nemefisto://add/{url}` | Добавить подписку напрямую |
| `nemefisto://onadd/{url}` | Сокращённая форма (без автообновления) |

#### Маршрутизация
| Команда | Действие |
|---|---|
| `nemefisto://routing/add/{base64}` | Добавить routing-профиль |
| `nemefisto://routing/onadd/{base64}` | Добавить и сразу активировать |
| `nemefisto://routing/onadd/{url}` | Скачать одноразово (без автообновления) |
| `nemefisto://autorouting/add/{url}` | Скачать с автообновлением (не активирует) |
| `nemefisto://autorouting/onadd/{url}` | Скачать, активировать, включить автообновление |

**Query-параметр `?data={base64}`** поддерживается как альтернатива
path-сегменту. **GitHub-конвертация**: `https://github.com/.../blob/main/...`
автоматически переписывается на `raw.githubusercontent.com/.../main/...`.

### 11.E — Спец-строки в теле подписки

Универсальный парсер дополнительно распознаёт строки:

```
://autorouting/onadd/https://example.com/profile.json
://autorouting/add/https://example.com/profile.json
://routing/onadd/https://example.com/profile.json
://routing/onadd/{base64}
://routing/add/{base64}
#announce: текст объявления
#announce: base64:...
#profile-title: имя
#support-url: https://...
#profile-web-page-url: https://...
#announce-url: https://...
#profile-update-interval: 6
```

### 11.F — Применение правил к движкам

- **Mihomo**: маппим напрямую — `DirectSites/DirectIp` → `DIRECT`,
  `ProxySites/ProxyIp` → выбранная proxy-group, `BlockSites/BlockIp` →
  `REJECT`. `geosite:`/`geoip:` нативно.
- **Xray/sing-box**: транслируем в `routing.rules[]` с `outboundTag`.
  `geosite:`/`geoip:` из локальных `.dat` через `assets`-каталог.

### Этапы реализации
- **11.A** — модель `RoutingProfile` (Rust + TS типы), парсинг, валидация.
- **11.B** — менеджер geofiles: скачивание, кеш, `.sha256`, фоновые обновления.
- **11.C** — стор для профилей, routing vs autorouting, scheduler.
- **11.D** — расширение deep-link обработчика.
- **11.E** — расширение парсера подписок спец-строками.
- **11.F** — генерация правил в конфигах движков.
- **11.G** — UI: вкладка «маршрутизация» в Settings, импорт/удаление,
  индикатор «обновлено N часов назад», кнопка refresh.

---

## Этап 12 — Полировка UX (предложения сообщества)

### 12.A — Сброс настроек без удаления подписки (готово)
Две раздельные кнопки: «сбросить настройки» (не трогает подписку) и
«удалить всё» (с двойным confirm).

### 12.B — Дата последнего обновления подписки
`lastFetchedAt: number` (unix-ts) в store + персист. Относительный формат
(«5 мин назад», «2 ч назад», «3 дн назад», «давно» если >7 дней).

### 12.C — Фильтр серверов в drawer (готово)
Search-input + чипы протоколов. Фильтрация на клиенте.

### 12.D — Backup/restore настроек через deep-link
- `nemefisto://export` — file-save диалог, JSON с settings + URL
  подписки + appRules (без кеша серверов и HWID).
- `nemefisto://import-from-url/{url}` — скачать JSON по ссылке.
- `nemefisto://import/{base64}` — импорт из inline base64.
- Перед применением — модалка с превью изменений.
- Whitelist полей: тема, фон, пресет, button-style, autoRefresh*,
  refresh/ping/connectOnOpen, sort, allowLan, anti-DPI группы,
  app-rules, URL подписки. **Без HWID, без localStorage-флагов.**

### 12.E — Маскировка имени TUN-адаптера (готово)
Toggle «маскировка TUN». Имя выбирается случайно из набора:
`wlan{99..199}` / `Local Area Connection {N}` / `Ethernet {N}`.

---

## Этап 13 — Что отличает «крепкий клиент» от «топового»

### 13.A — Системный трей + автоминимизация (готово)
Иконка статуса (red/yellow/green), контекстное меню, close→tray,
double-click→restore. `tauri-plugin-tray` через `app.tray()`.

### 13.B — Leak-test после connect (готово)
HTTP-запрос через системный прокси (Cloudflare cdn-trace + ipwho.is +
DoH whoami.cloudflare), toast «твой IP сейчас X (страна)». Auto-toggle
и manual button в Settings.

### 13.C — Smart auto-failover
Мониторим выбранный сервер: пинг каждые 30 сек или TCP-fail в логах.
Если пинг >3000мс на 30 сек подряд или TCP-disconnect → переключаемся
на следующий по пингу. Не работает если пользователь явно выбрал
конкретный сервер (опция «не переключать автоматически»).

### 13.D — Kill switch (готово, WFP-вариант)
Настоящий WFP kill switch с 5-уровневой защитой от orphan-фильтров:
DYNAMIC session + heartbeat watchdog (60s) + cleanup_on_startup +
Service Recovery (SCM failure actions) + emergency CLI. + A+B+E
hardening: per-interface allow-фильтр (Mullvad-style) + DNS leak
protection (PERMIT VPN-DNS:53 weight 15 > BLOCK :53 weight 9) +
ServiceFailureActions. + live-toggle через `kill_switch_apply`.

### 13.E — История сессий
Локальный лог connect/disconnect: timestamp, сервер, режим, длительность,
причина. SQLite `%LOCALAPPDATA%\NemefistoVPN\history.db` (через `rusqlite`).
UI: вкладка «история» в Settings.

### 13.F — Speed-test встроенный
Кнопка «измерить скорость через VPN». Скачивает 5–10 МБ с Cloudflare
speedtest endpoints, показывает Mbps. Опционально: автоматически раз в
неделю на всех серверах для smart-сортировки.

### 13.G — Per-app routing через WFP (Windows-native, без Mihomo)
WFP callout-driver перехватывает соединения по `process-id` напрямую от
ядра. Точно, мгновенно, работает с обоими движками. Реализация серьёзная
(~1 неделя): kernel-mode driver или user-mode WFP filter с callout
(crate `windivert-rs` / готовый подписанный `WinDivert`).

### 13.H — WebRTC + DNS leak protection
**DNS leak**: monitor DNS-traffic (через `pktmon` или WFP), assert что
все DNS-запросы идут через VPN. **WebRTC**: текстовая инструкция +
deep-link на `chrome://flags`. Браузерное расширение — вне scope.

### 13.I — Bandwidth-метр в реальном времени (готово)
`GetIfTable2` polling 1Hz + emit `bandwidth-tick` event.

### 13.J — Session passcode (Windows Hello)
Опция: при запуске требовать аутентификацию через Windows Hello.
Crate `windows-rs`, `UserConsentVerifier`.

### 13.K — Hysteria2 obfs salamander (готово)
Пакеты маскируются под мусор, DPI не видит QUIC. Учтено в build_hysteria2().

### 13.L — Mihomo built-in TUN-mode (готово)
Mihomo сам поднимает TUN через WinTUN (gVisor stack), не нужен отдельный
tun2socks. SYSTEM-spawn через helper (`nemefisto_helper/mihomo.rs`).

### 13.M — SSID-based auto-mode (готово)
Trusted Wi-Fi networks через `netsh wlan show interfaces` (с кириллицей).
При подключении к доверенной сети — auto-disconnect/direct.

### 13.N — Global shortcuts (готово)
`tauri-plugin-global-shortcut` — Ctrl+Shift+V toggle VPN, Ctrl+Shift+M
show/hide window и др.

### 13.O — Floating window (готово)
Мини-окно 190×52 alwaysOnTop с bandwidth meter и server-name. CSS scoped
через `.is-floating` class на `<html>`.

### 13.P — Слияние нескольких подписок
`subscriptionStore` хранит массив `Subscription[]`. При импорте —
добавляем, не заменяем. Каждый сервер помечается `source: <sub-id>`.
В UI server-list — group by source. *(частично закрыто multi-sub store
в 0.4.0)*

### 13.Q — Auto-grouping правил для пустых подписок
Если подписка не задаёт routing, применяем встроенный «минимальный»
шаблон: `geosite:ru` + `geoip:ru` → DIRECT, остальное → PROXY, реклама →
BLOCK. Опция в Settings (off по умолчанию).

### 13.R — TUN-only «strict mode»
Toggle скрывает выбор proxy-режима, оставляет только TUN. Для параноиков.

### 13.S — Kill-switch strict mode
Убирает общий `allow_app(xray.exe)`, оставляет только
`allow_app(...) on remote_ip in server_ips`. Тогда direct outbound к
ru.site блокируется WFP. Отдельный toggle: классический (default) /
строгий. UI показывает предупреждение про блокировку RU-direct.

---

## Этап 14 — Production-readiness

### 14.A — Auto-updater (готово)
`tauri-plugin-updater` + `tauri-plugin-process` для relaunch. Endpoint —
GitHub Releases `latest.json` (генерится в CI). ed25519-подпись (Tauri
signing key). installMode: passive.

### 14.B — Code signing ⚠️ НЕ СДЕЛАНО
Без подписи Windows SmartScreen ругается «Unknown publisher».
- **EV** (~$300-500/год) — мгновенный SmartScreen trust;
- **OV** (~$80-150/год) — нужно набрать репутацию;
- **Self-signed + AppX** (бесплатно) — ручное добавление сертификата.
Добавить signing-step в NSIS через `signtool.exe`, задокументировать в
`docs/RELEASE.md`, приватный ключ в HSM для EV.

### 14.C — Crash dump + диагностика
`std::panic::set_hook` → stacktrace в `%LOCALAPPDATA%\NemefistoVPN\crashes\`.
`tracing-rolling-file`. Опционально minidump через `minidump-writer`.
Без отправки на сервер.

### 14.D — IPv6 leak protection
В leak-test добавить v6-only endpoint (`api6.ipify.org`). Если v6
отвечает напрямую — toast warning. Протестить WFP block-all v6 end-to-end.
Опция «принудительно отключить IPv6».

### 14.E — Расширенный crash-recovery dialog
Показывать что именно обнаружено (stale PID / orphan WFP / orphan TUN)
и варианты: «восстановить прежнюю конфигурацию» / «начать с чистого
листа» / «оставить как есть».

### 14.F — Export logs для поддержки (готово)
Кнопка «выгрузить диагностику» → zip: stderr-логи, helper Event Log,
session_lock, версия клиента + Windows, proxy_backup.json, список
VPN-процессов. Без телеметрии.

### 14.G — First-run onboarding
Анимированный туториал (3-4 шага). Демо-подписка для теста (с диалогом).
Линк на сайт-источник подписок.

### 14.H — Privacy policy + License ⚠️
`PRIVACY.md` + `LICENSE` (MIT или GPLv3 — решить) + about-страница с
версией, sha-коммита, ссылкой на GitHub.

### 14.I — GitHub Releases workflow + CI (готово)
`.github/workflows/release.yml` — на push tag `v*` собирает NSIS,
подписывает, аплоадит. Auto-generated release notes.

### 14.J — i18n (опционально)
`react-i18next`. Структура `src/locales/{ru,en}/translation.json`.
Автодетект по `navigator.language`. *(инфраструктура i18next частично
подключена)*

### 14.K — Beta/Stable channels
После 14.A — опция канала обновлений. Endpoint поддерживает `?channel=beta`.

---

## Этап 15 — Кросс-платформенность

**Цель**: портирование на macOS, Linux, iOS, Android. Архитектура учитывает
это с этапа 0 (`#[cfg(windows)]` на платформо-зависимом коде, `platform/`
изолирован).

### 15.A — macOS порт
- `helper_client.rs` — Unix domain sockets вместо named pipe;
- `proxy.rs` — `networksetup -setsocksfirewallproxy`;
- `network.rs` — `route -n get default`;
- `network_watcher.rs` — `SystemConfiguration` framework;
- `processes.rs` — `sysctl kern.proc.all` + `proc_pidpath`;
- `tray.rs` — `NSStatusBar` через `cocoa`;
- helper — `launchd`; TUN — `utun` через `tun-rs`;
- WFP-аналог — `pfctl`. Самое сложное: kill-switch (нужна network
  extension, Apple Developer $99/год). Effort: ~2-3 недели.

### 15.B — Linux порт
- Unix domain sockets; `gsettings`/`kwriteconfig`/env-vars для proxy;
- `ip route show default` / netlink; `rtnetlink` для watcher;
- `/proc/<pid>/comm`; `tray-icon` crate; `systemd` unit / polkit;
- TUN — `/dev/net/tun`; kill-switch — `iptables`/`nftables`.
- Effort: ~2 недели.

### 15.C — iOS порт
React-фронт через WKWebView, core как `NetworkExtension`. xray-core под
iOS. App Store review нужно обоснование. Effort: ~1 месяц + Apple account.

### 15.D — Android порт
Tauri Mobile (бета) или native Kotlin + WebView. VpnService API для TUN.
Material Design. Effort: ~3-4 недели.

**Приоритет**: macOS → Linux → Android → iOS.

---

## Посессионные варианты (исторические заметки по планированию)

**Variant A — трей + leak-test** (готово: 13.A + 13.B).
**Variant B — UX-полировка** (готово: 12.A, 12.C, 12.D частично, 9.B).
**Variant C — Mihomo-движок** (готово: 8.B, 8.D; 13.L done).
**Variant D — Routing-профили** (11.A…11.G — НЕ сделано).
**Variant E — quick wins**.
**Variant F — фишки от конкурентов** (готово: 13.M, 13.N, 13.B).
**Variant G — Floating window** (готово: 13.O).

---

## Идеи из сравнения с другими клиентами

**dropweb** (форк FlClashX, mihomo-only):
- Рандомизация портов — взяли (9.H ✅).
- TUN-only «strict mode» — 13.R (низкий приоритет).
- Mihomo-only — было «не наш путь», но пересматривается (см. CLAUDE.md).

**koala-clash** (Electron + mihomo, 551 ⭐):
- SSID auto-mode — 13.M ✅. Global shortcuts — 13.N ✅.
- Floating window — 13.O ✅. Multiple cores — 8.B ✅.

**Prizrak-Box** (Vue + Wails, mihomo-only, 229 ⭐):
- Слияние подписок — 13.P (частично). Auto-grouping — 13.Q.
- Mieru протокол — только Mihomo. DNS rewrite — частично через DoH (10.C).
