-- MyShift — Supabase setup script
-- Run this once in your Supabase project's SQL editor (Project -> SQL Editor -> New query).
-- It creates a single table that stores each signed-in user's entire MyShift data
-- as one JSON document, protected so only that user can ever read or write their own row.

create table if not exists public.app_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.app_data enable row level security;

create policy "Users can read own data"
  on public.app_data for select
  using (auth.uid() = user_id);

create policy "Users can insert own data"
  on public.app_data for insert
  with check (auth.uid() = user_id);

create policy "Users can update own data"
  on public.app_data for update
  using (auth.uid() = user_id);

-- Optional but recommended: keep updated_at current automatically.
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists app_data_set_updated_at on public.app_data;
create trigger app_data_set_updated_at
  before update on public.app_data
  for each row execute function public.set_updated_at();
