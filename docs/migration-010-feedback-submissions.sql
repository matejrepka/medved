-- Migration 010: durable website feedback and newsletter poll responses.
-- Run once after the base schema. Only the server service role can access rows.

create table if not exists public.feedback_submissions (
  id bigserial primary key,
  kind text not null check (kind in ('message', 'newsletter_poll')),
  choice text,
  message text,
  email text,
  email_status text not null default 'pending'
    check (email_status in ('pending', 'sent', 'failed', 'disabled')),
  email_error text,
  email_delivered_at timestamptz,
  user_agent text,
  ip_hash text,
  created_at timestamptz not null default now(),
  constraint feedback_submissions_payload_check check (
    (kind = 'message' and message is not null and char_length(message) between 3 and 2000 and choice is null)
    or
    (kind = 'newsletter_poll' and choice in ('Áno, určite', 'Možno, podľa obsahu', 'Nie, stačí mi web') and message is null)
  )
);

create index if not exists feedback_submissions_created_at_idx
  on public.feedback_submissions (created_at desc);

create index if not exists feedback_submissions_kind_created_at_idx
  on public.feedback_submissions (kind, created_at desc);

alter table public.feedback_submissions enable row level security;

revoke all on table public.feedback_submissions from anon, authenticated;
