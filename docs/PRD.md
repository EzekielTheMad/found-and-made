# Found & Made Product Requirements Document

## Summary

**Found & Made**, tagline **“Recipes from anywhere, made yours,”** is a self-hosted recipe platform distributed as a Docker container and installable PWA. It gathers recipes scattered across websites, social media, video, photos, PDFs, pasted text, and existing recipe managers, then turns them into a durable personal cooking library.

One canonical recipe can be presented as a searchable library entry, scaled cooking guide, ingredient-flow merge table, public read-only page, printable sheet, modular physical cookbook, or agent-readable resource. The experience prioritizes active cooking while preserving source attribution, original wording, private household data, and user control over every import.

Found & Made improves on platforms such as [Mealie](https://docs.mealie.io/documentation/getting-started/features/), [Tandoor](https://docs.tandoor.dev/), and [KitchenOwl](https://docs.kitchenowl.org/v0.6.3/). Its primary differentiators are merge-table visualization, modular cookbook printing, privacy-safe public publishing, lossless ingredient normalization, and optional read-only Hermes access.

## Recipe Experience and Scaling

- Generate traditional, guided cook, and ingredient-flow merge-table views from one canonical recipe.
- Support components and sub-recipes for sauces, fillings, doughs, toppings, and reusable preparations.
- Require a numeric base yield for scalable recipes while preserving descriptive yield text.
- Open every recipe at its authored serving count by default.
- Let users change servings through an accessible numeric input, plus/minus controls, or an adaptive slider.
- Scale quantities using `target servings ÷ base servings`, including both endpoints of quantity ranges.
- Update amounts consistently in ingredients, linked cooking steps, guided mode, merge tables, print layouts, exports, and Hermes responses.
- Preserve base quantities; temporary serving changes never overwrite the recipe unless explicitly saved as a variant.
- Format results as readable fractions or decimals according to user preference.
- Do not silently scale temperatures, pan dimensions, appliance settings, package counts, or cooking/resting times. Display author-provided scaling guidance and flag impractical values such as fractional eggs or partial packages.
- Keep unit conversion independent from serving scaling so either can be applied without altering stored source values.
- Permit a serving target per recipe inside bulk print jobs.

## Recipe Quality Features

Include these in v1:

- Required, optional, and alternative ingredients.
- Ingredient substitutions with notes about flavor, dietary, or technique effects.
- Private per-user notes that never appear publicly.
- “Made this” cooking history, personal rating, and recorded adjustments.
- Favorites and recently viewed/cooked recipes.
- Independently editable variants linked to an originating recipe, without complex branch merging.
- Allergen and dietary metadata with clear warnings that imported or inferred classifications require human confirmation and are not medical guarantees.
- Revision history, concurrent-edit detection, soft deletion, and a recoverable recycle bin.
- Let Editors bulk add or remove Categories and Labels from the current library results. Let Owners version-check and move up to 500 selected recipes to the recycle bin in one recoverable action.
- Duplicate detection based on canonical source URL and recipe fingerprints.

## Photos, Sharing, and Public Pages

- Support a hero photo, recipe gallery, and optional component/step photos.
- Preserve print-resolution originals while generating web derivatives.
- Include captions, alt text, reordering, crop/focal-point controls, and EXIF removal.
- Default every new installation and imported recipe to private visibility.
- Allow an Owner to enable public cookbook mode and explicitly publish individual recipes or collections.
- Give published recipes stable canonical URLs and copy/share controls.
- Server-render public pages with Schema.org Recipe JSON-LD, Open Graph metadata, and social-card metadata.
- Use the hero photo in link previews or generate a branded fallback image.
- Verify useful unfurls in Discord and other compatible services.
- For unpublished recipes, return a privacy-safe preview containing only the instance identity and a sign-in message; never include the recipe title, photo, yield, time, or other recipe metadata.
- Never expose private cookbook, draft, or review-queue content through metadata or crawler responses.
- Import a public Found & Made URL like any other recipe webpage, producing an independent copy without federation or synchronization.

## Authentication and Collaboration

- Always offer email/password authentication and optionally enable Google OpenID Connect through environment configuration.
- Request only `openid`, `email`, and `profile`; use Google’s stable `sub` identifier and require verified email.
- Use a first-run setup wizard to create the initial Owner with a local email/password recovery method; Google sign-in may then be linked.
- Require single-use, expiring invitations for later accounts.
- Never automatically merge local and Google accounts by email. When a signed-in user explicitly connects Google, require the provider email to match before attaching it to the existing account; prevent users from removing their final usable sign-in method.
- Preserve local Owner login as a recovery path.
- Define these canonical roles:
  - **Owner:** manage the instance, people, integrations, visibility, publishing, deletion, and all recipe content.
  - **Editor:** edit recipe content and shared recipe notes, but cannot publish publicly, delete recipes, or manage permissions.
  - **Viewer:** read accessible recipes and manage only their own favorites, cooking history, ratings, and private notes.
- Allow anonymous visitors to read only explicitly published recipes and collections when public cookbook mode is enabled.
- Make public publishing Owner-only; Editors may prepare content for Owner review.
- Let local-account users change their password from account settings and revoke other sessions. Keep SMTP optional. When it is configured, support email password resets; otherwise provide a documented server-side command that creates a single-use, expiring Owner recovery link.

## Taxonomy, Search, and Home

- Present one controlled Category vocabulary for broad recipe types such as Breakfast, Lunch, Dinner, Dessert, Cocktail, and Seasonal. Preserve aliases so imports normalize common variants without creating duplicate categories.
- Let users add freeform Labels for household-specific organization and retain manual collections for curated sets.
- Support bulk additive/removal of Categories and Labels without overwriting unrelated classifications already present on mixed recipe selections.
- Build saved views from include/exclude filters, search terms, sorting, and result layout.
- Supply starter views such as Weeknight Dinner, Breakfast, Lunch, Dessert, Holiday & Seasonal, Quick Recipes, and Recently Added.
- Make the authenticated home navigation-first with search, pinned views, Owner-configured discovery sections, recent/favorite recipes, and relevant seasonal content.
- Let Owners define the initial home and each user choose a personal saved view as their default.
- Allow exclusion rules so large holiday collections do not overwhelm ordinary meal discovery.
- Configure the public cookbook landing page independently.

## PWA and Offline Behavior

- Cache favorites, recently viewed recipes, and any recipe opened in cooking mode, including required photos.
- Cache the library index needed for offline search and clearly distinguish cached from unavailable recipes.
- Keep ingredient check-offs, guided-step progress, active timers, serving scale, and private personal notes functional offline and synchronize them after reconnection.
- Require a network connection for imports, publishing, account administration, and collaborative recipe editing.
- Do not queue full recipe-content edits offline in v1; advanced offline collaboration remains a later-phase capability.
- Surface connection and synchronization state without interrupting an active cooking session.

## Import and Ingredient Normalization

- Support manual entry, pasted text, recipe websites, bulk export migrations from Mealie, Tandoor Recipes, Nextcloud Cookbook, and Schema.org/JSON-LD-compatible managers, photos/screenshots, PDFs, audio/video uploads, and TikTok/Instagram/YouTube-style URLs.
- Keep the import form source-aware so it shows only the fields applicable to the selected source. Expand each migration export into bounded, durable private recipe jobs that save automatically using the best structured result.
- Process imports as durable jobs: acquire permitted content, extract text, structure fields, normalize ingredients, map ingredients to steps, identify dependencies, detect duplicates, retain confidence warnings, and save privately. Users edit only recipes that need correction later.
- Use official/public metadata and embeds first. Never scrape authenticated sessions or user cookies. Offer caption paste or user-supplied media when extraction is blocked.
- Discover website recipe photos from official metadata or social metadata, acquire them through the same public-only SSRF controls, and sanitize them through the shared media pipeline before attaching them as private hero images.
- Skip exact active source-URL or recipe-fingerprint duplicates without creating another recipe. Recycled recipes remain eligible for clean reimport.
- Show saved, processing, failed, and exact-duplicate-skipped counts for migration batches, with one action to retry every failed job in the current batch.
- Infer no more than three Categories per import from a small managed vocabulary: Breakfast, Lunch, Dinner, Appetizer, Side Dish, Dessert, Snack, Soup, Salad, Cocktails, Drinks, and Seasonal. Never copy arbitrary source tags into Categories or Labels.
- Support bring-your-own hosted or local OpenAI-compatible AI providers, configured through environment variables.
- Display and index a generic canonical ingredient rather than branded marketing language.
- Preserve exact source wording privately in provenance.
- Flag cases where removing a brand may change ingredient identity or cooking behavior, preserve the original wording, and keep the best normalized guess editable.
- Allow Editors to retain meaningful product characteristics without retaining unnecessary brand names.

## Print and Physical Cookbooks

- Print one recipe or bulk-select recipes from searches, Categories, collections, Labels, or saved views.
- Include classic single-column, two-column, step-linked, landscape merge-table, and compact card layouts.
- Support reusable print profiles controlling page size, margins, typography, photos, metadata, and recipe layout.
- Allow a global bulk layout with per-recipe overrides and serving targets.
- Generate print-ready PDFs with preview, dependable page breaks, and high-resolution images.
- Default to a living-cookbook workflow:
  - Each recipe starts on a new sheet or card.
  - Profiles remain reusable for later additions.
  - Page numbers and fixed page-reference contents are disabled by default.
  - Newly added recipes can be printed separately using the existing style.
  - Covers and category dividers do not depend on numbering.
- Allow optional numbering for fixed-edition exports without making it the default.
- Save bulk selections as reusable print collections.

## Hermes Interaction Layer

- Include an optional, authenticated, read-only MCP server in v1, implemented as a thin adapter over the same recipe service layer used by the application and REST API.
- Use the stable MCP Streamable HTTP version supported by Hermes at implementation time; revalidate compatibility because the protocol is actively evolving. Follow the official [transport security requirements](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
- Provide narrowly typed tools:
  - `search_recipes` with Category, ingredient, time, and equipment filters.
  - `get_recipe`.
  - `get_scaled_recipe` with target servings and unit preference.
  - `list_collections`.
  - `list_saved_views`.
  - `find_recipes` using available ingredients or recipe requirements.
- Return only approved recipes; exclude drafts, import jobs, private user notes, credentials, raw database access, and filesystem paths.
- Issue a separate `recipes:read` service token for Hermes, store only its hash, and support expiry, revocation, rate limiting, and audit records.
- Require bearer authentication, Origin validation, optional LAN/CIDR restrictions, and deployment guidance preventing accidental public proxy exposure.
- Do not expose create, edit, publish, delete, invitation, configuration, or import tools in v1.
- Validate the integration through initialization, tool discovery, authenticated rejection tests, and representative search/get/scaled-recipe calls.
- Consider confirmation-gated recipe drafting only in a later phase.

## Equipment Support

- Store normalized required and optional equipment on recipes in v1.
- Add per-user equipment profiles in Phase 3 for smokers, grills, griddles, pressure cookers, mixers, and similar appliances.
- Use those profiles later for accessibility filtering and “can make / missing equipment” indicators.
- Avoid treating optional or substitutable equipment as a hard blocker.

## Platform and Security Requirements

- Implement the application as an AGPL-3.0-licensed TypeScript modular monolith with a React-based full-stack UI, shared application service layer, and embedded durable-job worker.
- Use one multi-arch container with SQLite, uploads, media, keys, and persistent state under `/data`.
- Keep the browser UI, application API, import worker, print renderer, and MCP adapter behind the same domain model and service boundaries rather than duplicating recipe logic.
- Run automatic migrations and first-boot secret generation, support PUID/PGID, and provide database-backed health checks.
- Back up and restore the application by copying `/data`.
- Publish machine-readable recipe exports and complete library/media exports.
- Include OAuth validation, secure cookies, CSRF protection, URL-import SSRF defenses, redirect revalidation, upload magic-byte and size validation, sanitized embeds, security headers, rate limits, generic client errors, and Owner-only audited publication.

## Roadmap

- **V1:** dual authentication, collaborators, recipe photos, multimodal imports, serving scaling, quality features, Categories, Labels, and saved views, configurable home pages, three recipe views, offline PWA cooking, link previews, individual/bulk printing, read-only Hermes MCP, Docker deployment, and bulk migration from common self-hosted recipe managers.
- **Phase 2:** meal planning, consolidated shopping lists, supermarket ordering, notifications, and shared household preferences.
- **Phase 3:** equipment inventories and recipe matching, pantry/freezer tracking, nutrition, recommendations, generic OIDC, additional integrations, voice-guided cooking, and advanced offline collaboration.
- Exclude from v1: native clients, automatic federation, comments/social feeds, Google service-data access, required cloud accounts, and autonomous AI publishing.

## Acceptance Scenarios

- Open a four-serving recipe and confirm all views use its original quantities.
- Scale it through input, controls, and slider to six, eight, and twelve servings; verify ingredients, ranges, steps, printing, exports, and Hermes agree.
- Verify temperatures and cooking times remain unchanged and fractional eggs/packages receive guidance rather than silent rounding.
- Save a scaled recipe as a variant without modifying the original.
- Exercise optional ingredients, substitutions, personal notes, cooking history, ratings, allergen review, favorites, revisions, conflicts, trash, and restore.
- Upload hero and step photos and verify optimized web display, social previews, print quality, alt text, and EXIF removal.
- Share a public recipe in Discord and confirm the preview; verify private content never unfurls.
- Build a Weeknight Dinner home view that excludes irrelevant holiday recipes.
- Generate individual and modular bulk cookbook PDFs in every supported layout.
- Connect Hermes using a scoped token, discover tools, search recipes, and retrieve a correctly scaled recipe. Confirm anonymous, expired-token, forbidden-origin, and mutation attempts fail.
- Complete fresh local-auth and Google-auth installations, then restore users, recipes, media, views, tokens, and print profiles from `/data`.
- Validate representative website, migration, scan, PDF, caption, and video imports, including blocked-source fallbacks, best-guess branded ingredients, and native Mealie hero images.
- Exercise permissions, offline cooking, SSRF protection, malicious uploads, OAuth failures, rate limits, health-check failure, and anonymous image pulls.

## Assumptions and Defaults

- Use **Found & Made**, tagline **“Recipes from anywhere, made yours,”** pending domain and formal trademark clearance.
- License the project under AGPL-3.0.
- Use a TypeScript modular monolith, SQLite, one container, and one `/data` volume.
- Use Owner, Editor, and Viewer as the canonical authorization roles.
- Default new installations to private visibility.
- Default imported and manually created recipes to private until an Owner explicitly publishes them.
- Keep SMTP optional and preserve server-side single-use recovery.
- Do not support full offline recipe editing in v1.
- Default recipes to their authored yield on every new open.
- Default physical cookbook output to modular and unnumbered.
- Hermes access is optional, separately authenticated, and read-only.
- The Hermes architecture recommendation is based on documented July 2026 configuration and may be stale; revalidate the live MCP transport and network configuration before implementation.
