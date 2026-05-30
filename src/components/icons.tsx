/**
 * Inline SVG-иконки. Пока все маленькие — держим в одном файле.
 * Заводить на каждую отдельный файл смысла нет.
 */

export function PowerIcon() {
  return (
    <svg className="power-icon" viewBox="0 0 24 24">
      <path d="M12 4 V13" />
      <path d="M5.5 7.5 a9 9 0 1 0 13 0" />
    </svg>
  );
}

export function UserIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-1a8 8 0 0 1 16 0v1" />
    </svg>
  );
}

export function SettingsIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/** Набор мелких SVG-иконок для soft-UI (16px, stroke=currentColor). */
const ico = (w = 16) => ({
  viewBox: "0 0 24 24",
  width: w,
  height: w,
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
});

export function RefreshIcon() {
  return (
    <svg {...ico()}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 4v5h-5" />
    </svg>
  );
}

export function PulseIcon() {
  return (
    <svg {...ico()}>
      <path d="M3 12h4l2.5 7 5-14 2.5 7h4" />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg {...ico()}>
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M6 6l1 14a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-14" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg {...ico(18)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function ChevronDownIcon() {
  return (
    <svg {...ico(14)}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export function ChevronRightIcon() {
  return (
    <svg {...ico(20)}>
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}

export function CopyIcon() {
  return (
    <svg {...ico()}>
      <rect x="9" y="9" width="11" height="11" rx="2.5" />
      <path d="M5 15V5a2 2 0 0 1 2-2h8" />
    </svg>
  );
}
