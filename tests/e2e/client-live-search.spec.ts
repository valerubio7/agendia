import { expect, type Page } from "@playwright/test";
import { createBusinessInAdminUi, login, test } from "./support/fixtures.ts";

const clara = { id: "clara", name: "Clara López", phone: "+5491123456777" };
const claudio = { id: "claudio", name: "Claudio Díaz", phone: "+5491123456788" };

// Only session setup writes, through the isolated system fixture. Search/history responses are read-only fixtures.
async function start(page: Page, admin: Page, system: { webUrl: string; admin: { email: string; password: string } }) {
  const email = "live-search@example.test", password = "isolated search fixture password";
  await login(admin, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await createBusinessInAdminUi(admin, { name: "Búsqueda en vivo", email, password });
  await login(page, system.webUrl, email, password);
  await expect(page).toHaveURL(/\/inicio$/);
  const writes: string[] = [];
  await page.route(/\/api\/me\//, route => {
    const request = route.request();
    if (/^(GET|HEAD)$/.test(request.method())) return route.continue();
    writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
    return route.abort();
  });
  return writes;
}

const clientList = (url: URL) => url.pathname === "/api/me/clients";
const queryIs = (query: string) => (request: { url(): string }) => {
  const url = new URL(request.url());
  return clientList(url) && url.searchParams.get("q") === query;
};

const gate = () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  return { held, release };
};

test("booking live search selects the first current match on Enter without submitting", async ({ browser, page: admin, system }) => {
  const page = await browser.newPage();
  const latest = gate(), obsolete = gate(), closing = gate();
  try {
    const writes = await start(page, admin, system);
    await page.route(clientList, async route => {
      if (route.request().method() !== "GET") return route.fallback();
      const query = new URL(route.request().url()).searchParams.get("q");
      if (query === "Claudio Díaz") await latest.held;
      if (query === "Pendiente") await obsolete.held;
      if (query === "Cerrar") await closing.held;
      return route.fulfill({ json: query === "No existe" ? [] : query === "Claudio Díaz" || query === claudio.phone ? [claudio] : [clara, claudio] });
    });
    await page.getByRole("button", { name: "Nuevo turno", exact: true }).click();
    const form = page.getByRole("form", { name: "Crear turno" });
    const input = form.getByLabel("Buscar cliente por nombre o teléfono");
    const results = form.getByRole("list", { name: "Resultados de clientes" });
    await input.fill("Cla");
    await expect(results.getByRole("button")).toHaveCount(2);
    await input.press("Enter");
    await expect(results.getByRole("button", { name: /Clara López/ })).toHaveAttribute("aria-pressed", "true");
    const requestedLatest = page.waitForRequest(queryIs("Claudio Díaz"));
    await input.fill("Claudio Díaz");
    await requestedLatest;
    await input.press("Enter");
    await expect(results).toHaveCount(0);
    latest.release();
    await expect(results.getByRole("button", { name: /Claudio Díaz/ })).toHaveAttribute("aria-pressed", "true");
    await expect(results.getByRole("button", { name: /Clara López/ })).toHaveCount(0);
    await input.fill(claudio.phone);
    await expect(results.getByRole("button", { name: /Claudio Díaz/ })).toHaveAttribute("aria-pressed", "false");
    await input.press("Enter");
    await expect(results.getByRole("button", { name: /Claudio Díaz/ })).toHaveAttribute("aria-pressed", "true");
    await input.fill("No existe");
    await input.press("Enter");
    await expect(results).toHaveCount(0);
    await expect(form.getByRole("heading", { name: "Revisá el turno" })).toHaveCount(0);
    await expect(form.getByRole("alert")).toHaveText(""); // Implicit submission would have triggered validation.
    const requested = page.waitForRequest(queryIs("Pendiente"));
    await input.fill("Pendiente");
    await requested;
    await input.press("Enter");
    const aborted = page.waitForEvent("requestfailed", { predicate: queryIs("Pendiente"), timeout: 5_000 });
    await input.clear();
    await aborted;
    obsolete.release();
    await form.getByRole("button", { name: "Buscar cliente", exact: true }).click();
    const manual = results.getByRole("button", { name: /Clara López/ });
    await expect(manual).toHaveAttribute("aria-pressed", "false");
    await manual.click();
    await expect(manual).toHaveAttribute("aria-pressed", "true");

    const requestedBeforeClose = page.waitForRequest(queryIs("Cerrar"));
    await input.fill("Cerrar");
    await requestedBeforeClose;
    await input.press("Enter");
    const abortedOnClose = page.waitForEvent("requestfailed", { predicate: queryIs("Cerrar"), timeout: 5_000 });
    await form.getByRole("button", { name: "Cancelar formulario" }).click();
    await abortedOnClose;
    closing.release();
    await expect(form).toBeHidden();
    await page.getByRole("button", { name: "Nuevo turno", exact: true }).click();
    await expect(input).toHaveValue("");
    await expect(results).toHaveCount(0);
    expect(writes).toEqual([]);
  } finally { latest.release(); obsolete.release(); closing.release(); await page.close(); }
});

test("Clientes live search opens only the current match and loads its history on Enter", async ({ browser, page: admin, system }) => {
  const page = await browser.newPage();
  const latest = gate(), obsolete = gate(), editing = gate();
  try {
    const writes = await start(page, admin, system);
    const queries: (string | null)[] = [], historyIds: (string | null)[] = [];
    await page.route(clientList, async route => {
      if (route.request().method() !== "GET") return route.fallback();
      const query = new URL(route.request().url()).searchParams.get("q");
      queries.push(query);
      if (query === "Cla") await obsolete.held;
      if (query === "Clau") await latest.held;
      if (query === "Díaz") await editing.held;
      await route.fulfill({ json: query === "Clau" || query === "Díaz" ? [claudio] : [clara, claudio] });
    });
    await page.route(url => url.pathname === "/api/me/appointments" && url.searchParams.has("clientId"), route => {
      if (route.request().method() !== "GET") return route.fallback();
      historyIds.push(new URL(route.request().url()).searchParams.get("clientId"));
      return route.fulfill({ json: [] });
    });
    await page.goto(`${system.webUrl}/clients`);
    const directory = page.getByRole("region", { name: "Directorio de clientes", includeHidden: true });
    const input = directory.getByLabel("Nombre o teléfono");
    const rows = directory.getByRole("list", { name: "Clientes del negocio" }).getByRole("button");
    const detail = page.getByRole("region", { name: "Cliente seleccionado" });
    await expect(rows).toHaveCount(2);
    await input.fill("  Cla  ");
    await expect.poll(() => queries).toEqual([null, "Cla"]);
    await expect(rows).toHaveCount(0);
    await input.press("Enter"); // The old directory rows must not be selectable during the pending search.
    await expect(detail).toBeHidden();
    const aborted = page.waitForEvent("requestfailed", { predicate: queryIs("Cla"), timeout: 5_000 });
    const requestedLatest = page.waitForRequest(queryIs("Clau"));
    await input.fill("Clau");
    await aborted;
    await requestedLatest;
    obsolete.release();
    await expect(detail).toBeHidden();
    expect(historyIds).toEqual([]); // Enter for Cla must not carry over to Clau.
    await input.press("Enter");
    await expect(detail).toBeHidden();
    latest.release();
    await expect(detail.getByRole("heading", { name: "Claudio Díaz" })).toBeVisible();
    await expect(detail.getByText("Este cliente todavía no tiene turnos registrados.")).toBeVisible();
    expect(historyIds).toEqual([claudio.id]);
    expect(queries).toEqual([null, "Cla", "Clau"]);
    await detail.getByRole("button", { name: "Cerrar panel" }).click();
    const refreshed = page.waitForResponse(response => clientList(new URL(response.url())));
    await directory.getByRole("button", { name: "Buscar", exact: true }).click();
    expect((await refreshed).ok()).toBe(true);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Claudio Díaz");
    await expect(detail).toBeHidden();
    expect(historyIds).toEqual([claudio.id]);
    expect(queries).toEqual([null, "Cla", "Clau", "Clau"]);

    const requestedBeforeCreate = page.waitForRequest(queryIs("Díaz"));
    await input.fill("Díaz");
    await requestedBeforeCreate;
    await input.press("Enter");
    await directory.getByRole("button", { name: "Nuevo cliente" }).click();
    const createForm = page.getByRole("form", { name: "Crear cliente" });
    const response = page.waitForResponse(r => queryIs("Díaz")(r.request()));
    editing.release();
    expect((await response).ok()).toBe(true);
    await expect(directory).not.toHaveAttribute("aria-busy", "true");
    await expect(createForm).toBeVisible();
    await expect(detail).toBeHidden();
    expect(historyIds).toEqual([claudio.id]);
    expect(writes).toEqual([]);
  } finally { latest.release(); obsolete.release(); editing.release(); await page.close(); }
});
