/* Depende de: CDN de Supabase (window.supabase)
   Expone: SUPABASE_URL, SUPABASE_KEY, db */
const SUPABASE_URL = "https://axxafvggyetnnaumqefi.supabase.co";
const SUPABASE_KEY = "sb_publishable_O4wRZft0LCo3DYiCWT4iqg_E5_c8B2A";
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
 auth: {
  persistSession: true,
  autoRefreshToken: true,
  detectSessionInUrl: true,
  storage: window.localStorage
 }
});

/* Llamadas y videollamadas (WebRTC).
   Con STUN solo, funcionan en la mayoría de redes wifi, pero pueden fallar con datos móviles
   o redes estrictas. Para que funcionen siempre, agregá un servidor TURN (por ejemplo, el plan
   gratuito de Metered, Twilio o Cloudflare) y descomentá lo siguiente con tus datos:

   window.OG_ICE_SERVERS = [
     { urls: 'stun:stun.l.google.com:19302' },
     { urls: 'turn:TU-SERVIDOR-TURN:443?transport=tcp', username: 'USUARIO', credential: 'CLAVE' }
   ];
*/
