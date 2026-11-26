import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { AuthenticatedShell } from "../../apps/web/src/shell/authenticated-shell";

const webRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { createElement } = webRequire("react");
const { renderToStaticMarkup } = webRequire("react-dom/server");
const { PathnameContext } = webRequire("next/dist/shared/lib/hooks-client-context.shared-runtime");

function shell(path: string, activeHref = path, logoutPending = false, variant = "business", sectionPending = false) {
  return renderToStaticMarkup(createElement(PathnameContext.Provider, { value: path },
    createElement(AuthenticatedShell, { variant, activeHref, sectionPending, logoutPending, logoutAction() {} }, "Panel"),
  ));
}

const destinations = [
  ["/clients", "Clientes"], ["/services", "Servicios"], ["/resources", "Recursos"],
  ["/business-calendar", "Horarios"], ["/agent", "Agente"], ["/whatsapp", "WhatsApp"],
] as const;

function nav(html: string, label: string) {
  return html.match(new RegExp(`<nav\\b[^>]*aria-label="${label}"[^>]*>(.*?)<\\/nav>`))?.[1] ?? "";
}

test.each(["/inicio", "/turnos", "/profile", "/services"])("%s has only the three primary destinations in both navs", path => {
  const html = shell(path, path === "/inicio" ? "/turnos" : path);
  for (const label of ["Navegación del negocio", "Navegación móvil del negocio"]) {
    const markup = nav(html, label);
    expect([...markup.matchAll(/href="([^"]+)"/g)].map(match => match[1])).toEqual(["/inicio", "/turnos", "/profile"]);
    expect([...markup.matchAll(/aria-label="([^"]+)"/g)].map(match => match[1])).toEqual(["Inicio", "Agenda", "Negocio"]);
    const current = path === "/services" ? ["location", "/profile"] : ["page", path];
    expect([...markup.matchAll(/aria-current="([^"]+)"[^>]*href="([^"]+)"/g)].map(match => match.slice(1))).toEqual([current]);
  }
});

test("the shell leaves Negocio destinations to the profile overview, without a breadcrumb", () => {
  const html = shell("/profile");
  expect(nav(html, "Gestión del negocio")).toBe("");
  expect(html).toContain("Panel");
  expect(nav(html, "Ruta de navegación")).toBe("");
});

test.each(destinations)("%s links back to Negocio from its breadcrumb", (path, label) => {
  const html = shell(path);
  const breadcrumb = nav(html, "Ruta de navegación");
  expect(breadcrumb).toMatch(/href="\/profile"[^>]*>.*Negocio<\/a>/);
  expect(breadcrumb).toContain(`aria-current="page">${label}</`);
  expect(nav(html, "Gestión del negocio")).toBe("");
});

test("both business navigation variants retain pending logout", () => {
  const buttons = shell("/whatsapp", "/whatsapp", true).match(/<button\b[^>]*disabled=""[^>]*>.*?<\/button>/g);
  expect(buttons?.filter(button => button.includes("Cerrando sesión…"))).toHaveLength(2);
});

test.each(["business", "admin"])("%s disables both logout buttons without announcing logout during section loads", variant => {
  const path = variant === "admin" ? "/businesses" : "/whatsapp";
  const html = shell(path, path, false, variant, true);
  const buttons = html.match(/<button\b[^>]*disabled=""[^>]*>.*?<\/button>/g);
  expect(buttons?.filter(button => button.includes("Cerrar sesión"))).toHaveLength(2);
  expect(html).not.toContain("Cerrando sesión…");
});

test.each(["/solicitudes", "/businesses", "/ajustes"])("admin marks %s as current in both admin-only menus", path => {
  const html = shell(path, "/businesses", true, "admin");
  expect(html).toContain('data-variant="admin"');
  expect(nav(html, "Navegación del negocio")).toBe("");
  expect(nav(html, "Navegación móvil del negocio")).toBe("");
  const menus = [...html.matchAll(/<nav\b[^>]*aria-label="Navegación administrativa"[^>]*>(.*?)<\/nav>/g)];
  expect(menus).toHaveLength(2);
  for (const [, menu] of menus) {
    const links = menu!.match(/<a\b[^>]*>/g) ?? [];
    const href = (link: string) => link.match(/\bhref="([^"]+)"/)?.[1];
    expect(links.map(href)).toEqual(["/solicitudes", "/businesses", "/ajustes"]);
    expect(links.filter(link => /\baria-current="page"/.test(link)).map(href)).toEqual([path]);
  }
});

test("both admin menus retain ready and pending logout", () => {
  for (const pending of [false, true]) {
    const html = shell("/businesses", "/businesses", pending, "admin");
    const label = pending ? "Cerrando sesión…" : "Cerrar sesión";
    const buttons = (html.match(/<button\b[^>]*>/g) ?? []).filter(button => button.includes(`aria-label="${label}"`));
    expect(buttons).toHaveLength(2);
    expect(buttons.map(button => button.includes('disabled=""'))).toEqual([pending, pending]);
  }
});
