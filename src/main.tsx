import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { FloatingApp } from "./FloatingApp";
// 14.J: i18n-инициализация ДО render'а — иначе первый кадр компонентов
// рендерится без переводов и потом «мерцает» когда i18n догоняет.
import "./i18n";

// Локальные шрифты — bundle-ятся через Vite, никаких внешних запросов
// (Tauri-окно может быть оффлайн).

// Space Grotesk — display (заголовки, имена серверов).
// ВАЖНО: Space Grotesk не поддерживает кириллицу — для русского текста
// браузер падает на следующий шрифт в стэке (см. App.css `--display`,
// там Inter Tight стоит сразу за Space Grotesk).
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/space-grotesk/700.css";

// Inter Tight — body (русский текст + cyrillic fallback для display).
// Веса 600/700 нужны для чёткого жирного текста в soft-UI (имена, бейджи,
// заголовки) — иначе браузер рисует «фейк-болд» (размытый).
import "@fontsource/inter-tight/400.css";
import "@fontsource/inter-tight/500.css";
import "@fontsource/inter-tight/600.css";
import "@fontsource/inter-tight/700.css";
import "@fontsource/inter-tight/cyrillic-400.css";
import "@fontsource/inter-tight/cyrillic-500.css";
import "@fontsource/inter-tight/cyrillic-600.css";
import "@fontsource/inter-tight/cyrillic-700.css";

// JetBrains Mono — мета, метки, моноширинный текст.
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/cyrillic-400.css";
import "@fontsource/jetbrains-mono/cyrillic-500.css";

// Noto Color Emoji — fallback для прочих эмодзи в тексте.
import "@fontsource/noto-color-emoji/400.css";

// SVG-флаги стран (flag-icons). Решают долг «regional-indicator emoji не
// рендерятся в WebView2»: вместо эмодзи-флагов в именах нод/локаций рисуем
// SVG через `<FlagIcon>` (см. lib/flags.tsx) — это CSS background-image с
// SVG, который WebView2 показывает корректно на любом Windows.
import "flag-icons/css/flag-icons.min.css";

// 13.O: один HTML-entrypoint обслуживает оба окна. Главное окно
// (label "main") получает полный <App />, плавающее (label "floating") —
// маленький <FloatingApp />. Tauri отдаёт label синхронно из URL,
// промис не нужен.
const isFloating = (() => {
  try {
    return getCurrentWindow().label === "floating";
  } catch {
    return false;
  }
})();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isFloating ? <FloatingApp /> : <App />}
  </React.StrictMode>,
);
