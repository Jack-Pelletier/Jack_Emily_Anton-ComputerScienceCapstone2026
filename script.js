const uploadForm = document.querySelector('.upload-form');

if (uploadForm) {
  const fileInput = document.querySelector('#projectFile');
  const fileName = document.querySelector('.file-name-display');
  const dropArea = document.querySelector('.file-drop-area');
  const status = document.querySelector('#uploadStatus');
  const submitButton = uploadForm.querySelector('button[type="submit"]');

  function showFile() {
    const file = fileInput.files[0];
    fileName.textContent = file ? file.name : 'No file selected';
    fileInput.setCustomValidity('');
    status.textContent = '';
    status.className = '';

    if (file && !file.name.toLowerCase().endsWith('.pdf')) {
      fileInput.setCustomValidity('Please choose a PDF file.');
    } else if (file && file.size > 10 * 1024 * 1024) {
      fileInput.setCustomValidity('The PDF must be 10 MB or smaller.');
    }

    if (!fileInput.validity.valid && file) {
      status.textContent = fileInput.validationMessage;
      status.className = 'status-error';
    }
  }

  fileInput.addEventListener('change', showFile);
  fileInput.addEventListener('invalid', () => {
    status.textContent = fileInput.validationMessage;
    status.className = 'status-error';
  });

  dropArea.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropArea.classList.add('drag-over');
  });

  dropArea.addEventListener('dragleave', () => {
    dropArea.classList.remove('drag-over');
  });

  dropArea.addEventListener('drop', (event) => {
    event.preventDefault();
    dropArea.classList.remove('drag-over');
    if (submitButton.disabled) return;

    if (event.dataTransfer.files.length !== 1) {
      status.textContent = 'Please drop one PDF file.';
      status.className = 'status-error';
      return;
    }

    fileInput.files = event.dataTransfer.files;
    showFile();
  });

  uploadForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submitButton.disabled) return;

    const formData = new FormData(uploadForm);
    submitButton.disabled = true;
    submitButton.textContent = 'Submitting…';
    status.textContent = 'Uploading your project…';
    status.className = '';

    try {
      const response = await fetch('/api/projects', {
        method: 'POST',
        body: formData
      });
      const result = await response.json().catch(() => {
        throw new Error('The server returned an unexpected response. Please try again.');
      });
      if (!response.ok) throw new Error(result.error || 'The project could not be submitted.');

      uploadForm.reset();
      showFile();
      status.textContent = result.message || 'Your project was submitted for faculty review.';
      status.className = 'status-success';
    } catch (error) {
      status.textContent = error instanceof TypeError
        ? 'Could not reach the server. Check your connection and try again.'
        : error.message;
      status.className = 'status-error';
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = 'Submit Project';
    }
  });
}

const searchForm = document.querySelector('#projectSearchForm');

if (searchForm) {
  const searchInput = document.querySelector('#projectSearch');
  const searchButton = searchForm.querySelector('button');
  const results = document.querySelector('#projectResults');
  const status = document.querySelector('#projectsStatus');

  async function loadProjects() {
    if (searchButton.disabled) return;
    searchButton.disabled = true;
    status.textContent = 'Loading projects…';
    status.className = '';
    results.replaceChildren();

    try {
      const response = await fetch('/api/projects?search=' + encodeURIComponent(searchInput.value.trim()));
      const projects = await response.json().catch(() => {
        throw new Error('The server returned an unexpected response. Please try again.');
      });
      if (!response.ok) throw new Error(projects.error || 'Projects could not be loaded.');

      for (const project of projects) {
        const card = document.createElement('article');
        card.className = 'project-card';

        const title = document.createElement('h3');
        title.textContent = project.ProjectName;
        const description = document.createElement('p');
        description.textContent = project.ProjectDescription;
        card.append(title, description);

        if (project.Industry) {
          const industry = document.createElement('p');
          industry.textContent = 'Industry: ' + project.Industry;
          card.append(industry);
        }

        if (project.Keywords) {
          const keywords = document.createElement('p');
          keywords.textContent = 'Keywords: ' + project.Keywords;
          card.append(keywords);
        }

        if (project.PDFID) {
          const pdfLink = document.createElement('a');
          pdfLink.href = '/api/projects/' + encodeURIComponent(project.ProjectID) + '/pdf';
          pdfLink.textContent = 'View project PDF';
          pdfLink.target = '_blank';
          pdfLink.rel = 'noopener';
          card.append(pdfLink);
        }

        results.append(card);
      }

      status.textContent = projects.length
        ? projects.length + (projects.length === 1 ? ' project found.' : ' projects found.')
        : 'No approved projects found.';
    } catch (error) {
      status.textContent = error instanceof TypeError
        ? 'Could not reach the server. Please try searching again.'
        : error.message;
      status.className = 'status-error';
    } finally {
      searchButton.disabled = false;
    }
  }

  searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    loadProjects();
  });

  loadProjects();
}
