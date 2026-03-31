-- Permite a cada usuario subir/actualizar su logo en ctpat-logs usando ruta fija: logos/<auth.uid()>.png|jpg
drop policy if exists "Authenticated upload own logo ctpat-logs" on storage.objects;
create policy "Authenticated upload own logo ctpat-logs"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'ctpat-logs'
  and (name = ('logos/' || auth.uid()::text || '.png') or name = ('logos/' || auth.uid()::text || '.jpg'))
);

drop policy if exists "Authenticated update own logo ctpat-logs" on storage.objects;
create policy "Authenticated update own logo ctpat-logs"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'ctpat-logs'
  and (name = ('logos/' || auth.uid()::text || '.png') or name = ('logos/' || auth.uid()::text || '.jpg'))
)
with check (
  bucket_id = 'ctpat-logs'
  and (name = ('logos/' || auth.uid()::text || '.png') or name = ('logos/' || auth.uid()::text || '.jpg'))
);
