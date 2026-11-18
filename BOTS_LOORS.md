# Bots de Loors (100 cuentas, hasta 5 videos/día cada una)
1. Supabase > SQL Editor: pegar y ejecutar `supabase/04_bots_loors.sql` (idempotente).
2. Database > Extensions: activar `pg_cron` y volver a ejecutar el SQL (programa la tarea cada 10 min).
3. Subir tus videos (.mp4) al bucket `loors_videos`, carpeta `bots/`, y registrarlos en `bot_video_library` (ejemplo al final del SQL). Temas: viajes, cocina, fitness, humor, musica, mascotas, arte, tecnologia, moda, naturaleza, deportes, baile, o `general`.
4. Prueba: `select public.bots_publish_due(5);`  Pausar: `update public.bot_accounts set active=false;`

# Seguridad (v1.6.9)
- `vercel.json`: HSTS, CSP, anti-clickjacking, nosniff, Permissions-Policy (se aplica solo al desplegar en Vercel).
- `supabase/05_seguridad.sql`: límites de frecuencia, límite de longitud de textos, bloqueos y reportes, auditoría (`select * from security_audit();`).
- Anti-XSS: `ogEsc()` en utils.js aplicado a nombres de usuario/títulos que iban sin escapar.

# Correcciones v1.6.9 (revisión final)
- Service Worker subido a 1.6.9: evita que el navegador use un utils.js viejo sin `ogEsc()`.
- Agregado `icons/icon-maskable-512.png` (lo pedía manifest.json y no existía).
- SQL 04: si pg_cron no está activado, el script termina bien (avisa y se programa al activarlo).
- SQL 05: el límite de longitud solo se aplica cuando el texto cambia (no rompe perfiles viejos).
- vercel.json: la política de contenido permite `data:` en media.

# Orden de uso
1. Subir el contenido de esta carpeta a GitHub (Vercel despliega solo; `vercel.json` ya está en la raíz).
2. Supabase > SQL Editor: ejecutar `04_bots_loors.sql` y luego `05_seguridad.sql`.
3. Subir los videos de los bots y registrarlos en `bot_video_library` (ver final del 04).
