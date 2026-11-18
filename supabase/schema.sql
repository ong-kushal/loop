-- LOOP social app schema for Supabase (Postgres)
-- Paste this whole file into Supabase Dashboard > SQL Editor > New query > Run.
-- Uses Supabase Auth, public Storage buckets, RLS, and Postgres triggers.

create extension if not exists pgcrypto;

-- ── Profiles ────────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique,
  display_name text not null default 'Loop user',
  bio text not null default '',
  avatar_path text,
  city text not null default '',
  region text not null default '',
  created_at timestamptz not null default now(),
  constraint username_format check (username ~ '^[a-zA-Z0-9_.]{3,24}$'),
  constraint display_name_length check (char_length(display_name) between 1 and 40),
  constraint bio_length check (char_length(bio) <= 160)
);

create or replace function public.make_username(seed text, user_id uuid)
returns text language plpgsql immutable as $$
declare base_name text;
begin
  base_name := lower(regexp_replace(coalesce(seed, 'loopuser'), '[^a-zA-Z0-9_.]', '', 'g'));
  base_name := trim(both '._' from base_name);
  if char_length(base_name) < 3 then base_name := 'loopuser'; end if;
  return left(base_name, 16) || '_' || left(replace(user_id::text, '-', ''), 6);
end;
$$;

create or replace function public.handle_new_loop_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare chosen_username text;
begin
  chosen_username := coalesce(nullif(new.raw_user_meta_data->>'username', ''), split_part(coalesce(new.email, 'loopuser'), '@', 1));
  chosen_username := left(lower(regexp_replace(chosen_username, '[^a-zA-Z0-9_.]', '', 'g')), 24);
  if char_length(chosen_username) < 3 or exists(select 1 from public.profiles p where p.username = chosen_username) then
    chosen_username := public.make_username(chosen_username, new.id);
  end if;
  insert into public.profiles(id, username, display_name)
  values (
    new.id,
    chosen_username,
    coalesce(nullif(new.raw_user_meta_data->>'display_name', ''), chosen_username)
  ) on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_loop on auth.users;
create trigger on_auth_user_created_loop
after insert on auth.users
for each row execute procedure public.handle_new_loop_user();

-- ── Posts ───────────────────────────────────────────────────────────────────
create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  caption text not null default '',
  media_path text not null,
  media_type text not null check (media_type in ('image', 'video')),
  duration_seconds numeric(8,2),
  tags text[] not null default '{}',
  location_city text not null default '',
  location_region text not null default '',
  views_count bigint not null default 0,
  comments_count bigint not null default 0,
  created_at timestamptz not null default now(),
  constraint caption_length check (char_length(caption) <= 500),
  constraint duration_for_media check (
    (media_type = 'image' and duration_seconds is null) or
    (media_type = 'video' and duration_seconds is not null and duration_seconds between 0.1 and 60)
  )
);

create index if not exists posts_created_at_idx on public.posts(created_at desc);
create index if not exists posts_user_id_idx on public.posts(user_id);
create index if not exists posts_tags_idx on public.posts using gin(tags);

-- ── Comments ────────────────────────────────────────────────────────────────
create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  constraint comment_not_blank check (char_length(trim(body)) between 1 and 1200),
  constraint comment_max_100_words check (cardinality(regexp_split_to_array(trim(body), '\s+')) <= 100)
);
create index if not exists comments_post_created_idx on public.comments(post_id, created_at);

create or replace function public.moderate_loop_comment()
returns trigger language plpgsql as $$
declare blocked_pattern text := '\m(fuck|shit|bitch|asshole|bastard|motherfucker|cunt|dickhead|slut|whore|nigger|faggot)\M';
begin
  if new.body ~* blocked_pattern then
    raise exception 'This comment contains language that Loop does not allow. Please edit it.';
  end if;
  return new;
end;
$$;
drop trigger if exists comments_moderation_before on public.comments;
create trigger comments_moderation_before before insert or update of body on public.comments
for each row execute procedure public.moderate_loop_comment();

create or replace function public.update_post_comment_count()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    update public.posts set comments_count = comments_count + 1 where id = new.post_id;
    return new;
  elsif tg_op = 'DELETE' then
    update public.posts set comments_count = greatest(comments_count - 1, 0) where id = old.post_id;
    return old;
  end if;
  return null;
end;
$$;
drop trigger if exists comments_count_after on public.comments;
create trigger comments_count_after after insert or delete on public.comments
for each row execute procedure public.update_post_comment_count();

-- ── Bookmarks ───────────────────────────────────────────────────────────────
create table if not exists public.bookmarks (
  user_id uuid not null references public.profiles(id) on delete cascade,
  post_id uuid not null references public.posts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(user_id, post_id)
);

-- ── Views (one per signed-in user per post) ──────────────────────────────────
create table if not exists public.post_views (
  post_id uuid not null references public.posts(id) on delete cascade,
  viewer_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(post_id, viewer_id)
);

create or replace function public.increment_post_view_count()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.posts set views_count = views_count + 1
  where id = new.post_id and user_id <> new.viewer_id;
  return new;
end;
$$;
drop trigger if exists post_views_increment_after on public.post_views;
create trigger post_views_increment_after after insert on public.post_views
for each row execute procedure public.increment_post_view_count();

-- ── Notifications ───────────────────────────────────────────────────────────
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  post_id uuid references public.posts(id) on delete set null,
  type text not null check (type in ('comment', 'bookmark', 'message')),
  message text not null,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists notifications_recipient_created_idx on public.notifications(recipient_id, created_at desc);

create or replace function public.notify_post_comment()
returns trigger language plpgsql security definer set search_path = public as $$
declare owner_id uuid;
begin
  select user_id into owner_id from public.posts where id = new.post_id;
  if owner_id is not null and owner_id <> new.user_id then
    insert into public.notifications(recipient_id, actor_id, post_id, type, message)
    values(owner_id, new.user_id, new.post_id, 'comment', 'commented on your post');
  end if;
  return new;
end;
$$;
drop trigger if exists notify_comment_after on public.comments;
create trigger notify_comment_after after insert on public.comments
for each row execute procedure public.notify_post_comment();

create or replace function public.notify_post_bookmark()
returns trigger language plpgsql security definer set search_path = public as $$
declare owner_id uuid;
begin
  select user_id into owner_id from public.posts where id = new.post_id;
  if owner_id is not null and owner_id <> new.user_id then
    insert into public.notifications(recipient_id, actor_id, post_id, type, message)
    values(owner_id, new.user_id, new.post_id, 'bookmark', 'saved your post');
  end if;
  return new;
end;
$$;
drop trigger if exists notify_bookmark_after on public.bookmarks;
create trigger notify_bookmark_after after insert on public.bookmarks
for each row execute procedure public.notify_post_bookmark();

-- ── Direct messages ─────────────────────────────────────────────────────────
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  body text not null,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  constraint message_not_blank check (char_length(trim(body)) between 1 and 2000),
  constraint no_self_message check (sender_id <> recipient_id)
);
create index if not exists messages_sender_created_idx on public.messages(sender_id, created_at desc);
create index if not exists messages_recipient_created_idx on public.messages(recipient_id, created_at desc);

create or replace function public.notify_new_message()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.notifications(recipient_id, actor_id, type, message)
  values(new.recipient_id, new.sender_id, 'message', 'sent you a message');
  return new;
end;
$$;
drop trigger if exists notify_message_after on public.messages;
create trigger notify_message_after after insert on public.messages
for each row execute procedure public.notify_new_message();

-- ── Row Level Security ──────────────────────────────────────────────────────
alter table public.profiles enable row level security;
alter table public.posts enable row level security;
alter table public.comments enable row level security;
alter table public.bookmarks enable row level security;
alter table public.post_views enable row level security;
alter table public.notifications enable row level security;
alter table public.messages enable row level security;

-- Profiles: public to read, owner only to modify.
drop policy if exists "profiles are public" on public.profiles;
create policy "profiles are public" on public.profiles for select using (true);
drop policy if exists "profile owner updates profile" on public.profiles;
create policy "profile owner updates profile" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- Posts: public feed, authenticated owners create/update/delete their own.
drop policy if exists "posts are public" on public.posts;
create policy "posts are public" on public.posts for select using (true);
drop policy if exists "users create own posts" on public.posts;
create policy "users create own posts" on public.posts for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "users delete own posts" on public.posts;
create policy "users delete own posts" on public.posts for delete to authenticated using (user_id = auth.uid());

-- Comments: public read; signed-in users can create and delete their own.
drop policy if exists "comments are public" on public.comments;
create policy "comments are public" on public.comments for select using (true);
drop policy if exists "users create own comments" on public.comments;
create policy "users create own comments" on public.comments for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "users delete own comments" on public.comments;
create policy "users delete own comments" on public.comments for delete to authenticated using (user_id = auth.uid());

-- Bookmarks are private to their owner.
drop policy if exists "users read own bookmarks" on public.bookmarks;
create policy "users read own bookmarks" on public.bookmarks for select to authenticated using (user_id = auth.uid());
drop policy if exists "users create own bookmarks" on public.bookmarks;
create policy "users create own bookmarks" on public.bookmarks for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "users delete own bookmarks" on public.bookmarks;
create policy "users delete own bookmarks" on public.bookmarks for delete to authenticated using (user_id = auth.uid());

-- View insert only. The primary key prevents repeat views per user/post.
drop policy if exists "users read own post views" on public.post_views;
create policy "users read own post views" on public.post_views for select to authenticated using (viewer_id = auth.uid());
drop policy if exists "users record own post views" on public.post_views;
create policy "users record own post views" on public.post_views for insert to authenticated
with check (viewer_id = auth.uid() and exists(select 1 from public.posts p where p.id = post_id and p.user_id <> auth.uid()));

-- Notifications belong only to their recipient. Inserts are trigger-only.
drop policy if exists "users read own notifications" on public.notifications;
create policy "users read own notifications" on public.notifications for select to authenticated using (recipient_id = auth.uid());
drop policy if exists "users mark own notifications read" on public.notifications;
create policy "users mark own notifications read" on public.notifications for update to authenticated using (recipient_id = auth.uid()) with check (recipient_id = auth.uid());

-- Messages can only be seen by sender/recipient; only sender inserts; recipient marks read.
drop policy if exists "participants read their messages" on public.messages;
create policy "participants read their messages" on public.messages for select to authenticated using (sender_id = auth.uid() or recipient_id = auth.uid());
drop policy if exists "users send messages as themselves" on public.messages;
create policy "users send messages as themselves" on public.messages for insert to authenticated with check (sender_id = auth.uid());
drop policy if exists "recipients mark messages read" on public.messages;
create policy "recipients mark messages read" on public.messages for update to authenticated using (recipient_id = auth.uid()) with check (recipient_id = auth.uid());

-- Least-privilege SQL grants (RLS remains the actual row-level security boundary).
grant usage on schema public to anon, authenticated;
grant select on public.profiles, public.posts, public.comments to anon, authenticated;
grant update on public.profiles to authenticated;
grant insert, delete on public.posts to authenticated;
grant insert, delete on public.comments to authenticated;
grant select, insert, delete on public.bookmarks to authenticated;
grant select, insert on public.post_views to authenticated;
grant select on public.notifications to authenticated;
grant update (is_read) on public.notifications to authenticated;
grant select, insert on public.messages to authenticated;
grant update (read_at) on public.messages to authenticated;

-- ── Storage buckets ─────────────────────────────────────────────────────────
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values
  ('loop-posts', 'loop-posts', true, 52428800, array['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/quicktime','video/x-m4v']),
  ('loop-avatars', 'loop-avatars', true, 4194304, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Public read is intentionally limited to these public media buckets.
drop policy if exists "public can view loop post media" on storage.objects;
create policy "public can view loop post media" on storage.objects for select using (bucket_id in ('loop-posts', 'loop-avatars'));
drop policy if exists "users upload to own loop folders" on storage.objects;
create policy "users upload to own loop folders" on storage.objects for insert to authenticated
with check (bucket_id in ('loop-posts', 'loop-avatars') and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "users update own loop media" on storage.objects;
create policy "users update own loop media" on storage.objects for update to authenticated
using (bucket_id in ('loop-posts', 'loop-avatars') and (storage.foldername(name))[1] = auth.uid()::text)
with check (bucket_id in ('loop-posts', 'loop-avatars') and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "users delete own loop media" on storage.objects;
create policy "users delete own loop media" on storage.objects for delete to authenticated
using (bucket_id in ('loop-posts', 'loop-avatars') and (storage.foldername(name))[1] = auth.uid()::text);

-- Enable Supabase Realtime for inbox and notifications (safe to re-run).
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages') then
    alter publication supabase_realtime add table public.messages;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications') then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;

-- Done. Configure Auth > URL Configuration after deploying the GitHub Pages site.
