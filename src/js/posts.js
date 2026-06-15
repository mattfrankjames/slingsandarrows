const feed       = document.getElementById('posts-feed');
const loading    = document.getElementById('loading');
const emptyState = document.getElementById('empty-state');
const errorState = document.getElementById('error-state');

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function renderPost(post) {
  const article = document.createElement('article');
  article.className = 'post-card';
  article.innerHTML = `
    ${post.title ? `<h3 class="post-title">${escapeHtml(post.title)}</h3>` : ''}
    <p class="post-body">${escapeHtml(post.body)}</p>
    <p class="post-meta">${formatDate(post.createdAt)}</p>
  `;
  return article;
}

async function loadPosts() {
  try {
    const res = await fetch('/api/get-posts');
    if (!res.ok) throw new Error(res.statusText);
    const posts = await res.json();

    loading.hidden = true;

    if (posts.length === 0) {
      emptyState.hidden = false;
      return;
    }

    posts.forEach(post => feed.appendChild(renderPost(post)));
  } catch {
    loading.hidden = true;
    errorState.hidden = false;
  }
}

loadPosts();
