import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { useVpnStore, findSelectedIndexByName } from "../stores/vpnStore";
import {
  useSubscriptionStore,
  type ProxyEntry,
} from "../stores/subscriptionStore";
import { useSettingsStore } from "../stores/settingsStore";
import { showToast } from "../stores/toastStore";
import { Welcome } from "./Welcome";
import { ModeSegment } from "./ModeSegment";
import { MihomoGroupsInline } from "./MihomoGroupsInline";
import { FlagIcon } from "../lib/flags";
import { ConnectionDashboard } from "./ConnectionDashboard";
import { AnnounceBanner } from "./AnnounceBanner";
import { SubStrip, NodePingOverview, type PingNode } from "./HomeExtras";
import {
  PowerIcon,
  SettingsIcon,
  RefreshIcon,
  PulseIcon,
  TrashIcon,
  PlusIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from "./icons";

/**
 * Главный экран «Soft / cards».
 *
 * Узкое окно — телефонная раскладка (тёмный верх → белая шторка → док).
 * Десктоп — двухпанельная карточка (слева тёмная панель, справа список).
 *
 * Быстрые действия активной подписки (обновить / тест пинга) — в шапке
 * списка на главном экране. Список подписок (тап по чипу) — только
 * переключение + удаление + добавить.
 */
export function SoftHome({ onOpenSettings }: { onOpenSettings: () => void }) {
  const status = useVpnStore((s) => s.status);
  const mode = useVpnStore((s) => s.mode);
  const setMode = useVpnStore((s) => s.setMode);
  const selectedIndex = useVpnStore((s) => s.selectedIndex);
  const selectServer = useVpnStore((s) => s.selectServer);
  const connect = useVpnStore((s) => s.connect);
  const disconnect = useVpnStore((s) => s.disconnect);
  const tunOnlyStrict = useSettingsStore((s) => s.tunOnlyStrict);
  const sortMode = useSettingsStore((s) => s.sort);

  const servers = useSubscriptionStore((s) => s.servers);
  const pings = useSubscriptionStore((s) => s.pings);
  const meta = useSubscriptionStore((s) => s.meta);
  const loading = useSubscriptionStore((s) => s.loading);
  const pingsLoading = useSubscriptionStore((s) => s.pingsLoading);
  const subscriptions = useSubscriptionStore((s) => s.subscriptions);
  const primaryId = useSubscriptionStore((s) => s.primaryId);
  const setPrimaryId = useSubscriptionStore((s) => s.setPrimaryId);
  const fetchSubscription = useSubscriptionStore((s) => s.fetchSubscription);
  const pingAll = useSubscriptionStore((s) => s.pingAll);

  const [sheet, setSheet] = useState<null | "pick" | "add">(null);
  // Фаза закрытия: проигрываем exit-анимацию, затем размонтируем.
  const [closing, setClosing] = useState(false);
  // Идёт delay-test групп mihomo (для спиннера на кнопке пинга).
  const [mihomoTesting, setMihomoTesting] = useState(false);
  // Pre-connect TCP-пинги нод mihomo-профиля (имя → мс|null). До подключения
  // живого latency нет — показываем эти на карточках сетки.
  const [mihomoPings, setMihomoPings] = useState<Record<string, number | null>>(
    {}
  );
  const closeSheet = () => {
    setClosing(true);
    window.setTimeout(() => {
      setSheet(null);
      setClosing(false);
    }, 240);
  };

  const isRunning = status === "running";
  const isBusy = status === "starting" || status === "stopping";
  const selected = selectedIndex !== null ? servers[selectedIndex] : null;
  const activeSub = subscriptions.find((s) => s.id === primaryId) ?? null;
  // Full-mihomo подписка (YAML с proxy-groups) приходит одной синтетической
  // записью protocol="mihomo-profile". Её ноды разворачиваем сеткой через
  // MihomoGroupsInline (страновые карточки), а не показываем одинокую строку
  // «Профиль Mihomo».
  const isMihomoProfile = servers.some((s) => s.protocol === "mihomo-profile");

  // Данные для обзора задержек (правая панель). Для mihomo-профиля —
  // ноды профиля + pre-connect TCP-пинги; для URI — серверы + pings.
  const pingNodes: PingNode[] = useMemo(() => {
    if (isMihomoProfile) {
      const profile = servers.find((s) => s.protocol === "mihomo-profile");
      return nodeListOf(profile).map((n) => ({
        name: n.name,
        ping: mihomoPings[n.name] ?? null,
      }));
    }
    return servers.map((s, i) => ({ name: s.name, ping: pings[i] ?? null }));
  }, [isMihomoProfile, servers, pings, mihomoPings]);

  // Пинг для mihomo-профиля.
  //  • ДО connect: TCP-пинг адресов нод (server:port из raw.proxies) через
  //    backend `ping_mihomo_nodes` — как обычный server-list. Результат
  //    кладём в mihomoPings → сетка показывает его на карточках.
  //  • ПОСЛЕ connect: delay-test нод через external-controller; результат
  //    подхватит MihomoGroupsInline своим 3-сек поллингом (live latency).
  const pingMihomo = async () => {
    if (mihomoTesting) return;
    const profile = servers.find((s) => s.protocol === "mihomo-profile");
    setMihomoTesting(true);
    try {
      if (isRunning) {
        // live: имена берём из движка, гоняем delay-test (пул 12).
        const SKIP = new Set([
          "GLOBAL",
          "DIRECT",
          "REJECT",
          "REJECT-DROP",
          "COMPATIBLE",
          "PASS",
        ]);
        let names: string[] = [];
        try {
          const snap = await invoke<{
            proxies: Record<string, { name: string; type: string }>;
          }>("mihomo_proxies");
          names = Object.values(snap.proxies)
            .filter((p) => !SKIP.has(p.name))
            .map((p) => p.name);
        } catch {
          names = nodeListOf(profile).map((n) => n.name);
        }
        if (names.length === 0) {
          showToast({ kind: "info", title: "Пинг", message: "Нет нод" });
          return;
        }
        const POOL = 12;
        let i = 0;
        const worker = async () => {
          while (i < names.length) {
            const name = names[i++];
            await invoke("mihomo_delay_test", { name }).catch(() => {});
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(POOL, names.length) }, worker)
        );
      } else {
        // pre-connect: TCP-пинг адресов нод.
        const nodes = nodeListOf(profile);
        if (nodes.length === 0) {
          showToast({ kind: "info", title: "Пинг", message: "Нет нод" });
          return;
        }
        const res = await invoke<Array<[string, number | null]>>(
          "ping_mihomo_nodes",
          { nodes }
        );
        const map: Record<string, number | null> = {};
        for (const [name, ms] of res) map[name] = ms;
        setMihomoPings(map);
      }
    } catch (e) {
      showToast({ kind: "error", title: "Пинг", message: String(e) });
    } finally {
      setMihomoTesting(false);
    }
  };

  const toggle = () => {
    if (isBusy) return;
    if (isRunning) void disconnect();
    else if (selectedIndex !== null) void connect();
  };

  // Переключение активной подписки: подменяем legacy servers/meta/pings
  // и заливаем серверы в Rust (set_servers) для connect-by-index.
  // Серверы берутся из кеша подписки (sub.servers) — сетевой fetch при
  // переключении НЕ нужен; он делается один раз при добавлении и далее
  // только по кнопке «обновить» / авто-обновлению.
  const activate = (id: string) => {
    if (id !== primaryId) {
      setPrimaryId(id);
      const sub = useSubscriptionStore.getState().subscriptions.find((s) => s.id === id);
      if (sub) {
        if (sub.servers.length === 0) {
          // Кеша нет (например, добавлена на старой версии без кеша или
          // кеш потёрт) — единственный случай, когда нужен fetch. Дальше
          // серверы лягут в sub.servers + localStorage и переключение
          // станет мгновенным.
          void useSubscriptionStore.getState().fetchSubscriptionById(id);
        } else {
          useSubscriptionStore.setState({
            servers: sub.servers,
            meta: sub.meta,
            pings: sub.pings ?? [],
          });
          void invoke("set_servers", { servers: sub.servers });
          // Восстановление выбора: по имени; если имя из другой подписки
          // не нашлось, а запись одна (full-mihomo «профиль») — авто-выбор,
          // иначе сетка локаций не отрисуется и список выглядит «пустым»
          // (раньше это и заставляло жать «обновить» при каждой смене).
          const idx = findSelectedIndexByName(sub.servers);
          useVpnStore.setState({
            selectedIndex:
              idx >= 0 ? idx : sub.servers.length === 1 ? 0 : null,
          });
          void useSubscriptionStore.getState().pingAll();
        }
      }
    }
    closeSheet();
  };

  let metaTop = isRunning ? "ЗАЩИЩЕНО" : "НЕ ЗАЩИЩЕНО";
  if (meta && meta.total > 0) {
    const leftGb = Math.max(0, (meta.total - meta.used) / 1024 ** 3);
    metaTop = `${leftGb.toFixed(1)} ГБ`;
  }
  const subName = activeSub?.meta?.title?.trim() || meta?.title?.trim() || "Kwik VPN";
  const word = isBusy ? "…" : isRunning ? "Включён" : "Выключен";

  if (servers.length === 0) {
    return (
      <div className="soft soft-empty">
        <aside className="soft-aside">
          <SoftHeader word="Старт" metaTop="—" on={false} />
        </aside>
        <main className="soft-sheet">
          <Welcome />
        </main>
        <SoftDock
          onLeft={onOpenSettings}
          onCenter={() => {}}
          onRight={() => setSheet("add")}
          centerOn={false}
          centerDisabled
        />
        {sheet === "add" && <AddSheet onClose={closeSheet} closing={closing} />}
      </div>
    );
  }

  const connectSub = isRunning
    ? `${selected?.name ?? ""}${
        selectedIndex !== null && pings[selectedIndex] != null
          ? ` · ${pings[selectedIndex]} ms`
          : ""
      }`
    : selected
    ? selected.name
    : "выберите сервер";

  return (
    <div className="soft">
      <aside className="soft-aside">
        <SoftHeader
          word={word}
          metaTop={metaTop}
          subName={subName}
          onPickSub={() => setSheet("pick")}
          on={isRunning}
        />

        <button
          type="button"
          className="soft-connect"
          data-on={isRunning}
          disabled={isBusy || (!isRunning && selectedIndex === null)}
          onClick={toggle}
        >
          <span className="soft-connect-main">
            <span className="soft-connect-title">
              {isBusy
                ? "Подключение…"
                : isRunning
                ? "Подключено"
                : "Подключить"}
            </span>
            <span className="soft-connect-sub">{connectSub}</span>
          </span>
          <span className="soft-connect-arrow" aria-hidden>
            {isRunning ? "■" : <ChevronRightIcon />}
          </span>
        </button>

        {!tunOnlyStrict && (
          <ModeSegment
            mode={mode}
            onChange={setMode}
            disabled={isRunning || isBusy}
          />
        )}

        {/* Дашборд активного соединения — заполняет левую панель когда
            подключён (скорость, график, время сессии, exit-IP). */}
        <ConnectionDashboard />
      </aside>

      <main className="soft-sheet">
        {/* Объявление провайдера (announce-заголовок подписки), если есть. */}
        <AnnounceBanner />
        <div className="soft-sheet-head">
          <span className="soft-sheet-title">
            {isMihomoProfile ? "Локации" : "Серверы"}
          </span>
          <span className="soft-sheet-count">{nodeCountOf(servers)}</span>
          <span className="soft-sheet-spacer" />
          <button
            type="button"
            className={`soft-iconbtn${loading ? " is-spin" : ""}`}
            title="Обновить подписку"
            disabled={loading}
            onClick={() => void fetchSubscription()}
          >
            <RefreshIcon />
          </button>
          {/* Тест пинга. Обычный список — pingAll (ping_servers).
              mihomo-профиль — pingMihomo: до connect TCP-пинг адресов нод,
              после connect — delay-test через external-controller. */}
          <button
            type="button"
            className={`soft-iconbtn${
              (isMihomoProfile ? mihomoTesting : pingsLoading) ? " is-pulse" : ""
            }`}
            title="Тест пинга"
            disabled={isMihomoProfile ? mihomoTesting : pingsLoading}
            onClick={() =>
              isMihomoProfile ? void pingMihomo() : void pingAll()
            }
          >
            <PulseIcon />
          </button>
        </div>

        {/* Сводка подписки — компактной полосой под заголовком «Локации»,
            органично в зоне локаций (а не отдельной плашкой внизу). */}
        <SubStrip />

        {isMihomoProfile ? (
          <div className="soft-rows soft-mihomo">
            <MihomoGroupsInline staticPings={mihomoPings} />
            {/* Обзор задержек — внутри скролла, после сетки нод. */}
            <NodePingOverview nodes={pingNodes} />
          </div>
        ) : (
          <div className="soft-rows">
            {orderServers(servers, pings, sortMode).map((i) => {
              const s = servers[i];
              const ping = pings[i];
              const sel = i === selectedIndex;
              const { label } = splitFlag(s.name);
              return (
                <button
                  key={`${s.subscriptionId ?? "x"}-${s.name}-${i}`}
                  type="button"
                  className="soft-row"
                  data-sel={sel}
                  onClick={() => selectServer(i)}
                >
                  <span className="soft-row-check" aria-hidden />
                  <FlagIcon name={s.name} className="soft-row-flag" placeholder />
                  <span className="soft-row-title">{label}</span>
                  <span className={`soft-row-ping${pingClass(ping)}`}>
                    {ping != null ? `${ping} ms` : "—"}
                  </span>
                </button>
              );
            })}
            <NodePingOverview nodes={pingNodes} />
          </div>
        )}
      </main>

      <SoftDock
        onLeft={onOpenSettings}
        onCenter={toggle}
        onRight={() => setSheet("add")}
        centerOn={isRunning}
        centerDisabled={!isRunning && selectedIndex === null}
      />

      {sheet === "pick" && (
        <PickSheet
          activeId={primaryId}
          onPick={activate}
          onAdd={() => setSheet("add")}
          onClose={closeSheet}
          closing={closing}
        />
      )}
      {sheet === "add" && <AddSheet onClose={() => setSheet(null)} />}
    </div>
  );
}

function SoftHeader({
  word,
  metaTop,
  subName,
  onPickSub,
  on,
}: {
  word: string;
  metaTop: string;
  subName?: string;
  onPickSub?: () => void;
  on: boolean;
}) {
  return (
    <header className="soft-head">
      <div className={`soft-head-word${on ? " on" : ""}`}>
        <span>{word}</span>
        <span className="dot" />
      </div>
      <div className="soft-head-meta">
        <div className="soft-head-meta-top">{metaTop}</div>
        {subName &&
          (onPickSub ? (
            <button type="button" className="soft-subchip" onClick={onPickSub}>
              <span>{subName}</span>
              <ChevronDownIcon />
            </button>
          ) : (
            <div className="soft-head-meta-sub">{subName}</div>
          ))}
      </div>
    </header>
  );
}

function SoftDock({
  onLeft,
  onCenter,
  onRight,
  centerOn,
  centerDisabled,
}: {
  onLeft: () => void;
  onCenter: () => void;
  onRight: () => void;
  centerOn: boolean;
  centerDisabled?: boolean;
}) {
  return (
    <div className="soft-dock">
      <button type="button" className="soft-dock-btn" onClick={onLeft} aria-label="настройки">
        <SettingsIcon />
      </button>
      <button
        type="button"
        className="soft-dock-btn soft-dock-center"
        data-on={centerOn}
        disabled={centerDisabled}
        onClick={onCenter}
        aria-label="питание"
      >
        <PowerIcon />
      </button>
      <button type="button" className="soft-dock-btn" onClick={onRight} aria-label="добавить">
        <PlusIcon />
      </button>
    </div>
  );
}

/** Менеджер подписок: переключение (тап), удаление, добавление.
 *  Быстрые действия (обновить/пинг) живут на главном экране. */
function PickSheet({
  activeId,
  onPick,
  onAdd,
  onClose,
  closing,
}: {
  activeId: string | null;
  onPick: (id: string) => void;
  onAdd: () => void;
  onClose: () => void;
  closing?: boolean;
}) {
  const subscriptions = useSubscriptionStore((s) => s.subscriptions);
  const removeSubscription = useSubscriptionStore((s) => s.removeSubscription);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  return (
    <div
      className={`soft-sheet-overlay${closing ? " is-closing" : ""}`}
      onClick={onClose}
    >
      <div className="soft-bottomsheet" onClick={(e) => e.stopPropagation()}>
        <div className="soft-bs-grip" />
        <div className="soft-bs-title">Подписки</div>
        <div className="soft-pick-list">
          {subscriptions.map((s, i) => {
            const active = s.id === activeId;
            const title = s.meta?.title?.trim() || `Подписка ${i + 1}`;
            return (
              <div key={s.id} className={`soft-pick-card${active ? " is-active" : ""}`}>
                <button
                  type="button"
                  className="soft-pick-main"
                  onClick={() => onPick(s.id)}
                >
                  <span className="soft-pick-head">
                    <span className="soft-pick-radio" aria-hidden />
                    <span className="soft-pick-name">{title}</span>
                    {active && <span className="soft-pick-badge">активна</span>}
                  </span>
                  <span className="soft-pick-meta">
                    {trafficLabel(s.meta)} · {nodeCountOf(s.servers)} серв.
                  </span>
                </button>
                {confirmId === s.id ? (
                  <div className="soft-pick-confirm">
                    <button type="button" onClick={() => setConfirmId(null)}>
                      отмена
                    </button>
                    <button
                      type="button"
                      className="is-danger"
                      onClick={() => {
                        setConfirmId(null);
                        void removeSubscription(s.id);
                      }}
                    >
                      удалить
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="soft-pick-del"
                    title="Удалить подписку"
                    onClick={() => setConfirmId(s.id)}
                  >
                    <TrashIcon />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <button type="button" className="soft-bs-add" onClick={onAdd}>
          <PlusIcon />
          <span>добавить подписку</span>
        </button>
      </div>
    </div>
  );
}

/** Оверлей добавления подписки. */
function AddSheet({
  onClose,
  closing,
}: {
  onClose: () => void;
  closing?: boolean;
}) {
  const { t } = useTranslation();
  const addSubscription = useSubscriptionStore((s) => s.addSubscription);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    const u = url.trim();
    if (!u || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await addSubscription(u);
      onClose();
    } catch (e) {
      setErr(String(e));
      setBusy(false);
    }
  };

  return (
    <div
      className={`soft-sheet-overlay${closing ? " is-closing" : ""}`}
      onClick={onClose}
    >
      <div className="soft-bottomsheet" onClick={(e) => e.stopPropagation()}>
        <div className="soft-bs-grip" />
        <div className="soft-bs-title">{t("welcome.title")}</div>
        <input
          className="soft-bs-input"
          type="url"
          inputMode="url"
          autoFocus
          placeholder="https://…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        {err && <div className="soft-bs-err">{err}</div>}
        <div className="soft-bs-actions">
          <button type="button" className="soft-bs-cancel" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="soft-bs-go"
            disabled={busy || !url.trim()}
            onClick={submit}
          >
            {busy ? "…" : t("welcome.load")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Кол-во нод для отображения. Для mihomo-профиля одна запись-«профиль»
 *  представляет N нод — берём их число из raw.proxy_count / raw.proxies,
 *  а не длину массива servers (=1). Для обычного списка — число серверов. */
function nodeCountOf(list: ProxyEntry[]): number {
  const prof = list.find((s) => s.protocol === "mihomo-profile");
  if (!prof) return list.length;
  const raw = prof.raw as
    | { proxy_count?: number; proxies?: unknown[] }
    | undefined;
  if (typeof raw?.proxy_count === "number" && raw.proxy_count > 0)
    return raw.proxy_count;
  if (Array.isArray(raw?.proxies)) return raw.proxies.length;
  return list.length;
}

/** Порядок индексов серверов по выбранной сортировке (Settings → подключение).
 *  none — как пришло из подписки; ping — по возрастанию (нет пинга в конец);
 *  name — по алфавиту (по очищенной подписи без флага). Возвращаем индексы,
 *  чтобы pings/selectedIndex продолжали ссылаться на исходный массив. */
function orderServers(
  servers: ProxyEntry[],
  pings: (number | null)[],
  mode: string
): number[] {
  const order = servers.map((_, i) => i);
  if (mode === "name") {
    order.sort((a, b) =>
      splitFlag(servers[a].name).label.localeCompare(
        splitFlag(servers[b].name).label,
        "ru"
      )
    );
  } else if (mode === "ping") {
    order.sort((a, b) => {
      const pa = pings[a];
      const pb = pings[b];
      if (pa == null && pb == null) return 0;
      if (pa == null) return 1;
      if (pb == null) return -1;
      return pa - pb;
    });
  }
  return order;
}

/** Список нод mihomo-профиля для TCP-пинга: {name, server, port}.
 *  Поля совпадают с backend-структурой MihomoNodePing. */
function nodeListOf(
  profile: ProxyEntry | undefined
): Array<{ name: string; server: string; port: number }> {
  const raw = profile?.raw as
    | { proxies?: Array<{ name?: string; server?: string; port?: number }> }
    | undefined;
  return (raw?.proxies ?? [])
    .filter((p) => p.name)
    .map((p) => ({
      name: p.name as string,
      server: p.server ?? "",
      port: p.port ?? 0,
    }));
}

/** Цветовой класс пинга: зелёный/жёлтый/красный. */
function pingClass(ping: number | null | undefined): string {
  if (ping == null) return "";
  if (ping < 80) return " is-good";
  if (ping < 200) return " is-ok";
  return " is-bad";
}

const FLAGS: [RegExp, string][] = [
  [/german|герман|deutsch/i, "🇩🇪"],
  [/netherl|нидерл|holland|голланд/i, "🇳🇱"],
  [/latvia|латв/i, "🇱🇻"],
  [/sweden|швец/i, "🇸🇪"],
  [/france|франц/i, "🇫🇷"],
  [/united kingdom|britain|англ|великобрит/i, "🇬🇧"],
  [/usa|united states|сша|америк/i, "🇺🇸"],
  [/russia|росси/i, "🇷🇺"],
  [/finland|финлянд/i, "🇫🇮"],
  [/poland|польш/i, "🇵🇱"],
  [/japan|япон/i, "🇯🇵"],
  [/singapore|сингап/i, "🇸🇬"],
  [/turkey|турц/i, "🇹🇷"],
  [/spain|испан/i, "🇪🇸"],
  [/italy|итал/i, "🇮🇹"],
  [/ukrain|украин/i, "🇺🇦"],
  [/estonia|эстон/i, "🇪🇪"],
  [/norway|норвег/i, "🇳🇴"],
  [/switzerl|швейцар/i, "🇨🇭"],
  [/canada|канад/i, "🇨🇦"],
  [/austria|австри/i, "🇦🇹"],
];

function flagFor(name: string): string {
  if (/fastest|быстр|авто|auto/i.test(name)) return "⚡";
  for (const [re, f] of FLAGS) if (re.test(name)) return f;
  return "🌐";
}

const FLAG_RE = /[\u{1F1E6}-\u{1F1FF}]{2}/u;

function cleanName(name: string): string {
  return name.replace(/^\s*[A-Z]{2,3}\s+(?=[A-ZА-Я])/, "").trim() || name;
}

/** Имя сервера → флаг (из подписки, иначе деривируем) + читаемая подпись. */
function splitFlag(name: string): { flag: string; label: string } {
  const m = name.match(FLAG_RE);
  if (m) {
    const label = name.replace(m[0], "").replace(/\s+/g, " ").trim();
    return { flag: m[0], label: label || name };
  }
  return { flag: flagFor(name), label: cleanName(name) };
}

/** Трафик подписки: «X / Y ГБ» или «X ГБ / ∞» или «∞». */
function trafficLabel(meta: { used: number; total: number } | null): string {
  if (!meta) return "∞";
  const gb = (b: number) => (b / 1024 ** 3).toFixed(1);
  if (meta.total > 0) return `${gb(meta.used)} / ${gb(meta.total)} ГБ`;
  if (meta.used > 0) return `${gb(meta.used)} ГБ / ∞`;
  return "∞";
}
