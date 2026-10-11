# SkySearch

Flugsuche auf Basis von Google Flights (über [SerpAPI](https://serpapi.com/)). Läuft als statische Seite auf Cloudflare Pages; die Suchlogik steckt in der Pages Function `functions/api/flights.js`.

## So findet die App günstigere Flüge

Eine Suche wird im Backend in mehrere SerpAPI-Abfragen aufgefächert, parallel ausgeführt und verglichen:

| Option | Was passiert |
|---|---|
| **Flexible Daten** | Sucht ±1–3 Tage (Hin & Rück: ±2 Tage als Preis-Matrix) und zeigt einen Preiskalender. |
| **Flughäfen im Umkreis** | Erweitert z. B. `VIE` → `VIE,BTS`, `MUC` → `MUC,MEM,NUE,SZG` (keine Zusatzkosten, eine Abfrage). |
| **Mit Einzeltickets vergleichen** | Hin & Rück: vergleicht mit zwei One-Way-Tickets. Trip-Planer: mit jeder Strecke als Einzelticket. |
| **Verkaufsländer vergleichen** | Fragt das Wunschdatum zusätzlich mit `gl=at/de/ch/gb/us` ab. |
| **Handgepäck im Preis** | `bags` – Preise inklusive Handgepäck-Gebühren, damit Billigflieger fair verglichen werden. |
| **Max. Preis** | `max_price`-Filter. |
| **Genaue Preise** | `deep_search` – dieselben Preise wie im Browser, dafür langsamer. |
| **Entdecken** | `google_travel_explore` – günstigste Ziele ab einem Flughafen. |

Außerdem: `show_hidden=true`, Google-Preiseinschätzung (`price_insights`) und Standard-Sortierung nach Preis.
Hin- & Rückflüge sowie Multi-City-Strecken werden über `departure_token` Schritt für Schritt gewählt (der angezeigte Preis ist bereits der Gesamtpreis). Gebucht wird über die Buchungsoptionen von Google (`booking_token`).

## Einrichtung (Cloudflare Pages)

1. Im Pages-Projekt unter *Settings → Variables and Secrets* das Secret **`SERPAPI_KEY`** setzen.
2. Optional:
   - `MAX_QUERIES` – max. SerpAPI-Abfragen pro Suche (Standard 40)
   - `CACHE_TTL` – Cache-Dauer in Sekunden (Standard 7200, `0` = aus)
   - `ALLOWED_ORIGINS` – kommagetrennte erlaubte Origins (z. B. `https://flights.example.com`), damit fremde Seiten das Kontingent nicht nutzen
3. Deployen – die Function ist automatisch unter `/api/flights` erreichbar.

Alternativ als eigener Worker: siehe Kommentar in `worker.js`, danach die Worker-URL in den App-Einstellungen eintragen.

> **Wichtig:** Früher stand ein SerpAPI-Key im Frontend-Code. Er ist weiterhin in der Git-Historie sichtbar und muss im SerpAPI-Dashboard neu erzeugt werden.

## Kosten

Jede nicht gecachte Abfrage verbraucht ein SerpAPI-Credit. Die App zeigt vor der Suche, wie viele Abfragen sie höchstens braucht. Identische Abfragen kommen 2 h lang aus dem Cloudflare-Cache (nur auf einer eigenen Domain, nicht unter `*.workers.dev`).

## Tests

```bash
npm test
```
