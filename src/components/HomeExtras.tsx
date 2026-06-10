import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useSubscriptionStore } from "../stores/subscriptionStore";
import { FlagIcon, cleanLabel } from "../lib/flags";

/**
 * Доп-блоки для правой панели soft-главной — заполняют пустое место на
 * широком экране полезными данными подписки и нод. Все блоки сами решают
 * показываться или нет (если данных нет — рендерят null).
 */

const GB = 1024 ** 3;

/** «X / Y ГБ» либо «X ГБ» (безлимит). */
function fmtBytes(b: number): string {
  if (b <= 0) return "0";
  if (b >= GB) return `${(b / GB).toFixed(1)} ГБ`;
  return `${(b / (1024 ** 2)).toFixed(0)} МБ`;
}

/** Валидный http(s)-URL (не пустой, не мусор). Иначе кнопку не рисуем. */
function httpUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  const t = u.trim();
  return /^https?:\/\//i.test(t) ? t : null;
}

// ── Объявление провайдера (announce-заголовок подписки) ────────────────
// Раньше было отдельным жёлтым баннером над шапкой «Локации»
// (AnnounceBanner) — теперь строка внутри плашки подписки, чтобы весь
// статус подписки жил в одном блоке. Dismissed-set в localStorage по
// хешу текста: каждое уникальное объявление закрывается один раз,
// новое (другой текст) появится снова.

const DISMISSED_KEY = "kwik.dismissed-announces";
const DISMISSED_MAX = 32;

/** Дешёвый стабильный хеш строки (FNV-1a). 8 hex-символов достаточно. */
function hashString(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function loadDismissed(): string[] {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

function saveDismissed(list: string[]) {
  try {
    localStorage.setItem(
      DISMISSED_KEY,
      JSON.stringify(list.slice(-DISMISSED_MAX))
    );
  } catch {
    // приватный режим — игнорируем
  }
}

/** Сколько длится анимация схлопывания строки объявления (мс) —
 *  синхронизировано с CSS-transition .sub-strip-announce. */
const ANNOUNCE_LEAVE_MS = 380;

/**
 * Строка объявления внутри плашки подписки: точка-индикатор + текст +
 * опц. ссылка ↗ + крестик. Появляется плавно (grid-rows 0fr→1fr +
 * opacity), при закрытии так же плавно схлопывается, и только потом
 * пишется в dismissed-set (размонтируется без скачка высоты).
 */
function AnnounceRow({
  text,
  url,
  hash,
  onDismissed,
}: {
  text: string;
  url: string | null;
  hash: string;
  onDismissed: (hash: string) => void;
}) {
  const { t } = useTranslation();
  // Вход: монтируемся свёрнутыми, через двойной rAF включаем is-visible —
  // CSS-transition разворачивает строку (тот же паттерн, что у дашборда).
  const [visible, setVisible] = useState(false);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setVisible(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [hash]);

  const close = () => {
    if (closing) return;
    setClosing(true);
    setVisible(false);
    window.setTimeout(() => onDismissed(hash), ANNOUNCE_LEAVE_MS);
  };

  return (
    <div className={`sub-strip-announce${visible ? " is-visible" : ""}`}>
      <div className="sub-strip-announce-inner">
        <span className="sub-strip-announce-dot" aria-hidden="true" />
        {url ? (
          <button
            type="button"
            className="sub-strip-announce-text is-link"
            onClick={() => void openUrl(url)}
            aria-label={t("announce.openLink")}
          >
            {text}
            <span className="sub-strip-announce-arrow" aria-hidden="true">
              {" "}↗
            </span>
          </button>
        ) : (
          <span className="sub-strip-announce-text">{text}</span>
        )}
        <button
          type="button"
          className="sub-strip-announce-close"
          onClick={close}
          aria-label={t("common.close")}
          title={t("common.close")}
        >
          ×
        </button>
      </div>
    </div>
  );
}

/** Относительный срок истечения: «через N дн» / «сегодня» / «истёк». */
function fmtExpiry(expireAtSec: number): { text: string; warn: boolean } {
  const now = Date.now() / 1000;
  const diffDays = Math.floor((expireAtSec - now) / 86400);
  if (diffDays < 0) return { text: "истёк", warn: true };
  if (diffDays === 0) return { text: "истекает сегодня", warn: true };
  if (diffDays === 1) return { text: "1 день", warn: true };
  if (diffDays < 5) return { text: `${diffDays} дн`, warn: true };
  return { text: `${diffDays} дн`, warn: false };
}

/**
 * Компактная полоса подписки — размещается СРАЗУ ПОД заголовком «Локации»
 * (а не отдельной карточкой внизу, где она налезала на плавающий док).
 * Показывает трафик (бар + текст), срок и опц. ссылки поддержки/премиум.
 * Если данных нет — null.
 */
export function SubStrip() {
  const meta = useSubscriptionStore((s) => s.meta);
  const [dismissed, setDismissed] = useState<string[]>(() => loadDismissed());
  if (!meta) return null;

  const used = meta.used ?? 0;
  const total = meta.total ?? 0;
  const expireAt = meta.expireAt ?? null;
  // Только валидные http(s)-ссылки — иначе кнопку не показываем
  // (панель может прислать пустую строку / мусор вместо URL).
  const supportUrl = httpUrl(meta.supportUrl);
  const premiumUrl = httpUrl(meta.premiumUrl);

  // Объявление провайдера — строка внутри этой же плашки.
  const announceText = meta.announce?.trim() || null;
  const announceUrl = httpUrl(meta.announceUrl);
  const announceHash = announceText ? hashString(announceText) : null;
  const showAnnounce =
    !!announceText && !!announceHash && !dismissed.includes(announceHash);

  const hasTraffic = total > 0 || used > 0;
  const hasExpiry = expireAt != null;
  const hasLinks = !!supportUrl || !!premiumUrl;
  if (!hasTraffic && !hasExpiry && !hasLinks && !showAnnounce) return null;

  const ratio = total > 0 ? Math.min(1, used / total) : 0;
  const expiry = hasExpiry ? fmtExpiry(expireAt!) : null;
  // Остаток трафика и флаг «мало» (>85% израсходовано или <5 ГБ осталось).
  const remaining = total > 0 ? Math.max(0, total - used) : 0;
  const lowTraffic = total > 0 && (ratio > 0.85 || remaining < 5 * GB);

  const dismissAnnounce = (hash: string) => {
    const next = [...dismissed.filter((h) => h !== hash), hash];
    setDismissed(next);
    saveDismissed(next);
  };

  return (
    <div className="sub-strip">
      <div className="sub-strip-main">
      <div className="sub-strip-info">
        <div className="sub-strip-line">
          <span className="sub-strip-traffic">
            {total > 0
              ? `${fmtBytes(used)} / ${fmtBytes(total)}`
              : hasTraffic
              ? `${fmtBytes(used)} · безлимит`
              : "безлимит"}
          </span>
          {/* Когда трафик на исходе — показываем «осталось N» (красным);
              иначе на этом месте срок подписки. */}
          {total > 0 && lowTraffic ? (
            <span className="sub-strip-left is-warn">
              осталось {fmtBytes(remaining)}
            </span>
          ) : (
            expiry && (
              <span
                className={`sub-strip-expiry${expiry.warn ? " is-warn" : ""}`}
              >
                {expiry.text}
              </span>
            )
          )}
        </div>
        {total > 0 && (
          <div className="sub-strip-bar">
            <div
              className={`sub-strip-bar-fill${lowTraffic ? " is-warn" : ""}`}
              style={{ width: `${Math.max(2, ratio * 100)}%` }}
            />
          </div>
        )}
      </div>
      {hasLinks && (
        <div className="sub-strip-links">
          {supportUrl && (
            <button
              type="button"
              className="sub-strip-link"
              onClick={() => void openUrl(supportUrl)}
              title="Поддержка"
            >
              Поддержка ↗
            </button>
          )}
          {premiumUrl && (
            <button
              type="button"
              className="sub-strip-link is-premium"
              onClick={() => void openUrl(premiumUrl)}
              title="Премиум"
            >
              Премиум ↗
            </button>
          )}
        </div>
      )}
      </div>
      {showAnnounce && announceText && announceHash && (
        <AnnounceRow
          text={announceText}
          url={announceUrl}
          hash={announceHash}
          onDismissed={dismissAnnounce}
        />
      )}
    </div>
  );
}

export type PingNode = { name: string; ping: number | null };

function pingColor(p: number | null): string {
  if (p == null) return "delay-none";
  if (p < 200) return "delay-good";
  if (p < 500) return "delay-ok";
  if (p < 1000) return "delay-slow";
  return "delay-bad";
}

/** Обзор задержек по нодам: бары «качества» (короткий пинг = длинный бар),
 *  самая быстрая помечена. Показывается только если есть хоть один пинг. */
export function NodePingOverview({ nodes }: { nodes: PingNode[] }) {
  const measured = nodes.filter((n) => n.ping != null);
  if (measured.length === 0) return null;

  // Сортируем по возрастанию пинга; неизмеренные — в конец.
  const sorted = [...nodes].sort((a, b) => {
    if (a.ping == null && b.ping == null) return 0;
    if (a.ping == null) return 1;
    if (b.ping == null) return -1;
    return a.ping - b.ping;
  });
  const fastest = sorted.find((n) => n.ping != null)?.name ?? null;
  // Масштаб бара — ОТНОСИТЕЛЬНЫЙ: самый быстрый = полный бар, самый
  // медленный = короткий. Без этого при близких пингах (13/24мс) бары
  // выглядели одинаково. Цвет при этом отражает абсолютную задержку.
  const vals = measured.map((n) => n.ping as number);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const quality = (p: number) =>
    max === min ? 100 : 38 + (1 - (p - min) / (max - min)) * 62;

  return (
    <section className="home-card ping-card">
      <div className="home-card-head">
        <span className="home-card-title">Задержки</span>
        <span className="home-card-sub">{measured.length} нод</span>
      </div>
      <div className="ping-list">
        {sorted.slice(0, 12).map((n, i) => (
          <div
            className="ping-row"
            key={n.name}
            style={{ animationDelay: `${Math.min(i, 12) * 45}ms` }}
          >
            <FlagIcon name={n.name} className="ping-flag" placeholder />
            <span className="ping-name">{cleanLabel(n.name)}</span>
            <span className="ping-bar">
              {n.ping != null && (
                <span
                  className={`ping-bar-fill ${pingColor(n.ping)}`}
                  style={{
                    width: `${quality(n.ping)}%`,
                    animationDelay: `${Math.min(i, 12) * 45 + 90}ms`,
                  }}
                />
              )}
            </span>
            <span className={`ping-val ${pingColor(n.ping)}`}>
              {n.ping != null ? `${n.ping} ms` : "—"}
            </span>
            {n.name === fastest && <span className="ping-fastest">★</span>}
          </div>
        ))}
      </div>
    </section>
  );
}
