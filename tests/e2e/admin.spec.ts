import { expect, test } from "@playwright/test";
import { renderAdminDashboard } from "../support/web/admin-render.ts";

const businesses = [
  {
    id: "b-1",
    name: "Estética Bella",
    status: "active" as const,
    assistantStatus: "inactive" as const,
    whatsappStatus: "connected" as const,
    createdAt: "2026-01-02T10:00:00.000Z",
    lastTechnicalActivityAt: "2026-01-03T10:00:00.000Z",
  },
];

test("an administrator can inspect the required business projection", async ({
  page,
}) => {
  await page.setContent(renderAdminDashboard("platform_admin", businesses));
  await expect(page.getByRole("heading", { name: "Negocios" })).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "Estética Bella" }),
  ).toBeVisible();
  await expect(page.getByRole("cell", { name: "Conectado" })).toBeVisible();
  await expect(page.getByRole("link", { name: /conversaciones/i })).toHaveCount(
    0,
  );
});

test("a business user receives an accessible authorization message instead of admin data", async ({
  page,
}) => {
  await page.setContent(renderAdminDashboard("business_user", businesses));
  await expect(page.getByRole("alert")).toHaveText(
    "No tenés acceso al panel administrativo.",
  );
  await expect(page.getByText("Estética Bella")).toHaveCount(0);
});
