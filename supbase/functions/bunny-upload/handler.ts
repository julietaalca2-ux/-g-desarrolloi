/* ÖG — Lógica de la Edge Function bunny-upload (sin dependencias externas).
   Recibe un archivo del usuario ya logueado, lo valida y lo guarda en Bunny Storage.

   Contrato (lo usa js/core/bunny-storage.js):
     POST  /functions/v1/bunny-upload
     Headers:  Authorization: Bearer <token de sesión del usuario>
               x-og-kind:     avatar | post | highlight | story | loor | loor_thumb
               x-og-filename: (opcional) nombre base sin extensión, solo letras, números, "-" y "_"
               Content-Type:  tipo del archivo (image/jpeg, video/mp4, ...)
     Body:     los bytes del archivo, tal cual
   Respuesta 201: { ok, kind, path, url, size, contentType }
   Errores:       { ok:false, error:"<codigo>", message:"..." } con el estado HTTP que corresponda.

   Secretos que usa (Supabase → Edge Functions → Secrets):
     BUNNY_STORAGE_ZONE, BUNNY_STORAGE_HOST, BUNNY_STORAGE_PASSWORD  (ya creados)
     BUNNY_CDN_URL  (opcional: dirección pública de la Pull Zone; si falta se usa DEFAULT_CDN_URL = https://ogmedia.b-cdn.net)
     BUNNY_VERIFY_CDN (opcional: poné 0 para NO comprobar el CDN después de cada subida)
     ALLOWED_ORIGINS (opcional: orígenes permitidos separados por coma; si falta, se permite cualquiera,
                      porque la seguridad la da el token del usuario y no las cookies)
   SUPABASE_URL y SUPABASE_ANON_KEY los inyecta Supabase solo. */

const MB = 1024 * 1024;

/* Pull Zone "ogmedia" (origen: Storage Zone og-media-storage). Solo se usa si no existe el secreto BUNNY_CDN_URL. */
export const DEFAULT_CDN_URL = 'https://ogmedia.b-cdn.net';

type Group = 'image' | 'video';
type Sniffed = { mime: string; ext: string; group: Group };

type KindRule = {
  folder: string;
  /** Tipos permitidos (ya detectados por los bytes reales del archivo) y su tamaño máximo en bytes. */
  allow: Record<string, number>;
};

const IMG_BASIC = ['image/jpeg', 'image/png', 'image/webp'];
const VIDEOS = ['video/mp4', 'video/quicktime', 'video/webm'];
const limits = (mimes: string[], max: number) => Object.fromEntries(mimes.map((m) => [m, max]));

/* ===== Límites: se cambian aquí, en un solo lugar =====
   Los videos se leen completos en memoria (la función tiene 256 MB) y además Supabase corta cada
   petición a los 150 s; por eso los videos tienen tope. */
export const KINDS: Record<string, KindRule> = {
  avatar: { folder: 'avatars', allow: limits(IMG_BASIC, 5 * MB) },
  post: { folder: 'posts', allow: limits([...IMG_BASIC, 'image/gif'], 10 * MB) },
  highlight: { folder: 'highlights', allow: limits(IMG_BASIC, 5 * MB) },
  story: { folder: 'stories', allow: { ...limits(IMG_BASIC, 10 * MB), ...limits(VIDEOS, 40 * MB) } },
  loor: { folder: 'loors', allow: limits(VIDEOS, 80 * MB) },
  loor_thumb: { folder: 'loors/thumbs', allow: limits(IMG_BASIC, 2 * MB) },
};

const NON_VIDEO_FTYP_BRANDS = new Set([
  'heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1', 'avif', 'avis',
]);

export type Deps = {
  env: (name: string) => string | undefined;
  fetch: typeof fetch;
  now: () => number;
  random: () => string;
  /** Pausa entre reintentos (en las pruebas se reemplaza para no esperar). */
  sleep?: (ms: number) => Promise<void>;
};

/* ---------- Detección del tipo real por los primeros bytes ---------- */
function ascii(b: Uint8Array, from: number, to: number): string {
  let s = '';
  for (let i = from; i < to && i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

export function sniff(b: Uint8Array): Sniffed | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg', group: 'image' };
  if (b[0] === 0x89 && ascii(b, 1, 4) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return { mime: 'image/png', ext: 'png', group: 'image' };
  }
  if (ascii(b, 0, 4) === 'GIF8') return { mime: 'image/gif', ext: 'gif', group: 'image' };
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp', group: 'image' };
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { mime: 'video/webm', ext: 'webm', group: 'video' };
  if (ascii(b, 4, 8) === 'ftyp') {
    const brand = ascii(b, 8, 12).toLowerCase();
    if (NON_VIDEO_FTYP_BRANDS.has(brand)) return null;
    if (brand === 'qt  ') return { mime: 'video/quicktime', ext: 'mov', group: 'video' };
    return { mime: 'video/mp4', ext: 'mp4', group: 'video' };
  }
  return null;
}

/* ---------- Utilidades ---------- */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_RE = /^[A-Za-z0-9_-]{1,80}$/;

function normalizeHost(v: string): string {
  return v.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
}
function normalizeZone(v: string): string {
  return v.trim().replace(/^\/+|\/+$/g, '');
}
function normalizeCdn(v: string): string {
  let s = v.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  return s;
}

function corsHeaders(req: Request, deps: Deps): Record<string, string> {
  const allowed = (deps.env('ALLOWED_ORIGINS') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get('origin') || '';
  let allowOrigin = '*';
  if (allowed.length) allowOrigin = allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-og-kind, x-og-filename',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(req: Request, deps: Deps, status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req, deps), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
const fail = (req: Request, deps: Deps, status: number, error: string, message: string) =>
  json(req, deps, status, { ok: false, error, message });

/* ---------- Autenticación: el token tiene que ser de un usuario real y vigente ---------- */
async function verifyUser(req: Request, deps: Deps): Promise<{ id: string } | { status: number; error: string; message: string }> {
  const auth = req.headers.get('authorization') || '';
  const m = /^Bearer\s+(\S+)$/i.exec(auth);
  if (!m) return { status: 401, error: 'no_session', message: 'Iniciá sesión para subir archivos.' };

  const base = (deps.env('SUPABASE_URL') || '').replace(/\/+$/, '');
  const apikey = deps.env('SUPABASE_ANON_KEY') || req.headers.get('apikey') || '';
  if (!base || !apikey) return { status: 503, error: 'not_configured', message: 'Falta configuración de Supabase en la función.' };

  let res: Response;
  try {
    res = await deps.fetch(base + '/auth/v1/user', { headers: { Authorization: 'Bearer ' + m[1], apikey } });
  } catch {
    return { status: 502, error: 'auth_unreachable', message: 'No se pudo verificar la sesión.' };
  }
  if (!res.ok) return { status: 401, error: 'invalid_session', message: 'Tu sesión venció. Volvé a iniciar sesión.' };

  const user = await res.json().catch(() => null) as { id?: string; is_anonymous?: boolean } | null;
  if (!user || typeof user.id !== 'string' || !UUID_RE.test(user.id)) {
    return { status: 401, error: 'invalid_session', message: 'Sesión inválida.' };
  }
  if (user.is_anonymous) return { status: 403, error: 'forbidden', message: 'Las cuentas anónimas no pueden subir archivos.' };
  return { id: user.id.toLowerCase() };
}

/* Pide solo el primer byte por el CDN (Range) y cancela el resto; 200 o 206 = el archivo se entrega bien. */
async function checkServedByCdn(url: string, deps: Deps): Promise<{ ok: boolean; status: number }> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let status = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(500 * attempt);
    try {
      const r = await deps.fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(8_000) });
      status = r.status;
      try { await r.body?.cancel(); } catch { /* nada */ }
      if (status === 200 || status === 206) return { ok: true, status };
    } catch {
      status = 0;
    }
  }
  return { ok: false, status };
}

/* ---------- Handler ---------- */
export function createHandler(deps: Deps) {
  // Límite de ritmo por usuario (por instancia de la función): frena abusos sin molestar el uso normal.
  const RATE_MAX = 40;
  const RATE_WINDOW_MS = 60_000;
  const hits = new Map<string, number[]>();
  function rateLimited(uid: string): boolean {
    const now = deps.now();
    const recent = (hits.get(uid) || []).filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length >= RATE_MAX) { hits.set(uid, recent); return true; }
    recent.push(now);
    hits.set(uid, recent);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < RATE_WINDOW_MS)) hits.delete(k);
    return false;
  }

  return async function handler(req: Request): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req, deps) });
    if (req.method !== 'POST') return fail(req, deps, 405, 'method_not_allowed', 'Usá POST.');

    const zone = normalizeZone(deps.env('BUNNY_STORAGE_ZONE') || '');
    const host = normalizeHost(deps.env('BUNNY_STORAGE_HOST') || '');
    const password = (deps.env('BUNNY_STORAGE_PASSWORD') || '').trim();
    const cdnRaw = (deps.env('BUNNY_CDN_URL') || '').trim() || DEFAULT_CDN_URL;
    if (!zone || !host || !password) {
      return fail(req, deps, 503, 'not_configured', 'Bunny no está configurado del todo en la función (faltan secretos).');
    }
    const cdn = normalizeCdn(cdnRaw);

    // 1) Solo usuarios con sesión válida
    const user = await verifyUser(req, deps);
    if ('status' in user) return fail(req, deps, user.status, user.error, user.message);
    if (rateLimited(user.id)) return fail(req, deps, 429, 'rate_limited', 'Demasiadas subidas seguidas. Esperá un minuto.');

    // 2) Tipo de contenido pedido
    const kind = (req.headers.get('x-og-kind') || '').trim();
    const rule = Object.prototype.hasOwnProperty.call(KINDS, kind) ? KINDS[kind] : undefined;
    if (!rule) return fail(req, deps, 400, 'bad_kind', 'Tipo de contenido no válido.');

    // 3) Tamaño: se revisa antes de leer el cuerpo y otra vez después
    const maxForKind = Math.max(...Object.values(rule.allow));
    const declared = Number(req.headers.get('content-length'));
    if (!Number.isFinite(declared) || declared <= 0) return fail(req, deps, 411, 'length_required', 'No se pudo determinar el tamaño del archivo.');
    if (declared > maxForKind) {
      return fail(req, deps, 413, 'too_large', `El archivo supera el máximo de ${Math.round(maxForKind / MB)} MB para este contenido.`);
    }

    // 4) Tipo declarado
    const declaredMime = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(rule.allow, declaredMime)) {
      return fail(req, deps, 415, 'unsupported_type', 'Tipo de archivo no permitido para este contenido.');
    }

    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > maxForKind) {
      return fail(req, deps, bytes.byteLength ? 413 : 400, bytes.byteLength ? 'too_large' : 'empty', 'Archivo vacío o demasiado grande.');
    }

    // 5) Tipo real, por los bytes del archivo (no se confía en el nombre ni en lo que diga el navegador)
    const real = sniff(bytes);
    if (!real || !Object.prototype.hasOwnProperty.call(rule.allow, real.mime)) {
      return fail(req, deps, 415, 'unsupported_type', 'El contenido del archivo no coincide con un formato permitido.');
    }
    if (!declaredMime.startsWith(real.group + '/')) {
      return fail(req, deps, 415, 'type_mismatch', 'El tipo declarado no coincide con el contenido del archivo.');
    }
    const maxForType = rule.allow[real.mime];
    if (bytes.byteLength > maxForType) {
      return fail(req, deps, 413, 'too_large', `El archivo supera el máximo de ${Math.round(maxForType / MB)} MB para este tipo.`);
    }

    // 6) Ruta: users/<id del usuario según el token>/<tipo>/<nombre>.<extensión según los bytes>
    //    El id sale SIEMPRE del token, nunca de lo que mande el cliente.
    const wanted = (req.headers.get('x-og-filename') || '').trim();
    const base = NAME_RE.test(wanted) ? wanted : `${kind}-${deps.now()}-${deps.random()}`;
    const path = `users/${user.id}/${rule.folder}/${base}.${real.ext}`;

    // 7) Guardar en Bunny Storage
    let put: Response;
    try {
      put = await deps.fetch(`https://${host}/${zone}/${path}`, {
        method: 'PUT',
        headers: { AccessKey: password, 'Content-Type': real.mime },
        body: bytes,
        signal: AbortSignal.timeout(110_000),
      });
    } catch (e) {
      console.error('bunny-upload: fallo de red hacia Bunny', e instanceof Error ? e.message : e);
      return fail(req, deps, 502, 'storage_unreachable', 'No se pudo contactar el almacenamiento. Probá de nuevo.');
    }
    if (put.status !== 201 && put.status !== 200) {
      console.error('bunny-upload: Bunny respondió', put.status);
      return fail(req, deps, 502, 'storage_failed', 'El almacenamiento rechazó el archivo.');
    }

    // 8) Comprobar que el archivo realmente se entrega por la Pull Zone. Si no (Pull Zone mal conectada,
    //    dirección equivocada, etc.), se borra lo recién subido y se responde 502: el cliente usa Supabase
    //    y el usuario nunca recibe una dirección que daría 404.
    const url = `${cdn}/${path}`;
    let verified = false;
    if (deps.env('BUNNY_VERIFY_CDN') !== '0') {
      const check = await checkServedByCdn(url, deps);
      if (!check.ok) {
        console.error('bunny-upload: el CDN no entrega el archivo recién subido. HTTP', check.status, url);
        try {
          await deps.fetch(`https://${host}/${zone}/${path}`, { method: 'DELETE', headers: { AccessKey: password }, signal: AbortSignal.timeout(10_000) });
        } catch { /* limpieza de mejor esfuerzo */ }
        return fail(req, deps, 502, 'cdn_unreachable', 'El archivo se subió pero el CDN no lo entrega (revisá la Pull Zone y BUNNY_CDN_URL).');
      }
      verified = true;
    }

    return json(req, deps, 201, {
      ok: true,
      kind,
      path,
      url,
      size: bytes.byteLength,
      contentType: real.mime,
      verified,
    });
  };
}
