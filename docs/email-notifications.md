# E-mailové upozornenia

Integrácia posiela potvrdenie odberu a následne jeden spoločný súhrn všetkých čakajúcich
varovaní a správ o 6:00, 12:00 a 18:00 v časovom pásme Europe/Bratislava. Ak v rade
nič nie je, e-mail sa neodošle. Odber oblasti sa porovnáva bez ohľadu na veľkosť
písmen a slovenskú diakritiku s lokalitou, titulkom a popisom položky.

## Nasadenie

1. V Supabase SQL Editore spustite celý súbor
   `docs/migration-007-email-notifications.sql` a potom
   `docs/migration-009-email-digests.sql`. Migrácia 007 najprv označí historické zdroje
   ako známe, takže prvý refresh nerozošle staré hlásenia. Staré nepotvrdené odbery zostanú
   neaktívne a používateľ musí formulár odoslať znova.
2. V produkčnom prostredí nastavte:

   ```env
   SMTP_HOST=smtp.provider.example
   SMTP_PORT=587
   SMTP_SECURE=false
   SMTP_REQUIRE_TLS=true
   SMTP_USER=warning@kdejemedved.sk
   SMTP_PASS=...
   EMAIL_FROM=Kde je Medveď – upozornenia <warning@kdejemedved.sk>
   EMAIL_REPLY_TO=kontakt@kdejemedved.sk
   MODERATION_EMAIL_TO=kdejemedved@gmail.com
   SITE_URL=https://www.kdejemedved.sk
   NEWSLETTER_TOKEN_SECRET=nahodna-hodnota-s-minimalne-32-znakmi
   EMAIL_DIGEST_HOURS=6,12,18
   EMAIL_DIGEST_TIME_ZONE=Europe/Bratislava
   ```

   Pre implicitné TLS na porte 465 použite `SMTP_PORT=465` a `SMTP_SECURE=true`.
   `NEWSLETTER_TOKEN_SECRET` musí byť náhodný produkčný secret a nesmie sa meniť bez
   dôvodu; zmena zneplatní odkazy v už odoslaných e-mailoch.
3. Na doméne odosielateľa nastavte SPF, DKIM a DMARC podľa pokynov poskytovateľa schránky.
4. Nasaďte aplikáciu a skontrolujte `/api/status`; hodnota
   `emailNotificationsEnabled` má byť `true`.
5. Urobte testovací odber, potvrďte ho, pridajte nové manuálne varovanie v administrácii
   a overte doručenie aj odhlásenie.

## Spoľahlivosť a bezpečnosť

Používateľské hlásenia na schválenie sa odosielajú ihneď na
`MODERATION_EMAIL_TO` (predvolene `kdejemedved@gmail.com`) namiesto Telegramu.
E-mail obsahuje lokalitu, dátum, popis, ID hlásenia a odkaz na `/admin`, kde sa
moderátor prihlási a hlásenie schváli alebo zamietne. Otvorenie e-mailu ani odkazu
hlásenie neschváli. Tieto e-maily nečakajú na čas súhrnu ani na newsletterový odber.
Používajú existujúci trvácny rad `telegram_notification_outbox` a opakovanie pri
chybe SMTP (najviac 10 pokusov); vyžadujú existujúce migrácie 005 a 008.
Nie je potrebná nová migrácia. Bez Telegramu worker vyberá iba používateľské
hlásenia; ostatné Telegram udalosti necháva v rade. Už odoslané notifikácie sa
automaticky neposielajú znova. Pri chýbajúcom SMTP zostávajú hlásenia v rade na
opakovaný pokus, neposielajú sa náhradnou cestou cez Telegram.
Schvaľovacie e-maily potrebujú SMTP a HTTPS `SITE_URL`; nevyžadujú
`NEWSLETTER_TOKEN_SECRET`, pretože schvaľovanie chráni prihlásenie do administrácie.

- Newsletter sa neposiela bez potvrdenia vlastníctva adresy.
- Všetky pripravené položky jedného odberateľa sa nárokujú naraz a odošlú v jedinom
  e-maile so sekciami Varovania a Správy.
- Jedinečný kľúč `(subscription_id, dedupe_key)` zabráni opakovanému zaradeniu položky.
- SMTP chyby sa opakujú s exponenciálnym odstupom; po ôsmich pokusoch sa úloha označí
  ako `dead` na manuálnu kontrolu.
- Odhlásenie deaktivuje odber a zruší čakajúce úlohy. Každý e-mail obsahuje aj štandardné
  hlavičky `List-Unsubscribe` a `List-Unsubscribe-Post`.
- Heslo SMTP ani tokenový secret nepatria do repozitára.
