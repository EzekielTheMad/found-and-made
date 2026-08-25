import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

test("builds, previews, saves, and downloads a scaled cookbook PDF", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Name").fill("Print Owner");
  await page.getByLabel("Email").fill("print-owner@example.com");
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Create Owner" }).click();

  await page.getByRole("link", { name: "Add a recipe" }).first().click();
  await page.getByLabel("Recipe title").fill("Printable Onion Soup");
  await page.getByLabel("Base servings").fill("4");
  await page.getByLabel("Descriptive yield").fill("Serves 4");
  await page.getByRole("button", { name: "Create private draft" }).click();
  await page
    .locator(".ingredient-editor-row")
    .getByLabel("Name", { exact: true })
    .fill("yellow onion");
  await page.getByLabel("Instruction").fill("Simmer until tender.");
  await page.getByRole("button", { name: "Save recipe" }).click();
  await page.getByRole("link", { name: "Print" }).click();

  await expect(
    page.getByRole("heading", { name: "Cookbook builder" }),
  ).toBeVisible();
  await page.getByText("Create a custom page style").click();
  await page.getByLabel("Profile name").fill("Family Half-Letter");
  await page.getByLabel("Page size").selectOption("half-letter");
  await page.getByLabel("Duplex-aware margins").check();
  await page.getByRole("button", { name: "Save profile" }).click();

  await page.getByLabel("Cookbook title").fill("E2E Family Binder");
  await page.locator('select[name="profileId"]').selectOption({
    label: "Family Half-Letter",
  });
  await page.getByLabel("Recipe source").selectOption({
    label: "Printable Onion Soup",
  });
  await page.getByRole("radio", { name: /Ingredient map/ }).check();
  await page.getByRole("button", { name: "Create cookbook" }).click();

  await expect(
    page.getByRole("heading", { name: "E2E Family Binder" }),
  ).toBeVisible();
  await expect(
    page
      .locator(".outline-item-identity strong")
      .filter({ hasText: "Printable Onion Soup" }),
  ).toBeVisible();
  await expect(page.locator(".outline-summary")).toContainText("total pages");
  await expect(recipeItemPageCount(page, "Printable Onion Soup")).toHaveText(
    /\d+ pages?/,
  );
  await page.getByRole("tab", { name: /Design & layout/ }).click();
  await expect(page.locator(".fit-diagnostics")).toContainText(/landscape/i);
  await expect(
    page.locator(".section-preview-list").getByText("Printable Onion Soup"),
  ).toBeVisible();

  await page.setViewportSize({ height: 1080, width: 1920 });
  const desktopDesign = await page.locator(".cookbook-design").boundingBox();
  const desktopPreview = await page.locator(".cookbook-preview").boundingBox();
  expect(desktopDesign?.width).toBeGreaterThan(650);
  expect(desktopPreview?.x).toBeGreaterThan(desktopDesign?.x ?? 0);

  await page.setViewportSize({ height: 1080, width: 2560 });
  const ultrawideWorkspace = await page
    .locator(".cookbook-workspace")
    .boundingBox();
  expect(ultrawideWorkspace?.width).toBeGreaterThan(1900);

  await page.setViewportSize({ height: 844, width: 390 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  await page.setViewportSize({ height: 1080, width: 1920 });

  await page
    .getByLabel("Cookbook name", { exact: true })
    .fill("E2E Live Preview Binder");
  await expect(page.locator(".preview-cover h3")).toHaveText(
    "E2E Live Preview Binder",
  );
  await page.getByRole("radio", { name: /Compact card/ }).check();
  await expect(
    page.locator(".print-page").getByText("Compact card"),
  ).toBeVisible();
  await page.getByRole("radio", { name: /Modern/ }).check();
  await expect(
    page.locator(".print-page.preview-style-modern").first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save design & recalculate" }).click();
  await page.waitForURL(/view=design/);
  await expect(page.getByLabel("Cookbook name", { exact: true })).toHaveValue(
    "E2E Live Preview Binder",
  );

  await page.getByRole("tab", { name: /Recipes & sections/ }).click();
  await expect(
    page.locator(".outline-item-identity strong").first(),
  ).toHaveText("E2E Live Preview Binder");

  const recipeItem = page.locator(".outline-items > li").filter({
    hasText: "Printable Onion Soup",
  });
  await recipeItem.getByText("Edit page settings").click();
  await recipeItem.getByLabel("Layout override").selectOption("step-linked");
  await recipeItem.getByLabel("Target servings").fill("6");
  await page.getByRole("button", { name: "Save outline" }).click();
  await page.waitForURL(/view=recipes/);
  await page.getByRole("tab", { name: /Design & layout/ }).click();
  await expect(page.locator(".print-page").getByText("Serves 6")).toBeVisible();
  await expect(
    page.locator(".print-page").getByText(/1½ yellow onion/),
  ).toBeVisible();

  await page.getByRole("tab", { name: /Recipes & sections/ }).click();

  const addOutline = page.locator(".add-outline-form");
  await addOutline.locator('select[name="itemType"]').selectOption("notes");
  await addOutline.locator('input[name="title"]').fill("Kitchen notes");
  await page.getByRole("button", { name: "Add to outline" }).click();
  await expect(
    page
      .locator(".outline-item-identity strong")
      .filter({ hasText: "Kitchen notes" }),
  ).toBeVisible();

  const notesItem = page.locator(".outline-items > li").filter({
    hasText: "Kitchen notes",
  });
  await notesItem.locator(".drag-handle").dragTo(recipeItem);
  await expect(page.locator(".outline-item-identity strong").nth(2)).toHaveText(
    "Kitchen notes",
  );
  await notesItem
    .getByRole("button", { name: /Move Kitchen notes down/ })
    .click();
  await page.getByRole("button", { name: "Save outline" }).click();
  await expect(page.locator(".outline-item-identity strong").last()).toHaveText(
    "Kitchen notes",
  );

  await page.getByRole("button", { name: "Generate print-ready PDF" }).click();
  const pdfLink = page.getByRole("link", { name: "Download PDF" });
  await expect(pdfLink).toBeVisible({ timeout: 10_000 });
  const href = await pdfLink.getAttribute("href");
  expect(href).toBeTruthy();
  const response = await page.request.get(href!);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/pdf");
  expect((await response.body()).subarray(0, 5).toString()).toBe("%PDF-");

  await page.getByText("Manage cookbook", { exact: true }).click();
  const management = page.locator(".cookbook-management-panel");
  await management
    .getByLabel("New cookbook name")
    .fill("E2E Renamed Family Binder");
  await management.getByRole("button", { name: "Rename cookbook" }).click();
  await expect(
    page.getByRole("heading", { name: "E2E Renamed Family Binder" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", {
      exact: true,
      name: "E2E Renamed Family Binder",
    }),
  ).toHaveAttribute("aria-current", "page");

  await page.getByText("Manage cookbook", { exact: true }).click();
  await page.getByRole("button", { name: "Make a copy" }).click();
  await expect(
    page.getByRole("heading", { name: "E2E Renamed Family Binder copy" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", {
      exact: true,
      name: "E2E Renamed Family Binder copy",
    }),
  ).toHaveAttribute("aria-current", "page");

  await page.getByText("Manage cookbook", { exact: true }).click();
  await page.getByText("Delete cookbook", { exact: true }).click();
  await expect(
    page.getByText(/recipes and generated PDFs stay available/i),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Delete cookbook permanently" })
    .click();
  await expect(
    page.getByRole("link", {
      exact: true,
      name: "E2E Renamed Family Binder copy",
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", {
      exact: true,
      name: "E2E Renamed Family Binder",
    }),
  ).toHaveAttribute("aria-current", "page");

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});

function recipeItemPageCount(page: Page, title: string) {
  return page
    .locator(".outline-items > li")
    .filter({ hasText: title })
    .locator(".outline-page-count");
}
