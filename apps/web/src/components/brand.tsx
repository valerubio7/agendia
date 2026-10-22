type BrandProps = {
  className?: string;
  inverse?: boolean;
};

type BrandedNameProps = {
  ariaHidden?: boolean;
  className?: string;
};

export function BrandedName({
  ariaHidden = false,
  className = "",
}: BrandedNameProps) {
  return (
    <span
      className={["branded-name", className].filter(Boolean).join(" ")}
      role="img"
      aria-label="agendIA"
      aria-hidden={ariaHidden || undefined}
    >
      <img className="branded-name__wordmark" src="/brand/logo-wordmark-outlined.svg" alt="" />
      <img className="branded-name__compact" src="/brand/logo-mono-outlined.svg" alt="" />
    </span>
  );
}

export function Brand({ className = "", inverse = false }: BrandProps) {
  return (
    <div
      className={["brand", inverse && "brand--inverse", className]
        .filter(Boolean)
        .join(" ")}
      role="img"
      aria-label="agendIA"
    >
      <img
        className="brand__image"
        src={`/brand/logo-${inverse ? "inverse" : "primary"}-outlined.svg`}
        alt=""
      />
    </div>
  );
}
