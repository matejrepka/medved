-- Migration 004 — stav hlásení z verejných máp.
--
-- Doteraz sa scrapované hlásenia (tumedved_logs) zobrazovali na mape hneď.
-- Stĺpec umožňuje adminovi záznam zamietnuť. Priamo integrované zdroje
-- tumedved.sk, mapamedvedov.sk a sprejnamedveda.sk sa automaticky schvaľujú.
--
-- Spusti raz v Supabase SQL editore.

alter table public.tumedved_logs
  add column if not exists status text not null default 'approved'
  check (status in ('pending', 'approved', 'rejected'));

create index if not exists tumedved_logs_status_idx
  on public.tumedved_logs (status);
