// Tab switching
const tabs = document.querySelectorAll('.tab');
const tabContents = document.querySelectorAll('.tab-content');

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const tabName = tab.dataset.tab;
    
    tabs.forEach(t => t.classList.remove('active'));
    tabContents.forEach(tc => tc.classList.remove('active'));
    
    tab.classList.add('active');
    document.getElementById(`${tabName}-tab`).classList.add('active');
  });
});

// File upload handling
const fileUploadZone = document.getElementById('file-upload-zone');
const fileInput = document.getElementById('file-input');
const fileSelected = document.getElementById('file-selected');
const fileName = document.getElementById('file-name');
const removeFileBtn = document.getElementById('remove-file');

let selectedFile = null;

fileUploadZone.addEventListener('click', () => {
  fileInput.click();
});

fileUploadZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});

fileUploadZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  fileUploadZone.classList.add('drag-over');
});

fileUploadZone.addEventListener('dragleave', () => {
  fileUploadZone.classList.remove('drag-over');
});

fileUploadZone.addEventListener('drop', (e) => {
  e.preventDefault();
  fileUploadZone.classList.remove('drag-over');
  
  const files = e.dataTransfer.files;
  if (files.length > 0) {
    handleFileSelect(files[0]);
  }
});

fileInput.addEventListener('change', (e) => {
  if (e.target.files.length > 0) {
    handleFileSelect(e.target.files[0]);
  }
});

removeFileBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  selectedFile = null;
  fileInput.value = '';
  fileSelected.style.display = 'none';
  fileUploadZone.style.display = 'block';
});

function handleFileSelect(file) {
  const maxSize = 200 * 1024; // 200 KB
  
  if (file.size > maxSize) {
    showError('File is too large. Maximum size is 200 KB.');
    return;
  }
  
  if (!file.name.endsWith('.md') && !file.name.endsWith('.markdown')) {
    showError('Please select a Markdown file (.md or .markdown)');
    return;
  }
  
  selectedFile = file;
  fileName.textContent = file.name;
  fileSelected.style.display = 'flex';
  fileUploadZone.style.display = 'none';
  hideError();
}

// Create link
const createButton = document.getElementById('create-button');
const buttonText = document.getElementById('button-text');
const markdownInput = document.getElementById('markdown-input');
const resultSection = document.getElementById('result-section');
const resultUrl = document.getElementById('result-url');
const viewLink = document.getElementById('view-link');
const errorSection = document.getElementById('error-section');

createButton.addEventListener('click', async () => {
  const activeTab = document.querySelector('.tab.active').dataset.tab;
  let markdown = '';
  
  if (activeTab === 'paste') {
    markdown = markdownInput.value.trim();
    if (!markdown) {
      showError('Please enter some markdown content');
      return;
    }
  } else {
    if (!selectedFile) {
      showError('Please select a file to upload');
      return;
    }
    markdown = await selectedFile.text();
  }
  
  // Disable button and show loading
  createButton.disabled = true;
  buttonText.innerHTML = '<span class="spinner"></span> Creating...';
  hideError();
  
  try {
    const response = await fetch('/api/render', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ markdown }),
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.error || 'Failed to create link');
    }
    
    // Show result
    resultUrl.value = data.url;
    viewLink.href = data.url;
    resultSection.classList.add('show');
    
    // Scroll to result
    resultSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    
  } catch (error) {
    showError(error.message);
  } finally {
    createButton.disabled = false;
    buttonText.textContent = 'Create Link';
  }
});

// Copy result
const copyResultBtn = document.getElementById('copy-result');
copyResultBtn.addEventListener('click', () => {
  resultUrl.select();
  navigator.clipboard.writeText(resultUrl.value);
  
  const originalText = copyResultBtn.textContent;
  copyResultBtn.textContent = 'Copied!';
  setTimeout(() => {
    copyResultBtn.textContent = originalText;
  }, 2000);
});

// Create another
const createAnotherBtn = document.getElementById('create-another');
createAnotherBtn.addEventListener('click', (e) => {
  e.preventDefault();
  
  // Reset form
  markdownInput.value = '';
  selectedFile = null;
  fileInput.value = '';
  fileSelected.style.display = 'none';
  fileUploadZone.style.display = 'block';
  resultSection.classList.remove('show');
  
  // Scroll to top
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// Error handling
function showError(message) {
  errorSection.textContent = message;
  errorSection.classList.add('show');
  errorSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function hideError() {
  errorSection.classList.remove('show');
}

// Track page view
if (typeof track !== 'undefined') {
  track('app_view');
}

