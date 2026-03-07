(function () {
  const PAGE_SIZE = 10;

  const searchInput = document.getElementById("my-links-search");
  const sortSelect = document.getElementById("my-links-sort");
  const statusEl = document.getElementById("my-links-status");
  const authRequiredEl = document.getElementById("my-links-auth-required");
  const emptyEl = document.getElementById("my-links-empty");
  const tableEl = document.getElementById("my-links-table");
  const bodyEl = document.getElementById("my-links-body");
  const paginationEl = document.getElementById("my-links-pagination");
  const pageLabelEl = document.getElementById("my-links-page-label");
  const prevBtn = document.getElementById("my-links-prev");
  const nextBtn = document.getElementById("my-links-next");
  const legacyClaimForm = document.getElementById("legacy-claim-form");
  const legacyClaimLinkInput = document.getElementById("legacy-claim-link-input");
  const legacyClaimTokenInput = document.getElementById("legacy-claim-token-input");
  const legacyClaimSubmitBtn = document.getElementById("legacy-claim-submit");
  const legacyClaimStatusEl = document.getElementById("legacy-claim-status");

  let page = 1;
  let search = "";
  let sort = sortSelect?.value || "created_desc";
  let totalPages = 1;
  let isLoading = false;
  let trackedView = false;

  const urlForHighlight = new URL(window.location.href);
  let highlightedDocId = urlForHighlight.searchParams.get("created");
  if (highlightedDocId) {
    urlForHighlight.searchParams.delete("created");
    try {
      window.history.replaceState({}, document.title, urlForHighlight.toString());
    } catch {
      /* ignore */
    }
  }

  function setStatus(message) {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.hidden = !message;
  }

  function setVisible({ authRequired, empty, table, pagination }) {
    if (authRequiredEl) authRequiredEl.hidden = !authRequired;
    if (emptyEl) emptyEl.hidden = !empty;
    if (tableEl) tableEl.hidden = !table;
    if (paginationEl) paginationEl.hidden = !pagination;
  }

  function formatDate(isoDate) {
    try {
      return new Date(isoDate).toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "2-digit",
      });
    } catch {
      return isoDate;
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function setLegacyClaimStatus(message, kind = "") {
    if (!legacyClaimStatusEl) return;
    legacyClaimStatusEl.textContent = message || "";
    if (kind) {
      legacyClaimStatusEl.setAttribute("data-kind", kind);
    } else {
      legacyClaimStatusEl.removeAttribute("data-kind");
    }
  }

  function normalizeLegacyDocId(rawValue) {
    const value = (rawValue || "").trim();
    if (!value) return null;

    const directMatch = value.match(/^[A-Za-z0-9_-]{6,64}$/);
    if (directMatch) {
      return directMatch[0];
    }

    try {
      const parsed = new URL(value, window.location.origin);
      const parts = parsed.pathname.split("/").filter(Boolean);

      if (parts[0] === "v" && /^[A-Za-z0-9_-]{6,64}$/.test(parts[1] || "")) {
        return parts[1];
      }

      if (
        parts[0] === "api" &&
        parts[1] === "render" &&
        /^[A-Za-z0-9_-]{6,64}$/.test(parts[2] || "")
      ) {
        return parts[2];
      }
    } catch {
      return null;
    }

    return null;
  }

  async function getAuthToken() {
    try {
      const getter = window.plsreadmeGetAuthToken;
      if (typeof getter === "function") {
        const result = await getter();
        return typeof result === "string" && result ? result : null;
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  function renderRows(items) {
    if (!bodyEl) return;

    bodyEl.innerHTML = items
      .map((item) => {
        const title = item.title || "Untitled";
        const isCreatedTarget = highlightedDocId && highlightedDocId === item.id;
        const rowStyle = isCreatedTarget
          ? ' style="background: rgba(37,99,235,0.12);"'
          : "";

        return `
          <tr${rowStyle}>
            <td>
              <div class="ml-title-cell">
                <span class="ml-title-main">${escapeHtml(title)}</span>
                <span class="ml-title-meta">${escapeHtml(item.slug)} · ${escapeHtml(item.id)}</span>
              </div>
            </td>
            <td>${escapeHtml(formatDate(item.createdAt))}</td>
            <td>${Number(item.viewCount || 0)}</td>
            <td>
              <div class="ml-actions">
                <a class="ml-action-btn" href="${escapeHtml(item.url)}" target="_blank" rel="noopener">Open</a>
                <button type="button" class="ml-action-btn" data-copy-url="${escapeHtml(item.url)}">Copy</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join("");

    const copyButtons = bodyEl.querySelectorAll("[data-copy-url]");
    for (const button of copyButtons) {
      button.addEventListener("click", async () => {
        const url = button.getAttribute("data-copy-url") || "";
        if (!url) return;

        const original = button.textContent;

        try {
          await navigator.clipboard.writeText(url);
          button.textContent = "Copied";
        } catch {
          button.textContent = "Copy failed";
        }

        setTimeout(() => {
          button.textContent = original;
        }, 1200);
      });
    }
  }

  function updatePagination(meta) {
    totalPages = Math.max(1, Number(meta?.totalPages || 1));
    const currentPage = Number(meta?.page || page);
    const total = Number(meta?.total || 0);

    if (pageLabelEl) {
      pageLabelEl.textContent = `Page ${currentPage} of ${totalPages} · ${total} total`;
    }

    if (prevBtn) prevBtn.disabled = currentPage <= 1 || isLoading;
    if (nextBtn) nextBtn.disabled = currentPage >= totalPages || isLoading;

    setVisible({
      authRequired: false,
      empty: false,
      table: total > 0,
      pagination: total > PAGE_SIZE,
    });
  }

  async function fetchMyLinks() {
    if (isLoading) return;

    const token = await getAuthToken();
    if (!token) {
      setVisible({ authRequired: true, empty: false, table: false, pagination: false });
      setStatus("");
      return;
    }

    isLoading = true;
    setStatus("Loading your links…");

    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;

    const query = new URLSearchParams({
      page: String(page),
      page_size: String(PAGE_SIZE),
      sort,
    });

    if (search) {
      query.set("search", search);
    }

    try {
      const response = await fetch(`/api/auth/my-links?${query.toString()}`, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
      });

      if (response.status === 401) {
        setVisible({ authRequired: true, empty: false, table: false, pagination: false });
        setStatus("");
        return;
      }

      if (!response.ok) {
        throw new Error(`Request failed (${response.status})`);
      }

      const data = await response.json();
      const items = Array.isArray(data.items) ? data.items : [];

      if (!trackedView && typeof window.track === "function") {
        window.track("my_links_view", {
          result_count: Number(data.pagination?.total || 0),
        });
        trackedView = true;
      }

      if (!items.length) {
        renderRows([]);
        setVisible({ authRequired: false, empty: true, table: false, pagination: false });
        setStatus("");
        return;
      }

      renderRows(items);
      updatePagination(data.pagination);
      setStatus("");
    } catch (error) {
      console.error("Failed to load my links", error);
      setVisible({ authRequired: false, empty: false, table: false, pagination: false });
      setStatus("Could not load your links. Please refresh and try again.");
    } finally {
      isLoading = false;
    }
  }

  function debounce(fn, ms) {
    let timeout = null;
    return function (...args) {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => fn(...args), ms);
    };
  }

  const onSearchChange = debounce(() => {
    search = (searchInput?.value || "").trim();
    page = 1;
    void fetchMyLinks();
  }, 220);

  if (searchInput) {
    searchInput.addEventListener("input", onSearchChange);
  }

  if (sortSelect) {
    sortSelect.addEventListener("change", () => {
      sort = sortSelect.value || "created_desc";
      page = 1;
      void fetchMyLinks();
    });
  }

  if (prevBtn) {
    prevBtn.addEventListener("click", () => {
      if (page <= 1 || isLoading) return;
      page -= 1;
      void fetchMyLinks();
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener("click", () => {
      if (page >= totalPages || isLoading) return;
      page += 1;
      void fetchMyLinks();
    });
  }

  if (legacyClaimForm) {
    legacyClaimForm.addEventListener("submit", async (event) => {
      event.preventDefault();

      const docId = normalizeLegacyDocId(legacyClaimLinkInput?.value || "");
      const adminToken = (legacyClaimTokenInput?.value || "").trim();

      if (!docId) {
        setLegacyClaimStatus("Enter a valid link URL or document ID.", "error");
        return;
      }

      if (!/^sk_[A-Za-z0-9_-]{8,160}$/.test(adminToken)) {
        setLegacyClaimStatus("Enter a valid edit token (starts with sk_).", "error");
        return;
      }

      const authToken = await getAuthToken();
      if (!authToken) {
        setLegacyClaimStatus("Sign in first, then try claiming again.", "error");
        return;
      }

      if (legacyClaimSubmitBtn) {
        legacyClaimSubmitBtn.disabled = true;
        legacyClaimSubmitBtn.textContent = "Claiming…";
      }
      setLegacyClaimStatus("Verifying token and claiming link…");

      try {
        const response = await fetch("/api/auth/claim-link", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({
            id: docId,
            adminToken,
          }),
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.error || `Claim failed (${response.status})`);
        }

        highlightedDocId = docId;
        page = 1;
        search = docId;
        if (searchInput) {
          searchInput.value = docId;
        }

        const statusMessage = data.claimed
          ? "Link claimed successfully. It now appears in your account."
          : "This link is already in your account.";
        setLegacyClaimStatus(statusMessage, "success");

        if (legacyClaimTokenInput) {
          legacyClaimTokenInput.value = "";
        }

        if (typeof window.track === "function") {
          window.track("legacy_link_claim", {
            claimed: Boolean(data.claimed),
            result_code: data.code || "unknown",
          });
        }

        await fetchMyLinks();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to claim link.";
        setLegacyClaimStatus(message, "error");
        if (typeof window.track === "function") {
          window.track("legacy_link_claim_error", {
            message,
          });
        }
      } finally {
        if (legacyClaimSubmitBtn) {
          legacyClaimSubmitBtn.disabled = false;
          legacyClaimSubmitBtn.textContent = "Claim link";
        }
      }
    });
  }

  window.addEventListener("plsreadme:auth-state", () => {
    page = 1;
    void fetchMyLinks();
  });

  void fetchMyLinks();
})();
