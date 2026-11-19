# ÖG + Bunny.net Storage

Las fotos de perfil, imágenes de publicaciones, historias, destacadas y videos de Loors se guardan en Bunny
(zona `og-media-storage`, São Paulo). La app sube a través de la Edge Function `bunny-upload`; la contraseña de
Bunny vive solo en los secretos de Supabase y nunca llega al navegador.

## Qué hace cada pieza
- `supabase/functions/bunny-upload/` — la función: valida sesión, tipo real (por los bytes) y tamaño, y guarda en Bunny.
- `js/core/bunny-storage.js` — el frontend: intercepta las subidas existentes y usa la función. Si falla la configuración, cae a Supabase Storage.
- `js/core/performance.js` — ajuste mínimo para que las miniaturas `-t.jpg` también funcionen con direcciones de Bunny.
- `.github/workflows/deploy-bunny-upload.yml` — despliega la función desde GitHub (sin comandos).
- `bunny-test.html` — página de prueba para el iPhone (no forma parte de la app; se puede borrar cuando ya no la necesites).

## Rutas en Bunny
`users/<id-usuario>/<tipo>/<archivo>`
- `avatars/` fotos de perfil · `posts/` fotos de publicaciones (+ miniatura `-t.jpg`) · `highlights/` portadas de destacadas
- `stories/` historias · `loors/` videos · `loors/thumbs/` miniaturas de videos

El `<id-usuario>` lo toma la función del token de sesión; el cliente no puede escribir en carpetas de otros.

## Límites (cambiar en `KINDS` de `handler.ts`)
| Tipo | Formatos | Máximo |
|---|---|---|
| Foto de perfil | JPG, PNG, WebP | 5 MB |
| Publicación | JPG, PNG, WebP, GIF | 10 MB |
| Destacada | JPG, PNG, WebP | 5 MB |
| Historia | foto 10 MB · video MP4/MOV/WebM 40 MB | |
| Loor | MP4, MOV, WebM | 80 MB |
| Miniatura de Loor | JPG, PNG, WebP | 2 MB |

Además: 40 subidas por minuto por usuario, cuentas anónimas rechazadas.

## Configuración (ya hecha en Bunny)
- Storage Zone `og-media-storage` (São Paulo) ← Pull Zone `ogmedia` (origen: Storage Zone, SSL activo).
- Dirección pública: `https://ogmedia.b-cdn.net` (ya viene por defecto en la función; el secreto `BUNNY_CDN_URL` es opcional).

## Secretos de Supabase (Edge Functions → Secrets)
| Secreto | Obligatorio | Valor |
|---|---|---|
| `BUNNY_STORAGE_ZONE` | sí | `og-media-storage` |
| `BUNNY_STORAGE_HOST` | sí | `br.storage.bunnycdn.com` (São Paulo) |
| `BUNNY_STORAGE_PASSWORD` | sí | contraseña de la Storage Zone (Storage Zone → FTP & API Access → Password) |
| `BUNNY_CDN_URL` | no | `https://ogmedia.b-cdn.net` (solo si algún día cambia la dirección) |
| `BUNNY_VERIFY_CDN` | no | `0` para saltar la comprobación del CDN |

## Poner en marcha (una sola vez)
1. Subir todo el proyecto al repo (o los archivos nuevos/modificados).
2. **Supabase → Account → Access Tokens**: generar un token. **GitHub → repo → Settings → Secrets and variables → Actions**: crear `SUPABASE_ACCESS_TOKEN` con ese valor.
3. **GitHub → Actions → "Desplegar bunny-upload" → Run workflow**.

## Cómo funciona la comprobación del CDN
Después de guardar cada archivo en Bunny, la función pide el primer byte por `https://ogmedia.b-cdn.net/...`.
Si el CDN no lo entrega (Pull Zone mal conectada, dirección equivocada), borra el archivo, responde `cdn_unreachable`
y la app sube a Supabase como antes. Así ÖG nunca guarda una dirección que dé 404.

## Probar que Bunny funciona (desde el iPhone)
1. Abrí ÖG e iniciá sesión. Después abrí la misma dirección de tu app agregando `bunny-test.html` al final (ej. `…/og-mobile-dev/bunny-test.html`), en el mismo navegador.
2. Arriba debe decir "✔ Sesión iniciada".
3. **Paso 1**: elegí una foto. Debe decir "✔ Subido a Bunny", mostrar una dirección que empiece con `https://ogmedia.b-cdn.net/users/…/posts/` y debajo "✔ Se carga bien desde el CDN".
4. **Paso 2**: elegí un video corto; mismo resultado con una dirección `…/loors/…` y el video reproducible.
5. En Bunny → Storage → `og-media-storage` deben aparecer los archivos `bunnytest-….jpg` y `bunnytest-….mp4` dentro de `users/<tu-id>/`.
6. Probar en la app: publicar una foto, cambiar la foto de perfil, subir una historia y un Loor. En Bunny aparecen en `posts/`, `avatars/`, `stories/` y `loors/`.

Si aparece un error rojo: "No se pudo conectar…" o "(HTTP 404)" = la función no está desplegada; `cdn_unreachable` = revisar la Pull Zone; otro mensaje = ver el texto. En esos casos la app sigue subiendo a Supabase. Los archivos de prueba `bunnytest-*` se pueden borrar desde Bunny.

## Opcional en Bunny
- Pull Zone → Headers → activar "Add CORS headers" (solo para diagnósticos con `fetch`; no hace falta para ver fotos y videos).
- Pull Zone → Caching → Browser cache expiration: 1 año. Los nombres de archivo son únicos, así que es seguro.

## Pruebas
```
node --experimental-strip-types --no-warnings --test supabase/functions/bunny-upload/handler.test.ts
node --test tests/bunny-storage.test.mjs
```
