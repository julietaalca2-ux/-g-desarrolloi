/* ==========================================
   APP.JS - ÖG (PWA Social Network)
   Depende de: todos los módulos anteriores (config, state, utils, core/*, features/*)
   Se carga siempre al final. Solo inicializa la aplicación.
   ========================================== */

async function init() {
  updatePwaInstallButtonsVisibility();
  
  // Inicializar la sección LOORS (registra eventos y estados globales)
  if (typeof initLoors === 'function') {
    initLoors();
  }

  const { data } = await db.auth.getSession();
  if (data.session?.user) {
    await loadAccount(data.session.user);
    hideSplashScreen();
  } else {
    hideSplashScreen();
    showAuthOverlay();
  }
}

db.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_IN' && session?.user && !currentUser) {
    loadAccount(session.user);
  } else if (event === 'SIGNED_OUT') {
    currentUser = null;
    showAuthOverlay();
  }
});

// ==========================================
// CONTROL DE NAVEGACIÓN INFERIOR & LOORS
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  const loorsNavBtn = document.getElementById('nav-loors-btn');

  if (loorsNavBtn) {
    loorsNavBtn.addEventListener('click', () => {
      // 1. Ocultar el resto de secciones activas de ÖG
      document.querySelectorAll('.app-section, .tab-content, section[id$="-section"]').forEach(sec => {
        if (sec.id !== 'loors-section') sec.classList.remove('active');
      });
      document.querySelectorAll('.nav-item').forEach(btn => btn.classList.remove('active'));

      // 2. Activar la pestaña y abrir LOORS
      loorsNavBtn.classList.add('active');
      if (typeof openLoorsSection === 'function') {
        openLoorsSection();
      }
    });
  }

  // Al hacer clic en cualquier otra pestaña de navegación inferior (Inicio, Buscar, Mensajes, Perfil),
  // nos aseguramos de pausar y cerrar LOORS para que no quede reproduciéndose audio en segundo plano.
  const otherNavButtons = document.querySelectorAll('.nav-item:not(#nav-loors-btn)');
  otherNavButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      if (typeof closeLoorsSection === 'function') {
        closeLoorsSection();
      }
    });
  });
});

init();
