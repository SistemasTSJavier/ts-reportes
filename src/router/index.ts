import { createRouter, createWebHistory, RouteRecordRaw } from 'vue-router';
import { useAuthStore } from '../stores/authStore';
import { useToastStore } from '../stores/toastStore';
import { preflightCameraForRegistro } from '../utils/cameraPermission';
import HomeView from '../views/HomeView.vue';
import RegistroView from '../views/RegistroView.vue';
import PrivacyView from '../views/PrivacyView.vue';
import TermsView from '../views/TermsView.vue';
import SecuritySupportView from '../views/SecuritySupportView.vue';

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
  }
];

const router = createRouter({
  history: createWebHistory(),
  routes
});

/** Rutas que usan API/Supabase: renovar JWT antes de entrar (reduce 401 tras inactividad). */
const ROUTES_NEED_SESSION_REFRESH = new Set(['home', 'registro-new', 'registro-edit']);

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

  if (name === 'registro-new' || name === 'registro-edit') {
    const cam = await preflightCameraForRegistro();
    if (cam === 'denied') {
      const toast = useToastStore();
      toast.error(
        'Cámara requerida',
        'Debes permitir el acceso a la cámara para usar el registro. Revisa los permisos del sitio en el navegador e inténtalo de nuevo.'
      );
      return next({ name: 'home', replace: true });
    }
    if (cam === 'unsupported') {
      const toast = useToastStore();
      toast.info(
        'Cámara no disponible',
        'Este entorno no permite solicitar la cámara (por ejemplo HTTP sin HTTPS). Podrás adjuntar fotos desde la galería si el navegador lo permite.'
      );
    }
  }

  next();
});

export default router;

