# Prayer tracker

The ward prayer tracker, moved off browser `localStorage` and onto SQLite on disk,
served over HTTP so it works from a phone or any other device.

No npm dependencies — it uses `node:sqlite` and `node:http`, both built into Node.
Requires **Node 22 or newer** (you have 24).

```
server.mjs      HTTP server: static files + JSON API
db.mjs          schema and all SQL
import.mjs      load a backup JSON into the database
backup.mjs      timestamped .db + .json snapshots
public/         the app itself (index.html)
data/           the database lives here (gitignored)
backups/        snapshots (gitignored)
```

## First run

The database already holds an import of the August 7 export. To load a fresher
one, export from the standalone app first (`../prayer-tracker.html`, Roster tab
→ **Export**), then:

```
cd D:\source\prayer-tracker\server
node import.mjs "D:\path\to\prayer-tracker-backup-<date>.json"
npm start
```

Then open <http://localhost:8787>. Importing replaces everything in the database,
so it is the same operation as the app's own Import button.

## Suggestions

The Suggest tab lists each group (youth, adults) in three fixed tiers:

1. **Has a calling, never asked** — the people most worth chasing first
2. **Never asked** — everyone else with no prayer on record
3. **Longest since asked** — oldest first

Every tier header shows “N of M” and a **show all** link, so the full list is
one click away when the shortlist doesn’t fit the week.

**Adjust suggestions** opens a small panel with per-group settings:

| Setting                       | What it does                                              |
| ----------------------------- | --------------------------------------------------------- |
| Calling · never asked / Never asked / Longest since asked | how many names each tier lists |
| Skip if asked within (weeks)  | anyone asked more recently is left out entirely            |
| Draw “longest ago” from top     | size of the pool the last tier draws from — bigger = more variety |
| Randomize the picks           | off means strictly the top of each tier, same names every time |

These live in the database under the `suggest.` settings prefix, so the phone and
the desktop share them. **Reset to defaults** puts them back.

The draw is seeded, so switching tabs shows the same people — **↻ Reshuffle**
is what re-rolls it.

## Everyday use

**Open <http://localhost:8787>, not the HTML file.** Double-clicking
`public/index.html` loads it as `file://`, which can't reach the database — the
page will tell you so if you try. Double-click **`Prayer Tracker.cmd`** to start
the server and open the browser in one step.

```
npm start                      # http://localhost:8787
npm start -- --port 9000       # different port
npm run backup                 # snapshot into backups/
npm test                       # 55 tests, uses throwaway databases
```

## Reaching it from your phone

The server listens on `0.0.0.0`, so it is reachable at your machine's IP as soon
as it is running. With Tailscale installed on both this machine and the phone:

1. `tailscale ip -4` here gives you an address like `100.x.y.z`.
2. On the phone, browse to `http://100.x.y.z:8787`.
3. In Safari or Chrome, "Add to Home Screen" gives it an app icon.

Windows Firewall may prompt the first time — allow it on private networks.
Because Tailscale is a private network, nothing is exposed to the public internet.

### Keeping it running

To have it start with Windows, create a scheduled task that runs at logon:

```
schtasks /create /tn "Prayer Tracker" /sc onlogon /rl highest ^
  /tr "node --no-warnings D:\source\prayer-tracker\server\server.mjs"
```

Run `schtasks /delete /tn "Prayer Tracker"` to undo it. A nightly backup is worth
adding too:

```
schtasks /create /tn "Prayer Tracker Backup" /sc daily /st 02:00 ^
  /tr "node --no-warnings D:\source\prayer-tracker\server\backup.mjs"
```

## How syncing works

The app still keeps one in-memory `state` object and still calls `saveState()`
after every change — that part is unchanged, which is why the ~1,900 lines of
UI code needed almost no edits.

What changed is what `saveState()` does. It compares `state` against a snapshot
of what the server last confirmed and sends **only the records that actually
changed**. Editing one member sends about 400 bytes rather than rewriting all
105KB, and two devices editing different members don't overwrite each other.

- Writes are debounced 400ms and applied server-side in a single transaction.
- Every write carries the version the client last saw. If the server has moved
  on, it answers `409` with its current state; the client keeps its own edited
  records, adopts the server's for everything else, and retries.
- Open tabs poll `/api/version` every 20s and pull changes made elsewhere.
- The status pill in the header shows Saved / Saving / Not saved. If the server
  is unreachable the app retries every 5s; click the pill to retry immediately.
- `localStorage` is still written on every save as a crash net. It is never
  restored automatically — the server is always the source of truth.

### Concurrency, honestly

Conflicts are resolved per record, not per field. If you edit the *same* member
on two devices at once, the last save wins for that member. Different members,
or different fields on different members, merge cleanly. For one person using a
phone and a desktop, that's the behaviour you want.

## API

| Method | Path           | Purpose                                       |
| ------ | -------------- | --------------------------------------------- |
| GET    | `/api/state`   | whole state, in the shape the app uses         |
| GET    | `/api/version` | current version only — cheap poll target       |
| POST   | `/api/sync`    | apply a delta (`{baseVersion, delta}`)         |
| POST   | `/api/import`  | replace everything with a backup object        |
| GET    | `/api/export`  | download a backup (works from the phone too)   |
| GET    | `/api/health`  | status and row counts                          |

## Schema

`members` keyed by the app's existing id, `log` keyed by date (one prayer
assignment per Sunday, matching the app's own rule), and `settings` as key/value
for the YPT message wording (`ypt.*`) and the suggestion tuning (`suggest.*`).

Booleans (`hasCalling`, `notBaptized`) are stored as INTEGER and omitted from
the JSON when false, which matches how the app already treats them — absent and
false are the same thing to the UI.

Deleting a member sets their log references to NULL rather than deleting the
prayer history, so the record of that Sunday survives.

## Backups

`npm run backup` writes both a `.db` (via `VACUUM INTO`, consistent even while
the server is running) and a `.json` in the same format the app's Export button
produces — so a JSON backup can be restored either with `import.mjs` or through
the app's own Import button. It keeps the 30 most recent by default.

To restore: `node import.mjs backups/prayer-tracker-<stamp>.json`

## Notes

- `../prayer-tracker.html` is the standalone build and still works off
  localStorage. It is the one actually in use; this version is not deployed yet.
  Changes to shared logic have to land in both files.
- There is no authentication. That's fine on Tailscale, where the machine isn't
  publicly reachable. If you ever put this on a public host, add auth first —
  the data includes names, phone numbers, emails, and birthdates.
