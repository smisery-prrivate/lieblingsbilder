# Lieblingsbilder

Keep your favourite photos, with the date they were taken, encrypted end to end; see them by month,
make a collage of any month, share a photo again from the app. Built the Snapdoc way: a web app, no
build step, local first, the Snapdoc vault and lock taken over as they are. Lives in
`braindump/photos/` for now; moving it into a repository of its own is a copy.

## What it does

- **Add.** The big plus opens the phone's gallery (several pictures at once). On Android the app also
  appears in the share sheet of the gallery and of any other app ("Share → Lieblingsbilder"). The
  picture is stored exactly as it is: the original bytes, nothing re-encoded. iPhones do not offer
  the share sheet to web apps; there the plus is the way in.
- **Date taken.** Read from the picture itself (EXIF in JPEG, WebP and PNG: DateTimeOriginal, then
  DateTimeDigitized, then DateTime). A picture without one gets the file's date, and the summary
  says so; the date can be changed in the viewer. The month decides where the photo appears and
  which collage it joins, so monthly collages over the years are possible.
- **Home.** Months, newest first, each a grid of thumbnails. Folders (Family, Holidays, …) are a
  row of chips above; a photo can be put into one folder from the viewer or for several at once.
  Long press, or *Select*, turns the grid into a pick list: share, folder or delete several photos.
- **Viewer.** Swipe between photos; Share (the system share sheet with the original file, a download
  on the PC), Date, Folder, Delete; `⋯` for caption, details and "Save to this device".
- **Collage.** Every month with two or more photos has a *Collage* button: the month's photos on one
  picture (up to 16, evenly picked if there are more), with the month's name, to share or save.
  Made from the thumbnails on this device, so it is quick and needs no download.
- **Sync.** Optional. Sign in by e-mail link, choose an encryption password once, and every photo
  appears on every device that signs in and knows the password. A second device fetches the
  thumbnails first and the full picture when a photo is opened (or all of them: menu, "Keep every
  full-size photo here").
- **Lock.** Optional. Fingerprint or screen lock, or a password or long PIN, exactly as in Snapdoc.
- **Rooms.** Shared spaces, as simple as a chat: everyone in a room adds pictures and sees all of
  them, and only the person who added a picture can change or delete it. Own photos and the rooms
  are a vertical stack of screens like Stillzeit's: arrow bars above and below name the neighbour,
  a vertical swipe in the button area or on a bar moves one step (circular). The plus adds to the
  space that is open; a picture from the share sheet asks which space it goes to when there are
  rooms. A room is made in the menu (needs cloud sync) and shared with an invite link
  (`#join=<room>.<token>.<key>`, like Stillzeit's family link); whoever opens it and signs in is
  in. The invite link is the room's key: send it only to the people who belong in.

## Encryption, and what a compromise of one part gives away

All of it is AES-256-GCM in `vault.js` (WebCrypto, no libraries), the Snapdoc vault with its labels
renamed so that both apps can live on one origin. The parts are kept apart on purpose:

| Part | What it holds | Compromised alone gives |
| --- | --- | --- |
| **Local key** (one per device) | every image, thumbnail, the photo list and the sign-in token on the device | this device's copy only; with a key-bound lock (fingerprint / long PIN) not even that |
| **Cloud account** (Supabase sign-in) | ciphertext files and sealed entries | nothing readable; a deleted or swapped entry is noticed (sealed with its change time and delete flag) |
| **Cloud key** (wrapped by the encryption password, which never leaves the device) | the per-photo keys inside the entries | the collection, but only together with the password or an unlocked device |
| **Per-photo key** (random, carried wrapped in the photo's entry) | that photo's full picture and thumbnail, through two derived keys | one photo; thumbnail keys open no full pictures |
| **Room key** (random, held by the members; in the invite link's fragment, which never reaches the server; in the cloud only wrapped by each member's cloud key) | that room's entries and per-photo keys | that room, nothing of anyone's own photos or other rooms |
| **Server** | ciphertext, sizes, stamps | cannot read, forge or swap: files carry the photo id, tag and kind inside the encryption |

Honest limits, the same as in Snapdoc: a web page cannot scrub browser storage files, so turn the
lock on before adding anything private; and all of the owner's GitHub Pages apps share one origin,
so a script in a sibling app could reach this app's storage. A key-bound lock keeps the key out of
reach even then; an address of its own is the full answer and is the owner's decision. The share
sheet has one limit of its own: a shared picture lies in the browser's database unencrypted for the
seconds until the app has taken it over (the service worker has no key); it comes from the gallery,
where it is unencrypted anyway, and the slot is cleared at once.

Everything else is as in Snapdoc: no cookies, no analytics, no third-party scripts or fonts; a
Content-Security-Policy allows the app's own origin and Supabase only; no inline script; the page
refuses to run inside another site's frame; one active window at a time; a PKCE sign-in link that
only this browser can exchange and that is accepted only within an hour of asking for it; the lock
restarts the page so no decrypted picture stays in memory.

## Files

| File | Role |
| --- | --- |
| `index.html` | Layout and styles, no inline script |
| `vault.js` | All cryptography and the lock methods (Snapdoc's, labels renamed) plus per-photo keys |
| `app-core.js` | Helpers, the write guard, encrypted storage, the photo list, screens, back button |
| `app-photos.js` | Adding pictures, the date from the picture, thumbnails, home, viewer, folders, collage |
| `app-lock.js` | Lock screen, the menu and the small sheets |
| `app-sync.js` | Sign-in, encryption password, sync loop, downloads on demand, rooms |
| `app-boot.js` | One active window, start-up order, updates, housekeeping |
| `sw.js` | Offline shell (one complete release) and the share-sheet receiver |
| `supabase-schema.sql` | Tables, policies and the private bucket (run once, safe to run again) |

## Sync rules

- Local first. The app works fully without an account.
- A picture never changes, so its files are written once: `lb/<user>/<photo id>.<tag>` (full) and
  `…<tag>.t` (thumbnail), under a random tag and the photo's own key. Only the small entry moves
  (date, folder, caption, deletion), sealed with its change time; the later change wins, a delete
  beats a live change with the same stamp, equal stamps are decided alike on every device.
- Entries are written conditionally on the server stamp last seen (a sequence, never a clock);
  if another device wrote first, its entry is taken in and the write tried once more.
- Deleting removes the files only after the cloud confirms the delete marker is current; a delete
  on one device while another keeps the photo with a later change sends the picture up again under
  a fresh tag and key. Objects nothing refers to are removed, or remembered and removed later.
- A refused upload is tried again after a growing pause (1 min, 4 min, … up to an hour).
- Rooms: `lb_rooms` holds a sealed name and invite token and the token's hash; `lb_room_members`
  holds who is in and each member's wrapped copy of the room key. Joining goes through the
  function `lb_join_room`, which checks the token's hash before adding the member. Every photo
  entry carries `room_id`; members read a room's entries and objects (`room/<room id>/…`), only
  the uploader writes or deletes them. Each space has its own pull bookmark, so a room joined
  later is read from its beginning. Whoever adds a picture to a room is named inside the sealed
  entry by the part of their e-mail before the @.

## Set-up (once, by the owner)

Like Snapdoc, the app gets its **own Supabase project**.

1. supabase.com → new project, EU region. Project Settings → API: put the URL and the publishable
   key into `config.js`, and narrow `connect-src` in `index.html` from `https://*.supabase.co` to
   that one address.
2. SQL Editor → paste and run `supabase-schema.sql`.
3. Authentication → URL Configuration: Site URL and redirect URL = the app's address (with the
   trailing slash, e.g. `https://smisery-prrivate.github.io/braindump/photos/`).
4. After the first sign-in: Authentication → switch off new sign-ups.
5. Publish with GitHub Pages (the share sheet, fingerprint lock and installing need HTTPS).

Free Supabase projects pause after a week without requests (restart in the dashboard) and hold
**1 GB** of files. See "Storage" below before relying on it for thousands of photos.

## Storage: thousands of photos a year

The app keeps only thumbnails on a second device by default, fetches full pictures on demand and
never decrypts more than it shows, so the list itself scales. The cloud bucket is the limit:
thousands of photos a year at 2–5 MB each is several GB a year.

- **Supabase Storage** (as built): 1 GB free; Pro is about USD 25 a month for 100 GB.
- **Google Drive as the file store**: feasible, and Snapdoc already has the sign-in code for it
  (`app-drive.js`, scope `drive.file`, no Google script loaded). Here the files would stay
  encrypted (Snapdoc stores plain PDFs on Drive on purpose), so Google holds ciphertext only; the
  entries, keys and sync stamps stay in Supabase, where they are small. 15 GB free, 100 GB for
  about EUR 2 a month.
- **Proton Drive**: no interface for third-party web apps (no OAuth, no public API); a static web
  app cannot write to it. Not an option unless Proton opens one.

Recommendation: Google Drive for the ciphertext files, Supabase for everything small. The file
store is one function pair in `app-sync.js` (`uploadPhoto`, `fetchFull`/`fetchThumb`), so the
switch does not touch the rest.

## Release habit

`VERSION` in `app-core.js`, `CACHE` in `sw.js` and the commit message move together. New files go
into the `ASSETS` list in `sw.js`.

## History

- v1 (2026-10-26): first release, tested against a stand-in cloud with two browsers (import,
  EXIF dates and orientation, folders, lock, sign-in, upload, second device, delete across devices,
  share sheet, collage) and with two accounts (rooms: create, invite link, join before and after
  sign-in, pictures from both sides, no delete of the other's pictures, leave).
