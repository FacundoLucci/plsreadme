(function () {
  const PAGE_SELECTOR = "[data-clerk-auth-page]";
  const MOUNT_SELECTOR = "[data-clerk-component-root]";
  const STATUS_SELECTOR = "[data-auth-page-status]";
  const DEFAULT_CLERK_BROWSER_SDK_URL =
    "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@latest/dist/clerk.browser.js";
  const DEFAULT_REDIRECT_PATH = "/app.html";

  function getPageRoot() {
    return document.querySelector(PAGE_SELECTOR);
  }

  function getMountNode(root) {
    return root ? root.querySelector(MOUNT_SELECTOR) : null;
  }

  function getStatusNode(root) {
    return root ? root.querySelector(STATUS_SELECTOR) : null;
  }

  function setStatus(root, message, tone) {
    const node = getStatusNode(root);
    if (!node) {
      return;
    }

    node.hidden = !message;
    node.textContent = message || "";
    node.setAttribute("data-tone", tone || "muted");
  }

  function resolveRedirectTarget() {
    try {
      const url = new URL(window.location.href);
      const raw =
        url.searchParams.get("redirect_url") ||
        url.searchParams.get("returnBackUrl") ||
        url.searchParams.get("return_to") ||
        DEFAULT_REDIRECT_PATH;
      const target = new URL(raw, window.location.origin);

      if (target.origin !== window.location.origin) {
        return DEFAULT_REDIRECT_PATH;
      }

      return `${target.pathname}${target.search}${target.hash}` || DEFAULT_REDIRECT_PATH;
    } catch {
      return DEFAULT_REDIRECT_PATH;
    }
  }

  function buildSiblingPageUrl(pathname) {
    const url = new URL(pathname, window.location.origin);
    const redirectTarget = resolveRedirectTarget();

    if (redirectTarget) {
      const absoluteTarget = new URL(redirectTarget, window.location.origin).toString();
      url.searchParams.set("redirect_url", absoluteTarget);
      url.searchParams.set("returnBackUrl", absoluteTarget);
    }

    return url.toString();
  }

  function hydrateAuxLinks(root, pageType) {
    const alternateHref =
      pageType === "sign-up" ? buildSiblingPageUrl("/sign-in") : buildSiblingPageUrl("/sign-up");

    for (const link of root.querySelectorAll("[data-auth-page-link='alternate']")) {
      link.setAttribute("href", alternateHref);
    }

    for (const link of root.querySelectorAll("[data-auth-page-link='return']")) {
      link.setAttribute("href", resolveRedirectTarget());
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

  function buildClerkBrowserSdkUrl(frontendApiUrl) {
    const trimmed = typeof frontendApiUrl === "string" ? frontendApiUrl.trim().replace(/\/+$/, "") : "";
    if (!trimmed) {
      return DEFAULT_CLERK_BROWSER_SDK_URL;
    }

    return `${trimmed}/npm/@clerk/clerk-js@5/dist/clerk.browser.js`;
  }

  async function ensureClerkScript(publishableKey, frontendApiUrl) {
    if (window.Clerk) {
      return;
    }

    if (publishableKey) {
      window.__clerk_publishable_key = publishableKey;
    }

    const scriptUrl = buildClerkBrowserSdkUrl(frontendApiUrl);

    await new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${scriptUrl}"]`);
      if (existing) {
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener("error", () => reject(new Error("Failed to load Clerk SDK")), {
          once: true,
        });
        return;
      }

      const script = document.createElement("script");
      script.src = scriptUrl;
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

  async function getClerkClient(publishableKey, frontendApiUrl) {
    await ensureClerkScript(publishableKey, frontendApiUrl);

    if (typeof window.Clerk === "function") {
      const clerk = new window.Clerk(publishableKey);
      await clerk.load();
      return clerk;
    }

    if (window.Clerk && typeof window.Clerk.load === "function") {
      await window.Clerk.load({ publishableKey });
      return window.Clerk;
    }

    throw new Error("Clerk SDK API not available");
  }

  function buildSharedProps(config) {
    const redirectTarget = resolveRedirectTarget();

    return {
      routing: "path",
      signInUrl: config?.signInUrl || "/sign-in",
      signUpUrl: config?.signUpUrl || "/sign-up",
      fallbackRedirectUrl: redirectTarget,
      signUpFallbackRedirectUrl: redirectTarget,
    };
  }

  async function boot() {
    const root = getPageRoot();
    if (!root) {
      return;
    }

    const pageType = root.getAttribute("data-clerk-auth-page") || "sign-in";
    const mountNode = getMountNode(root);
    if (!mountNode) {
      return;
    }

    hydrateAuxLinks(root, pageType);
    setStatus(root, "Loading secure sign-in…", "muted");

    let config;
    try {
      config = await fetchAuthConfig();
    } catch (error) {
      console.error("Failed to load auth config", error);
      setStatus(root, "Auth is unavailable right now. Open the setup guide and try again.", "error");
      return;
    }

    if (!config?.enabled || !config?.publishableKey) {
      setStatus(root, "Auth is not enabled in this environment yet.", "error");
      return;
    }

    try {
      const clerk = await getClerkClient(config.publishableKey, config.frontendApiUrl);
      const redirectTarget = resolveRedirectTarget();

      if (clerk.isSignedIn) {
        window.location.replace(redirectTarget);
        return;
      }

      const sharedProps = buildSharedProps(config);

      if (pageType === "sign-up") {
        clerk.mountSignUp(mountNode, {
          ...sharedProps,
          path: config?.signUpUrl || "/sign-up",
        });
      } else {
        clerk.mountSignIn(mountNode, {
          ...sharedProps,
          path: config?.signInUrl || "/sign-in",
          withSignUp: false,
        });
      }

      setStatus(root, "", "muted");
    } catch (error) {
      console.error("Failed to initialize Clerk auth page", error);
      setStatus(root, "Secure sign-in failed to load. Refresh and try again.", "error");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      void boot();
    }, { once: true });
  } else {
    void boot();
  }
})();
