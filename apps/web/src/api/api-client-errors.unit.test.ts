import { describe, expect, test } from "bun:test";
import { ApiClient, ApiError } from "./api-client";

const messages = [
  [409, "CONFLICT", "Service name already exists", "Ya hay un servicio con ese nombre. Elegí otro nombre."],
  [409, "CONFLICT", "Client phone already exists", "Ya hay un cliente con ese teléfono. Usá otro teléfono."],
  [409, "CONFLICT", "Resource name already exists", "Ya hay un recurso con ese nombre. Elegí otro nombre."],
  [409, "CONFLICT", "Resource hours must fit business hours", "Los horarios de los recursos deben estar dentro del horario del negocio. Revisá ambos horarios."],
  [409, "CONFLICT", "Resource change conflicts with future appointments", "El cambio del recurso presenta un conflicto con turnos futuros. Revisá los turnos antes de continuar."],
  [409, "CONFLICT", "Service change conflicts with future appointments", "El cambio del servicio presenta un conflicto con turnos futuros. Revisá los turnos antes de continuar."],
  [409, "CONFLICT", "Calendar change conflicts with future appointments", "El cambio del calendario presenta un conflicto con turnos futuros. Revisá los turnos antes de continuar."],
  [400, "VALIDATION_FAILED", "Services must belong to this business", "Algunos servicios seleccionados ya no están disponibles. Actualizá la lista y volvé a elegirlos."],
] as const;

describe("safe API error feedback", () => {
  test.each(messages)("translates the identified response %s %s %s", async (status, code, message, expected) => {
    const client = new ApiClient(async () => Response.json({ code, message }, { status }));
    const error = await client.resources().catch(cause => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect(client.errorMessage(error)).toBe(expected);
  });

  test.each(messages)("does not translate mismatched status or code for %s %s %s", (status, code, message) => {
    const client = new ApiClient();
    expect(client.errorMessage(new ApiError(code, message, 500)))
      .toBe(code === "CONFLICT" ? "Los datos cambiaron. Recargá y volvé a intentar." : "Revisá los campos indicados.");
    expect(client.errorMessage(new ApiError("INTERNAL_ERROR", message, status)))
      .toBe("No se pudo completar la operación.");
  });

  test.each([
    [401, "UNAUTHENTICATED", "Invalid credentials", "No se pudo iniciar sesión. Revisá tus datos o intentá nuevamente más tarde."],
    [429, "FORBIDDEN", "Too many login attempts", "No se pudo iniciar sesión. Intentá nuevamente más tarde."],
  ] as const)("provides safe login feedback for %s %s", async (status, code, message, expected) => {
    for (const admin of [false, true]) {
      const calls: string[] = [];
      const client = new ApiClient(async path => {
        calls.push(path);
        return Response.json({ code, message }, { status });
      });
      const error = await client.login("user@example.test", "password", admin).catch(cause => cause);
      expect(error).toBeInstanceOf(ApiError);
      expect(client.loginErrorMessage(error)).toBe(expected);
      expect(calls).toEqual([admin ? "/api/auth/admin/login" : "/api/auth/login"]);
    }
  });

  test("keeps unrelated login failures and unknown responses safe", () => {
    const client = new ApiClient();
    expect(client.loginErrorMessage(new ApiError("FORBIDDEN", "Origin rejected", 403))).toBe("No se pudo iniciar sesión. Intentá nuevamente más tarde.");
    expect(client.loginErrorMessage(new ApiError("INTERNAL_ERROR", "private diagnostic", 500))).toBe("No se pudo completar la operación.");
    expect(client.loginErrorMessage(new ApiError("UNAUTHENTICATED", "Invalid credentials", 500))).toBe("No se pudo iniciar sesión. Intentá nuevamente más tarde.");
  });

  test("handles ambiguous registration conflicts without asserting account existence", async () => {
    const client = new ApiClient(async () => Response.json({ code: "CONFLICT", message: "Registration unavailable" }, { status: 409 }));
    const error = await client.register({ name: "Negocio", email: "user@example.test", password: "password" }).catch(cause => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect(client.registrationErrorMessage(error)).toBe("No se pudo enviar la solicitud. Revisá los datos o intentá nuevamente más tarde.");
    expect(client.registrationErrorMessage(new ApiError("CONFLICT", "private diagnostic", 409))).toBe("Los datos cambiaron. Recargá y volvé a intentar.");
    expect(client.registrationErrorMessage(new ApiError("FORBIDDEN", "Too many registration attempts", 429))).toBe("No se pudo enviar la solicitud. Intentá nuevamente más tarde.");
  });

  test("preserves generic feedback and never displays unknown backend text", () => {
    const client = new ApiClient();
    expect(client.errorMessage(new ApiError("CONFLICT", "private diagnostic", 409))).toBe("Los datos cambiaron. Recargá y volvé a intentar.");
    expect(client.errorMessage(new ApiError("VALIDATION_FAILED", "private diagnostic", 400))).toBe("Revisá los campos indicados.");
    expect(client.errorMessage(new ApiError("UNAUTHENTICATED", "private diagnostic", 401))).toBe("Tu sesión expiró o el negocio está suspendido. Iniciá sesión nuevamente.");
    expect(client.errorMessage(new Error("private diagnostic"))).toBe("No se pudo completar la operación.");
  });
});
