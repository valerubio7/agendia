import type { Service } from "../api-client";

const priceFormatter = new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "ARS",
  currencyDisplay: "code",
  minimumFractionDigits: 2,
  maximumFractionDigits: 20,
});

export function ServicesScreen({ services }: { services: readonly Service[] }) {
  return (
    <main className="services-screen" aria-labelledby="services-title">
      <header className="services-header">
        <h1 id="services-title">Servicios</h1>
        <p>Consultá los servicios de tu negocio, sus tiempos y precios.</p>
      </header>
      {services.length === 0 ? (
        <section className="services-empty" aria-labelledby="services-empty-title">
          <h2 id="services-empty-title">Todavía no hay servicios</h2>
          <p>Los servicios de tu negocio aparecerán acá con su duración, precio y estado.</p>
        </section>
      ) : (
        <ul className="services-list" aria-label="Catálogo de servicios">
          {services.map((service) => (
            <li className="services-item" key={service.id}>
              <div className="services-summary">
                <h2>{service.name}</h2>
                <span className="services-status" data-status={service.status}>
                  {service.status === "active" ? "Activo" : "Suspendido"}
                </span>
                {service.description && <p className="services-description">{service.description}</p>}
              </div>
              <dl className="services-terms">
                <div><dt>Duración</dt><dd>{service.durationMinutes} min</dd></div>
                <div><dt>Precio</dt><dd>{priceFormatter.format(service.priceArs)}</dd></div>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
