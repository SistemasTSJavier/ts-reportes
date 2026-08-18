-- =============================================================================
-- FIX: dedupe registros + acceso temporal + admin delete (panel)
-- Pegar en Supabase → SQL Editor → Run
-- =============================================================================

begin;

drop function if exists public.admin_set_user_access(uuid, text);

alter table public.registros_ctpat
  add column if not exists client_request_id uuid null;

create unique index if not exists idx_registros_user_client_request
  on public.registros_ctpat (user_id, client_request_id)
  where client_request_id is not null;

alter table public.user_access
  add column if not exists access_expires_at timestamptz null;

create or replace function public.is_user_approved()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_access ua
    where ua.user_id = auth.uid()
      and ua.status = 'approved'
      and (ua.access_expires_at is null or ua.access_expires_at > now())
  );
$$;

create or replace function public.admin_set_user_access(
  p_user_id uuid,
  p_status text,
  p_access_expires_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_app_admin() then
    return jsonb_build_object('ok', false, 'error', 'No autorizado.');
  end if;
  if p_user_id is null then
    return jsonb_build_object('ok', false, 'error', 'user_id requerido.');
  end if;
  if p_status not in ('pending', 'approved', 'rejected') then
    return jsonb_build_object('ok', false, 'error', 'Estado inválido.');
  end if;
  update public.user_access
  set
    status = p_status,
    approved_at = case when p_status = 'approved' then coalesce(approved_at, now()) else null end,
    approved_by = case when p_status = 'approved' then auth.uid() else approved_by end,
    access_expires_at = case when p_status = 'approved' then p_access_expires_at else null end,
    updated_at = now()
  where user_id = p_user_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Usuario no encontrado.');
  end if;
  return jsonb_build_object('ok', true, 'status', p_status, 'access_expires_at', p_access_expires_at);
end;
$$;

create or replace function public.admin_grant_temporary_access(p_user_id uuid, p_days integer default 30)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_days integer;
  v_until timestamptz;
begin
  if not public.is_app_admin() then
    return jsonb_build_object('ok', false, 'error', 'No autorizado.');
  end if;
  if p_user_id is null then
    return jsonb_build_object('ok', false, 'error', 'user_id requerido.');
  end if;
  v_days := greatest(1, least(coalesce(p_days, 30), 3650));
  v_until := now() + make_interval(days => v_days);
  return public.admin_set_user_access(p_user_id, 'approved', v_until);
end;
$$;

-- admin_prepare_user_delete ya existe en migración 20260812140000
-- Si no la tienes, aplica esa migración o scripts/delete-user.sql

revoke all on function public.admin_set_user_access(uuid, text, timestamptz) from public;
grant execute on function public.admin_set_user_access(uuid, text, timestamptz) to authenticated;
revoke all on function public.admin_grant_temporary_access(uuid, integer) from public;
grant execute on function public.admin_grant_temporary_access(uuid, integer) to authenticated;

commit;

notify pgrst, 'reload schema';
