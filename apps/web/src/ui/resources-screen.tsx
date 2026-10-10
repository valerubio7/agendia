import type { Resource, Service } from "../api-client";

const days = [
  [1, "Lunes"], [2, "Martes"], [3, "Miércoles"], [4, "Jueves"],
  [5, "Viernes"], [6, "Sábado"], [0, "Domingo"],
] as const;
const clock = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

export function ResourcesScreen({ resources, services }: {
  resources: readonly Resource[];
  services: readonly Service[];
}) {
  const serviceById = new Map(services.map(service => [service.id, service]));
  return (
    <main className="resources-screen" aria-labelledby="resources-title">
      <header className="resources-header">
        <h1 id="resources-title">Recursos</h1>
        <p>Consultá los recursos de tu negocio, sus servicios asignados y horarios semanales.</p>
      </header>
      {resources.length === 0 ? (
        <section className="resources-empty" aria-labelledby="resources-empty-title">
          <h2 id="resources-empty-title">Todavía no hay recursos</h2>
          <p>Los recursos de tu negocio aparecerán acá con su estado, servicios y horarios.</p>
        </section>
      ) : (
        <>
          <p className="resources-schedule-note">Las franjas corresponden al día en que empiezan y pueden continuar al día siguiente.
            No representan turnos disponibles ni incluyen cierres por fecha.</p>
          <ul className="resources-list" aria-label="Catálogo de recursos">
            {resources.map(resource => (
              <li className="resources-item" key={resource.id}>
                <div className="resources-summary">
                  <h2>{resource.name}</h2>
                  <span className="resources-status" data-status={resource.status}>
                    {resource.status === "active" ? "Activo" : "Suspendido"}
                  </span>
                  {resource.description && <p className="resources-description">{resource.description}</p>}
                  <h3>Servicios asignados</h3>
                  {resource.serviceIds.length === 0 ? <p>Sin servicios asignados</p> : (
                    <div className="resources-services">
                      {resource.serviceIds.map(id => {
                        const service = serviceById.get(id);
                        return <p key={id}>{service
                          ? `${service.name}${service.status === "suspended" ? " (suspendido)" : ""}`
                          : `Servicio no disponible en el catálogo (ID: ${id})`}</p>;
                      })}
                    </div>
                  )}
                </div>
                <section className="resources-schedule" aria-label={`Horario semanal de ${resource.name}`}>
                  <h3>Horario semanal</h3>
                  <dl className="resources-week">
                    {days.map(([day, label]) => (
                      <div key={day}>
                        <dt>{label}</dt>
                        <dd>{resource.weeklySchedule[day]?.map(span =>
                          `${clock(span.startMinute)}–${clock(span.endMinute)}${span.endMinute < span.startMinute ? " (día siguiente)" : ""}`
                        ).join(" · ") || "Sin franjas"}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
