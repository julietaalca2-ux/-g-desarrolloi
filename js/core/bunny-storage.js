/* ÖG — Almacenamiento externo en Bunny.net (archivo NUEVO, no modifica ningún otro JS)
   Depende de: config.js (db, SUPABASE_URL, SUPABASE_KEY). Cargar justo después de utils.js y ANTES de performance.js.

   Cómo funciona (sin tocar publicaciones, perfil, historias, destacadas ni Loors):
   las pantallas siguen llamando a  db.storage.from(...).upload(...)  y  .getPublicUrl(...)  como siempre.
   Este archivo intercepta SOLO esas subidas:
     · og-media  →  post-*.jpg (y su miniatura -t.jpg), avatar-*, highlight-*, story-*, loorthumb-*
     · loors_videos  →  videos de Loors
   y en vez de mandarlas a Supabase Storage las envía a la Edge Function "bunny-upload", que valida la
   sesión, el tipo y el tamaño y las guarda en Bunny. getPublicUrl() devuelve entonces la dirección del CDN.
   El chat, los audios y la verificación de identidad NO se tocan (siguen en Supabase).

   Seguridad: aquí no hay ninguna contraseña ni clave de Bunny. Solo viaja el token de sesión del usuario.
   Si la función no está desplegada, Bunny no está configurado, la Pull Zone no entrega el archivo o falla, la subida cae sola a Supabase
   Storage (como antes), así la app nunca se queda sin poder subir. Los errores de validación
   (archivo muy grande, tipo no permitido, sesión vencida) NO caen a Supabase: se muestran al usuario.

   Interruptor: poné  BUNNY_ENABLED = false  para volver a Supabase en todo. */

const OG_BUNNY_CONFIG = {
 BUNNY_ENABLED: true,
 FUNCTION_NAME: 'bunny-upload',
 TIMEOUT_MS: 120000,
 RETRY_AFTER_MS: 5 * 60 * 1000   // si Bunny no está configurado, no se vuelve a intentar durante este tiempo
};

(function ogBunnyStorage() {
 const ENDPOINT = String(SUPABASE_URL).replace(/\/+$/, '') + '/functions/v1/' + OG_BUNNY_CONFIG.FUNCTION_NAME;
 const publicUrls = new Map();   // "bucket/ruta" → dirección del CDN (solo lo recién subido)
 let pausedUntil = 0;

 const state = window.OG_BUNNY = { endpoint: ENDPOINT, lastError: null, lastUrl: null };

 function enabled() {
  try { if (localStorage.getItem('og_bunny_off') === '1') return false; } catch (e) {}
  return OG_BUNNY_CONFIG.BUNNY_ENABLED && Date.now() >= pausedUntil;
 }

 /* ¿Qué tipo de contenido es? Solo lo que ÖG sube hoy como foto/video de contenido.
    Devuelve null para todo lo demás (chat, etc.), que sigue yendo a Supabase. */
 function classify(bucket, path) {
  const parts = String(path || '').split('/');
  const name = parts[parts.length - 1] || '';
  const base = name.replace(/\.[A-Za-z0-9]+$/, '');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(base)) return null;

  if (bucket === 'loors_videos') {
   return parts.length === 2 ? { kind: 'loor', base } : null;   // "<usuario>/<fecha>.mp4"; bots/... queda aparte
  }
  if (bucket === 'og-media' && parts.length === 2) {            // "<usuario>/<archivo>"; chat/ tiene 3 partes
   if (/^post-\d+(-t)?$/.test(base)) return { kind: 'post', base };
   if (/^avatar-\d+$/.test(base)) return { kind: 'avatar', base };
   if (/^highlight-[A-Za-z0-9-]+$/.test(base)) return { kind: 'highlight', base };
   if (/^story-[A-Za-z0-9-]+$/.test(base)) return { kind: 'story', base };
   if (/^loorthumb-\d+$/.test(base)) return { kind: 'loor_thumb', base };
  }
  return null;
 }

 function toBlob(body, mime) {
  if (typeof Blob !== 'undefined' && body instanceof Blob) return body;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return new Blob([body], { type: mime || '' });
  return null;
 }

 function fail(message, status, code) {
  const err = new Error(message);
  err.statusCode = String(status || '');
  err.status = status || 0;
  err.code = code || 'bunny_error';
  return err;
 }

 /* Sube un archivo a Bunny mediante la Edge Function. Devuelve { path, url, size, contentType }.
    Se puede usar directamente:  await window.OG_BUNNY.upload('post', blob, { filename: 'post-123' }) */
 async function uploadToBunny(kind, blob, opts) {
  opts = opts || {};
  const { data } = await db.auth.getSession();
  const token = data && data.session && data.session.access_token;
  if (!token) throw fail('Iniciá sesión para subir archivos.', 401, 'no_session');

  const headers = {
   Authorization: 'Bearer ' + token,
   apikey: SUPABASE_KEY,
   'Content-Type': opts.contentType || blob.type || 'application/octet-stream',
   'x-og-kind': kind
  };
  if (opts.filename) headers['x-og-filename'] = opts.filename;

  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), OG_BUNNY_CONFIG.TIMEOUT_MS) : null;
  let res;
  try {
   res = await fetch(ENDPOINT, { method: 'POST', headers, body: blob, signal: ctrl ? ctrl.signal : undefined });
  } catch (e) {
   throw fail('No se pudo conectar con el almacenamiento.', 0, 'network');
  } finally {
   if (timer) clearTimeout(timer);
  }

  let json = null;
  try { json = await res.json(); } catch (e) {}
  if (!res.ok || !json || !json.ok || !json.url) {
   throw fail((json && json.message) || 'No se pudo subir el archivo.', res.status, (json && json.error) || 'bunny_error');
  }
  return json;
 }
 state.upload = uploadToBunny;

 /* Errores que SÍ conviene reintentar en Supabase (la función no está lista o Bunny no responde).
    Todo lo demás (400, 401, 403, 411, 413, 415, 429) es una respuesta correcta de la validación. */
 function shouldFallback(err) {
  return err.status === 0 || err.status === 404 || err.status >= 500;
 }

 function patchStorage(storage) {
  if (!storage || storage.__ogBunny) return storage;
  storage.__ogBunny = true;
  const originalFrom = storage.from.bind(storage);

  storage.from = function (bucket) {
   const api = originalFrom(bucket);
   if (bucket !== 'og-media' && bucket !== 'loors_videos') return api;

   const originalUpload = api.upload.bind(api);
   const originalGetPublicUrl = api.getPublicUrl.bind(api);

   api.upload = async function (path, body, options) {
    const cls = (options && options.upsert === true) ? null : classify(bucket, path);
    const blob = cls && enabled() ? toBlob(body, options && options.contentType) : null;
    if (!blob) return originalUpload(path, body, options);

    try {
     const out = await uploadToBunny(cls.kind, blob, {
      filename: cls.base,
      contentType: (options && options.contentType) || blob.type
     });
     publicUrls.set(bucket + '/' + path, out.url);
     if (publicUrls.size > 300) publicUrls.delete(publicUrls.keys().next().value);
     state.lastUrl = out.url;
     state.lastError = null;
     return { data: { path, id: null, fullPath: bucket + '/' + path, bunnyPath: out.path }, error: null };
    } catch (err) {
     state.lastError = err.message + ' [' + (err.code || err.status) + ']';
     if (!shouldFallback(err)) return { data: null, error: err };
     // Bunny no configurado (o Pull Zone sin conectar): se pausa un rato para no demorar cada subida con un intento fallido
     if (err.status === 503 || err.status === 404 || err.code === 'cdn_unreachable') pausedUntil = Date.now() + OG_BUNNY_CONFIG.RETRY_AFTER_MS;
     console.warn('[Bunny] No disponible, se usa Supabase Storage:', state.lastError);
     return originalUpload(path, body, options);
    }
   };

   api.getPublicUrl = function (path, options) {
    const url = publicUrls.get(bucket + '/' + path);
    return url ? { data: { publicUrl: url } } : originalGetPublicUrl(path, options);
   };

   return api;
  };
  return storage;
 }

 /* Según la versión de supabase-js, db.storage es siempre el mismo objeto o uno nuevo en cada acceso.
    Se contemplan los dos casos para que el parche funcione igual. */
 try {
  if (db.storage === db.storage) {
   patchStorage(db.storage);
  } else {
   let owner = db, desc = null;
   while (owner && !(desc = Object.getOwnPropertyDescriptor(owner, 'storage'))) owner = Object.getPrototypeOf(owner);
   if (desc && desc.get) {
    Object.defineProperty(db, 'storage', { configurable: true, get() { return patchStorage(desc.get.call(db)); } });
   }
  }
 } catch (e) { console.warn('[Bunny] No se pudo activar; la app sigue con Supabase Storage.', e); }
})();
