-- =============================================================================
-- Arregla "Failed to delete user: Database error deleting user"
-- Ejecutar en: Supabase → SQL Editor → New query → Run
-- Luego: Authentication → Users → Delete
-- =============================================================================

-- 0) (Opcional) Ver qué FKs apuntan a auth.users sin CASCADE
select
  n_from.nspname || '.' || c_from.relname as tabla,
  a.attname as columna,
  case c.confdeltype
    when 'a' then 'NO ACTION'
    when 'r' then 'RESTRICT'
    when 'c' then 'CASCADE'
    when 'n' then 'SET NULL'
    when 'd' then 'SET DEFAULT'
  end as on_delete
from pg_constraint c
join pg_class c_from on c_from.oid = c.conrelid
join pg_namespace n_from on n_from.oid = c_from.relnamespace
join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
join pg_class ref on ref.oid = c.confrelid
join pg_namespace n on n.oid = ref.relnamespace
where c.contype = 'f'
  and n.nspname = 'auth'
  and ref.relname = 'users'
  and c.confdeltype in ('a', 'r')  -- solo las que BLOQUEAN
order by tabla;

-- =============================================================================
-- 1) PEGA AQUÍ los UUID de Authentication → Users (columna UID / User UID)
--    Puedes poner 1 o varios.
-- =============================================================================
do $$
declare
  uids uuid[] := array[
    'UUID-USUARIO-1'::uuid
    -- ,'UUID-USUARIO-2'::uuid
  ];
  uid uuid;
  n_storage bigint;
  n_reg bigint;
  n_drive bigint;
  n_access bigint;
  n_admins bigint;
begin
  foreach uid in array uids loop
    -- Storage: borra TODO lo que tenga owner = usuario (cualquier bucket)
    delete from storage.objects where owner = uid;
    get diagnostics n_storage = row_count;

    -- Por si existe owner_id (text) en versiones nuevas de Storage
    begin
      execute 'delete from storage.objects where owner_id = $1' using uid::text;
      get diagnostics n_storage = n_storage + row_count;
    exception
      when undefined_column then null;
    end;

    -- Rutas típicas de esta app (por si owner no coincide)
    delete from storage.objects
    where name like uid::text || '/%'
       or name like '%/' || uid::text || '/%'
       or name like 'logos/' || uid::text || '.%';

    delete from public.registros_ctpat where user_id = uid;
    get diagnostics n_reg = row_count;

    delete from public.user_drive_config where user_id = uid;
    get diagnostics n_drive = row_count;

    delete from public.user_access where user_id = uid;
    get diagnostics n_access = row_count;

    delete from public.app_admins where user_id = uid;
    get diagnostics n_admins = row_count;

    -- Si alguien lo aprobó / creó códigos, no debe bloquear (SET NULL)
    begin
      update public.user_access set approved_by = null where approved_by = uid;
      update public.access_codes set created_by = null where created_by = uid;
    exception
      when undefined_table then null;
      when undefined_column then null;
    end;

    raise notice 'OK % → storage≈% registros=% drive=% access=% admins=%',
      uid, n_storage, n_reg, n_drive, n_access, n_admins;
  end loop;
end $$;

-- =============================================================================
-- 2) Ahora sí: Authentication → Users → selecciona → Delete
-- =============================================================================
