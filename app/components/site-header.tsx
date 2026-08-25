import { Link, useLocation } from "react-router";

type NavigationRole = "editor" | "owner" | "viewer";

export function SiteHeader({ role }: { role: NavigationRole | null }) {
  const location = useLocation();
  const pathname = location.pathname;

  if (!role) {
    if (
      pathname !== "/" &&
      !pathname.startsWith("/public/recipes/") &&
      !pathname.startsWith("/public/collections/")
    ) {
      return null;
    }
    return (
      <header className="site-header">
        <Link
          aria-current={pathname === "/" ? "page" : undefined}
          className="brand"
          to="/"
        >
          Found &amp; Made
        </Link>
        <nav className="site-nav" aria-label="Public cookbook">
          {pathname === "/" ? <span>Runs on Found &amp; Made</span> : null}
          <Link to="/sign-in">Sign in</Link>
        </nav>
      </header>
    );
  }

  const canEdit = role !== "viewer";
  const isOwner = role === "owner";
  const libraryCurrent =
    pathname === "/" ||
    (pathname.startsWith("/recipes/") &&
      pathname !== "/recipes/new" &&
      pathname !== "/recipes/trash");
  const recipesCurrent =
    pathname === "/recipes/new" ||
    pathname === "/recipes/trash" ||
    pathname.startsWith("/imports");
  const manageCurrent = ["/people", "/taxonomy"].some((path) =>
    pathname.startsWith(path),
  );
  const dataCurrent = ["/exports", "/integrations"].some((path) =>
    pathname.startsWith(path),
  );

  return (
    <header className="site-header authenticated-site-header">
      <Link className="brand" to="/">
        Found &amp; Made
      </Link>
      <nav aria-label="Primary" className="site-nav primary-nav" key={pathname}>
        <span className="desktop-primary-nav">
          <NavigationLink current={libraryCurrent} to="/">
            Library
          </NavigationLink>
          {canEdit ? (
            <NavigationMenu current={recipesCurrent} label="Recipes">
              {canEdit ? (
                <NavigationLink to="/recipes/new">Add recipe</NavigationLink>
              ) : null}
              {canEdit ? (
                <NavigationLink to="/imports">Import recipes</NavigationLink>
              ) : null}
              {isOwner ? (
                <NavigationLink to="/recipes/trash">Recycle bin</NavigationLink>
              ) : null}
            </NavigationMenu>
          ) : null}
          <NavigationLink
            current={pathname.startsWith("/cookbooks")}
            to="/cookbooks"
          >
            Cookbooks
          </NavigationLink>
          {isOwner ? (
            <NavigationMenu current={manageCurrent} label="Manage">
              <NavigationLink to="/people">People</NavigationLink>
              <NavigationLink to="/taxonomy">
                Categories &amp; labels
              </NavigationLink>
            </NavigationMenu>
          ) : null}
          <NavigationMenu current={dataCurrent} label="Data">
            <NavigationLink to="/exports">Exports</NavigationLink>
            {isOwner ? (
              <NavigationLink to="/integrations">Integrations</NavigationLink>
            ) : null}
          </NavigationMenu>
          <NavigationLink
            current={pathname.startsWith("/account")}
            to="/account"
          >
            Account
          </NavigationLink>
        </span>

        <span className="mobile-primary-nav">
          <NavigationLink current={libraryCurrent} to="/">
            Library
          </NavigationLink>
          {canEdit ? (
            <NavigationLink
              current={pathname === "/recipes/new"}
              to="/recipes/new"
            >
              Add
            </NavigationLink>
          ) : null}
          {canEdit ? (
            <NavigationLink
              current={pathname.startsWith("/imports")}
              to="/imports"
            >
              Import
            </NavigationLink>
          ) : null}
          <NavigationLink
            current={pathname.startsWith("/cookbooks")}
            to="/cookbooks"
          >
            Cookbooks
          </NavigationLink>
          <details
            className="mobile-nav-more"
            data-current={
              pathname === "/recipes/trash" ||
              manageCurrent ||
              dataCurrent ||
              pathname.startsWith("/account") ||
              undefined
            }
          >
            <summary>More</summary>
            <div className="mobile-nav-menu">
              {isOwner ? <MenuHeading>Recipes</MenuHeading> : null}
              {isOwner ? (
                <NavigationLink to="/recipes/trash">Recycle bin</NavigationLink>
              ) : null}
              {isOwner ? <MenuHeading>Manage</MenuHeading> : null}
              {isOwner ? (
                <NavigationLink to="/people">People</NavigationLink>
              ) : null}
              {isOwner ? (
                <NavigationLink to="/taxonomy">
                  Categories &amp; labels
                </NavigationLink>
              ) : null}
              <MenuHeading>Data</MenuHeading>
              <NavigationLink to="/exports">Exports</NavigationLink>
              {isOwner ? (
                <NavigationLink to="/integrations">Integrations</NavigationLink>
              ) : null}
              <MenuHeading>Account</MenuHeading>
              <NavigationLink to="/account">Account settings</NavigationLink>
            </div>
          </details>
        </span>
      </nav>
    </header>
  );
}

function NavigationMenu({
  children,
  current = false,
  label,
}: {
  children: React.ReactNode;
  current?: boolean;
  label: string;
}) {
  return (
    <details className="nav-dropdown" data-current={current || undefined}>
      <summary>{label}</summary>
      <div className="nav-dropdown-menu">{children}</div>
    </details>
  );
}

function NavigationLink({
  children,
  current = false,
  to,
}: {
  children: React.ReactNode;
  current?: boolean;
  to: string;
}) {
  return (
    <Link aria-current={current ? "page" : undefined} to={to}>
      {children}
    </Link>
  );
}

function MenuHeading({ children }: { children: React.ReactNode }) {
  return <p className="mobile-nav-heading">{children}</p>;
}
