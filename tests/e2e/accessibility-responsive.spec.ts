import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

test.describe.serial("accessibility and responsive smoke journey", () => {
  test("keeps first-run, cooking, and public recipe routes usable", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Create the local Owner" }),
    ).toBeVisible();
    await assertNoAxeViolations(page);

    await page.getByLabel("Name").fill("Accessibility Owner");
    await page.getByLabel("Email").fill("accessibility-owner@example.com");
    await page.getByLabel("Password").fill("correct horse battery staple");
    await page.getByRole("button", { name: "Create Owner" }).click();
    await expect(
      page.getByRole("heading", { name: "Your recipes", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Your recipes will live here." }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Filter" })).toBeVisible();
    await expect(page.getByText("Default home view")).toHaveCount(0);
    await assertNoAxeViolations(page);
    await assertSharedDesktopNavigation(page);
    await assertBrandPalette(page);
    await captureVisualCheckpoint(page, "library-desktop", 1440);
    await page.emulateMedia({ colorScheme: "dark" });
    await assertNoAxeViolations(page);
    await assertBrandPalette(page);
    await captureVisualCheckpoint(page, "library-desktop-dark", 1440);
    await page.emulateMedia({ colorScheme: "light" });
    await captureVisualCheckpoint(page, "library-empty", 768);
    await assertCompactMobileLibrary(page);
    await captureVisualCheckpoint(page, "library-mobile", 390);
    await page.setViewportSize({ height: 900, width: 768 });

    await page.goto("/account");
    await page
      .getByLabel("Current password")
      .fill("correct horse battery staple");
    await page
      .getByLabel("New password", { exact: true })
      .fill("new accessible password phrase");
    await page
      .getByLabel("Confirm new password")
      .fill("new accessible password phrase");
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(
      page.getByText(
        "Password changed. Other signed-in devices have been signed out.",
      ),
    ).toBeVisible();
    await assertNoAxeViolations(page);
    await page.goto("/");

    await page.getByRole("link", { name: "Add a recipe" }).first().click();
    await page.getByLabel("Recipe title").fill("Accessible Tomato Soup");
    await page.getByLabel("Base servings").fill("4");
    await page.getByLabel("Descriptive yield").fill("Serves 4");
    await page.getByRole("button", { name: "Create private draft" }).click();
    await assertProgressiveMobileEditor(page);
    await captureVisualCheckpoint(page, "editor-collapsed", 390);
    await page.setViewportSize({ height: 900, width: 768 });
    await page
      .locator(".ingredient-editor-row")
      .getByLabel("Name", { exact: true })
      .fill("tomatoes");
    await page.getByLabel("Instruction").fill("Simmer the tomatoes.");
    await page.getByRole("button", { name: "Save recipe" }).click();
    await expect(
      page.getByRole("heading", { name: "Accessible Tomato Soup" }),
    ).toBeVisible();

    const recipeId = new URL(page.url()).pathname.split("/")[2];
    expect(recipeId).toBeTruthy();
    const privateResponse = await page.request.get(
      `/public/recipes/${recipeId}`,
    );
    expect(privateResponse.status()).toBe(200);
    const privatePreview = await privateResponse.text();
    expect(privatePreview).toContain("This recipe is private");
    expect(privatePreview).not.toContain("Accessible Tomato Soup");

    await expect(page.getByText("No active timers.")).toBeVisible();
    const guided = page.getByRole("button", { name: "Guided" });
    await guided.focus();
    await expect(guided).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Step 1 of 1")).toBeVisible();
    await assertNoAxeViolations(page);
    await assertNoHorizontalOverflow(page);
    await captureVisualCheckpoint(page, "guided-recipe", 390);
    await assertMobileNavigation(page);

    await page.goto("/people");
    await page.getByRole("button", { name: "Enable public mode" }).click();
    await page.goto(`/recipes/${recipeId}`);
    await page.getByRole("button", { name: "Publish recipe" }).click();
    await page.getByRole("link", { name: "View public page" }).click();
    await expect(
      page.getByRole("heading", { name: "Accessible Tomato Soup" }),
    ).toBeVisible();
    await assertNoAxeViolations(page);
    await assertNoHorizontalOverflow(page);
    await captureVisualCheckpoint(page, "public-recipe", 1440);
  });

  test("removes card motion for people who request reduced motion", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    const transitionDuration = await page.evaluate(() => {
      const card = document.createElement("a");
      card.className = "recipe-card";
      document.body.append(card);
      return getComputedStyle(card).transitionDuration;
    });
    expect(Number.parseFloat(transitionDuration)).toBeLessThanOrEqual(0.01);
    expect(
      await page.evaluate(
        () => matchMedia("(prefers-reduced-motion: reduce)").matches,
      ),
    ).toBe(true);
  });
});

async function assertNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
}

async function assertNoHorizontalOverflow(page: Page) {
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ height: 900, width });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  await page.setViewportSize({ height: 900, width: 1440 });
}

async function captureVisualCheckpoint(
  page: Page,
  name: string,
  width: number,
) {
  const directory = process.env.VISUAL_CAPTURE_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.setViewportSize({ height: 900, width });
  await page.screenshot({
    fullPage: true,
    path: join(directory, `${name}-${width}.png`),
  });
}

async function assertBrandPalette(page: Page) {
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(231, 220, 198)",
  );
  await expect(page.locator(".site-header")).toHaveCSS(
    "background-color",
    "rgb(33, 74, 51)",
  );
  await expect(page.getByRole("button", { name: "Search" })).toHaveCSS(
    "background-color",
    "rgb(47, 91, 63)",
  );
}

async function assertMobileNavigation(page: Page) {
  await page.setViewportSize({ height: 900, width: 390 });
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav).toBeVisible();
  const navBox = await nav.boundingBox();
  expect(navBox).not.toBeNull();
  expect(navBox!.y + navBox!.height).toBeGreaterThanOrEqual(895);
  for (const link of await nav.getByRole("link").all()) {
    const box = await link.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  await page.setViewportSize({ height: 900, width: 1440 });
}

async function assertSharedDesktopNavigation(page: Page) {
  await page.setViewportSize({ height: 900, width: 1440 });
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav).toBeVisible();
  const recipes = nav.locator(".nav-dropdown > summary", {
    hasText: /^Recipes$/,
  });
  await recipes.click();
  await expect(nav.getByRole("link", { name: "Add recipe" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Import recipes" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Recycle bin" })).toBeVisible();
  await recipes.click();
  const manage = nav.locator(".nav-dropdown > summary", {
    hasText: /^Manage$/,
  });
  await manage.click();
  await expect(nav.getByRole("link", { name: "People" })).toBeVisible();
  await expect(
    nav.getByRole("link", { name: "Categories & labels" }),
  ).toBeVisible();
  await manage.click();
  const dataMenu = nav.locator(".nav-dropdown > summary", {
    hasText: /^Data$/,
  });
  await dataMenu.click();
  await expect(nav.getByRole("link", { name: "Exports" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Integrations" })).toBeVisible();
  await dataMenu.click();
}

async function assertCompactMobileLibrary(page: Page) {
  await page.setViewportSize({ height: 844, width: 390 });
  await expect(page.locator(".discovery-options")).toHaveCount(0);
  await expect(page.locator(".library-settings")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Filter" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  const state = await page.evaluate(() => {
    const nav = document.querySelector<HTMLElement>(".primary-nav");
    const firstCard = document.querySelector<HTMLElement>(".empty-card");
    return {
      firstCardTop: firstCard?.getBoundingClientRect().top,
      navClientWidth: nav?.clientWidth,
      navScrollWidth: nav?.scrollWidth,
    };
  });
  expect(state.firstCardTop).toBeLessThan(844);
  expect(state.navScrollWidth).toBeLessThanOrEqual(state.navClientWidth!);
  await expect(page.getByText("Online", { exact: true })).toHaveCount(0);
  const more = page.locator(".mobile-nav-more > summary");
  await expect(more).toBeVisible();
  await more.click();
  await expect(page.locator(".mobile-nav-menu")).toBeVisible();
  await expect(
    page.locator(".mobile-nav-menu").getByRole("link", { name: "Account" }),
  ).toBeVisible();
  await more.click();
}

async function assertProgressiveMobileEditor(page: Page) {
  await page.setViewportSize({ height: 844, width: 390 });
  const disclosures = page.locator("details.editor-disclosure");
  await expect(disclosures).toHaveCount(5);
  expect(
    await disclosures.evaluateAll((items) =>
      items.every((item) => !item.hasAttribute("open")),
    ),
  ).toBe(true);
  const mobileSave = page.locator(".mobile-editor-save");
  await expect(mobileSave).toBeVisible();
  await expect(
    mobileSave.getByText("All changes saved", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollHeight),
  ).toBeLessThan(1_500);
  const bottomClearance = await page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    const history = document
      .querySelector('[data-editor-section="history"]')
      ?.getBoundingClientRect();
    const save = document
      .querySelector(".mobile-editor-save")
      ?.getBoundingClientRect();
    return history && save ? save.top - history.bottom : undefined;
  });
  expect(bottomClearance).toBeGreaterThanOrEqual(8);
  await page.evaluate(() => window.scrollTo(0, 0));
}
