(function () {
  const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
  let configPromise;
  let scriptPromise;

  function getConfig() {
    if (!configPromise) {
      configPromise = fetch("/api/auth/config", { headers: { Accept: "application/json" } })
        .then((response) => response.json())
        .then((config) => {
          if (!config.turnstileSiteKey) throw new Error("Human verification is not configured.");
          return config;
        });
    }
    return configPromise;
  }

  function loadScript() {
    if (window.turnstile) return Promise.resolve();
    if (!scriptPromise) {
      scriptPromise = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = SCRIPT_URL;
        script.async = true;
        script.defer = true;
        script.onload = resolve;
        script.onerror = () => reject(new Error("Could not load human verification."));
        document.head.appendChild(script);
      });
    }
    return scriptPromise;
  }

  async function getToken() {
    const [config] = await Promise.all([getConfig(), loadScript()]);
    const container = document.createElement("div");
    container.setAttribute("aria-live", "polite");
    container.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;";
    document.body.appendChild(container);

    return new Promise((resolve, reject) => {
      let widgetId;
      const cleanup = () => {
        try {
          if (widgetId !== undefined) window.turnstile.remove(widgetId);
        } catch {}
        container.remove();
      };
      const fail = (message) => {
        cleanup();
        reject(new Error(message));
      };

      widgetId = window.turnstile.render(container, {
        sitekey: config.turnstileSiteKey,
        action: config.turnstileAction || "anonymous_upload",
        appearance: "interaction-only",
        execution: "execute",
        callback(token) {
          cleanup();
          resolve(token);
        },
        "error-callback"() {
          fail("Human verification failed. Please try again.");
        },
        "expired-callback"() {
          fail("Human verification expired. Please try again.");
        },
      });
      window.turnstile.execute(widgetId);
    });
  }

  async function issueDemoGrant() {
    const token = await getToken();
    const response = await fetch("/api/auth/demo-grant", {
      method: "GET",
      headers: { Accept: "application/json", "X-Turnstile-Token": token },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || "Human verification failed.");
      error.payload = data;
      throw error;
    }
    return data;
  }

  async function createLink(markdown) {
    await issueDemoGrant();
    return fetch("/api/create-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown }),
    });
  }

  window.plsreadmeTurnstile = { getToken, issueDemoGrant, createLink };
})();
