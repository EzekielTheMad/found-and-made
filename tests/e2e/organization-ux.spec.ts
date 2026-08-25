import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

test("keeps organization, export, cookbook, and account workflows clear", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Name").fill("Organization Owner");
  await page.getByLabel("Email").fill("organization-owner@example.com");
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Create Owner" }).click();

  await page.getByRole("link", { name: "Add a recipe" }).first().click();
  await page.getByLabel("Recipe title").fill("Organization Test Soup");
  await page.getByLabel("Base servings").fill("4");
  await page.getByLabel("Descriptive yield").fill("Serves 4");
  await page.getByRole("button", { name: "Create private draft" }).click();
  await page
    .locator(".ingredient-editor-row")
    .getByLabel("Name", { exact: true })
    .fill("tomato");
  await page.getByLabel("Instruction").fill("Simmer until ready.");
  await page.getByRole("button", { name: "Save recipe" }).click();

  await verifyPage(page, "/imports", "Import from almost anywhere", "imports");
  await verifyPage(page, "/taxonomy", "Categories and labels", "categories");
  await page.getByLabel("Category name").fill("Brunch");
  await page.getByRole("button", { name: "Add category" }).click();
  await expect(page.getByText("Brunch", { exact: true })).toBeVisible();

  await verifyPage(page, "/exports", "Export recipes", "exports");
  await page.getByLabel(/Organization Test Soup/).check();
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Download 1 recipe" }),
  ).toBeEnabled();

  await verifyPage(page, "/cookbooks", "Cookbook builder", "cookbooks");
  await expect(page.getByLabel("Cookbook title")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create cookbook" }),
  ).toBeEnabled();

  await verifyPage(page, "/account", "Connected sign-in methods", "account");
  await expect(
    page.getByRole("heading", { name: "Change password" }),
  ).toBeVisible();
});

async function verifyPage(
  page: Page,
  path: string,
  heading: string,
  captureName: string,
) {
  await page.setViewportSize({ height: 900, width: 1440 });
  await page.goto(path);
  await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  await assertNoAxeViolations(page);
  await assertNoHorizontalOverflow(page);
  await capture(page, `${captureName}-desktop`, 1440);

  await page.setViewportSize({ height: 844, width: 390 });
  await assertNoHorizontalOverflow(page);
  await capture(page, `${captureName}-mobile`, 390);
}

async function assertNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
}

async function assertNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
}

async function capture(page: Page, name: string, width: number) {
  const directory = process.env.VISUAL_CAPTURE_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({
    fullPage: true,
    path: join(directory, `${name}-${width}.png`),
  });
}
