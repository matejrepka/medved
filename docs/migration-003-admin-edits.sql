-- Migration 003: ručné úpravy hlásení adminom (tumedved_logs.manually_edited)
-- Spusti raz v Supabase SQL editore.
--
-- tumedved_logs sa pri každom scrapingu prepisuje čerstvými dátami zo zdroja
-- (upsert s ON CONFLICT DO UPDATE). Keď admin hlásenie ručne upraví v správe
-- obsahu, nastaví sa manually_edited = true a scraper takýto riadok pri ďalšom
-- behu PRESKOČÍ — úprava sa teda nestratí.
--
-- Správy (news_logs) tento príznak nepotrebujú: scraper zapisuje len NOVÉ
-- články a existujúce id-čka (vrátane upravených) úplne preskakuje.

alter table public.tumedved_logs
  add column if not exists manually_edited boolean not null default false;

create index if not exists tumedved_logs_manually_edited_idx
  on public.tumedved_logs (manually_edited);
