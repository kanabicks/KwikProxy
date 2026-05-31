// Ребрендинг 0.7.0 (Nemefisto → Kwik): one-time перенос всех ключей
// localStorage из namespace `nemefisto.*` в `kwik.*`.
//
// Зачем модуль, а не функция: stores (settingsStore, subscriptionStore,
// vpnStore) и i18n читают localStorage синхронно на этапе импорта своего
// модуля. ES-импорты выполняются в порядке объявления, поэтому этот файл
// импортируется ПЕРВЫМ в main.tsx — до любого стора, — и его side-effect
// успевает перенести данные, прежде чем код обратится к `kwik.*` ключам.
//
// Копируем (не переносим): старые `nemefisto.*` ключи остаются на месте на
// случай отката версии. Перезаписи нет — если `kwik.*` ключ уже есть, его
// не трогаем. Флаг `kwik.migrated.rebrand.v1` гарантирует один прогон.

const LEGACY_PREFIX = "nemefisto.";
const NEW_PREFIX = "kwik.";
const DONE_FLAG = "kwik.migrated.rebrand.v1";

try {
  if (typeof localStorage !== "undefined" && !localStorage.getItem(DONE_FLAG)) {
    // Snapshot ключей: пишем в localStorage внутри цикла, поэтому берём
    // список заранее, чтобы не зацепить только что добавленные `kwik.*`.
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LEGACY_PREFIX)) keys.push(k);
    }
    for (const oldKey of keys) {
      const newKey = NEW_PREFIX + oldKey.slice(LEGACY_PREFIX.length);
      if (localStorage.getItem(newKey) === null) {
        const value = localStorage.getItem(oldKey);
        if (value !== null) localStorage.setItem(newKey, value);
      }
    }
    localStorage.setItem(DONE_FLAG, "1");
  }
} catch {
  // localStorage может быть недоступен (приватный режим / отключён) —
  // миграция best-effort, молча пропускаем.
}

export {};
