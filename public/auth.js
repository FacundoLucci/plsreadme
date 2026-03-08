(function () {
  if (typeof window.plsreadmeGetAuthToken !== "function") {
    window.plsreadmeGetAuthToken = async () => null;
  }

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

  function setTokenGetter(fn) {
    try {
      window.plsreadmeGetAuthToken = fn;
    } catch {
      window.plsreadmeGetAuthToken = async () => null;
    }
  }

  function publishAuthState(state) {
    window.plsreadmeAuthState = state;
    window.dispatchEvent(
      new CustomEvent("plsreadme:auth-state", {
        detail: state,
      })
    );
  }

  function trackLoginSuccess(backendSession, clerk) {
    if (typeof window.track !== "function") return;

    const identity =
      backendSession?.sessionId ||
      backendSession?.userId ||
      clerk?.session?.id ||
      clerk?.user?.id;

    if (!identity) return;

    const dedupeKey = `plsreadme_login_success:${identity}`;

    try {
      if (sessionStorage.getItem(dedupeKey)) {
        return;
      }

      window.track("login_success", {
        token_source: backendSession?.tokenSource || "clerk",
      });

      sessionStorage.setItem(dedupeKey, "1");
    } catch {
      window.track("login_success", {
        token_source: backendSession?.tokenSource || "clerk",
      });
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

  async function redirectToHostedSignIn(clerk, config) {
    try {
      await clerk.redirectToSignIn({
        returnBackUrl: window.location.href,
        signInUrl: config?.signInUrl || undefined,
      });
    } catch (error) {
      console.warn("Hosted sign-in redirect failed, falling back to modal", error);
      clerk.openSignIn({
        afterSignInUrl: window.location.href,
        afterSignUpUrl: window.location.href,
      });
    }
  }

  async function redirectToHostedSignUp(clerk, config) {
    try {
      await clerk.redirectToSignUp({
        returnBackUrl: window.location.href,
        signUpUrl: config?.signUpUrl || undefined,
      });
    } catch (error) {
      console.warn("Hosted sign-up redirect failed, falling back to modal", error);
      clerk.openSignUp({
        afterSignInUrl: window.location.href,
        afterSignUpUrl: window.location.href,
      });
    }
  }

  function attachSignedOutHandlers(clerk, config) {
    const signInButtons = document.querySelectorAll("[data-auth-action='sign-in']");
    for (const button of signInButtons) {
      button.addEventListener("click", () => {
        void redirectToHostedSignIn(clerk, config);
      });
    }

    const signUpButtons = document.querySelectorAll("[data-auth-action='sign-up']");
    for (const button of signUpButtons) {
      button.addEventListener("click", () => {
        void redirectToHostedSignUp(clerk, config);
      });
    }

    const emailFallbackButtons = document.querySelectorAll("[data-auth-action='email-fallback']");
    for (const button of emailFallbackButtons) {
      button.addEventListener("click", () => {
        void redirectToHostedSignIn(clerk, config);
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
    publishAuthState({ authenticated: false, reason: "loading" });
    setTokenGetter(async () => null);

    let config;
    try {
      config = await fetchAuthConfig();
    } catch (error) {
      console.error("Failed to load auth config", error);
      renderAll("");
      publishAuthState({ authenticated: false, reason: "config_failed" });
      setTokenGetter(async () => null);
      return;
    }

    if (!config?.enabled || !config?.publishableKey) {
      renderAll("");
      publishAuthState({ authenticated: false, reason: "disabled" });
      setTokenGetter(async () => null);
      return;
    }

    try {
      await loadClerkScript();

      let clerk;
      // Support both Clerk v5 (constructor) and Clerk v6 (global singleton load)
      if (typeof window.Clerk === "function") {
        clerk = new window.Clerk(config.publishableKey);
        await clerk.load();
      } else if (window.Clerk && typeof window.Clerk.load === "function") {
        await window.Clerk.load({ publishableKey: config.publishableKey });
        clerk = window.Clerk;
      } else {
        throw new Error("Clerk SDK API not available");
      }

      const backendSession = await getBackendSession(clerk);

      if (!clerk.isSignedIn) {
        renderAll(`
          <div class="auth-shell-inner">
            <div class="auth-buttons">
              <button type="button" class="auth-link-button" data-auth-action="sign-in">Sign in</button>
              <button type="button" class="auth-link-button auth-link-button-secondary" data-auth-action="sign-up">Create account</button>
              <button type="button" class="auth-link-button auth-link-button-secondary" data-auth-action="email-fallback">Use email instead</button>
            </div>
          </div>
        `);

        publishAuthState({
          authenticated: false,
          reason: "signed_out",
          clerkReady: true,
        });
        setTokenGetter(async () => null);

        attachSignedOutHandlers(clerk, config);
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
          <a href="/my-links" class="auth-secondary-link">My links</a>
          <button type="button" class="auth-link-button auth-link-button-secondary" data-auth-action="sign-out">Sign out</button>
        </div>
      `);

      publishAuthState({
        authenticated: true,
        userId: backendSession?.userId || clerk.user?.id || null,
        sessionId: backendSession?.sessionId || clerk.session?.id || null,
        email:
          backendSession?.email ||
          clerk.user?.primaryEmailAddress?.emailAddress ||
          null,
        tokenSource: backendSession?.tokenSource || null,
      });

      setTokenGetter(async () => {
        try {
          return (await clerk.session?.getToken?.()) || null;
        } catch {
          return null;
        }
      });

      trackLoginSuccess(backendSession, clerk);
      attachSignedInHandlers(clerk);
    } catch (error) {
      console.error("Failed to initialize Clerk auth", error);
      renderAll('<span class="auth-status">Auth unavailable</span>');
      publishAuthState({ authenticated: false, reason: "init_failed" });
      setTokenGetter(async () => null);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    void boot();
  }
})();
