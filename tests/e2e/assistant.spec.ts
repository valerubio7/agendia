import { expect, test } from "@playwright/test";
import {
  AssistantConfigService,
  InMemoryAssistantRepository,
} from "../../packages/domain/src/assistant-config.ts";
import { renderAssistantStatus } from "../support/web/assistant-render.ts";

test("a minimal valid assistant activation persists in the business panel", async ({
  page,
}) => {
  const service = new AssistantConfigService(new InMemoryAssistantRepository());
  service.save("tenant-a", {
    personality: "",
    tone: "",
    instructions: "",
    knowledge: "",
    rules: "",
    restrictions: "",
    active: true,
    expectedRevision: 0,
  });
  await page.setContent(renderAssistantStatus(service.get("tenant-a")!.active));
  await expect(page.getByRole("status")).toHaveText("Activo");
  await expect(page.getByText(/opera las 24 horas/i)).toBeVisible();
});
