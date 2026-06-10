//! Генерация YAML-конфига Mihomo (Clash Meta) из ProxyEntry — этап 8.B.
//!
//! Симметричен `xray_config.rs`. Возвращает готовую YAML-строку, которая
//! записывается в `%TEMP%\KwikVPN\mihomo-config.yaml` и подсовывается
//! Mihomo через `-f <file>`.
//!
//! Поддерживаемые протоколы: всё что умеет Mihomo — vless / vmess / trojan /
//! ss / socks5 / hysteria2 / tuic / wireguard / anytls / mieru.
//!
//! Anti-DPI:
//! - **fragmentation / noises** Mihomo не имеет — игнорируем (UI скрывает
//!   эти секции при `engine = mihomo`);
//! - **server-resolve через DoH** реализуем через `dns.nameserver` (DoH
//!   endpoint) + `dns.default-nameserver` (bootstrap IP).
//!
//! Routing на v1: единое правило `MATCH,PROXY` (всё через прокси), как
//! сейчас в Xray-конфиге. Routing-профили из этапа 11 добавляются позже.
//!
//! Engine API control (HTTP API на 127.0.0.1:9090) включаем с случайным
//! `secret`-паролем — на v1 не используется, но открывает дорогу для
//! 13.I bandwidth-метра и smart auto-failover (13.C).

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};

use super::server::ProxyEntry;

/// Опции анти-DPI обвязки. Приходят из фронта через `connect()`.
///
/// Mihomo нативно поддерживает только server-resolve через DoH
/// (`dns.nameserver` + bootstrap). Поля `fragmentation*` / `noises*`
/// Mihomo не умеет — они игнорируются (UI скрывает эти секции для
/// текущего движка). Поля сохранены в структуре для совместимости
/// IPC-контракта с фронтом.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntiDpiOptions {
    pub fragmentation: bool,
    pub fragmentation_packets: String,
    pub fragmentation_length: String,
    pub fragmentation_interval: String,
    pub noises: bool,
    pub noises_type: String,
    pub noises_packet: String,
    pub noises_delay: String,
    pub server_resolve: bool,
    pub server_resolve_doh: String,
    pub server_resolve_bootstrap: String,
}

/// Mux (multiplexing) — устаревшая опция от sing-box-движка.
///
/// Mihomo не использует этот блок (мультиплексирование настраивается
/// в самом proxy-конфиге YAML). Структура сохранена только для
/// совместимости IPC-контракта `connect()` — фронт может прислать
/// поле `mux`, мы его молча игнорируем.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MuxOptions {
    pub enabled: bool,
    pub protocol: String,
    pub max_streams: u32,
}

/// Per-process routing rule (этап 8.D). Принимается из фронта через
/// `connect()` и транслируется в Mihomo `PROCESS-NAME,<exe>,<action>`.
///
/// Frontend кладёт массив таких объектов в payload `connect`; serde
/// разбирает поля через camelCase rename. Xray-движок игнорирует
/// эти правила (UI предупреждает заранее).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppRule {
    pub exe: String,
    /// `"proxy"` | `"direct"` | `"block"` — мапится в `PROXY` / `DIRECT` /
    /// `REJECT` правил Mihomo соответственно.
    pub action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

/// Результат генерации: YAML-текст + порт `mixed-port` (SOCKS5 + HTTP).
pub struct MihomoConfig {
    pub yaml: String,
    pub mixed_port: u16,
}

/// Построить mihomo-конфиг для одного сервера.
///
/// `listen` — `127.0.0.1` (loopback) или `0.0.0.0` (LAN).
/// `socks_auth` — `Some((user, pass))` если включён auth для inbound (9.G);
/// иначе `None` (proxy-режим на loopback, без аутентификации).
/// `app_rules` — per-process правила (этап 8.D); пустой slice = no-op.
#[allow(clippy::too_many_arguments)] // аргументы зеркалят поля wire-протокола/конфига — структура здесь не упростит вызовы
pub fn build(
    entry: &ProxyEntry,
    mixed_port: u16,
    listen: &str,
    anti_dpi: Option<&AntiDpiOptions>,
    socks_auth: Option<(&str, &str)>,
    app_rules: &[AppRule],
    routing_profile: Option<&super::routing_profile::RoutingProfile>,
    // 13.L + TUN-для-URI: если `true`, добавляем `tun:` секцию — mihomo
    // сам поднимает WinTUN-адаптер для URI/base64-серверов (раньше TUN
    // работал только для full mihomo-profile подписок).
    use_builtin_tun: bool,
    // 12.E маскировка имени TUN-адаптера. `Some(name)` → `tun.device`
    // ставится в замаскированное имя (`wlan99` / `Ethernet 7` и т.п.);
    // `None` → mihomo default (kill-switch детектит по Description/IP).
    tun_device: Option<&str>,
    // #4: разрешить IPv6 (root + dns). По умолчанию false (анти-leak).
    ipv6: bool,
    // #3: пользовательские DNS-серверы из настроек (высший приоритет для
    // `nameserver`). Пустой/None → дефолтная логика (профиль/anti-DPI/DoH).
    custom_dns: Option<&[String]>,
    // external-controller для mihomo_api (тот же порт/secret, что connect
    // сохраняет в MihomoApiState — иначе UI/статистика не достучатся).
    external_controller_port: u16,
    external_controller_secret: &str,
) -> Result<MihomoConfig> {
    let proxy = proxy_for_entry(entry)
        .with_context(|| format!("не удалось собрать mihomo-proxy для «{}»", entry.name))?;

    // Имя для proxy внутри Mihomo-конфига должно быть стабильным и не
    // конфликтовать с зарезервированными "DIRECT" / "REJECT" / "PROXY".
    let proxy_name = "VPN-NODE".to_string();
    let mut proxy_map = proxy;
    proxy_map.insert("name".into(), proxy_name.clone().into());

    let mut root = Mapping::new();

    // ── Inbound ──────────────────────────────────────────────────────
    root.insert("mixed-port".into(), (mixed_port as u64).into());
    root.insert("allow-lan".into(), (listen == "0.0.0.0").into());
    root.insert("bind-address".into(), listen.to_string().into());

    // 9.G: SOCKS5 auth для TUN/LAN. Mihomo принимает массив строк
    // вида "user:pass". Если auth не задан — секция отсутствует.
    if let Some((user, pass)) = socks_auth {
        let mut auth = Vec::new();
        auth.push(Value::from(format!("{user}:{pass}")));
        root.insert("authentication".into(), Value::Sequence(auth));
    }

    // ── Базовое поведение ────────────────────────────────────────────
    root.insert("mode".into(), "rule".into());
    root.insert("log-level".into(), "info".into());
    root.insert("ipv6".into(), ipv6.into());

    // 11.B: используем v2ray `.dat` geo-базы (geofiles::provision_into
    // кладёт их в data-dir). Авто-обновление выключено — geofiles тянет
    // scheduler по интервалу профиля, без сюрприз-загрузок при connect.
    root.insert("geodata-mode".into(), true.into());
    root.insert("geo-auto-update".into(), false.into());

    // #7: tcp-concurrent — happy-eyeballs (параллельные попытки к
    // нескольким IP домена, берём первый успешный → быстрее коннект);
    // unified-delay — единая методика замера задержки (честный пинг в UI).
    root.insert("tcp-concurrent".into(), true.into());
    root.insert("unified-delay".into(), true.into());

    // #2: глобальный uTLS-отпечаток ClientHello. Маскирует TLS-handshake
    // под Chrome (анти-DPI, 10.x). Применяется только к нодам БЕЗ своего
    // `client-fingerprint` — per-proxy значение из подписки приоритетнее.
    root.insert("global-client-fingerprint".into(), "chrome".into());

    // #8: помнить выбранную ноду и fake-ip кеш между рестартами (cache.db
    // в data-dir). store-selected — выбор в proxy-group; store-fake-ip —
    // стабильные fake-ip, чтобы приложения не теряли соединения после
    // рестарта ядра.
    let mut profile_persist = Mapping::new();
    profile_persist.insert("store-selected".into(), true.into());
    profile_persist.insert("store-fake-ip".into(), true.into());
    root.insert("profile".into(), Value::Mapping(profile_persist));

    // 8.D: per-process routing требует `find-process-mode: always` —
    // Mihomo при каждом новом соединении проверяет какой процесс его
    // создал (через WMI / iptables-conntrack lookup на других ОС).
    // Включаем только если правила непустые — иначе лишний overhead.
    if !app_rules.is_empty() {
        root.insert("find-process-mode".into(), "always".into());
    }

    // External controller — для mihomo_api (proxies/connections/delay).
    // Порт и secret приходят из connect() и совпадают с тем, что
    // сохраняется в MihomoApiState, — иначе UI/статистика не достучатся.
    root.insert(
        "external-controller".into(),
        format!("127.0.0.1:{external_controller_port}").into(),
    );
    root.insert(
        "secret".into(),
        external_controller_secret.to_string().into(),
    );

    // ── DNS ──────────────────────────────────────────────────────────
    // Включаем всегда, чтобы предотвратить DNS-leak (аналог Prizrak-Box
    // DNS rewrite). При активном anti-DPI server-resolve — берём DoH
    // и bootstrap из настроек, иначе разумные дефолты.
    root.insert(
        "dns".into(),
        Value::Mapping(build_dns(anti_dpi, routing_profile, ipv6, custom_dns)),
    );

    // #1: sniffer — определяет реальный домен из SNI (TLS) / Host (HTTP) /
    // QUIC, даже когда приложение ходит по «голому» IP или через fake-ip.
    // Без него правила DOMAIN/GEOSITE и per-app промахиваются по
    // IP-трафику, а fake-ip (11.E) теряет смысл.
    root.insert("sniffer".into(), Value::Mapping(build_sniffer()));

    // ── Proxies / proxy-groups / rules ───────────────────────────────
    root.insert(
        "proxies".into(),
        Value::Sequence(vec![Value::Mapping(proxy_map)]),
    );

    let mut group = Mapping::new();
    group.insert("name".into(), "PROXY".into());
    group.insert("type".into(), "select".into());
    group.insert(
        "proxies".into(),
        Value::Sequence(vec![Value::String(proxy_name)]),
    );
    root.insert(
        "proxy-groups".into(),
        Value::Sequence(vec![Value::Mapping(group)]),
    );

    // 8.D: per-process правила (если заданы) идут перед routing-профилем
    // и MATCH'ем — чтобы перехватить трафик конкретных процессов
    // первыми. Action нормализуется: proxy→PROXY, direct→DIRECT,
    // block→REJECT.
    let mut rules: Vec<Value> = Vec::new();
    for r in app_rules {
        if let Some(rule) = app_rule_to_mihomo(r) {
            rules.push(Value::String(rule));
        }
    }

    // 11.F: правила из routing-профиля. block — первый (override любого
    // direct/proxy), потом direct, потом proxy. После — MATCH с дефолтом
    // от GlobalProxy.
    let default_action = if let Some(p) = routing_profile {
        // URI-путь: outbound — proxy-group с именем "PROXY" (см. выше),
        // поэтому target для proxy-правил — литерал "PROXY".
        for r in mihomo_rules_from_profile(p, "PROXY") {
            rules.push(Value::String(r));
        }
        if p.global_proxy.0 { "PROXY" } else { "DIRECT" }
    } else {
        "PROXY"
    };
    // Базовые DIRECT для приватных/локальных диапазонов — ПЕРЕД MATCH, чтобы
    // LAN/loopback/link-local не уходили в туннель (иначе со `strict-route`
    // недоступны роутер/принтеры/локалка). Профильные explicit-правила выше
    // приоритетнее (могут переопределить конкретный адрес).
    for r in local_direct_rules() {
        rules.push(Value::String(r));
    }
    rules.push(Value::String(format!("MATCH,{default_action}")));
    root.insert("rules".into(), Value::Sequence(rules));

    // ── tun (13.L + TUN-для-URI) ──────────────────────────────────────
    // Для URI/base64-серверов раньше TUN был недоступен (только proxy).
    // Теперь, если запрошен built-in TUN, синтезируем минимально-рабочую
    // секцию: mihomo сам создаёт WinTUN, ставит маршруты, hijack'ает DNS.
    if use_builtin_tun {
        root.insert("tun".into(), Value::Mapping(builtin_tun_mapping(tun_device)));
    }

    let yaml = serde_yaml::to_string(&Value::Mapping(root))
        .context("сериализация mihomo YAML")?;

    Ok(MihomoConfig { yaml, mixed_port })
}

/// 13.L + 12.E: собрать `tun:` секцию для built-in TUN-режима mihomo.
///
/// `device` — кастомное имя WinTUN-адаптера (12.E маскировка). `None` →
/// mihomo default (`Meta`); kill-switch тогда детектит адаптер по
/// Description/IP, а не по alias.
///
/// `dns-hijack: any:53` обязателен в TUN-режиме — без него DNS-запросы
/// приложений уходят мимо нашего DNS и могут утечь (DNS leak). С ним
/// mihomo перехватывает весь :53-трафик на TUN-интерфейсе.
fn builtin_tun_mapping(device: Option<&str>) -> Mapping {
    let mut tun = Mapping::new();
    tun.insert("enable".into(), true.into());
    tun.insert("stack".into(), "mixed".into());
    tun.insert("auto-route".into(), true.into());
    tun.insert("auto-detect-interface".into(), true.into());
    // #3: strict-route — mihomo ставит файрвол-правила, чтобы НИ один пакет
    // не ушёл мимо TUN (анти-leak). Дополняет WFP kill switch (13.D).
    tun.insert("strict-route".into(), true.into());
    // route-exclude-address: приватные/link-local диапазоны НЕ заворачиваем
    // в TUN — идут штатной OS-маршрутизацией (LAN/роутер доступны даже при
    // strict-route). Резолв этих IP в DIRECT добавлен правилами отдельно.
    tun.insert(
        "route-exclude-address".into(),
        Value::Sequence(vec![
            "10.0.0.0/8".into(),
            "172.16.0.0/12".into(),
            "192.168.0.0/16".into(),
            "169.254.0.0/16".into(),
            "fc00::/7".into(),
            "fe80::/10".into(),
        ]),
    );
    tun.insert(
        "dns-hijack".into(),
        Value::Sequence(vec!["any:53".into()]),
    );
    if let Some(dev) = device {
        tun.insert("device".into(), dev.into());
    }
    tun
}

/// 12.E: сгенерировать замаскированное имя TUN-адаптера.
///
/// Имя выбирается псевдослучайно из набора, имитирующего стандартные
/// сетевые адаптеры Windows — чтобы сторонний процесс при перечислении
/// интерфейсов не распознал VPN-туннель по характерному имени
/// (`Mihomo` / `kwik-*`). Угроза: https://habr.com/ru/news/1020902/.
///
/// Наборы: `wlan{99..198}`, `Local Area Connection {2..16}`,
/// `Ethernet {2..16}`. Энтропия — наносекунды (как в `random_high_port`),
/// криптостойкость не требуется.
pub fn masked_tun_name() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    match nanos % 3 {
        0 => format!("wlan{}", 99 + (nanos / 3) % 100),
        1 => format!("Local Area Connection {}", 2 + (nanos / 3) % 15),
        _ => format!("Ethernet {}", 2 + (nanos / 3) % 15),
    }
}

/// 11.F: преобразовать правила routing-профиля в Mihomo-формат строк.
///
/// Маппинг:
/// - `geosite:ru` → `GEOSITE,ru,DIRECT`
/// - `geoip:ru` → `GEOIP,ru,DIRECT,no-resolve`
/// - `1.2.3.4/24` или `::1/128` → `IP-CIDR,...,DIRECT,no-resolve`
/// - конкретный IP без / → `IP-CIDR,IP/32,...,no-resolve`
/// - домен типа `example.com` → `DOMAIN-SUFFIX,example.com,DIRECT`
/// - `*.example.com` → `DOMAIN-SUFFIX,example.com,DIRECT`
/// - `keyword:word` → `DOMAIN-KEYWORD,word,DIRECT`
///
/// `proxy_target` — имя outbound'а для proxy-правил. В URI-пути это
/// литерал `"PROXY"` (group, который мы сами создаём); в full-profile
/// passthrough — имя провайдерской группы из `MATCH`/`FINAL` (детектится
/// в `detect_proxy_target`), чтобы правила не указывали на несуществующий
/// outbound и mihomo их не отбрасывал.
///
/// Order: block → direct → proxy (block перебивает остальное).
fn mihomo_rules_from_profile(
    p: &super::routing_profile::RoutingProfile,
    proxy_target: &str,
) -> Vec<String> {
    let mut out = Vec::new();
    push_site_rules(&mut out, &p.block_sites, "REJECT");
    push_ip_rules(&mut out, &p.block_ip, "REJECT");
    push_site_rules(&mut out, &p.direct_sites, "DIRECT");
    push_ip_rules(&mut out, &p.direct_ip, "DIRECT");
    push_site_rules(&mut out, &p.proxy_sites, proxy_target);
    push_ip_rules(&mut out, &p.proxy_ip, proxy_target);
    out
}

/// 11.F (full-profile): определить имя outbound-группы для proxy-правил
/// активного профиля. Стратегия — повторно использовать ту группу, в
/// которую провайдер сам направляет дефолтный трафик:
///
///  1. `MATCH,<group>` / `FINAL,<group>` из провайдерских `rules` —
///     это «куда уходит всё непойманное», самый надёжный сигнал;
///  2. иначе — имя первой `proxy-groups[].name`;
///  3. иначе — встроенная mihomo-группа `GLOBAL` (есть всегда).
fn detect_proxy_target(root: &Mapping) -> String {
    if let Some(Value::Sequence(rules)) = root.get("rules") {
        for r in rules {
            let Some(s) = r.as_str() else { continue };
            let mut parts = s.splitn(3, ',');
            let head = parts.next().unwrap_or("").trim().to_uppercase();
            if head == "MATCH" || head == "FINAL" {
                if let Some(t) = parts.next().map(str::trim) {
                    if !t.is_empty() {
                        return t.to_string();
                    }
                }
            }
        }
    }
    if let Some(Value::Sequence(groups)) = root.get("proxy-groups") {
        if let Some(name) = groups
            .first()
            .and_then(|g| g.get("name"))
            .and_then(|v| v.as_str())
        {
            return name.to_string();
        }
    }
    "GLOBAL".to_string()
}

/// 8.D / #5: одно app-rule → строка правила mihomo. Если `exe` содержит
/// разделитель пути (`\` или `/`) — матчим по полному пути (`PROCESS-PATH`,
/// различает два разных exe с одним именем), иначе по имени (`PROCESS-NAME`).
/// `action`: proxy→PROXY / direct→DIRECT / block→REJECT. `None` если exe пуст.
fn app_rule_to_mihomo(r: &AppRule) -> Option<String> {
    let exe = r.exe.trim();
    if exe.is_empty() {
        return None;
    }
    let target = match r.action.as_str() {
        "direct" => "DIRECT",
        "block" => "REJECT",
        _ => "PROXY",
    };
    let matcher = if exe.contains('\\') || exe.contains('/') {
        "PROCESS-PATH"
    } else {
        "PROCESS-NAME"
    };
    Some(format!("{matcher},{exe},{target}"))
}

/// Базовые DIRECT-правила для loopback / приватных / link-local /
/// multicast диапазонов. Нужны чтобы локальный трафик не уходил в туннель
/// (особенно со `strict-route`). `no-resolve` — не резолвим домен в IP.
fn local_direct_rules() -> Vec<String> {
    [
        "IP-CIDR,127.0.0.0/8,DIRECT,no-resolve",
        "IP-CIDR,10.0.0.0/8,DIRECT,no-resolve",
        "IP-CIDR,172.16.0.0/12,DIRECT,no-resolve",
        "IP-CIDR,192.168.0.0/16,DIRECT,no-resolve",
        "IP-CIDR,169.254.0.0/16,DIRECT,no-resolve",
        "IP-CIDR,224.0.0.0/4,DIRECT,no-resolve",
        "IP-CIDR6,::1/128,DIRECT,no-resolve",
        "IP-CIDR6,fc00::/7,DIRECT,no-resolve",
        "IP-CIDR6,fe80::/10,DIRECT,no-resolve",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

fn push_site_rules(out: &mut Vec<String>, sites: &[String], action: &str) {
    for s in sites {
        let s = s.trim();
        if s.is_empty() {
            continue;
        }
        if let Some(rest) = s.strip_prefix("geosite:") {
            out.push(format!("GEOSITE,{rest},{action}"));
        } else if let Some(rest) = s.strip_prefix("keyword:") {
            out.push(format!("DOMAIN-KEYWORD,{rest},{action}"));
        } else if let Some(rest) = s.strip_prefix("*.") {
            out.push(format!("DOMAIN-SUFFIX,{rest},{action}"));
        } else if let Some(rest) = s.strip_prefix("regex:") {
            // #4: mihomo умеет DOMAIN-REGEX — раньше ошибочно скипали.
            out.push(format!("DOMAIN-REGEX,{rest},{action}"));
        } else if let Some(rest) = s.strip_prefix("domain:") {
            out.push(format!("DOMAIN,{rest},{action}"));
        } else if s.contains('.') {
            // Простой domain — DOMAIN-SUFFIX (включает все subdomains)
            out.push(format!("DOMAIN-SUFFIX,{s},{action}"));
        } else {
            // Без точки — обрабатываем как DOMAIN-KEYWORD
            out.push(format!("DOMAIN-KEYWORD,{s},{action}"));
        }
    }
}

fn push_ip_rules(out: &mut Vec<String>, ips: &[String], action: &str) {
    for s in ips {
        let s = s.trim();
        if s.is_empty() {
            continue;
        }
        if let Some(rest) = s.strip_prefix("geoip:") {
            out.push(format!("GEOIP,{rest},{action},no-resolve"));
        } else if s.contains('/') {
            // Уже CIDR
            let kind = if s.contains(':') { "IP-CIDR6" } else { "IP-CIDR" };
            out.push(format!("{kind},{s},{action},no-resolve"));
        } else if let Ok(addr) = s.parse::<std::net::IpAddr>() {
            // Конкретный IP без префикса — добавляем /32 или /128
            let suffix = if addr.is_ipv6() { "/128" } else { "/32" };
            let kind = if addr.is_ipv6() { "IP-CIDR6" } else { "IP-CIDR" };
            out.push(format!("{kind},{s}{suffix},{action},no-resolve"));
        } else {
            eprintln!("[mihomo-rules] невалидный IP/CIDR, skip: {s}");
        }
    }
}

/// 11.E: собрать DNS-секцию mihomo с раздельным резолвом (split-DNS).
///
/// Идея: *куда трафик идёт — оттуда и резолв*. Проксируемые домены
/// резолвятся удалённым DoH (без leak'а и подмены провайдером), а direct
/// (`DirectSites`, обычно `geosite:ru`) — местным DNS (правильные CDN-IP).
///
/// Источники с приоритетом **профиль → anti-DPI (10.C) → дефолты**:
///  - `nameserver` (общий резолвер) ← `RemoteDNS` профиля / DoH anti-DPI /
///    Cloudflare+Google;
///  - `default-nameserver` (bootstrap, только plain-IP для резолва самого
///    DoH-хоста) ← `RemoteDNSIP` / anti-DPI bootstrap / 1.1.1.1+8.8.8.8;
///  - `nameserver-policy` (per-zone override) ← `DomesticDNS` для зон из
///    `DirectSites` (geosite/домены);
///  - `hosts` ← `DnsHosts` профиля;
///  - `enhanced-mode: fake-ip` если `FakeDNS=true` (+ `fake-ip-filter` с
///    direct-зонами и локальными именами, чтобы им выдавался реальный IP).
fn build_dns(
    anti_dpi: Option<&AntiDpiOptions>,
    profile: Option<&super::routing_profile::RoutingProfile>,
    ipv6: bool,
    custom_dns: Option<&[String]>,
) -> Mapping {
    let mut dns = Mapping::new();
    dns.insert("enable".into(), true.into());
    dns.insert("listen".into(), "0.0.0.0:0".into()); // не открываем DNS-сервер наружу
    dns.insert("ipv6".into(), ipv6.into());

    // ── enhanced-mode + fake-ip ───────────────────────────────────────
    let fake = profile.map(|p| p.fake_dns.0).unwrap_or(false);
    if fake {
        dns.insert("enhanced-mode".into(), "fake-ip".into());
        dns.insert("fake-ip-range".into(), "198.18.0.1/16".into());
        // fake-ip-filter: эти имена должны получать НАСТОЯЩИЙ IP (не
        // fake) — локальные + direct-зоны профиля (они идут мимо прокси).
        let mut filter: Vec<Value> = vec![
            "+.lan".into(),
            "+.local".into(),
            "localhost".into(),
            "*.localdomain".into(),
            "time.*.com".into(),
        ];
        if let Some(p) = profile {
            for k in dns_policy_keys(&p.direct_sites) {
                filter.push(k.into());
            }
        }
        dns.insert("fake-ip-filter".into(), Value::Sequence(filter));
    } else {
        dns.insert("enhanced-mode".into(), "redir-host".into());
    }

    // ── remote nameserver + bootstrap ─────────────────────────────────
    let dpi_resolve = anti_dpi.map(|d| d.server_resolve).unwrap_or(false);
    // #3: пользовательский DNS из настроек — высший приоритет (юзер явно
    // выбрал «использовать мой DNS»). Пустые строки отфильтровываем.
    let custom: Option<Vec<Value>> = custom_dns.and_then(|d| {
        let v: Vec<Value> = d
            .iter()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| Value::from(s.to_string()))
            .collect();
        (!v.is_empty()).then_some(v)
    });
    // Общий резолвер: custom > профиль > anti-DPI DoH > дефолт-DoH.
    let remote = custom
        .clone()
        .or_else(|| {
            profile
                .and_then(|p| profile_dns_addr(&p.remote_dns_domain, &p.remote_dns_ip))
                .map(|s| vec![Value::from(s)])
        })
        .or_else(|| {
            if dpi_resolve {
                anti_dpi
                    .map(|d| vec![Value::from(d.server_resolve_doh.clone())])
                    .filter(|v| v.first().and_then(|x| x.as_str()).is_some_and(|s| !s.is_empty()))
            } else {
                None
            }
        })
        .unwrap_or_else(|| {
            vec![
                "https://cloudflare-dns.com/dns-query".into(),
                "https://dns.google/dns-query".into(),
            ]
        });
    // Bootstrap (plain-IP): профиль RemoteDNSIP > anti-DPI bootstrap > дефолт.
    let bootstrap = profile
        .map(|p| p.remote_dns_ip.trim())
        .filter(|s| s.parse::<std::net::IpAddr>().is_ok())
        .map(|s| vec![Value::from(s)])
        .or_else(|| {
            if dpi_resolve {
                anti_dpi
                    .map(|d| d.server_resolve_bootstrap.trim())
                    .filter(|s| s.parse::<std::net::IpAddr>().is_ok())
                    .map(|s| vec![Value::from(s)])
            } else {
                None
            }
        })
        .unwrap_or_else(|| vec!["1.1.1.1".into(), "8.8.8.8".into()]);
    dns.insert("default-nameserver".into(), Value::Sequence(bootstrap));
    dns.insert("nameserver".into(), Value::Sequence(remote.clone()));

    // respect-rules: DNS-запросы следуют routing-правилам — проксируемые
    // домены резолвятся ВНУТРИ туннеля (провайдер/DPI не видит их),
    // direct — напрямую. proxy-server-nameserver резолвит хосты самих нод
    // (чистым DoH, мимо fake-ip/policy) — иначе петля «чтобы поднять
    // прокси, нужен прокси». Без него respect-rules не имеет смысла.
    dns.insert("respect-rules".into(), true.into());
    dns.insert("proxy-server-nameserver".into(), Value::Sequence(remote));

    // #5: fallback + fallback-filter — анти-подмена DNS. Если ответ
    // основного резолвера не проходит фильтр (не-RU IP, где ожидался RU,
    // либо зарезервированный диапазон) — берём чистый DoH-фолбэк. Это
    // ловит DNS-poisoning от провайдера/DPI на спорных доменах.
    dns.insert(
        "fallback".into(),
        Value::Sequence(vec![
            "https://dns.google/dns-query".into(),
            "tls://1.1.1.1:853".into(),
        ]),
    );
    let mut ff = Mapping::new();
    ff.insert("geoip".into(), true.into());
    ff.insert("geoip-code".into(), "RU".into());
    // CGNAT/зарезервированные — частый признак заглушки-подмены.
    ff.insert(
        "ipcidr".into(),
        Value::Sequence(vec!["240.0.0.0/4".into(), "0.0.0.0/32".into()]),
    );
    dns.insert("fallback-filter".into(), Value::Mapping(ff));

    // ── domestic split (nameserver-policy) + hosts ────────────────────
    if let Some(p) = profile {
        if let Some(domestic) = profile_dns_addr(&p.domestic_dns_domain, &p.domestic_dns_ip) {
            let keys = dns_policy_keys(&p.direct_sites);
            if !keys.is_empty() {
                let mut policy = Mapping::new();
                for k in keys {
                    policy.insert(k.into(), Value::Sequence(vec![domestic.clone().into()]));
                }
                dns.insert("nameserver-policy".into(), Value::Mapping(policy));
            }
        }
        if !p.dns_hosts.is_empty() {
            let mut hosts = Mapping::new();
            for (host, ip) in &p.dns_hosts {
                hosts.insert(host.clone().into(), ip.clone().into());
            }
            dns.insert("hosts".into(), Value::Mapping(hosts));
        }
    }
    dns
}

/// 11.E: выбрать адрес DNS-сервера для mihomo из пары (domain, ip)
/// Marzban-профиля. `domain` приоритетнее — он несёт полную форму
/// (`https://...` DoH, `tls://...` DoT, или plain-адрес); `ip` — fallback.
/// `None` если оба пусты.
fn profile_dns_addr(domain: &str, ip: &str) -> Option<String> {
    let d = domain.trim();
    if !d.is_empty() {
        return Some(d.to_string());
    }
    let i = ip.trim();
    if !i.is_empty() {
        return Some(i.to_string());
    }
    None
}

/// 11.E: преобразовать `DirectSites`-зоны в ключи `nameserver-policy` /
/// `fake-ip-filter` mihomo. Поддерживаются geosite/домены/суффиксы;
/// `keyword:`/голые слова пропускаем (policy не матчит по keyword).
fn dns_policy_keys(sites: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for s in sites {
        let s = s.trim();
        if s.is_empty() {
            continue;
        }
        if let Some(r) = s.strip_prefix("geosite:") {
            out.push(format!("geosite:{r}"));
        } else if s.starts_with("keyword:") {
            // nameserver-policy не умеет keyword-матчинг — пропускаем.
        } else if let Some(r) = s.strip_prefix("*.") {
            out.push(format!("+.{r}"));
        } else if let Some(r) = s.strip_prefix("domain:") {
            out.push(r.to_string());
        } else if s.contains('.') {
            // Голый домен → суффикс (как DOMAIN-SUFFIX в правилах).
            out.push(format!("+.{s}"));
        }
    }
    out
}

/// 11.E (full-profile): аддитивно домержить DNS активного профиля в
/// провайдерскую `dns:` секцию — только `hosts` и `nameserver-policy`
/// для direct-зон. Общий `nameserver` / `enhanced-mode` провайдера НЕ
/// трогаем (его выбор — источник истины). Если `dns:` секции нет —
/// пропускаем (не фабрикуем, чтобы не сломать резолв провайдера).
fn merge_profile_dns(root: &mut Mapping, profile: &super::routing_profile::RoutingProfile) {
    let Some(dns) = root
        .get_mut(Value::String("dns".into()))
        .and_then(|v| v.as_mapping_mut())
    else {
        return;
    };
    // hosts: мёрж, профиль приоритетнее при коллизии ключа.
    if !profile.dns_hosts.is_empty() {
        let hosts = dns
            .entry(Value::String("hosts".into()))
            .or_insert_with(|| Value::Mapping(Mapping::new()));
        if let Some(h) = hosts.as_mapping_mut() {
            for (k, v) in &profile.dns_hosts {
                h.insert(k.clone().into(), v.clone().into());
            }
        }
    }
    // nameserver-policy для domestic-зон: добавляем только отсутствующие
    // ключи — провайдерскую политику для того же домена не перетираем.
    if let Some(domestic) = profile_dns_addr(&profile.domestic_dns_domain, &profile.domestic_dns_ip)
    {
        let keys = dns_policy_keys(&profile.direct_sites);
        if !keys.is_empty() {
            let pol = dns
                .entry(Value::String("nameserver-policy".into()))
                .or_insert_with(|| Value::Mapping(Mapping::new()));
            if let Some(p) = pol.as_mapping_mut() {
                for k in keys {
                    p.entry(Value::String(k))
                        .or_insert_with(|| Value::Sequence(vec![domestic.clone().into()]));
                }
            }
        }
    }
}

/// #1: секция `sniffer` — извлечение реального домена из трафика.
///
/// `override-destination: true` — подменяем dst на заснифанный домен, чтобы
/// domain-правила и per-app сработали даже по IP/fake-ip. `force-dns-mapping`
/// и `parse-pure-ip` — сниффим и «голый» IP-трафик. `skip-domain` — то, что
/// ломается от подмены (Apple push). Порты заданы для TLS/HTTP/QUIC.
fn build_sniffer() -> Mapping {
    let mut s = Mapping::new();
    s.insert("enable".into(), true.into());
    s.insert("override-destination".into(), true.into());
    s.insert("force-dns-mapping".into(), true.into());
    s.insert("parse-pure-ip".into(), true.into());

    let mut sniff = Mapping::new();
    let mut tls = Mapping::new();
    tls.insert(
        "ports".into(),
        Value::Sequence(vec![443.into(), 8443.into()]),
    );
    let mut http = Mapping::new();
    http.insert(
        "ports".into(),
        Value::Sequence(vec![80.into(), Value::from("8080-8880")]),
    );
    // HTTP без override-destination — plaintext Host часто врёт за CDN.
    http.insert("override-destination".into(), false.into());
    let mut quic = Mapping::new();
    quic.insert("ports".into(), Value::Sequence(vec![443.into()]));
    sniff.insert("TLS".into(), Value::Mapping(tls));
    sniff.insert("HTTP".into(), Value::Mapping(http));
    sniff.insert("QUIC".into(), Value::Mapping(quic));
    s.insert("sniff".into(), Value::Mapping(sniff));

    s.insert(
        "skip-domain".into(),
        Value::Sequence(vec!["+.push.apple.com".into()]),
    );
    s
}

// ─── Per-protocol mappers ────────────────────────────────────────────────────

/// Главная точка входа: переводит `ProxyEntry` в один YAML-mapping в
/// формате mihomo. Для записей из clash YAML — passthrough; для записей
/// из URI-парсеров — собираем поля по протоколу.
fn proxy_for_entry(entry: &ProxyEntry) -> Result<Mapping> {
    // Записи из clash YAML кладут в `raw` всё mapping подряд, включая
    // топ-уровневые поля name/server/port/type. URI-парсеры таких полей
    // в raw не пишут (имя/сервер/порт хранятся отдельно в ProxyEntry).
    // Используем «есть `name` в raw» как маркер clash-shape.
    let from_yaml = entry.raw.get("name").and_then(|v| v.as_str()).is_some();
    if from_yaml {
        return passthrough_proxy(entry);
    }

    match entry.protocol.as_str() {
        "vless" => build_vless_proxy(entry),
        "vmess" => build_vmess_proxy(entry),
        "trojan" => build_trojan_proxy(entry),
        "ss" => build_ss_proxy(entry),
        "hysteria2" => build_hysteria2_proxy(entry),
        "tuic" => build_tuic_proxy(entry),
        "wireguard" => build_wireguard_proxy(entry),
        "socks" => build_socks_proxy(entry),
        other => bail!("протокол '{other}' не поддерживается mihomo-конвертером"),
    }
}

/// Прямая конверсия raw JSON-mapping → YAML mapping. Используется когда
/// запись пришла из clash YAML и уже имеет нужную форму.
fn passthrough_proxy(entry: &ProxyEntry) -> Result<Mapping> {
    let yaml: Value = serde_yaml::to_value(&entry.raw)
        .context("конверсия JSON→YAML для passthrough proxy")?;
    let mut map = match yaml {
        Value::Mapping(m) => m,
        _ => bail!("raw entry не является объектом"),
    };
    // Принудительно проставляем server/port/name — на случай если в raw
    // лёгкое расхождение с обновлённым ProxyEntry.
    map.insert("name".into(), entry.name.clone().into());
    map.insert("server".into(), entry.server.clone().into());
    map.insert("port".into(), (entry.port as u64).into());
    // Ензайно гарантируем тип — clash YAML всегда содержит `type`,
    // но подстраховаться полезно.
    if !map.contains_key(Value::from("type")) {
        map.insert("type".into(), entry.protocol.clone().into());
    }
    Ok(map)
}

// ── helpers ──────────────────────────────────────────────────────────────

fn s(raw: &serde_json::Value, key: &str) -> Option<String> {
    raw.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

fn b(raw: &serde_json::Value, key: &str) -> Option<bool> {
    if let Some(v) = raw.get(key) {
        if let Some(b) = v.as_bool() {
            return Some(b);
        }
        if let Some(s) = v.as_str() {
            return Some(matches!(s, "1" | "true" | "yes"));
        }
        if let Some(n) = v.as_u64() {
            return Some(n != 0);
        }
    }
    None
}

fn base_proxy(entry: &ProxyEntry, type_name: &str) -> Mapping {
    let mut m = Mapping::new();
    m.insert("type".into(), type_name.into());
    m.insert("server".into(), entry.server.clone().into());
    m.insert("port".into(), (entry.port as u64).into());
    m.insert("udp".into(), true.into());
    m
}

/// Применить общие TLS/network/transport поля из URI-формата к
/// proxy-mapping. Универсально для vless/vmess/trojan.
fn apply_stream(map: &mut Mapping, raw: &serde_json::Value) {
    // network: tcp / ws / grpc / h2 / httpupgrade / xhttp
    let network = s(raw, "type").unwrap_or_else(|| "tcp".to_string());
    map.insert("network".into(), network.clone().into());

    // TLS / REALITY
    let security = s(raw, "security").unwrap_or_default();
    let tls_on = !security.is_empty() && security != "none";
    if tls_on {
        map.insert("tls".into(), true.into());
    }
    if let Some(sni) = s(raw, "sni") {
        if !sni.is_empty() {
            map.insert("servername".into(), sni.into());
        }
    }
    if let Some(fp) = s(raw, "fp") {
        if !fp.is_empty() {
            map.insert("client-fingerprint".into(), fp.into());
        }
    }
    if let Some(alpn) = s(raw, "alpn") {
        if !alpn.is_empty() {
            let arr: Vec<Value> = alpn.split(',').map(|s| Value::from(s.trim().to_string())).collect();
            map.insert("alpn".into(), Value::Sequence(arr));
        }
    }
    if b(raw, "allowInsecure").unwrap_or(false) || b(raw, "insecure").unwrap_or(false) {
        map.insert("skip-cert-verify".into(), true.into());
    }
    // #2: ECH (Encrypted ClientHello) — прячет SNI на уровне TLS-handshake
    // (анти-DPI). Источник: готовый объект `ech-opts` в raw (clash-shape)
    // ИЛИ URI-параметр `ech` с base64 ECHConfigList. Требует поддержки на
    // сервере; если параметра нет — ничего не добавляем.
    if let Some(ech_opts) = raw.get("ech-opts") {
        if let Ok(v) = serde_yaml::to_value(ech_opts) {
            map.insert("ech-opts".into(), v);
        }
    } else if let Some(ech) = s(raw, "ech") {
        if !ech.is_empty() {
            let mut eo = Mapping::new();
            eo.insert("enable".into(), true.into());
            eo.insert("config".into(), ech.into());
            map.insert("ech-opts".into(), Value::Mapping(eo));
        }
    }
    // REALITY (vless only обычно)
    if security == "reality" {
        let mut ro = Mapping::new();
        if let Some(pbk) = s(raw, "pbk") {
            ro.insert("public-key".into(), pbk.into());
        }
        if let Some(sid) = s(raw, "sid") {
            ro.insert("short-id".into(), sid.into());
        }
        if !ro.is_empty() {
            map.insert("reality-opts".into(), Value::Mapping(ro));
        }
    }

    // ws-opts
    if network == "ws" {
        let mut ws = Mapping::new();
        if let Some(path) = s(raw, "path") {
            ws.insert("path".into(), path.into());
        }
        if let Some(host) = s(raw, "host") {
            if !host.is_empty() {
                let mut headers = Mapping::new();
                headers.insert("Host".into(), host.into());
                ws.insert("headers".into(), Value::Mapping(headers));
            }
        }
        if !ws.is_empty() {
            map.insert("ws-opts".into(), Value::Mapping(ws));
        }
    }
    // grpc-opts
    if network == "grpc" {
        let mut g = Mapping::new();
        if let Some(svc) = s(raw, "serviceName").or_else(|| s(raw, "path")) {
            g.insert("grpc-service-name".into(), svc.into());
        }
        if !g.is_empty() {
            map.insert("grpc-opts".into(), Value::Mapping(g));
        }
    }
    // h2-opts
    if network == "h2" {
        let mut h = Mapping::new();
        if let Some(path) = s(raw, "path") {
            h.insert("path".into(), path.into());
        }
        if let Some(host) = s(raw, "host") {
            if !host.is_empty() {
                h.insert("host".into(), Value::Sequence(vec![host.into()]));
            }
        }
        if !h.is_empty() {
            map.insert("h2-opts".into(), Value::Mapping(h));
        }
    }
}

fn build_vless_proxy(entry: &ProxyEntry) -> Result<Mapping> {
    let raw = &entry.raw;
    let mut m = base_proxy(entry, "vless");
    let uuid = s(raw, "uuid").context("vless: uuid обязателен")?;
    m.insert("uuid".into(), uuid.into());

    if let Some(flow) = s(raw, "flow") {
        if !flow.is_empty() {
            m.insert("flow".into(), flow.into());
        }
    }
    apply_stream(&mut m, raw);
    Ok(m)
}

fn build_vmess_proxy(entry: &ProxyEntry) -> Result<Mapping> {
    let raw = &entry.raw;
    let mut m = base_proxy(entry, "vmess");

    let uuid = s(raw, "id").context("vmess: id (uuid) обязателен")?;
    m.insert("uuid".into(), uuid.into());

    let aid = raw
        .get("aid")
        .and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or(0);
    m.insert("alterId".into(), aid.into());

    let cipher = s(raw, "scy").unwrap_or_else(|| "auto".to_string());
    m.insert("cipher".into(), cipher.into());

    // network в vmess JSON хранится в поле "net", security в "tls".
    // Создаём synthetic raw где имена нормализованы под apply_stream
    // (которая ждёт "type" / "security").
    let mut synth = serde_json::Map::new();
    if let Some(net) = s(raw, "net") {
        synth.insert("type".into(), net.into());
    }
    if let Some(tls) = s(raw, "tls") {
        if tls == "tls" || tls == "1" || tls == "true" {
            synth.insert("security".into(), "tls".into());
        }
    }
    for k in ["sni", "fp", "alpn", "host", "path", "serviceName"] {
        if let Some(v) = s(raw, k) {
            synth.insert(k.into(), v.into());
        }
    }
    let synth_v = serde_json::Value::Object(synth);
    apply_stream(&mut m, &synth_v);
    Ok(m)
}

fn build_trojan_proxy(entry: &ProxyEntry) -> Result<Mapping> {
    let raw = &entry.raw;
    let mut m = base_proxy(entry, "trojan");

    let password = s(raw, "password").context("trojan: password обязателен")?;
    m.insert("password".into(), password.into());

    if let Some(sni) = s(raw, "sni") {
        if !sni.is_empty() {
            m.insert("sni".into(), sni.into());
        }
    }
    if let Some(alpn) = s(raw, "alpn") {
        if !alpn.is_empty() {
            let arr: Vec<Value> = alpn.split(',').map(|s| Value::from(s.trim().to_string())).collect();
            m.insert("alpn".into(), Value::Sequence(arr));
        }
    }
    if b(raw, "allowInsecure").unwrap_or(false) {
        m.insert("skip-cert-verify".into(), true.into());
    }
    // Сетевой транспорт + ws/grpc opts
    apply_stream(&mut m, raw);
    Ok(m)
}

fn build_ss_proxy(entry: &ProxyEntry) -> Result<Mapping> {
    let raw = &entry.raw;
    let mut m = base_proxy(entry, "ss");
    let cipher = s(raw, "cipher").context("ss: cipher обязателен")?;
    let password = s(raw, "password").context("ss: password обязателен")?;
    m.insert("cipher".into(), cipher.into());
    m.insert("password".into(), password.into());
    Ok(m)
}

fn build_hysteria2_proxy(entry: &ProxyEntry) -> Result<Mapping> {
    let raw = &entry.raw;
    let mut m = base_proxy(entry, "hysteria2");

    let password = s(raw, "password").context("hysteria2: password обязателен")?;
    m.insert("password".into(), password.into());

    if let Some(obfs) = s(raw, "obfs") {
        if !obfs.is_empty() {
            m.insert("obfs".into(), obfs.into());
        }
    }
    if let Some(obfs_pass) = s(raw, "obfs-password").or_else(|| s(raw, "obfsPassword")) {
        if !obfs_pass.is_empty() {
            m.insert("obfs-password".into(), obfs_pass.into());
        }
    }
    if let Some(sni) = s(raw, "sni") {
        if !sni.is_empty() {
            m.insert("sni".into(), sni.into());
        }
    }
    if b(raw, "insecure").unwrap_or(false) {
        m.insert("skip-cert-verify".into(), true.into());
    }
    let alpn = s(raw, "alpn").unwrap_or_else(|| "h3".to_string());
    let arr: Vec<Value> = alpn.split(',').map(|s| Value::from(s.trim().to_string())).collect();
    m.insert("alpn".into(), Value::Sequence(arr));
    Ok(m)
}

fn build_tuic_proxy(entry: &ProxyEntry) -> Result<Mapping> {
    let raw = &entry.raw;
    let mut m = base_proxy(entry, "tuic");

    if let Some(uuid) = s(raw, "uuid") {
        if !uuid.is_empty() {
            m.insert("uuid".into(), uuid.into());
        }
    }
    if let Some(password) = s(raw, "password") {
        m.insert("password".into(), password.into());
    }
    if let Some(sni) = s(raw, "sni") {
        if !sni.is_empty() {
            m.insert("sni".into(), sni.into());
        }
    }
    let alpn = s(raw, "alpn").unwrap_or_else(|| "h3".to_string());
    let arr: Vec<Value> = alpn.split(',').map(|s| Value::from(s.trim().to_string())).collect();
    m.insert("alpn".into(), Value::Sequence(arr));

    if let Some(cc) = s(raw, "congestion_control").or_else(|| s(raw, "congestion-controller")) {
        m.insert("congestion-controller".into(), cc.into());
    } else {
        m.insert("congestion-controller".into(), "bbr".into());
    }
    if let Some(udp_mode) = s(raw, "udp_relay_mode").or_else(|| s(raw, "udp-relay-mode")) {
        m.insert("udp-relay-mode".into(), udp_mode.into());
    } else {
        m.insert("udp-relay-mode".into(), "native".into());
    }
    if b(raw, "disable_sni").unwrap_or(false) {
        m.insert("disable-sni".into(), true.into());
    }
    if b(raw, "allow_insecure").or_else(|| b(raw, "insecure")).unwrap_or(false) {
        m.insert("skip-cert-verify".into(), true.into());
    }
    m.insert("reduce-rtt".into(), true.into());
    m.insert("fast-open".into(), true.into());
    Ok(m)
}

fn build_wireguard_proxy(entry: &ProxyEntry) -> Result<Mapping> {
    let raw = &entry.raw;
    let mut m = base_proxy(entry, "wireguard");

    let priv_key = s(raw, "private-key")
        .or_else(|| s(raw, "privatekey"))
        .context("wireguard: private-key обязателен")?;
    m.insert("private-key".into(), priv_key.into());

    if let Some(pubk) = s(raw, "publickey").or_else(|| s(raw, "public-key")) {
        m.insert("public-key".into(), pubk.into());
    }

    // Адрес интерфейса. URI хранит как "10.0.0.2/32" в "address".
    if let Some(addr) = s(raw, "address").or_else(|| s(raw, "ip")) {
        let ip_only = addr.split('/').next().unwrap_or(&addr).to_string();
        m.insert("ip".into(), ip_only.into());
    }
    if let Some(psk) = s(raw, "presharedkey").or_else(|| s(raw, "preshared-key")) {
        if !psk.is_empty() {
            m.insert("preshared-key".into(), psk.into());
        }
    }
    if let Some(mtu) = raw.get("mtu").and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))) {
        m.insert("mtu".into(), mtu.into());
    }
    if let Some(reserved) = s(raw, "reserved") {
        // "0,0,0" → [0,0,0]
        let nums: Vec<Value> = reserved
            .split(',')
            .filter_map(|s| s.trim().parse::<u64>().ok())
            .map(Value::from)
            .collect();
        if !nums.is_empty() {
            m.insert("reserved".into(), Value::Sequence(nums));
        }
    }
    m.insert("remote-dns-resolve".into(), true.into());
    Ok(m)
}

fn build_socks_proxy(entry: &ProxyEntry) -> Result<Mapping> {
    let raw = &entry.raw;
    let mut m = base_proxy(entry, "socks5");
    if let Some(user) = s(raw, "username") {
        m.insert("username".into(), user.into());
    }
    if let Some(pass) = s(raw, "password") {
        m.insert("password".into(), pass.into());
    }
    Ok(m)
}

// ─── 8.F: passthrough full mihomo YAML ───────────────────────────────────────

/// Параметры patch'а — наши значения которые обязательно должны
/// попасть в финальный YAML, даже если у провайдера в подписке стоят
/// другие.
pub struct FullYamlPatch<'a> {
    /// Порт `mixed-port` (SOCKS5 + HTTP в одном). Перезаписываем
    /// провайдерский — нам нужен наш random port для рандомизации
    /// (9.H) и чтобы tun2socks-pipeline знал точный адрес.
    pub mixed_port: u16,
    /// `127.0.0.1` или `0.0.0.0` (LAN). Из настроек.
    pub listen: &'a str,
    /// SOCKS5 password-auth для inbound (9.G). Перезаписывает
    /// провайдерскую `authentication`. None в proxy-режиме без auth.
    pub socks_auth: Option<(&'a str, &'a str)>,
    /// Порт для external-controller (mihomo HTTP API). Используется
    /// для bandwidth-метра, smart failover, group-switching через
    /// `mihomo_api`. Random secret генерится автоматически.
    pub external_controller_port: u16,
    pub external_controller_secret: &'a str,
    /// Per-process правила пользователя (8.D). Добавляются ПЕРЕД
    /// провайдерскими — наш override приоритетнее.
    pub app_rules: &'a [AppRule],
    /// Anti-DPI: пока full-passthrough игнорирует (mihomo-only — DoH
    /// resolve можно поднять патчем `dns.nameserver` если нужен,
    /// но в подписке-профиле обычно DNS уже сконфигурен. Если нужно
    /// принудительно — пользователь явно включит в Settings).
    pub anti_dpi: Option<&'a AntiDpiOptions>,
    /// 0.1.2 / 13.L: использовать встроенный TUN-режим mihomo вместо
    /// нашего pipeline `external tun2socks via helper`.
    ///
    /// Когда `true`:
    /// - Сохраняем `tun.enable: true` из YAML (НЕ переписываем в false);
    /// - Mihomo сам создаёт WinTUN-адаптер, ставит routing-таблицу,
    ///   биндит DIRECT-outbound к физ-интерфейсу, обходит сам себя
    ///   на уровне sockopt (никаких петель — mihomo знает свой TUN);
    /// - Tauri-main НЕ дёргает helper.tun_start — mihomo всё делает сам.
    ///
    /// Когда `false` (default — proxy-режим или fallback):
    /// - Переписываем `tun.enable: false`, mihomo работает как обычный
    ///   SOCKS5/HTTP-сервер на mixed-port;
    /// - В TUN-режиме helper поднимает наш tun2socks и направляет
    ///   трафик в mihomo SOCKS5 (старый путь).
    ///
    /// **Требование**: mihomo должен быть запущен с правами админа
    /// (создание WinTUN-адаптера). Для этого запускаем mihomo через
    /// helper-сервис (он SYSTEM), а не напрямую как Tauri sidecar.
    pub use_builtin_tun: bool,
    /// 12.E маскировка имени TUN-адаптера. `Some(name)` → принудительно
    /// ставим `tun.device` в замаскированное имя (перезаписывая
    /// провайдерское). `None` → имя из подписки / mihomo default.
    pub tun_device: Option<&'a str>,
    /// 11.F: активный routing-профиль. `Some(p)` → его explicit-правила
    /// (block/direct/proxy) вставляются ПЕРЕД провайдерскими (после
    /// app-rules) — split-tunnel override поверх базовой маршрутизации
    /// подписки. Провайдерский `MATCH` (глобальный дефолт) НЕ трогаем:
    /// его группы/балансировка остаются как задумал провайдер, поэтому
    /// `GlobalProxy` профиля в full-profile-режиме не переопределяет
    /// финальное правило (только явные rule'ы). `None` → без изменений.
    pub routing_profile: Option<&'a super::routing_profile::RoutingProfile>,
    /// #4: если `true` — принудительно включаем IPv6 (root + dns), даже
    /// если провайдер выставил false. `false` → провайдерский выбор не
    /// трогаем (наш дефолт — не навязывать).
    pub ipv6: bool,
    /// #3: пользовательские DNS из настроек. `Some(non-empty)` →
    /// перезаписываем `dns.nameserver` (общий резолвер), сохраняя
    /// провайдерскую `nameserver-policy`. `None` → не трогаем DNS провайдера.
    pub custom_dns: Option<&'a [String]>,
}

/// 8.F: применяет patch к полному mihomo-YAML из подписки и возвращает
/// готовый текст для запуска. Стратегия — **сохранить максимум** того
/// что прислал провайдер, перезаписав только то, что нам критично:
///
/// - `mixed-port` / `bind-address` — наш inbound порт (9.H рандомизация);
/// - `socks-port` / `port` / `redir-port` — удаляем (используем только
///   mixed-port, чтобы не разводить лишние порты);
/// - `authentication` — наша SOCKS-auth (9.G), перезаписываем;
/// - `external-controller` + `secret` — наши, иначе UI не достучится;
/// - `tun.enable` → `false` — наш helper управляет WinTUN через
///   tun2socks; mihomo built-in TUN был бы конфликтом (отложено в 13.L);
/// - `log-level` → `info` если был `silent` (нам нужны логи);
/// - `app_rules` пользователя (8.D) добавляются в начало `rules` блока.
///
/// **Сохраняется** провайдерское: `proxies`, `proxy-groups`,
/// `proxy-providers`, `rule-providers`, `dns`, `hosts`, `rules`,
/// `tun.exclude-address`, `tun.stack`, `tun.auto-route`,
/// `nameserver-policy`, `fake-ip-filter` и т.д.
pub fn patch_full_yaml(raw_yaml: &str, patch: &FullYamlPatch) -> Result<MihomoConfig> {
    let mut value: Value = serde_yaml::from_str(raw_yaml)
        .context("не удалось распарсить full mihomo YAML")?;
    let root = value
        .as_mapping_mut()
        .context("YAML root — не mapping")?;

    // ── inbound: единственный mixed-port на нашем порту ───────────────
    root.insert(
        "mixed-port".into(),
        (patch.mixed_port as u64).into(),
    );
    // Удаляем дублирующие порты — mixed-port покрывает SOCKS5 и HTTP
    root.remove(Value::String("socks-port".into()));
    root.remove(Value::String("port".into()));
    root.remove(Value::String("redir-port".into()));
    root.remove(Value::String("tproxy-port".into()));

    root.insert("allow-lan".into(), (patch.listen == "0.0.0.0").into());
    root.insert(
        "bind-address".into(),
        Value::String(patch.listen.to_string()),
    );

    // ── SOCKS-auth (9.G) ──────────────────────────────────────────────
    if let Some((user, pass)) = patch.socks_auth {
        root.insert(
            "authentication".into(),
            Value::Sequence(vec![Value::String(format!("{user}:{pass}"))]),
        );
        // skip-auth-prefixes для loopback можно оставить если был —
        // но обычно в подписочных конфигах его нет.
    } else {
        // Удаляем чужую auth — мы хотим контролировать кто подключается
        // к нашему inbound. Если auth не задан, оставляем noauth (только
        // loopback по умолчанию).
        root.remove(Value::String("authentication".into()));
    }

    // ── external-controller (для mihomo_api) ──────────────────────────
    root.insert(
        "external-controller".into(),
        Value::String(format!("127.0.0.1:{}", patch.external_controller_port)),
    );
    root.insert(
        "secret".into(),
        Value::String(patch.external_controller_secret.to_string()),
    );

    // ── log-level ─────────────────────────────────────────────────────
    // Стратегия:
    //   - `silent` / отсутствует → форсим `warning` (по умолчанию мы
    //     режем шум, но оставляем error/warning видимыми);
    //   - любое явное значение (`info` / `debug`) — оставляем как есть.
    //     Если провайдер прислал `info`, значит ему нужны verbose-логи
    //     для диагностики (rule-decisions, provider-loads, и т.п.);
    //     перезаписывать его выбор плохая идея — мы тогда теряем
    //     причину когда mihomo внезапно умирает на init-фазе.
    //
    // На прод-релизе можно подумать про toggle «debug logs» в Settings,
    // но сейчас пользователь сам решает уровень через YAML.
    let current_log = root
        .get("log-level")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if current_log.is_empty() || current_log == "silent" {
        root.insert("log-level".into(), "warning".into());
    }

    // ── tun.enable: зависит от режима ─────────────────────────────────
    // **builtin-TUN путь (13.L)**: оставляем `tun.enable: true` — mihomo
    // сам создаст WinTUN, поставит маршруты, обработает DIRECT через
    // auto-detect-interface. Никакого нашего tun2socks/half-route'а.
    //
    // **внешний tun2socks путь** (default): принудительно
    // `tun.enable: false` — mihomo работает только как SOCKS-server,
    // тоннель управляется нашим helper'ом.
    if let Some(tun) = root
        .get_mut(Value::String("tun".into()))
        .and_then(|v| v.as_mapping_mut())
    {
        if patch.use_builtin_tun {
            tun.insert("enable".into(), true.into());
            // auto-detect-interface жизненно важен — он скажет mihomo
            // какой физ-интерфейс использовать для bypass'а собственного
            // TUN'а в DIRECT-outbound. Без него mihomo не знает куда
            // привязать direct-сокет, петля.
            tun.insert("auto-detect-interface".into(), true.into());
            // auto-route: пусть mihomo сам ставит half-routes/0.0.0.0
            tun.entry(Value::String("auto-route".into()))
                .or_insert_with(|| true.into());
            // #3: strict-route — анти-leak (не override, если провайдер
            // явно выключил).
            tun.entry(Value::String("strict-route".into()))
                .or_insert_with(|| true.into());
            // 12.E: перезаписываем имя адаптера на замаскированное, если
            // включена маскировка. Иначе сохраняем провайдерское / default.
            if let Some(dev) = patch.tun_device {
                tun.insert("device".into(), dev.into());
            }
        } else {
            tun.insert("enable".into(), false.into());
        }
    } else if patch.use_builtin_tun {
        // Подписка не имеет `tun:` секции — собираем минимально-рабочую
        // через общий helper (с dns-hijack + опциональным 12.E device).
        root.insert(
            "tun".into(),
            Value::Mapping(builtin_tun_mapping(patch.tun_device)),
        );
    }

    // ── ipv6 — оставляем как у провайдера ─────────────────────────────
    // (он сам решает; обычно false для mihomo-профилей)

    // ── find-process-mode для app-rules (8.D) ─────────────────────────
    if !patch.app_rules.is_empty() {
        root.insert("find-process-mode".into(), "always".into());
    }

    // ── Префиксные правила (наш приоритет) ────────────────────────────
    let mut prefix_rules: Vec<Value> = Vec::new();
    for r in patch.app_rules {
        if let Some(rule) = app_rule_to_mihomo(r) {
            prefix_rules.push(Value::String(rule));
        }
    }

    // 11.F: explicit-правила активного routing-профиля. Идут ПОСЛЕ
    // app-rules (PROCESS-NAME точечнее) и ПЕРЕД провайдерскими — так
    // пользовательский split-tunnel override перебивает дефолтную
    // маршрутизацию подписки, но провайдерский MATCH остаётся финальным.
    // proxy-target — провайдерская группа (detect_proxy_target), иначе
    // mihomo отбросил бы правило на несуществующий outbound.
    if let Some(p) = patch.routing_profile {
        let proxy_target = detect_proxy_target(root);
        for r in mihomo_rules_from_profile(p, &proxy_target) {
            prefix_rules.push(Value::String(r));
        }
    }

    // Anti-DPI server-resolve через DoH: если включён, подставляем в
    // dns.nameserver чтобы мiomo резолвил VPN-сервера через DoH.
    if let Some(anti) = patch.anti_dpi {
        if anti.server_resolve && !anti.server_resolve_doh.is_empty() {
            let dns = root
                .entry(Value::String("dns".into()))
                .or_insert_with(|| Value::Mapping(Mapping::new()));
            if let Some(dns_map) = dns.as_mapping_mut() {
                dns_map.insert("enable".into(), true.into());
                dns_map.insert(
                    "nameserver".into(),
                    Value::Sequence(vec![Value::String(
                        anti.server_resolve_doh.clone(),
                    )]),
                );
                if !anti.server_resolve_bootstrap.is_empty() {
                    dns_map.insert(
                        "default-nameserver".into(),
                        Value::Sequence(vec![Value::String(
                            anti.server_resolve_bootstrap.clone(),
                        )]),
                    );
                }
            }
        }
    }

    // 11.E: аддитивный мёрж DNS активного профиля (hosts + domestic
    // nameserver-policy). Общий nameserver/enhanced-mode провайдера не
    // трогаем — это его зона ответственности в full-profile.
    if let Some(p) = patch.routing_profile {
        merge_profile_dns(root, p);
    }

    // ── Префиксные правила в начало rules ─────────────────────────────
    if !prefix_rules.is_empty() {
        let rules_entry = root
            .entry(Value::String("rules".into()))
            .or_insert_with(|| Value::Sequence(Vec::new()));
        if let Some(seq) = rules_entry.as_sequence_mut() {
            // Вставляем наши rules перед существующими — сохраняя порядок
            let mut combined = prefix_rules;
            combined.append(seq);
            *seq = combined;
        }
    }

    // mode=rule по умолчанию (если провайдер забыл) — иначе mihomo
    // войдёт в global mode (всё через PROXY) и наши rules не сработают.
    if !root.contains_key("mode") {
        root.insert("mode".into(), "rule".into());
    }

    // 11.B: если вшили geo-правила активного профиля — гарантируем
    // `.dat`-режим (geofiles::provision_into кладёт файлы в data-dir) и
    // выключаем авто-обновление. Провайдерский `geodata-mode` НЕ перетираем
    // (entry/or_insert): если он явно выбрал mmdb — это его решение.
    if patch.routing_profile.is_some() {
        root.entry(Value::String("geodata-mode".into()))
            .or_insert_with(|| true.into());
        root.entry(Value::String("geo-auto-update".into()))
            .or_insert_with(|| false.into());
    }

    // #2/#7/#8/#1: фичи mihomo для full-profile — добавляем ТОЛЬКО если
    // провайдер их не задал (or_insert), чтобы не перетереть его выбор.
    root.entry(Value::String("tcp-concurrent".into()))
        .or_insert_with(|| true.into());
    root.entry(Value::String("unified-delay".into()))
        .or_insert_with(|| true.into());
    // #2: глобальный fingerprint — per-proxy и провайдерский имеют приоритет.
    root.entry(Value::String("global-client-fingerprint".into()))
        .or_insert_with(|| "chrome".into());
    // #1: sniffer — если у провайдера секции нет, ставим свою (для domain-
    // правил/per-app по IP). Если есть — не трогаем.
    root.entry(Value::String("sniffer".into()))
        .or_insert_with(|| Value::Mapping(build_sniffer()));
    // #8: persist выбранной ноды/fake-ip. Мёржим в существующий profile.
    {
        let prof = root
            .entry(Value::String("profile".into()))
            .or_insert_with(|| Value::Mapping(Mapping::new()));
        if let Some(pm) = prof.as_mapping_mut() {
            pm.entry(Value::String("store-selected".into()))
                .or_insert_with(|| true.into());
            pm.entry(Value::String("store-fake-ip".into()))
                .or_insert_with(|| true.into());
        }
    }

    // #4: включаем IPv6 только если пользователь явно попросил — override
    // провайдерского false. Выключение оставляем провайдеру.
    if patch.ipv6 {
        root.insert("ipv6".into(), true.into());
        if let Some(d) = root
            .entry(Value::String("dns".into()))
            .or_insert_with(|| Value::Mapping(Mapping::new()))
            .as_mapping_mut()
        {
            d.insert("ipv6".into(), true.into());
        }
    }

    // #3: пользовательский DNS перезаписывает общий nameserver провайдера
    // (его nameserver-policy сохраняем). Только непустые значения.
    if let Some(cdns) = patch.custom_dns {
        let v: Vec<Value> = cdns
            .iter()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| Value::from(s.to_string()))
            .collect();
        if !v.is_empty() {
            if let Some(d) = root
                .entry(Value::String("dns".into()))
                .or_insert_with(|| Value::Mapping(Mapping::new()))
                .as_mapping_mut()
            {
                d.insert("enable".into(), true.into());
                d.insert("nameserver".into(), Value::Sequence(v));
            }
        }
    }

    let yaml = serde_yaml::to_string(&value)
        .context("сериализация патченного YAML")?;
    Ok(MihomoConfig {
        yaml,
        mixed_port: patch.mixed_port,
    })
}

#[cfg(test)]
mod patch_tests {
    use super::*;

    fn base_patch<'a>() -> FullYamlPatch<'a> {
        FullYamlPatch {
            mixed_port: 31000,
            listen: "127.0.0.1",
            socks_auth: Some(("kwik", "secret-pass")),
            external_controller_port: 31001,
            external_controller_secret: "test-secret-uuid",
            app_rules: &[],
            anti_dpi: None,
            use_builtin_tun: false,
            tun_device: None,
            routing_profile: None,
            ipv6: false,
            custom_dns: None,
        }
    }

    /// 8.F: provider's mixed-port должен быть перезаписан нашим. Также
    /// удаляем дублирующие SOCKS-port/redir-port чтобы mihomo не
    /// поднимал лишние inbound'ы.
    #[test]
    fn patch_overrides_inbound_ports() {
        let yaml = r#"
mixed-port: 7890
socks-port: 7891
redir-port: 7892
proxies: []
proxy-groups:
  - name: select
    type: select
    proxies: []
"#;
        let cfg = patch_full_yaml(yaml, &base_patch()).expect("patch ok");
        let v: Value = serde_yaml::from_str(&cfg.yaml).unwrap();
        let m = v.as_mapping().unwrap();
        assert_eq!(m["mixed-port"].as_u64(), Some(31000));
        assert!(!m.contains_key("socks-port"), "socks-port должен быть удалён");
        assert!(!m.contains_key("redir-port"), "redir-port должен быть удалён");
    }

    /// 8.F: tun.enable → false; остальные поля tun секции (stack,
    /// exclude-address) сохраняются для будущего 13.L.
    #[test]
    fn patch_disables_tun_keeping_other_fields() {
        let yaml = r#"
tun:
  enable: true
  stack: mixed
  auto-route: true
  exclude-address:
    - 1.2.3.4/32
proxies: []
proxy-groups:
  - name: select
    type: select
    proxies: []
"#;
        let cfg = patch_full_yaml(yaml, &base_patch()).expect("patch ok");
        let v: Value = serde_yaml::from_str(&cfg.yaml).unwrap();
        let tun = v.as_mapping().unwrap()["tun"].as_mapping().unwrap();
        assert_eq!(tun["enable"].as_bool(), Some(false));
        assert_eq!(tun["stack"].as_str(), Some("mixed"));
        assert!(tun.contains_key("exclude-address"));
    }

    /// 8.F: app_rules (PROCESS-NAME) попадают в начало rules списка —
    /// перед провайдерскими. Также set find-process-mode=always.
    #[test]
    fn patch_prepends_app_rules() {
        let yaml = r#"
proxies: []
proxy-groups:
  - name: select
    type: select
    proxies: []
rules:
  - DOMAIN-SUFFIX,example.com,DIRECT
  - MATCH,select
"#;
        let mut p = base_patch();
        let rules_owned = vec![AppRule {
            exe: "telegram.exe".into(),
            action: "proxy".into(),
            comment: None,
        }];
        p.app_rules = &rules_owned;
        let cfg = patch_full_yaml(yaml, &p).expect("patch ok");
        let v: Value = serde_yaml::from_str(&cfg.yaml).unwrap();
        let root = v.as_mapping().unwrap();
        assert_eq!(root["find-process-mode"].as_str(), Some("always"));
        let rules = root["rules"].as_sequence().unwrap();
        assert!(
            rules[0]
                .as_str()
                .unwrap()
                .starts_with("PROCESS-NAME,telegram.exe"),
            "первая rule должна быть наша app-rule"
        );
        assert_eq!(rules.last().unwrap().as_str(), Some("MATCH,select"));
    }

    /// 8.F: external-controller перезаписывается нашим (для mihomo_api).
    /// Чужой secret игнорируется.
    #[test]
    fn patch_sets_external_controller() {
        let yaml = r#"
external-controller: 127.0.0.1:9999
secret: provider-secret
proxies: []
proxy-groups:
  - name: select
    type: select
    proxies: []
"#;
        let cfg = patch_full_yaml(yaml, &base_patch()).expect("patch ok");
        let v: Value = serde_yaml::from_str(&cfg.yaml).unwrap();
        let m = v.as_mapping().unwrap();
        assert_eq!(
            m["external-controller"].as_str(),
            Some("127.0.0.1:31001")
        );
        assert_eq!(m["secret"].as_str(), Some("test-secret-uuid"));
    }

    /// 11.F: правила активного routing-профиля вставляются в full-profile
    /// ПОСЛЕ app-rules и ПЕРЕД провайдерскими; proxy-target берётся из
    /// провайдерского MATCH (а не литерал "PROXY"), MATCH не трогаем.
    #[test]
    fn patch_injects_routing_profile_rules() {
        use crate::config::routing_profile::{BoolString, RoutingProfile};
        let yaml = r#"
proxies: []
proxy-groups:
  - name: "🚀 Выбор"
    type: select
    proxies: []
rules:
  - DOMAIN-SUFFIX,provider.example,DIRECT
  - MATCH,🚀 Выбор
"#;
        let profile = RoutingProfile {
            name: "T".into(),
            global_proxy: BoolString(true),
            direct_sites: vec!["geosite:ru".into()],
            block_sites: vec!["geosite:category-ads-all".into()],
            proxy_sites: vec!["geosite:youtube".into()],
            ..Default::default()
        };
        let mut p = base_patch();
        p.routing_profile = Some(&profile);
        let cfg = patch_full_yaml(yaml, &p).expect("patch ok");
        let v: Value = serde_yaml::from_str(&cfg.yaml).unwrap();
        let rules = v.as_mapping().unwrap()["rules"].as_sequence().unwrap();
        let strs: Vec<&str> = rules.iter().filter_map(|r| r.as_str()).collect();
        // block идёт первым, proxy-target = провайдерская группа.
        assert_eq!(strs[0], "GEOSITE,category-ads-all,REJECT");
        assert!(strs.contains(&"GEOSITE,ru,DIRECT"));
        assert!(strs.contains(&"GEOSITE,youtube,🚀 Выбор"));
        // Провайдерские правила и их MATCH сохранены и идут ПОСЛЕ наших.
        let our_last = strs
            .iter()
            .position(|s| *s == "GEOSITE,youtube,🚀 Выбор")
            .unwrap();
        let provider_match = strs.iter().position(|s| *s == "MATCH,🚀 Выбор").unwrap();
        assert!(our_last < provider_match, "наши правила до MATCH провайдера");
        assert!(
            strs.contains(&"DOMAIN-SUFFIX,provider.example,DIRECT"),
            "провайдерское правило сохранено"
        );
    }

    /// 11.F: app-rules (PROCESS-NAME) приоритетнее правил профиля —
    /// идут раньше в списке.
    #[test]
    fn patch_app_rules_precede_profile_rules() {
        use crate::config::routing_profile::RoutingProfile;
        let yaml = r#"
proxies: []
proxy-groups:
  - name: select
    type: select
    proxies: []
rules:
  - MATCH,select
"#;
        let profile = RoutingProfile {
            name: "T".into(),
            direct_sites: vec!["geosite:ru".into()],
            ..Default::default()
        };
        let app = vec![AppRule {
            exe: "telegram.exe".into(),
            action: "proxy".into(),
            comment: None,
        }];
        let mut p = base_patch();
        p.app_rules = &app;
        p.routing_profile = Some(&profile);
        let cfg = patch_full_yaml(yaml, &p).expect("patch ok");
        let v: Value = serde_yaml::from_str(&cfg.yaml).unwrap();
        let rules = v.as_mapping().unwrap()["rules"].as_sequence().unwrap();
        let strs: Vec<&str> = rules.iter().filter_map(|r| r.as_str()).collect();
        let app_pos = strs
            .iter()
            .position(|s| s.starts_with("PROCESS-NAME,telegram.exe"))
            .unwrap();
        let prof_pos = strs.iter().position(|s| *s == "GEOSITE,ru,DIRECT").unwrap();
        assert!(app_pos < prof_pos, "app-rule раньше правила профиля");
    }

    /// 11.E: split-DNS из профиля — remote nameserver, domestic policy,
    /// hosts, fake-ip с фильтром direct-зон.
    #[test]
    fn build_dns_full_split_from_profile() {
        use crate::config::routing_profile::{BoolString, RoutingProfile};
        let mut hosts = std::collections::BTreeMap::new();
        hosts.insert("router.lan".to_string(), "192.168.1.1".to_string());
        let p = RoutingProfile {
            name: "T".into(),
            fake_dns: BoolString(true),
            remote_dns_domain: "https://dns.example/dns-query".into(),
            remote_dns_ip: "9.9.9.9".into(),
            domestic_dns_domain: "".into(),
            domestic_dns_ip: "77.88.8.8".into(),
            direct_sites: vec!["geosite:ru".into(), "*.local-cdn.ru".into()],
            dns_hosts: hosts,
            ..Default::default()
        };
        let dns = build_dns(None, Some(&p), false, None);
        // enhanced-mode fake-ip + фильтр содержит direct-зону.
        assert_eq!(dns["enhanced-mode"].as_str(), Some("fake-ip"));
        let filter = dns["fake-ip-filter"].as_sequence().unwrap();
        let fstr: Vec<&str> = filter.iter().filter_map(|v| v.as_str()).collect();
        assert!(fstr.contains(&"geosite:ru"));
        assert!(fstr.contains(&"+.local-cdn.ru"));
        // remote nameserver = RemoteDNSDomain, bootstrap = RemoteDNSIP.
        assert_eq!(
            dns["nameserver"][0].as_str(),
            Some("https://dns.example/dns-query")
        );
        assert_eq!(dns["default-nameserver"][0].as_str(), Some("9.9.9.9"));
        // domestic policy для geosite:ru → DomesticDNSIP.
        let pol = dns["nameserver-policy"].as_mapping().unwrap();
        let dom = pol.get(Value::String("geosite:ru".into())).unwrap();
        assert_eq!(dom[0].as_str(), Some("77.88.8.8"));
        // hosts.
        assert_eq!(dns["hosts"]["router.lan"].as_str(), Some("192.168.1.1"));
    }

    /// 11.E: без профиля — дефолтный redir-host + Cloudflare/Google.
    #[test]
    fn build_dns_defaults_without_profile() {
        let dns = build_dns(None, None, false, None);
        assert_eq!(dns["enhanced-mode"].as_str(), Some("redir-host"));
        assert!(!dns.contains_key(Value::String("nameserver-policy".into())));
        assert!(dns["nameserver"][0]
            .as_str()
            .unwrap()
            .contains("cloudflare"));
    }

    /// 11.E: dns_policy_keys — geosite/суффикс/домен; keyword и голые
    /// слова пропускаются.
    #[test]
    fn dns_policy_keys_conversion() {
        let keys = dns_policy_keys(&[
            "geosite:ru".into(),
            "*.example.com".into(),
            "domain:exact.com".into(),
            "plain.org".into(),
            "keyword:vk".into(),
            "ads".into(),
        ]);
        assert_eq!(
            keys,
            vec!["geosite:ru", "+.example.com", "exact.com", "+.plain.org"]
        );
    }

    /// 11.E (full-profile): merge_profile_dns добавляет hosts и domestic
    /// policy, но НЕ перетирает провайдерский nameserver и policy-ключ.
    #[test]
    fn merge_profile_dns_is_additive() {
        use crate::config::routing_profile::RoutingProfile;
        let mut root: Mapping = serde_yaml::from_str(
            "dns:\n  enable: true\n  nameserver: [https://provider.dns/q]\n  nameserver-policy:\n    \"geosite:ru\": [1.1.1.1]\n",
        )
        .unwrap();
        let mut hosts = std::collections::BTreeMap::new();
        hosts.insert("my.host".to_string(), "10.0.0.5".to_string());
        let p = RoutingProfile {
            name: "T".into(),
            domestic_dns_ip: "77.88.8.8".into(),
            direct_sites: vec!["geosite:ru".into(), "geosite:private".into()],
            dns_hosts: hosts,
            ..Default::default()
        };
        merge_profile_dns(&mut root, &p);
        let dns = root[Value::String("dns".into())].as_mapping().unwrap();
        // провайдерский nameserver не тронут.
        assert_eq!(dns["nameserver"][0].as_str(), Some("https://provider.dns/q"));
        let pol = dns["nameserver-policy"].as_mapping().unwrap();
        // существующий ключ geosite:ru НЕ перетёрт (остался 1.1.1.1).
        assert_eq!(
            pol.get(Value::String("geosite:ru".into())).unwrap()[0].as_str(),
            Some("1.1.1.1")
        );
        // новый ключ geosite:private добавлен с DomesticDNS.
        assert_eq!(
            pol.get(Value::String("geosite:private".into())).unwrap()[0].as_str(),
            Some("77.88.8.8")
        );
        // hosts домержены.
        assert_eq!(dns["hosts"]["my.host"].as_str(), Some("10.0.0.5"));
    }

    /// 11.E (full-profile): без `dns:` секции merge не фабрикует её.
    #[test]
    fn merge_profile_dns_skips_when_no_dns_section() {
        use crate::config::routing_profile::RoutingProfile;
        let mut root: Mapping = serde_yaml::from_str("proxies: []\n").unwrap();
        let p = RoutingProfile {
            name: "T".into(),
            domestic_dns_ip: "77.88.8.8".into(),
            direct_sites: vec!["geosite:ru".into()],
            ..Default::default()
        };
        merge_profile_dns(&mut root, &p);
        assert!(!root.contains_key(Value::String("dns".into())));
    }

    /// #4: regex-правило профиля → DOMAIN-REGEX (раньше скипалось).
    #[test]
    fn regex_rule_maps_to_domain_regex() {
        use crate::config::routing_profile::RoutingProfile;
        let p = RoutingProfile {
            name: "T".into(),
            proxy_sites: vec![r"regex:.*\.example\.(com|org)".into()],
            ..Default::default()
        };
        let rules = mihomo_rules_from_profile(&p, "PROXY");
        assert!(rules.contains(&r"DOMAIN-REGEX,.*\.example\.(com|org),PROXY".to_string()));
    }

    /// #1: sniffer включает TLS/HTTP/QUIC + override-destination.
    #[test]
    fn sniffer_has_tls_http_quic() {
        let s = build_sniffer();
        assert_eq!(s["enable"].as_bool(), Some(true));
        assert_eq!(s["override-destination"].as_bool(), Some(true));
        let sniff = s["sniff"].as_mapping().unwrap();
        assert!(sniff.contains_key(Value::String("TLS".into())));
        assert!(sniff.contains_key(Value::String("HTTP".into())));
        assert!(sniff.contains_key(Value::String("QUIC".into())));
    }

    /// #3: built-in TUN mapping содержит strict-route + route-exclude
    /// приватных диапазонов (LAN не ломается при strict-route).
    #[test]
    fn builtin_tun_has_strict_route_and_lan_exclude() {
        let tun = builtin_tun_mapping(None);
        assert_eq!(tun["strict-route"].as_bool(), Some(true));
        let excl = tun["route-exclude-address"].as_sequence().unwrap();
        let s: Vec<&str> = excl.iter().filter_map(|v| v.as_str()).collect();
        assert!(s.contains(&"192.168.0.0/16"));
        assert!(s.contains(&"fc00::/7"));
    }

    /// LAN/loopback/link-local идут DIRECT (не в туннель).
    #[test]
    fn local_direct_rules_cover_private_ranges() {
        let r = local_direct_rules();
        assert!(r.iter().any(|x| x.contains("127.0.0.0/8") && x.contains("DIRECT")));
        assert!(r.iter().any(|x| x.contains("192.168.0.0/16")));
        assert!(r.iter().any(|x| x.contains("::1/128")));
        assert!(r.iter().all(|x| x.ends_with("no-resolve")));
    }

    /// build_dns: respect-rules + proxy-server-nameserver выставлены
    /// (DNS следует правилам, хост ноды резолвится отдельно — без петли).
    #[test]
    fn build_dns_has_respect_rules_and_proxy_server_ns() {
        let dns = build_dns(None, None, false, None);
        assert_eq!(dns["respect-rules"].as_bool(), Some(true));
        assert!(dns
            .get(Value::String("proxy-server-nameserver".into()))
            .and_then(|v| v.as_sequence())
            .is_some_and(|s| !s.is_empty()));
    }

    /// #2/#7/#8/#1: full-profile получает фичи, если провайдер их не задал.
    #[test]
    fn patch_adds_mihomo_features_when_absent() {
        let yaml = "proxies: []\nproxy-groups:\n  - {name: s, type: select, proxies: []}\n";
        let cfg = patch_full_yaml(yaml, &base_patch()).expect("ok");
        let v: Value = serde_yaml::from_str(&cfg.yaml).unwrap();
        let m = v.as_mapping().unwrap();
        assert_eq!(m["tcp-concurrent"].as_bool(), Some(true));
        assert_eq!(m["unified-delay"].as_bool(), Some(true));
        assert_eq!(m["global-client-fingerprint"].as_str(), Some("chrome"));
        assert!(m.contains_key(Value::String("sniffer".into())));
        let prof = m["profile"].as_mapping().unwrap();
        assert_eq!(prof["store-selected"].as_bool(), Some(true));
    }

    /// #2/#7: провайдерские значения этих фич НЕ перетираются.
    #[test]
    fn patch_respects_provider_feature_values() {
        let yaml = "global-client-fingerprint: firefox\ntcp-concurrent: false\nproxies: []\nproxy-groups:\n  - {name: s, type: select, proxies: []}\n";
        let cfg = patch_full_yaml(yaml, &base_patch()).expect("ok");
        let v: Value = serde_yaml::from_str(&cfg.yaml).unwrap();
        let m = v.as_mapping().unwrap();
        assert_eq!(m["global-client-fingerprint"].as_str(), Some("firefox"));
        assert_eq!(m["tcp-concurrent"].as_bool(), Some(false));
    }

    /// #1: провайдерская url-test группа (failover) переживает patch.
    #[test]
    fn patch_preserves_provider_url_test_group() {
        let yaml = r#"
proxies: []
proxy-groups:
  - name: auto
    type: url-test
    url: http://www.gstatic.com/generate_204
    interval: 300
    proxies: [a, b, c]
rules:
  - MATCH,auto
"#;
        let cfg = patch_full_yaml(yaml, &base_patch()).expect("ok");
        let v: Value = serde_yaml::from_str(&cfg.yaml).unwrap();
        let groups = v.as_mapping().unwrap()["proxy-groups"].as_sequence().unwrap();
        let g = groups[0].as_mapping().unwrap();
        assert_eq!(g["type"].as_str(), Some("url-test"));
        assert_eq!(g["interval"].as_u64(), Some(300));
        assert_eq!(g["proxies"].as_sequence().unwrap().len(), 3);
    }

    /// #2: ECH из URI-параметра `ech` → ech-opts {enable, config}.
    #[test]
    fn apply_stream_ech_from_uri_param() {
        let raw = serde_json::json!({
            "type": "tcp",
            "security": "tls",
            "sni": "example.com",
            "ech": "SGVsbG8="
        });
        let mut m = Mapping::new();
        apply_stream(&mut m, &raw);
        let ech = m[Value::String("ech-opts".into())].as_mapping().unwrap();
        assert_eq!(ech["enable"].as_bool(), Some(true));
        assert_eq!(ech["config"].as_str(), Some("SGVsbG8="));
    }

    /// #2: готовый объект ech-opts в raw сохраняется как есть.
    #[test]
    fn apply_stream_ech_opts_object_preserved() {
        let raw = serde_json::json!({
            "type": "tcp", "security": "tls",
            "ech-opts": {"enable": true, "config": "AAAA"}
        });
        let mut m = Mapping::new();
        apply_stream(&mut m, &raw);
        assert_eq!(
            m[Value::String("ech-opts".into())]["config"].as_str(),
            Some("AAAA")
        );
    }

    /// #5: app-rule с путём → PROCESS-PATH, с именем → PROCESS-NAME.
    #[test]
    fn app_rule_path_vs_name() {
        let by_name = AppRule { exe: "telegram.exe".into(), action: "proxy".into(), comment: None };
        let by_path = AppRule {
            exe: r"C:\Program Files\App\app.exe".into(),
            action: "direct".into(),
            comment: None,
        };
        assert_eq!(
            app_rule_to_mihomo(&by_name).unwrap(),
            "PROCESS-NAME,telegram.exe,PROXY"
        );
        assert_eq!(
            app_rule_to_mihomo(&by_path).unwrap(),
            r"PROCESS-PATH,C:\Program Files\App\app.exe,DIRECT"
        );
    }

    /// #4: ipv6=true включает ipv6 в dns; #3: custom_dns — высший приоритет.
    #[test]
    fn build_dns_ipv6_and_custom_dns() {
        let custom = vec!["https://my.dns/q".to_string(), "1.0.0.1".to_string()];
        let dns = build_dns(None, None, true, Some(&custom));
        assert_eq!(dns["ipv6"].as_bool(), Some(true));
        assert_eq!(dns["nameserver"][0].as_str(), Some("https://my.dns/q"));
        assert_eq!(dns["nameserver"][1].as_str(), Some("1.0.0.1"));
        // bootstrap всё ещё дефолтный (custom не обязан быть plain-IP).
        assert!(dns
            .get(Value::String("default-nameserver".into()))
            .is_some());
    }

    /// #4 (full-profile): ipv6=true override; #3: custom_dns перетирает
    /// nameserver, но сохраняет провайдерскую policy.
    #[test]
    fn patch_ipv6_and_custom_dns_override() {
        let yaml = "ipv6: false\ndns:\n  nameserver: [https://prov/q]\n  nameserver-policy:\n    \"geosite:ru\": [1.1.1.1]\nproxies: []\nproxy-groups:\n  - {name: s, type: select, proxies: []}\n";
        let mut p = base_patch();
        p.ipv6 = true;
        let custom = vec!["8.8.4.4".to_string()];
        p.custom_dns = Some(&custom);
        let cfg = patch_full_yaml(yaml, &p).expect("ok");
        let v: Value = serde_yaml::from_str(&cfg.yaml).unwrap();
        let m = v.as_mapping().unwrap();
        assert_eq!(m["ipv6"].as_bool(), Some(true));
        let dns = m["dns"].as_mapping().unwrap();
        assert_eq!(dns["ipv6"].as_bool(), Some(true));
        assert_eq!(dns["nameserver"][0].as_str(), Some("8.8.4.4"));
        // policy провайдера сохранена.
        assert!(dns
            .get(Value::String("nameserver-policy".into()))
            .and_then(|v| v.as_mapping())
            .is_some_and(|p| p.contains_key(Value::String("geosite:ru".into()))));
    }

    /// 11.F: detect_proxy_target — приоритет MATCH > первая группа > GLOBAL.
    #[test]
    fn detect_proxy_target_priority() {
        // 1. из MATCH
        let m: Mapping = serde_yaml::from_str(
            "rules:\n  - MATCH,my-group\nproxy-groups:\n  - name: other\n",
        )
        .unwrap();
        assert_eq!(detect_proxy_target(&m), "my-group");
        // 2. из первой группы (нет MATCH)
        let m: Mapping =
            serde_yaml::from_str("proxy-groups:\n  - name: first\n  - name: second\n").unwrap();
        assert_eq!(detect_proxy_target(&m), "first");
        // 3. fallback
        let m: Mapping = serde_yaml::from_str("proxies: []\n").unwrap();
        assert_eq!(detect_proxy_target(&m), "GLOBAL");
    }

    /// 8.F: provider's authentication перезаписывается нашим SOCKS-auth.
    #[test]
    fn patch_overrides_authentication() {
        let yaml = r#"
authentication:
  - bad-user:bad-pass
  - other-user:other-pass
proxies: []
proxy-groups:
  - name: select
    type: select
    proxies: []
"#;
        let cfg = patch_full_yaml(yaml, &base_patch()).expect("patch ok");
        let v: Value = serde_yaml::from_str(&cfg.yaml).unwrap();
        let auth = v.as_mapping().unwrap()["authentication"]
            .as_sequence()
            .unwrap();
        assert_eq!(auth.len(), 1);
        assert_eq!(auth[0].as_str(), Some("kwik:secret-pass"));
    }

    /// 0.1.2: реальная подписка пользователя с load-balance подгруппой,
    /// select-обёрткой, rule-providers и сложными OR-правилами + emoji
    /// в имени группы. Регрессия — раньше тестов с такой структурой
    /// не было, и можно было поломать парсинг при правке patch_full_yaml.
    #[test]
    fn patches_complex_real_world_subscription() {
        let yaml = r#"
mixed-port: 7890
mode: rule
log-level: info
tun:
  enable: true
  stack: mixed
  auto-route: true
dns:
  enable: true
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  nameserver:
    - 1.1.1.1
proxies:
  - {name: 'germany', type: vless, server: de.x.com, port: 443}
  - {name: 'latvia',  type: vless, server: lv.x.com, port: 443}
proxy-groups:
  - name: "🇪🇺  Fastest"
    type: load-balance
    url: https://cp.cloudflare.com/generate_204
    interval: 600
    strategy: consistent-hashing
    proxies:
      - germany
      - latvia
  - name: 'ariyvpn'
    type: 'select'
    proxies:
      - "🇪🇺  Fastest"
rule-providers:
  geosite-ru:
    type: http
    behavior: domain
    format: mrs
    url: https://github.com/MetaCubeX/meta-rules-dat/raw/meta/geo/geosite/category-ru.mrs
    path: ./geosite-ru.mrs
    interval: 86400
  geoip-ru:
    type: http
    behavior: ipcidr
    format: mrs
    url: https://github.com/MetaCubeX/meta-rules-dat/raw/meta/geo/geoip/ru.mrs
    path: ./geoip-ru.mrs
    interval: 86400
rules:
  - IP-CIDR,3.68.63.139/32,DIRECT,no-resolve
  - PROCESS-NAME,FortiClient.exe,DIRECT
  - DOMAIN-SUFFIX,sportlevel.com,DIRECT
  - OR,((RULE-SET,geosite-ru),(RULE-SET,geoip-ru)),DIRECT
  - MATCH,ariyvpn
"#;
        let cfg = patch_full_yaml(yaml, &base_patch())
            .expect("реальная подписка должна патчиться");
        // log-level: info в подписке — сохраняется как есть. Только
        // silent/missing мы форсим в warning.
        assert!(
            cfg.yaml.contains("log-level: info"),
            "log-level=info из подписки должен сохраниться"
        );
        // tun.enable должно быть false — наш tun2socks pipeline активный
        assert!(cfg.yaml.contains("enable: false"));
        // rule-providers должны сохраниться целиком
        assert!(cfg.yaml.contains("geosite-ru"));
        assert!(cfg.yaml.contains("geoip-ru"));
        assert!(cfg.yaml.contains("category-ru.mrs"));
        // rules в исходном порядке (мы только префиксы добавляем)
        let pos_iprule = cfg.yaml.find("3.68.63.139").expect("ip-cidr rule");
        let pos_match = cfg.yaml.find("MATCH,ariyvpn").expect("match rule");
        assert!(pos_iprule < pos_match, "порядок rules сохраняется");
        // proxy-group с emoji в имени — должна пройти YAML round-trip
        // без потери символов
        assert!(cfg.yaml.contains("🇪🇺"));
        // OR-rule с rule-set'ами должно сохраниться как строка
        assert!(cfg.yaml.contains("RULE-SET,geosite-ru"));
        // ariyvpn group должна сохраниться
        assert!(cfg.yaml.contains("ariyvpn"));
    }

    /// 13.L: `use_builtin_tun=true` сохраняет `tun.enable: true` из
    /// подписки и форсит `auto-detect-interface: true`. Это позволяет
    /// mihomo самостоятельно создать WinTUN, поставить маршруты, и
    /// корректно bypass'ить собственный TUN на DIRECT-outbound'е.
    #[test]
    fn patch_keeps_tun_enabled_for_builtin_tun_mode() {
        let yaml = r#"
proxies: []
proxy-groups:
  - name: select
    type: select
    proxies: []
tun:
  enable: true
  stack: mixed
  auto-route: true
"#;
        let mut p = base_patch();
        p.use_builtin_tun = true;
        let cfg = patch_full_yaml(yaml, &p).expect("patch ok");
        let v: Value = serde_yaml::from_str(&cfg.yaml).unwrap();
        let tun = v.as_mapping().unwrap()["tun"].as_mapping().unwrap();
        assert_eq!(tun["enable"], Value::Bool(true), "tun.enable=true сохранён");
        assert_eq!(
            tun["auto-detect-interface"],
            Value::Bool(true),
            "auto-detect-interface форсирован для bypass-а DIRECT"
        );
    }

    /// 13.L: `use_builtin_tun=true` для подписки БЕЗ tun-секции —
    /// собираем минимальную с разумными дефолтами. mihomo не должен
    /// упасть на отсутствии `tun:` блока когда мы хотим built-in.
    #[test]
    fn patch_synthesizes_tun_for_builtin_when_missing() {
        let yaml = r#"
proxies: []
proxy-groups:
  - name: select
    type: select
    proxies: []
"#;
        let mut p = base_patch();
        p.use_builtin_tun = true;
        let cfg = patch_full_yaml(yaml, &p).expect("patch ok");
        let v: Value = serde_yaml::from_str(&cfg.yaml).unwrap();
        let tun = v.as_mapping().unwrap()["tun"].as_mapping().unwrap();
        assert_eq!(tun["enable"], Value::Bool(true));
        assert_eq!(tun["auto-detect-interface"], Value::Bool(true));
        assert_eq!(tun["auto-route"], Value::Bool(true));
        // Синтезированный tun должен hijack'ить DNS (защита от leak).
        assert!(tun.contains_key("dns-hijack"));
        // Без маскировки device не задаётся (mihomo default).
        assert!(!tun.contains_key("device"));
    }

    /// 12.E: синтезированный tun-блок берёт замаскированное имя адаптера
    /// из `tun_device`, перезаписывая (тут — задавая) `tun.device`.
    #[test]
    fn patch_synthesized_tun_uses_masked_device() {
        let yaml = "proxies: []\n";
        let mut p = base_patch();
        p.use_builtin_tun = true;
        p.tun_device = Some("wlan137");
        let cfg = patch_full_yaml(yaml, &p).expect("patch ok");
        let v: Value = serde_yaml::from_str(&cfg.yaml).unwrap();
        let tun = v.as_mapping().unwrap()["tun"].as_mapping().unwrap();
        assert_eq!(tun["device"].as_str(), Some("wlan137"));
    }

    /// 12.E: для подписки с уже существующей tun-секцией маскировка
    /// перезаписывает провайдерский `device`.
    #[test]
    fn patch_existing_tun_overrides_device_when_masking() {
        let yaml = "proxies: []\ntun:\n  enable: false\n  device: Meta\n";
        let mut p = base_patch();
        p.use_builtin_tun = true;
        p.tun_device = Some("Ethernet 9");
        let cfg = patch_full_yaml(yaml, &p).expect("patch ok");
        let v: Value = serde_yaml::from_str(&cfg.yaml).unwrap();
        let tun = v.as_mapping().unwrap()["tun"].as_mapping().unwrap();
        assert_eq!(tun["device"].as_str(), Some("Ethernet 9"));
        assert_eq!(tun["enable"], Value::Bool(true));
    }

    /// 12.E: имя адаптера из одного из ожидаемых наборов и непустое.
    #[test]
    fn masked_tun_name_is_plausible() {
        let n = masked_tun_name();
        assert!(!n.is_empty());
        assert!(
            n.starts_with("wlan")
                || n.starts_with("Local Area Connection ")
                || n.starts_with("Ethernet "),
            "неожиданное имя: {n}"
        );
    }
}
