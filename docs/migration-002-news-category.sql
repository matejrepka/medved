-- Migration 002: kategória pre správy (news_logs.category)
-- Spusti raz v Supabase SQL editore.
--
-- 'warning'  = medvedie varovanie — admin mu priradí lokalitu, zobrazí sa na
--              mape vlastnou hranatou značkou a popup odkazuje na článok.
--              NEzobrazuje sa v zozname správ.
-- 'article'  = bežný článok o medveďoch — len v zozname správ, bez značky na
--              mape a bez lokality v zázname.
--
-- Existujúce riadky dostanú 'article' (na mape sa teda zobrazia len správy, ktoré
-- admin výslovne označí ako varovanie).

alter table public.news_logs
  add column if not exists category text not null default 'article'
  check (category in ('warning', 'article'));

create index if not exists news_logs_category_idx
  on public.news_logs (category);
