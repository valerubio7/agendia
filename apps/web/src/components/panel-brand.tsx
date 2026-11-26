import "./panel-brand.css";

type PanelBrandProps = {
  ariaHidden?: boolean;
  className?: string;
  compact?: boolean;
  dark?: boolean;
};

export function PanelBrand({ ariaHidden = false, className, compact = false, dark = false }: PanelBrandProps) {
  return (
    <span className={["panel-brand", className].filter(Boolean).join(" ")}
      data-compact={compact || undefined} data-tone={dark ? "dark" : undefined}
      role={ariaHidden ? undefined : "img"} aria-label={ariaHidden ? undefined : "agendIA"}
      aria-hidden={ariaHidden || undefined}>
      <span className="panel-brand__mark" aria-hidden="true">
        <svg viewBox="0 0 120 120" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
          <path d="M60 6 Q66 56 114 62 Q66 68 60 116 Q54 68 6 62 Q54 56 60 6 Z" fill={dark ? "#1C2620" : "#F3EEE1"} />
          <circle cx="60" cy="62" r="10" fill="#FF6B49" />
        </svg>
      </span>
      {dark ? <span className="panel-brand__word">agend<span>IA</span></span>
        : <img className="panel-brand__wordmark" src="/brand/logo-wordmark-panel.svg" width="210" height="50" alt="" />}
    </span>
  );
}
