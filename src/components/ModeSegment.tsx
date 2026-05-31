import { useTranslation } from "react-i18next";
import type { VpnMode } from "../stores/vpnStore";
import { InfoTip } from "./InfoTip";

/**
 * Segmented control: переключение режима VPN (proxy / tun).
 * Дизейблится пока туннель в running/busy состоянии.
 */
export function ModeSegment({
  mode,
  onChange,
  disabled,
}: {
  mode: VpnMode;
  onChange: (m: VpnMode) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="mode-seg" style={{ marginTop: 12 }}>
      {(["proxy", "tun"] as VpnMode[]).map((m) => (
        <button
          key={m}
          type="button"
          disabled={disabled}
          onClick={() => onChange(m)}
          className={mode === m ? "is-active" : ""}
        >
          <span className="mode-seg-label">
            {m === "proxy" ? t("modeSegment.proxy") : t("modeSegment.tun")}
          </span>
          {/* Подсказка «i» (портальный тултип — не обрезается листом). */}
          <InfoTip
            text={
              m === "proxy"
                ? t("modeSegment.proxyHint")
                : t("modeSegment.tunHint")
            }
            label={t("modeSegment.infoLabel")}
          />
        </button>
      ))}
    </div>
  );
}
