// Tab switching
const tabs = document.querySelectorAll(".tab");
const tabContents = document.querySelectorAll(".tab-content");

function detectMarkdown(text) {
  // Updated 2025-12-25: Improved detection to prevent false positives from line breaks.
  // Focus on stronger markdown tokens rather than weak signals.
  const strongMdSignals = [
    /^\s{0,3}#{1,6}\s+\S/m, // headings with proper spacing
    /^\s{0,3}>\s+\S/m, // blockquote
    /^\s{0,3}[-*+]\s+\S/m, // unordered list
    /^\s{0,3}\d+\.\s+\S/m, // ordered list
    /^```[\s\S]*?```$/m, // fenced code block (complete)
    /^\s{0,3}---\s*$/m, // horizontal rule
    /^\s{0,3}\|\s*[^|]+\s*\|/m, // table row
    /\*\*[^*\n]+\*\*/m, // bold (no line breaks within)
    /__[^_\n]+__/m, // bold underscore (no line breaks within)
    /\[[^\]\n]+\]\([^)\n]+\)/m, // markdown link (no line breaks within)
    /!\[[^\]\n]*]\([^)\n]+\)/m, // markdown image (no line breaks within)
  ];
  return strongMdSignals.some((re) => re.test(text));
}

const markdownStatus = document.getElementById("markdown-status");
let pasteLooksRichText = false;
let isConverting = false;
let convertButton = null;
let pasteActions = null;

function setPasteActionsVisible(visible) {
  if (!pasteActions) return;
  pasteActions.classList.toggle("show", !!visible);
}

function setConvertButtonState({ disabled, text }) {
  if (!convertButton) return;
  convertButton.disabled = !!disabled;
  if (typeof text === "string") convertButton.textContent = text;
}

function setMarkdownStatus({ show, kind, message }) {
  if (!markdownStatus) return;
  markdownStatus.classList.remove("show", "good", "warn");
  if (!show) {
    markdownStatus.textContent = "";
    return;
  }
  markdownStatus.classList.add("show");
  if (kind) markdownStatus.classList.add(kind);
  markdownStatus.textContent = message;
}

function updateCreateButtonState() {
  const activeTab = document.querySelector(".tab.active")?.dataset?.tab;
  if (!activeTab) return;

  if (activeTab === "upload") {
    createButton.disabled = !selectedFile;
    setMarkdownStatus({ show: false, kind: null, message: "" });
    setPasteActionsVisible(false);
    return;
  }

  // Paste tab
  const text = markdownInput.value.trim();
  if (!text) {
    createButton.disabled = true;
    setMarkdownStatus({
      show: true,
      kind: null,
      message: "Paste Markdown to enable “Create Link”.",
    });
    isConverting = false;
    setConvertButtonState({ disabled: false, text: "Generate new Markdown" });
    setPasteActionsVisible(false);
    return;
  }

  const hasMarkdown = detectMarkdown(text);
  if (hasMarkdown) {
    createButton.disabled = false;
    pasteLooksRichText = false;
    isConverting = false;
    setConvertButtonState({ disabled: false, text: "Generate new Markdown" });
    setPasteActionsVisible(true);
    setMarkdownStatus({
      show: true,
      kind: "good",
      message: "Markdown detected — ready to create link.",
    });
    return;
  }

  // No markdown detected, but button is still available (Updated 2025-12-25)
  createButton.disabled = false;
  setPasteActionsVisible(true);
  setConvertButtonState({
    disabled: isConverting,
    text: isConverting ? "Generating…" : "Generate new Markdown",
  });
  setMarkdownStatus({
    show: true,
    kind: null,
    message: pasteLooksRichText
      ? 'No Markdown detected. You can still create a link, or try "Generate new Markdown" to convert rich text.'
      : "No Markdown detected. You can still create a link as-is, or add Markdown formatting.",
  });
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    const tabName = tab.dataset.tab;

    tabs.forEach((t) => t.classList.remove("active"));
    tabContents.forEach((tc) => tc.classList.remove("active"));

    tab.classList.add("active");
    document.getElementById(`${tabName}-tab`).classList.add("active");

    updateCreateButtonState();
  });
});

// File upload handling
const fileUploadZone = document.getElementById("file-upload-zone");
const fileInput = document.getElementById("file-input");
const fileSelected = document.getElementById("file-selected");
const fileName = document.getElementById("file-name");
const removeFileBtn = document.getElementById("remove-file");

let selectedFile = null;

fileUploadZone.addEventListener("click", () => {
  fileInput.click();
});

fileUploadZone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});

fileUploadZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  fileUploadZone.classList.add("drag-over");
});

fileUploadZone.addEventListener("dragleave", () => {
  fileUploadZone.classList.remove("drag-over");
});

fileUploadZone.addEventListener("drop", (e) => {
  e.preventDefault();
  fileUploadZone.classList.remove("drag-over");

  const files = e.dataTransfer.files;
  if (files.length > 0) {
    handleFileSelect(files[0]);
  }
});

fileInput.addEventListener("change", (e) => {
  if (e.target.files.length > 0) {
    handleFileSelect(e.target.files[0]);
  }
});

removeFileBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  selectedFile = null;
  fileInput.value = "";
  fileSelected.style.display = "none";
  fileUploadZone.style.display = "block";
  updateCreateButtonState();
});

function handleFileSelect(file) {
  const maxSize = 200 * 1024; // 200 KB

  if (file.size > maxSize) {
    showError("File is too large. Maximum size is 200 KB.");
    return;
  }

  if (!file.name.endsWith(".md") && !file.name.endsWith(".markdown")) {
    showError("Please select a Markdown file (.md or .markdown)");
    return;
  }

  selectedFile = file;
  fileName.textContent = file.name;
  fileSelected.style.display = "flex";
  fileUploadZone.style.display = "none";
  hideError();
  updateCreateButtonState();
}

// Create link
const createButton = document.getElementById("create-button");
const buttonText = document.getElementById("button-text");
const markdownInput = document.getElementById("markdown-input");
convertButton = document.getElementById("convert-button");
pasteActions = convertButton?.closest?.(".paste-actions") || null;
const resultSection = document.getElementById("result-section");
const resultUrl = document.getElementById("result-url");
const viewLink = document.getElementById("view-link");
const errorSection = document.getElementById("error-section");

markdownInput.addEventListener("paste", (e) => {
  // Detect if the clipboard *source* looks like rich text, even if the textarea only receives plain text.
  try {
    const html = e.clipboardData?.getData("text/html") || "";
    pasteLooksRichText =
      !!html &&
      /<(h[1-6]|strong|b|em|i|ul|ol|li|code|pre|blockquote|p)\b/i.test(html);
  } catch {
    pasteLooksRichText = false;
  }

  // Let the paste happen, then recompute state.
  setTimeout(updateCreateButtonState, 0);
});

markdownInput.addEventListener("input", () => {
  pasteLooksRichText = false;
  updateCreateButtonState();
});

// Allow Enter+Cmd/Ctrl to submit
markdownInput.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    createButton.click();
  }
});

if (convertButton) {
  convertButton.addEventListener("click", async () => {
    const activeTab = document.querySelector(".tab.active")?.dataset?.tab;
    if (activeTab !== "paste") return;

    const text = markdownInput.value.trim();
    if (!text) return;
    // Updated 2025-12-25: Allow generating new markdown even if markdown is detected

    isConverting = true;
    hideError();
    setConvertButtonState({ disabled: true, text: "Generating…" });
    setMarkdownStatus({
      show: true,
      kind: null,
      message: "Generating new Markdown…",
    });
    updateCreateButtonState();

    try {
      const response = await fetch("/api/convert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Failed to generate Markdown");
      }

      if (typeof data.markdown !== "string" || !data.markdown.trim()) {
        throw new Error("AI returned empty Markdown");
      }

      markdownInput.value = data.markdown.trim();
      pasteLooksRichText = false;
      setMarkdownStatus({
        show: true,
        kind: "good",
        message: "Generated new Markdown.",
      });
    } catch (error) {
      showError(error.message || "Failed to generate Markdown");
      setMarkdownStatus({
        show: true,
        kind: "warn",
        message: "Generation failed. You can still paste Markdown manually.",
      });
    } finally {
      isConverting = false;
      setConvertButtonState({ disabled: false, text: "Generate new Markdown" });
      updateCreateButtonState();
    }
  });
}

createButton.addEventListener("click", async () => {
  const activeTab = document.querySelector(".tab.active").dataset.tab;
  let markdown = "";

  if (activeTab === "paste") {
    markdown = markdownInput.value.trim();
    if (!markdown) {
      showError("Please enter some markdown content");
      return;
    }
    // Updated 2025-12-25: Removed markdown detection blocker - allow any content
  } else {
    if (!selectedFile) {
      showError("Please select a file to upload");
      return;
    }
    markdown = await selectedFile.text();
  }

  // Disable button and show loading
  createButton.disabled = true;
  buttonText.innerHTML = '<span class="spinner"></span> Creating...';
  hideError();

  try {
    const response = await fetch("/api/create-link", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ markdown }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Failed to create link");
    }

    // Show result
    resultUrl.value = data.url;
    viewLink.href = data.url;
    resultSection.classList.add("show");

    // Automatically copy the URL to clipboard
    try {
      await navigator.clipboard.writeText(data.url);
      console.log("Link copied to clipboard");
    } catch (clipboardError) {
      console.error("Failed to auto-copy:", clipboardError);
    }

    // Scroll to result
    resultSection.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) {
    showError(error.message);
  } finally {
    createButton.disabled = false;
    buttonText.textContent = "Create Link";
  }
});

// Copy result
const copyResultBtn = document.getElementById("copy-result");
copyResultBtn.addEventListener("click", () => {
  resultUrl.select();
  navigator.clipboard.writeText(resultUrl.value);

  const originalText = copyResultBtn.textContent;
  copyResultBtn.textContent = "Copied!";
  setTimeout(() => {
    copyResultBtn.textContent = originalText;
  }, 2000);
});

// Create another
const createAnotherBtn = document.getElementById("create-another");
createAnotherBtn.addEventListener("click", (e) => {
  e.preventDefault();

  // Reset form
  markdownInput.value = "";
  selectedFile = null;
  fileInput.value = "";
  fileSelected.style.display = "none";
  fileUploadZone.style.display = "block";
  resultSection.classList.remove("show");
  pasteLooksRichText = false;
  isConverting = false;
  setConvertButtonState({ disabled: false, text: "Convert to Markdown" });
  updateCreateButtonState();

  // Scroll to top
  window.scrollTo({ top: 0, behavior: "smooth" });
});

// Error handling
function showError(message) {
  errorSection.textContent = message;
  errorSection.classList.add("show");
  errorSection.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function hideError() {
  errorSection.classList.remove("show");
}

// Track page view
if (typeof track !== "undefined") {
  track("app_view");
}

// Initialize on load
updateCreateButtonState();
