-- =============================================================================
-- FIX: "new row violates row-level security policy" al subir logo
-- Pegar en: Supabase → SQL Editor → Run
-- =============================================================================

insert into storage.buckets (id, name, public)
values ('ctpat-logs', 'ctpat-logs', true)
on conflict (id) do update set public = true;

drop policy if exists "ctpat_logs_select_public" on storage.objects;
drop policy if exists "ctpat_logs_insert_own_logo" on storage.objects;
drop policy if exists "ctpat_logs_update_own_logo" on storage.objects;
drop policy if exists "ctpat_logs_delete_own_logo" on storage.objects;

create policy "ctpat_logs_select_public"
on storage.objects
for select
to public
using (bucket_id = 'ctpat-logs');

create policy "ctpat_logs_insert_own_logo"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'ctpat-logs'
  and (
    name = 'logos/' || auth.uid()::text || '.png'
    or name = 'logos/' || auth.uid()::text || '.jpg'
    or name = 'logos/' || auth.uid()::text || '.jpeg'
  )
);

create policy "ctpat_logs_update_own_logo"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'ctpat-logs'
  and (
    name = 'logos/' || auth.uid()::text || '.png'
    or name = 'logos/' || auth.uid()::text || '.jpg'
    or name = 'logos/' || auth.uid()::text || '.jpeg'
  )
)
with check (
  bucket_id = 'ctpat-logs'
  and (
    name = 'logos/' || auth.uid()::text || '.png'
    or name = 'logos/' || auth.uid()::text || '.jpg'
    or name = 'logos/' || auth.uid()::text || '.jpeg'
  )
);

create policy "ctpat_logs_delete_own_logo"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'ctpat-logs'
  and (
    name = 'logos/' || auth.uid()::text || '.png'
    or name = 'logos/' || auth.uid()::text || '.jpg'
    or name = 'logos/' || auth.uid()::text || '.jpeg'
  )
);

select policyname, cmd
from pg_policies
where schemaname = 'storage'
  and tablename = 'objects'
  and policyname like 'ctpat_logs%'
order by policyname;
