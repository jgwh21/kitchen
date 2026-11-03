# Kitchen

Know what's in your fridge, freezer and cupboards, how much is left and when it expires, so
less food gets thrown away. It's a web app you install to the Home Screen of an iPhone or
Android phone. It's hosted free on GitHub Pages and there's no account or subscription.

## What it does

- **Add item** opens the camera. Photograph the label and **Claude reads it** for you: name,
  brand, type, pack size, use-by / best-before date and storage notes. Anything it fills in is
  tinted blue so you can check it before saving. What you type yourself is never overwritten.
  **Type it in** adds an item without a photo.
- Each item has a **type** (Dairy & eggs, Frozen, Fresh produce…), a **location** (Fridge –
  door, Freezer – drawer 2…), quantity, **how much is left** (Full, ¾, ½, ¼, nearly gone),
  expiry date, date opened and notes. Both lists can be changed in Settings. New items start
  in the location you used last.
- The list **sorts** by name (A–Z), expiry date, location, type, amount left or recently
  added, with headings when sorted by location, type or expiry. Search and filter by location
  or type.
- A banner shows what's **expired or due soon** (3 days by default, changeable). Tap it to see them.
- When something's finished, open it and tap **Used it up** or **Threw it away** (with Undo).
  Settings shows the running count, so you can see the waste going down.

## Sharing with friends

*Settings → Share my kitchen with a friend* sends a small file (about 10 KB plus a few KB per
item) through the share sheet: WhatsApp, Messages, email, AirDrop. Your friend saves it,
then in their Kitchen app taps *Open a kitchen file*. They see **"JG's Kitchen Inventory"**
read-only, with photos, and switch between kitchens by tapping the title. It's a snapshot:
share again to send an update, and it replaces the old one.

Also in Settings:
- **Send the list as a message**: a plain-text list grouped by location.
- **Export a spreadsheet (CSV)**: opens in Excel, Numbers or Google Sheets.

Set your name in Settings first; the kitchen is called "*name*'s Kitchen Inventory" unless you rename it.

## Reading labels with Claude (optional)

1. Create an account at **console.anthropic.com**, add some credit (the minimum is plenty),
   and set a **monthly spend limit** under *Settings → Limits*.
2. *API keys → Create key*, copy it, and paste it in the app's *Settings → Claude API key*.

Each photo costs about 0.03p with Claude Haiku 5.5 (the default), or about 0.5p with
Claude Sonnet 5.5 (choose under *Model*). If Claude can't read something, that field is left
blank for you to fill in. Only the label photo is sent, straight from the
phone to Anthropic. The key stays on that phone and is never put in shared or backup files.
Without a key, everything else works and you type the details in.

## Backups and a new phone

Everything is stored on the phone. **Deleting the app from the Home Screen deletes its data**,
so now and then use *Settings → Save a full backup* (to Files / iCloud Drive / Google Drive).
To move to a new phone, install the app there and *Open a kitchen file* with the backup, then
choose *It's mine*.

## Putting it online (one-time)

1. Create a **public** repository called `kitchen` at github.com/new (no README).
2. On the PC, in this project folder: `python publish.py`. It checks the version stamps, pushes
   the app, then waits until https://jgwh21.github.io/kitchen/ serves every file.
3. The first time only: on GitHub, *Settings → Pages → Deploy from a branch → main / (root)*,
   then run `python publish.py --check`.

## Installing

- **iPhone**: open https://jgwh21.github.io/kitchen/ in **Safari** → *Share → Add to Home Screen*.
  Use it from the Home Screen icon, which keeps its own storage.
- **Android**: open the address in **Chrome** → *⋮ → Add to Home screen / Install app*.

The version number shows under the title, with update progress next to it
("Downloading update, keep the app open…" → "Up to date").

## Updating the app

Commit the change, then `python build-upload.py --bump` (raises the version everywhere),
commit again, and `python publish.py`. Phones pick it up next time the app is opened online;
GitHub Pages can take a few minutes. Your items are untouched.

## Testing locally on the PC

```bash
python -m http.server 8766 --bind 127.0.0.1 --directory kitchen
```

Then open http://localhost:8766. Data made there is separate from the phone's.

## Known limits

- No expiry **notifications** yet: iPhone web apps only get those through a push server.
  The banner shows when you open the app.
- Sharing is a snapshot file, not live sync. Two people editing one kitchen live would need a
  small online database.
- iOS doesn't let web apps open files from the share sheet directly, so a friend saves the
  file first and opens it from inside the app.

## Files

- `index.html`, `styles.css`: the interface
- `js/app.js`: screens, list, editor, settings, updates
- `js/ai.js`: reading a label photo with Claude
- `js/share.js`: kitchen files (share/backup), CSV and text export
- `js/images.js`: shrinking photos and making thumbnails
- `js/db.js`: on-device storage (IndexedDB)
- `sw.js`, `manifest.webmanifest`, `icons/`: offline support and installability
