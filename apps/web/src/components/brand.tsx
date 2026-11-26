import { PanelBrand } from "./panel-brand";

type BrandProps = {
  className?: string;
  inverse?: boolean;
};

type BrandedNameProps = {
  ariaHidden?: boolean;
  className?: string;
};

export function BrandedName(props: BrandedNameProps) {
  return <PanelBrand {...props} dark />;
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
