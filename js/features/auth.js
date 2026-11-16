/* Depende de: config.js (db); state.js (currentUser, myProfile, viewedProfile, profilesCache,
   myActiveStories, storiesByUserMap, highlightsCacheByUser, cachedConversationsList,
   cachedActivityEvents, cachedFeedPosts, cachedFollowingIds, explorePostsCache,
   loadedPostIds, renderedMessageIds, prefetchedProfileIds, prefetchedConversationIds,
   prefetchedMessagesByConv, realtimeChannel, dmRealtimeChannel, postsRealtimeChannel,
   presenceChannel); utils.js (status, updateNavAvatarUI, ogCache, setCachedProfile,
   PROFILE_SELECT_FIELDS); core/pwa.js (updatePwaInstallButtonsVisibility);
   core/navigation.js (showTab); core/realtime.js (setupRealtimeNotifications, setupPresenceChannel)
   En tiempo de ejecución usa funciones de features/: updateProfileUI, loadInitialPosts,
   renderPostsToDOM, loadStoriesData, loadHighlights, checkGlobalUnreadMessages, updateStoryUI
   Expone: switchAuthSubView, showAuthOverlay, hideAuthOverlay, hideSplashScreen,
   executeSignUp, executeSignIn, loadAccount, promptLogoutConfirmation,
   closeLogoutConfirmation, executeConfirmedSignOut */

let activeAccountLoadUserId = null;

function switchAuthSubView(viewName) {
 document.getElementById('authWelcomePanel').classList.remove('active');
 document.getElementById('authSignupPanel').classList.remove('active');
 document.getElementById('authSigninPanel').classList.remove('active');
 document.getElementById('authOverlayStatus').textContent = '';

 if (viewName === 'welcome') document.getElementById('authWelcomePanel').classList.add('active');
 if (viewName === 'signup') document.getElementById('authSignupPanel').classList.add('active');
 if (viewName === 'signin') document.getElementById('authSigninPanel').classList.add('active');
}

function showAuthOverlay() {
 document.getElementById('authWelcomeOverlay').classList.add('visible');
 updatePwaInstallButtonsVisibility();
}

function hideAuthOverlay() {
 document.getElementById('authWelcomeOverlay').classList.remove('visible');
}

function hideSplashScreen() {
 const splash = document.getElementById('appSplashScreen');
 if (splash) {
  splash.classList.add('fade-out');
  setTimeout(() => splash.remove(), 300);
 }
}

async function executeSignUp() {
 const email = document.getElementById('regEmail').value.trim();
 const password = document.getElementById('regPassword').value;
 const username = document.getElementById('regUsername').value.trim().toLowerCase();

 if (!email || !password || !username) return status('authOverlayStatus', 'Completá todos los campos.');
 if (!/^[a-z0-9_]{3,20}$/.test(username)) return status('authOverlayStatus', 'Usuario: 3 a 20 caracteres alfanuméricos.');
 if (password.length < 8) return status('authOverlayStatus', 'Contraseña mínima de 8 caracteres.');

 status('authOverlayStatus', 'Creando cuenta...');
 const { data, error } = await db.auth.signUp({
  email,
  password,
  options: { data: { username } }
 });

 if (error) return status('authOverlayStatus', error.message);

 if (data.session) {
  await loadAccount(data.user);
  hideAuthOverlay();
 } else {
  status('authOverlayStatus', '¡Cuenta creada! Ya podés iniciar sesión.');
  setTimeout(() => switchAuthSubView('signin'), 1500);
 }
}

async function executeSignIn() {
 const email = document.getElementById('loginEmail').value.trim();
 const password = document.getElementById('loginPassword').value;

 if (!email || !password) return status('authOverlayStatus', 'Ingresá correo y contraseña.');

 status('authOverlayStatus', 'Iniciando sesión...');
 const { data, error } = await db.auth.signInWithPassword({ email, password });

 if (error) return status('authOverlayStatus', error.message);

 await loadAccount(data.user);
 hideAuthOverlay();
}

async function loadAccount(user) {
 if (!user) return;
 if (activeAccountLoadUserId === user.id && myProfile) return;
 activeAccountLoadUserId = user.id;

 const previousUserId = currentUser?.id;
 if (previousUserId && previousUserId !== user.id) {
  profilesCache = {};
  cachedFeedPosts = null;
  cachedFollowingIds = null;
  cachedConversationsList = null;
  cachedActivityEvents = null;
  highlightsCacheByUser = {};
  explorePostsCache = null;
  loadedPostIds.clear();
  renderedMessageIds.clear();
  prefetchedProfileIds.clear();
  prefetchedConversationIds.clear();
  prefetchedMessagesByConv = {};
 }

 currentUser = user;

 // Hidratar cachés locales del usuario para arranque instantáneo (SWR)
 const cachedProfilesMap = ogCache.getForUser(user.id, 'profiles_map', 1000 * 60 * 60 * 24);
 if (cachedProfilesMap && typeof cachedProfilesMap === 'object') {
  Object.assign(profilesCache, cachedProfilesMap);
 }
 const cachedMyProf = ogCache.getForUser(user.id, 'my_profile', 1000 * 60 * 60 * 24 * 7);
 const cachedFeed = ogCache.getForUser(user.id, 'feed_posts', 1000 * 60 * 60 * 12);
 const cachedFollowing = ogCache.getForUser(user.id, 'following_ids', 1000 * 60 * 60 * 12);
 const cachedConvs = ogCache.getForUser(user.id, 'conversations', 1000 * 60 * 60 * 12);
 const cachedAct = ogCache.getForUser(user.id, 'activity_events', 1000 * 60 * 60 * 12);
 const cachedHl = ogCache.getForUser(user.id, 'highlights_map', 1000 * 60 * 60 * 24);

 if (Array.isArray(cachedFeed) && cachedFeed.length > 0) cachedFeedPosts = cachedFeed;
 if (Array.isArray(cachedFollowing)) cachedFollowingIds = cachedFollowing;
 if (Array.isArray(cachedConvs)) cachedConversationsList = cachedConvs;
 if (Array.isArray(cachedAct)) cachedActivityEvents = cachedAct;
 if (cachedHl && typeof cachedHl === 'object') highlightsCacheByUser = cachedHl;

 const hasInstantCache = !!cachedMyProf;
 if (hasInstantCache) {
  myProfile = cachedMyProf;
  setCachedProfile(cachedMyProf, false);
  hideAuthOverlay();
  updateProfileUI();
  updateNavAvatarUI();
  updatePwaInstallButtonsVisibility();
  if (cachedFeedPosts && cachedFeedPosts.length > 0) {
   renderPostsToDOM(cachedFeedPosts, document.getElementById('posts'), true);
  }
  hideSplashScreen();
 }

 try {
  let { data: profile, error } = await db
   .from('og_profiles')
   .select(PROFILE_SELECT_FIELDS)
   .eq('id', user.id)
   .maybeSingle();

  if (error) {
   console.error('ÖG - Error cargando perfil:', error);
   if (!hasInstantCache) alert('No se pudo cargar tu perfil: ' + error.message);
   return;
  }

  if (!profile) {
   const username = user.user_metadata?.username || ('usuario_' + user.id.slice(0, 8));

   const { data: created, error: createError } = await db
    .from('og_profiles')
    .insert({
     id: user.id,
     username,
     display_name: username
    })
    .select(PROFILE_SELECT_FIELDS)
    .single();

   if (createError) {
    console.error('ÖG - Error creando perfil:', createError);
    if (!hasInstantCache) alert('No se pudo crear tu perfil: ' + createError.message);
    return;
   }

   profile = created;
  }

  myProfile = profile;
  setCachedProfile(profile, true);
  ogCache.setForUser(user.id, 'my_profile', profile);

  hideAuthOverlay();
  updateProfileUI();
  updateNavAvatarUI();
  updatePwaInstallButtonsVisibility();

  await Promise.all([
   loadInitialPosts(),
   loadStoriesData(),
   loadHighlights(user.id, 'highlightsScrollContainer'),
   checkGlobalUnreadMessages()
  ]);

  setupRealtimeNotifications();
  setupPresenceChannel();
 } finally {
  if (activeAccountLoadUserId === user.id) {
   activeAccountLoadUserId = null;
  }
 }
}

function promptLogoutConfirmation() {
 document.getElementById('logoutConfirmModal').classList.add('active');
}

function closeLogoutConfirmation() {
 document.getElementById('logoutConfirmModal').classList.remove('active');
}

async function executeConfirmedSignOut() {
 closeLogoutConfirmation();
 const signingOutUserId = currentUser?.id;

 const { error } = await db.auth.signOut();
 if (error) return alert(error.message);

 if (realtimeChannel) { db.removeChannel(realtimeChannel); realtimeChannel = null; }
 if (dmRealtimeChannel) { db.removeChannel(dmRealtimeChannel); dmRealtimeChannel = null; }
 if (postsRealtimeChannel) { db.removeChannel(postsRealtimeChannel); postsRealtimeChannel = null; }
 if (presenceChannel) { db.removeChannel(presenceChannel); presenceChannel = null; }

 if (signingOutUserId) {
  ogCache.clearForUser(signingOutUserId);
 }

 currentUser = null;
 myProfile = null;
 viewedProfile = null;
 profilesCache = {};
 myActiveStories = [];
 storiesByUserMap = {};
 highlightsCacheByUser = {};
 cachedConversationsList = null;
 cachedActivityEvents = null;
 cachedFeedPosts = null;
 cachedFollowingIds = null;
 explorePostsCache = null;
 loadedPostIds.clear();
 renderedMessageIds.clear();
 prefetchedProfileIds.clear();
 prefetchedConversationIds.clear();
 prefetchedMessagesByConv = {};

 updateStoryUI();
 updateNavAvatarUI();
 updateProfileUI();
 showAuthOverlay();
 showTab('feed');
}
