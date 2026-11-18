-- Loop: stop creating Notifications entries for incoming direct messages.
-- Run once in Supabase SQL Editor for an existing installation.

-- Remove the trigger before dropping its function.
drop trigger if exists notify_message_after on public.messages;
drop function if exists public.notify_new_message();

-- Clean up old DM notification rows so they no longer appear in Alerts.
delete from public.notifications where type = 'message';

-- Keep only post-interaction notification types for future inserts.
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications
  add constraint notifications_type_check check (type in ('comment', 'bookmark'));
