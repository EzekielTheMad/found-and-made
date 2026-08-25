import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("approves Hermes access, issues a clear-once token, and exports portable data", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Name").fill("Integration Owner");
  await page.getByLabel("Email").fill("integration-owner@example.com");
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Create Owner" }).click();

  await page.getByRole("link", { name: "Add a recipe" }).first().click();
  await page.getByLabel("Recipe title").fill("Hermes Export Soup");
  await page.getByLabel("Base servings").fill("4");
  await page.getByLabel("Descriptive yield").fill("Serves 4");
  await page.getByRole("button", { name: "Create private draft" }).click();
  await page
    .locator(".ingredient-editor-row")
    .getByLabel("Name", { exact: true })
    .fill("onion");
  await page.getByLabel("Instruction").fill("Simmer gently.");
  await page.getByRole("button", { name: "Save recipe" }).click();

  await page.goto("/integrations");
  await expect(
    page.getByRole("heading", { name: "Hermes integration" }),
  ).toBeVisible();
  await expect(page.getByText("MCP is disabled")).toBeVisible();
  const recipeApproval = page.locator("form.inline-form").filter({
    hasText: "Hermes Export Soup",
  });
  await recipeApproval.getByRole("button", { name: "Approve" }).click();
  await expect(
    recipeApproval.getByRole("button", { name: "Remove access" }),
  ).toBeVisible();

  await page.getByLabel("Name").fill("E2E Hermes");
  await page.getByLabel("Expires after days").fill("30");
  await page.getByLabel("Include collections and saved views").check();
  await page.getByRole("button", { name: "Issue token" }).click();
  const token = await page.getByLabel("Clear-once service token").inputValue();
  expect(token).toMatch(/^fm_ro_[A-Za-z0-9_-]+$/);
  await page.reload();
  await expect(page.getByLabel("Clear-once service token")).toHaveCount(0);
  await expect(page.getByText("E2E Hermes")).toBeVisible();

  await page.goto("/exports");
  const recipeId = await page
    .getByLabel(/Hermes Export Soup/)
    .getAttribute("value");
  expect(recipeId).toBeTruthy();
  const recipeResponse = await page.request.post("/exports/selection.json", {
    form: {
      includeSource: "on",
      recipeIds: recipeId!,
      unitPreference: "metric",
    },
    headers: { Origin: "http://127.0.0.1:4173" },
  });
  expect(recipeResponse.status()).toBe(200);
  expect(recipeResponse.headers()["cache-control"]).toBe("private, no-store");
  expect(recipeResponse.headers()["content-disposition"]).toContain(
    "attachment",
  );
  const recipeExport: unknown = await recipeResponse.json();
  expect(recipeExport).toMatchObject({
    recipeCount: 1,
    schema: "found-made.recipe-selection-export",
    recipes: [{ unitPreference: "metric" }],
  });

  await page.getByRole("button", { name: "Generate complete export" }).click();
  await expect(page.getByText("Library export created.")).toBeVisible();
  await expect(page.getByText(/^library-[0-9a-f-]{36}$/)).toBeVisible();
  await page.getByRole("button", { name: "Verify integrity" }).click();
  await expect(page.getByText("Export integrity verified.")).toBeVisible();

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});
