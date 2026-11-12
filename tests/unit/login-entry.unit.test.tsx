import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { LoginScreen } from "../../apps/web/src/features/auth/login-screen";
import { TerminalAuthenticatedState } from "../../apps/web/src/shell/authenticated-shell";
import { entryPathFor, entryRedirectFor } from "../../apps/web/src/shell/entry-path";

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
  test("offers an unchecked, labelled remember-me checkbox for both entrances", () => {
    for (const title of ["Iniciar sesión", "Acceso de administración"]) {
      const html = renderToStaticMarkup(createElement(LoginScreen, { ...loginProps, title }));
      expect(html).toMatch(/<label[^>]*>[^<]*<input type="checkbox" name="remember"\/>[^<]*<\/label>/);
      expect(html).not.toMatch(/<input[^>]*type="checkbox"[^>]*checked/);
    }
  });
  test("links registration only from the business entrance", () => {
    expect(renderToStaticMarkup(createElement(LoginScreen, loginProps))).toContain('href="/register"');
    expect(renderToStaticMarkup(createElement(LoginScreen, { ...loginProps, adminEntrance: true }))).not.toContain('href="/register"');
  });
  test("identifies the admin entrance", () => {
    const admin = renderToStaticMarkup(createElement(LoginScreen, {
      ...loginProps,
      title: "Acceso de administración", adminEntrance: true,
    }));
    expect(admin).toContain("Acceso de administración");
  });

  test("preserves pending and error feedback on the shared form", () => {
    const html = renderToStaticMarkup(createElement(LoginScreen, {
      ...loginProps,
      loginPending: true,
      feedback: createElement("p", { role: "alert" }, "Correo o contraseña incorrectos."),
    }));
    expect(html).toContain("Correo o contraseña incorrectos.");
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/<button\b[^>]*\bdisabled(?:="")?[^>]*>Ingresando…/);
  });
});

describe("panel login recovery", () => {
  test.each(["session-recovery", "denied", "load-error"] as const)(
    "%s defaults to root and supports the admin entrance without changing feedback or retry",
    (state) => {
      const props = { state, message: "No se pudo acceder.", retryAction: () => {} };
      const business = renderToStaticMarkup(createElement(TerminalAuthenticatedState, props));
      expect(business).toContain('href="/"');
      expect(business).toContain("Ir a iniciar sesión");
      expect(business).toContain('role="alert"');
      expect(business).toContain("No se pudo acceder.");
      expect(business.includes("Volver a intentar")).toBe(state === "load-error");
      const admin = renderToStaticMarkup(createElement(TerminalAuthenticatedState, {
        ...props,
        loginHref: "/admin/login",
      }));
      expect(admin).toContain('href="/admin/login"');
      expect(admin).toContain("Ir a iniciar sesión");
      expect(admin).toContain('role="alert"');
      expect(admin).toContain("No se pudo acceder.");
      expect(admin.includes("Volver a intentar")).toBe(state === "load-error");
    },
  );

  test("keeps loading free of recovery actions", () => {
    const html = renderToStaticMarkup(createElement(TerminalAuthenticatedState, { state: "loading" }));
    expect(html).toContain('role="status"');
    expect(html).toContain("Cargando panel…");
    expect(html).not.toContain("href=");
  });
});

describe("entrance routing", () => {
  test("sends each role to its own panel", () => {
    expect(entryPathFor({ role: "platform_admin" })).toBe("/businesses");
    expect(entryPathFor({ role: "business_user" })).toBe("/profile");
  });
  test("only bounces an administrator session from the administration entrance", () => {
    expect(entryRedirectFor({ role: "platform_admin" }, true)).toBe("/businesses");
    expect(entryRedirectFor({ role: "business_user" }, true)).toBeNull();
    expect(entryRedirectFor({ role: "platform_admin" }, false)).toBe("/businesses");
    expect(entryRedirectFor({ role: "business_user" }, false)).toBe("/profile");
  });
});
