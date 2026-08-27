import { defineStore } from 'pinia';
import { supabase } from '../supabaseClient';

export type UserAccessStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface AccessUserRow {
  user_id: string;
  email: string | null;
  status: UserAccessStatus;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AdminUserOverviewRow extends AccessUserRow {
  access_expires_at: string | null;
  registros_count: number;
  service_logo_file: string | null;
  onedrive_subfolder_name: string | null;
  logo_locked: boolean;
  onedrive_subfolder_locked: boolean;
  has_drive_config: boolean;
}

export interface AccessCodeRow {
  id: string;
  label: string | null;
  max_uses: number;
  use_count: number;
  expires_at: string | null;
  is_active: boolean;
  created_at: string;
}

export type AuditLogAction = 'INSERT' | 'UPDATE' | 'DELETE';

export interface AuditLogRow {
  id: string;
  created_at: string;
  action: AuditLogAction;
  table_name: string;
  record_id: string;
  actor_user_id: string | null;
  actor_email: string | null;
  subject_user_id: string | null;
  subject_email: string | null;
  old_data: Record<string, unknown> | null;
  new_data: Record<string, unknown> | null;
}

interface AccessState {
  ready: boolean;
  loading: boolean;
  status: UserAccessStatus | null;
  isAdmin: boolean;
  aal: string | null;
}

export const useAccessStore = defineStore('access', {
  state: (): AccessState => ({
    ready: false,
    loading: false,
    status: null,
    isAdmin: false,
    aal: null
  }),
  getters: {
    isApproved: (s) => s.status === 'approved',
    isPending: (s) => s.status === 'pending' || s.status === 'expired',
    isRejected: (s) => s.status === 'rejected',
    needsMfa: (s) => s.isAdmin && s.aal !== 'aal2'
  },
  actions: {
    reset() {
      this.ready = false;
      this.loading = false;
      this.status = null;
      this.isAdmin = false;
      this.aal = null;
    },
    async syncContext(): Promise<void> {
      this.loading = true;
      try {
        const { data, error } = await supabase.rpc('sync_user_access_context');
        if (error) {
          console.error('[accessStore] sync_user_access_context:', error.message);
          this.status = 'pending';
          this.isAdmin = false;
          this.aal = null;
          return;
        }
        const row = data as {
          ok?: boolean;
          status?: UserAccessStatus;
          is_admin?: boolean;
          aal?: string;
        } | null;
        if (row?.ok) {
          this.status = row.status ?? 'pending';
          this.isAdmin = row.is_admin === true;
          this.aal = row.aal ?? 'aal1';
        } else {
          this.status = 'pending';
          this.isAdmin = false;
          this.aal = null;
        }
      } finally {
        this.ready = true;
        this.loading = false;
      }
    },
    async redeemCode(code: string): Promise<{ ok: boolean; error?: string }> {
      const trimmed = code.trim();
      if (!trimmed) {
        return { ok: false, error: 'Escribe el código de acceso.' };
      }
      const { data, error } = await supabase.rpc('redeem_access_code', { p_code: trimmed });
      if (error) {
        return { ok: false, error: error.message };
      }
      const row = data as { ok?: boolean; error?: string; status?: UserAccessStatus } | null;
      if (!row?.ok) {
        return { ok: false, error: row?.error ?? 'Código inválido.' };
      }
      this.status = row.status ?? 'approved';
      return { ok: true };
    },
    async adminCreateCode(options?: {
      label?: string;
      maxUses?: number;
      expiresDays?: number | null;
    }): Promise<{ ok: boolean; code?: string; error?: string }> {
      const { data, error } = await supabase.rpc('admin_create_access_code', {
        p_label: options?.label?.trim() || null,
        p_max_uses: options?.maxUses ?? 1,
        p_expires_days: options?.expiresDays ?? null
      });
      if (error) {
        return { ok: false, error: error.message };
      }
      const row = data as { ok?: boolean; code?: string; error?: string } | null;
      if (!row?.ok || !row.code) {
        return { ok: false, error: row?.error ?? 'No se pudo crear el código.' };
      }
      return { ok: true, code: row.code };
    },
    async adminSetUserAccess(
      userId: string,
      status: UserAccessStatus,
      accessExpiresAt?: string | null
    ): Promise<{ ok: boolean; error?: string }> {
      const { data, error } = await supabase.rpc('admin_set_user_access', {
        p_user_id: userId,
        p_status: status,
        p_access_expires_at: accessExpiresAt ?? null
      });
      if (error) {
        return { ok: false, error: error.message };
      }
      const row = data as { ok?: boolean; error?: string } | null;
      if (!row?.ok) {
        return { ok: false, error: row?.error ?? 'No se pudo actualizar.' };
      }
      return { ok: true };
    },
    async adminListUsers(): Promise<{ ok: boolean; users: AccessUserRow[]; error?: string }> {
      const { data, error } = await supabase.rpc('admin_list_user_access');
      if (error) {
        return { ok: false, users: [], error: error.message };
      }
      const row = data as { ok?: boolean; users?: AccessUserRow[]; error?: string } | null;
      if (!row?.ok) {
        return { ok: false, users: [], error: row?.error ?? 'No autorizado.' };
      }
      return { ok: true, users: row.users ?? [] };
    },
    async adminListUserOverview(): Promise<{
      ok: boolean;
      users: AdminUserOverviewRow[];
      error?: string;
    }> {
      const { data, error } = await supabase.rpc('admin_list_user_overview');
      if (error) {
        return { ok: false, users: [], error: error.message };
      }
      const row = data as { ok?: boolean; users?: AdminUserOverviewRow[]; error?: string } | null;
      if (!row?.ok) {
        return { ok: false, users: [], error: row?.error ?? 'No autorizado.' };
      }
      return { ok: true, users: row.users ?? [] };
    },
    async adminUpdateUserDriveConfig(options: {
      userId: string;
      onedriveSubfolder?: string | null;
      setOnedriveSubfolder?: boolean;
      logoLocked?: boolean | null;
      onedriveSubfolderLocked?: boolean | null;
    }): Promise<{ ok: boolean; error?: string }> {
      const { data, error } = await supabase.rpc('admin_update_user_drive_config', {
        p_user_id: options.userId,
        p_onedrive_subfolder: options.onedriveSubfolder ?? null,
        p_set_onedrive_subfolder: options.setOnedriveSubfolder === true,
        p_logo_locked: options.logoLocked ?? null,
        p_onedrive_subfolder_locked: options.onedriveSubfolderLocked ?? null
      });
      if (error) {
        return { ok: false, error: error.message };
      }
      const row = data as { ok?: boolean; error?: string } | null;
      if (!row?.ok) {
        return { ok: false, error: row?.error ?? 'No se pudo actualizar.' };
      }
      return { ok: true };
    },
    async adminListCodes(): Promise<{ ok: boolean; codes: AccessCodeRow[]; error?: string }> {
      const { data, error } = await supabase.rpc('admin_list_access_codes');
      if (error) {
        return { ok: false, codes: [], error: error.message };
      }
      const row = data as { ok?: boolean; codes?: AccessCodeRow[]; error?: string } | null;
      if (!row?.ok) {
        return { ok: false, codes: [], error: row?.error ?? 'No autorizado.' };
      }
      return { ok: true, codes: row.codes ?? [] };
    },
    async adminGrantTemporaryAccess(
      userId: string,
      days: number
    ): Promise<{ ok: boolean; error?: string; accessExpiresAt?: string | null }> {
      const { data, error } = await supabase.rpc('admin_grant_temporary_access', {
        p_user_id: userId,
        p_days: days
      });
      if (error) {
        return { ok: false, error: error.message };
      }
      const row = data as {
        ok?: boolean;
        error?: string;
        access_expires_at?: string | null;
      } | null;
      if (!row?.ok) {
        return { ok: false, error: row?.error ?? 'No se pudo otorgar acceso temporal.' };
      }
      return { ok: true, accessExpiresAt: row.access_expires_at ?? null };
    },
    async adminPrepareUserDelete(
      userId: string
    ): Promise<{ ok: boolean; error?: string; message?: string }> {
      const { data: sessionData } = await supabase.auth.getSession();
      const jwt = sessionData.session?.access_token?.trim();
      const baseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim().replace(/\/$/, '');
      const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim();
      if (!jwt || !baseUrl || !anonKey) {
        return { ok: false, error: 'No hay sesión para eliminar el usuario.' };
      }
      try {
        const res = await fetch(`${baseUrl}/functions/v1/admin-delete-user`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${jwt}`,
            apikey: anonKey
          },
          body: JSON.stringify({ userId })
        });
        const row = (await res.json().catch(() => null)) as {
          ok?: boolean;
          error?: string;
          message?: string;
          warning?: string;
        } | null;
        if (!res.ok || !row?.ok) {
          return { ok: false, error: row?.error ?? `HTTP ${res.status}` };
        }
        return {
          ok: true,
          message: row.message ?? row.warning ?? 'Usuario eliminado.'
        };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'Error de red.' };
      }
    },
    async adminListAuditLogs(options?: {
      limit?: number;
      offset?: number;
      tableFilter?: string;
      actionFilter?: AuditLogAction | '';
    }): Promise<{
      ok: boolean;
      logs: AuditLogRow[];
      total: number;
      error?: string;
    }> {
      const { data, error } = await supabase.rpc('admin_list_audit_logs', {
        p_limit: options?.limit ?? 50,
        p_offset: options?.offset ?? 0,
        p_table_filter: options?.tableFilter?.trim() || null,
        p_action_filter: options?.actionFilter?.trim() || null
      });
      if (error) {
        return { ok: false, logs: [], total: 0, error: error.message };
      }
      const row = data as {
        ok?: boolean;
        logs?: AuditLogRow[];
        total?: number;
        error?: string;
      } | null;
      if (!row?.ok) {
        return { ok: false, logs: [], total: 0, error: row?.error ?? 'No autorizado.' };
      }
      return { ok: true, logs: row.logs ?? [], total: row.total ?? 0 };
    }
  }
});
