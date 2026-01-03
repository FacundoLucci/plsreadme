/**
 * plsreadme Analytics — Client-side tracking
 * Lightweight, privacy-respecting event tracking
 */

(function () {
  "use strict";

  // Configuration
  var ENDPOINT = "/t";
  var ANON_ID_KEY = "outframer_aid";

  // Get or create anonymous ID
  function getAnonId() {
    var id = localStorage.getItem(ANON_ID_KEY);
    if (!id) {
      id =
        "a_" +
        Math.random().toString(36).substring(2, 15) +
        Date.now().toString(36);
      try {
        localStorage.setItem(ANON_ID_KEY, id);
      } catch (e) {
        // localStorage not available
      }
    }
    return id;
  }

  // Get UTM parameter from URL
  function getUTM(param) {
    try {
      var url = new URL(window.location.href);
      return url.searchParams.get(param) || "";
    } catch (e) {
      return "";
    }
  }

  // Get all UTM parameters
  function getUTMs() {
    return {
      utm_source: getUTM("utm_source"),
      utm_medium: getUTM("utm_medium"),
      utm_campaign: getUTM("utm_campaign"),
      utm_content: getUTM("utm_content"),
      utm_term: getUTM("utm_term"),
    };
  }

  // Send tracking event
  function track(event, extra) {
    extra = extra || {};

    var payload = {
      event: event,
      path: window.location.pathname,
      referrer: document.referrer || "",
      anon_id: getAnonId(),
      timestamp: Date.now(),
    };

    // Merge UTMs
    var utms = getUTMs();
    for (var key in utms) {
      payload[key] = utms[key];
    }

    // Merge extra properties
    for (var prop in extra) {
      payload[prop] = extra[prop];
    }

    // Send via fetch with keepalive (non-blocking, reliable JSON)
    var data = JSON.stringify(payload);

    fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: data,
      keepalive: true,
    }).catch(function () {});
  }

  // Scroll tracking state
  var scrolled50 = false;
  var scrolled90 = false;

  function getScrollPercent() {
    var h = document.documentElement;
    var b = document.body;
    var st = "scrollTop";
    var sh = "scrollHeight";
    return ((h[st] || b[st]) / ((h[sh] || b[sh]) - h.clientHeight)) * 100;
  }

  function onScroll() {
    var percent = getScrollPercent();

    if (!scrolled50 && percent >= 50) {
      scrolled50 = true;
      track("scroll_50");
    }

    if (!scrolled90 && percent >= 90) {
      scrolled90 = true;
      track("scroll_90");
    }
  }

  // Throttle scroll events
  var scrollTimeout;
  function throttledScroll() {
    if (!scrollTimeout) {
      scrollTimeout = setTimeout(function () {
        scrollTimeout = null;
        onScroll();
      }, 100);
    }
  }

  // Initialize
  function init() {
    // Track page view
    track("page_view");

    // Setup scroll tracking
    window.addEventListener("scroll", throttledScroll, { passive: true });

    // Setup waitlist modal (only on index page)
    setupWaitlistModal();
  }

  // Setup waitlist modal
  function setupWaitlistModal() {
    const openModalButtons = document.querySelectorAll(
      "#open-waitlist-modal-header, #open-waitlist-modal-bottom"
    );
    const waitlistModal = document.getElementById("waitlist-modal");

    if (!waitlistModal || openModalButtons.length === 0) {
      return; // Not on index page
    }

    const closeModalButton = waitlistModal.querySelector(".close-button");
    const modalWaitlistForm = document.getElementById("modal-waitlist-form");
    const modalEmailInput = document.getElementById("modal-email");
    const modalFeaturesInput = document.getElementById("modal-features");
    const modalFormMessage = document.getElementById("modal-form-message");
    const honeypotInput = document.getElementById("honeypot");

    // Open modal on button click
    openModalButtons.forEach((button) => {
      button.addEventListener("click", function (e) {
        e.preventDefault();
        const ctaLocation = button.dataset.cta || "unknown";
        track("request_beta_access", { cta_location: ctaLocation });
        waitlistModal.classList.add("show");
        if (modalEmailInput) {
          modalEmailInput.focus();
        }
      });
    });

    // Close modal
    if (closeModalButton) {
      closeModalButton.addEventListener("click", function () {
        waitlistModal.classList.remove("show");
        if (modalFormMessage) {
          modalFormMessage.textContent = "";
          modalFormMessage.className = "form-message";
        }
        if (modalEmailInput) {
          modalEmailInput.value = "";
        }
        if (modalFeaturesInput) {
          modalFeaturesInput.value = "";
        }
      });
    }

    // Close modal when clicking outside
    window.addEventListener("click", function (event) {
      if (event.target === waitlistModal) {
        waitlistModal.classList.remove("show");
        if (modalFormMessage) {
          modalFormMessage.textContent = "";
          modalFormMessage.className = "form-message";
        }
        if (modalEmailInput) {
          modalEmailInput.value = "";
        }
        if (modalFeaturesInput) {
          modalFeaturesInput.value = "";
        }
      }
    });

    // Handle modal form submission
    if (modalWaitlistForm) {
      modalWaitlistForm.addEventListener("submit", async function (e) {
        e.preventDefault();

        const email = modalEmailInput ? modalEmailInput.value.trim() : "";
        const requestedFeatures = modalFeaturesInput
          ? modalFeaturesInput.value.trim()
          : "";
        const honeypot = honeypotInput ? honeypotInput.value : "";
        const button = modalWaitlistForm.querySelector('button[type="submit"]');

        if (!email) {
          return;
        }

        track("waitlist_submit", { email: email });

        // Disable form
        if (button) {
          button.disabled = true;
          button.classList.add("loading");
        }

        const formData = {
          email: email,
          requested_features: requestedFeatures,
          honeypot: honeypot,
          utm_source: getUTM("utm_source"),
          utm_medium: getUTM("utm_medium"),
          utm_campaign: getUTM("utm_campaign"),
          utm_content: getUTM("utm_content"),
          utm_term: getUTM("utm_term"),
          referrer: document.referrer || "",
          landing_path: window.location.pathname,
          user_agent: navigator.userAgent || "",
          ip_hash: "", // Placeholder, ideally set by Worker
        };

        try {
          const response = await fetch("/api/waitlist", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(formData),
          });

          const result = await response.json();

          if (result.success) {
            track("waitlist_success", { email: email });
            window.location.href = "/thanks.html";
          } else {
            const message =
              result.message ||
              result.error ||
              "Something went wrong. Please try again.";
            track("waitlist_error", { email: email, error: message });
            if (modalFormMessage) {
              modalFormMessage.textContent = message;
              modalFormMessage.className = "form-message error";
            }
            if (button) {
              button.disabled = false;
              button.classList.remove("loading");
            }
          }
        } catch (error) {
          console.error("Error submitting waitlist:", error);
          track("waitlist_error", { email: email, error: "Network error" });
          if (modalFormMessage) {
            modalFormMessage.textContent =
              "An unexpected error occurred. Please try again.";
            modalFormMessage.className = "form-message error";
          }
          if (button) {
            button.disabled = false;
            button.classList.remove("loading");
          }
        }
      });
    }
  }

  // Run on DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Expose track function globally
  window.track = track;
  window.getUTM = getUTM;
})();
