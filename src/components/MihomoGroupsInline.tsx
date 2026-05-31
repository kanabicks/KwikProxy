import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { useVpnStore } from "../stores/vpnStore";
import {
  useSubscriptionStore,
  type ProxyEntry,
} from "../stores/subscriptionStore";
import { useSettingsStore } from "../stores/settingsStore";
import { showToast } from "../stores/toastStore";
import { FlagIcon } from "../lib/flags";

/**
 * 8.F (UI v2) — Inline-вид прокси-групп Mihomo на главном экране.
 *
 * Заменяет модальную ProxiesPanel когда выбран mihomo-профиль (полный
 * YAML с `proxy-groups`/`rules`). Отрисовывает FlClash-style сетку
 * карточек: каждая нода (страна) — отдельная карточка, активная
 * подсвечена.
 *
 * **До connect:** данные берутся из `selectedServer.raw.{groups, proxies}`
 * — статика из YAML подписки. Клик по карточке записывает её в
 * `settings.preferredMihomoNodes[group]`. Latency не показываем (mihomo
 * ещё не запущен — нечего опрашивать). При connect `vpnStore` через
 * external-controller применит preferred-выбор сразу после старта.
 *
 * **После connect:** polling `mihomo_proxies` каждые 3 сек. Карточки
 * показывают live latency из `history`. Клик по карточке = мгновенное
 * переключение через external-controller + сохранение как preferred
 * (на следующий перезапуск VPN).
 */

type ProxyInfo = {
  name: string;
  type: string;
  now?: string | null;
  all: string[];
  history: { time: string; delay: number }[];
  udp: boolean;
};

type ProxiesSnapshot = { proxies: Record<string, ProxyInfo> };

const GROUP_TYPES = new Set([
  "Selector",
  "URLTest",
  "Fallback",
  "LoadBalance",
  "Relay",
]);

const YAML_TO_API_GROUP_TYPE: Record<string, string> = {
  select: "Selector",
  "url-test": "URLTest",
  fallback: "Fallback",
  "load-balance": "LoadBalance",
  relay: "Relay",
};

/** Убрать эмодзи (флаги, пиктограммы, символы, variation-selector, ZWJ) из
 *  отображаемого имени ноды/группы. Имена в подписках часто содержат
 *  флаги вроде «NJ 🇩🇪 Германия | 28» — выглядит мусорно, чистим до
 *  «NJ Германия | 28». ВАЖНО: применять только для ОТОБРАЖЕНИЯ — реальное
 *  имя (ключ) нужно сохранять для mihomo API (select/delay). */
const EMOJI_RE =
  /[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{25A0}-\u{25FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu;
function cleanLabel(name: string): string {
  return name.replace(EMOJI_RE, "").replace(/\s{2,}/g, " ").trim() || name;
}

function lastDelay(p: ProxyInfo | undefined): number | null {
  if (!p?.history?.length) return null;
  const v = p.history[p.history.length - 1].delay;
  return v > 0 ? v : null;
}

/** Цвет latency-бэйджа: зелёный <200мс / жёлтый <500 / оранжевый <1000 /
 *  красный либо timeout. Возвращает CSS-класс из App.css. */
function delayClass(d: number | null): string {
  if (d == null) return "delay-none";
  if (d < 200) return "delay-good";
  if (d < 500) return "delay-ok";
  if (d < 1000) return "delay-slow";
  return "delay-bad";
}

function buildStaticSnapshot(
  rawGroups: Array<{ name: string; type: string; proxies: string[] }>,
  rawProxies: Array<{ name: string; type: string }>
): ProxiesSnapshot {
  const out: Record<string, ProxyInfo> = {};
  for (const p of rawProxies) {
    out[p.name] = {
      name: p.name,
      type: p.type,
      now: null,
      all: [],
      history: [],
      udp: false,
    };
  }
  for (const g of rawGroups) {
    const apiType = YAML_TO_API_GROUP_TYPE[g.type] ?? "Selector";
    out[g.name] = {
      name: g.name,
      type: apiType,
      now: g.proxies[0] ?? null,
      all: g.proxies,
      history: [],
      udp: false,
    };
  }
  return { proxies: out };
}

/** Опционально передаваемый source — конкретный mihomo-profile entry.
 *  Когда задан, MihomoGroupsInline отрисовывает группы из него (а не
 *  из global state.servers по selectedIndex). Используется внутри
 *  SubscriptionCard expand'а для multi-subscription, чтобы группы
 *  каждой подписки рендерились в её карточке без swap'а primary.
 *  `onActivate` дёргается при click по карточке-ноде Selector-группы
 *  (если задан) — там SubscriptionCard переключает primary на эту
 *  подписку перед сохранением preferredNode.
 *  `showSelection` — рендерить ли визуально active-ноду (галку, подсветку).
 *  В multi-sub карточки non-primary подписок передают false, чтобы
 *  глобально выделялся только один (active) сервер, как просил юзер. */
export type MihomoGroupsInlineProps = {
  entry?: ProxyEntry;
  onActivate?: () => void | Promise<void>;
  showSelection?: boolean;
  /** Pre-connect TCP-пинги нод (имя → мс|null). Когда заданы и движок
   *  ещё не запущен — показываем их на карточках (до connect живого
   *  latency нет). После connect используется live-latency из поллинга. */
  staticPings?: Record<string, number | null>;
};

export function MihomoGroupsInline({
  entry: entryProp,
  onActivate,
  showSelection = true,
  staticPings,
}: MihomoGroupsInlineProps = {}) {
  const { t } = useTranslation();
  const status = useVpnStore((s) => s.status);
  const selectedIndex = useVpnStore((s) => s.selectedIndex);
  const servers = useSubscriptionStore((s) => s.servers);
  const preferredNodes = useSettingsStore((s) => s.preferredMihomoNodes);
  const setSetting = useSettingsStore((s) => s.set);

  const liveMode = status === "running" && !entryProp;

  const typeLabel = (apiType: string): string => {
    const known = ["Selector", "URLTest", "Fallback", "LoadBalance", "Relay"];
    if (known.includes(apiType))
      return t(`mihomoGroups.typeLabels.${apiType}`);
    return apiType.toLowerCase();
  };

  const delayLabel = (d: number | null): string =>
    d == null ? "—" : t("mihomoGroups.delayUnit", { value: d });

  const [snap, setSnap] = useState<ProxiesSnapshot | null>(null);
  const [busyTesting, setBusyTesting] = useState<string | null>(null);
  // По умолчанию свёрнуты группы, в которых пользователь руками ничего
  // не выбирает — load-balance/url-test/fallback/relay. Они показывают
  // статус, но карточки нод там работают как «инфо», не как кнопки —
  // нет смысла занимать ими экран. Selector-группы (то что пользователь
  // реально кликает) — раскрыты сразу.
  const [autoCollapsed, setAutoCollapsed] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const refresh = async () => {
    try {
      const data = await invoke<ProxiesSnapshot>("mihomo_proxies");
      setSnap(data);
    } catch {
      // 503 «mihomo не запущен» — нормально между connect-disconnect, молчим
    }
  };

  useEffect(() => {
    if (liveMode) {
      void refresh();
      const t = window.setInterval(() => void refresh(), 3000);
      return () => window.clearInterval(t);
    }
    // Source приоритет: entryProp (multi-sub: рендерим группы конкретной
    // подписки) → selectedIndex (legacy single-sub mode).
    const entry =
      entryProp ?? (selectedIndex !== null ? servers[selectedIndex] : null);
    if (!entry || entry.protocol !== "mihomo-profile") {
      setSnap(null);
      return;
    }
    const raw = entry.raw as
      | {
          groups?: Array<{ name: string; type: string; proxies: string[] }>;
          proxies?: Array<{ name: string; type: string }>;
        }
      | undefined;
    setSnap(buildStaticSnapshot(raw?.groups ?? [], raw?.proxies ?? []));
  }, [liveMode, selectedIndex, servers, entryProp]);

  const groups = useMemo(() => {
    if (!snap) return [];
    // Показываем ВСЕ proxy-группы (как FlClashX): selector + url-test +
    // fallback + load-balance + relay, кроме служебной GLOBAL. Порядок —
    // как в конфиге (Object.values сохраняет порядок вставки snapshot'а).
    // Каждая группа — отдельная сворачиваемая секция с выбранной нодой в
    // шапке; auto-типы по дефолту свёрнуты (см. autoCollapsed ниже).
    return Object.values(snap.proxies).filter(
      (p) => GROUP_TYPES.has(p.type) && p.name !== "GLOBAL"
    );
  }, [snap]);

  // Один раз после первой загрузки групп — сворачиваем все
  // авто-управляемые root-группы (если они вышли в root, потому что
  // у пользователя нет Selector над ними). Дальше уважаем
  // пользовательские toggle.
  useEffect(() => {
    if (autoCollapsed || groups.length === 0) return;
    const auto = new Set<string>();
    for (const g of groups) {
      if (g.type !== "Selector") auto.add(g.name);
    }
    if (auto.size > 0) setCollapsed(auto);
    setAutoCollapsed(true);
  }, [groups, autoCollapsed]);

  const setPreferred = (group: string, name: string) => {
    setSetting("preferredMihomoNodes", { ...preferredNodes, [group]: name });
  };

  const onCardClick = async (group: string, type: string, name: string) => {
    if (type !== "Selector") {
      // URL-test / fallback / load-balance — нода выбирается автоматом
      // движком. Пользовательский pin не имеет смысла.
      showToast({
        kind: "info",
        title: t("mihomoGroups.toast.autoSelectTitle"),
        message: t("mihomoGroups.toast.autoSelectMessage", {
          type: typeLabel(type),
        }),
        durationMs: 3000,
      });
      return;
    }
    // 0.3.0: если рендеримся внутри карточки non-primary subscription
    // (entryProp задан + onActivate задан) — сначала активируем эту
    // подписку (swap primary), затем сохраняем preferredNode для неё.
    if (entryProp && onActivate) {
      await onActivate();
    }
    setPreferred(group, name);
    if (!liveMode) {
      // Toast «выбрано: applies on connect» удалён — галочка ✓ на
      // карточке уже даёт visual feedback, сообщение избыточное.
      return;
    }
    try {
      await invoke("mihomo_select_proxy", { group, name });
      void refresh();
    } catch (e) {
      showToast({
        kind: "error",
        title: t("mihomoGroups.toast.switchFailedTitle"),
        message: String(e),
      });
    }
  };

  const onTestGroup = async (groupName: string) => {
    if (!liveMode) return;
    setBusyTesting(groupName);
    try {
      await invoke("mihomo_delay_test", { name: groupName });
      void refresh();
    } catch (e) {
      showToast({
        kind: "error",
        title: t("mihomoGroups.toast.testFailedTitle"),
        message: String(e),
      });
    } finally {
      setBusyTesting(null);
    }
  };

  const toggleCollapse = (name: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  if (groups.length === 0) {
    // Подписка распознана как mihomo-profile, но в YAML нет групп —
    // редкий случай. Скрываем секцию полностью, пользователь увидит
    // только обычный server-pill «Профиль Mihomo» в ServerSelector.
    return null;
  }

  return (
    <div className="mihomo-groups">
      {groups.map((g) => {
        const memberInfos = g.all.map((n) => snap!.proxies[n]).filter(Boolean);
        const liveActive = g.now ?? null;
        const preferredName = preferredNodes[g.name];
        // 0.3.0: showSelection=false (multi-sub non-primary card) — не
        // подсвечиваем «активную» ноду, чтобы globally была только одна
        // visual selection (на active subscription).
        //
        // Подсветка = preferred (намерение пользователя) ВСЕГДА, если он
        // задан — и до, и после connect. Раньше в live-режиме брали g.now,
        // но при старте mihomo держит активной ПЕРВУЮ ноду группы, пока
        // vpnStore не применит preferred через select_proxy — из-за этого
        // подсветка на доли секунды прыгала на первую ноду (напр. Германию)
        // и возвращалась. preferred сходится с g.now (ручное переключение
        // обновляет и preferred), а для auto-групп (url-test/fallback) без
        // preferred — fallback на live `now`.
        const displayActive = !showSelection
          ? null
          : preferredName ?? liveActive;
        const isCollapsed = collapsed.has(g.name);
        const isSelector = g.type === "Selector";
        return (
          <section key={g.name} className="mihomo-group">
            <header
              className="mihomo-group-head"
              onClick={() => toggleCollapse(g.name)}
            >
              <div className="mihomo-group-title-block">
                <div className="mihomo-group-title">
                  <FlagIcon name={g.name} className="mihomo-group-flag" />
                  <span className="flag-label">{cleanLabel(g.name)}</span>
                </div>
                <div className="mihomo-group-sub">
                  {/* Для Selector скрываем typeLabel («выбор»), потому
                      что «выбрана: X» сам по себе сигнализирует тип —
                      иначе тавтология «выбор · выбрана: X». Для
                      auto-типов (URL-test/Fallback) показываем тип. */}
                  {!isSelector && (
                    <>
                      <span className="mihomo-group-type">
                        {typeLabel(g.type)}
                      </span>
                      <span className="dot-sep">·</span>
                    </>
                  )}
                  {displayActive && (
                    <>
                      <span className="mihomo-group-active">
                        {liveMode
                          ? t("mihomoGroups.active")
                          : t("mihomoGroups.selected")}
                        :{" "}
                        <FlagIcon
                          name={displayActive}
                          className="mihomo-active-flag"
                        />
                        {cleanLabel(displayActive)}
                      </span>
                      <span className="dot-sep">·</span>
                    </>
                  )}
                  <span>
                    {t("mihomoGroups.nodeCount", { count: memberInfos.length })}
                  </span>
                  {!isSelector && (
                    <>
                      <span className="dot-sep">·</span>
                      <span style={{ opacity: 0.7 }}>
                        {t("mihomoGroups.auto")}
                      </span>
                    </>
                  )}
                </div>
              </div>
              {liveMode && (
                <button
                  type="button"
                  className="mihomo-test-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    void onTestGroup(g.name);
                  }}
                  disabled={busyTesting === g.name}
                  title={t("mihomoGroups.testTitle")}
                >
                  {busyTesting === g.name ? "…" : t("mihomoGroups.test")}
                </button>
              )}
              <span className="mihomo-group-arrow">
                {isCollapsed ? "▸" : "▾"}
              </span>
            </header>

            {/* Сетка всегда смонтирована — сворачивание идёт через CSS
                (grid-template-rows 1fr↔0fr), чтобы была плавная анимация
                высоты и opacity, а не мгновенное появление/исчезновение. */}
            <div
              className={`mihomo-grid-wrap${isCollapsed ? " is-collapsed" : ""}`}
            >
              <div className="mihomo-grid">
                {memberInfos.map((m) => {
                  // live-режим — latency из поллинга; до connect — из
                  // переданных pre-connect TCP-пингов (staticPings).
                  const d = liveMode
                    ? lastDelay(m)
                    : staticPings?.[m.name] ?? null;
                  const showDelay = liveMode || staticPings != null;
                  const isActive = m.name === displayActive;
                  return (
                    <button
                      type="button"
                      key={m.name}
                      className={
                        "mihomo-card" +
                        (isActive ? " is-active" : "") +
                        (isSelector ? "" : " is-readonly")
                      }
                      onClick={() => void onCardClick(g.name, g.type, m.name)}
                      title={
                        isSelector
                          ? liveMode
                            ? t("mihomoGroups.cardTitleLiveSelector")
                            : t("mihomoGroups.cardTitlePreferredSelector")
                          : t("mihomoGroups.cardTitleAuto")
                      }
                    >
                      <div className="mihomo-card-name" title={m.name}>
                        <FlagIcon
                          name={m.name}
                          className="mihomo-card-flag"
                          placeholder
                        />
                        <span className="flag-label">{cleanLabel(m.name)}</span>
                      </div>
                      <div className="mihomo-card-meta">
                        <span className="mihomo-card-proto">
                          {m.type}
                        </span>
                        {showDelay && (
                          <span className={"mihomo-card-delay " + delayClass(d)}>
                            {delayLabel(d)}
                          </span>
                        )}
                      </div>
                      {isActive && <span className="mihomo-card-check">✓</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
}
