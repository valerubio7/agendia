import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { LoginScreen } from "../../apps/web/src/features/auth/login-screen";
import { TerminalAuthenticatedState } from "../../apps/web/src/shell/authenticated-shell";

// React belongs to the web workspace, not the repository root.
const webRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { createElement } = webRequire("react");
const { renderToStaticMarkup } = webRequire("react-dom/server");

const loginProps = {
  feedback: null,
  loginPending: false,
  submitAction: () => {},
};

describe("login entrance presentation", () => {
  test("keeps the customer and legacy login presentation unchanged by default", () => {
    const html = renderToStaticMarkup(createElement(LoginScreen, loginProps));
    expect(html).toContain('<h1 id="login-title">Iniciar sesión</h1>');
    expect(html).toContain("Qué bueno verte de nuevo.");
    expect(html).toContain('aria-busy="false"');
    expect(html).toContain('<input type="email" autoComplete="email" autoCapitalize="none" required="" name="email"/>');
    expect(html).toContain('<input type="password" autoComplete="current-password" minLength="16" required="" name="password"/>');
    expect(html).toContain('type="submit">Ingresar</button>');
  });

  test("identifies the admin entrance without changing the shared login form", () => {
    const customer = renderToStaticMarkup(createElement(LoginScreen, loginProps));
    const admin = renderToStaticMarkup(createElement(LoginScreen, {
      ...loginProps,
      title: "Acceso de administración",
    }));
    expect(admin).toBe(customer.replace(
      '<h1 id="login-title">Iniciar sesión</h1>',
      '<h1 id="login-title">Acceso de administración</h1>',
    ));
  });

  test("preserves pending and error feedback on the shared form", () => {
    const html = renderToStaticMarkup(createElement(LoginScreen, {
      ...loginProps,
      loginPending: true,
      feedback: createElement("p", { role: "alert" }, "Correo o contraseña incorrectos."),
    }));
    expect(html).toContain('<p role="alert">Correo o contraseña incorrectos.</p>');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('type="submit" disabled="">Ingresando…</button>');
  });
});

describe("panel login recovery", () => {
  test.each(["session-recovery", "denied", "load-error"] as const)(
    "%s defaults to root and supports the admin entrance without changing feedback or retry",
    (state) => {
      const props = { state, message: "No se pudo acceder.", retryAction: () => {} };
      const business = renderToStaticMarkup(createElement(TerminalAuthenticatedState, props));
      expect(business).toContain('href="/">Ir a iniciar sesión</a>');
      expect(business).toContain('<p role="alert">No se pudo acceder.</p>');
      expect(business.includes("Volver a intentar")).toBe(state === "load-error");
      const admin = renderToStaticMarkup(createElement(TerminalAuthenticatedState, {
        ...props,
        loginHref: "/admin/login",
      }));
      expect(admin).toBe(business.replace('href="/"', 'href="/admin/login"'));
    },
  );

  test("keeps loading free of recovery actions", () => {
    const html = renderToStaticMarkup(createElement(TerminalAuthenticatedState, { state: "loading" }));
    expect(html).toContain('<p role="status">Cargando panel…</p>');
    expect(html).not.toContain("href=");
  });
});
