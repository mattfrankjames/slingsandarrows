const netlifyIdentity = window.netlifyIdentity;

netlifyIdentity.init({ APIUrl: 'https://slingsandarrows.band/.netlify/identity' });

const authGate        = document.getElementById('auth-gate');
const composerPanel   = document.getElementById('composer-panel');
const userEmailEl     = document.getElementById('user-email');
const loginBtn        = document.getElementById('login-btn');
const logoutBtn       = document.getElementById('logout-btn');
const postForm        = document.getElementById('post-form');
const submitBtn       = document.getElementById('submit-btn');
const statusMsg       = document.getElementById('status-msg');
const installBanner   = document.getElementById('install-banner');
const installBtn      = document.getElementById('install-btn');
const installDismiss  = document.getElementById('install-dismiss');
const imageInput      = document.getElementById('post-image');
const imagePreviewWrap = document.getElementById('image-preview-wrap');
const previewImg      = document.getElementById('preview-img');
const removeImageBtn  = document.getElementById('remove-image-btn');
const uploadStatus    = document.getElementById('upload-status');

// Tracks the Cloudinary URL from a successful upload
let pendingImageUrl = null;

function setAuthUI(user) {
  if (user) {
    authGate.hidden = true;
    composerPanel.hidden = false;
    userEmailEl.textContent = user.email;
  } else {
    authGate.hidden = false;
    composerPanel.hidden = true;
    userEmailEl.textContent = '';
  }
}

setAuthUI(netlifyIdentity.currentUser());

netlifyIdentity.on('login', user => {
  setAuthUI(user);
  netlifyIdentity.close();
});

netlifyIdentity.on('logout', () => setAuthUI(null));

loginBtn.addEventListener('click', () => netlifyIdentity.open('login'));
logoutBtn.addEventListener('click', () => netlifyIdentity.logout());

// Image upload
async function uploadToCloudinary(file) {
  const cloudName   = process.env.CLOUDINARY_CLOUD_NAME;
  const uploadPreset = process.env.CLOUDINARY_UPLOAD_PRESET;

  const formData = new FormData();
  formData.append('file', file);
  formData.append('upload_preset', uploadPreset);

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
    { method: 'POST', body: formData }
  );
  if (!res.ok) throw new Error('Upload failed');
  const data = await res.json();
  return data.secure_url;
}

function clearImageState() {
  pendingImageUrl = null;
  imageInput.value = '';
  imagePreviewWrap.hidden = true;
  previewImg.src = '';
  uploadStatus.className = '';
  uploadStatus.textContent = '';
}

imageInput.addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;

  uploadStatus.className = 'uploading';
  uploadStatus.textContent = 'Uploading photo…';
  imagePreviewWrap.hidden = true;
  pendingImageUrl = null;

  try {
    const url = await uploadToCloudinary(file);
    pendingImageUrl = url;
    previewImg.src = url;
    imagePreviewWrap.hidden = false;
    uploadStatus.className = '';
    uploadStatus.textContent = '';
  } catch {
    uploadStatus.className = 'error';
    uploadStatus.textContent = 'Photo upload failed — you can still publish without one.';
  }
});

removeImageBtn.addEventListener('click', clearImageState);

// Form submit
postForm.addEventListener('submit', async e => {
  e.preventDefault();

  const title = document.getElementById('post-title').value;
  const body  = document.getElementById('post-body').value;

  submitBtn.disabled = true;
  statusMsg.className = '';
  statusMsg.textContent = 'Publishing…';

  try {
    const user  = netlifyIdentity.currentUser();
    const token = await user.jwt();

    const res = await fetch('/api/create-post', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ title, body, imageUrl: pendingImageUrl || '' }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Unknown error');
    }

    statusMsg.className = 'success';
    statusMsg.textContent = 'Post published!';
    postForm.reset();
    clearImageState();
  } catch (err) {
    statusMsg.className = 'error';
    statusMsg.textContent = `Error: ${err.message}`;
  } finally {
    submitBtn.disabled = false;
  }
});

// PWA install prompt
let deferredPrompt = null;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPrompt = e;
  installBanner.hidden = false;
});

installBtn.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  if (outcome === 'accepted') installBanner.hidden = true;
  deferredPrompt = null;
});

installDismiss.addEventListener('click', () => {
  installBanner.hidden = true;
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(new URL('../sw.js', import.meta.url), { scope: '/' })
    .catch(err => console.warn('SW registration failed:', err));
}
