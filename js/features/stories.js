/* Depende de: config.js (db); state.js (currentUser, myProfile, profilesCache, myActiveStories,
   storiesByUserMap, currentStoryGroupProfile, currentStoryGroupList, currentStoryGroupIndex,
   currentActiveStoryId, mediaStream, capturedBlob, currentFacingMode, currentZoom,
   isUploadingStory); utils.js (timeAgo, setAvatarContent, setPreviewBlobUrl,
   revokePreviewBlobUrl, compressImageBlob, createAvatarNode, setCachedProfile, ogCache)
   En tiempo de ejecución usa funciones de otros módulos: showAuthOverlay (auth.js)
   Expone: renderProgressSegments (también la usa highlights.js), loadStoriesData,
   updateStoryUI, handleStoryClick, openUserStoriesSequence, renderCurrentStorySlide,
   nextStorySlide, prevStorySlide, toggleStoryLikeAction, sendStoryReply, closeStoryViewer,
   openCameraModal, adjustZoom, startCameraStream, switchCamera, closeCameraModal,
   showCapturedPreview, takePhoto, handleGallerySelect, uploadCapturedStory
   Registra: gestos táctiles del visor de historias y liberación de cámara al ocultar pestaña */

const preloadedStoryUrls = new Set();

function preloadStoryImageUrl(url) {
 if (!url || preloadedStoryUrls.has(url)) return;
 try {
  const raw = localStorage.getItem('og_user_settings_' + (currentUser?.id || 'guest'));
  const prefs = raw ? JSON.parse(raw) : {};
  if (prefs.dataSaver === true) return;
 } catch (e) {}
 preloadedStoryUrls.add(url);
 const img = new Image();
 img.decoding = 'async';
 img.src = url;
}

function renderProgressSegments(containerId, totalCount, activeIndex) {
 const container = document.getElementById(containerId);
 if (!container) return;
 container.replaceChildren();
 if (!totalCount || totalCount <= 0) return;

 const fragment = document.createDocumentFragment();
 for (let i = 0; i < totalCount; i++) {
  const seg = document.createElement('div');
  seg.className = 'story-progress-segment';
  if (i < activeIndex) seg.classList.add('completed');
  else if (i === activeIndex) seg.classList.add('active');

  const fill = document.createElement('div');
  fill.className = 'story-progress-fill';
  seg.append(fill);
  fragment.append(seg);
 }
 container.replaceChildren(fragment);
}

async function loadStoriesData() {
 if (!currentUser) return;
 const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

 const { data: followingRes } = await db.from('follows').select('following_id').eq('follower_id', currentUser.id);
 const followingIds = (followingRes || []).map(f => f.following_id);
 const allowedUserIds = [...new Set([...followingIds, currentUser.id])];

 const { data: storiesData } = await db.from('stories')
  .select('id, user_id, image_url, created_at')
  .in('user_id', allowedUserIds)
  .gte('created_at', twentyFourHoursAgo)
  .order('created_at', { ascending: true });

 storiesByUserMap = {};
 (storiesData || []).forEach(s => {
  if (!storiesByUserMap[s.user_id]) storiesByUserMap[s.user_id] = [];
  storiesByUserMap[s.user_id].push(s);
 });

 myActiveStories = storiesByUserMap[currentUser.id] || [];

 const container = document.getElementById('storiescontainer');
 const fragment = document.createDocumentFragment();

 const myDiv = document.createElement('div');
 myDiv.className = myActiveStories.length > 0 ? 'story has-story' : 'story';
 myDiv.onclick = handleStoryClick;

 const avatarWrapper = document.createElement('div');
 avatarWrapper.className = 'story-avatar-container';

 const avatarInner = document.createElement('div');
 avatarInner.className = 'story-avatar-inner';
 if (myProfile?.avatar_url) {
  const img = document.createElement('img');
  img.src = myProfile.avatar_url;
  img.alt = 'Tu historia';
  img.decoding = 'async';
  avatarInner.append(img);
 } else {
  avatarInner.textContent = '👤';
 }
 avatarWrapper.append(avatarInner);

 const plusBadge = document.createElement('div');
 plusBadge.className = 'story-plus-badge';
 plusBadge.textContent = '+';
 plusBadge.title = 'Agregar nueva historia';
 plusBadge.onclick = e => {
  e.stopPropagation();
  openCameraModal();
 };
 avatarWrapper.append(plusBadge);

 myDiv.append(avatarWrapper, document.createTextNode('Tu historia'));
 fragment.append(myDiv);

 const otherUserIdsWithStories = Object.keys(storiesByUserMap).filter(uid => uid !== currentUser.id && storiesByUserMap[uid].length > 0);
 const missing = otherUserIdsWithStories.filter(id => !profilesCache[id]);
 if (missing.length > 0) {
  const { data: profs } = await db.from('og_profiles').select('id, username, avatar_url').in('id', missing);
  (profs || []).forEach(p => setCachedProfile(p, false));
 }

 otherUserIdsWithStories.forEach((uid, idx) => {
  const profile = profilesCache[uid];
  const userStories = storiesByUserMap[uid];
  if (!profile || !userStories || !userStories.length) return;

  // Precarga progresiva de la primera historia de los primeros 3 usuarios visibles
  if (idx < 3 && userStories[0]?.image_url) {
   preloadStoryImageUrl(userStories[0].image_url);
  }

  const sDiv = document.createElement('div');
  sDiv.className = 'story has-story';
  sDiv.onclick = () => openUserStoriesSequence(profile, userStories, 0);
  sDiv.append(createAvatarNode(profile, true));

  const lbl = document.createElement('div');
  lbl.textContent = profile.username;
  sDiv.append(lbl);
  fragment.append(sDiv);
 });

 container.replaceChildren(fragment);
}

function updateStoryUI() { loadStoriesData(); }

async function handleStoryClick() {
 if (!currentUser) { showAuthOverlay(); return; }
 if (myActiveStories && myActiveStories.length > 0) {
  openUserStoriesSequence(myProfile, myActiveStories, 0);
 } else {
  openCameraModal();
 }
}

function openUserStoriesSequence(profile, storiesArray, startIndex = 0) {
 const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;
 const validStories = (storiesArray || []).filter(s => new Date(s.created_at).getTime() >= twentyFourHoursAgo);

 if (!validStories.length) {
  alert('Esta historia ha expirado.');
  closeStoryViewer();
  loadStoriesData();
  return;
 }

 currentStoryGroupProfile = profile;
 currentStoryGroupList = validStories;
 currentStoryGroupIndex = Math.max(0, Math.min(startIndex, validStories.length - 1));

 renderCurrentStorySlide();
 document.getElementById('storyViewer').classList.add('active');
}

function renderCurrentStorySlide() {
 const story = currentStoryGroupList[currentStoryGroupIndex];
 if (!story || !currentStoryGroupProfile) return;

 currentActiveStoryId = story.id;
 renderProgressSegments('storyProgressBars', currentStoryGroupList.length, currentStoryGroupIndex);

 document.getElementById('storyUsername').textContent = '@' + currentStoryGroupProfile.username;
 document.getElementById('storyImage').src = story.image_url;
 document.getElementById('storyTimeAgo').textContent = timeAgo(story.created_at);
 setAvatarContent(document.getElementById('storyViewerAvatarInner'), currentStoryGroupProfile.avatar_url);
 document.getElementById('storyLikeBtn')?.classList.remove('liked');

 const addToHighlightTrigger = document.getElementById('storyAddToHighlightTrigger');
 addToHighlightTrigger.style.display = (currentUser && currentStoryGroupProfile.id === currentUser.id) ? 'inline-flex' : 'none';

 // Precargar el siguiente slide en segundo plano
 const nextStory = currentStoryGroupList[currentStoryGroupIndex + 1];
 if (nextStory?.image_url) {
  preloadStoryImageUrl(nextStory.image_url);
 }
}

function nextStorySlide() {
 if (!currentStoryGroupList.length) return;
 if (currentStoryGroupIndex < currentStoryGroupList.length - 1) {
  currentStoryGroupIndex++;
  renderCurrentStorySlide();
 } else {
  closeStoryViewer();
 }
}

function prevStorySlide() {
 if (!currentStoryGroupList.length) return;
 if (currentStoryGroupIndex > 0) {
  currentStoryGroupIndex--;
  renderCurrentStorySlide();
 } else {
  renderCurrentStorySlide();
 }
}

function toggleStoryLikeAction() {
 const btn = document.getElementById('storyLikeBtn');
 if (btn) btn.classList.toggle('liked');
}

function sendStoryReply() {
 document.getElementById('storyReplyInput').value = '';
 alert('Mensaje enviado.');
}

function closeStoryViewer() {
 currentActiveStoryId = null;
 currentStoryGroupList = [];
 currentStoryGroupIndex = 0;
 document.getElementById('storyViewer').classList.remove('active');
}

/* Gestos táctiles y toque en Visor de Historias (con deduplicación táctil/clic) */
(function initStoryViewerGestures() {
 const area = document.getElementById('storyContentAreaContainer');
 if (!area) return;
 let startX = 0;
 let startY = 0;
 let lastTouchEnd = 0;

 area.addEventListener('touchstart', e => {
  startX = e.changedTouches[0].clientX;
  startY = e.changedTouches[0].clientY;
 }, { passive: true });

 area.addEventListener('touchend', e => {
  lastTouchEnd = Date.now();
  const endX = e.changedTouches[0].clientX;
  const endY = e.changedTouches[0].clientY;
  const diffX = endX - startX;
  const diffY = endY - startY;

  if (Math.abs(diffY) > 90 && diffY > Math.abs(diffX)) {
   closeStoryViewer();
   return;
  }

  if (Math.abs(diffX) > 40 && Math.abs(diffX) > Math.abs(diffY)) {
   if (diffX < 0) nextStorySlide();
   else prevStorySlide();
   return;
  }

  const rect = area.getBoundingClientRect();
  const tapX = endX - rect.left;
  if (tapX < rect.width * 0.35) prevStorySlide();
  else nextStorySlide();
 }, { passive: true });

 area.addEventListener('click', e => {
  if (Date.now() - lastTouchEnd < 400) return;
  const rect = area.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  if (clickX < rect.width * 0.35) prevStorySlide();
  else nextStorySlide();
 });
})();

/* Cámara */
function stopCameraTracks() {
 if (mediaStream) {
  mediaStream.getTracks().forEach(t => t.stop());
  mediaStream = null;
 }
 const video = document.getElementById('cameraVideo');
 if (video && video.srcObject) {
  video.srcObject = null;
 }
}

document.addEventListener('visibilitychange', () => {
 if (document.hidden && mediaStream) {
  stopCameraTracks();
 }
});

async function openCameraModal() {
 if (!currentUser) { showAuthOverlay(); return; }
 capturedBlob = null;
 revokePreviewBlobUrl(document.getElementById('capturedImagePreview'));
 document.getElementById('capturedImagePreview').style.display = 'none';
 document.getElementById('cameraVideo').style.display = 'block';
 document.getElementById('captureBtn').style.display = 'block';
 document.getElementById('publishStoryBtn').style.display = 'none';
 document.getElementById('publishStoryBtn').disabled = false;
 document.getElementById('publishStoryBtn').textContent = 'Compartir en tu historia';
 document.getElementById('cameraModal').classList.add('active');
 await startCameraStream();
}

function adjustZoom(val) {
 currentZoom = parseFloat(val);
 document.getElementById('zoomValueText').textContent = currentZoom.toFixed(1) + 'x';
 document.getElementById('cameraVideo').style.transform = `scale(${currentZoom})`;
}

async function startCameraStream() {
 stopCameraTracks();
 try {
  mediaStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: currentFacingMode }, audio: false });
  const v = document.getElementById('cameraVideo');
  v.srcObject = mediaStream;
  await v.play();
 } catch (e) {}
}

async function switchCamera() {
 currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
 await startCameraStream();
}

function closeCameraModal() {
 stopCameraTracks();
 capturedBlob = null;
 revokePreviewBlobUrl(document.getElementById('capturedImagePreview'));
 document.getElementById('cameraModal').classList.remove('active');
}

function showCapturedPreview(blob) {
 capturedBlob = blob;
 const previewImg = document.getElementById('capturedImagePreview');
 setPreviewBlobUrl(previewImg, blob);
 previewImg.style.display = 'block';
 document.getElementById('cameraVideo').style.display = 'none';
 document.getElementById('captureBtn').style.display = 'none';
 document.getElementById('publishStoryBtn').style.display = 'block';
 stopCameraTracks();
}

function takePhoto() {
 const video = document.getElementById('cameraVideo');
 const canvas = document.createElement('canvas');
 canvas.width = video.videoWidth || 720;
 canvas.height = video.videoHeight || 1280;
 canvas.getContext('2d').drawImage(video, 0, 0);
 canvas.toBlob(blob => showCapturedPreview(blob), 'image/jpeg', 0.85);
}

async function handleGallerySelect(input) {
 const file = input.files?.[0];
 if (!file) return;
 input.value = '';
 const compressed = await compressImageBlob(file, 1080, 0.82);
 showCapturedPreview(compressed);
}

async function uploadCapturedStory() {
 if (!currentUser || !capturedBlob || isUploadingStory) return;
 isUploadingStory = true;
 const pubBtn = document.getElementById('publishStoryBtn');
 pubBtn.disabled = true;
 pubBtn.textContent = 'Subiendo historia...';

 try {
  const uniqueSuffix = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const path = `${currentUser.id}/story-${uniqueSuffix}.jpg`;

  const { error: uploadError } = await db.storage.from('og-media').upload(path, capturedBlob, {
   contentType: 'image/jpeg',
   upsert: false
  });
  if (uploadError) throw uploadError;

  const { data: urlData } = db.storage.from('og-media').getPublicUrl(path);
  const { error: insertError } = await db.from('stories').insert({
   user_id: currentUser.id,
   image_url: urlData.publicUrl
  });
  if (insertError) throw insertError;

  capturedBlob = null;
  closeCameraModal();
  await loadStoriesData();
 } catch (e) {
  alert('No se pudo subir la historia. Intentá nuevamente.');
  pubBtn.disabled = false;
  pubBtn.textContent = 'Compartir en tu historia';
 } finally {
  isUploadingStory = false;
 }
}
