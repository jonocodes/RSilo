export const ACCOUNT_CLIENT_SCRIPT = String.raw`
(() => {
  'use strict';

  function submitUpload(button) {
    const folderInput = document.getElementById(button.dataset.folderInput);
    const fileInput = document.getElementById(button.dataset.fileInput);
    const files = fileInput?.files;
    if (!files?.length) {
      alert('Select at least one file');
      return;
    }

    const base = button.dataset.uploadPath || '';
    const subfolder = folderInput?.value.trim() || '';
    const target = subfolder ? (base ? base + '/' + subfolder : subfolder) : base;
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/account/upload/' + target.split('/').map(encodeURIComponent).join('/');
    form.enctype = 'multipart/form-data';

    const input = document.createElement('input');
    input.type = 'file';
    input.name = 'files';
    input.multiple = true;
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(file);
    input.files = transfer.files;
    form.appendChild(input);
    document.body.appendChild(form);
    form.submit();
  }

  for (const button of document.querySelectorAll('[data-upload-path]')) {
    button.addEventListener('click', () => submitUpload(button));
  }

  for (const button of document.querySelectorAll('[data-copy-target]')) {
    button.addEventListener('click', async () => {
      const text = document.getElementById(button.dataset.copyTarget)?.textContent || '';
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = 'Copied';
      } catch {
        button.textContent = 'Copy failed';
      }
      setTimeout(() => { button.textContent = 'Copy'; }, 2000);
    });
  }

  for (const form of document.querySelectorAll('form[data-confirm-message]')) {
    form.addEventListener('submit', (event) => {
      if (!confirm(form.dataset.confirmMessage)) event.preventDefault();
    });
  }

  const editButton = document.getElementById('edit-btn');
  const saveButton = document.getElementById('save-btn');
  const cancelButton = document.getElementById('cancel-btn');
  const view = document.getElementById('view-pre');
  const editor = document.getElementById('edit-area');

  if (editButton && saveButton && cancelButton && view && editor) {
    const original = editor.value;

    editButton.addEventListener('click', () => {
      editor.value = original;
      view.style.display = 'none';
      editor.style.display = 'block';
      editor.style.height = Math.max(400, editor.scrollHeight) + 'px';
      editor.focus();
      editButton.style.display = 'none';
      saveButton.style.display = '';
      cancelButton.style.display = '';
    });

    cancelButton.addEventListener('click', () => {
      editor.value = original;
      editor.style.display = 'none';
      view.style.display = '';
      editButton.style.display = '';
      saveButton.style.display = 'none';
      cancelButton.style.display = 'none';
    });

    saveButton.addEventListener('click', async () => {
      saveButton.textContent = 'Saving…';
      saveButton.disabled = true;
      const form = new FormData();
      form.append('content', editor.value);
      const response = await fetch(saveButton.dataset.savePath, { method: 'POST', body: form });
      if (response.ok || response.redirected) {
        location.reload();
        return;
      }
      alert('Save failed');
      saveButton.textContent = 'Save';
      saveButton.disabled = false;
    });
  }
})();
`;
