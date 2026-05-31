//! Защищённое хранилище секретов (этап 6.A).
//!
//! Использует Windows Credential Manager через `keyring-rs`. Каждое
//! значение хранится как отдельный credential под уникальным именем
//! `kwik.<key>`. На macOS — Keychain, на Linux — Secret Service
//! (kwallet/gnome-keyring); кросс-платформенно работает «out of the box».
//!
//! Хранится:
//! - `subscription_url` — URL подписки (содержит токен/HWID часто);
//! - `hwid_override` — кастомный HWID для разработки.
//!
//! НЕ хранится:
//! - Сгенерированный SOCKS5 password — он создаётся при connect и не
//!   переживает перезапуск.
//! - Кеш серверов, настройки UI — это не секреты, лежат в localStorage.

use anyhow::{Context, Result};
use keyring::Entry;

/// Префикс для всех keys в Credential Manager — чтобы наши значения
/// не путались с другими приложениями.
const SERVICE_PREFIX: &str = "kwik";
/// Префикс до ребрендинга 0.7.0 (Nemefisto → Kwik). Используется только
/// для one-time миграции существующих записей в Credential Manager
/// (см. `migrate_legacy`). Новые записи всегда пишутся с `SERVICE_PREFIX`.
const LEGACY_SERVICE_PREFIX: &str = "nemefisto";
/// Username в credential — в Credential Manager у каждой записи есть
/// service+user пара. Нам user не нужен, ставим единый.
const USERNAME: &str = "default";

/// Создать `Entry` для ключа. На Windows credential будет виден в
/// «Учётные данные Windows» как «Универсальные учётные данные».
fn entry(key: &str) -> Result<Entry> {
    entry_with_prefix(SERVICE_PREFIX, key)
}

/// Создать `Entry` с произвольным service-префиксом. Вынесено отдельно
/// чтобы `migrate_legacy` могло читать старый `nemefisto.*` namespace.
fn entry_with_prefix(prefix: &str, key: &str) -> Result<Entry> {
    let service = format!("{prefix}.{key}");
    Entry::new(&service, USERNAME)
        .with_context(|| format!("не удалось создать keyring entry для {key}"))
}

/// Прочитать значение по ключу. Возвращает `None` если ключа нет
/// (не считаем за ошибку — это нормальный first-run сценарий).
pub fn get(key: &str) -> Result<Option<String>> {
    let e = entry(key)?;
    match e.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(anyhow::anyhow!("keyring get({key}): {err}")),
    }
}

/// Записать значение. Перезаписывает существующее.
///
/// После записи делаем read-back verify: если keyring по какой-то причине
/// окажется в неперсистентном режиме (например снова забыли feature-флаг
/// нативного backend'а и крейт молча подсунул mock-store), запись «успешна»,
/// но в Credential Manager ничего нет. Без verify это приводит к тихой
/// потере данных (баг 0.3.4: подписка «исчезала» на рестарте). Verify
/// превращает молчаливый провал в явную ошибку, которую фронт ловит через
/// свой `ok`-guard и не пишет осиротевший индекс.
pub fn set(key: &str, value: &str) -> Result<()> {
    let e = entry(key)?;
    e.set_password(value)
        .with_context(|| format!("keyring set({key})"))?;
    match e.get_password() {
        Ok(read) if read == value => Ok(()),
        Ok(_) => Err(anyhow::anyhow!(
            "keyring set({key}): read-back вернул другое значение — хранилище неперсистентно"
        )),
        Err(err) => Err(anyhow::anyhow!(
            "keyring set({key}): read-back провалился ({err}) — хранилище неперсистентно"
        )),
    }
}

/// Удалить значение. Если ключа уже нет — не считаем за ошибку.
pub fn delete(key: &str) -> Result<()> {
    let e = entry(key)?;
    match e.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(anyhow::anyhow!("keyring delete({key}): {err}")),
    }
}

/// One-time миграция записи из старого `nemefisto.*` namespace в новый
/// `kwik.*` (ребрендинг 0.7.0). Для каждого `key`:
///   - если в новом namespace значение уже есть — ничего не делаем;
///   - иначе читаем `nemefisto.{key}`, и если оно есть — копируем в
///     `kwik.{key}` (старую запись НЕ удаляем — на случай отката
///     версии; Credential Manager переживёт пару осиротевших записей).
///
/// Возвращает `true` если хоть одно значение было перенесено. Ошибки
/// чтения старой записи не фатальны (best-effort) — это миграция, а не
/// критический путь.
pub fn migrate_legacy(key: &str) -> Result<bool> {
    // Новое значение уже есть → миграция не нужна.
    if get(key)?.is_some() {
        return Ok(false);
    }
    let legacy = entry_with_prefix(LEGACY_SERVICE_PREFIX, key)?;
    match legacy.get_password() {
        Ok(value) => {
            set(key, &value)?;
            Ok(true)
        }
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(err) => Err(anyhow::anyhow!("keyring migrate({key}): {err}")),
    }
}
