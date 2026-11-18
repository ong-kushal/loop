-- Loop location onboarding migration for an existing Supabase project.
-- Run this once in Supabase Dashboard > SQL Editor before publishing the updated frontend.
-- It stores city/region in private tables, not in public profile or post rows.

alter table public.profiles
  add column if not exists location_prompt_completed boolean not null default false;
alter table public.profiles
  add column if not exists show_location boolean not null default false;

create table if not exists public.profile_locations (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  city text not null default '',
  region text not null default '',
  updated_at timestamptz not null default now()
);

create table if not exists public.post_locations (
  post_id uuid primary key references public.posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  city text not null default '',
  region text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists post_locations_user_id_idx on public.post_locations(user_id);

-- Move existing account locations to private storage, without overwriting a user's newer private values.
insert into public.profile_locations(user_id, city, region)
select id, city, region from public.profiles
where coalesce(nullif(trim(city), ''), nullif(trim(region), '')) is not null
on conflict (user_id) do nothing;

-- Move existing post locality values to private storage for the location-aware feed.
insert into public.post_locations(post_id, user_id, city, region)
select id, user_id, location_city, location_region from public.posts
where coalesce(nullif(trim(location_city), ''), nullif(trim(location_region), '')) is not null
on conflict (post_id) do nothing;

-- Default to private. A user can explicitly opt in later from Edit profile.
update public.profiles set city = '', region = '', show_location = false
where show_location = false and (coalesce(city, '') <> '' or coalesce(region, '') <> '');
update public.posts set location_city = '', location_region = ''
where coalesce(location_city, '') <> '' or coalesce(location_region, '') <> '';

-- Enforce privacy at database level: public locality columns stay empty unless explicitly shared.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profile_location_visibility_check') then
    alter table public.profiles add constraint profile_location_visibility_check
      check (show_location or (city = '' and region = ''));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'post_location_columns_private_check') then
    alter table public.posts add constraint post_location_columns_private_check
      check (location_city = '' and location_region = '');
  end if;
end $$;

-- Existing accounts already passed onboarding if they had a stored location.
update public.profiles set location_prompt_completed = true
where id in (select user_id from public.profile_locations);

alter table public.profile_locations enable row level security;
alter table public.post_locations enable row level security;

drop policy if exists "users manage own profile location" on public.profile_locations;
create policy "users manage own profile location" on public.profile_locations for all to authenticated
using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "users manage own post locations" on public.post_locations;
create policy "users manage own post locations" on public.post_locations for all to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid() and exists (
  select 1 from public.posts p where p.id = post_id and p.user_id = auth.uid()
));

grant select, insert, update, delete on public.profile_locations, public.post_locations to authenticated;

create or replace function public.get_my_location_matches(p_post_ids uuid[])
returns table(post_id uuid, city_match boolean, region_match boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select pl.post_id,
    (nullif(trim(me.city), '') is not null and lower(trim(pl.city)) = lower(trim(me.city))) as city_match,
    (nullif(trim(me.region), '') is not null and lower(trim(pl.region)) = lower(trim(me.region))) as region_match
  from public.profile_locations me
  join public.post_locations pl on true
  join public.posts p on p.id = pl.post_id and p.user_id = pl.user_id
  where me.user_id = auth.uid()
    and pl.post_id = any(coalesce(p_post_ids, array[]::uuid[]))
    and (
      (nullif(trim(me.city), '') is not null and lower(trim(pl.city)) = lower(trim(me.city)))
      or (nullif(trim(me.region), '') is not null and lower(trim(pl.region)) = lower(trim(me.region)))
    );
$$;
revoke all on function public.get_my_location_matches(uuid[]) from public;
grant execute on function public.get_my_location_matches(uuid[]) to authenticated;

-- End migration. Public profile/post locality fields are blank unless a user opts in.
