(() => {
  'use strict';

  if (!document.querySelector('[data-admin-page]')) return;
  const byId = id => document.getElementById(id);
  const userList = byId('userList');
  const projectList = byId('adminProjectList');
  const requestList = byId('requestList');
  const requestDialog = byId('requestDialog');
  const deleteDialog = byId('deleteUserDialog');
  const addForm = byId('addUserForm');
  const addButton = addForm.querySelector('button');
  const facultyEmail = byId('facultyEmail');
  const projectEditForm = byId('projectEditForm');
  const projectPdfInput = byId('editProjectPdf');
  let users = [];
  let csrfToken = '';
  let userVersion = 0;
  let projectVersion = 0;
  let pendingVersion = 0;
  let detailVersion = 0;
  let selectedProject = null;
  let selectedUser = null;
  let savingDecision = false;
  let confirmingDenial = false;
  let deletingUser = false;
  let searchTimer;
  let reviewingRequest = false;
  let projectMode = 'view';
  let savingProject = false;
  let editBaseline = null;
  let contactSequence = 0;
  let pdfSelectionVersion = 0;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function status(id, message, kind = '') {
    const node = byId(id);
    node.textContent = message;
    node.className = 'admin-status' + (kind ? ` status-${kind}` : '');
  }

  function empty(list, title, message) {
    const block = element(list.tagName === 'UL' ? 'li' : 'div', 'admin-empty');
    block.append(element('strong', '', title), element('p', '', message));
    list.replaceChildren(block);
  }

  function loadError(id, error, retry) {
    status(id, error.message, 'error');
    const button = element('button', 'admin-text-button', 'Try again');
    button.type = 'button';
    button.addEventListener('click', retry);
    byId(id).append(' ', button);
  }

  async function api(path, options = {}) {
    let response;
    try {
      response = await fetch(path, {
        credentials: 'same-origin', cache: 'no-store', ...options,
        headers: {
          Accept: 'application/json',
          ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
          ...(options.method && options.method !== 'GET' ? { 'X-CSRF-Token': csrfToken } : {})
        }
      });
    } catch {
      throw new Error('Could not reach the server. Check your connection and try again.');
    }
    if (response.status === 401) {
      window.location.replace('/');
      throw new Error('Your session has expired. Please log in again.');
    }
    const result = await response.json().catch(() => {
      throw new Error('The server returned an unexpected response. Please try again.');
    });
    if (!response.ok) {
      throw Object.assign(new Error(response.status === 403
        ? 'Your session could not be verified. Reload the page and try again.'
        : result.error || 'The request could not be completed.'), { status: response.status });
    }
    return result;
  }

  function renderUsers() {
    const query = byId('userSearch').value.trim().toLowerCase();
    const matches = users.filter(user => user.Email.toLowerCase().includes(query));
    userList.replaceChildren();
    for (const user of matches) {
      const row = element('li', 'admin-user-row');
      const details = element('div');
      details.append(element('strong', 'admin-user-email', user.Email),
        element('span', 'admin-user-role', 'Faculty · Administrator'));
      row.append(details);
      if (user.isCurrentUser) {
        row.append(element('span', 'admin-you', 'You'));
      } else {
        const button = element('button', 'admin-delete-user', 'Delete');
        button.type = 'button';
        button.setAttribute('aria-label', `Delete ${user.Email}`);
        button.addEventListener('click', () => openDeleteUser(user));
        row.append(button);
      }
      userList.append(row);
    }
    status('usersStatus', '');
    if (!matches.length) empty(userList, query ? 'No matching users' : 'No faculty users',
      query ? 'Try another email address.' : 'Add a faculty email above to get started.');
  }

  async function loadUsers() {
    const version = ++userVersion;
    userList.setAttribute('aria-busy', 'true');
    status('usersStatus', 'Loading faculty users…');
    try {
      const result = await api('/api/admin/users');
      if (version !== userVersion) return;
      users = result;
      renderUsers();
    } catch (error) {
      if (version === userVersion) loadError('usersStatus', error, loadUsers);
    } finally {
      if (version === userVersion) userList.setAttribute('aria-busy', 'false');
    }
  }

  function reviewState(project) {
    return project.Approved ? 'Approved' : 'Pending';
  }

  function projectCard(project) {
    const card = element('article', 'admin-project-card');
    const heading = element('div', 'admin-card-heading');
    const state = project.IsPublic ? 'Public' : 'Private';
    heading.append(element('h3', '', project.ProjectName),
      element('span', `admin-badge ${state.toLowerCase()}`, state));
    card.append(heading, element('p', 'admin-project-description', project.ProjectDescription));
    const meta = [project.Industry, project.Keywords].filter(Boolean).join(' · ');
    if (meta) card.append(element('p', 'admin-project-meta', meta));
    const button = element('button', 'admin-text-button', 'View details →');
    button.type = 'button';
    button.setAttribute('aria-label', `View ${project.ProjectName}`);
    button.addEventListener('click', () => openProject(project));
    card.append(button);
    return card;
  }

  async function loadProjects() {
    const version = ++projectVersion;
    const query = byId('adminProjectSearch').value.trim();
    projectList.setAttribute('aria-busy', 'true');
    status('adminProjectsStatus', 'Loading projects…');
    try {
      const projects = await api(`/api/admin/projects?status=approved&search=${encodeURIComponent(query)}`);
      if (version !== projectVersion) return;
      projectList.replaceChildren(...projects.map(projectCard));
      projectList.scrollTop = 0;
      byId('projectCount').textContent = projects.length;
      status('adminProjectsStatus', `${projects.length} ${projects.length === 1 ? 'project' : 'projects'}${query ? ' found' : ' in the collection'}.`);
      if (!projects.length) empty(projectList, query ? 'No matching projects' : 'No approved projects yet',
        query ? 'Try a different title, industry, or keyword.' : 'Accepted submissions will appear here.');
    } catch (error) {
      if (version === projectVersion) {
        projectList.replaceChildren();
        byId('projectCount').textContent = '—';
        loadError('adminProjectsStatus', error, loadProjects);
      }
    } finally {
      if (version === projectVersion) projectList.setAttribute('aria-busy', 'false');
    }
  }

  async function loadPending() {
    const version = ++pendingVersion;
    requestList.setAttribute('aria-busy', 'true');
    status('requestsStatus', 'Loading requests…');
    try {
      const projects = await api('/api/admin/projects?status=pending');
      if (version !== pendingVersion) return;
      requestList.replaceChildren();
      for (const project of projects) {
        const row = element('li');
        const button = element('button', 'admin-request-card');
        button.type = 'button';
        button.append(element('span', 'admin-request-title', project.ProjectName),
          element('span', 'admin-request-meta', project.Industry || 'Student submission'),
          element('span', 'admin-review-link', 'Review request →'));
        button.addEventListener('click', () => openProject(project, true));
        row.append(button);
        requestList.append(row);
      }
      byId('requestCount').textContent = projects.length;
      status('requestsStatus', projects.length
        ? `${projects.length} ${projects.length === 1 ? 'submission needs' : 'submissions need'} review.` : '');
      if (!projects.length) empty(requestList, 'No pending requests', 'New submissions will appear here for review.');
    } catch (error) {
      if (version === pendingVersion) {
        requestList.replaceChildren();
        byId('requestCount').textContent = '—';
        loadError('requestsStatus', error, loadPending);
      }
    } finally {
      if (version === pendingVersion) requestList.setAttribute('aria-busy', 'false');
    }
  }

  function detailSection(title) {
    const section = element('section', 'admin-detail-section');
    section.append(element('h3', '', title));
    return section;
  }

  function externalLink(label, url, className = '') {
    const link = element('a', className, label);
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  }

  function renderDetails(project) {
    const details = byId('requestDetails');
    details.replaceChildren();
    const fields = element('dl', 'admin-detail-fields');
    for (const [label, value] of [['Visibility', project.Approved && project.IsPublic ? 'Public' : 'Private'], ['Industry', project.Industry || 'Not specified']]) {
      const field = element('div');
      field.append(element('dt', '', label), element('dd', '', value));
      fields.append(field);
    }
    const abstract = detailSection('Project abstract');
    abstract.append(element('p', 'admin-abstract', project.ProjectDescription || 'No abstract provided.'));
    details.append(fields, abstract);
    if (project.keywords?.length) {
      const keywords = detailSection('Keywords');
      const tags = element('div', 'admin-tags');
      tags.append(...project.keywords.map(keyword => element('span', '', keyword)));
      keywords.append(tags);
      details.append(keywords);
    }
    const team = detailSection('Team members');
    for (const contact of project.contacts || []) {
      const card = element('div', 'admin-contact-card');
      card.append(element('h4', '', contact.contactName || 'Team member'),
        element('p', 'admin-contact-privacy', contact.contactPublic ? 'Contact details visible publicly' : 'Contact details private · faculty only'));
      if (contact.contactEmail) card.append(element('p', '', `Email: ${contact.contactEmail}`));
      if (contact.contactPhone) card.append(element('p', '', `Phone: ${contact.contactPhone}`));
      for (const [label, url] of [['LinkedIn', contact.contactLinkedin], ['GitHub', contact.contactGithub]]) {
        if (/^https?:\/\//i.test(url || '')) card.append(externalLink(label, url));
      }
      team.append(card);
    }
    if (!project.contacts?.length) team.append(element('p', '', 'No team contact details provided.'));
    details.append(team);
    const documents = detailSection('Project document');
    for (const pdf of project.pdfs || []) {
      documents.append(externalLink(pdf.PDFOriginalName || 'View project PDF',
        `/api/projects/${encodeURIComponent(project.ProjectID)}/pdf`, 'admin-document-link'));
    }
    if (!project.pdfs?.length) documents.append(element('p', '', 'No PDF attached.'));
    details.append(documents);
  }

  function showDialog(dialog) {
    document.body.classList.add('admin-dialog-open');
    if (!dialog.open) dialog.showModal();
  }

  function showProjectView(detail) {
    clearPdfSelection();
    selectedProject = detail;
    projectMode = 'view';
    editBaseline = null;
    byId('requestTitle').textContent = detail.ProjectName;
    byId('requestEyebrow').textContent = reviewingRequest && !detail.Approved ? 'Pending request' : 'Project details';
    byId('requestDetails').hidden = false;
    projectEditForm.hidden = true;
    renderDetails(detail);
    const review = reviewingRequest && !detail.Approved;
    byId('requestActions').hidden = !review;
    byId('projectActions').hidden = review;
    byId('projectActionNote').hidden = true;
    byId('cancelProjectAction').hidden = true;
    byId('saveProject').hidden = true;
    byId('editProject').hidden = false;
    byId('deleteProject').hidden = false;
    byId('deleteProject').textContent = 'Delete Project';
  }

  async function openProject(project, forReview = false) {
    clearPdfSelection();
    const version = ++detailVersion;
    selectedProject = null;
    reviewingRequest = forReview;
    projectMode = 'view';
    resetDecision();
    byId('requestTitle').textContent = project.ProjectName;
    byId('requestEyebrow').textContent = reviewState(project) === 'Pending' ? 'Pending request' : 'Project details';
    byId('requestDetails').replaceChildren();
    byId('requestActions').hidden = true;
    byId('projectActions').hidden = true;
    projectEditForm.hidden = true;
    byId('requestDetails').hidden = false;
    status('requestStatus', 'Loading submission details…');
    showDialog(requestDialog);
    byId('requestTitle').focus();
    try {
      const detail = await api(`/api/admin/projects/${encodeURIComponent(project.ProjectID)}`);
      if (version !== detailVersion || !requestDialog.open) return;
      showProjectView(detail);
      status('requestStatus', '');
    } catch (error) {
      if (version === detailVersion && requestDialog.open) loadError('requestStatus', error, () => openProject(project, forReview));
    }
  }

  function setProjectBusy(busy) {
    savingProject = busy;
    byId('closeRequest').disabled = busy;
    for (const control of requestDialog.querySelectorAll('#projectManagement input, #projectActions button, #projectEditForm input, #projectEditForm textarea, #projectEditForm button')) {
      control.disabled = busy;
    }
    byId('addProjectContact').disabled = busy || byId('editContacts').children.length >= 20;
  }

  function unavailableProject() {
    selectedProject = null;
    byId('projectActions').hidden = true;
    projectEditForm.hidden = true;
    byId('requestDetails').hidden = false;
    byId('requestDetails').replaceChildren();
  }

  async function refreshSavedProject(project, message) {
    try {
      const detail = await api(`/api/admin/projects/${encodeURIComponent(project.ProjectID)}`);
      showProjectView(detail);
      status('requestStatus', message, 'success');
    } catch (error) {
      unavailableProject();
      loadError('requestStatus', new Error(`${message} The updated details could not be loaded. ${error.message}`), () => openProject(project));
    }
    await Promise.all([loadProjects(), loadPending()]);
  }

  function updateVisibilityHint() {
    byId('projectVisibilityHint').textContent = byId('projectPublic').checked
      ? 'Public: visible to everyone after saving.'
      : 'Private: visible only to faculty after saving.';
  }

  function showCurrentPdf(project) {
    const current = byId('currentProjectPdf');
    current.replaceChildren(element('span', '', 'Current PDF: '));
    if (!project.pdfs?.length) {
      current.append('No PDF attached.');
      return;
    }
    for (const [index, pdf] of project.pdfs.entries()) {
      if (index) current.append(', ');
      current.append(externalLink(pdf.PDFOriginalName || 'View project PDF',
        `/api/projects/${encodeURIComponent(project.ProjectID)}/pdf`));
    }
  }

  function clearPdfSelection() {
    ++pdfSelectionVersion;
    projectPdfInput.value = '';
    projectPdfInput.removeAttribute('aria-invalid');
    byId('clearProjectPdf').hidden = true;
    status('projectPdfStatus', '');
  }

  async function replacementPdfError(file) {
    if (!file) return '';
    if (!/\.pdf$/i.test(file.name)) return 'Choose a PDF file.';
    if (file.size > 10 * 1024 * 1024) return 'PDF files must be 10 MB or smaller.';
    if (file.name.length > 225) return 'The PDF filename must be 225 characters or fewer.';
    try {
      if (await file.slice(0, 5).text() !== '%PDF-') return 'Choose a valid PDF file.';
    } catch {
      return 'This file could not be read. Please choose it again.';
    }
    return '';
  }

  function showPdfError(message) {
    status('projectPdfStatus', message, message ? 'error' : '');
    if (message) projectPdfInput.setAttribute('aria-invalid', 'true');
    else projectPdfInput.removeAttribute('aria-invalid');
  }

  const contactFields = [
    ['contactName', 'Name', 150, 'text'], ['contactEmail', 'Email', 100, 'email'],
    ['contactPhone', 'Phone', 14, 'tel'], ['contactLinkedin', 'LinkedIn', 500, 'text'],
    ['contactGithub', 'GitHub', 500, 'text']
  ];

  function updateContactLabels() {
    Array.from(byId('editContacts').children).forEach((group, index) => {
      group.querySelector('legend').textContent = `Team member ${index + 1}`;
      group.querySelector('button').setAttribute('aria-label', `Remove team member ${index + 1}`);
    });
    byId('addProjectContact').disabled = byId('editContacts').children.length >= 20;
  }

  function addContactFields(contact = {}) {
    const group = element('fieldset', 'admin-edit-contact');
    const sequence = ++contactSequence;
    group.append(element('legend'));
    const fields = element('div', 'admin-edit-contact-fields');
    for (const [name, label, maxLength, type] of contactFields) {
      const field = element('div', 'admin-edit-field');
      const input = element('input', 'admin-input');
      input.id = `editContact${sequence}-${name}`;
      input.dataset.field = name;
      input.type = type;
      input.maxLength = maxLength;
      input.value = contact[name] || '';
      const caption = element('label', '', label);
      caption.htmlFor = input.id;
      field.append(caption, input);
      fields.append(field);
    }
    const visibility = element('label', 'admin-switch');
    const toggle = element('input');
    toggle.type = 'checkbox';
    toggle.dataset.field = 'contactPublic';
    toggle.setAttribute('role', 'switch');
    toggle.checked = contact.contactPublic === true;
    const track = element('span', 'admin-switch-track');
    track.setAttribute('aria-hidden', 'true');
    visibility.append(toggle, track, element('span', '', 'Public contact information'));
    const remove = element('button', 'admin-text-button', 'Remove team member');
    remove.type = 'button';
    remove.addEventListener('click', () => {
      group.remove();
      updateContactLabels();
      byId('addProjectContact').focus();
    });
    group.append(fields, visibility, remove);
    byId('editContacts').append(group);
    updateContactLabels();
    return group;
  }

  function editValues() {
    return {
      isPublic: byId('projectPublic').checked,
      projectTitle: byId('editProjectTitle').value.trim(),
      projectAbstract: byId('editProjectAbstract').value.trim(),
      projectIndustry: byId('editProjectIndustry').value.trim(),
      projectTags: byId('editProjectTags').value.trim(),
      contacts: Array.from(byId('editContacts').children).map(group => {
        const contact = {};
        for (const input of group.querySelectorAll('[data-field]')) {
          contact[input.dataset.field] = input.type === 'checkbox' ? input.checked : input.value.trim();
        }
        return contact;
      })
    };
  }

  function startProjectEdit() {
    if (!selectedProject || savingProject) return;
    projectMode = 'edit';
    byId('requestDetails').hidden = true;
    projectEditForm.hidden = false;
    clearPdfSelection();
    showCurrentPdf(selectedProject);
    byId('requestEyebrow').textContent = 'Edit project';
    byId('projectPublic').checked = selectedProject.IsPublic;
    updateVisibilityHint();
    byId('editProjectTitle').value = selectedProject.ProjectName || '';
    byId('editProjectAbstract').value = selectedProject.ProjectDescription || '';
    byId('editProjectIndustry').value = selectedProject.Industry || '';
    byId('editProjectTags').value = (selectedProject.keywords || []).join(', ');
    byId('editContacts').replaceChildren();
    for (const contact of selectedProject.contacts || []) addContactFields(contact);
    for (const input of projectEditForm.querySelectorAll('[aria-invalid]')) input.removeAttribute('aria-invalid');
    updateContactLabels();
    editBaseline = editValues();
    status('requestStatus', '');
    status('projectEditStatus', '');
    byId('projectActionNote').hidden = true;
    byId('deleteProject').hidden = true;
    byId('editProject').hidden = true;
    byId('cancelProjectAction').hidden = false;
    byId('saveProject').hidden = false;
    byId('editProjectTitle').focus();
  }

  function validateProjectEdit(values) {
    for (const input of projectEditForm.querySelectorAll('input, textarea')) {
      input.removeAttribute('aria-invalid');
      if ((input.required && !input.value.trim()) || !input.validity.valid) {
        const label = input.labels?.[0]?.textContent || 'This field';
        status('projectEditStatus', input.required && !input.value.trim()
          ? `${label} is required.` : `Enter a valid ${label.toLowerCase()}.`, 'error');
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        return false;
      }
    }
    const tags = values.projectTags.split(',').map(tag => tag.trim()).filter(Boolean);
    if (new Set(tags.map(tag => tag.toLowerCase())).size > 20 || tags.some(tag => tag.length > 100)) {
      status('projectEditStatus', 'Use up to 20 keywords, with no more than 100 characters each.', 'error');
      byId('editProjectTags').focus();
      return false;
    }
    const emptyContact = values.contacts.findIndex(contact => !contactFields.some(([name]) => contact[name]));
    if (emptyContact !== -1) {
      status('projectEditStatus', `Add a contact detail for team member ${emptyContact + 1}, or remove that team member.`, 'error');
      byId('editContacts').children[emptyContact].querySelector('input').focus();
      return false;
    }
    return true;
  }

  async function saveProjectEdit(event) {
    event.preventDefault();
    if (!selectedProject || savingProject || projectMode !== 'edit') return;
    const values = editValues();
    if (!validateProjectEdit(values)) return;
    const replacementPdf = projectPdfInput.files[0];
    // Send only fields changed by this editor; preserve unrelated visibility/contact changes.
    const changes = Object.fromEntries(Object.entries(values).filter(([key, value]) =>
      JSON.stringify(value) !== JSON.stringify(editBaseline[key])));
    const hasFieldChanges = Object.keys(changes).length > 0;
    if (!hasFieldChanges && !replacementPdf) {
      await openProject(selectedProject, reviewingRequest);
      if (selectedProject) {
        status('requestStatus', 'No changes to save.');
        byId('editProject').focus();
      }
      return;
    }
    const project = selectedProject;
    let fieldsSaved = false;
    let invalidPdf = false;
    let uploadingPdf = false;
    setProjectBusy(true);
    status('projectEditStatus', replacementPdf ? 'Checking replacement PDF…' : 'Saving changes…');
    try {
      const pdfError = await replacementPdfError(replacementPdf);
      if (pdfError) {
        invalidPdf = true;
        showPdfError(pdfError);
        status('projectEditStatus', '');
        return;
      }
      showPdfError('');
      if (hasFieldChanges) {
        status('projectEditStatus', 'Saving project fields…');
        await api(`/api/admin/projects/${encodeURIComponent(project.ProjectID)}`, {
          method: 'PATCH', body: JSON.stringify(changes)
        });
        fieldsSaved = true;
        // A failed PDF upload can be retried without overwriting these fields again.
        editBaseline = values;
      }
      if (replacementPdf) {
        uploadingPdf = true;
        status('projectEditStatus', 'Uploading replacement PDF…');
        const upload = new FormData();
        upload.append('projectFile', replacementPdf);
        await api(`/api/admin/projects/${encodeURIComponent(project.ProjectID)}/pdf`, {
          method: 'PUT', body: upload
        });
        clearPdfSelection();
      }
      await refreshSavedProject(project, replacementPdf ? 'Project changes saved and PDF replaced.' : 'Project changes saved.');
    } catch (error) {
      status('projectEditStatus', fieldsSaved
        ? `Project fields were saved, but the PDF upload did not complete successfully. ${error.message} You can retry Save Changes for the PDF.`
        : error.message, 'error');
      if (uploadingPdf) showPdfError(error.message);
      if (error.status === 404) {
        unavailableProject();
        status('requestStatus', error.message, 'error');
        await Promise.all([loadProjects(), loadPending()]);
      } else if (fieldsSaved) {
        try {
          selectedProject = await api(`/api/admin/projects/${encodeURIComponent(project.ProjectID)}`);
          byId('requestTitle').textContent = selectedProject.ProjectName;
          showCurrentPdf(selectedProject);
        } catch {
          // Keep the editor available; Cancel always reloads the server's current details.
        }
        await Promise.all([loadProjects(), loadPending()]);
      }
    } finally {
      setProjectBusy(false);
      if (requestDialog.open && selectedProject) {
        (invalidPdf ? projectPdfInput : projectMode === 'view' ? byId('editProject') : byId('saveProject')).focus();
      }
    }
  }

  async function deleteSelectedProject() {
    if (!selectedProject || savingProject) return;
    if (projectMode !== 'delete') {
      projectMode = 'delete';
      byId('projectActionNote').textContent = 'Permanently delete this project, its team information, and its PDF? This cannot be undone.';
      byId('projectActionNote').hidden = false;
      byId('deleteProject').textContent = 'Permanently Delete';
      byId('editProject').hidden = true;
      byId('cancelProjectAction').hidden = false;
      byId('cancelProjectAction').focus();
      return;
    }
    const project = selectedProject;
    setProjectBusy(true);
    status('requestStatus', 'Deleting project…');
    try {
      await api(`/api/admin/projects/${encodeURIComponent(project.ProjectID)}`, { method: 'DELETE' });
      requestDialog.close();
      await Promise.all([loadProjects(), loadPending()]);
      byId('adminProjectSearch').focus();
    } catch (error) {
      status('requestStatus', error.message, 'error');
      if (error.status === 404) {
        unavailableProject();
        await Promise.all([loadProjects(), loadPending()]);
      }
    } finally {
      setProjectBusy(false);
    }
  }

  function resetDecision() {
    confirmingDenial = false;
    byId('denyRequest').textContent = 'Deny Request';
    byId('acceptRequest').hidden = false;
    byId('cancelDenyRequest').hidden = true;
    byId('requestDecisionNote').textContent = 'Accept to publish this project. Denying permanently deletes the submission and its PDF.';
  }

  async function decideProject(decision) {
    if (!selectedProject || savingDecision) return;
    if (decision === 'deny' && !confirmingDenial) {
      confirmingDenial = true;
      byId('requestDecisionNote').textContent = 'Permanently delete this submission and its PDF? This cannot be undone.';
      byId('denyRequest').textContent = 'Permanently Delete';
      byId('acceptRequest').hidden = true;
      byId('cancelDenyRequest').hidden = false;
      byId('cancelDenyRequest').focus();
      return;
    }
    savingDecision = true;
    const project = selectedProject;
    for (const id of ['acceptRequest', 'denyRequest', 'cancelDenyRequest', 'closeRequest']) byId(id).disabled = true;
    status('requestStatus', decision === 'accept' ? 'Accepting submission…' : 'Deleting submission…');
    try {
      const path = `/api/admin/projects/${encodeURIComponent(project.ProjectID)}${decision === 'deny' ? '?pendingOnly=true' : ''}`;
      await api(path, decision === 'accept'
        ? { method: 'PATCH', body: JSON.stringify({ approved: true }) }
        : { method: 'DELETE' });
      requestDialog.close();
      await Promise.all([loadProjects(), loadPending()]);
      byId('adminProjectSearch').focus();
    } catch (error) {
      status('requestStatus', error.message, 'error');
      if (error.status === 409 || error.status === 404) {
        selectedProject = null;
        byId('requestActions').hidden = true;
        await Promise.all([loadProjects(), loadPending()]);
      }
    } finally {
      savingDecision = false;
      for (const id of ['acceptRequest', 'denyRequest', 'cancelDenyRequest', 'closeRequest']) byId(id).disabled = false;
    }
  }

  function openDeleteUser(user) {
    selectedUser = user;
    byId('deleteUserMessage').textContent = `Delete ${user.Email}? This removes their administrator access to Capstone Street.`;
    status('deleteUserStatus', '');
    showDialog(deleteDialog);
  }

  async function deleteUser() {
    if (!selectedUser || deletingUser) return;
    deletingUser = true;
    const user = selectedUser;
    for (const id of ['confirmDeleteUser', 'cancelDeleteUser', 'closeDeleteUser']) byId(id).disabled = true;
    status('deleteUserStatus', 'Deleting faculty user…');
    try {
      await api(`/api/admin/users/${encodeURIComponent(user.AccountID)}`, { method: 'DELETE' });
      deleteDialog.close();
      status('userActionStatus', `${user.Email} was removed.`, 'success');
      await loadUsers();
      byId('userSearch').focus();
    } catch (error) {
      status('deleteUserStatus', error.message, 'error');
    } finally {
      deletingUser = false;
      for (const id of ['confirmDeleteUser', 'cancelDeleteUser', 'closeDeleteUser']) byId(id).disabled = false;
    }
  }

  addForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (addButton.disabled) return;
    const email = facultyEmail.value.trim();
    if (!email || email.length > 100 || facultyEmail.validity.typeMismatch || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      status('userActionStatus', email
        ? 'Enter a valid email address of 100 characters or fewer.'
        : 'Enter a faculty email address.', 'error');
      facultyEmail.setAttribute('aria-invalid', 'true');
      facultyEmail.focus();
      return;
    }
    facultyEmail.removeAttribute('aria-invalid');
    addButton.disabled = true;
    status('userActionStatus', 'Adding faculty user…');
    try {
      const user = await api('/api/admin/users', {
        method: 'POST', body: JSON.stringify({ email })
      });
      addForm.reset();
      byId('userSearch').value = '';
      status('userActionStatus', `${user.Email} now has administrator access.`, 'success');
      await loadUsers();
      facultyEmail.focus();
    } catch (error) {
      status('userActionStatus', error.message, 'error');
      if ([400, 409].includes(error.status)) facultyEmail.setAttribute('aria-invalid', 'true');
    } finally {
      addButton.disabled = false;
    }
  });

  facultyEmail.addEventListener('input', () => facultyEmail.removeAttribute('aria-invalid'));
  byId('userSearch').addEventListener('input', renderUsers);
  byId('adminProjectSearchForm').addEventListener('submit', event => {
    event.preventDefault();
    clearTimeout(searchTimer);
    loadProjects();
  });
  byId('adminProjectSearch').addEventListener('input', () => {
    // Invalidate an older search immediately, even before the debounce expires.
    ++projectVersion;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadProjects, 250);
  });
  byId('acceptRequest').addEventListener('click', () => decideProject('accept'));
  byId('projectPublic').addEventListener('change', updateVisibilityHint);
  projectPdfInput.addEventListener('change', async () => {
    const version = ++pdfSelectionVersion;
    const file = projectPdfInput.files[0];
    byId('clearProjectPdf').hidden = !file;
    showPdfError('');
    const error = await replacementPdfError(file);
    if (version === pdfSelectionVersion && projectMode === 'edit') showPdfError(error);
  });
  byId('clearProjectPdf').addEventListener('click', () => {
    clearPdfSelection();
    projectPdfInput.focus();
  });
  byId('editProject').addEventListener('click', startProjectEdit);
  byId('deleteProject').addEventListener('click', deleteSelectedProject);
  projectEditForm.addEventListener('submit', saveProjectEdit);
  byId('addProjectContact').addEventListener('click', () => {
    if (savingProject || byId('editContacts').children.length >= 20) return;
    addContactFields().querySelector('input').focus();
  });
  byId('cancelProjectAction').addEventListener('click', () => {
    if (!selectedProject || savingProject) return;
    openProject(selectedProject, reviewingRequest);
  });
  byId('denyRequest').addEventListener('click', () => decideProject('deny'));
  byId('cancelDenyRequest').addEventListener('click', () => {
    resetDecision();
    byId('denyRequest').focus();
  });
  byId('closeRequest').addEventListener('click', () => requestDialog.close());
  byId('confirmDeleteUser').addEventListener('click', deleteUser);
  for (const id of ['cancelDeleteUser', 'closeDeleteUser']) byId(id).addEventListener('click', () => deleteDialog.close());
  requestDialog.addEventListener('cancel', event => { if (savingDecision || savingProject) event.preventDefault(); });
  deleteDialog.addEventListener('cancel', event => { if (deletingUser) event.preventDefault(); });
  requestDialog.addEventListener('close', () => {
    ++detailVersion;
    selectedProject = null;
    editBaseline = null;
    projectMode = 'view';
    clearPdfSelection();
    projectEditForm.reset();
    byId('editContacts').replaceChildren();
    byId('requestDetails').replaceChildren();
  });
  deleteDialog.addEventListener('close', () => { selectedUser = null; });
  for (const dialog of [requestDialog, deleteDialog]) {
    dialog.addEventListener('close', () => document.body.classList.remove('admin-dialog-open'));
  }

  async function initialize() {
    try {
      status('dashboardStatus', '');
      const session = await api('/api/auth/session');
      if (!session.authenticated || !session.csrfToken) {
        window.location.replace('/');
        return;
      }
      csrfToken = session.csrfToken;
      addButton.disabled = false;
      await Promise.all([loadUsers(), loadProjects(), loadPending()]);
    } catch (error) {
      loadError('dashboardStatus', error, initialize);
      for (const id of ['usersStatus', 'adminProjectsStatus', 'requestsStatus']) status(id, 'Waiting for a verified session.');
      for (const list of [userList, projectList, requestList]) list.setAttribute('aria-busy', 'false');
    }
  }

  initialize();
})();
