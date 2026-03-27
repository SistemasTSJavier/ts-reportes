import { createRouter, createWebHistory, RouteRecordRaw } from 'vue-router';
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

export default router;

