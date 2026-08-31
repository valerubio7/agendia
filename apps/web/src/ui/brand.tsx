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
      aria-hidden={ariaHidden || undefined}
    >
      agend<strong>IA</strong>
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
      <svg
        className="brand__mark"
        viewBox="0 0 100 100"
        aria-hidden="true"
        focusable="false"
      >
        <rect
          className="brand__calendar"
          x="15"
          y="15"
          width="70"
          height="70"
          rx="14"
          fill="#2F6E52"
        />
        <path
          className="brand__calendar-accent"
          d="M60 15H71A14 14 0 0 1 85 29V40H60Z"
          fill="#FF6B49"
        />
        <line
          className="brand__calendar-grid"
          x1="15"
          y1="40"
          x2="85"
          y2="40"
          stroke="#F1EEE3"
          strokeWidth="5"
        />
        <line
          className="brand__calendar-grid"
          x1="38"
          y1="40"
          x2="38"
          y2="85"
          stroke="#F1EEE3"
          strokeWidth="4"
        />
        <line
          className="brand__calendar-grid"
          x1="62"
          y1="40"
          x2="62"
          y2="85"
          stroke="#F1EEE3"
          strokeWidth="4"
        />
        <line
          className="brand__calendar-grid"
          x1="15"
          y1="62.5"
          x2="85"
          y2="62.5"
          stroke="#F1EEE3"
          strokeWidth="4"
        />
        <path
          className="brand__check-outline"
          d="M5 55L38 85L94 18"
          fill="none"
          stroke="#F1EEE3"
          strokeWidth="18"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          className="brand__check"
          d="M5 55L38 85L94 18"
          fill="none"
          stroke="#FF6B49"
          strokeWidth="10"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <BrandedName className="brand__word" ariaHidden />
    </div>
  );
}
