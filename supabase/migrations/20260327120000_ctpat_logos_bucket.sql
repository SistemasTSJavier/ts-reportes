-- Bucket público para logos (PDF + PWA). Mismo id que usa la Edge Function por defecto (LOGO_BUCKET / ctpat-logs).
insert into storage.buckets (id, name, public, file_size_limit)
values ('ctpat-logs', 'ctpat-logs', true, 5242880)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit;

-- Cualquiera puede leer objetos (URL pública para img y para la Edge Function).
drop policy if exists "Public read ctpat-logs logos" on storage.objects;
create policy "Public read ctpat-logs logos"
on storage.objects
for select
to public
using (bucket_id = 'ctpat-logs');

-- Las subidas se hacen desde el panel de Supabase (service_role) o políticas que añadas tú;
-- los usuarios de la app no necesitan INSERT si solo administras archivos en Storage manualmente.
