<template>
  <div class="space-y-6">
    <section>
      <h2 class="text-xl font-bold text-slate-800">Panel de administración</h2>
      <p class="text-sm text-slate-500 mt-1">
        Usuarios, registros, logo, carpeta OneDrive, códigos de acceso y bitácora de auditoría.
      </p>
    </section>

    <nav class="flex gap-1 border-b border-slate-200" aria-label="Secciones del panel">
      <button
        type="button"
        :class="tabButtonClass('manage')"
        @click="activeTab = 'manage'"
      >
        Gestión
      </button>
      <button
        type="button"
        :class="tabButtonClass('audit')"
        @click="switchToAuditTab"
      >
        Auditoría
      </button>
    </nav>

    <div v-show="activeTab === 'manage'" class="space-y-6">
    <section class="card p-4 sm:p-5 space-y-4">
      <h3 class="text-sm font-semibold text-slate-800">Nuevo código de acceso</h3>
      <div class="grid gap-3 sm:grid-cols-3">
        <div class="sm:col-span-2">
          <label class="block text-xs font-medium text-slate-600 mb-1">Etiqueta (opcional)</label>
          <input
            v-model="codeLabel"
            type="text"
            maxlength="80"
            placeholder="Ej. Cliente Castores"
            class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label class="block text-xs font-medium text-slate-600 mb-1">Usos máx.</label>
          <input
            v-model.number="codeMaxUses"
            type="number"
            min="1"
            max="100"
            class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </div>
      </div>
      <button type="button" class="btn-primary" :disabled="creatingCode" @click="createCode">
        {{ creatingCode ? 'Generando…' : 'Generar código' }}
      </button>
      <div
        v-if="generatedCode"
        class="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-950"
      >
        <p class="font-semibold">Código generado (cópialo ahora, no se volverá a mostrar):</p>
        <p class="mt-2 font-mono text-lg tracking-wider select-all">{{ generatedCode }}</p>
      </div>
    </section>

    <section class="card p-4 sm:p-5 space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="text-sm font-semibold text-slate-800">Usuarios y configuración</h3>
        <button type="button" class="text-xs text-tactical-blue font-semibold hover:underline" @click="loadUsers">
          Actualizar
        </button>
      </div>
      <p v-if="loadingUsers" class="text-sm text-slate-500">Cargando…</p>
      <div v-else-if="users.length === 0" class="text-sm text-slate-500">Sin usuarios registrados.</div>
      <ul v-else class="divide-y divide-slate-100">
        <li v-for="u in users" :key="u.user_id" class="py-4 space-y-3">
          <div class="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3">
            <div class="min-w-0 flex gap-3">
              <img
                v-if="logoUrl(u.service_logo_file)"
                :src="logoUrl(u.service_logo_file)"
                alt="Logo"
                class="h-12 w-16 object-contain rounded border border-slate-200 bg-white px-1 shrink-0"
              />
              <div
                v-else
                class="h-12 w-16 rounded border border-dashed border-slate-300 bg-slate-50 text-[10px] text-slate-400 flex items-center justify-center shrink-0"
              >
                Sin logo
              </div>
              <div class="min-w-0">
                <p class="text-sm font-medium text-slate-800 truncate">{{ u.email || u.user_id }}</p>
                <p class="text-xs text-slate-500 mt-0.5">
                  Estado:
                  <span :class="statusClass(u.status)">{{ statusLabel(u.status) }}</span>
                  · Registros: <strong class="text-slate-700">{{ u.registros_count ?? 0 }}</strong>
                </p>
                <p class="text-xs text-slate-500 mt-0.5">
                  Carpeta:
                  <span class="font-medium text-slate-700">{{
                    u.onedrive_subfolder_name || '— (usa id de usuario)'
                  }}</span>
                  <span v-if="u.onedrive_subfolder_locked" class="text-amber-700"> · bloqueada</span>
                  <span v-if="u.logo_locked" class="text-amber-700"> · logo bloqueado</span>
                </p>
                <p v-if="u.access_expires_at" class="text-xs text-indigo-700 mt-0.5">
                  Acceso temporal hasta {{ formatDate(u.access_expires_at) }}
                </p>
              </div>
            </div>

            <div class="flex flex-wrap gap-2 shrink-0">
              <button
                v-if="u.status !== 'approved'"
                type="button"
                class="btn-primary py-1.5 px-3 text-xs"
                :disabled="actingUserId === u.user_id"
                @click="setStatus(u.user_id, 'approved')"
              >
                Aprobar
              </button>
              <button
                v-if="u.status !== 'rejected'"
                type="button"
                class="btn-secondary py-1.5 px-3 text-xs"
                :disabled="actingUserId === u.user_id"
                @click="setStatus(u.user_id, 'rejected')"
              >
                Rechazar
              </button>
              <button
                v-if="u.status !== 'pending'"
                type="button"
                class="text-xs text-slate-600 hover:underline"
                :disabled="actingUserId === u.user_id"
                @click="setStatus(u.user_id, 'pending')"
              >
                Pendiente
              </button>
            </div>
          </div>

          <div class="rounded-md border border-indigo-100 bg-indigo-50/60 px-3 py-3 space-y-2">
            <p class="text-xs font-semibold text-indigo-900">Acceso temporal / eliminar</p>
            <div class="flex flex-wrap gap-2 items-center">
              <select
                v-model="tempAccessDays[u.user_id]"
                class="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs"
              >
                <option :value="7">7 días</option>
                <option :value="30">30 días</option>
                <option :value="90">90 días</option>
                <option :value="180">180 días</option>
              </select>
              <button
                type="button"
                class="btn-secondary py-1.5 px-3 text-xs"
                :disabled="actingUserId === u.user_id"
                @click="grantTemporaryAccess(u.user_id)"
              >
                Acceso temporal
              </button>
              <button
                type="button"
                class="text-xs text-rose-700 font-semibold hover:underline"
                :disabled="actingUserId === u.user_id"
                @click="deleteUserData(u.user_id, u.email || u.user_id)"
              >
                Eliminar datos
              </button>
            </div>
            <p class="text-[10px] text-indigo-800/80">
              «Eliminar datos» borra registros, storage y acceso. Luego elimina al usuario en Supabase → Authentication.
            </p>
          </div>

          <div class="rounded-md border border-slate-200 bg-slate-50/80 px-3 py-3 space-y-2">
            <p class="text-xs font-semibold text-slate-700">Carpeta OneDrive (admin puede cambiarla ya)</p>
            <p class="text-[11px] text-slate-500">
              Escribe <strong>DANFOSS</strong> o <strong>BSH</strong> (igual que en OneDrive) y guarda. El siguiente PDF usa este nombre.
            </p>
            <div class="flex flex-col sm:flex-row gap-2 sm:items-center">
              <input
                v-model="folderDrafts[u.user_id]"
                type="text"
                maxlength="120"
                placeholder="DANFOSS o BSH"
                class="flex-1 min-w-0 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm uppercase"
              />
              <button
                type="button"
                class="btn-secondary py-1.5 px-3 text-xs shrink-0"
                :disabled="actingUserId === u.user_id"
                @click="saveFolder(u.user_id)"
              >
                Guardar carpeta ahora
              </button>
            </div>
            <div class="flex flex-wrap gap-2">
              <button
                v-if="u.logo_locked"
                type="button"
                class="text-xs text-tactical-blue font-semibold hover:underline"
                :disabled="actingUserId === u.user_id"
                @click="setLock(u.user_id, { logoLocked: false })"
              >
                Desbloquear logo
              </button>
              <button
                v-else
                type="button"
                class="text-xs text-slate-600 hover:underline"
                :disabled="actingUserId === u.user_id"
                @click="setLock(u.user_id, { logoLocked: true })"
              >
                Bloquear logo
              </button>
              <button
                v-if="u.onedrive_subfolder_locked"
                type="button"
                class="text-xs text-tactical-blue font-semibold hover:underline"
                :disabled="actingUserId === u.user_id"
                @click="setLock(u.user_id, { onedriveSubfolderLocked: false })"
              >
                Desbloquear carpeta
              </button>
              <button
                v-else
                type="button"
                class="text-xs text-slate-600 hover:underline"
                :disabled="actingUserId === u.user_id"
                @click="setLock(u.user_id, { onedriveSubfolderLocked: true })"
              >
                Bloquear carpeta
              </button>
            </div>
          </div>
        </li>
      </ul>
    </section>

    <section class="card p-4 sm:p-5 space-y-3">
      <h3 class="text-sm font-semibold text-slate-800">Códigos emitidos</h3>
      <p v-if="loadingCodes" class="text-sm text-slate-500">Cargando…</p>
      <ul v-else-if="codes.length > 0" class="text-xs text-slate-600 space-y-2">
        <li v-for="c in codes" :key="c.id" class="border-b border-slate-100 pb-2">
          <span class="font-medium">{{ c.label || 'Sin etiqueta' }}</span>
          — usos {{ c.use_count }}/{{ c.max_uses }}
          <span v-if="c.expires_at"> — expira {{ formatDate(c.expires_at) }}</span>
          <span v-if="!c.is_active" class="text-rose-600"> (inactivo)</span>
        </li>
      </ul>
      <p v-else class="text-sm text-slate-500">Aún no hay códigos.</p>
    </section>
    </div>

    <div v-show="activeTab === 'audit'" class="space-y-4">
      <section class="card p-4 sm:p-5 space-y-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 class="text-sm font-semibold text-slate-800">Bitácora de auditoría</h3>
            <p class="text-xs text-slate-500 mt-0.5">
              Cambios en registros, acceso y configuración (solo lectura, inmutable).
            </p>
          </div>
          <button
            type="button"
            class="text-xs text-tactical-blue font-semibold hover:underline"
            @click="loadAuditLogs(true)"
          >
            Actualizar
          </button>
        </div>

        <div class="flex flex-wrap gap-2 items-end">
          <div>
            <label class="block text-xs font-medium text-slate-600 mb-1">Tabla</label>
            <select
              v-model="auditTableFilter"
              class="rounded-md border border-slate-300 px-2 py-1.5 text-sm bg-white"
              @change="loadAuditLogs(true)"
            >
              <option value="">Todas</option>
              <option value="registros_ctpat">registros_ctpat</option>
              <option value="user_access">user_access</option>
              <option value="user_drive_config">user_drive_config</option>
            </select>
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-600 mb-1">Acción</label>
            <select
              v-model="auditActionFilter"
              class="rounded-md border border-slate-300 px-2 py-1.5 text-sm bg-white"
              @change="loadAuditLogs(true)"
            >
              <option value="">Todas</option>
              <option value="INSERT">INSERT</option>
              <option value="UPDATE">UPDATE</option>
              <option value="DELETE">DELETE</option>
            </select>
          </div>
        </div>

        <p v-if="loadingAudit" class="text-sm text-slate-500">Cargando auditoría…</p>
        <p v-else-if="auditError" class="text-sm text-rose-700">{{ auditError }}</p>
        <p v-else-if="auditLogs.length === 0" class="text-sm text-slate-500">
          Sin eventos de auditoría todavía.
        </p>
        <div v-else class="overflow-x-auto -mx-1">
          <table class="min-w-full text-xs text-left">
            <thead>
              <tr class="border-b border-slate-200 text-slate-600">
                <th class="py-2 pr-3 font-semibold">Fecha</th>
                <th class="py-2 pr-3 font-semibold">Acción</th>
                <th class="py-2 pr-3 font-semibold">Tabla</th>
                <th class="py-2 pr-3 font-semibold">Registro</th>
                <th class="py-2 pr-3 font-semibold">Usuario</th>
                <th class="py-2 pr-3 font-semibold">Actor</th>
                <th class="py-2 font-semibold">Detalle</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <template v-for="log in auditLogs" :key="log.id">
                <tr class="align-top">
                  <td class="py-2 pr-3 text-slate-700 whitespace-nowrap">{{ formatDate(log.created_at) }}</td>
                  <td class="py-2 pr-3">
                    <span :class="auditActionClass(log.action)">{{ log.action }}</span>
                  </td>
                  <td class="py-2 pr-3 font-mono text-[11px] text-slate-700">
                    {{ shortTableName(log.table_name) }}
                  </td>
                  <td class="py-2 pr-3 font-mono text-[11px] text-slate-600 max-w-[8rem] truncate" :title="log.record_id">
                    {{ log.record_id || '—' }}
                  </td>
                  <td class="py-2 pr-3 text-slate-700 max-w-[10rem] truncate" :title="log.subject_email ?? log.subject_user_id ?? ''">
                    {{ log.subject_email || shortId(log.subject_user_id) }}
                  </td>
                  <td class="py-2 pr-3 text-slate-600 max-w-[10rem] truncate" :title="log.actor_email ?? log.actor_user_id ?? ''">
                    {{ log.actor_email || shortId(log.actor_user_id) || '—' }}
                  </td>
                  <td class="py-2">
                    <button
                      type="button"
                      class="text-tactical-blue font-semibold hover:underline"
                      @click="toggleAuditDetail(log.id)"
                    >
                      {{ expandedAuditIds.has(log.id) ? 'Ocultar' : 'Ver' }}
                    </button>
                  </td>
                </tr>
                <tr v-if="expandedAuditIds.has(log.id)">
                  <td colspan="7" class="pb-3 pt-0">
                    <div class="grid gap-2 sm:grid-cols-2 rounded-md border border-slate-200 bg-slate-50 p-3">
                      <div v-if="log.old_data">
                        <p class="text-[10px] font-semibold uppercase text-slate-500 mb-1">Antes</p>
                        <pre class="text-[10px] text-slate-700 whitespace-pre-wrap break-all max-h-48 overflow-auto">{{ formatAuditJson(log.old_data) }}</pre>
                      </div>
                      <div v-if="log.new_data">
                        <p class="text-[10px] font-semibold uppercase text-slate-500 mb-1">Después</p>
                        <pre class="text-[10px] text-slate-700 whitespace-pre-wrap break-all max-h-48 overflow-auto">{{ formatAuditJson(log.new_data) }}</pre>
                      </div>
                      <p v-if="!log.old_data && !log.new_data" class="text-[11px] text-slate-500 sm:col-span-2">
                        Sin datos adjuntos.
                      </p>
                    </div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>

        <div v-if="auditLogs.length > 0" class="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100">
          <p class="text-xs text-slate-500">
            Mostrando {{ auditLogs.length }} de {{ auditTotal }} eventos
          </p>
          <button
            v-if="auditLogs.length < auditTotal"
            type="button"
            class="btn-secondary py-1.5 px-3 text-xs"
            :disabled="loadingAudit"
            @click="loadAuditLogs(false)"
          >
            Cargar más
          </button>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import {
  useAccessStore,
  type AccessCodeRow,
  type AdminUserOverviewRow,
  type AuditLogAction,
  type AuditLogRow,
  type UserAccessStatus
} from '../stores/accessStore';
import { useToastStore } from '../stores/toastStore';
import { getServiceLogoPublicUrl } from '../utils/serviceLogoUrl';
import { sanitizeOnedriveSubfolderName } from '../stores/authStore';

const access = useAccessStore();
const toast = useToastStore();

const users = ref<AdminUserOverviewRow[]>([]);
const codes = ref<AccessCodeRow[]>([]);
const loadingUsers = ref(false);
const loadingCodes = ref(false);
const creatingCode = ref(false);
const actingUserId = ref<string | null>(null);
const codeLabel = ref('');
const codeMaxUses = ref(1);
const generatedCode = ref('');
const folderDrafts = reactive<Record<string, string>>({});
const tempAccessDays = reactive<Record<string, number>>({});

type AdminTab = 'manage' | 'audit';
const activeTab = ref<AdminTab>('manage');

const auditLogs = ref<AuditLogRow[]>([]);
const auditTotal = ref(0);
const auditOffset = ref(0);
const auditPageSize = 50;
const loadingAudit = ref(false);
const auditError = ref('');
const auditTableFilter = ref('');
const auditActionFilter = ref<AuditLogAction | ''>('');
const expandedAuditIds = ref(new Set<string>());
const auditLoadedOnce = ref(false);

function tabButtonClass(tab: AdminTab): string {
  const base = 'px-4 py-2 text-sm font-semibold border-b-2 -mb-px transition-colors';
  if (activeTab.value === tab) {
    return `${base} border-tactical-blue text-tactical-blue`;
  }
  return `${base} border-transparent text-slate-500 hover:text-slate-700`;
}

function statusLabel(s: UserAccessStatus): string {
  if (s === 'approved') return 'Aprobado';
  if (s === 'rejected') return 'Rechazado';
  return 'Pendiente';
}

function statusClass(s: UserAccessStatus): string {
  if (s === 'approved') return 'text-emerald-700 font-semibold';
  if (s === 'rejected') return 'text-rose-700 font-semibold';
  return 'text-amber-700 font-semibold';
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function logoUrl(file: string | null | undefined): string {
  return getServiceLogoPublicUrl(file);
}

function shortTableName(name: string): string {
  return name.replace(/^public\./, '');
}

function shortId(id: string | null | undefined): string {
  if (!id) return '—';
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function auditActionClass(action: AuditLogAction): string {
  if (action === 'INSERT') return 'text-emerald-700 font-semibold';
  if (action === 'DELETE') return 'text-rose-700 font-semibold';
  return 'text-amber-700 font-semibold';
}

function formatAuditJson(data: Record<string, unknown>): string {
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

function toggleAuditDetail(id: string) {
  const next = new Set(expandedAuditIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedAuditIds.value = next;
}

async function loadAuditLogs(reset: boolean) {
  if (reset) {
    auditOffset.value = 0;
    auditLogs.value = [];
    expandedAuditIds.value = new Set();
  }

  loadingAudit.value = true;
  auditError.value = '';
  try {
    const res = await access.adminListAuditLogs({
      limit: auditPageSize,
      offset: auditOffset.value,
      tableFilter: auditTableFilter.value,
      actionFilter: auditActionFilter.value
    });
    if (!res.ok) {
      auditError.value =
        res.error ??
        'No se pudo cargar auditoría. Ejecuta scripts/fix-admin-audit-logs.sql en Supabase.';
      if (reset) auditLogs.value = [];
      return;
    }
    auditTotal.value = res.total;
    if (reset) {
      auditLogs.value = res.logs;
    } else {
      auditLogs.value = [...auditLogs.value, ...res.logs];
    }
    auditOffset.value = auditLogs.value.length;
    auditLoadedOnce.value = true;
  } finally {
    loadingAudit.value = false;
  }
}

function switchToAuditTab() {
  activeTab.value = 'audit';
  if (!auditLoadedOnce.value) {
    void loadAuditLogs(true);
  }
}

async function loadUsers() {
  loadingUsers.value = true;
  const res = await access.adminListUserOverview();
  loadingUsers.value = false;
  if (!res.ok) {
    // Fallback si aún no aplicaron la migración del overview
    const legacy = await access.adminListUsers();
    if (!legacy.ok) {
      toast.error('Error', res.error ?? legacy.error ?? 'No se pudo cargar usuarios.');
      return;
    }
    users.value = legacy.users.map((u) => ({
      ...u,
      access_expires_at: null,
      registros_count: 0,
      service_logo_file: null,
      onedrive_subfolder_name: null,
      logo_locked: false,
      onedrive_subfolder_locked: false,
      has_drive_config: false
    }));
    toast.info(
      'Panel parcial',
      'Ejecuta scripts/fix-admin-panel-overview.sql en Supabase para ver registros, logo y carpeta.'
    );
    return;
  }
  users.value = res.users;
  for (const u of res.users) {
    folderDrafts[u.user_id] = u.onedrive_subfolder_name ?? '';
    if (tempAccessDays[u.user_id] == null) {
      tempAccessDays[u.user_id] = 30;
    }
  }
}

async function loadCodes() {
  loadingCodes.value = true;
  const res = await access.adminListCodes();
  loadingCodes.value = false;
  if (!res.ok) {
    toast.error('Error', res.error ?? 'No se pudo cargar códigos.');
    return;
  }
  codes.value = res.codes;
}

async function createCode() {
  creatingCode.value = true;
  generatedCode.value = '';
  try {
    const res = await access.adminCreateCode({
      label: codeLabel.value,
      maxUses: codeMaxUses.value
    });
    if (!res.ok || !res.code) {
      toast.error('Error', res.error ?? 'No se pudo generar el código.');
      return;
    }
    generatedCode.value = res.code;
    toast.success('Código creado', 'Compártelo con el usuario autorizado.');
    await loadCodes();
  } finally {
    creatingCode.value = false;
  }
}

async function setStatus(userId: string, status: UserAccessStatus) {
  actingUserId.value = userId;
  try {
    const res = await access.adminSetUserAccess(userId, status, null);
    if (!res.ok) {
      toast.error('Error', res.error ?? 'No se pudo actualizar.');
      return;
    }
    toast.success('Actualizado', `Usuario marcado como ${statusLabel(status).toLowerCase()}.`);
    await loadUsers();
  } finally {
    actingUserId.value = null;
  }
}

async function grantTemporaryAccess(userId: string) {
  actingUserId.value = userId;
  try {
    const days = tempAccessDays[userId] ?? 30;
    const res = await access.adminGrantTemporaryAccess(userId, days);
    if (!res.ok) {
      toast.error('Acceso temporal', res.error ?? 'No se pudo otorgar.');
      return;
    }
    toast.success(
      'Acceso temporal',
      res.accessExpiresAt
        ? `Aprobado hasta ${formatDate(res.accessExpiresAt)}.`
        : `Aprobado por ${days} días.`
    );
    await loadUsers();
  } finally {
    actingUserId.value = null;
  }
}

async function deleteUserData(userId: string, label: string) {
  const ok = window.confirm(
    `¿Eliminar TODOS los datos de «${label}»?\n\nSe borran registros, logos, PDFs y acceso. Después debes eliminar al usuario en Supabase → Authentication.`
  );
  if (!ok) return;

  actingUserId.value = userId;
  try {
    const res = await access.adminPrepareUserDelete(userId);
    if (!res.ok) {
      toast.error('Eliminar', res.error ?? 'No se pudo eliminar.');
      return;
    }
    toast.success(
      'Datos eliminados',
      res.message ??
        'Datos públicos y storage limpiados. Completa el borrado en Supabase → Authentication → Users.'
    );
    await loadUsers();
  } finally {
    actingUserId.value = null;
  }
}

async function saveFolder(userId: string) {
  actingUserId.value = userId;
  try {
    const name = sanitizeOnedriveSubfolderName(folderDrafts[userId] ?? '') ?? '';
    folderDrafts[userId] = name;
    const res = await access.adminUpdateUserDriveConfig({
      userId,
      onedriveSubfolder: name,
      setOnedriveSubfolder: true,
      onedriveSubfolderLocked: true
    });
    if (!res.ok) {
      toast.error('Carpeta', res.error ?? 'No se pudo guardar.');
      return;
    }
    toast.success(
      'Carpeta actualizada',
      name
        ? `Nombre guardado. El primer PDF creará PDF-TACTICAL-SUPPORT/${name} en OneDrive.`
        : 'Nombre guardado en la app.'
    );
    await loadUsers();
  } finally {
    actingUserId.value = null;
  }
}

async function setLock(
  userId: string,
  opts: { logoLocked?: boolean; onedriveSubfolderLocked?: boolean }
) {
  actingUserId.value = userId;
  try {
    const res = await access.adminUpdateUserDriveConfig({
      userId,
      logoLocked: opts.logoLocked ?? null,
      onedriveSubfolderLocked: opts.onedriveSubfolderLocked ?? null
    });
    if (!res.ok) {
      toast.error('Bloqueo', res.error ?? 'No se pudo actualizar.');
      return;
    }
    toast.success(
      'Listo',
      opts.onedriveSubfolderLocked === false
        ? 'Carpeta desbloqueada. El usuario verá el cambio al volver a Home y podrá guardarla.'
        : 'Permisos de configuración actualizados.'
    );
    await loadUsers();
  } finally {
    actingUserId.value = null;
  }
}

onMounted(() => {
  void loadUsers();
  void loadCodes();
});
</script>
