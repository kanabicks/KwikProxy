import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { useVpnStore, findSelectedIndexByName } from "../stores/vpnStore";
import { useSubscriptionStore } from "../stores/subscriptionStore";
import { useSettingsStore } from "../stores/settingsStore";
import { Welcome } from "./Welcome";
import { ModeSegment } from "./ModeSegment";
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

  const toggle = () => {
    if (isBusy) return;
    if (isRunning) void disconnect();
    else if (selectedIndex !== null) void connect();
  };

  // Переключение активной подписки: подменяем legacy servers/meta/pings
  // и заливаем серверы в Rust (set_servers) для connect-by-index.
  const activate = (id: string) => {
    if (id !== primaryId) {
      setPrimaryId(id);
      const sub = useSubscriptionStore.getState().subscriptions.find((s) => s.id === id);
      if (sub) {
        useSubscriptionStore.setState({
          servers: sub.servers,
          meta: sub.meta,
          pings: sub.pings ?? [],
        });
        void invoke("set_servers", { servers: sub.servers });
        const idx = findSelectedIndexByName(sub.servers);
        useVpnStore.setState({ selectedIndex: idx >= 0 ? idx : null });
        void useSubscriptionStore.getState().pingAll();
      }
    }
    closeSheet();
  };

  let metaTop = isRunning ? "ЗАЩИЩЕНО" : "НЕ ЗАЩИЩЕНО";
  if (meta && meta.total > 0) {
    const leftGb = Math.max(0, (meta.total - meta.used) / 1024 ** 3);
    metaTop = `${leftGb.toFixed(1)} ГБ`;
  }
  const subName = activeSub?.meta?.title?.trim() || meta?.title?.trim() || "Nemefisto VPN";
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
      </aside>

      <main className="soft-sheet">
        <div className="soft-sheet-head">
          <span className="soft-sheet-title">Серверы</span>
          <span className="soft-sheet-count">{servers.length}</span>
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
          <button
            type="button"
            className={`soft-iconbtn${pingsLoading ? " is-pulse" : ""}`}
            title="Тест пинга"
            disabled={pingsLoading}
            onClick={() => void pingAll()}
          >
            <PulseIcon />
          </button>
        </div>

        <div className="soft-rows">
          {servers.map((s, i) => {
            const ping = pings[i];
            const sel = i === selectedIndex;
            const { flag, label } = splitFlag(s.name);
            return (
              <button
                key={`${s.subscriptionId ?? "x"}-${s.name}-${i}`}
                type="button"
                className="soft-row"
                data-sel={sel}
                onClick={() => selectServer(i)}
              >
                <span className="soft-row-check" aria-hidden />
                {flag && <span className="soft-row-flag">{flag}</span>}
                <span className="soft-row-title">{label}</span>
                <span className={`soft-row-ping${pingClass(ping)}`}>
                  {ping != null ? `${ping} ms` : "—"}
                </span>
              </button>
            );
          })}
        </div>
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
                    {trafficLabel(s.meta)} · {s.servers.length} серв.
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
