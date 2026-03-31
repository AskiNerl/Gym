create table if not exists public.workout_state (
  id text primary key,
  workouts jsonb not null default '[]'::jsonb,
  exercises jsonb not null default '[]'::jsonb,
  theme text not null default 'light',
  updated_at timestamptz not null default now()
);

alter table public.workout_state enable row level security;

drop policy if exists "Public read workout_state" on public.workout_state;
create policy "Public read workout_state"
on public.workout_state
for select
using (true);

drop policy if exists "Public insert workout_state" on public.workout_state;
create policy "Public insert workout_state"
on public.workout_state
for insert
with check (true);

drop policy if exists "Public update workout_state" on public.workout_state;
create policy "Public update workout_state"
on public.workout_state
for update
using (true)
with check (true);

grant usage on schema public to anon, authenticated;
grant select, insert, update on public.workout_state to anon, authenticated;
