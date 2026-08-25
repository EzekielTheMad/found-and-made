import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";

test.describe.serial("recipe core journey", () => {
  test("creates, edits, scales, projects, variants, trashes, and restores", async ({
    page,
  }, testInfo) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Create the local Owner" }),
    ).toBeVisible();
    await page.getByLabel("Name").fill("E2E Owner");
    await page.getByLabel("Email").fill("owner@example.com");
    await page.getByLabel("Password").fill("correct horse battery staple");
    await page.getByRole("button", { name: "Create Owner" }).click();
    await expect(
      page.getByRole("heading", { exact: true, name: "Your recipes" }),
    ).toBeVisible();
    await assertNoAxeViolations(page);

    await page.getByRole("link", { name: "Add a recipe" }).first().click();
    await page.getByLabel("Recipe title").fill("E2E Four Serving Recipe");
    await page.getByLabel("Base servings").fill("4");
    await page.getByLabel("Descriptive yield").fill("Serves 4");
    await page.getByLabel("Recipe creator").fill("Aunt June");
    await page
      .getByLabel("Source URL")
      .fill("https://recipes.example.test/aunts-lasagna#method");
    await page.getByRole("button", { name: "Create private draft" }).click();

    await expect(
      page.getByRole("heading", { name: "Ingredients" }),
    ).toBeVisible();
    await page
      .locator(".ingredient-editor-row")
      .getByLabel("Name", { exact: true })
      .fill("yellow onion");
    await page
      .getByLabel("Instruction")
      .fill("Cook the onion until translucent.");
    await page.getByRole("button", { name: "Save recipe" }).click();

    await expect(
      page.getByRole("heading", { name: "E2E Four Serving Recipe" }),
    ).toBeVisible();
    await expect(page.getByText("Aunt June", { exact: true })).toBeVisible();
    await expect(page.getByText("E2E Owner", { exact: true })).toBeVisible();
    await expect(page.getByText("Private", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "recipes.example.test" }),
    ).toHaveAttribute("rel", "noreferrer");
    for (const action of ["Edit recipe", "Photos", "Classify", "Print"]) {
      await expect(page.getByRole("link", { name: action })).toHaveCSS(
        "background-color",
        "rgb(47, 91, 63)",
      );
    }
    await page.getByLabel("Target servings").fill("6");
    await expect(page.locator(".ingredient-row .quantity")).toHaveText("1½");
    await expect(
      page.getByText("Times, temperatures, pan sizes"),
    ).toBeVisible();
    await expect(page.locator(".step-group > h2")).toHaveText("Main");
    await expect(page.locator(".step-card .status-chip")).toHaveCount(0);
    await expect(page.locator(".ingredient-row").first()).toHaveCSS(
      "text-align",
      "left",
    );
    expect(
      await page.evaluate(() => {
        const recipe = document.querySelector(".classic-layout");
        const notes = document.querySelector(".personal-cooking-card");
        return Boolean(
          recipe &&
          notes &&
          recipe.compareDocumentPosition(notes) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        );
      }),
    ).toBe(true);

    await page.getByRole("button", { name: "Guided" }).click();
    await expect(page.getByText("Step 1 of 1")).toBeVisible();
    await page.getByRole("button", { name: "Merge Grid" }).click();
    await expect(page.locator("table.merge-grid")).toBeVisible();
    await assertNoAxeViolations(page);

    for (const width of [390, 768, 1440, 1920]) {
      await page.setViewportSize({ height: 900, width });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        fullPage: true,
        path: testInfo.outputPath(`recipe-grid-${width}.png`),
      });
      if (width === 1920) {
        expect(
          await page
            .locator(".recipe-shell")
            .evaluate((element) =>
              Math.round(element.getBoundingClientRect().width),
            ),
        ).toBeGreaterThan(1500);
      }
    }
    await page.setViewportSize({ height: 900, width: 1440 });

    await page.getByText("Save scaled variant").click();
    await page.getByLabel("Variant title").fill("E2E Recipe for Six");
    await page
      .getByRole("button", { name: "Save independent variant" })
      .click();
    await expect(
      page.getByRole("heading", { name: "E2E Recipe for Six" }),
    ).toBeVisible();
    await expect(page.getByText("Original yield 6 servings")).toBeVisible();

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Move to recycle bin" }).click();
    await page.waitForURL((url) => url.pathname === "/");
    await page.goto("/recipes/trash");
    await expect(
      page.getByRole("heading", { name: "E2E Recipe for Six" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Restore recipe" }).click();
    await expect(
      page.getByRole("heading", { name: "E2E Recipe for Six" }),
    ).toBeVisible();

    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: "Library" })
      .click();
    await page
      .locator('section[aria-label="Recipe library"]')
      .getByRole("link", { name: /E2E Four Serving Recipe/ })
      .click();
    await expect(page.getByLabel("Target servings")).toHaveValue("6");
    await expect(page.locator(".ingredient-row .quantity")).toHaveText("1½");

    await page.getByRole("link", { name: "Edit recipe" }).click();
    await page.getByLabel("Recipe title").fill("Temporarily Changed Recipe");
    await page.getByRole("button", { name: "Save recipe" }).click();
    await expect(
      page.getByRole("heading", { name: "Temporarily Changed Recipe" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Edit recipe" }).click();
    await page
      .getByRole("button", { name: "Restore this content" })
      .first()
      .click();
    await expect(page.getByLabel("Recipe title")).toHaveValue(
      "E2E Four Serving Recipe",
    );
    await assertNoAxeViolations(page);

    const recipeId = new URL(page.url()).pathname.split("/")[2];
    expect(recipeId).toBeTruthy();
    const publicPath = `/public/recipes/${recipeId}`;
    await page.goto("/taxonomy");
    await page.getByLabel("Category name").fill("Holiday");
    await page.getByLabel(/Also recognize/).fill("Festive");
    await page.getByRole("button", { name: "Add category" }).click();
    await expect(
      page.getByText("Holiday (festive)", { exact: true }),
    ).toBeVisible();

    await page.goto(`/recipes/${recipeId}/classification`);
    await page.getByLabel("Holiday").check();
    await page.getByLabel("Labels (comma separated)").fill("family favorite");
    await page
      .getByRole("button", { name: "Save categories and labels" })
      .click();

    await page.goto("/");
    const recipeLibrary = page.locator('section[aria-label="Recipe library"]');
    await page
      .getByRole("link", { exact: true, name: "Weeknight Dinner" })
      .click();
    await expect(
      recipeLibrary.getByRole("link", { name: /E2E Four Serving Recipe/ }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Filter" }).click();
    await page
      .locator('.default-view-form select[name="viewId"]')
      .selectOption({ label: "Weeknight Dinner" });
    await page.getByRole("button", { name: "Set default" }).click();
    await expect(
      recipeLibrary.getByRole("link", { name: /E2E Four Serving Recipe/ }),
    ).toHaveCount(0);
    await page
      .locator('.default-view-form select[name="viewId"]')
      .selectOption("");
    await page.getByRole("button", { name: "Set default" }).click();
    await expect(
      recipeLibrary.getByRole("link", { name: /E2E Four Serving Recipe/ }),
    ).toBeVisible();

    await page.getByLabel("Search recipes").fill("onion");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(
      recipeLibrary.getByRole("link", { name: /E2E Four Serving Recipe/ }),
    ).toBeVisible();
    await page.getByText("Save this view").click();
    await page.getByLabel("View name").fill("Onion recipes");
    await page.getByRole("button", { name: "Save view" }).click();
    await expect(
      page.getByRole("link", { exact: true, name: "Onion recipes" }),
    ).toHaveAttribute("aria-current", "page");

    const photoBuffer = await sharp({
      create: {
        background: "#9b4d35",
        channels: 3,
        height: 320,
        width: 640,
      },
    })
      .png()
      .toBuffer();
    await page.goto(`/recipes/${recipeId}/media`);
    await page.getByLabel("Image").setInputFiles({
      buffer: photoBuffer,
      mimeType: "image/png",
      name: "finished-dish.png",
    });
    await page.getByLabel("Alt text").first().fill("Finished onion dish");
    await page.getByLabel("Caption").first().fill("Ready to serve");
    await page.getByRole("button", { name: "Upload and sanitize" }).click();
    await expect(page.getByAltText("Finished onion dish")).toBeVisible();
    const heroPath = await page
      .getByAltText("Finished onion dish")
      .getAttribute("src");
    expect(heroPath).toMatch(/^\/api\/media\/.+\/web$/);

    await page.getByLabel("Image").setInputFiles({
      buffer: photoBuffer,
      mimeType: "image/png",
      name: "onion-step.png",
    });
    await page.getByLabel("Placement").selectOption("step");
    await page.locator('select[name="stepId"]').selectOption({ index: 1 });
    await page.getByLabel("Alt text").first().fill("Onion cooking step");
    await page.getByRole("button", { name: "Upload and sanitize" }).click();
    await expect(page.getByAltText("Onion cooking step")).toBeVisible();
    const stepPath = await page
      .getByAltText("Onion cooking step")
      .getAttribute("src");
    expect(stepPath).toMatch(/^\/api\/media\/.+\/web$/);

    const heroCard = page
      .locator("figure.media-card")
      .filter({ has: page.getByAltText("Finished onion dish") });
    await heroCard.getByLabel("Alt text").fill("Finished onion dish on table");
    await heroCard.getByLabel(/Horizontal focal point/).fill("75");
    await heroCard.getByRole("button", { name: "Save photo details" }).click();
    await expect(
      page.getByAltText("Finished onion dish on table"),
    ).toBeVisible();

    await page.goto(`/recipes/${recipeId}`);
    await expect(
      page.getByAltText("Finished onion dish on table"),
    ).toBeVisible();
    await expect(page.getByAltText("Onion cooking step")).toBeVisible();
    const privatePublicResponse = await page.request.get(publicPath);
    expect(privatePublicResponse.status()).toBe(200);
    const privatePublicBody = await privatePublicResponse.text();
    expect(privatePublicBody).toContain("This recipe is private");
    expect(privatePublicBody).toContain("Sign in");
    expect(privatePublicBody).not.toContain("E2E Four Serving Recipe");
    expect(privatePublicBody).not.toContain("Serves 4");
    expect(privatePublicBody).not.toContain("Finished onion dish");
    expect(
      (await page.request.get(heroPath!.replace("/api/", "/public/"))).status(),
    ).toBe(404);
    await page.goto("/people");
    await page.getByRole("button", { name: "Enable public mode" }).click();
    await page.goto(`/recipes/${recipeId}`);
    await page.getByRole("button", { name: "Publish recipe" }).click();
    await page.getByRole("link", { name: "View public page" }).click();
    await expect(
      page.getByRole("heading", { name: "E2E Four Serving Recipe" }),
    ).toBeVisible();
    await expect(
      page.getByAltText("Finished onion dish on table"),
    ).toBeVisible();
    await expect(page.getByAltText("Onion cooking step")).toBeVisible();
    const publicHeroPath = heroPath!.replace("/api/", "/public/");
    expect((await page.request.get(publicHeroPath)).status()).toBe(200);
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      "content",
      /\/public\/media\/.+\/social$/,
    );
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      new RegExp(`${publicPath}$`),
    );
    expect(
      await page.locator('script[type="application/ld\\+json"]').textContent(),
    ).toContain('"@type":"Recipe"');
    await assertNoAxeViolations(page);

    await page.goto("/taxonomy");
    await page.getByLabel("Collection title").fill("E2E Supper Collection");
    await page
      .getByLabel("Description")
      .fill("A deliberately published recipe collection.");
    await page.getByRole("button", { name: "Create collection" }).click();
    const collection = page.locator("article.collection-editor").filter({
      has: page.getByRole("heading", { name: "E2E Supper Collection" }),
    });
    await collection
      .getByRole("checkbox", { name: "E2E Four Serving Recipe" })
      .check();
    await collection
      .getByRole("button", { name: "Save collection recipes" })
      .click();
    await collection
      .getByRole("button", { name: "Publish collection" })
      .click();
    const publicCollectionPath = await collection
      .getByRole("link", { name: "View public collection" })
      .getAttribute("href");
    expect(new URL(publicCollectionPath!).pathname).toMatch(
      /^\/public\/collections\/.+$/,
    );

    await page.goto("/account");
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    expect((await page.request.get(heroPath!)).status()).toBe(404);
    await page.goto("/");
    await expect(
      page.getByRole("heading", {
        name: "Recipes from anywhere, made yours.",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /E2E Four Serving Recipe/ }),
    ).toBeVisible();
    await page.goto(publicPath);
    await expect(
      page.getByRole("heading", { name: "E2E Four Serving Recipe" }),
    ).toBeVisible();
    await page.goto(publicCollectionPath!);
    await expect(
      page.getByRole("heading", { name: "E2E Supper Collection" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "E2E Four Serving Recipe" }),
    ).toBeVisible();
    await assertNoAxeViolations(page);
  });
});

async function assertNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
}
