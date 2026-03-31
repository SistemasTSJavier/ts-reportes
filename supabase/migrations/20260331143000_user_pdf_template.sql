create table if not exists public.user_pdf_template (
  user_id uuid primary key references auth.users(id) on delete cascade,
  template_json jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_pdf_template enable row level security;

drop policy if exists "Usuarios ven su plantilla PDF" on public.user_pdf_template;
create policy "Usuarios ven su plantilla PDF"
  on public.user_pdf_template
  for select
  using (auth.uid() = user_id);

drop policy if exists "Usuarios insertan su plantilla PDF" on public.user_pdf_template;
create policy "Usuarios insertan su plantilla PDF"
  on public.user_pdf_template
  for insert
  with check (auth.uid() = user_id);

drop policy if exists "Usuarios actualizan su plantilla PDF" on public.user_pdf_template;
create policy "Usuarios actualizan su plantilla PDF"
  on public.user_pdf_template
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create or replace function public.set_user_pdf_template_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists set_user_pdf_template_updated_at on public.user_pdf_template;
create trigger set_user_pdf_template_updated_at
before update on public.user_pdf_template
for each row
execute function public.set_user_pdf_template_updated_at();
