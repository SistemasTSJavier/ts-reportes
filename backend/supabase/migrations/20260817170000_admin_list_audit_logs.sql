-- RPC para listar audit_logs en /panel-admin (solo admin).

begin;

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
  if not public.is_app_admin() then
    return jsonb_build_object('ok', false, 'error', 'No autorizado.');
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

revoke all on function public.admin_list_audit_logs(integer, integer, text, text) from public;
grant execute on function public.admin_list_audit_logs(integer, integer, text, text) to authenticated;

commit;
