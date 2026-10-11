# OleOS

OleOS ist ein browserbasierter Retro-Desktop mit React, TypeScript, Vite, Express, SQLite und Prisma. Discord ist die einzige Anmeldemethode; es gibt kein Registrierungsformular.

## Voraussetzungen

- Node.js 20 oder neuer
- npm 10 oder neuer
- Eine Discord-Anwendung aus dem Discord Developer Portal für den OAuth-Login

## Lokal einrichten

1. Abhängigkeiten installieren:

   ```sh
   npm install
   ```

2. Umgebungsdatei anlegen:

   ```sh
   cp .env.example .env
   ```

   Unter Windows PowerShell geht das mit `Copy-Item .env.example .env`.

3. Einen langen, zufälligen Session-Schlüssel erzeugen und als `SESSION_SECRET` in `.env` eintragen:

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
   ```

4. Discord-Anwendung konfigurieren:

   - Öffne das [Discord Developer Portal](https://discord.com/developers/applications) und erstelle eine Application.
   - Öffne **OAuth2** und trage diese Redirect-URI ein: `http://localhost:3001/api/auth/discord/callback`
   - Kopiere die **Application ID** nach `DISCORD_CLIENT_ID` in `.env`.
   - Erzeuge unter **OAuth2** ein Client Secret und trage es als `DISCORD_CLIENT_SECRET` ein. Das Secret bleibt ausschließlich auf dem Server.
   - `DISCORD_REDIRECT_URI` muss exakt mit der im Portal hinterlegten URI übereinstimmen.
   - Verwendet wird nur der Scope `identify`; ein Bot ist nicht erforderlich.

5. Starten:

   ```sh
   npm run dev
   ```

   Öffne die von Vite angezeigte lokale Adresse (standardmäßig `http://localhost:5173`). Wenn der Standardport belegt ist, wählt Vite einen freien Port; der Discord-Rücksprung folgt der aufgerufenen lokalen Seite. Der Dev-Start generiert den Prisma Client und richtet die SQLite-Tabellen ein. Die Datenbank liegt unter `prisma/dev.db`.

Ohne Discord-Zugangsdaten startet die Seite ebenfalls; der Login-Hinweis erklärt dann, welche `.env`-Werte noch fehlen.

## Produktionsbetrieb

Setze `NODE_ENV=production`, `APP_ORIGIN` auf die HTTPS-Adresse der Website, `DISCORD_REDIRECT_URI` auf `https://deine-domain/api/auth/discord/callback`, `SESSION_SECRET` auf einen neuen zufälligen Schlüssel und `TRUST_PROXY=true`, wenn OleOS hinter einem vertrauenswürdigen HTTPS-Reverse-Proxy läuft. Registriere dieselbe Redirect-URI im Discord Portal. Für eine entfernte dauerhafte Datenbank setze `TURSO_DATABASE_URL` und `TURSO_AUTH_TOKEN`; lokal bleibt SQLite über `DATABASE_URL` aktiv.

```sh
npm run build
npm start
```

Express liefert in Produktion das Vite-Build und die API auf demselben Origin aus. Der Session-Cookie ist HttpOnly, SameSite=Lax und in Produktion Secure. Verwende für flüchtige Hosting-Container eine Remote-Datenbank wie Turso, damit Daten Deployments und Neustarts überstehen.

## Sicherheitsdetails

- Discord Authorization Code Flow mit einmaligem kryptografischem `state` gegen CSRF.
- Session-ID-Rotation nach dem Login; serverseitige Session in SQLite oder Turso.
- API-Änderungen und Socket.IO-Schreibaktionen verlangen einen same-origin Request beziehungsweise synchronisierten CSRF-Token; Socket-Verbindungen prüfen ebenfalls den Origin.
- HTTP-Sicherheitsheader, Login-Rate-Limit, JSON-Größenlimit, validierte Profileingaben.
- Client Secret und Session-Schlüssel werden nie an den Browser ausgeliefert.

## Bedienung und Dateien

- `src/App.tsx` — Bootscreen, Discord-Login, Desktop, Startmenü und Fenstersystem.
- `src/social.tsx` — OleChat, Live-Presence, Netzwerkprofile und Dateifreigaben.
- `src/audio.ts` — synthetische Systemsounds mit der Web Audio API.
- `src/style.css` — Win95-inspirierte Oberfläche und Loginansicht.
- `server/index.js` — Express API, Discord OAuth, Sessions, Socket.IO und Moderation.
- `server/database.js` — Initialisierung der SQLite-Tabellen über Prisma.
- `server/prisma.js` — Prisma-Verbindung für lokale SQLite- oder optionale Turso-Nutzung.
- `server/generated/client/` — generierter Prisma Client (wird bei Setup/Build erstellt).
- `prisma/schema.prisma` — Nutzer-, Datei-, Chat-, Freigabe- und Moderationsmodelle.

Systemsounds werden lokal im Browser synthetisiert und erst nach einer Nutzerinteraktion abgespielt. Lautstärke, Stummschaltung und Benachrichtigungssounds lassen sich in der Taskleiste und in den Einstellungen ändern.

## Persönliche Dateien und Profil

Jeder Discord-Account erhält einen eigenen Dateibereich. In **Eigene Dateien** kannst du Ordner und Textdateien anlegen, öffnen, bearbeiten, umbenennen und verschieben. Gelöschte Elemente landen zunächst im Papierkorb und können von dort wiederhergestellt oder endgültig entfernt werden. Textdateien sind auf 1 MB begrenzt; Bilder auf 2 MB und PNG, JPEG, GIF oder WebP validiert.

Unter **Start → Einstellungen** kannst du deinen OleOS-Anzeigenamen und die Farbe des Desktops ändern. Diese Profildaten und Dateien werden serverseitig in SQLite oder der konfigurierten Turso-Datenbank gespeichert und sind an das angemeldete Discord-Konto gebunden.

Beim Serverstart legt `server/database.js` fehlende Tabellen an und ergänzt die neuen Profilspalten auch in vorhandenen OleOS-Datenbanken. Lokal liegen die Daten in `prisma/dev.db`; im öffentlichen Hosting liegen sie in der konfigurierten Turso-Datenbank.

## OleChat, Netzwerk und Freigaben

Die Phase-5-Social-Funktionen verwenden Socket.IO auf demselben Origin wie die Website. OleChat enthält die Räume **Allgemein**, **Lounge** und **Hilfe**, unterstützt eigene Räume, Direktnachrichten und einen persistenten Nachrichtenverlauf. Online-Nutzer werden live angezeigt und nach fünf Minuten ohne Aktivität als abwesend markiert.

In der **Netzwerkumgebung** kannst du OleOS-Profile sehen und eigene Textdateien und Bilder mit einem bestimmten Nutzer teilen. Freigaben sind für den Empfänger lesbar, bleiben in deinem Dateisystem und sind nicht öffentlich zugänglich. Geteilte Texte sind auf 1 MB, Bilder auf 2 MB begrenzt.

Für Moderationsrechte trägst du in `.env` unter `ADMIN_DISCORD_IDS` eine kommaseparierte Liste der Discord-User-IDs ein. Moderatoren können Chatnachrichten entfernen, Nutzer zeitweise stummschalten sowie sperren und entsperren. Lege die IDs nur serverseitig ab. Räume, Nachrichten, Freigaben und Moderationssperren werden in SQLite oder der konfigurierten Turso-Datenbank gespeichert.

## Kostenloses öffentliches Hosting mit GitHub, Render und Turso

GitHub Pages allein reicht nicht: Es veröffentlicht statische Dateien, führt aber weder Express/Socket.IO noch Discord OAuth aus. `render.yaml` stellt OleOS deshalb als kostenlosen Render-Webservice bereit. Render Free kann den Dienst nach Inaktivität schlafen legen; der erste Aufruf danach kann verzögert sein. Weil der kostenlose Container kein dauerhaftes Dateisystem hat, wird für Livebetrieb Turso als persistente Datenbank verwendet. Lokal bleibt SQLite aktiv.

1. Erstelle bei Turso eine Datenbank und einen Auth-Token. Die URL und den Token trägst du später in Render als `TURSO_DATABASE_URL` und `TURSO_AUTH_TOKEN` ein.
2. Lade den OleOS-Quellcode in dein GitHub-Repository.
3. Verbinde das Repository im Render-Dashboard und erstelle den Blueprint aus `render.yaml`. Ergänze `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `TURSO_DATABASE_URL` und `TURSO_AUTH_TOKEN`; `SESSION_SECRET` wird automatisch erzeugt. Secrets gehören nicht ins Repository.
4. Nach dem ersten Deploy kopiere die tatsächliche Render-URL. Trage im Discord Developer Portal unter **OAuth2 → Redirects** exakt `https://DEINE-RENDER-URL/api/auth/discord/callback` ein. Der Server leitet sie aus `RENDER_EXTERNAL_URL` ab.
5. Öffne OleOS über die HTTPS-URL. Für eine eigene Domain setze `APP_ORIGIN` auf deren HTTPS-Adresse und trage auch deren Callback-URL bei Discord ein. Für Moderation kannst du zusätzlich `ADMIN_DISCORD_IDS` setzen.

Vor dem ersten Start müssen beide Turso-Werte in Render gesetzt sein, sonst verwendet der Container seine temporäre SQLite-Datei.
