import { expect, test } from "@playwright/test";
import { renderWhatsAppPanel } from "../support/web/whatsapp-render.ts";

test("business panel shows only its temporary QR and public WhatsApp state", async ({
  page,
}) => {
  await page.setContent(
    renderWhatsAppPanel({
      access: "active",
      status: "link_required",
      qr: "temporary-tenant-qr",
    }),
  );
  await expect(page.getByRole("heading", { name: "WhatsApp" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Requiere vinculación");
  await expect(page.getByText("temporary-tenant-qr")).toBeVisible();
  await expect(page.getByText(/expira/i)).toBeVisible();
  await expect(page.getByText(/credential|signal key|ciphertext/i)).toHaveCount(
    0,
  );
});

test("suspended access redirects safely and a second link conflict is usable", async ({
  page,
}) => {
  await page.setContent(
    renderWhatsAppPanel({ access: "suspended", status: "connected", qr: null }),
  );
  await expect(page.getByRole("alert")).toContainText(
    "sesión no está disponible",
  );
  await expect(
    page.getByRole("link", { name: "Iniciar sesión" }),
  ).toHaveAttribute("href", "/");
  await page.setContent(
    renderWhatsAppPanel({
      access: "active",
      status: "connected",
      qr: null,
      error: "Ya existe una conexión vinculada",
    }),
  );
  await expect(page.getByRole("status")).toHaveText("Conectado");
  await expect(page.getByRole("alert")).toContainText(
    "Ya existe una conexión vinculada",
  );
  await expect(
    page.getByRole("button", { name: "Vincular WhatsApp" }),
  ).toBeDisabled();
});
