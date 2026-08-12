-- Endurece el borrado de usuarios desde Dashboard / SQL Editor.
-- Problema: storage.objects.owner → auth.users bloquea el delete;
-- y admin_prepare_user_delete fallaba en SQL Editor (auth.uid() null → "No autorizado").

begin;

-- =========================================================
-- 1) Reafirmar CASCADE en tablas públicas (idempotente)
-- =========================================================

alter table public.registros_ctpat
  drop constraint if exists registros_ctpat_user_id_fkey;
alter table public.registros_ctpat
  add constraint registros_ctpat_user_id_fkey
  foreign key (user_id) references auth.users (id) on delete cascade;

alter table public.user_drive_config
  drop constraint if exists user_drive_config_user_id_fkey;
alter table public.user_drive_config
  add constraint user_drive_config_user_id_fkey
  foreign key (user_id) references auth.users (id) on delete cascade;

alter table public.app_admins
  drop constraint if exists app_admins_user_id_fkey;
alter table public.app_admins
  add constraint app_admins_user_id_fkey
  foreign key (user_id) references auth.users (id) on delete cascade;

alter table public.user_access
  drop constraint if exists user_access_user_id_fkey;
alter table public.user_access
  add constraint user_access_user_id_fkey
  foreign key (user_id) references auth.users (id) on delete cascade;

alter table public.user_access
  drop constraint if exists user_access_approved_by_fkey;
alter table public.user_access
  add constraint user_access_approved_by_fkey
  foreign key (approved_by) references auth.users (id) on delete set null;

alter table public.access_codes
  drop constraint if exists access_codes_created_by_fkey;
alter table public.access_codes
  add constraint access_codes_created_by_fkey
  foreign key (created_by) references auth.users (id) on delete set null;

-- =========================================================
-- 2) Limpieza Storage (owner + owner_id + rutas)
-- =========================================================

create or replace function public.cleanup_user_storage(p_user_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  deleted_count bigint := 0;
  has_owner_id boolean;
begin
  if p_user_id is null then
    return 0;
  end if;

  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'storage'
      and table_name = 'objects'
      and column_name = 'owner_id'
  ) into has_owner_id;

  if has_owner_id then
    execute $sql$
      delete from storage.objects
      where bucket_id in ('ctpat-evidence', 'ctpat-pdfs', 'ctpat-logs')
        and (
          owner = $1
          or owner_id = $1::text
          or name like $1::text || '/%'
          or name like '%/' || $1::text || '/%'
          or name like 'logos/' || $1::text || '.%'
        )
    $sql$ using p_user_id;
  else
    delete from storage.objects
    where bucket_id in ('ctpat-evidence', 'ctpat-pdfs', 'ctpat-logs')
      and (
        owner = p_user_id
        or name like p_user_id::text || '/%'
        or name like '%/' || p_user_id::text || '/%'
        or name like 'logos/' || p_user_id::text || '.%'
      );
  end if;

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

-- =========================================================
-- 3) Preparar borrado: app admin O SQL Editor / service_role
-- =========================================================

create or replace function public.admin_prepare_user_delete(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  v_storage bigint;
  v_caller text := coalesce(auth.role(), current_user);
begin
  -- PostgREST (usuario autenticado): solo admins de la app.
  -- SQL Editor (postgres) / service_role: auth.uid() es null → permitir.
  if auth.uid() is not null and not public.is_app_admin() then
    return jsonb_build_object('ok', false, 'error', 'No autorizado.');
  end if;

  if auth.uid() is null
     and v_caller not in ('service_role', 'postgres', 'supabase_admin', 'authenticator')
     and current_user not in ('postgres', 'supabase_admin', 'service_role')
  then
    return jsonb_build_object('ok', false, 'error', 'No autorizado.');
  end if;

  if p_user_id is null then
    return jsonb_build_object('ok', false, 'error', 'user_id requerido.');
  end if;

  v_storage := public.cleanup_user_storage(p_user_id);

  delete from public.registros_ctpat where user_id = p_user_id;
  delete from public.user_drive_config where user_id = p_user_id;
  delete from public.user_access where user_id = p_user_id;
  delete from public.app_admins where user_id = p_user_id;

  return jsonb_build_object(
    'ok', true,
    'storage_objects_deleted', v_storage,
    'message', 'Datos públicos y Storage limpiados. Ahora borra el usuario en Authentication → Users.'
  );
end;
$$;

revoke all on function public.cleanup_user_storage(uuid) from public;
revoke all on function public.admin_prepare_user_delete(uuid) from public;
grant execute on function public.cleanup_user_storage(uuid) to service_role;
grant execute on function public.admin_prepare_user_delete(uuid) to authenticated;
grant execute on function public.admin_prepare_user_delete(uuid) to service_role;

commit;
