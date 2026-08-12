-- =============================================================================
-- Limpieza de BD para ts-reportes (TS-CTRMT)
-- Ejecutar en: Supabase → SQL Editor
--
-- Conserva SOLO lo que usa este proyecto.
-- NUNCA toca schemas: auth, storage (sistema), realtime, extensions, vault, cron.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- A) DIAGNÓSTICO — ejecuta primero y revisa el resultado
-- ---------------------------------------------------------------------------

-- Tablas en public: KEEP vs CANDIDATAS A BORRAR
select
  c.relname as tabla,
  case
    when c.relname in (
      'registros_ctpat',
      'user_drive_config',
      'user_access',
      'app_admins',
      'app_admin_emails',
      'access_codes'
    ) then 'KEEP (proyecto)'
    else 'DROP CANDIDATE'
  end as decision
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
order by decision desc, tabla;

-- Buckets de Storage
select
  id as bucket,
  public as is_public,
  case
    when id in ('ctpat-logs', 'ctpat-evidence', 'ctpat-pdfs') then 'KEEP'
    else 'DROP CANDIDATE'
  end as decision
from storage.buckets
order by decision desc, id;

-- Funciones públicas relevantes (solo referencia)
select p.proname as funcion
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'next_folio_ctpat',
    'sync_user_access_context',
    'redeem_access_code',
    'admin_create_access_code',
    'admin_set_user_access',
    'admin_list_user_access',
    'admin_list_access_codes',
    'purge_expired_ctpat_registros',
    'admin_prepare_user_delete',
    'cleanup_user_storage',
    'is_app_admin',
    'is_user_approved',
    'hash_access_code',
    'set_updated_at'
  )
order by funcion;

-- IMPORTANTE: el cleanup de tablas NO debe borrar funciones.
-- Si falta next_folio_ctpat, ejecuta scripts/fix-next-folio-ctpat.sql


-- =============================================================================
-- B) BORRAR TABLAS SOBRANTES en public
--    (todo lo que NO esté en la lista KEEP)
-- =============================================================================
do $$
declare
  r record;
  keep text[] := array[
    'registros_ctpat',
    'user_drive_config',
    'user_access',
    'app_admins',
    'app_admin_emails',
    'access_codes'
  ];
begin
  for r in
    select c.relname as tabla
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and not (c.relname = any (keep))
  loop
    raise notice 'DROP TABLE public.%', r.tabla;
    execute format('drop table if exists public.%I cascade', r.tabla);
  end loop;
end $$;

-- =============================================================================
-- C) BORRAR BUCKETS de Storage que no son del proyecto
--    (borra objetos + bucket)
-- =============================================================================
do $$
declare
  r record;
  keep_buckets text[] := array['ctpat-logs', 'ctpat-evidence', 'ctpat-pdfs'];
begin
  for r in
    select id
    from storage.buckets
    where not (id = any (keep_buckets))
  loop
    raise notice 'DROP BUCKET %', r.id;
    delete from storage.objects where bucket_id = r.id;
    delete from storage.buckets where id = r.id;
  end loop;
end $$;

-- =============================================================================
-- D) OPCIONAL — vaciar DATOS de las tablas del proyecto (deja estructura)
--    Descomenta SOLO si quieres empezar “en limpio” (usuarios Auth NO se borran).
-- =============================================================================
/*
truncate table
  public.registros_ctpat,
  public.user_drive_config,
  public.user_access,
  public.app_admins,
  public.access_codes
restart identity cascade;

-- app_admin_emails normalmente se conserva (allowlist de admins)
-- truncate table public.app_admin_emails;

-- Vaciar Storage del proyecto (logos/evidencias/pdfs)
delete from storage.objects
where bucket_id in ('ctpat-logs', 'ctpat-evidence', 'ctpat-pdfs');
*/

-- =============================================================================
-- E) VERIFICACIÓN final
-- =============================================================================
select relname as tablas_public_restantes
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by 1;

select id as buckets_restantes
from storage.buckets
order by 1;
