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
| **Günstige Tage vorab gratis prüfen** | Bei flexiblen Daten werden zuerst kostenlos die Richtpreise von Travelpayouts (Aviasales Data API) geprüft; live per SerpAPI abgefragt werden nur der Wunschtag und die 2 günstigsten anderen Tage. |
| **Monatsübersicht** | Nach jeder Suche: Richtpreise für jeden Tag des Monats (gratis, Travelpayouts). Klick auf einen Tag startet die Live-Suche. |

**Deals ab Warschau:** Der Deploy-Workflow läuft zusätzlich täglich (05:17 UTC) und holt mit `scripts/fetch-deals.mjs` die Angebote ab Warschau von [Secret Flying](https://www.secretflying.com/) (RSS-Feed der Suche, Fallback: Suchseite). Sie werden als `deals.json` mit der Seite veröffentlicht und dort mit Link zurück auf Secret Flying angezeigt. Neue Deals werden mit der bisher veröffentlichten Liste zusammengeführt (alte Einträge bleiben bis zu 90 Tage), damit nichts verschwindet, wenn Secret Flying einzelne Seiten sperrt.

**Zuverlässiger täglicher Start:** GitHubs Zeitplan startet oft Stunden zu spät oder gar nicht. Deshalb hat der Worker einen Cloudflare-Cron-Trigger (05:17 UTC, `wrangler.toml`), der den Workflow per `workflow_dispatch` startet. Dafür einen Fine-grained GitHub-Token anlegen (Settings → Developer settings → Fine-grained tokens; *Only select repositories* → dieses Repo; Repository permissions → *Actions: Read and write*) und im Cloudflare-Dashboard beim Worker `skysearch-api` unter Settings → Variables and Secrets als Secret `GH_DISPATCH_TOKEN` eintragen (bleibt bei weiteren Deploys erhalten). Ohne Token schreibt der Cron nur einen Hinweis ins Worker-Log. Der GitHub-Zeitplan bleibt als Reserve aktiv.

Außerdem: `show_hidden=true`, Google-Preiseinschätzung (`price_insights`) und Standard-Sortierung nach Preis.
Hin- & Rückflüge sowie Multi-City-Strecken werden über `departure_token` Schritt für Schritt gewählt (der angezeigte Preis ist bereits der Gesamtpreis). Gebucht wird über die Buchungsoptionen von Google (`booking_token`).

## Einrichtung (GitHub Pages + Cloudflare Worker)

Die Seite liegt auf GitHub Pages, die Such-API läuft als Cloudflare Worker (`worker.js`, `wrangler.toml`).
Beides deployt `.github/workflows/deploy.yml` bei jedem Push auf `main`. Die Worker-URL wird dabei automatisch in die Seite eingetragen.

1. **Cloudflare:** Unter *Workers & Pages* einmalig eine `workers.dev`-Subdomain einrichten (falls noch nicht vorhanden).
   Unter *My Profile → API Tokens* einen Token mit der Vorlage **„Edit Cloudflare Workers"** erstellen.
   Die **Account-ID** steht auf der Übersichtsseite von *Workers & Pages*.
2. **GitHub → Settings → Secrets and variables → Actions → Secrets:**
   - `SERPAPI_KEY` – SerpAPI-Key
   - `TRAVELPAYOUTS_TOKEN` – API-Token aus dem Travelpayouts-Profil (für Richtpreise und Vorauswahl)
   - `CLOUDFLARE_API_TOKEN` – der Token aus Schritt 1
   - `CLOUDFLARE_ACCOUNT_ID` – die Account-ID
3. **GitHub → Settings → Pages:** Source = **GitHub Actions**.
4. Unter *Actions* den Workflow **Deploy** starten (oder auf `main` pushen).

Optional in `wrangler.toml` unter `[vars]`:
- `ALLOWED_ORIGINS` – erlaubte Seiten (Standard `https://henryai-stack.github.io`; bei eigener Domain ergänzen)
- `MAX_QUERIES` – max. SerpAPI-Abfragen pro Suche (Standard 40)
- `CACHE_TTL` – Cache-Dauer in Sekunden (Standard 7200, `0` = aus)
- `TP_CACHE_TTL` – Cache-Dauer für Travelpayouts-Daten in Sekunden (Standard 21600)

Optionale Repository-Variable `API_URL`: feste API-Adresse (z. B. eigene Domain) statt der `workers.dev`-URL.

Alternativ läuft alles auch auf Cloudflare Pages: Repo verbinden, Secret `SERPAPI_KEY` im Pages-Projekt setzen – die Function `functions/api/flights.js` ist dann unter `/api/flights` erreichbar.

> **Wichtig:** Früher stand ein SerpAPI-Key im Frontend-Code. Er ist weiterhin in der Git-Historie sichtbar und muss im SerpAPI-Dashboard neu erzeugt werden.

## Kosten

Jede nicht gecachte Abfrage verbraucht ein SerpAPI-Credit. Die App zeigt vor der Suche, wie viele Abfragen sie höchstens braucht. Identische Abfragen kommen 2 h lang aus dem Cloudflare-Cache. Achtung: Unter `*.workers.dev` greift der Cache nicht, dafür braucht der Worker eine eigene Domain (dann `API_URL` setzen).

## Tests

```bash
npm test
```
