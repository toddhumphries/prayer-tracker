# Prayer tracker

One self-contained HTML file. Open `prayer-tracker.html` in a browser; the data
lives in that browser's `localStorage` under the key `ward-prayer-tracker-v1`.

Nothing to install, no server, no network calls.

## Backups

`localStorage` is not a safe place to keep the only copy of anything. Roster tab
→ **Export** writes `prayer-tracker-backup-<date>.json`, and **Import** reads one
back. Do this before changing browsers, clearing site data, or moving the file.

Exports are gitignored — they hold names, phone numbers, emails, and birthdates.

## Suggestions

The Suggest tab lists each group (youth, adults) in three fixed tiers:

1. **Has a calling · never asked**
2. **Never asked**
3. **Longest since asked** — oldest first

Each heading shows "N of M" with a **show all** link, so the full list is one
click away when the shortlist doesn't suit the week.

**Adjust suggestions** opens a per-group panel:

| Setting | What it does |
| --- | --- |
| Calling · never asked / Never asked / Longest since asked | how many names each tier lists |
| Skip if asked within (weeks) | anyone asked more recently drops out entirely |
| Draw "longest ago" from top | how deep the last tier's random draw reaches — bigger means more variety |
| Randomize the picks | off means strictly the top of each tier, the same names every week |

Settings live in `state.suggest`, so they persist in `localStorage` and travel
through Export/Import. **Reset to defaults** puts them back.

The draw is seeded, so switching tabs shows the same people — **↻ Reshuffle**
is what re-rolls it.

## Training reminders

The Training tab builds the youth-protection renewal emails. Paste the report
rows, and it works out who is actually due and drafts the batch.

The subject, link, and message body are editable under **Message settings**, and
the shipped template signs off with `[Your name]` / `[Your phone number]` —
replace those once and the wording is saved in `localStorage` from then on.

## Who counts as what

- **Youth** is age 8–20, **adults** are 21+ or anyone with no birthdate on file.
- Only `active` members are suggested. `notBaptized` excludes someone until the
  flag is cleared.
- "Last asked" is the later of the prayer log and the member's `lastPrayerRef`,
  which is how history predating the log is carried in.

## The server version

`server/` is the same app rebuilt against SQLite over HTTP, so it can be reached
from a phone. It is not in use yet. Changes to the suggestion
logic need to land in both files — they share the code but not the storage layer.
