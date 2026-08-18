-- Quita el trigger legado registros_ctpat_audit_mutation (tabla ya no existe).

begin;

do $$
declare
  r record;
begin
  for r in
    select t.tgname as trigger_name, c.relname as table_name
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_proc p on p.oid = t.tgfoid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and not t.tgisinternal
      and p.proname in (
        'registros_ctpat_audit_mutation',
        'user_access_audit_mutation',
        'user_drive_config_audit_mutation'
      )
  loop
    execute format('drop trigger if exists %I on public.%I', r.trigger_name, r.table_name);
  end loop;
end $$;

drop function if exists public.registros_ctpat_audit_mutation() cascade;
drop function if exists public.user_access_audit_mutation() cascade;
drop function if exists public.user_drive_config_audit_mutation() cascade;
drop table if exists public.registros_ctpat_audit;

commit;
