-- Panel admin: overview de usuarios + bloqueo 1 sola vez de logo/carpeta OneDrive.

begin;

-- =========================================================
-- 1) Flags de bloqueo en user_drive_config
-- =========================================================

alter table public.user_drive_config
  add column if not exists logo_locked boolean not null default false,
  add column if not exists onedrive_subfolder_locked boolean not null default false;

comment on column public.user_drive_config.logo_locked is
  'Si true, el usuario no puede cambiar el logo (1 sola configuración). Admin puede desbloquear.';
comment on column public.user_drive_config.onedrive_subfolder_locked is
  'Si true, el usuario no puede cambiar el nombre de carpeta OneDrive. Admin puede desbloquear.';

-- Quienes ya subieron logo real (ruta logos/...) o carpeta quedan bloqueados
update public.user_drive_config
set logo_locked = true
where service_logo_file ~* '^logos/'
  and logo_locked is distinct from true;

update public.user_drive_config
set onedrive_subfolder_locked = true
where coalesce(trim(onedrive_subfolder_name), '') <> ''
  and onedrive_subfolder_locked is distinct from true;

-- =========================================================
-- 2) RPC: listado enriquecido para /panel-admin
-- =========================================================

create or replace function public.admin_list_user_overview()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
begin
  if not public.is_app_admin() then
    return jsonb_build_object('ok', false, 'error', 'No autorizado.');
  end if;

  select coalesce(jsonb_agg(row_data order by created_at desc), '[]'::jsonb)
  into v_rows
  from (
    select
      jsonb_build_object(
        'user_id', ua.user_id,
        'email', ua.email,
        'status', ua.status,
        'approved_at', ua.approved_at,
        'created_at', ua.created_at,
        'updated_at', ua.updated_at,
        'registros_count', (
          select count(*)::int
          from public.registros_ctpat r
          where r.user_id = ua.user_id
        ),
        'service_logo_file', udc.service_logo_file,
        'onedrive_subfolder_name', udc.onedrive_subfolder_name,
        'logo_locked', coalesce(udc.logo_locked, false),
        'onedrive_subfolder_locked', coalesce(udc.onedrive_subfolder_locked, false),
        'has_drive_config', (udc.user_id is not null)
      ) as row_data,
      ua.created_at
    from public.user_access ua
    left join public.user_drive_config udc on udc.user_id = ua.user_id
  ) t;

  return jsonb_build_object('ok', true, 'users', v_rows);
end;
$$;

-- =========================================================
-- 3) RPC: admin actualiza carpeta / locks
-- =========================================================

create or replace function public.admin_update_user_drive_config(
  p_user_id uuid,
  p_onedrive_subfolder text default null,
  p_set_onedrive_subfolder boolean default false,
  p_logo_locked boolean default null,
  p_onedrive_subfolder_locked boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
begin
  if not public.is_app_admin() then
    return jsonb_build_object('ok', false, 'error', 'No autorizado.');
  end if;

  if p_user_id is null then
    return jsonb_build_object('ok', false, 'error', 'user_id requerido.');
  end if;

  insert into public.user_drive_config (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  if p_set_onedrive_subfolder then
    v_name := nullif(trim(coalesce(p_onedrive_subfolder, '')), '');
    if v_name is not null then
      v_name := regexp_replace(v_name, '[\u0000-\u001f\\/:*?"<>|]', '', 'g');
      v_name := regexp_replace(v_name, '\s+', ' ', 'g');
      v_name := left(trim(v_name), 120);
      if v_name = '' then
        v_name := null;
      end if;
    end if;

    update public.user_drive_config
    set
      onedrive_subfolder_name = v_name,
      onedrive_subfolder_locked = case
        when p_onedrive_subfolder_locked is not null then p_onedrive_subfolder_locked
        when v_name is not null then true
        else onedrive_subfolder_locked
      end,
      updated_at = now()
    where user_id = p_user_id;
  elsif p_onedrive_subfolder_locked is not null then
    update public.user_drive_config
    set
      onedrive_subfolder_locked = p_onedrive_subfolder_locked,
      updated_at = now()
    where user_id = p_user_id;
  end if;

  if p_logo_locked is not null then
    update public.user_drive_config
    set
      logo_locked = p_logo_locked,
      updated_at = now()
    where user_id = p_user_id;
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.admin_list_user_overview() from public;
revoke all on function public.admin_update_user_drive_config(uuid, text, boolean, boolean, boolean) from public;
grant execute on function public.admin_list_user_overview() to authenticated;
grant execute on function public.admin_update_user_drive_config(uuid, text, boolean, boolean, boolean) to authenticated;

commit;
