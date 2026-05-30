/**
 * 14.A: обёртка над `@tauri-apps/plugin-updater` + `plugin-process`.
 *
 * Endpoint и pubkey прописаны в `tauri.conf.json` (тот же ключ что в CI
 * подписывает релизы). При вызове `check()` плагин сам ходит в endpoint,
 * парсит `latest.json` и проверяет ed25519-подпись `.sig` файлов NSIS-
 * installer'а. Если хоть что-то не сходится — `null` (или throw в случае
 * сетевой ошибки), мы это просто логируем без громких ошибок.
 */

import { check, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { invoke } from "@tauri-apps/api/core";

export interface AvailableUpdate {
  /** Версия из manifest'а (например "0.1.4"). */
  version: string;
  /** Текущая версия приложения. */
  currentVersion: string;
  /** Release notes (из тела GitHub Release / поля `notes` manifest'а). */
  notes: string;
  /** ISO-дата релиза (если есть). */
  date: string | null;
  /** Внутренний хэндл плагина для последующего downloadAndInstall. */
  handle: Update;
}

/**
 * Проверка обновлений. Возвращает `null` если уже на последней версии
 * или произошла сетевая ошибка (мы не пугаем юзера notwerk-ошибками).
 */
export async function checkForUpdates(): Promise<AvailableUpdate | null> {
  try {
    const update = await check();
    if (!update) return null;
    return {
      version: update.version,
      currentVersion: update.currentVersion,
      notes: update.body ?? "",
      date: update.date ?? null,
      handle: update,
    };
  } catch (e) {
    // Не показываем юзеру каждый network-fail. Логируем для диагностики.
    console.warn("[updater] check failed:", e);
    return null;
  }
}

/**
 * Шаг 1 — СКАЧАТЬ обновление в фоне. **VPN не выключается** — это просто
 * загрузка байтов NSIS-installer'а (~44 МБ) на диск, движок продолжает
 * работать. Установка (с disconnect'ом и перезапуском) — отдельным шагом
 * `installUpdate()` после явного согласия пользователя.
 *
 * `onProgress` зовётся после каждого chunk'а с прогрессом 0..1.
 */
export async function downloadUpdate(
  update: AvailableUpdate,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  let downloaded = 0;
  let total = 0;

  await update.handle.download((event) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength ?? 0;
        onProgress?.(0);
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        if (total > 0) {
          onProgress?.(Math.min(1, downloaded / total));
        }
        break;
      case "Finished":
        onProgress?.(1);
        break;
    }
  });
}

/**
 * Шаг 2 — УСТАНОВИТЬ уже скачанное обновление и перезапустить приложение.
 * Вот здесь (и только здесь) VPN отключается: NSIS-installer не сможет
 * перезаписать `mihomo-*.exe` / `nemefisto-helper.exe` пока они залочены
 * запущенными процессами. Поэтому грациозно стопим движок и helper, ждём
 * освобождения файлов, затем `install()` + `relaunch()`.
 */
export async function installUpdate(update: AvailableUpdate): Promise<void> {
  // 0.3.2 / file-lock fix: дисконнектим VPN — иначе mihomo (Tauri sidecar
  // в proxy-mode или SYSTEM-spawned child helper'а в TUN-mode) останется
  // orphan-процессом и залочит свой .exe.
  try {
    await invoke("disconnect");
  } catch (e) {
    console.warn("[updater] disconnect failed:", e);
  }
  await new Promise((r) => setTimeout(r, 1500));

  // 0.3.1: грациозно стопим helper (Windows service держит handle на
  // nemefisto-helper.exe). 0.3.2: helper при ShutdownHelper также стопит
  // своих детей (mihomo). 1500мс — запас на SCM routing + pipe-disconnect.
  try {
    await invoke("shutdown_helper");
  } catch (e) {
    console.warn("[updater] shutdown_helper failed:", e);
  }
  await new Promise((r) => setTimeout(r, 1500));

  // 0.3.3: ещё ~300мс на дренаж IPC-очереди (in-flight secure_storage_set
  // с URL подписки — иначе при следующем старте URL «исчезает»).
  await new Promise((r) => setTimeout(r, 300));

  // Запускаем уже скачанный installer (installMode=passive) и
  // перезапускаем app.
  await update.handle.install();
  await relaunch();
}
