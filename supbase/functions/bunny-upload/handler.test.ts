/* Pruebas de bunny-upload. Corren con Node 22+ o con Deno, sin internet (Supabase y Bunny están simulados):
     node --experimental-strip-types --test supabase/functions/bunny-upload/handler.test.ts
     deno test supabase/functions/bunny-upload/handler.test.ts */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, sniff } from './handler.ts';

const UID = '11111111-2222-4333-8444-555555555555';
const GOOD_TOKEN = 'token-bueno';

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 1, 2, 3]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3, 4]);
const MP4 = Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 1, 2, 3, 4]);
const MOV = Uint8Array.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20, 0, 0, 0, 0, 1, 2, 3, 4]);
const HEIC = Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0, 1, 2, 3, 4]);
const HTML = new TextEncoder().encode('<html><script>alert(1)</script></html>');

type Call = { url: string; init?: RequestInit };
function setup(overrides: Record<string, string | undefined> = {}, bunnyStatus = 201, cdnStatus = 206) {
  const calls: Call[] = [];
  const env: Record<string, string | undefined> = {
    SUPABASE_URL: 'https://proj.supabase.co',
    SUPABASE_ANON_KEY: 'anon',
    BUNNY_STORAGE_ZONE: 'og-media-storage',
    BUNNY_STORAGE_HOST: 'br.storage.bunnycdn.com',
    BUNNY_STORAGE_PASSWORD: 'secreto-de-bunny',
    BUNNY_CDN_URL: 'https://og-media.b-cdn.net/',
    ...overrides,
  };
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith('https://proj.supabase.co/auth/v1/user')) {
      const auth = (init?.headers as Record<string, string>).Authorization;
      if (auth === 'Bearer ' + GOOD_TOKEN) return new Response(JSON.stringify({ id: UID }), { status: 200 });
      if (auth === 'Bearer anonimo') return new Response(JSON.stringify({ id: UID, is_anonymous: true }), { status: 200 });
      return new Response('{}', { status: 401 });
    }
    if (init?.method === 'DELETE') return new Response(null, { status: 200 });
    if (!url.includes('storage.bunnycdn.com')) return new Response(null, { status: cdnStatus }); // lectura por el CDN
    return new Response(null, { status: bunnyStatus });
  }) as typeof fetch;
  let n = 1000;
  const handler = createHandler({ env: (k) => env[k], fetch: fakeFetch, now: () => n++, random: () => 'abc123', sleep: async () => {} });
  return { handler, calls };
}

function upload(body: Uint8Array, o: { kind?: string; type?: string; token?: string | null; name?: string; length?: number } = {}) {
  const headers: Record<string, string> = {
    'content-type': o.type ?? 'image/jpeg',
    'x-og-kind': o.kind ?? 'post',
    'content-length': String(o.length ?? body.byteLength),
  };
  if (o.token !== null) headers.authorization = 'Bearer ' + (o.token ?? GOOD_TOKEN);
  if (o.name) headers['x-og-filename'] = o.name;
  return new Request('https://proj.supabase.co/functions/v1/bunny-upload', { method: 'POST', headers, body });
}
const bunnyCalls = (calls: Call[]) => calls.filter((c) => c.url.includes('storage.bunnycdn.com') && c.init?.method === 'PUT');

test('sniff reconoce formatos y rechaza HEIC y HTML', () => {
  assert.equal(sniff(JPEG)?.mime, 'image/jpeg');
  assert.equal(sniff(PNG)?.ext, 'png');
  assert.equal(sniff(MP4)?.mime, 'video/mp4');
  assert.equal(sniff(MOV)?.ext, 'mov');
  assert.equal(sniff(HEIC), null);
  assert.equal(sniff(HTML), null);
});

test('CORS preflight responde 204 con los headers permitidos', async () => {
  const { handler } = setup();
  const r = await handler(new Request('https://x/f', { method: 'OPTIONS' }));
  assert.equal(r.status, 204);
  assert.match(r.headers.get('access-control-allow-headers')!, /x-og-kind/);
});

test('sin token -> 401 y no toca Bunny', async () => {
  const { handler, calls } = setup();
  const r = await handler(upload(JPEG, { token: null }));
  assert.equal(r.status, 401);
  assert.equal(bunnyCalls(calls).length, 0);
});

test('token inválido o vencido -> 401', async () => {
  const { handler, calls } = setup();
  const r = await handler(upload(JPEG, { token: 'malo' }));
  assert.equal(r.status, 401);
  assert.equal(bunnyCalls(calls).length, 0);
});

test('cuenta anónima -> 403', async () => {
  const { handler } = setup();
  assert.equal((await handler(upload(JPEG, { token: 'anonimo' }))).status, 403);
});

test('subida correcta: ruta por usuario y tipo, AccessKey solo hacia Bunny, URL del CDN', async () => {
  const { handler, calls } = setup();
  const r = await handler(upload(JPEG, { kind: 'post', name: 'post-1700000000000' }));
  assert.equal(r.status, 201);
  const j = await r.json();
  assert.equal(j.path, `users/${UID}/posts/post-1700000000000.jpg`);
  assert.equal(j.url, `https://og-media.b-cdn.net/users/${UID}/posts/post-1700000000000.jpg`);
  const b = bunnyCalls(calls);
  assert.equal(b.length, 1);
  assert.equal(b[0].url, `https://br.storage.bunnycdn.com/og-media-storage/${j.path}`);
  assert.equal(b[0].init?.method, 'PUT');
  assert.equal((b[0].init?.headers as Record<string, string>).AccessKey, 'secreto-de-bunny');
  assert.ok(!JSON.stringify(j).includes('secreto-de-bunny'), 'la respuesta no debe contener la contraseña');
});

test('la miniatura del post queda al lado: post-N-t.jpg', async () => {
  const { handler } = setup();
  const j = await (await handler(upload(JPEG, { kind: 'post', name: 'post-123-t' }))).json();
  assert.equal(j.path, `users/${UID}/posts/post-123-t.jpg`);
});

test('el cliente no puede elegir carpeta ni usuario (path traversal en el nombre)', async () => {
  const { handler } = setup();
  for (const name of ['../otro/x', '../../etc/passwd', 'a/b', 'x.html', 'otro-uid/../x']) {
    const j = await (await handler(upload(JPEG, { kind: 'post', name }))).json();
    assert.match(j.path, new RegExp(`^users/${UID}/posts/post-\\d+-abc123\\.jpg$`), name);
  }
});

test('la extensión sale de los bytes, no del cliente', async () => {
  const { handler } = setup();
  const j = await (await handler(upload(PNG, { kind: 'avatar', type: 'image/png', name: 'avatar-1' }))).json();
  assert.equal(j.path, `users/${UID}/avatars/avatar-1.png`);
});

test('video: loor mp4 y mov entran en loors/', async () => {
  const { handler } = setup();
  const a = await (await handler(upload(MP4, { kind: 'loor', type: 'video/mp4', name: '1700' }))).json();
  assert.equal(a.path, `users/${UID}/loors/1700.mp4`);
  const b = await (await handler(upload(MOV, { kind: 'loor', type: 'video/quicktime', name: '1701' }))).json();
  assert.equal(b.path, `users/${UID}/loors/1701.mov`);
});

test('HTML disfrazado de imagen -> 415 y no se sube', async () => {
  const { handler, calls } = setup();
  const r = await handler(upload(HTML, { kind: 'post', type: 'image/jpeg' }));
  assert.equal(r.status, 415);
  assert.equal(bunnyCalls(calls).length, 0);
});

test('video declarado como imagen y viceversa -> 415', async () => {
  const { handler } = setup();
  assert.equal((await handler(upload(MP4, { kind: 'story', type: 'image/jpeg' }))).status, 415);
  assert.equal((await handler(upload(JPEG, { kind: 'story', type: 'video/mp4' }))).status, 415);
});

test('tipo no permitido para ese contenido: video en avatar, imagen en loor, gif en avatar', async () => {
  const { handler } = setup();
  assert.equal((await handler(upload(MP4, { kind: 'avatar', type: 'video/mp4' }))).status, 415);
  assert.equal((await handler(upload(JPEG, { kind: 'loor', type: 'image/jpeg' }))).status, 415);
  assert.equal((await handler(upload(JPEG, { kind: 'avatar', type: 'image/gif' }))).status, 415);
});

test('HEIC -> 415', async () => {
  const { handler } = setup();
  assert.equal((await handler(upload(HEIC, { kind: 'post', type: 'image/jpeg' }))).status, 415);
});

test('tamaño: avatar de más de 5 MB -> 413 sin leer el cuerpo', async () => {
  const { handler, calls } = setup();
  const r = await handler(upload(JPEG, { kind: 'avatar', length: 6 * 1024 * 1024 }));
  assert.equal(r.status, 413);
  assert.equal(bunnyCalls(calls).length, 0);
});

test('tamaño: Content-Length mentiroso (cuerpo más grande de lo declarado) -> 413', async () => {
  const { handler } = setup();
  const big = new Uint8Array(6 * 1024 * 1024);
  big.set(JPEG);
  const r = await handler(upload(big, { kind: 'avatar', length: 100 }));
  assert.equal(r.status, 413);
});

test('kind desconocido -> 400', async () => {
  const { handler } = setup();
  assert.equal((await handler(upload(JPEG, { kind: 'chat' }))).status, 400);
  assert.equal((await handler(upload(JPEG, { kind: '__proto__' }))).status, 400);
});

test('método distinto de POST -> 405', async () => {
  const { handler } = setup();
  assert.equal((await handler(new Request('https://x/f', { method: 'GET' }))).status, 405);
});

test('falta la contraseña de Bunny -> 503 (el cliente cae a Supabase)', async () => {
  const { handler } = setup({ BUNNY_STORAGE_PASSWORD: undefined });
  assert.equal((await handler(upload(JPEG))).status, 503);
});

test('sin el secreto BUNNY_CDN_URL se usa la Pull Zone ogmedia por defecto', async () => {
  const { handler, calls } = setup({ BUNNY_CDN_URL: undefined });
  const j = await (await handler(upload(JPEG, { name: 'post-9' }))).json();
  assert.equal(j.url, `https://ogmedia.b-cdn.net/users/${UID}/posts/post-9.jpg`);
  assert.ok(calls.some((c) => c.url === j.url), 'se comprobó la URL por el CDN');
});

test('verificación por el CDN: pide solo el primer byte (Range) y devuelve verified:true', async () => {
  const { handler, calls } = setup();
  const j = await (await handler(upload(JPEG, { name: 'post-5' }))).json();
  assert.equal(j.verified, true);
  const check = calls.find((c) => c.url === j.url)!;
  assert.equal((check.init?.headers as Record<string, string>).Range, 'bytes=0-0');
});

test('el CDN responde 404 (Pull Zone mal conectada): 502, se borra lo subido y no se devuelve URL', async () => {
  const { handler, calls } = setup({}, 201, 404);
  const r = await handler(upload(JPEG, { name: 'post-6' }));
  assert.equal(r.status, 502);
  const j = await r.json();
  assert.equal(j.error, 'cdn_unreachable');
  assert.equal(j.url, undefined);
  const del = calls.find((c) => c.init?.method === 'DELETE');
  assert.ok(del && del.url.endsWith(`/users/${UID}/posts/post-6.jpg`), 'se borró el archivo huérfano');
  assert.equal(calls.filter((c) => c.init?.method === 'GET' && c.url.includes('b-cdn.net')).length, 3, 'reintenta 3 veces');
});

test('el CDN tarda en propagar (404, 404, luego 206): igual se acepta', async () => {
  let n = 0;
  const calls: Call[] = [];
  const handler = createHandler({
    env: (k) => ({ SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_ANON_KEY: 'a', BUNNY_STORAGE_ZONE: 'z', BUNNY_STORAGE_HOST: 'br.storage.bunnycdn.com', BUNNY_STORAGE_PASSWORD: 'p' } as Record<string, string>)[k],
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); calls.push({ url, init });
      if (url.includes('/auth/v1/user')) return new Response(JSON.stringify({ id: UID }), { status: 200 });
      if (url.includes('storage.bunnycdn.com')) return new Response(null, { status: 201 });
      return new Response(null, { status: ++n < 3 ? 404 : 206 });
    }) as typeof fetch,
    now: () => 1, random: () => 'r', sleep: async () => {},
  });
  assert.equal((await handler(upload(JPEG))).status, 201);
});

test('BUNNY_VERIFY_CDN=0 salta la comprobación', async () => {
  const { handler, calls } = setup({ BUNNY_VERIFY_CDN: '0' }, 201, 404);
  const j = await (await handler(upload(JPEG, { name: 'post-7' }))).json();
  assert.equal(j.verified, false);
  assert.ok(!calls.some((c) => c.url.includes('b-cdn.net')));
});

test('host y zona con formato "sucio" se normalizan', async () => {
  const { handler, calls } = setup({ BUNNY_STORAGE_HOST: 'https://br.storage.bunnycdn.com/', BUNNY_STORAGE_ZONE: '/og-media-storage/', BUNNY_CDN_URL: 'og-media.b-cdn.net' });
  const j = await (await handler(upload(JPEG, { name: 'p-1' }))).json();
  assert.equal(bunnyCalls(calls)[0].url, `https://br.storage.bunnycdn.com/og-media-storage/${j.path}`);
  assert.equal(j.url, `https://og-media.b-cdn.net/${j.path}`);
});

test('Bunny rechaza (401) -> 502 sin filtrar detalles', async () => {
  const { handler } = setup({}, 401);
  const r = await handler(upload(JPEG));
  assert.equal(r.status, 502);
  assert.ok(!(await r.text()).includes('secreto'));
});

test('límite de ritmo: la subida 41 en un minuto -> 429', async () => {
  const { handler } = setup();
  let last = 0;
  for (let i = 0; i < 41; i++) last = (await handler(upload(JPEG))).status;
  assert.equal(last, 429);
});
