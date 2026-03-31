create table if not exists public.workout_state (
  id text primary key,
  workouts jsonb not null default '[]'::jsonb,
  exercises jsonb not null default '[]'::jsonb,
  theme text not null default 'light',
  updated_at timestamptz not null default now()
);

alter table public.workout_state enable row level security;

drop policy if exists "Public read workout_state" on public.workout_state;
drop policy if exists "Public insert workout_state" on public.workout_state;
drop policy if exists "Public update workout_state" on public.workout_state;
drop policy if exists "Users read own workout_state" on public.workout_state;
drop policy if exists "Users insert own workout_state" on public.workout_state;
drop policy if exists "Users update own workout_state" on public.workout_state;

revoke all on public.workout_state from anon;

create policy "Users read own workout_state"
on public.workout_state
for select
to authenticated
using (id = auth.uid()::text);

create policy "Users insert own workout_state"
on public.workout_state
for insert
to authenticated
with check (id = auth.uid()::text);

create policy "Users update own workout_state"
on public.workout_state
for update
to authenticated
using (id = auth.uid()::text)
with check (id = auth.uid()::text);

grant usage on schema public to authenticated;
grant select, insert, update on public.workout_state to authenticated;
