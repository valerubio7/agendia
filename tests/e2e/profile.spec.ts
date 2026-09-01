import { expect, test } from "@playwright/test";
import {
  InMemoryProfileRepository,
  ProfileService,
} from "../../packages/domain/src/business-profile.ts";
import { renderProfile } from "../support/web/profile-render.ts";

test("the authenticated tenant saves and reloads its own profile", async ({
  page,
}) => {
  const service = new ProfileService(new InMemoryProfileRepository());
  service.save("tenant-a", {
    displayName: "Clínica Norte",
    description: "Salud",
    address: "Calle 1",
    contact: "11-5555",
    businessHours: "24 horas",
    offerings: "Consultas",
    faq: "Con turno",
    policies: "Cancelar con 24 h",
    additionalInfo: "Guardia",
  });
  await page.setContent(renderProfile(service.get("tenant-a")!));
  await expect(
    page.getByRole("heading", { name: "Información del negocio" }),
  ).toBeVisible();
  await expect(page.getByText("Clínica Norte")).toBeVisible();
  await expect(page.getByText("24 horas")).toBeVisible();
  expect(service.get("tenant-b")).toBeNull();
});
