import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useUpdateStore } from "../stores/updateStore";
import { useSettingsStore } from "../stores/settingsStore";
import { downloadUpdate, installUpdate } from "../lib/updater";
import { showToast } from "../stores/toastStore";

/**
 * 14.A: модалка предложения обновления (двухшаговая, 0.5.0).
 *
 * Открывается когда `useAutoUpdateCheck` нашёл новую версию. Поток:
 *  1. «Скачать обновление» → загрузка в фоне, **VPN не выключается**;
 *  2. после загрузки — «Обновить и перезапустить» → только теперь
 *     VPN отключается, ставится installer, app перезапускается.
 * Так пользователь не теряет соединение на время скачивания (~44 МБ).
 */
export function UpdateModal() {
  const { t } = useTranslation();
  const state = useUpdateStore((s) => s.state);
  const setState = useUpdateStore((s) => s.setState);
  const dismissedSet = useSettingsStore((s) => s.set);
  const dismissedList = useSettingsStore((s) => s.dismissedUpdateVersions);
  const [progress, setProgress] = useState(0);

  if (
    state.kind !== "available" &&
    state.kind !== "downloading" &&
    state.kind !== "downloaded" &&
    state.kind !== "installing"
  ) {
    return null;
  }

  const update = state.update;
  const isDownloading = state.kind === "downloading";
  const isDownloaded = state.kind === "downloaded";
  const isInstalling = state.kind === "installing";
  const busy = isDownloading || isInstalling;

  const onDismiss = () => {
    if (busy) return;
    if (!dismissedList.includes(update.version)) {
      dismissedSet("dismissedUpdateVersions", [
        ...dismissedList,
        update.version,
      ]);
    }
    setState({ kind: "idle" });
  };

  // Шаг 1 — скачивание (VPN продолжает работать).
  const onDownload = async () => {
    setState({ kind: "downloading", update, progress: 0 });
    try {
      await downloadUpdate(update, (fraction) => {
        setProgress(fraction);
        setState({ kind: "downloading", update, progress: fraction });
      });
      setState({ kind: "downloaded", update });
    } catch (e) {
      showToast({
        kind: "error",
        title: t("modal.update.updateFailedTitle"),
        message: String(e),
      });
      setState({ kind: "idle" });
    }
  };

  // Шаг 2 — установка (VPN отключается, app перезапускается).
  const onInstall = async () => {
    setState({ kind: "installing", update });
    try {
      await installUpdate(update);
      // relaunch() обычно не возвращается — app уже перезапустился.
      setState({ kind: "installed" });
    } catch (e) {
      showToast({
        kind: "error",
        title: t("modal.update.updateFailedTitle"),
        message: String(e),
      });
      setState({ kind: "idle" });
    }
  };

  return (
    <div className="recovery-overlay" role="dialog" aria-modal="true">
      <div className="recovery-dialog" style={{ maxWidth: 460 }}>
        <div className="recovery-title">
          {t("modal.update.availableTitle", { version: update.version })}
        </div>
        <div className="recovery-text">
          {t("modal.update.currentVersion")}{" "}
          <span style={{ color: "var(--fg)" }}>{update.currentVersion}</span>
        </div>
        {update.notes ? (
          <pre
            className="recovery-text"
            style={{
              marginTop: 12,
              maxHeight: 200,
              overflowY: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontFamily: "var(--font-mono, monospace)",
              fontSize: 12,
              padding: 8,
              background: "var(--bg-soft, rgba(255,255,255,0.04))",
              borderRadius: 6,
            }}
          >
            {update.notes.trim()}
          </pre>
        ) : null}
        {isDownloading ? (
          <div style={{ marginTop: 16 }}>
            <div
              className="recovery-text"
              style={{ marginBottom: 6, fontSize: 12 }}
            >
              Скачивается… {Math.round(progress * 100)}% — VPN продолжает
              работать
            </div>
            <div
              style={{
                height: 6,
                background: "var(--bg-soft, rgba(255,255,255,0.06))",
                borderRadius: 3,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${progress * 100}%`,
                  height: "100%",
                  background: "var(--accent, #5cc6c6)",
                  transition: "width 120ms linear",
                }}
              />
            </div>
          </div>
        ) : null}
        {isDownloaded ? (
          <div
            className="recovery-text"
            style={{ marginTop: 16, fontSize: 13 }}
          >
            Обновление загружено. При установке VPN отключится, приложение
            перезапустится (несколько секунд).
          </div>
        ) : null}
        {isInstalling ? (
          <div
            className="recovery-text"
            style={{ marginTop: 16, fontSize: 13 }}
          >
            Устанавливаем обновление… приложение сейчас перезапустится.
          </div>
        ) : null}
        <div className="recovery-actions" style={{ marginTop: 16 }}>
          <button
            type="button"
            className="btn-ghost"
            onClick={onDismiss}
            disabled={busy}
          >
            {t("modal.update.later")}
          </button>
          {isDownloaded ? (
            <button type="button" className="btn-primary" onClick={onInstall}>
              {t("modal.update.installAndRestart")}
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary"
              onClick={onDownload}
              disabled={busy}
            >
              {isDownloading ? "…" : "Скачать обновление"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
