import { createRouter, createWebHistory, RouteRecordRaw } from 'vue-router';
import { useAuthStore } from '../stores/authStore';
import HomeView from '../views/HomeView.vue';
import RegistroView from '../views/RegistroView.vue';
import PrivacyView from '../views/PrivacyView.vue';
import TermsView from '../views/TermsView.vue';
import SecuritySupportView from '../views/SecuritySupportView.vue';
import TemplateSetupView from '../views/TemplateSetupView.vue';

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'home',
    component: HomeView
  },
  {
    path: '/registro/new',
    name: 'registro-new',
    component: RegistroView
  },
  {
    path: '/registro/:id',
    name: 'registro-edit',
    component: RegistroView,
    props: true
  },
  {
    path: '/privacidad',
    name: 'privacy',
    component: PrivacyView
  },
  {
    path: '/terminos',
    name: 'terms',
    component: TermsView
  },
  {
    path: '/seguridad-soporte',
    name: 'security-support',
    component: SecuritySupportView
  },
  {
    path: '/template/setup',
    name: 'template-setup',
    component: TemplateSetupView
  }
];

const router = createRouter({
  history: createWebHistory(),
  routes
});

/** Rutas que usan API/Supabase: renovar JWT antes de entrar (reduce 401 tras inactividad). */
const ROUTES_NEED_SESSION_REFRESH = new Set(['home', 'registro-new', 'registro-edit', 'template-setup']);

router.beforeEach(async (to, _from, next) => {
  const auth = useAuthStore();
  const name = to.name;
  if (typeof name === 'string' && ROUTES_NEED_SESSION_REFRESH.has(name)) {
    if (typeof navigator !== 'undefined' && navigator.onLine) {
      try {
        if (auth.isSignedIn) {
          await auth.refreshSessionForApi({ force: false });
        }
      } catch {
        /* seguir navegando; el guard de pantalla mostrará error si hace falta */
      }
    }
  }

  // Flujo obligatorio: usuario autenticado debe crear plantilla antes de capturar registros.
  if (auth.isSignedIn && typeof name === 'string') {
    const bypass = new Set(['template-setup', 'privacy', 'terms', 'security-support']);
    if (!bypass.has(name)) {
      if (!auth.templateChecked) {
        await auth.ensureTemplateStatus();
      }
      if (!auth.templateReady) {
        next({ name: 'template-setup' });
        return;
      }
    }
  }
  next();
});

export default router;

