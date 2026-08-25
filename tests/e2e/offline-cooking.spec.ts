import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

interface WebAppManifest {
  display: string;
  icons: Array<{ purpose?: string }>;
  name: string;
  start_url: string;
}

test("cooking state survives reload, offline use, reconnect, and logout purge", async ({
  context,
  page,
}) => {
  await page.addInitScript(() => {
    Reflect.set(window, "__wakeLockRequests", 0);
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: {
        request: (type: string) => {
          if (type === "screen") {
            Reflect.set(
              window,
              "__wakeLockRequests",
              Number(Reflect.get(window, "__wakeLockRequests")) + 1,
            );
          }
          return Promise.resolve({ release: () => Promise.resolve() });
        },
      },
    });
  });
  await page.goto("/");
  await page.getByLabel("Name").fill("Offline Owner");
  await page.getByLabel("Email").fill("offline-owner@example.com");
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Create Owner" }).click();
  await expect(
    page.getByRole("heading", { exact: true, name: "Your recipes" }),
  ).toBeVisible();
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/manifest.webmanifest",
  );
  const manifestText = await page.evaluate(async () =>
    fetch("/manifest.webmanifest").then((response) => response.text()),
  );
  const manifest = JSON.parse(manifestText) as WebAppManifest;
  expect(manifest).toMatchObject({
    display: "standalone",
    name: "Found & Made",
    start_url: "/",
  });
  expect(manifest.icons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ purpose: expect.stringContaining("maskable") }),
    ]),
  );

  await page.getByRole("link", { name: "Add a recipe" }).first().click();
  await page.getByLabel("Recipe title").fill("Offline Tomato Soup");
  await page.getByLabel("Base servings").fill("4");
  await page.getByLabel("Descriptive yield").fill("Serves 4");
  await page.getByRole("button", { name: "Create private draft" }).click();
  await page
    .locator(".ingredient-editor-row")
    .getByLabel("Name", { exact: true })
    .fill("tomatoes");
  await page.getByLabel("Instruction").fill("Simmer the tomatoes.");
  await page.getByRole("button", { name: "+ Add step" }).click();
  await page
    .getByLabel("Instruction")
    .nth(1)
    .fill("Blend until completely smooth.");
  await page.getByRole("button", { name: "Save recipe" }).click();
  await expect(
    page.getByRole("heading", { name: "Offline Tomato Soup" }),
  ).toBeVisible();

  const recipeId = new URL(page.url()).pathname.split("/")[2];
  expect(recipeId).toBeTruthy();
  await page.waitForFunction(
    async (path) => {
      for (const name of await caches.keys()) {
        if (!name.startsWith("found-made-protected-")) continue;
        if (await (await caches.open(name)).match(path)) return true;
      }
      return false;
    },
    `/api/offline/recipes/${recipeId}`,
    { timeout: 10_000 },
  );

  await page.getByRole("button", { name: "☆ Favorite" }).click();
  await expect(page.getByRole("button", { name: "★ Favorited" })).toBeVisible();

  await page.getByLabel("Personal note").fill("Add basil after blending.");
  await syncAfter(page, () =>
    page.getByRole("button", { name: "Save note for offline sync" }).click(),
  );
  await syncAfter(page, () =>
    page.locator(".ingredient-row").filter({ hasText: "tomatoes" }).click(),
  );
  await page.getByLabel("Target servings").fill("6");
  await syncAfter(page, () => page.getByLabel("Target servings").blur());
  await page.getByRole("button", { name: "Guided" }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Number(Reflect.get(window, "__wakeLockRequests") ?? 0),
      ),
    )
    .toBeGreaterThan(0);
  await syncAfter(page, () =>
    page.getByRole("button", { name: "Next step" }).click(),
  );
  await expect(page.getByText("Step 2 of 2")).toBeVisible();
  await page.getByLabel("Minutes").fill("0.1");
  await syncAfter(page, () =>
    page.getByRole("button", { name: "Start timer" }).click(),
  );

  await page.reload();
  await expect(page.getByLabel("Target servings")).toHaveValue("6");
  await expect(
    page.locator(".ingredient-row").filter({ hasText: "tomatoes" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Personal note")).toHaveValue(
    "Add basil after blending.",
  );
  await page.getByRole("button", { name: "Guided" }).click();
  await expect(page.getByText("Step 2 of 2")).toBeVisible();
  await expect(page.getByText("Cooking timer")).toBeVisible();

  await page.waitForFunction(async (path) => {
    for (const name of await caches.keys()) {
      if (!name.startsWith("found-made-protected-")) continue;
      if (await (await caches.open(name)).match(path)) return true;
    }
    return false;
  }, `/api/offline/recipes/${recipeId}`);
  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Offline Tomato Soup" }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("status")).toContainText("Offline copy");
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Saved recipes" }),
  ).toBeVisible();
  await page.getByLabel("Search saved recipes").fill("tomato");
  await expect(
    page.getByRole("link", { name: "Offline Tomato Soup" }),
  ).toBeVisible();
  await page.goto("/recipes/not-cached-12345678");
  await expect(
    page.getByRole("heading", { name: "This is not available offline" }),
  ).toBeVisible();
  await expect(page.getByText("not saved on this device")).toBeVisible();
  await page.goto(`/recipes/${recipeId}`);
  await expect(
    page.getByRole("heading", { name: "Offline Tomato Soup" }),
  ).toBeVisible();
  await page.getByLabel("Target yield").fill("8");
  await page.getByRole("button", { name: "Apply" }).click();
  await page.getByRole("textbox").fill("Use smoked salt.");
  await page.getByRole("button", { name: "Save note offline" }).click();

  await context.setOffline(false);
  const syncResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/offline/operations") &&
      response.ok(),
    { timeout: 10_000 },
  );
  await page.reload();
  await syncResponse;
  await page.reload();
  await expect(page.getByLabel("Target servings")).toHaveValue("8");
  await expect(page.getByLabel("Personal note")).toHaveValue(
    "Use smoked salt.",
  );
  await assertNoAxeViolations(page);

  await page.goto("/account");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await caches.keys()).filter((name) =>
          name.startsWith("found-made-protected-"),
        ),
      ),
    )
    .toEqual([]);
});

async function syncAfter(page: Page, action: () => Promise<unknown>) {
  const response = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "POST" &&
      candidate.url().endsWith("/api/offline/operations") &&
      candidate.ok(),
    { timeout: 10_000 },
  );
  await action();
  await response;
}

async function assertNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
}
