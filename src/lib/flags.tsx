/**
 * SVG-флаги для имён нод/локаций. Решает долг «regional-indicator emoji не
 * рендерятся в WebView2»: вместо эмодзи определяем ISO-код страны из имени
 * и рисуем SVG-флаг из пакета `flag-icons` (CSS background-image c SVG —
 * рендерится в WebView2 без проблем).
 *
 * Детект страны (по убыванию надёжности):
 *  1. **regional-indicator пара** (флаг-эмодзи в имени, напр. «🇩🇪 Берлин»);
 *  2. **название страны** — словарь рус/англ ключевых слов;
 *  3. **standalone ISO2-токен** — `\bDE\b`, `\bNL\b` и т.п. из whitelist.
 *
 * Возвращаем lowercase ISO 3166-1 alpha-2 (как требует flag-icons), либо
 * `null` если страну не распознали (тогда флаг не рисуется).
 */

/** UK в обиходе, но flag-icons знает только `gb`. Нормализуем алиасы. */
const ISO_ALIAS: Record<string, string> = {
  uk: "gb",
  en: "gb",
  su: "ru",
};

/**
 * Словарь «ключевое слово → ISO2». Включает русские и английские названия
 * стран + частые города-хабы (Франкфурт → de и т.п.). Ключи в lowercase.
 * Порядок не важен — матчим по вхождению подстроки на word-boundary где
 * это возможно, длинные ключи (названия) проверяются до коротких токенов.
 */
const NAME_TO_ISO: Array<[RegExp, string]> = [
  [/росси|russia|moscow|москв|\bspb\b|питер|petersburg/i, "ru"],
  [/герман|german|frankfurt|франкфурт|berlin|берлин/i, "de"],
  [/нидерланд|netherl|holland|amsterd|амстерд/i, "nl"],
  [/финлянд|finland|helsink|хельсинк/i, "fi"],
  [/швеци|sweden|stockh|стокгольм/i, "se"],
  [/франци|france|paris|париж/i, "fr"],
  [/великобритан|britain|england|london|лондон|united kingdom/i, "gb"],
  [/\bсша\b|united states|america|\busa\b/i, "us"],
  [/нью-йорк|new york|\bnyc\b/i, "us"],
  [/канад|canada|toronto|торонто/i, "ca"],
  [/япони|japan|tokyo|токио/i, "jp"],
  [/сингапур|singapore/i, "sg"],
  [/гонконг|hong kong|hongkong/i, "hk"],
  [/корея|korea|seoul|сеул/i, "kr"],
  [/турци|turkey|türkiye|istanbul|стамбул/i, "tr"],
  [/польш|poland|warsaw|варшав/i, "pl"],
  [/эстони|estonia|tallinn|таллин/i, "ee"],
  [/латви|latvia|riga|рига/i, "lv"],
  [/литв|lithuania|vilnius/i, "lt"],
  [/украин|ukraine|kyiv|kiev|киев/i, "ua"],
  [/казахст|kazakh|almaty|алматы/i, "kz"],
  [/швейцар|switzerl|zurich|цюрих/i, "ch"],
  [/австри|austria|vienna|вена/i, "at"],
  [/итали|italy|milan|милан|rome|рим/i, "it"],
  [/испани|spain|madrid|мадрид/i, "es"],
  [/норвег|norway|oslo|осло/i, "no"],
  [/дани|denmark|copenhag/i, "dk"],
  [/бельги|belgium|brussel/i, "be"],
  [/чехи|czech|prague|прага/i, "cz"],
  [/ирланд|ireland|dublin|дублин/i, "ie"],
  [/индия|india|mumbai|мумбаи/i, "in"],
  [/австрали|australia|sydney|сидней/i, "au"],
  [/бразили|brazil|sao paulo/i, "br"],
  [/арген|argentina/i, "ar"],
  [/мексик|mexico/i, "mx"],
  [/эмират|\buae\b|dubai|дубай|emirates/i, "ae"],
  [/израил|israel|tel aviv/i, "il"],
  [/китай|china|beijing|shanghai|шанхай/i, "cn"],
  [/тайван|taiwan|taipei/i, "tw"],
  [/вьетнам|vietnam/i, "vn"],
  [/тайланд|таиланд|thailand|bangkok/i, "th"],
  [/индонез|indonesia|jakarta/i, "id"],
  [/армени|armenia|yerevan|ереван/i, "am"],
  [/грузи|georgia|tbilisi|тбилиси/i, "ge"],
  [/серби|serbia|belgrade/i, "rs"],
  [/румын|romania|bucharest/i, "ro"],
  [/болгари|bulgaria|sofia/i, "bg"],
  [/венгри|hungary|budapest/i, "hu"],
  [/португал|portugal|lisbon/i, "pt"],
  [/грец|greece|athens|афин/i, "gr"],
];

/** Whitelist ISO2-кодов которые безопасно матчить как отдельный токен в
 *  имени (`\bDE\b`). Без whitelist «NJ»/«VPN» давали бы ложные флаги. */
const ISO_TOKENS = new Set([
  "ru", "de", "nl", "fi", "se", "fr", "gb", "us", "ca", "jp", "sg", "hk",
  "kr", "tr", "pl", "ee", "lv", "lt", "ua", "kz", "ch", "at", "it", "es",
  "no", "dk", "be", "cz", "ie", "in", "au", "br", "ar", "mx", "ae", "il",
  "cn", "tw", "vn", "th", "id", "am", "ge", "rs", "ro", "bg", "hu", "pt",
  "gr", "uk",
]);

/** SVG-флаг по готовому ISO-2 коду (например из leak-test `country_code`).
 *  `null`/невалидный код → ничего. */
export function FlagByCode({
  code,
  className = "",
}: {
  code: string | null | undefined;
  className?: string;
}) {
  if (!code || code.length !== 2 || !/^[a-z]{2}$/i.test(code)) return null;
  const iso = (ISO_ALIAS[code.toLowerCase()] ?? code.toLowerCase());
  return (
    <span className={`fi fis fi-${iso} flag-svg ${className}`.trim()} aria-hidden />
  );
}

/** Убрать эмодзи (флаги/пиктограммы/ZWJ/variation-selector) из имени для
 *  отображения. Реальное имя (ключ для API) трогать нельзя. */
const EMOJI_RE =
  /[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{25A0}-\u{25FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu;
export function cleanLabel(name: string): string {
  return name.replace(EMOJI_RE, "").replace(/\s{2,}/g, " ").trim() || name;
}

/** Извлечь ISO2 из первой regional-indicator пары в строке. */
function isoFromRegionalIndicators(name: string): string | null {
  const cps = Array.from(name);
  for (let i = 0; i < cps.length - 1; i++) {
    const a = cps[i].codePointAt(0) ?? 0;
    const b = cps[i + 1].codePointAt(0) ?? 0;
    if (a >= 0x1f1e6 && a <= 0x1f1ff && b >= 0x1f1e6 && b <= 0x1f1ff) {
      const code =
        String.fromCharCode(a - 0x1f1e6 + 97) +
        String.fromCharCode(b - 0x1f1e6 + 97);
      return ISO_ALIAS[code] ?? code;
    }
  }
  return null;
}

/** Определить ISO2-код страны из имени ноды/группы. `null` — не распознано. */
export function flagCodeFromName(name: string): string | null {
  if (!name) return null;

  // 1. Флаг-эмодзи (самый надёжный сигнал).
  const fromEmoji = isoFromRegionalIndicators(name);
  if (fromEmoji) return fromEmoji;

  // 2. Названия стран / городов-хабов.
  for (const [re, iso] of NAME_TO_ISO) {
    if (re.test(name)) return iso;
  }

  // 3. ОТДЕЛЬНЫЙ ISO2-токен (`HK 01`, `nl-fast`, `de1`). Только из
  //    whitelist и только как самостоятельный буквенный фрагмент длиной
  //    ровно 2 — иначе ловили «fi» внутри «Kwik»/«First» (→ ложный
  //    финский флаг). split по не-буквам изолирует буквенные пробеги:
  //    «de1»→["de"], «hk01»→["hk"], «kwik»→["kwik"] (len 8, skip).
  const tokens = name.toLowerCase().split(/[^a-z]+/);
  for (const tk of tokens) {
    if (tk.length === 2 && ISO_TOKENS.has(tk)) return ISO_ALIAS[tk] ?? tk;
  }

  return null;
}

/**
 * SVG-флаг страны, определённой из имени. Рендерит `<span class="fi …">`
 * из flag-icons (квадратный вариант `fis` хорошо смотрится inline).
 *
 * Если страну не распознали:
 *  - `placeholder=true` → нейтральный кружок (выравнивание в сетке карточек
 *    не «прыгает»);
 *  - `placeholder=false` (default) → ничего не рисуем (для заголовков групп
 *    и inline-текста, где лишняя точка перед «PROXY» выглядит мусорно).
 */
export function FlagIcon({
  name,
  className = "",
  placeholder = false,
}: {
  name: string;
  className?: string;
  placeholder?: boolean;
}) {
  const code = flagCodeFromName(name);
  if (!code) {
    return placeholder ? (
      <span className={`flag-dot ${className}`.trim()} aria-hidden />
    ) : null;
  }
  return (
    <span
      className={`fi fis fi-${code} flag-svg ${className}`.trim()}
      aria-hidden
    />
  );
}
