import { expect, test } from "@playwright/test";
import { runDeterministicV1Journey } from "../../packages/test-support/src/v1-acceptance.ts";

test("admin to tenant to single link to message to deterministic AI to ACK", async ({
  page,
}) => {
  const result = await runDeterministicV1Journey();
  await page.setContent(
    `<main><h1>Aceptación agendIA v1</h1><pre>${JSON.stringify(result)}</pre></main>`,
  );
  await expect(
    page.getByRole("heading", { name: "Aceptación agendIA v1" }),
  ).toBeVisible();
  await expect(page.getByText(/"businessStatus":"active"/)).toBeVisible();
  await expect(page.getByText(/"secondLinkRejected":true/)).toBeVisible();
  await expect(page.getByText(/"inboundMessages":1/)).toBeVisible();
  await expect(page.getByText(/"aiProvider":"deterministic-ai"/)).toBeVisible();
  await expect(page.getByText(/"deliveryState":"sent"/)).toBeVisible();
});
