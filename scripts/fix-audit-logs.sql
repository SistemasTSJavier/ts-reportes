-- =============================================================================
-- FIX RÁPIDO: audit_logs inmutable + triggers en registros, acceso y drive config
-- Pegar en: Supabase → SQL Editor → Run
-- =============================================================================

-- Registro de auditoría inmutable (append-only) para cambios críticos en C-TPAT.

begin;

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  actor_user_id uuid null references auth.users (id) on delete set null,
  action text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  table_name text not null,
  record_id text not null,
  subject_user_id uuid null references auth.users (id) on delete set null,
  old_data jsonb null,
  new_data jsonb null
);

comment on table public.audit_logs is
  'Bitácora append-only de cambios en registros y configuración de usuario. Sin UPDATE/DELETE.';

create index if not exists idx_audit_logs_created_at on public.audit_logs (created_at desc);
create index if not exists idx_audit_logs_subject_user on public.audit_logs (subject_user_id, created_at desc);
create index if not exists idx_audit_logs_table_record on public.audit_logs (table_name, record_id);

alter table public.audit_logs enable row level security;

drop policy if exists audit_logs_select_own_or_admin on public.audit_logs;
create policy audit_logs_select_own_or_admin
on public.audit_logs
for select
to authenticated
using (
  public.is_app_admin()
  or actor_user_id = auth.uid()
  or subject_user_id = auth.uid()
);

revoke update, delete on public.audit_logs from authenticated, anon;

create or replace function public.audit_log_row_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_record_id text;
  v_subject uuid;
begin
  if tg_op = 'DELETE' then
    v_old := to_jsonb(old);
    v_new := null;
    v_record_id := coalesce(v_old->>'id', v_old->>'user_id', '');
    v_subject := coalesce(
      nullif(v_old->>'user_id', '')::uuid,
      nullif(v_old->>'id', '')::uuid
    );
    insert into public.audit_logs (
      actor_user_id, action, table_name, record_id, subject_user_id, old_data, new_data
    ) values (
      auth.uid(), 'DELETE', tg_table_schema || '.' || tg_table_name,
      v_record_id, v_subject, v_old, null
    );
    return old;
  elsif tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);
    v_record_id := coalesce(v_new->>'id', v_new->>'user_id', '');
    v_subject := coalesce(
      nullif(v_new->>'user_id', '')::uuid,
      nullif(v_new->>'id', '')::uuid
    );
    insert into public.audit_logs (
      actor_user_id, action, table_name, record_id, subject_user_id, old_data, new_data
    ) values (
      auth.uid(), 'UPDATE', tg_table_schema || '.' || tg_table_name,
      v_record_id, v_subject, v_old, v_new
    );
    return new;
  elsif tg_op = 'INSERT' then
    v_new := to_jsonb(new);
    v_record_id := coalesce(v_new->>'id', v_new->>'user_id', '');
    v_subject := coalesce(
      nullif(v_new->>'user_id', '')::uuid,
      nullif(v_new->>'id', '')::uuid
    );
    insert into public.audit_logs (
      actor_user_id, action, table_name, record_id, subject_user_id, old_data, new_data
    ) values (
      auth.uid(), 'INSERT', tg_table_schema || '.' || tg_table_name,
      v_record_id, v_subject, null, v_new
    );
    return new;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_audit_registros_ctpat on public.registros_ctpat;
create trigger trg_audit_registros_ctpat
after insert or update or delete on public.registros_ctpat
for each row execute function public.audit_log_row_change();

drop trigger if exists trg_audit_user_access on public.user_access;
create trigger trg_audit_user_access
after insert or update or delete on public.user_access
for each row execute function public.audit_log_row_change();

drop trigger if exists trg_audit_user_drive_config on public.user_drive_config;
create trigger trg_audit_user_drive_config
after insert or update or delete on public.user_drive_config
for each row execute function public.audit_log_row_change();

commit;
