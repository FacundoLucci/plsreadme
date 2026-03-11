(function () {
  const PAGE_SIZE = 50;

  const searchInput = document.getElementById("my-links-search");
  const sortSelect = document.getElementById("my-links-sort");
  const statusEl = document.getElementById("my-links-status");
  const authRequiredEl = document.getElementById("my-links-auth-required");
  const emptyEl = document.getElementById("my-links-empty");
  const sectionsEl = document.getElementById("my-links-sections");

  const createdCountEl = document.getElementById("my-created-count");
  const createdEmptyEl = document.getElementById("my-created-empty");
  const createdTableEl = document.getElementById("my-created-table");
  const createdBodyEl = document.getElementById("my-created-body");

  const savedCountEl = document.getElementById("my-saved-count");
  const savedEmptyEl = document.getElementById("my-saved-empty");
  const savedTableEl = document.getElementById("my-saved-table");
  const savedBodyEl = document.getElementById("my-saved-body");

  let search = "";
  let sort = sortSelect?.value || "created_desc";
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

  function setViewMode(mode) {
    if (authRequiredEl) authRequiredEl.hidden = mode !== "auth";
    if (emptyEl) emptyEl.hidden = mode !== "empty";
    if (sectionsEl) sectionsEl.hidden = mode !== "sections";
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

  function attachCopyHandlers(scope) {
    const copyButtons = scope.querySelectorAll("[data-copy-url]");
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

  function renderRows(targetBody, items, { highlightCreated = false } = {}) {
    if (!targetBody) return;

    targetBody.innerHTML = items
      .map((item) => {
        const title = item.title || "Untitled";
        const isCreatedTarget = highlightCreated && highlightedDocId && highlightedDocId === item.id;
        const rowClass = isCreatedTarget ? " class=\"ml-highlight-row\"" : "";

        return `
          <tr${rowClass}>
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

    attachCopyHandlers(targetBody);
  }

  function renderSection({ items, countEl, emptyEl, tableEl, bodyEl, highlightCreated }) {
    const total = Number(items?.length || 0);
    if (countEl) {
      countEl.textContent = `${total} link${total === 1 ? "" : "s"}`;
    }

    if (!total) {
      if (emptyEl) emptyEl.hidden = false;
      if (tableEl) tableEl.hidden = true;
      if (bodyEl) bodyEl.innerHTML = "";
      return;
    }

    if (emptyEl) emptyEl.hidden = true;
    if (tableEl) tableEl.hidden = false;

    renderRows(bodyEl, items, { highlightCreated });
  }

  async function fetchMyLinks() {
    if (isLoading) return;

    const token = await getAuthToken();
    if (!token) {
      setViewMode("auth");
      setStatus("");
      return;
    }

    isLoading = true;
    setStatus("Loading your links…");

    const query = new URLSearchParams({
      page: "1",
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
        setViewMode("auth");
        setStatus("");
        return;
      }

      if (!response.ok) {
        throw new Error(`Request failed (${response.status})`);
      }

      const data = await response.json();
      const createdItems = Array.isArray(data.created?.items)
        ? data.created.items
        : Array.isArray(data.items)
        ? data.items
        : [];
      const savedItems = Array.isArray(data.saved?.items) ? data.saved.items : [];

      renderSection({
        items: createdItems,
        countEl: createdCountEl,
        emptyEl: createdEmptyEl,
        tableEl: createdTableEl,
        bodyEl: createdBodyEl,
        highlightCreated: true,
      });

      renderSection({
        items: savedItems,
        countEl: savedCountEl,
        emptyEl: savedEmptyEl,
        tableEl: savedTableEl,
        bodyEl: savedBodyEl,
        highlightCreated: false,
      });

      const totalVisible = createdItems.length + savedItems.length;

      if (!trackedView && typeof window.track === "function") {
        window.track("my_links_view", {
          created_count: Number(data.totals?.created || createdItems.length),
          saved_count: Number(data.totals?.saved || savedItems.length),
          result_count: Number(data.totals?.all || totalVisible),
        });
        trackedView = true;
      }

      if (!totalVisible) {
        setViewMode("empty");
      } else {
        setViewMode("sections");
      }

      setStatus("");
    } catch (error) {
      console.error("Failed to load my links", error);
      setViewMode("empty");
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
    void fetchMyLinks();
  }, 220);

  if (searchInput) {
    searchInput.addEventListener("input", onSearchChange);
  }

  if (sortSelect) {
    sortSelect.addEventListener("change", () => {
      sort = sortSelect.value || "created_desc";
      void fetchMyLinks();
    });
  }

  window.addEventListener("plsreadme:auth-state", () => {
    void fetchMyLinks();
  });

  void fetchMyLinks();
})();
