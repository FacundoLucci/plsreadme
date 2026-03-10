(function () {
  const ROOT_SELECTOR = "[data-auth-root]";
  const CLERK_BROWSER_SDK_URL =
    "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@latest/dist/clerk.browser.js";

  if (typeof window.plsreadmeGetAuthToken !== "function") {
    window.plsreadmeGetAuthToken = async () => null;
  }

  function getRoots() {
    return Array.from(document.querySelectorAll(ROOT_SELECTOR));
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function getVariant(root) {
    return root.getAttribute("data-auth-variant") || "default";
  }

  function renderRoots(renderer) {
    for (const root of getRoots()) {
      root.innerHTML = renderer(root);
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

  function trackLoginSuccess(identity, tokenSource) {
    if (typeof window.track !== "function" || !identity) {
      return;
    }

    const dedupeKey = `plsreadme_login_success:${identity}`;

    try {
      if (sessionStorage.getItem(dedupeKey)) {
        return;
      }

      window.track("login_success", {
        token_source: tokenSource || "clerk",
      });
      sessionStorage.setItem(dedupeKey, "1");
    } catch {
      window.track("login_success", {
        token_source: tokenSource || "clerk",
      });
    }
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

  async function ensureClerkScript(publishableKey) {
    if (publishableKey) {
      window.__clerk_publishable_key = publishableKey;
    }

    await new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src=\"${CLERK_BROWSER_SDK_URL}\"]`);
      if (existing) {
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener("error", () => reject(new Error("Failed to load Clerk SDK")), {
          once: true,
        });

        if (window.Clerk) {
          resolve();
        }

        return;
      }

      const script = document.createElement("script");
      script.src = CLERK_BROWSER_SDK_URL;
      script.async = true;
      script.crossOrigin = "anonymous";
      if (publishableKey) {
        script.setAttribute("data-clerk-publishable-key", publishableKey);
      }

      script.addEventListener("load", () => resolve(), { once: true });
      script.addEventListener("error", () => reject(new Error("Failed to load Clerk SDK")), {
        once: true,
      });

      document.head.appendChild(script);
    });
  }

  async function getClerkClient(publishableKey) {
    await ensureClerkScript(publishableKey);

    if (!window.Clerk || typeof window.Clerk.load !== "function") {
      throw new Error("Clerk SDK API not available");
    }

    if (!window.__plsreadmeClerkLoaded) {
      await window.Clerk.load({ publishableKey });
      window.__plsreadmeClerkLoaded = true;
    }

    return window.Clerk;
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

  async function goToSignIn(clerk, config) {
    try {
      await clerk.redirectToSignIn({
        returnBackUrl: window.location.href,
        signInUrl: config?.signInUrl || undefined,
      });
    } catch (error) {
      console.warn("Clerk sign-in redirect failed", error);
      if (config?.signInUrl) {
        window.location.href = config.signInUrl;
      }
    }
  }

  async function goToSignUp(clerk, config) {
    try {
      await clerk.redirectToSignUp({
        returnBackUrl: window.location.href,
        signUpUrl: config?.signUpUrl || undefined,
      });
    } catch (error) {
      console.warn("Clerk sign-up redirect failed", error);
      if (config?.signUpUrl) {
        window.location.href = config.signUpUrl;
      }
    }
  }

  function bindSignedOutActions(clerk, config) {
    for (const button of document.querySelectorAll("[data-auth-action='sign-in']")) {
      button.addEventListener("click", () => {
        void goToSignIn(clerk, config);
      });
    }

    for (const button of document.querySelectorAll("[data-auth-action='sign-up']")) {
      button.addEventListener("click", () => {
        void goToSignUp(clerk, config);
      });
    }

    for (const button of document.querySelectorAll("[data-auth-action='email-fallback']")) {
      button.addEventListener("click", () => {
        void goToSignIn(clerk, config);
      });
    }
  }

  function bindSignedInActions(clerk) {
    for (const button of document.querySelectorAll("[data-auth-action='sign-out']")) {
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

  function renderSignedOut(variant) {
    if (variant === "read-link") {
      return `
        <div class="auth-shell-inner auth-shell-inner-read-link">
          <button type="button" class="auth-link-button" data-auth-action="sign-in">Sign in</button>
        </div>
      `;
    }

    return `
      <div class="auth-shell-inner">
        <div class="auth-buttons">
          <button type="button" class="auth-link-button" data-auth-action="sign-in">Sign in</button>
          <button type="button" class="auth-link-button auth-link-button-secondary" data-auth-action="sign-up">Create account</button>
          <button type="button" class="auth-link-button auth-link-button-secondary" data-auth-action="email-fallback">Use email instead</button>
        </div>
      </div>
    `;
  }

  function renderSignedIn(variant, displayName, avatarUrl, email) {
    const fallbackInitial = (displayName || "U").trim().charAt(0).toUpperCase() || "U";
    const safeAvatar = avatarUrl ? escapeHtml(avatarUrl) : "";
    const avatarMarkup = safeAvatar
      ? `<img src="${safeAvatar}" alt="" class="auth-avatar-img" loading="lazy" referrerpolicy="no-referrer" />`
      : `<span class="auth-avatar-fallback">${escapeHtml(fallbackInitial)}</span>`;

    if (variant === "read-link") {
      return `
        <div class="auth-shell-inner auth-shell-inner-signed-in auth-shell-inner-read-link-signed-in">
          <span class="auth-avatar" aria-hidden="true">${avatarMarkup}</span>
          <span class="auth-user-chip" title="${escapeHtml(email || displayName)}">${escapeHtml(displayName)}</span>
          <a href="/my-links" class="auth-secondary-link">My links</a>
          <button type="button" class="auth-link-button auth-link-button-secondary" data-auth-action="sign-out">Sign out</button>
        </div>
      `;
    }

    return `
      <div class="auth-shell-inner auth-shell-inner-signed-in">
        <span class="auth-avatar" aria-hidden="true">${avatarMarkup}</span>
        <span class="auth-user-chip">${escapeHtml(displayName)}</span>
        <a href="/my-links" class="auth-secondary-link">My links</a>
        <button type="button" class="auth-link-button auth-link-button-secondary" data-auth-action="sign-out">Sign out</button>
      </div>
    `;
  }

  async function boot() {
    if (!getRoots().length) {
      return;
    }

    renderRoots(() => '<span class="auth-status">Loading auth…</span>');
    publishAuthState({ authenticated: false, reason: "loading" });
    setTokenGetter(async () => null);

    let config;

    try {
      config = await fetchAuthConfig();
    } catch (error) {
      console.error("Failed to load auth config", error);
      renderRoots(() => "");
      publishAuthState({ authenticated: false, reason: "config_failed" });
      return;
    }

    if (!config?.enabled || !config?.publishableKey) {
      renderRoots(() => "");
      publishAuthState({ authenticated: false, reason: "disabled" });
      return;
    }

    try {
      const clerk = await getClerkClient(config.publishableKey);
      const backendSession = await getBackendSession(clerk);

      if (!clerk.isSignedIn) {
        renderRoots((root) => renderSignedOut(getVariant(root)));

        publishAuthState({
          authenticated: false,
          reason: "signed_out",
          clerkReady: true,
        });
        setTokenGetter(async () => null);

        bindSignedOutActions(clerk, config);
        return;
      }

      const displayName =
        clerk.user?.fullName ||
        clerk.user?.firstName ||
        clerk.user?.primaryEmailAddress?.emailAddress ||
        backendSession?.email ||
        "Signed in";
      const avatarUrl = clerk.user?.imageUrl || "";
      const email = backendSession?.email || clerk.user?.primaryEmailAddress?.emailAddress || "";

      renderRoots((root) => renderSignedIn(getVariant(root), displayName, avatarUrl, email));

      publishAuthState({
        authenticated: true,
        userId: backendSession?.userId || clerk.user?.id || null,
        sessionId: backendSession?.sessionId || clerk.session?.id || null,
        email: email || null,
        displayName,
        tokenSource: backendSession?.tokenSource || "clerk",
      });

      setTokenGetter(async () => {
        try {
          return (await clerk.session?.getToken?.()) || null;
        } catch {
          return null;
        }
      });

      const identity = backendSession?.sessionId || backendSession?.userId || clerk.session?.id || clerk.user?.id;
      trackLoginSuccess(identity, backendSession?.tokenSource || "clerk");
      bindSignedInActions(clerk);
    } catch (error) {
      console.error("Failed to initialize Clerk auth shell", error);
      renderRoots(() => '<span class="auth-status">Auth unavailable</span>');
      publishAuthState({ authenticated: false, reason: "init_failed" });
      setTokenGetter(async () => null);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        void boot();
      },
      { once: true }
    );
  } else {
    void boot();
  }
})();
