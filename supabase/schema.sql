-- ═══════════════════════════════════════════════════
--  CRM SURTAVET — schema Supabase
--  Cole este arquivo em: Dashboard → SQL Editor → Run
-- ═══════════════════════════════════════════════════

create table if not exists public.leads (
  id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default '',
  instagram text not null default '',
  phone text not null default '',
  company text not null default '',
  niche text not null default '',
  source text not null default '',
  stage text not null default 'new',
  service_type text not null default '',
  quality text not null default 'C',
  first_contact_date date,
  meeting_date date,
  proposal_date date,
  responded boolean not null default false,
  responded_after_proposal boolean not null default false,
  sold boolean not null default false,
  contract_value numeric not null default 0,
  next_action text not null default '',
  objections text not null default '',
  notes text not null default '',
  history jsonb not null default '[]'::jsonb,
  created_at date not null default current_date,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.tasks (
  id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  lead_id text not null default '',
  title text not null default '',
  due_date date,
  priority text not null default 'medium',
  done boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists leads_user_id_idx on public.leads (user_id);
create index if not exists leads_stage_idx on public.leads (user_id, stage);
create index if not exists tasks_user_id_idx on public.tasks (user_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_leads_updated_at on public.leads;
create trigger trg_leads_updated_at
before update on public.leads
for each row execute function public.set_updated_at();

drop trigger if exists trg_tasks_updated_at on public.tasks;
create trigger trg_tasks_updated_at
before update on public.tasks
for each row execute function public.set_updated_at();

alter table public.leads enable row level security;
alter table public.tasks enable row level security;

drop policy if exists "leads_own_all" on public.leads;
create policy "leads_own_all"
on public.leads
for all
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "tasks_own_all" on public.tasks;
create policy "tasks_own_all"
on public.tasks
for all
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.leads to authenticated;
grant select, insert, update, delete on public.tasks to authenticated;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null default '',
  name text not null default '',
  role text not null default 'user' check (role in ('admin', 'user')),
  created_at timestamptz not null default now()
);

create index if not exists profiles_role_idx on public.profiles (role);

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  admin_count int;
  new_role text;
begin
  select count(*) into admin_count from public.profiles where role = 'admin';
  new_role := coalesce(new.raw_app_meta_data->>'role', case when admin_count = 0 then 'admin' else 'user' end);
  if new_role not in ('admin', 'user') then
    new_role := 'user';
  end if;
  insert into public.profiles (id, email, name, role)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data->>'name', ''),
    new_role
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own_or_admin" on public.profiles;
create policy "profiles_select_own_or_admin"
on public.profiles
for select
to authenticated
using (id = auth.uid() or public.is_admin());

revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;
grant select on public.profiles to authenticated;
revoke insert, update, delete on public.profiles from authenticated, anon;
