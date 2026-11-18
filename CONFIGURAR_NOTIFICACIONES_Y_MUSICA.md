# Pasos para activar todo

## 1. Música en publicaciones (obligatorio)
Supabase → SQL Editor → pega y ejecuta `supabase/01_musica_posts_y_push.sql`.
La música se elige de "Mis audios" o "Música libre" (Jamendo: pon tu Client ID en `js/features/audio-library.js`).

## 2. Notificaciones con la app abierta o en segundo plano
Ya funcionan sin configurar nada más: aviso arriba dentro de la app y notificación en el
centro de notificaciones del teléfono (la app debe seguir cargada en segundo plano).

## 3. Notificaciones con la app CERRADA (Web Push)
1. `npx web-push generate-vapid-keys`
2. Clave pública → `window.OG_VAPID_PUBLIC_KEY` en `js/config.js`.
3. Supabase CLI:
   supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:tu@correo.com PUSH_WEBHOOK_SECRET=una-clave-larga
   supabase functions deploy send-push --no-verify-jwt
4. Supabase → Database → Webhooks: crea uno por tabla (messages, likes, comments, follows), evento INSERT,
   tipo Edge Function `send-push`, header `x-webhook-secret` = tu PUSH_WEBHOOK_SECRET.

## iPhone
Solo funciona con la app instalada ("Añadir a pantalla de inicio") en iOS 16.4 o superior.
