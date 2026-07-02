-- Migration 004 — moderácia hlásení z tumedved.sk.
--
-- Doteraz sa scrapované hlásenia (tumedved_logs) zobrazovali na mape hneď.
-- Odteraz nové hlásenia čakajú na schválenie adminom (rovnako ako správy a
-- hlásenia od používateľov). Existujúce riadky nastavíme na 'approved', aby
-- z mapy nič nezmizlo — moderácia sa týka len nových hlásení.
--
-- Spusti raz v Supabase SQL editore.

alter table public.tumedved_logs
  add column if not exists status text not null default 'approved'
  check (status in ('pending', 'approved', 'rejected'));

create index if not exists tumedved_logs_status_idx
  on public.tumedved_logs (status);
