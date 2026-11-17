// ==========================================
// MÓDULO LOORS - ÖG
// ==========================================
// Ajustá la ruta de importación según dónde tengas tu cliente de Supabase en ÖG
import { supabase } from './supabase.js';

let currentUser = null;
let activeLoorIdForComments = null;
let viewedLoorsSession = new Set();
let videoObserver = null;

/**
 * Inicializa la sección LOORS y sus eventos
 */
export async function initLoors() {
  const { data: { session } } = await supabase.auth.getSession();
  currentUser = session?.user || null;

  supabase.auth.onAuthStateChange((_event, session) => {
    currentUser = session?.user || null;
  });

  bindLoorsUIEvents();
}

/**
 * Abre la sección LOORS, carga los videos y activa el autoplay
 */
export async function openLoorsSection() {
  const section = document.getElementById('loors-section');
  if (!section) return;
  section.classList.add('active');
  await loadLoorsFeed();
}

/**
 * Cierra la sección LOORS y pausa cualquier video en reproducción
 */
export function closeLoorsSection() {
  const section = document.getElementById('loors-section');
  if (!section) return;
  section.classList.remove('active');
  document.querySelectorAll('.loor-video').forEach(video => video.pause());
}

/**
 * Carga todos los LOORS desde Supabase junto con perfiles, likes, comentarios y guardados
 */
export async function loadLoorsFeed() {
  const container = document.getElementById('loors-feed-container');
  if (!container) return;

  container.innerHTML = `<div style="color:#fff;text-align:center;margin-top:45vh;">Cargando LOORS...</div>`;

  // 1. Obtener loors ordenados por más recientes
  const { data: loors, error } = await supabase
    .from('loors')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error cargando loors:', error);
    container.innerHTML = `<div style="color:#fff;text-align:center;margin-top:45vh;">Error al cargar videos.</div>`;
    return;
  }

  if (!loors || loors.length === 0) {
    container.innerHTML = `
      <div style="color:#fff;text-align:center;margin-top:40vh;padding:0 24px;">
        <p style="font-size:1.1rem;font-weight:700;margin-bottom:8px;">Aún no hay LOORS</p>
        <p style="font-size:0.9rem;opacity:0.75;margin-bottom:16px;">Sé el primero en subir un video vertical a ÖG.</p>
        <button class="loor-submit-btn" style="background:#fff;color:#000;" onclick="document.getElementById('loors-upload-modal').classList.add('open')">Subir primer Loor</button>
      </div>`;
    return;
  }

  // 2. Obtener perfiles de creadores, likes, comentarios, guardados y seguidos en paralelo
  const userIds = [...new Set(loors.map(l => l.user_id))];
  const loorIds = loors.map(l => l.id);

  const [profilesRes, likesRes, commentsRes, savesRes, followsRes] = await Promise.all([
    supabase.from('profiles').select('id, username, full_name, avatar_url').in('id', userIds),
    supabase.from('loor_likes').select('loor_id, user_id').in('loor_id', loorIds),
    supabase.from('loor_comments').select('loor_id').in('loor_id', loorIds),
    currentUser
      ? supabase.from('loor_saves').select('loor_id').eq('user_id', currentUser.id)
      : Promise.resolve({ data: [] }),
    currentUser
      ? supabase.from('follows').select('following_id').eq('follower_id', currentUser.id)
      : Promise.resolve({ data: [] })
  ]);

  const profilesMap = new Map((profilesRes.data || []).map(p => [p.id, p]));
  const allLikes = likesRes.data || [];
  const allComments = commentsRes.data || [];
  const savedSet = new Set((savesRes.data || []).map(s => s.loor_id));
  const followingSet = new Set((followsRes.data || []).map(f => f.following_id));

  container.innerHTML = '';

  loors.forEach(loor => {
    const creator = profilesMap.get(loor.user_id) || {
      username: 'usuario_og',
      avatar_url: 'assets/default-avatar.png'
    };

    const loorLikes = allLikes.filter(lk => lk.loor_id === loor.id);
    const isLiked = currentUser ? loorLikes.some(lk => lk.user_id === currentUser.id) : false;
    const commentsCount = allComments.filter(c => c.loor_id === loor.id).length;
    const isSaved = savedSet.has(loor.id);
    const isFollowing = followingSet.has(loor.user_id);
    const isOwnVideo = currentUser && currentUser.id === loor.user_id;

    const hashtagsFormatted = (loor.hashtags || [])
      .map(tag => (tag.startsWith('#') ? tag : `#${tag}`))
      .join(' ');

    const card = document.createElement('article');
    card.className = 'loor-item';
    card.dataset.loorId = loor.id;

    card.innerHTML = `
      <video class="loor-video" src="${loor.video_url}" playsinline loop preload="metadata"></video>
      <div class="loor-pause-indicator">❚❚</div>

      <div class="loor-overlay-wrapper">
        <!-- Barra lateral derecha -->
        <div class="loor-actions-bar">
          <button class="loor-action-btn btn-like ${isLiked ? 'liked' : ''}" data-id="${loor.id}" aria-label="Me gusta">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
            </svg>
            <span class="loor-action-count like-count">${loorLikes.length}</span>
          </button>

          <button class="loor-action-btn btn-comment" data-id="${loor.id}" aria-label="Comentarios">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
            </svg>
            <span class="loor-action-count comment-count">${commentsCount}</span>
          </button>

          <button class="loor-action-btn btn-save ${isSaved ? 'saved' : ''}" data-id="${loor.id}" aria-label="Guardar">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
            </svg>
            <span class="loor-action-count">${isSaved ? 'Guardado' : 'Guardar'}</span>
          </button>

          <button class="loor-action-btn btn-share" data-id="${loor.id}" data-url="${loor.video_url}" data-desc="${escapeHtml(loor.description)}" aria-label="Compartir">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
            </svg>
            <span class="loor-action-count">Compartir</span>
          </button>
        </div>

        <!-- Información inferior izquierda -->
        <div class="loor-info-panel">
          <div class="loor-creator-row">
            <div class="loor-creator-link" data-user-id="${loor.user_id}">
              <img class="loor-avatar" src="${creator.avatar_url || 'assets/default-avatar.png'}" alt="${escapeHtml(creator.username)}">
              <span class="loor-username">@${escapeHtml(creator.username)}</span>
            </div>
            ${!isOwnVideo ? `
              <button class="loor-follow-btn ${isFollowing ? 'following' : ''}" data-creator-id="${loor.user_id}">
                ${isFollowing ? 'Siguiendo' : 'Seguir'}
              </button>
            ` : ''}
          </div>

          ${loor.description ? `<p class="loor-description">${escapeHtml(loor.description)}</p>` : ''}
          ${hashtagsFormatted ? `<p class="loor-hashtags">${escapeHtml(hashtagsFormatted)}</p>` : ''}

          <div class="loor-meta-row">
            <div class="loor-audio-pill">
              <span>🎵</span>
              <span>${escapeHtml(loor.audio_name || 'Audio original')}</span>
            </div>
            <span class="loor-views-text">👁️ <b class="views-number">${loor.views_count || 0}</b> reproducciones</span>
          </div>
        </div>
      </div>
    `;

    // Pausar / Reanudar al tocar el video
    const videoEl = card.querySelector('.loor-video');
    videoEl.addEventListener('click', () => {
      if (videoEl.paused) {
        videoEl.play();
        card.classList.remove('paused');
      } else {
        videoEl.pause();
        card.classList.add('paused');
      }
    });

    // Acceso al perfil del creador (conectado a tu sistema existente de ÖG)
    card.querySelector('.loor-creator-link').addEventListener('click', () => {
      closeLoorsSection();
      // Si en ÖG usás openUserProfile(userId) o similar, se invoca aquí:
      if (typeof window.openUserProfile === 'function') {
        window.openUserProfile(loor.user_id);
      } else {
        window.dispatchEvent(new CustomEvent('og:navigate-profile', { detail: { userId: loor.user_id } }));
      }
    });

    container.appendChild(card);
  });

  setupAutoplayObserver();
}

/**
 * Configura IntersectionObserver para autoplay y contador de vistas
 */
function setupAutoplayObserver() {
  if (videoObserver) videoObserver.disconnect();

  const options = {
    root: document.getElementById('loors-feed-container'),
    threshold: 0.75
  };

  videoObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const card = entry.target;
      const video = card.querySelector('.loor-video');
      const loorId = card.dataset.loorId;

      if (entry.isIntersecting) {
        video.play().then(() => {
          card.classList.remove('paused');
        }).catch(() => {
          // Si el navegador bloquea autoplay con sonido, intenta silenciado
          video.muted = true;
          video.play();
        });

        // Contabilizar reproducción 1 vez por sesión
        if (!viewedLoorsSession.has(loorId)) {
          viewedLoorsSession.add(loorId);
          incrementViews(loorId, card);
        }
      } else {
        video.pause();
        video.currentTime = 0;
      }
    });
  }, options);

  document.querySelectorAll('.loor-item').forEach(item => videoObserver.observe(item));
}

async function incrementViews(loorId, card) {
  const { error } = await supabase.rpc('increment_loor_views', { target_loor_id: loorId });
  if (!error) {
    const numEl = card.querySelector('.views-number');
    if (numEl) numEl.textContent = parseInt(numEl.textContent || '0', 10) + 1;
  }
}

/**
 * Eventos delegados para Likes, Comentarios, Favoritos, Seguir, Compartir y Subida
 */
function bindLoorsUIEvents() {
  const feed = document.getElementById('loors-feed-container');
  if (!feed) return;

  feed.addEventListener('click', async (e) => {
    // 1. ME GUSTA
    const likeBtn = e.target.closest('.btn-like');
    if (likeBtn) {
      if (!requireAuth()) return;
      const loorId = likeBtn.dataset.id;
      const countEl = likeBtn.querySelector('.like-count');
      let count = parseInt(countEl.textContent, 10);

      if (likeBtn.classList.contains('liked')) {
        likeBtn.classList.remove('liked');
        countEl.textContent = Math.max(0, count - 1);
        await supabase.from('loor_likes').delete().match({ loor_id: loorId, user_id: currentUser.id });
      } else {
        likeBtn.classList.add('liked');
        countEl.textContent = count + 1;
        await supabase.from('loor_likes').insert({ loor_id: loorId, user_id: currentUser.id });
      }
      return;
    }

    // 2. GUARDAR EN FAVORITOS
    const saveBtn = e.target.closest('.btn-save');
    if (saveBtn) {
      if (!requireAuth()) return;
      const loorId = saveBtn.dataset.id;
      const labelEl = saveBtn.querySelector('.loor-action-count');

      if (saveBtn.classList.contains('saved')) {
        saveBtn.classList.remove('saved');
        labelEl.textContent = 'Guardar';
        await supabase.from('loor_saves').delete().match({ loor_id: loorId, user_id: currentUser.id });
      } else {
        saveBtn.classList.add('saved');
        labelEl.textContent = 'Guardado';
        await supabase.from('loor_saves').insert({ loor_id: loorId, user_id: currentUser.id });
      }
      return;
    }

    // 3. COMENTARIOS
    const commentBtn = e.target.closest('.btn-comment');
    if (commentBtn) {
      activeLoorIdForComments = commentBtn.dataset.id;
      openCommentsModal(activeLoorIdForComments);
      return;
    }

    // 4. COMPARTIR
    const shareBtn = e.target.closest('.btn-share');
    if (shareBtn) {
      const shareData = {
        title: 'Mirá este Loor en ÖG',
        text: shareBtn.dataset.desc || 'Video en ÖG LOORS',
        url: window.location.origin + '?loor=' + shareBtn.dataset.id
      };
      if (navigator.share) {
        try { await navigator.share(shareData); } catch (_) {}
      } else {
        await navigator.clipboard.writeText(shareData.url);
        alert('Enlace del Loor copiado al portapapeles');
      }
      return;
    }

    // 5. SEGUIR AL CREADOR
    const followBtn = e.target.closest('.loor-follow-btn');
    if (followBtn) {
      if (!requireAuth()) return;
      const creatorId = followBtn.dataset.creatorId;
      if (followBtn.classList.contains('following')) {
        followBtn.classList.remove('following');
        followBtn.textContent = 'Seguir';
        await supabase.from('follows').delete().match({ follower_id: currentUser.id, following_id: creatorId });
      } else {
        followBtn.classList.add('following');
        followBtn.textContent = 'Siguiendo';
        await supabase.from('follows').insert({ follower_id: currentUser.id, following_id: creatorId });
      }
    }
  });

  // Formulario de nuevo comentario
  const commentForm = document.getElementById('loor-comment-form');
  if (commentForm) {
    commentForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!requireAuth() || !activeLoorIdForComments) return;
      const input = document.getElementById('loor-comment-input');
      const content = input.value.trim();
      if (!content) return;

      input.value = '';
      const { error } = await supabase.from('loor_comments').insert({
        loor_id: activeLoorIdForComments,
        user_id: currentUser.id,
        content
      });

      if (!error) {
        await openCommentsModal(activeLoorIdForComments);
        // Actualizar contador en tarjeta
        const card = document.querySelector(`.loor-item[data-loor-id="${activeLoorIdForComments}"] .comment-count`);
        if (card) card.textContent = parseInt(card.textContent, 10) + 1;
      }
    });
  }

  // Formulario de subida de video desde galería
  const uploadForm = document.getElementById('loor-upload-form');
  if (uploadForm) {
    uploadForm.addEventListener('submit', handleUploadLoor);
  }
}

async function openCommentsModal(loorId) {
  const modal = document.getElementById('loors-comments-modal');
  const list = document.getElementById('loor-comments-list');
  modal.classList.add('open');
  list.innerHTML = '<p style="text-align:center;color:#666;">Cargando comentarios...</p>';

  const { data: comments } = await supabase
    .from('loor_comments')
    .select('*')
    .eq('loor_id', loorId)
    .order('created_at', { ascending: true });

  if (!comments || comments.length === 0) {
    list.innerHTML = '<p style="text-align:center;color:#888;margin-top:20px;">Aún no hay comentarios. ¡Escribí el primero!</p>';
    return;
  }

  const userIds = [...new Set(comments.map(c => c.user_id))];
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, username, avatar_url')
    .in('id', userIds);

  const pMap = new Map((profiles || []).map(p => [p.id, p]));

  list.innerHTML = comments.map(c => {
    const u = pMap.get(c.user_id) || { username: 'usuario', avatar_url: 'assets/default-avatar.png' };
    return `
      <div class="loor-comment-item">
        <img src="${u.avatar_url || 'assets/default-avatar.png'}" alt="">
        <div>
          <strong>@${escapeHtml(u.username)}</strong>
          <p style="margin:2px 0 0;">${escapeHtml(c.content)}</p>
        </div>
      </div>
    `;
  }).join('');
}

async function handleUploadLoor(e) {
  e.preventDefault();
  if (!requireAuth()) return;

  const fileInput = document.getElementById('loor-video-file');
  const descInput = document.getElementById('loor-desc-input');
  const tagsInput = document.getElementById('loor-hashtags-input');
  const audioInput = document.getElementById('loor-audio-input');
  const submitBtn = document.getElementById('loor-upload-submit');

  const file = fileInput.files[0];
  if (!file) {
    alert('Seleccioná un video vertical de tu galería.');
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Subiendo video...';

  try {
    const fileExt = file.name.split('.').pop();
    const filePath = `${currentUser.id}/${Date.now()}.${fileExt}`;

    // 1. Subir a Supabase Storage
    const { error: uploadError } = await supabase.storage
      .from('loors_videos')
      .upload(filePath, file, { cacheControl: '3600', upsert: false });

    if (uploadError) throw uploadError;

    // 2. Obtener URL pública
    const { data: publicUrlData } = supabase.storage
      .from('loors_videos')
      .getPublicUrl(filePath);

    // 3. Procesar hashtags
    const hashtagsArray = tagsInput.value
      .split(/[\s,]+/)
      .map(t => t.replace(/^#/, '').trim())
      .filter(Boolean);

    // 4. Guardar registro en base de datos
    const { error: dbError } = await supabase.from('loors').insert({
      user_id: currentUser.id,
      video_url: publicUrlData.publicUrl,
      description: descInput.value.trim(),
      hashtags: hashtagsArray,
      audio_name: audioInput.value.trim() || 'Audio original'
    });

    if (dbError) throw dbError;

    // Resetear y recargar feed
    e.target.reset();
    document.getElementById('loors-upload-modal').classList.remove('open');
    await loadLoorsFeed();
  } catch (err) {
    console.error('Error al publicar Loor:', err);
    alert('No se pudo subir el video: ' + err.message);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Publicar Loor';
  }
}

function requireAuth() {
  if (!currentUser) {
    alert('Iniciá sesión en ÖG para interactuar o subir videos en LOORS.');
    return false;
  }
  return true;
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

