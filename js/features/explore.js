/* Depende de: config.js (db); state.js (currentUser, profilesCache, searchTimer,
   explorePostsCache, explorePage, EXPLORE_PAGE_SIZE, exploreLoading, exploreHasMore);
   utils.js (createAvatarNode, setCachedProfile, prefetchUserProfile, bindSmartPrefetch,
   ogCache, POST_SELECT_FIELDS, PROFILE_MINI_FIELDS)
   En tiempo de ejecución usa funciones de otros módulos: openPostDetail (feed.js),
   openPublicProfile (profile.js)
   Expone: loadExploreGrid, loadMoreExploreGrid, handleExploreSearchFocus,
   handleExploreSearchInput, resetExploreSearch, switchSearchTab, executeAdvancedSearch */

let exploreObserverInitialized = false;

function buildExploreGridItem(post) {
 const item = document.createElement('div');
 item.className = 'explore-grid-item';
 item.onclick = () => openPostDetail(post);
 if (post.image_url) {
  const img = document.createElement('img');
  img.src = post.image_url;
  img.loading = 'lazy';
  img.decoding = 'async';
  item.append(img);
 } else {
  item.textContent = (post.content || '').slice(0, 45);
 }
 const badge = document.createElement('div');
 badge.className = 'explore-grid-badge';
 badge.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg> <span data-post-views="${post.id}">${post.views || 0}</span>`;
 item.append(badge);
 return item;
}

function renderExplorePostsToGrid(posts, grid, reset = true) {
 if (!grid) return;
 if (!posts || !posts.length) {
  if (reset) grid.replaceChildren();
  return;
 }
 const fragment = document.createDocumentFragment();
 posts.forEach(post => fragment.append(buildExploreGridItem(post)));
 if (reset) grid.replaceChildren(fragment);
 else grid.append(fragment);
}

function ensureExploreScrollObserver() {
 if (exploreObserverInitialized || !('IntersectionObserver' in window)) return;
 const grid = document.getElementById('exploreGrid');
 if (!grid || !grid.parentElement) return;
 exploreObserverInitialized = true;

 const sentinel = document.createElement('div');
 sentinel.id = 'exploreScrollSentinel';
 sentinel.style.height = '1px';
 grid.parentElement.append(sentinel);

 const observer = new IntersectionObserver(entries => {
  for (const entry of entries) {
   if (entry.isIntersecting && document.getElementById('explore')?.classList.contains('active') && document.getElementById('exploreDefaultView')?.classList.contains('active')) {
    loadMoreExploreGrid();
   }
  }
 }, { root: null, rootMargin: '400px 0px', threshold: 0 });
 observer.observe(sentinel);
}

async function loadExploreGrid() {
 const grid = document.getElementById('exploreGrid');
 if (!grid) return;
 ensureExploreScrollObserver();

 explorePage = 0;
 exploreHasMore = true;

 if (!explorePostsCache) {
  const cached = ogCache.get('explore_posts', 1000 * 60 * 30);
  if (Array.isArray(cached) && cached.length > 0) explorePostsCache = cached;
 }
 if (Array.isArray(explorePostsCache) && explorePostsCache.length > 0) {
  renderExplorePostsToGrid(explorePostsCache, grid, true);
 }

 if (exploreLoading) return;
 exploreLoading = true;
 try {
  const { data: posts } = await db.from('posts')
   .select(POST_SELECT_FIELDS)
   .order('created_at', { ascending: false })
   .range(0, EXPLORE_PAGE_SIZE - 1);

  if (!posts || posts.length < EXPLORE_PAGE_SIZE) exploreHasMore = false;
  if (posts && posts.length > 0) {
   explorePostsCache = posts;
   ogCache.set('explore_posts', posts);
   renderExplorePostsToGrid(posts, grid, true);
  }
 } finally {
  exploreLoading = false;
 }
}

async function loadMoreExploreGrid() {
 if (exploreLoading || !exploreHasMore) return;
 exploreLoading = true;
 explorePage++;
 const from = explorePage * EXPLORE_PAGE_SIZE;
 const to = from + EXPLORE_PAGE_SIZE - 1;

 try {
  const { data: posts } = await db.from('posts')
   .select(POST_SELECT_FIELDS)
   .order('created_at', { ascending: false })
   .range(from, to);

  if (!posts || posts.length < EXPLORE_PAGE_SIZE) exploreHasMore = false;
  if (posts && posts.length > 0) {
   explorePostsCache = (explorePostsCache || []).concat(posts);
   renderExplorePostsToGrid(posts, document.getElementById('exploreGrid'), false);
  }
 } finally {
  exploreLoading = false;
 }
}

function handleExploreSearchFocus() {
 const val = document.getElementById('search').value.trim();
 if (val.length >= 1) {
  document.getElementById('searchCategoriesBar').classList.add('active');
  document.getElementById('exploreDefaultView').classList.remove('active');
  document.getElementById('exploreSearchResultsView').classList.add('active');
 }
}

function handleExploreSearchInput() {
 clearTimeout(searchTimer);
 const val = document.getElementById('search').value.trim();
 const catBar = document.getElementById('searchCategoriesBar');
 const defaultView = document.getElementById('exploreDefaultView');
 const resultsView = document.getElementById('exploreSearchResultsView');

 if (val.length === 0) {
  resetExploreSearch();
  return;
 }

 catBar.classList.add('active');
 defaultView.classList.remove('active');
 resultsView.classList.add('active');

 searchTimer = setTimeout(() => executeAdvancedSearch(val), 250);
}

function resetExploreSearch() {
 document.getElementById('searchCategoriesBar').classList.remove('active');
 document.getElementById('exploreDefaultView').classList.add('active');
 document.getElementById('exploreSearchResultsView').classList.remove('active');
 document.getElementById('searchForYouResults').replaceChildren();
 document.getElementById('searchProfilesResults').replaceChildren();
}

function switchSearchTab(tabKey, btnElement) {
 document.querySelectorAll('.search-cat-tab').forEach(b => b.classList.remove('active'));
 btnElement.classList.add('active');
 document.querySelectorAll('.search-tab-content').forEach(c => { c.style.display = 'none'; });
 const targetTab = document.getElementById(`searchTab-${tabKey}`);
 if (targetTab) targetTab.style.display = 'block';
}

async function executeAdvancedSearch(queryText) {
 const query = queryText.toLowerCase();

 const [profilesRes, postsRes] = await Promise.all([
  db.from('og_profiles')
   .select(PROFILE_MINI_FIELDS)
   .or(`username.ilike.%${query}%,display_name.ilike.%${query}%`)
   .limit(15),
  db.from('posts')
   .select(POST_SELECT_FIELDS)
   .ilike('content', `%${query}%`)
   .order('created_at', { ascending: false })
   .limit(18)
 ]);

 const profilesData = profilesRes.data;
 const profilesContainer = document.getElementById('searchProfilesResults');
 profilesContainer.replaceChildren();

 if (!profilesData || !profilesData.length) {
  profilesContainer.innerHTML = '<div class="activity-empty">No se encontraron perfiles.</div>';
 } else {
  const profileFragment = document.createDocumentFragment();
  profilesData.forEach(profile => {
   if (profile.id === currentUser?.id) return;
   setCachedProfile(profile, false);
   const item = document.createElement('div');
   item.className = 'public-user';
   item.style.padding = '8px 16px';
   item.append(createAvatarNode(profile, false));
   const info = document.createElement('div');
   info.className = 'public-user-info';
   info.innerHTML = `<strong>${profile.display_name || profile.username}</strong><small>@${profile.username}</small>`;
   item.append(info);
   item.onclick = () => openPublicProfile(profile.id);
   bindSmartPrefetch(item, () => prefetchUserProfile(profile.id));
   profileFragment.append(item);
  });
  profilesContainer.replaceChildren(profileFragment);
 }

 const postsData = postsRes.data;
 const forYouContainer = document.getElementById('searchForYouResults');
 forYouContainer.replaceChildren();

 if (!postsData || !postsData.length) {
  forYouContainer.innerHTML = '<div class="activity-empty" style="grid-column: span 3;">No hay publicaciones relacionadas.</div>';
 } else {
  const postsFragment = document.createDocumentFragment();
  postsData.forEach(post => {
   const item = document.createElement('div');
   item.className = 'explore-grid-item';
   item.onclick = () => openPostDetail(post);
   if (post.image_url) {
    const img = document.createElement('img');
    img.src = post.image_url;
    img.loading = 'lazy';
    img.decoding = 'async';
    item.append(img);
   } else {
    item.textContent = (post.content || '').slice(0, 45);
   }
   postsFragment.append(item);
  });
  forYouContainer.replaceChildren(postsFragment);
 }
}
