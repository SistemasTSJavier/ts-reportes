-- =============================================================================
-- FIX RÁPIDO: Error "No se pudo obtener el folio automático" (404 next_folio_ctpat)
-- Pegar en: Supabase → SQL Editor → Run
-- Luego vuelve a crear el registro en la PWA.
-- =============================================================================

alter table public.registros_ctpat
  add column if not exists comentarios text null,
  add column if not exists comentarios_tipo text null;

create or replace function public.next_folio_ctpat(p_user_id uuid default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := coalesce(p_user_id, auth.uid());
  v_next integer;
begin
  if v_uid is null then
    raise exception 'user_id requerido para generar folio';
  end if;

  if auth.uid() is not null and auth.uid() <> v_uid then
    raise exception 'No autorizado a generar folio de otro usuario';
  end if;

  perform pg_advisory_xact_lock(hashtext('ctpat_folio:' || v_uid::text));

  select coalesce(
    max(
      nullif(
        regexp_replace(coalesce(folio_pdf, ''), '^TS-0*', '', 'i'),
        ''
      )::integer
    ),
    0
  ) + 1
  into v_next
  from public.registros_ctpat
  where user_id = v_uid
    and folio_pdf ~* '^TS-[0-9]+$';

  return 'TS-' || lpad(v_next::text, 4, '0');
end;
$$;

revoke all on function public.next_folio_ctpat(uuid) from public;
grant execute on function public.next_folio_ctpat(uuid) to authenticated;
grant execute on function public.next_folio_ctpat(uuid) to service_role;

-- Prueba (debe devolver TS-0001 o el siguiente):
-- select public.next_folio_ctpat();
