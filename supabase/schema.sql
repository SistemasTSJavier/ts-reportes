  -- Tabla principal que replica el RegistroModel de Flutter
  create table if not exists public.registros_ctpat (
    id uuid primary key default gen_random_uuid(),
    service_id text,
    folio_pdf text,
    operador text,
    checklist_tracto jsonb not null default '{}'::jsonb,
    checklist_caja jsonb not null default '{}'::jsonb,
    inspeccion_agricola jsonb not null default '{}'::jsonb,
    inspeccion_mecanica jsonb not null default '{}'::jsonb,
    image_urls text[] not null default '{}'::text[],
    firma_operador text,
    firma_oficial text,
    comentarios text,
    comentarios_tipo text,
    evidencias_exif jsonb not null default '{}'::jsonb,
    sync_status text not null default 'pending',
    user_id uuid references auth.users (id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );

  -- Configuración por usuario para carpetas de Google Drive
  create table if not exists public.user_drive_config (
    user_id uuid primary key references auth.users (id) on delete cascade,
    pdf_folder_id text not null,
    images_folder_id text not null,
    created_at timestamptz not null default now()
  );

  alter table public.user_drive_config enable row level security;

-- Logo por usuario/servicio (archivo dentro del bucket LOGO_BUCKET o assets).
-- Ejemplos: caterpillar.png, komatsu.png, john_deere.png
alter table public.user_drive_config
  add column if not exists service_logo_file text not null default 'caterpillar.png';

  drop policy if exists "Usuarios ven su propia config Drive" on public.user_drive_config;
  create policy "Usuarios ven su propia config Drive"
    on public.user_drive_config
    for select
    using (auth.uid() = user_id);

  drop policy if exists "Usuarios insertan su propia config Drive" on public.user_drive_config;
  create policy "Usuarios insertan su propia config Drive"
    on public.user_drive_config
    for insert
    with check (auth.uid() = user_id);

  drop policy if exists "Usuarios actualizan su propia config Drive" on public.user_drive_config;
  create policy "Usuarios actualizan su propia config Drive"
    on public.user_drive_config
    for update
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

  -- Contador de folio automático POR USUARIO (TS-1, TS-2, ...)
  create table if not exists public.registros_ctpat_folio_counter (
    user_id uuid primary key references auth.users(id) on delete cascade,
    counter bigint not null default 0
  );

  alter table public.registros_ctpat_folio_counter enable row level security;

  drop policy if exists "Usuarios ven su contador de folio" on public.registros_ctpat_folio_counter;
  create policy "Usuarios ven su contador de folio"
    on public.registros_ctpat_folio_counter
    for select
    using (auth.uid() = user_id);

  drop policy if exists "Usuarios insertan su contador de folio" on public.registros_ctpat_folio_counter;
  create policy "Usuarios insertan su contador de folio"
    on public.registros_ctpat_folio_counter
    for insert
    with check (auth.uid() = user_id);

  drop policy if exists "Usuarios actualizan su contador de folio" on public.registros_ctpat_folio_counter;
  create policy "Usuarios actualizan su contador de folio"
    on public.registros_ctpat_folio_counter
    for update
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

  create or replace function public.next_folio_ctpat(p_user_id uuid default null)
  returns text as $$
  declare
    new_val bigint;
    uid uuid;
  begin
    uid := coalesce(p_user_id, auth.uid());
    if uid is null then
      raise exception 'user_id requerido para generar folio';
    end if;

    insert into public.registros_ctpat_folio_counter (user_id, counter)
    values (uid, 1)
    on conflict (user_id) do update
      set counter = public.registros_ctpat_folio_counter.counter + 1
    returning counter into new_val;

    return format('TS-%s', new_val::text);
  end;
  $$ language plpgsql;

  alter table public.registros_ctpat enable row level security;

  drop policy if exists "Usuarios ven sólo sus registros" on public.registros_ctpat;
  create policy "Usuarios ven sólo sus registros"
    on public.registros_ctpat
    for select
    using (auth.uid() = user_id);

  drop policy if exists "Usuarios insertan sus registros" on public.registros_ctpat;
  create policy "Usuarios insertan sus registros"
    on public.registros_ctpat
    for insert
    with check (auth.uid() = user_id);

  drop policy if exists "Usuarios actualizan sus registros" on public.registros_ctpat;
  create policy "Usuarios actualizan sus registros"
    on public.registros_ctpat
    for update
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

  drop policy if exists "Usuarios borran sus registros" on public.registros_ctpat;
  create policy "Usuarios borran sus registros"
    on public.registros_ctpat
    for delete
    using (auth.uid() = user_id);

  create or replace function public.set_registros_ctpat_updated_at()
  returns trigger as $$
  begin
    new.updated_at = now();
    return new;
  end;
  $$ language plpgsql;

  drop trigger if exists set_registros_ctpat_updated_at on public.registros_ctpat;

  create trigger set_registros_ctpat_updated_at
  before update on public.registros_ctpat
  for each row
  execute function public.set_registros_ctpat_updated_at();

  -- =========================
  -- Limpieza automática BD
  -- =========================
  -- Importante: NO borrar "pending" antes de que la Edge Function
  -- termine de subir el PDF a Drive. Solo se eliminan registros ya sincronizados.
  create index if not exists registros_ctpat_created_at_idx
    on public.registros_ctpat (created_at);

  create or replace function public.cleanup_registros_ctpat(p_days integer default 30)
  returns void
  language plpgsql
  as $$
  begin
    delete from public.registros_ctpat
    where created_at < now() - make_interval(days => p_days)
      and sync_status in ('synced', 'error');
  end;
  $$;