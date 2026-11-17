/* ==========================================
   LOORS PERFORMANCE ENGINE (archivo NUEVO)
   Cargar ANTES de loors.js. No depende de Supabase ni de otros módulos.
   Qué hace:
   1) Ventana de videos: solo el Loor activo y sus vecinos tienen el video "conectado" (src).
      Los demás se liberan (se corta la descarga y se libera el decodificador).
   2) Precarga escalonada: el siguiente Loor se prepara recién cuando el actual ya puede
      reproducirse, así un video lento nunca compite con el que se está viendo.
   3) Red adaptativa: navigator.connection (saveData, effectiveType, downlink) y, como
      respaldo para iPhone (que no lo expone), la latencia real de arranque medida.
   4) Un solo IntersectionObserver: reproduce solo el video activo, pausa el resto y
      respeta la pausa manual de la persona.
   5) Arranque anticipado del primer video mientras se cargan perfiles/likes/comentarios.
   6) Preparado para HLS (.m3u8): nativo en iPhone/Safari; en otros navegadores usa hls.js
      solo si la página lo cargó (window.Hls). Sin hls.js, igual intenta el src directo.
   ========================================== */

window.LoorsEngine = (function () {
  'use strict';

  /* Cuántos vecinos se mantienen según la calidad de la conexión.
     gate = estado del video activo que se espera antes de preparar el siguiente
     (3 = canplay, 4 = canplaythrough); waitMs = espera máxima antes de preparar igual. */
  const TIERS = {
    high: { ahead: 2, behind: 1, next: 'auto',     gate: 3, waitMs: 1500 },
    mid:  { ahead: 1, behind: 1, next: 'auto',     gate: 3, waitMs: 4000 },
    low:  { ahead: 1, behind: 0, next: 'metadata', gate: 4, waitMs: 0 },
    none: { ahead: 0, behind: 0, next: 'none',     gate: 4, waitMs: 0 }
  };
  const RANK = { none: 0, low: 1, mid: 2, high: 3 };
  const POSTER_AHEAD = 4;         // miniaturas que se piden por adelantado
  const ACTIVATE_DELAY_MS = 90;   // si el video no estaba preparado, se espera un instante por si la persona sigue deslizando
  const WARM_TTL_MS = 20000;      // un video "calentado" que nadie adoptó se descarta
  const HLS_RE = /\.m3u8(\?|#|$)/i;

  let observer = null;
  let observerRoot = null;
  let cards = [];
  let activeCard = null;
  let activateTimer = 0;
  let pendingAhead = null;
  let startAvg = null;            // latencia media de arranque (ms)
  let hooks = { play: null, pause: null, onActivate: null };

  const info = new WeakMap();     // tarjeta -> { idx, attached, userPaused, v, a, t0, measuring }
  const attached = new Set();     // tarjetas con el video conectado
  const hlsByVideo = new WeakMap();
  const warmed = new Map();       // id del loor -> { v, timer }

  function S(card) {
    let s = info.get(card);
    if (!s) {
      s = { idx: -1, attached: false, userPaused: false, v: null, a: null, t0: 0, measuring: false };
      info.set(card, s);
    }
    if (!s.v) s.v = card.querySelector('.loor-video');
    if (!s.a) s.a = card.querySelector('.loor-audio');
    return s;
  }

  /* ---------- Red ---------- */
  function conn() {
    return navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
  }

  function tierName() {
    let t = 'high';
    const c = conn();
    if (c) {
      const et = c.effectiveType || '';
      if (c.saveData || et === 'slow-2g' || et === '2g') return 'none';
      if (et === '3g') t = 'mid';
      else if (c.downlink && c.downlink < 1.5) t = 'mid';
    }
    if (startAvg != null) {
      const m = startAvg > 3500 ? 'low' : (startAvg > 1800 ? 'mid' : 'high');
      if (RANK[m] < RANK[t]) t = m;
    }
    return t;
  }

  /* Mide cuánto tarda un Loor en empezar a verse desde que se activa */
  function measureStart(card) {
    const s = S(card);
    s.t0 = performance.now();
    if (s.measuring || !s.v) return;
    s.measuring = true;
    const v = s.v;
    v.addEventListener('playing', function onPlaying() {
      v.removeEventListener('playing', onPlaying);
      s.measuring = false;
      const dt = performance.now() - s.t0;
      if (document.hidden || dt > 15000) return;
      startAvg = startAvg == null ? dt : startAvg * 0.5 + dt * 0.5;
    });
  }

  /* ---------- Conectar / liberar el video de una tarjeta ---------- */
  function setSource(v, url, hasPoster) {
    if (HLS_RE.test(url) && !v.canPlayType('application/vnd.apple.mpegurl') && window.Hls && window.Hls.isSupported()) {
      const hls = new window.Hls({ capLevelToPlayerSize: true, maxBufferLength: 12, startLevel: -1 });
      hlsByVideo.set(v, hls);
      hls.loadSource(url);
      hls.attachMedia(v);
      return;
    }
    // Sin miniatura, "#t=0.001" hace que iPhone muestre el primer cuadro en vez de negro
    v.src = (hasPoster || HLS_RE.test(url) || url.indexOf('#') !== -1) ? url : url + '#t=0.001';
  }

  function setPoster(card) {
    const v = S(card).v;
    if (v && v.dataset.poster && !v.getAttribute('poster')) v.setAttribute('poster', v.dataset.poster);
  }

  function attach(card, preload, withAudio) {
    const s = S(card);
    const v = s.v;
    if (!v) return;
    if (!s.attached) {
      const url = v.dataset.src;
      if (!url) return;
      setSource(v, url, !!v.dataset.poster);
      s.attached = true;
      attached.add(card);
    }
    if (preload && preload !== 'none' && v.preload !== preload) v.preload = preload;
    const a = s.a;
    if (a && withAudio && !a.getAttribute('src') && a.dataset.src) {
      a.preload = 'auto';
      a.src = a.dataset.src;
    }
  }

  function detach(card) {
    const s = S(card);
    attached.delete(card);
    if (!s.attached) return;
    s.attached = false;
    const v = s.v;
    if (v) {
      try { v.pause(); } catch (e) {}
      const hls = hlsByVideo.get(v);
      if (hls) { try { hls.destroy(); } catch (e) {} hlsByVideo.delete(v); }
      v.removeAttribute('src');
      v.preload = 'none';
      try { v.load(); } catch (e) {}   // corta la descarga en curso y libera memoria/decodificador
      delete v.dataset.retried;
    }
    const a = s.a;
    if (a && a.getAttribute('src')) {
      try { a.pause(); } catch (e) {}
      a.removeAttribute('src');
      try { a.load(); } catch (e) {}
    }
  }

  /* ---------- Ventana de videos conectados alrededor del activo ---------- */
  function cancelAhead() {
    if (pendingAhead) { pendingAhead.cleanup(); pendingAhead = null; }
  }

  function scheduleAhead() {
    cancelAhead();
    if (!activeCard) return;
    const name = tierName();
    const t = TIERS[name];
    if (!t.ahead) return;
    const card = activeCard;
    const s = S(card);
    const v = s.v;
    const a = s.idx;
    if (!v) return;

    const go = function () {
      cancelAhead();
      if (activeCard !== card) return;
      for (let k = 1; k <= t.ahead; k++) {
        const c = cards[a + k];
        if (!c) break;
        attach(c, k === 1 ? t.next : 'metadata', k === 1 && name !== 'low');
      }
    };

    if (v.readyState >= t.gate) { go(); return; }
    const evt = t.gate === 4 ? 'canplaythrough' : 'canplay';
    v.addEventListener(evt, go, { once: true });
    const timer = t.waitMs ? setTimeout(go, t.waitMs) : 0;
    pendingAhead = { cleanup: function () { v.removeEventListener(evt, go); if (timer) clearTimeout(timer); } };
  }

  function applyWindow() {
    if (!activeCard) return;
    const a = S(activeCard).idx;
    const t = TIERS[tierName()];
    const lo = a - t.behind;
    const hi = a + t.ahead;
    attached.forEach(function (c) {
      const i = S(c).idx;
      if (i < lo || i > hi) detach(c);   // fuera de la ventana: se cancela su descarga
    });
    attach(activeCard, 'auto', true);
    for (let i = Math.max(0, a - 1); i <= Math.min(cards.length - 1, a + POSTER_AHEAD); i++) setPoster(cards[i]);
    scheduleAhead();
  }

  /* ---------- Activar / silenciar ---------- */
  function quiet(card) {
    const s = S(card);
    if (hooks.pause) hooks.pause(card);
    if (s.v && s.attached && s.v.readyState >= 1 && s.v.currentTime > 0.3) { try { s.v.currentTime = 0; } catch (e) {} }
    if (s.a && s.a.getAttribute('src') && s.a.currentTime > 0.3) { try { s.a.currentTime = 0; } catch (e) {} }
    s.userPaused = false;
  }

  function pauseOthers(card) {
    attached.forEach(function (c) {
      if (c === card) return;
      const v = S(c).v;
      if (v && !v.paused && hooks.pause) hooks.pause(c);
    });
  }

  function activate(card) {
    if (card === activeCard) return;
    clearTimeout(activateTimer);
    cancelAhead();
    if (activeCard) quiet(activeCard);
    activeCard = card;
    S(card).userPaused = false;

    const start = function () {
      if (activeCard !== card) return;
      attach(card, 'auto', true);
      measureStart(card);
      pauseOthers(card);
      if (hooks.play) hooks.play(card);
      applyWindow();
      if (hooks.onActivate) hooks.onActivate(card);
    };
    // Ya preparado: arranca al instante. Si no, un respiro corto por si la persona sigue deslizando
    if (S(card).attached) start();
    else activateTimer = setTimeout(start, ACTIVATE_DELAY_MS);
  }

  function leave(card) {
    if (card === activeCard) {
      clearTimeout(activateTimer);
      cancelAhead();
      quiet(card);
      activeCard = null;
    } else if (S(card).attached && hooks.pause) {
      hooks.pause(card);
    }
  }

  function onIntersect(entries) {
    let best = null;
    entries.forEach(function (e) {
      if (!e.isIntersecting) leave(e.target);
      else if (!best || e.intersectionRatio > best.intersectionRatio) best = e;
    });
    if (best) activate(best.target);
  }

  /* ---------- API pública ---------- */
  function configure(h) { hooks = Object.assign(hooks, h || {}); }

  function register(newCards, root) {
    if (!root || !('IntersectionObserver' in window)) return;
    if (!observer || observerRoot !== root) {
      if (observer) observer.disconnect();
      observer = new IntersectionObserver(onIntersect, { root: root, threshold: 0.75 });
      observerRoot = root;
    }
    newCards.forEach(function (c) {
      const s = S(c);
      s.idx = cards.length;
      cards.push(c);
      if (s.idx <= POSTER_AHEAD) setPoster(c);
      observer.observe(c);
    });
    if (activeCard) applyWindow();
  }

  function ensureSource(card) { attach(card, 'auto', true); }
  function setManualPause(card, paused) { S(card).userPaused = !!paused; }

  /* Vuelve a reproducir el Loor activo (al volver a la app), salvo que la persona lo haya pausado */
  function resumeActive() {
    if (!activeCard) return;
    const section = document.getElementById('loors-section');
    if (!section || !section.classList.contains('active')) return;
    const s = S(activeCard);
    if (s.userPaused || !s.v || !s.v.paused) return;
    attach(activeCard, 'auto', true);
    if (hooks.play) hooks.play(activeCard);
  }

  /* Se cerró la sección: se pausa todo y se libera todo menos el último Loor (reapertura instantánea) */
  function suspend() {
    clearTimeout(activateTimer);
    cancelAhead();
    const keep = activeCard;
    if (activeCard) { quiet(activeCard); activeCard = null; }
    attached.forEach(function (c) { if (c !== keep) detach(c); });
  }

  /* Se va a reconstruir el listado: se libera todo */
  function reset() {
    clearTimeout(activateTimer);
    cancelAhead();
    if (observer) { observer.disconnect(); observer = null; observerRoot = null; }
    Array.from(attached).forEach(detach);
    cards = [];
    activeCard = null;
    dropWarm();
  }

  /* ---------- Arranque anticipado del primer video ---------- */
  function dropWarm() {
    warmed.forEach(function (w) {
      clearTimeout(w.timer);
      try { w.v.pause(); } catch (e) {}
      w.v.removeAttribute('src');
      try { w.v.load(); } catch (e) {}
    });
    warmed.clear();
  }

  /* Empieza a bajar el primer video mientras la app consulta perfiles, likes y comentarios */
  function warmFirst(loor) {
    dropWarm();
    if (!loor || !loor.video_url || tierName() === 'none') return;
    const v = document.createElement('video');
    v.className = 'loor-video';
    v.setAttribute('playsinline', '');
    v.playsInline = true;
    v.loop = true;
    v.preload = 'auto';
    if (loor.audio_url) { v.defaultMuted = true; v.muted = true; }
    v.dataset.src = loor.video_url;
    if (loor.thumbnail_url) { v.dataset.poster = loor.thumbnail_url; v.setAttribute('poster', loor.thumbnail_url); }
    setSource(v, loor.video_url, !!loor.thumbnail_url);
    const id = String(loor.id);
    warmed.set(id, { v: v, timer: setTimeout(function () {
      const w = warmed.get(id);
      if (!w) return;
      w.v.removeAttribute('src');
      try { w.v.load(); } catch (e) {}
      warmed.delete(id);
    }, WARM_TTL_MS) });
  }

  /* La tarjeta recién creada toma el video que ya venía descargando */
  function adopt(card, loorId) {
    const w = warmed.get(String(loorId));
    const old = card.querySelector('.loor-video');
    if (!w || !old) return false;
    clearTimeout(w.timer);
    warmed.delete(String(loorId));
    w.v.dataset.src = old.dataset.src || w.v.dataset.src;
    if (old.dataset.poster) w.v.dataset.poster = old.dataset.poster;
    old.replaceWith(w.v);
    const s = S(card);
    s.v = w.v;
    s.attached = true;
    attached.add(card);
    return true;
  }

  function stats() {
    let playing = 0;
    cards.forEach(function (c) { const v = S(c).v; if (v && !v.paused && !v.ended) playing++; });
    return {
      tier: tierName(), startAvgMs: startAvg == null ? null : Math.round(startAvg),
      cards: cards.length, attached: attached.size, playing: playing,
      activeIndex: activeCard ? S(activeCard).idx : -1
    };
  }

  /* ---------- Eventos globales (se registran una sola vez) ---------- */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (activeCard && hooks.pause) hooks.pause(activeCard);   // sin marcar pausa manual
    } else {
      resumeActive();
    }
  });
  window.addEventListener('pageshow', resumeActive);
  const c0 = conn();
  if (c0 && c0.addEventListener) c0.addEventListener('change', function () { applyWindow(); });

  return {
    configure: configure, register: register, reset: reset, suspend: suspend,
    ensureSource: ensureSource, setManualPause: setManualPause, resumeActive: resumeActive,
    warmFirst: warmFirst, adopt: adopt, stats: stats
  };
})();
