-- =============================================================================
-- Seguridad fases 1–3 (+ columnas fase 4): locks BD, acceso, códigos, audit,
-- tickets Turnstile, MFA admin, logos privados, google refresh enc.
-- Pegar en SQL Editor o aplicar vía migraciones.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1.1 Locks reales en user_drive_config
-- ---------------------------------------------------------------------------
create or replace function public.enforce_user_drive_config_locks()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin boolean := public.is_app_admin();
begin
  if tg_op <> 'UPDATE' then
    return new;
  end if;

  if coalesce(old.logo_locked, false) and not v_admin then
    if new.service_logo_file is distinct from old.service_logo_file
       or new.logo_locked is distinct from old.logo_locked then
      raise exception 'Logo bloqueado: solo un administrador puede cambiarlo.';
    end if;
  end if;

  if coalesce(old.onedrive_subfolder_locked, false) and not v_admin then
    if new.onedrive_subfolder_name is distinct from old.onedrive_subfolder_name
       or new.onedrive_subfolder_locked is distinct from old.onedrive_subfolder_locked then
      raise exception 'Carpeta OneDrive bloqueada: solo un administrador puede cambiarla.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_user_drive_config_locks on public.user_drive_config;
create trigger trg_enforce_user_drive_config_locks
before update on public.user_drive_config
for each row execute function public.enforce_user_drive_config_locks();

-- ---------------------------------------------------------------------------
-- 1.2 Acceso temporal efectivo + MFA helper
-- ---------------------------------------------------------------------------
create or replace function public.require_admin_aal2()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select public.is_app_admin()
    and (
      coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
      or not exists (
        select 1
        from auth.mfa_factors f
        where f.user_id = auth.uid()
          and f.status = 'verified'
      )
    );
$$;

create or replace function public.sync_user_access_context()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_status text;
  v_expires timestamptz;
  v_effective text;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  select u.email into v_email from auth.users u where u.id = v_uid;

  insert into public.user_access (user_id, email, status)
  values (v_uid, v_email, 'pending')
  on conflict (user_id) do nothing;

  update public.user_access
  set email = v_email, updated_at = now()
  where user_id = v_uid;

  if exists (
    select 1 from public.app_admin_emails ae
    where lower(ae.email::text) = lower(coalesce(v_email, ''))
  ) then
    insert into public.app_admins (user_id) values (v_uid)
    on conflict (user_id) do nothing;

    update public.user_access
    set
      status = 'approved',
      approved_at = coalesce(approved_at, now()),
      approved_by = coalesce(approved_by, v_uid),
      access_expires_at = null,
      updated_at = now()
    where user_id = v_uid
      and status <> 'approved';
  end if;

  select ua.status, ua.access_expires_at
  into v_status, v_expires
  from public.user_access ua
  where ua.user_id = v_uid;

  v_effective := coalesce(v_status, 'pending');
  if v_effective = 'approved'
     and v_expires is not null
     and v_expires <= now() then
    v_effective := 'expired';
  end if;

  return jsonb_build_object(
    'ok', true,
    'status', v_effective,
    'is_admin', public.is_app_admin(),
    'access_expires_at', v_expires,
    'aal', coalesce(auth.jwt() ->> 'aal', 'aal1')
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 1.3 Códigos: rechazados no re-aprueban; códigos más largos; rate limit
-- ---------------------------------------------------------------------------
create table if not exists public.access_code_redeem_attempts (
  id bigserial primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  attempted_at timestamptz not null default now()
);
create index if not exists idx_access_code_redeem_attempts_user_time
  on public.access_code_redeem_attempts (user_id, attempted_at desc);

create or replace function public.redeem_access_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_hash text;
  v_code public.access_codes%rowtype;
  v_prev_status text;
  v_recent int;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'Debes iniciar sesión primero.');
  end if;

  select count(*)::int into v_recent
  from public.access_code_redeem_attempts
  where user_id = v_uid
    and attempted_at > now() - interval '15 minutes';
  if v_recent >= 10 then
    return jsonb_build_object('ok', false, 'error', 'Demasiados intentos. Espera 15 minutos.');
  end if;

  insert into public.access_code_redeem_attempts (user_id) values (v_uid);

  if p_code is null or length(trim(p_code)) < 8 then
    return jsonb_build_object('ok', false, 'error', 'Código inválido.');
  end if;

  select ua.status into v_prev_status from public.user_access ua where ua.user_id = v_uid;
  if v_prev_status = 'rejected' then
    return jsonb_build_object('ok', false, 'error', 'Tu acceso fue rechazado. Contacta al administrador.');
  end if;

  v_hash := public.hash_access_code(p_code);

  select * into v_code
  from public.access_codes ac
  where ac.code_hash = v_hash
    and ac.is_active = true
    and ac.use_count < ac.max_uses
    and (ac.expires_at is null or ac.expires_at > now())
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'Código inválido, expirado o ya utilizado.');
  end if;

  select u.email into v_email from auth.users u where u.id = v_uid;

  update public.access_codes
  set use_count = use_count + 1
  where id = v_code.id;

  insert into public.user_access (user_id, email, status, approved_at, approved_by, redeemed_code_id)
  values (v_uid, v_email, 'approved', now(), null, v_code.id)
  on conflict (user_id) do update
  set
    status = 'approved',
    approved_at = coalesce(public.user_access.approved_at, now()),
    redeemed_code_id = v_code.id,
    access_expires_at = null,
    updated_at = now();

  return jsonb_build_object('ok', true, 'status', 'approved');
end;
$$;

create or replace function public.admin_create_access_code(
  p_label text default null,
  p_max_uses integer default 1,
  p_expires_days integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plain text;
  v_hash text;
  v_id uuid;
begin
  if not public.require_admin_aal2() then
    return jsonb_build_object('ok', false, 'error', 'No autorizado (se requiere MFA admin).');
  end if;

  if p_max_uses is null or p_max_uses < 1 then
    p_max_uses := 1;
  end if;

  v_plain := 'TS-' || upper(substr(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 1, 16));
  v_hash := public.hash_access_code(v_plain);

  insert into public.access_codes (code_hash, label, created_by, max_uses, expires_at)
  values (
    v_hash,
    nullif(trim(p_label), ''),
    auth.uid(),
    p_max_uses,
    case
      when p_expires_days is null or p_expires_days < 1 then null
      else now() + make_interval(days => p_expires_days)
    end
  )
  returning id into v_id;

  return jsonb_build_object(
    'ok', true,
    'code', v_plain,
    'id', v_id,
    'max_uses', p_max_uses
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin RPCs: exigir AAL2
-- ---------------------------------------------------------------------------
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
  if not public.require_admin_aal2() then
    return jsonb_build_object('ok', false, 'error', 'No autorizado (se requiere MFA admin).');
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
  if not public.require_admin_aal2() then
    return jsonb_build_object('ok', false, 'error', 'No autorizado (se requiere MFA admin).');
  end if;
  if p_user_id is null then
    return jsonb_build_object('ok', false, 'error', 'user_id requerido.');
  end if;
  v_days := greatest(1, least(coalesce(p_days, 30), 3650));
  v_until := now() + make_interval(days => v_days);
  return public.admin_set_user_access(p_user_id, 'approved', v_until);
end;
$$;

create or replace function public.admin_list_user_overview()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
begin
  if not public.require_admin_aal2() then
    return jsonb_build_object('ok', false, 'error', 'No autorizado (se requiere MFA admin).');
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
        'access_expires_at', ua.access_expires_at,
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
  if not public.require_admin_aal2() then
    return jsonb_build_object('ok', false, 'error', 'No autorizado (se requiere MFA admin).');
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
  if auth.uid() is not null and not public.require_admin_aal2() then
    return jsonb_build_object('ok', false, 'error', 'No autorizado (se requiere MFA admin).');
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

  if auth.uid() is not null and p_user_id = auth.uid() then
    return jsonb_build_object('ok', false, 'error', 'No puedes eliminar tu propia cuenta desde el panel.');
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
    'message', 'Datos públicos eliminados. Storage y Auth se completan vía Edge admin-delete-user.'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 2.1 Audit redact + solo admin SELECT
-- ---------------------------------------------------------------------------
create or replace function public.redact_audit_jsonb(p_data jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  v jsonb := p_data;
  k text;
  sensitive text[] := array[
    'firma_operador', 'firma_oficial', 'image_urls',
    'checklist_tracto', 'checklist_caja',
    'inspeccion_agricola', 'inspeccion_mecanica',
    'operador', 'evidencias_exif',
    'google_refresh_token_enc'
  ];
begin
  if v is null or jsonb_typeof(v) <> 'object' then
    return v;
  end if;
  foreach k in array sensitive
  loop
    if v ? k then
      v := v || jsonb_build_object(k, '[REDACTED]');
    end if;
  end loop;
  return v;
end;
$$;

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
    v_old := public.redact_audit_jsonb(to_jsonb(old));
    v_new := null;
    v_record_id := coalesce(v_old->>'id', v_old->>'user_id', '');
    v_subject := coalesce(
      nullif(to_jsonb(old)->>'user_id', '')::uuid,
      nullif(to_jsonb(old)->>'id', '')::uuid
    );
    insert into public.audit_logs (
      actor_user_id, action, table_name, record_id, subject_user_id, old_data, new_data
    ) values (
      auth.uid(), 'DELETE', tg_table_schema || '.' || tg_table_name,
      v_record_id, v_subject, v_old, null
    );
    return old;
  elsif tg_op = 'UPDATE' then
    v_old := public.redact_audit_jsonb(to_jsonb(old));
    v_new := public.redact_audit_jsonb(to_jsonb(new));
    v_record_id := coalesce(v_new->>'id', v_new->>'user_id', '');
    v_subject := coalesce(
      nullif(to_jsonb(new)->>'user_id', '')::uuid,
      nullif(to_jsonb(new)->>'id', '')::uuid
    );
    insert into public.audit_logs (
      actor_user_id, action, table_name, record_id, subject_user_id, old_data, new_data
    ) values (
      auth.uid(), 'UPDATE', tg_table_schema || '.' || tg_table_name,
      v_record_id, v_subject, v_old, v_new
    );
    return new;
  elsif tg_op = 'INSERT' then
    v_new := public.redact_audit_jsonb(to_jsonb(new));
    v_record_id := coalesce(v_new->>'id', v_new->>'user_id', '');
    v_subject := coalesce(
      nullif(to_jsonb(new)->>'user_id', '')::uuid,
      nullif(to_jsonb(new)->>'id', '')::uuid
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

drop policy if exists audit_logs_select_own_or_admin on public.audit_logs;
drop policy if exists audit_logs_select_admin_only on public.audit_logs;
create policy audit_logs_select_admin_only
on public.audit_logs
for select
to authenticated
using (public.is_app_admin());

create or replace function public.admin_list_audit_logs(
  p_limit integer default 50,
  p_offset integer default 0,
  p_table_filter text default null,
  p_action_filter text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer;
  v_offset integer;
  v_table text;
  v_action text;
  v_total integer;
  v_rows jsonb;
begin
  if not public.require_admin_aal2() then
    return jsonb_build_object('ok', false, 'error', 'No autorizado (se requiere MFA admin).');
  end if;

  v_limit := greatest(1, least(coalesce(p_limit, 50), 200));
  v_offset := greatest(0, coalesce(p_offset, 0));
  v_table := nullif(trim(coalesce(p_table_filter, '')), '');
  v_action := nullif(upper(trim(coalesce(p_action_filter, ''))), '');

  if v_action is not null and v_action not in ('INSERT', 'UPDATE', 'DELETE') then
    return jsonb_build_object('ok', false, 'error', 'Acción inválida.');
  end if;

  select count(*)::integer
  into v_total
  from public.audit_logs al
  where (v_table is null or al.table_name ilike '%' || v_table || '%')
    and (v_action is null or al.action = v_action);

  select coalesce(jsonb_agg(row_data order by sort_at desc), '[]'::jsonb)
  into v_rows
  from (
    select
      jsonb_build_object(
        'id', al.id,
        'created_at', al.created_at,
        'action', al.action,
        'table_name', al.table_name,
        'record_id', al.record_id,
        'actor_user_id', al.actor_user_id,
        'actor_email', actor_ua.email,
        'subject_user_id', al.subject_user_id,
        'subject_email', subject_ua.email,
        'old_data', al.old_data,
        'new_data', al.new_data
      ) as row_data,
      al.created_at as sort_at
    from public.audit_logs al
    left join public.user_access actor_ua on actor_ua.user_id = al.actor_user_id
    left join public.user_access subject_ua on subject_ua.user_id = al.subject_user_id
    where (v_table is null or al.table_name ilike '%' || v_table || '%')
      and (v_action is null or al.action = v_action)
    order by al.created_at desc
    limit v_limit
    offset v_offset
  ) t;

  return jsonb_build_object(
    'ok', true,
    'logs', v_rows,
    'total', v_total,
    'limit', v_limit,
    'offset', v_offset
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 2.4 Logos privados + quitar DELETE admin bucket-wide
-- ---------------------------------------------------------------------------
update storage.buckets set public = false where id = 'ctpat-logs';

drop policy if exists "ctpat_logs_select_public" on storage.objects;
drop policy if exists "ctpat_logs_select_own_or_admin" on storage.objects;
create policy "ctpat_logs_select_own_or_admin"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'ctpat-logs'
  and (
    public.is_app_admin()
    or name = 'logos/' || auth.uid()::text || '.png'
    or name = 'logos/' || auth.uid()::text || '.jpg'
    or name = 'logos/' || auth.uid()::text || '.jpeg'
  )
);

drop policy if exists "ctpat_pdfs_delete_admin" on storage.objects;
drop policy if exists "ctpat_evidence_delete_admin" on storage.objects;
drop policy if exists "ctpat_logs_delete_admin" on storage.objects;

-- ---------------------------------------------------------------------------
-- 3.1 Login tickets Turnstile + rate limit IP
-- ---------------------------------------------------------------------------
create table if not exists public.login_tickets (
  jti uuid primary key,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz null,
  client_ip text null
);
create index if not exists idx_login_tickets_expires on public.login_tickets (expires_at);

create table if not exists public.turnstile_rate_by_ip (
  client_ip text not null,
  window_start timestamptz not null,
  hit_count integer not null default 0,
  primary key (client_ip, window_start)
);

alter table public.login_tickets enable row level security;
alter table public.turnstile_rate_by_ip enable row level security;
alter table public.access_code_redeem_attempts enable row level security;

-- ---------------------------------------------------------------------------
-- 4 Google refresh token encrypted column
-- ---------------------------------------------------------------------------
alter table public.user_drive_config
  add column if not exists google_refresh_token_enc text null,
  add column if not exists google_token_updated_at timestamptz null;

comment on column public.user_drive_config.google_refresh_token_enc is
  'Refresh token Google cifrado (AES-GCM) por Edge Function; no expuesto al cliente.';

revoke all on function public.require_admin_aal2() from public;
grant execute on function public.require_admin_aal2() to authenticated;
grant execute on function public.require_admin_aal2() to service_role;

notify pgrst, 'reload schema';

commit;
