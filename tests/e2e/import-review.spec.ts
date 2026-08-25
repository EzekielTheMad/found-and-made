import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import sharp from "sharp";

const sourceText = `E2E Imported Soup
Serves 4
Ingredients:
1 cup lentils
2 cups water
Steps:
Simmer lentils in the water until tender.`;

test("automatically imports private recipes and Mealie hero images", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Name").fill("Import Owner");
  await page.getByLabel("Email").fill("import-owner@example.com");
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Create Owner" }).click();
  await expect(
    page.getByRole("heading", { exact: true, name: "Your recipes" }),
  ).toBeVisible();

  await page.goto("/imports");
  await expect(
    page.getByRole("heading", { name: "Import from almost anywhere" }),
  ).toBeVisible();
  await expect(page.getByLabel("Recipe text", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Recipe website URL")).toHaveCount(0);

  await page.getByLabel("Source type").selectOption("website");
  await expect(page.getByLabel("Recipe website URL")).toBeVisible();
  await expect(page.getByLabel("Fallback recipe text")).toBeVisible();
  await expect(page.getByLabel("Default recipe creator")).toHaveCount(0);
  await expect(page.getByLabel("Recipe text", { exact: true })).toHaveCount(0);

  await page.getByLabel("Source type").selectOption("migration_json");
  await expect(
    page.getByLabel("Recipe manager", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Recipe export file", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Default recipe creator")).toBeVisible();
  await expect(page.getByLabel("Recipe website URL")).toHaveCount(0);

  await page.getByLabel("Source type").selectOption("pasted_text");
  await page.getByLabel("Recipe text", { exact: true }).fill(sourceText);
  await page.getByRole("button", { name: "Start private import" }).click();

  await expect(
    page.getByRole("heading", { name: /Imported .*E2E Imported Soup/ }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByRole("heading", { name: "Saved privately" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Open recipe" }).click();
  await expect(
    page.getByRole("heading", { name: "E2E Imported Soup" }),
  ).toBeVisible();
  await expect(
    page.getByText("Simmer lentils in the water until tender."),
  ).toBeVisible();
  const recipeId = new URL(page.url()).pathname.split("/")[2];
  expect(recipeId).toBeTruthy();
  const privatePreviewResponse = await page.request.get(
    `/public/recipes/${recipeId}`,
  );
  expect(privatePreviewResponse.status()).toBe(200);
  const privatePreview = await privatePreviewResponse.text();
  expect(privatePreview).toContain("This recipe is private");
  expect(privatePreview).not.toContain("E2E Imported Soup");

  await page.goto("/imports");
  await page.getByLabel("Source type").selectOption("pasted_text");
  await page.getByLabel("Recipe text", { exact: true }).fill(sourceText);
  await page.getByRole("button", { name: "Start private import" }).click();
  await expect(
    page.getByRole("heading", { name: "Exact duplicate skipped" }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/did not create another copy/i)).toBeVisible();

  await page.goto("/imports");
  await page.getByLabel("Source type").selectOption("website");
  await page.getByLabel("Recipe website URL").fill("http://127.0.0.1/private");
  await page.getByRole("button", { name: "Start private import" }).click();
  await expect(
    page.getByRole("heading", { name: "Import needs attention" }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/supplied material is preserved/i)).toBeVisible();

  await page.goto("/imports");
  await page.getByLabel("Source type").selectOption("pasted_text");
  await page
    .getByLabel("Recipe text", { exact: true })
    .fill(
      "Brand biscuits\nServes 4\nIngredients:\n1 cup Bisquick\nSteps:\nMix the Bisquick with water and bake.",
    );
  await page.getByRole("button", { name: "Start private import" }).click();
  await expect(
    page.getByRole("heading", { name: /Imported .*Brand biscuits/ }),
  ).toBeVisible({ timeout: 10_000 });
  await page.getByText("Things you may want to check later").click();
  await expect(
    page.getByText(/branded ingredient normalization.*best guesses/i),
  ).toBeVisible();
  await page.getByRole("link", { name: "Open recipe" }).click();
  await expect(
    page.getByRole("heading", { name: "Brand biscuits" }),
  ).toBeVisible();

  await page.goto("/imports");
  await page.getByLabel("Source type").selectOption("migration_json");
  await page
    .getByLabel("Recipe manager", { exact: true })
    .selectOption("mealie");
  await page.getByLabel("Recipe export file", { exact: true }).setInputFiles({
    buffer: Buffer.from(JSON.stringify({ users: [{ id: "not-a-recipe" }] })),
    mimeType: "application/json",
    name: "not-recipes.json",
  });
  await page.getByRole("button", { name: "Queue private migration" }).click();
  await expect(page.getByText(/No supported recipes were found/)).toBeVisible();
  await expect(page.getByText(/Reference:/)).toHaveCount(0);
  await page.getByLabel("Default recipe creator").fill("Family Archive");

  const image = await sharp({
    create: {
      background: { alpha: 1, b: 70, g: 130, r: 80 },
      channels: 4,
      height: 16,
      width: 16,
    },
  })
    .webp()
    .toBuffer();
  const archive = zipSync({
    "recipes/tomato-soup/images/original.webp": new Uint8Array(image),
    "recipes/tomato-soup/tomato-soup.json": strToU8(
      JSON.stringify({
        author: { name: "Grandma Rosa" },
        name: "Migrated tomato soup",
        orgURL: "https://recipes.example.test/grandmas-tomato-soup",
        recipe_ingredient: [
          { display: "2 cups tomatoes", note: "tomatoes", quantity: 2 },
        ],
        recipe_instructions: [{ text: "Simmer the tomatoes." }],
        recipe_servings: 4,
      }),
    ),
    "recipes/bean-stew/bean-stew.json": strToU8(
      JSON.stringify({
        name: "Migrated bean stew",
        recipe_ingredient: [
          { display: "2 cups beans", note: "beans", quantity: 2 },
        ],
        recipe_instructions: [{ text: "Simmer the beans." }],
        recipe_servings: 6,
      }),
    ),
  });
  await page.getByLabel("Recipe export file", { exact: true }).setInputFiles({
    buffer: Buffer.from(archive),
    mimeType: "application/zip",
    name: "mealie-backup.zip",
  });
  await page.getByRole("button", { name: "Queue private migration" }).click();
  await expect(
    page.getByRole("heading", { name: /Importing|Import complete/ }),
  ).toBeVisible({ timeout: 10_000 });
  const batchUrl = page.url();
  await expect(
    page.getByRole("heading", { name: "Import complete: 2 saved" }),
  ).toBeVisible({ timeout: 15_000 });
  await page.getByText("View individual imports").click();
  await page
    .locator(".import-batch-card")
    .getByRole("link", { name: /Migrated tomato soup/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Migrated tomato soup" }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.getByAltText("Migrated tomato soup")).toBeVisible();
  await expect(page.getByText("Grandma Rosa", { exact: true })).toBeVisible();
  await expect(page.getByText("Import Owner", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "recipes.example.test" }),
  ).toHaveAttribute(
    "href",
    "https://recipes.example.test/grandmas-tomato-soup",
  );

  const tomatoPath = new URL(page.url()).pathname;
  await page.goto(batchUrl);
  await page.getByText("View individual imports").click();
  await page
    .locator(".import-batch-card")
    .getByRole("link", { name: /Migrated bean stew/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Migrated bean stew" }),
  ).toBeVisible();
  await expect(page.getByText("Family Archive", { exact: true })).toBeVisible();
  await expect(page.getByText("Import Owner", { exact: true })).toBeVisible();

  await page.goto(batchUrl);
  await page.getByRole("link", { name: "Manage imported recipes" }).click();
  await expect(page.getByText(/Showing 2 completed recipes/)).toBeVisible();
  await page.getByRole("button", { name: "Bulk edit" }).click();
  await page.getByRole("button", { name: "Select all shown" }).click();
  await page.getByLabel("New labels, comma separated").fill("Reimport cleanup");
  await page.getByRole("button", { name: "Add to 2 recipes" }).click();
  await expect(
    page.getByText("Updated 2 recipes.", { exact: true }),
  ).toBeVisible();

  await page.goto(`${tomatoPath}/classification`);
  await expect(page.getByLabel("Soup", { exact: true })).toBeChecked();
  await expect(page.getByLabel("Labels (comma separated)")).toHaveValue(
    "Reimport cleanup",
  );

  await page.goto(batchUrl);
  await page.getByRole("link", { name: "Manage imported recipes" }).click();
  await page.getByRole("button", { name: "Bulk edit" }).click();
  await page.getByRole("button", { name: "Select all shown" }).click();
  await page.getByLabel("Bulk action").selectOption("publish");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Make 2 public" }).click();
  await expect(
    page.getByText("2 recipes are now public.", { exact: true }),
  ).toBeVisible();

  await page.getByLabel("Bulk action").selectOption("unpublish");
  await page.getByRole("button", { name: "Make 2 private" }).click();
  await expect(
    page.getByText("2 recipes are now private.", { exact: true }),
  ).toBeVisible();

  await page.getByLabel("Bulk action").selectOption("trash");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Move 2 to recycle bin" }).click();
  await expect(
    page.getByText("2 recipes moved to the recycle bin.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Migrated tomato soup/ }),
  ).toHaveCount(0);
  await page.goto("/recipes/trash");
  await expect(
    page.getByRole("heading", { name: "Migrated tomato soup" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Migrated bean stew" }),
  ).toBeVisible();

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});
