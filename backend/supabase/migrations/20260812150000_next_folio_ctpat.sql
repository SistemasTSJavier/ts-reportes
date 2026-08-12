-- Restaura RPC next_folio_ctpat (faltaba en migraciones; se pierde si se recrea la BD).
-- Formato: TS-0001, TS-0002, ... (secuencial por usuario).

begin;

-- Columnas que inserta la PWA y no estaban en el CREATE original
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

  -- Usuario autenticado solo puede pedir su propio folio
  if auth.uid() is not null and auth.uid() <> v_uid then
    raise exception 'No autorizado a generar folio de otro usuario';
  end if;

  -- Evita colisiones si dos guardados concurrentes
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

commit;
