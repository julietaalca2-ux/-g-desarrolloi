/* Pruebas del módulo js/core/bunny-storage.js (y su convivencia con performance.js) sin navegador ni internet:
     node --test tests/bunny-storage.test.mjs */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const CDN = 'https://og-media.b-cdn.net';

/* Cliente de Supabase falso: guarda qué subidas llegaron a "Supabase Storage". */
function makeDb({ session = true, freshStorageEachTime = false } = {}) {
  const supabaseUploads = [];
  const makeStorage = () => ({
    from(bucket) {
      return {
        async upload(p, body, opts) { supabaseUploads.push({ bucket, p }); return { data: { path: p }, error: null }; },
        getPublicUrl(p) { return { data: { publicUrl: `https://proj.supabase.co/storage/v1/object/public/${bucket}/${p}` } }; }
      };
    }
  });
  const db = { auth: { getSession: async () => ({ data: { session: session ? { access_token: 'tok-usuario' } : null } }) } };
  if (freshStorageEachTime) Object.defineProperty(db, 'storage', { configurable: true, get: makeStorage });
  else db.storage = makeStorage();
  return { db, supabaseUploads };
}

function load(files, { db, fetchImpl }) {
  const window = {};
  const doc = {
    readyState: 'complete', head: { appendChild() {} },
    querySelectorAll: () => [], documentElement: {}, createElement: () => ({ style: {} }), addEventListener() {}
  };
  const ctx = vm.createContext({
    window, db, document: doc, console, Blob, ArrayBuffer, AbortController, setTimeout, clearTimeout, Date, URL,
    SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_KEY: 'sb_publishable_x',
    localStorage: { getItem: () => null, setItem() {} }, fetch: fetchImpl,
    MutationObserver: class { observe() {} }, HTMLImageElement: class {}, Image: class {}
  });
  window.window = window;
  Object.assign(ctx, { window });
  for (const f of files) vm.runInContext(read(f), ctx, { filename: f });
  return ctx;
}

function okFetch(calls) {
  return async (url, init) => {
    calls.push({ url, init });
    const kind = init.headers['x-og-kind'], name = init.headers['x-og-filename'];
    const ext = kind === 'loor' ? 'mp4' : 'jpg';
    const p = `users/uid-1/${kind === 'loor' ? 'loors' : kind + 's'}/${name}.${ext}`;
    return new Response(JSON.stringify({ ok: true, kind, path: p, url: `${CDN}/${p}`, size: 3, contentType: 'image/jpeg' }), { status: 201 });
  };
}
const jpg = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])], { type: 'image/jpeg' });

for (const fresh of [false, true]) {
  const mode = fresh ? ' (db.storage nuevo en cada acceso)' : '';

  test('publicación: va a Bunny con token de usuario, sin claves, y getPublicUrl devuelve el CDN' + mode, async () => {
    const calls = []; const { db, supabaseUploads } = makeDb({ freshStorageEachTime: fresh });
    load(['js/core/bunny-storage.js'], { db, fetchImpl: okFetch(calls) });
    const r = await db.storage.from('og-media').upload('uid-1/post-1700.jpg', jpg(), { contentType: 'image/jpeg', upsert: false });
    assert.equal(r.error, null);
    assert.equal(supabaseUploads.length, 0, 'no debe duplicarse en Supabase');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://proj.supabase.co/functions/v1/bunny-upload');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer tok-usuario');
    assert.equal(calls[0].init.headers['x-og-kind'], 'post');
    assert.equal(calls[0].init.headers['x-og-filename'], 'post-1700');
    assert.ok(!JSON.stringify(calls[0].init.headers).match(/AccessKey|BUNNY|password/i));
    const url = db.storage.from('og-media').getPublicUrl('uid-1/post-1700.jpg').data.publicUrl;
    assert.equal(url, `${CDN}/users/uid-1/posts/post-1700.jpg`);
  });
}

test('cada tipo de contenido se clasifica bien', async () => {
  const calls = []; const { db } = makeDb();
  load(['js/core/bunny-storage.js'], { db, fetchImpl: okFetch(calls) });
  const cases = [
    ['og-media', 'u/avatar-123.jpg', 'avatar'], ['og-media', 'u/avatar-123.png', 'avatar'],
    ['og-media', 'u/highlight-17-ab12cd.jpg', 'highlight'], ['og-media', 'u/story-17-ab12cd.jpg', 'story'],
    ['og-media', 'u/loorthumb-17.jpg', 'loor_thumb'], ['og-media', 'u/post-17-t.jpg', 'post'],
    ['loors_videos', 'u/1700.mp4', 'loor'], ['loors_videos', 'u/1700.MOV', 'loor']
  ];
  for (const [bucket, p, kind] of cases) {
    calls.length = 0;
    await db.storage.from(bucket).upload(p, jpg(), { contentType: 'image/jpeg' });
    assert.equal(calls[0]?.init.headers['x-og-kind'], kind, `${bucket}/${p}`);
  }
});

test('lo que no es de este alcance sigue en Supabase: chat, audios, verificación, bots, upsert', async () => {
  const calls = []; const { db, supabaseUploads } = makeDb();
  load(['js/core/bunny-storage.js'], { db, fetchImpl: okFetch(calls) });
  await db.storage.from('og-media').upload('u/chat/123-abc.jpg', jpg(), {});
  await db.storage.from('og_audios').upload('u/123.m4a', jpg(), {});
  await db.storage.from('verification-docs').upload('u/doc.jpg', jpg(), {});
  await db.storage.from('loors_videos').upload('bots/viajes/1.mp4', jpg(), {});
  await db.storage.from('og-media').upload('u/post-1.jpg', jpg(), { upsert: true });
  assert.equal(calls.length, 0);
  assert.equal(supabaseUploads.length, 5);
});

test('función no desplegada/sin configurar (404/503): cae a Supabase y se pausa el reintento', async () => {
  let n = 0; const { db, supabaseUploads } = makeDb();
  load(['js/core/bunny-storage.js'], { db, fetchImpl: async () => { n++; return new Response(JSON.stringify({ ok: false, error: 'not_configured' }), { status: 503 }); } });
  const a = await db.storage.from('og-media').upload('u/post-1.jpg', jpg(), {});
  const b = await db.storage.from('og-media').upload('u/post-2.jpg', jpg(), {});
  assert.equal(a.error, null); assert.equal(b.error, null);
  assert.equal(supabaseUploads.length, 2);
  assert.equal(n, 1, 'tras el primer 503 no vuelve a intentar durante un rato');
  assert.match(db.storage.from('og-media').getPublicUrl('u/post-1.jpg').data.publicUrl, /supabase\.co\/storage/);
});

test('el CDN no entrega el archivo (502 cdn_unreachable): cae a Supabase y se pausa', async () => {
  let n = 0; const { db, supabaseUploads } = makeDb();
  load(['js/core/bunny-storage.js'], { db, fetchImpl: async () => { n++; return new Response(JSON.stringify({ ok: false, error: 'cdn_unreachable' }), { status: 502 }); } });
  await db.storage.from('og-media').upload('u/post-1.jpg', jpg(), {});
  await db.storage.from('og-media').upload('u/post-2.jpg', jpg(), {});
  assert.equal(supabaseUploads.length, 2); assert.equal(n, 1);
});

test('error de red hacia la función: cae a Supabase', async () => {
  const { db, supabaseUploads } = makeDb();
  load(['js/core/bunny-storage.js'], { db, fetchImpl: async () => { throw new TypeError('offline'); } });
  const r = await db.storage.from('og-media').upload('u/story-1-ab.jpg', jpg(), {});
  assert.equal(r.error, null); assert.equal(supabaseUploads.length, 1);
});

test('validación del servidor (413/415/429): se muestra el error, NO se salta a Supabase', async () => {
  for (const status of [413, 415, 429, 401, 403]) {
    const { db, supabaseUploads } = makeDb();
    load(['js/core/bunny-storage.js'], { db, fetchImpl: async () => new Response(JSON.stringify({ ok: false, error: 'x', message: 'Mensaje ' + status }), { status }) });
    const r = await db.storage.from('og-media').upload('u/avatar-1.jpg', jpg(), {});
    assert.equal(r.data, null); assert.equal(r.error.message, 'Mensaje ' + status);
    assert.equal(supabaseUploads.length, 0, 'status ' + status);
  }
});

test('sin sesión: error claro y no se llama a la función', async () => {
  let n = 0; const { db, supabaseUploads } = makeDb({ session: false });
  load(['js/core/bunny-storage.js'], { db, fetchImpl: async () => { n++; return new Response('{}'); } });
  const r = await db.storage.from('og-media').upload('u/post-1.jpg', jpg(), {});
  assert.ok(r.error); assert.equal(n, 0); assert.equal(supabaseUploads.length, 0);
});

test('convive con performance.js: la miniatura de Bunny se reconoce y la cadena de subida funciona', async () => {
  const calls = []; const { db, supabaseUploads } = makeDb();
  const ctx = load(['js/core/bunny-storage.js', 'js/core/performance.js'], { db, fetchImpl: okFetch(calls) });
  const r = await db.storage.from('og-media').upload('uid-1/post-1700.jpg', jpg(), { contentType: 'image/jpeg' });
  assert.equal(r.error, null);
  assert.equal(calls.length >= 1, true);
  assert.equal(supabaseUploads.length, 0);
  const t = ctx.window.ogThumbUrl;
  assert.equal(t(`${CDN}/users/uid-1/posts/post-1700.jpg`), `${CDN}/users/uid-1/posts/post-1700-t.jpg`);
  assert.equal(t(`${CDN}/users/uid-1/avatars/avatar-1.jpg`), `${CDN}/users/uid-1/avatars/avatar-1.jpg`);
  assert.equal(t('https://proj.supabase.co/storage/v1/object/public/og-media/u/post-5.jpg'), 'https://proj.supabase.co/storage/v1/object/public/og-media/u/post-5-t.jpg');
});
