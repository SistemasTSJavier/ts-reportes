-- El panel no puede DELETE FROM storage.objects; usa Storage API + políticas admin.

begin;

create or replace function public.cleanup_user_storage(p_user_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public, storage
as $$
begin
  if p_user_id is null then
    return 0;
  end if;
  return 0;
end;
$$;

create or replace function public.admin_prepare_user_delete(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  v_caller text := coalesce(auth.role(), current_user);
  v_files jsonb := '[]'::jsonb;
begin
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

  begin
    select coalesce(
      jsonb_agg(jsonb_build_object('bucket', o.bucket_id, 'name', o.name)),
      '[]'::jsonb
    )
    into v_files
    from storage.objects o
    where o.bucket_id in ('ctpat-evidence', 'ctpat-pdfs', 'ctpat-logs')
      and (
        o.owner = p_user_id
        or o.name like p_user_id::text || '/%'
        or o.name like '%/' || p_user_id::text || '/%'
        or o.name like 'logos/' || p_user_id::text || '.%'
      );
  exception
    when others then
      v_files := '[]'::jsonb;
  end;

  v_files := coalesce(v_files, '[]'::jsonb) || coalesce(
    (
      select jsonb_agg(jsonb_build_object('bucket', 'ctpat-pdfs', 'name', r.pdf_storage_path))
      from public.registros_ctpat r
      where r.user_id = p_user_id
        and r.pdf_storage_path is not null
        and length(trim(r.pdf_storage_path)) > 0
    ),
    '[]'::jsonb
  );

  v_files := v_files || coalesce(
    (
      select jsonb_agg(jsonb_build_object('bucket', 'ctpat-logs', 'name', c.service_logo_file))
      from public.user_drive_config c
      where c.user_id = p_user_id
        and c.service_logo_file is not null
        and c.service_logo_file not like 'http%'
        and length(trim(c.service_logo_file)) > 0
    ),
    '[]'::jsonb
  );

  delete from public.registros_ctpat where user_id = p_user_id;
  delete from public.user_drive_config where user_id = p_user_id;
  delete from public.user_access where user_id = p_user_id;
  delete from public.app_admins where user_id = p_user_id;

  return jsonb_build_object(
    'ok', true,
    'files', coalesce(v_files, '[]'::jsonb),
    'message', 'Datos públicos eliminados. Completa el borrado en Authentication → Users si aplica.'
  );
end;
$$;

drop policy if exists "ctpat_pdfs_delete_admin" on storage.objects;
create policy "ctpat_pdfs_delete_admin"
on storage.objects
for delete
to authenticated
using (bucket_id = 'ctpat-pdfs' and public.is_app_admin());

drop policy if exists "ctpat_evidence_delete_admin" on storage.objects;
create policy "ctpat_evidence_delete_admin"
on storage.objects
for delete
to authenticated
using (bucket_id = 'ctpat-evidence' and public.is_app_admin());

drop policy if exists "ctpat_logs_delete_admin" on storage.objects;
create policy "ctpat_logs_delete_admin"
on storage.objects
for delete
to authenticated
using (bucket_id = 'ctpat-logs' and public.is_app_admin());

revoke all on function public.cleanup_user_storage(uuid) from public;
revoke all on function public.admin_prepare_user_delete(uuid) from public;
grant execute on function public.cleanup_user_storage(uuid) to service_role;
grant execute on function public.admin_prepare_user_delete(uuid) to authenticated;
grant execute on function public.admin_prepare_user_delete(uuid) to service_role;

commit;
