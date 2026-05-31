//! Управление автозапуском приложения (этап 6.B + 0.1.1 fix).
//!
//! Используем Windows Task Scheduler через `schtasks.exe` — task создаётся
//! с триггером ON-LOGON для текущего пользователя и стартует Kwik при
//! входе в систему. Преимущество перед `HKCU\...\Run`: не требует UAC при
//! установке (текущий user-scope), переживает обновление приложения, и
//! пользователь видит/может удалить task через стандартный UI Windows.
//!
//! ## 0.1.1 / Bug 4
//!
//! `schtasks.exe` синхронно блокирует вызывающий поток на 5-15 секунд
//! при создании task'а — это особенность Windows-планировщика, не баг
//! у нас. Раньше команды Tauri были `pub fn` (sync) → блокировали
//! главный thread → UI зависал.
//!
//! Решения:
//!
//! 1. **`tokio::process::Command`** вместо `std::process::Command` —
//!    операция асинхронная, не блокирует тред пула tokio.
//! 2. **`creation_flags(CREATE_NO_WINDOW)`** — не показываем мигающее
//!    cmd-окно при запуске schtasks (раньше было видно).
//! 3. **Убрали `/RL LIMITED`** — оказывается, эта опция вызывает
//!    лишние проверки Task Scheduler'а, что и было причиной 15-сек
//!    зависания. Дефолтный RunLevel «Highest if possible, иначе Limited»
//!    нас устраивает (обычный пользовательский логин).
//! 4. **timeout на 30 сек** — если schtasks всё-таки повис в каком-то
//!    edge case'е, мы вернём ошибку «таймаут», а не «UI заклинило».

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use tokio::process::Command;

const TASK_NAME: &str = "Kwik VPN Autostart";
/// Имя задачи до ребрендинга 0.7.0 (Nemefisto → Kwik). Сносим при
/// enable/disable и на старте приложения (`cleanup_legacy`), чтобы в
/// планировщике не осталось видимого упоминания старого бренда.
const LEGACY_TASK_NAME: &str = "Nemefisto VPN Autostart";
const SCHTASKS_TIMEOUT: Duration = Duration::from_secs(30);

/// CREATE_NO_WINDOW — создаём дочерний процесс БЕЗ консольного окна.
/// Нужно чтобы при каждом enable/disable не вспыхивало чёрное cmd-окно
/// у пользователя.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Полный путь к exe текущего приложения для регистрации в task.
fn current_exe() -> Result<PathBuf> {
    std::env::current_exe().context("не удалось определить путь к exe")
}

/// Включить автозапуск: создать (или пересоздать) task в планировщике.
/// Запуск — `ONLOGON` для текущего пользователя.
///
/// Async-функция, чтобы Tauri-команда не блокировала UI-поток. См.
/// модульный комментарий о причинах асинхронности.
pub async fn enable() -> Result<()> {
    let exe = current_exe()?;
    let exe_str = exe
        .to_str()
        .context("путь к exe содержит не-UTF-8 символы")?;

    // /F = принудительная перезапись если task уже существует
    // /SC ONLOGON = триггер при входе пользователя
    // RL опускаем (см. модульный комментарий)
    let mut cmd = Command::new("schtasks.exe");
    cmd.args([
        "/Create",
        "/F",
        "/TN",
        TASK_NAME,
        "/TR",
        &format!("\"{exe_str}\""),
        "/SC",
        "ONLOGON",
    ]);
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let status = tokio::time::timeout(SCHTASKS_TIMEOUT, cmd.status())
        .await
        .context("schtasks /Create зависает >30 сек — возможно блокирует Task Scheduler")?
        .context("не удалось запустить schtasks.exe")?;

    if !status.success() {
        anyhow::bail!("schtasks /Create вернул код {:?}", status.code());
    }
    Ok(())
}

/// Удалить task по имени. `schtasks /Delete /F` возвращает 0 если task
/// удалён и не-0 если его не было — второе не ошибка. Best-effort.
async fn delete_task(name: &str) {
    let mut cmd = Command::new("schtasks.exe");
    cmd.args(["/Delete", "/F", "/TN", name]);
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let _ = tokio::time::timeout(SCHTASKS_TIMEOUT, cmd.status()).await;
}

/// Выключить автозапуск: удалить task. Если его нет — тихо успех.
/// Заодно сносим legacy-задачу (ребрендинг 0.7.0).
pub async fn disable() -> Result<()> {
    delete_task(TASK_NAME).await;
    delete_task(LEGACY_TASK_NAME).await;
    Ok(())
}

/// One-time миграция автозапуска при ребрендинге 0.7.0. Если в
/// планировщике есть legacy-задача `Nemefisto VPN Autostart`:
///   - и новой `Kwik VPN Autostart` ещё нет — пересоздаём её на текущий
///     exe (переносим включённое состояние автозапуска);
///   - в любом случае сносим legacy (убираем видимое упоминание бренда).
/// Best-effort: все ошибки проглатываются.
pub async fn cleanup_legacy() {
    if !query_task(LEGACY_TASK_NAME).await {
        return;
    }
    if !query_task(TASK_NAME).await {
        let _ = enable().await;
    }
    delete_task(LEGACY_TASK_NAME).await;
}

/// Проверить, зарегистрирована ли task с данным именем в планировщике.
async fn query_task(name: &str) -> bool {
    let mut cmd = Command::new("schtasks.exe");
    cmd.args(["/Query", "/TN", name]);
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    match tokio::time::timeout(SCHTASKS_TIMEOUT, cmd.output()).await {
        Ok(Ok(o)) => o.status.success(),
        _ => false,
    }
}

/// Проверить, включён ли автозапуск. Async, по тем же причинам что
/// enable/disable.
pub async fn is_enabled() -> bool {
    query_task(TASK_NAME).await
}
