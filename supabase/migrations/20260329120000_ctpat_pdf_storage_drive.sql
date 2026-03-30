-- PDFs generados por usuario (Edge Function con service_role; no lectura pública).
insert into storage.buckets (id, name, public, file_size_limit)
values ('ctpat-pdfs', 'ctpat-pdfs', false, 52428800)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit;

-- Ruta en Storage y opcionalmente id de archivo en Drive tras sincronizar.
alter table public.registros_ctpat
  add column if not exists pdf_storage_path text,
  add column if not exists drive_file_id text;

comment on column public.registros_ctpat.pdf_storage_path is 'Ruta en bucket ctpat-pdfs (p. ej. user_id/registro_id.pdf)';
comment on column public.registros_ctpat.drive_file_id is 'Id del archivo PDF en Google Drive tras sync; null si solo está en Storage';
