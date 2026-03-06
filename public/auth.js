(function () {
  const AUTH_ROOT_SELECTOR = "[data-auth-root]";
  const CLERK_BROWSER_SDK_URL =
    "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@latest/dist/clerk.browser.js";

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function getAuthRoots() {
    return Array.from(document.querySelectorAll(AUTH_ROOT_SELECTOR));
  }

  function renderAll(markup) {
    const roots = getAuthRoots();
    for (const root of roots) {
      root.innerHTML = markup;
    }
  }

  async function loadClerkScript() {
    if (window.Clerk) return;

    await new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src=\"${CLERK_BROWSER_SDK_URL}\"]`);
      if (existing) {
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener("error", () => reject(new Error("Failed to load Clerk SDK")), {
          once: true,
        });
        return;
      }

      const script = document.createElement("script");
      script.src = CLERK_BROWSER_SDK_URL;
      script.async = true;
      script.crossOrigin = "anonymous";
      script.addEventListener("load", () => resolve(), { once: true });
      script.addEventListener("error", () => reject(new Error("Failed to load Clerk SDK")), {
        once: true,
      });
      document.head.appendChild(script);
    });
  }

  async function fetchAuthConfig() {
    const response = await fetch("/api/auth/config", {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`Auth config request failed (${response.status})`);
    }

    return response.json();
  }

  function attachSignedOutHandlers(clerk) {
    const signInButtons = document.querySelectorAll("[data-auth-action='sign-in']");
    for (const button of signInButtons) {
      button.addEventListener("click", () => {
        clerk.openSignIn({
          afterSignInUrl: window.location.href,
          afterSignUpUrl: window.location.href,
        });
      });
    }

    const signUpButtons = document.querySelectorAll("[data-auth-action='sign-up']");
    for (const button of signUpButtons) {
      button.addEventListener("click", () => {
        clerk.openSignUp({
          afterSignInUrl: window.location.href,
          afterSignUpUrl: window.location.href,
        });
      });
    }
  }

  function attachSignedInHandlers(clerk) {
    const signOutButtons = document.querySelectorAll("[data-auth-action='sign-out']");
    for (const button of signOutButtons) {
      button.addEventListener("click", async () => {
        button.setAttribute("disabled", "disabled");
        try {
          await clerk.signOut({ redirectUrl: window.location.href });
        } catch (error) {
          console.error("Failed to sign out", error);
          button.removeAttribute("disabled");
        }
      });
    }
  }

  async function getBackendSession(clerk) {
    try {
      const token = await clerk.session?.getToken?.();
      if (!token) {
        return null;
      }

      const response = await fetch("/api/auth/session", {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        return null;
      }

      return response.json();
    } catch {
      return null;
    }
  }

  async function boot() {
    const roots = getAuthRoots();
    if (!roots.length) {
      return;
    }

    renderAll('<span class="auth-status">Loading auth…</span>');

    let config;
    try {
      config = await fetchAuthConfig();
    } catch (error) {
      console.error("Failed to load auth config", error);
      renderAll("");
      return;
    }

    if (!config?.enabled || !config?.publishableKey) {
      renderAll("");
      return;
    }

    try {
      await loadClerkScript();

      const clerk = new window.Clerk(config.publishableKey);
      await clerk.load();

      const backendSession = await getBackendSession(clerk);

      if (!clerk.isSignedIn) {
        renderAll(`
          <div class="auth-shell-inner">
            <div class="auth-buttons">
              <button type="button" class="auth-link-button" data-auth-action="sign-in">Sign in (GitHub / Google)</button>
              <button type="button" class="auth-link-button auth-link-button-secondary" data-auth-action="sign-up">Create account</button>
            </div>
          </div>
        `);
        attachSignedOutHandlers(clerk);
        return;
      }

      const displayName =
        clerk.user?.fullName ||
        clerk.user?.firstName ||
        clerk.user?.primaryEmailAddress?.emailAddress ||
        backendSession?.email ||
        "Signed in";

      renderAll(`
        <div class="auth-shell-inner auth-shell-inner-signed-in">
          <span class="auth-user-chip">${escapeHtml(displayName)}</span>
          <a href="#" class="auth-secondary-link" aria-disabled="true">My links (soon)</a>
          <button type="button" class="auth-link-button auth-link-button-secondary" data-auth-action="sign-out">Sign out</button>
        </div>
      `);
      attachSignedInHandlers(clerk);
    } catch (error) {
      console.error("Failed to initialize Clerk auth", error);
      renderAll('<span class="auth-status">Auth unavailable</span>');
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    void boot();
  }
})();
