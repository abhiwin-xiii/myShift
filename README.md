# MyShift

A mobile-friendly app for logging shifts, tracking pay, and keeping employer details in one place. Data syncs to a free cloud database (Supabase) so it's available across your devices once you're signed in — or it runs purely on-device with no account if you skip that setup.

## What's in this folder
- `index.html`, `style.css`, `app.js` — the app
- `manifest.json`, `sw.js`, `icons/` — makes it installable as a home-screen app (PWA) that works offline
- `config.js` — where you paste your Supabase project keys to turn on cloud sync (optional)
- `supabase-setup.sql` — one-time database setup script for Supabase

## Try it right now on your computer
No install needed — just open `index.html` directly in a browser to click around. Note: on `file://` the offline/install features won't activate (browsers require a real server for that), but everything else works fine for testing. Without Supabase configured (the default), the app runs in **local mode**: no login screen, all data in this browser's storage — same as before.

To preview it more like the real thing locally:
```
cd myshift
python3 -m http.server 8000
```
Then visit `http://localhost:8000` in your browser.

## Get it on your phone (recommended: GitHub Pages, free, ~5 minutes)
1. Create a free GitHub account if you don't have one, and create a new repository (e.g. `myshift`).
2. Upload all the files in this folder to that repository (drag-and-drop works on github.com, or use `git push`).
3. In the repo, go to **Settings → Pages**, set source to the `main` branch, root folder. Save.
4. GitHub gives you a URL like `https://yourname.github.io/myshift/`. Open it on your phone.
5. In Safari (iPhone): tap Share → **Add to Home Screen**. In Chrome (Android): tap the menu (⋮) → **Install app** / **Add to Home Screen**.
6. You now have a MyShift icon that opens full-screen and works offline (once signed in, your data is also cached locally between syncs).

Any static host works the same way (Netlify, Vercel, Cloudflare Pages) if you'd rather use one of those.

## Turning on cloud sync (Supabase) — optional, ~10 minutes
Skip this section if you're happy with local-only storage (no login, data stays on one device).

1. Go to [supabase.com](https://supabase.com) and create a free account, then create a new project (pick any name/region; the free tier is plenty for this app).
2. Once the project is ready, open **SQL Editor** in the left sidebar → **New query**, paste in the contents of `supabase-setup.sql` (included in this folder), and run it. This creates the table that stores your data and locks it down so only you can ever read or write your own row.
3. Go to **Project Settings → API**. Copy the **Project URL** and the **anon public** key.
4. Open `config.js` in this folder and paste them in:
   ```js
   window.MYSHIFT_SUPABASE_URL = "https://xxxxx.supabase.co";
   window.MYSHIFT_SUPABASE_ANON_KEY = "eyJhbGciOi...";
   ```
5. (Optional, recommended for personal use) In **Authentication → Providers → Email**, turn off "Confirm email" so you can sign up and start using the app immediately without checking your inbox. Leave it on if you'd rather have that extra verification step.
6. Redeploy/upload the updated `config.js` to your host (or just refresh if testing locally). The app will now show a sign-in screen — create an account with any email + password, and your data starts syncing.
7. Install the app on additional devices and sign in with the same account to see the same shifts everywhere.

The anon key is safe to include in your deployed files — it can't be used to read anyone else's data because of the database lock-down (Row Level Security) set up in step 2. Treat your Supabase account password/dashboard access as the actual secret.

If you ever want to go back to local-only mode, just clear out the two values in `config.js`.

## How it works
- **Employers** — save each employer once: name, contact, and (optionally) a default hourly rate. Open an employer to manage its **Sites** — the actual work locations under that employer (name/label, address, a maps link, and an optional rate override for that specific site).
- **Shifts** — log a shift by picking an employer, then one of its sites, plus date, start time, expected hours, and an expected pay date (when you think you'll actually be paid for it). Pay is estimated live as you fill in the form (hours × rate — there's no overtime or premium/holiday multiplier, pay is always hours × rate). Once the shift's scheduled time has passed, reopen it and a "Hours worked" field appears — fill it in and pay recalculates using the real hours instead of the estimate.
- **Pay rate** — resolves in this order: a rate set directly on the shift, then the site's rate override, then the employer's default rate, then your app-wide default rate. Handy when the same employer's sites pay differently, or one specific shift pays a one-off rate.
- **Open Shifts** — add shifts you're considering picking up (from a marketplace, group chat, etc.) and each one is checked against your committed schedule:
  - **Clear (green)** — no conflicts, safe to take.
  - **Caution (amber)** — it fits, but there's less than your minimum gap (4 hrs by default) between it and another shift, or it falls on a day you've marked off. You'll get a confirm prompt before adding it.
  - **Conflict (red)** — it overlaps a shift you already have. This can't be accepted until the conflict is resolved (edit or remove the clashing shift first) — two shifts can never occupy the same time.
  - Tap **Accept** to move it into your real shift list, or **Dismiss** to drop it.
- **No overlapping shifts, ever** — whether you're adding a shift directly, editing one, or accepting an Open Shift candidate, MyShift blocks it if the time overlaps another shift already on your schedule. Once a shift is marked done and you've filled in the actual hours worked, the overlap check uses that real duration (not just the original estimate) — so a shift that ran long correctly flags a clash with whatever comes right after it.
- **Calendar** — a month view of your schedule at a glance. Each day is colored: **red** if you've marked it a day off, **green** if you have a committed shift on it, **orange** if you have an Open Shift candidate pending a decision on it, and **white** if it's free (a day off takes priority over a shift if both happen to land on the same date, so you always notice it). Tap any day to see what's on it, add a shift straight to that date, or toggle it as a day off.
- **Days Off** (in Settings, or from the Calendar) — mark dates you don't want to work. Any shift — open or already committed — landing on one of those dates gets flagged.
- **Pay rules** (in Settings): currency (defaults to €), a default hourly rate, and the minimum gap between shifts before Open Shifts warns you.
- **Dashboard** shows hours and earnings for shifts actually *worked* this week/this month, your upcoming shifts, and an at-a-glance calendar for the current month (same red/green/orange/white coloring as the Calendar tab — tap a day to see details). It's fixed to the current month; head to the Calendar tab to browse other months.
- **Shifts tab → Past** stacks your shift history month by month — each month gets its own header showing that month's total pay and shift count, with the shifts for that month listed underneath, most recent month first. Upcoming and All stay as flat chronological lists.
- **Payments tab** is where money-tracking lives. Every shift automatically carries a payment status:
  - **Scheduled** — the shift hasn't happened yet.
  - **Pending** — the shift's time has passed but you haven't marked it paid. This is money you're owed right now.
  - **Paid** — you've ticked "Payment received" on the shift (manually, once it actually lands in your account).
  The Payments tab shows: **Pending** (total owed across all pending shifts), **Expected This Month** (projected pay for every shift dated this month, regardless of status), **Credited This Month** (money actually marked paid with a pay date in this month), **Earned This Week / This Month** (pay for shifts worked in that period), and **Expected to Be Credited: This Week** (not-yet-paid shifts whose *expected pay date* falls this week, plus a list of upcoming pay dates). Below all that, filter chips (Pending / Scheduled / Paid) let you browse shifts by status — Pending and Paid are stacked month-by-month just like Shifts → Past, each with its own monthly total, so it's easy to see what you were owed or paid in any given month. Tap **Mark Paid** on any pending shift to settle it (defaults the pay date to today if none was set). You can also flip a shift to paid from its own edit screen via the "Payment received" checkbox, which appears once the shift's time has passed.
- **Backup** — Settings → Export downloads a `.json` backup of everything; Import restores from one. Handy even with cloud sync on, as a point-in-time snapshot.
- **No "erase all data" button, on purpose** — there's no in-app way to wipe everything, to rule out accidental data loss. If you ever genuinely need to start over, delete your row from the `app_data` table in Supabase's Table Editor (cloud mode) or clear this site's browser storage (local mode).

## Notes
- **Local mode** (no `config.js` keys set): all data stays only in this browser's storage. Switching phones or clearing browser data means exporting/importing a backup to move it over.
- **Cloud mode** (Supabase configured): data lives in your Supabase project and syncs automatically across every device you sign into. A local copy is still cached on-device for instant loading and basic offline use — if a save can't reach the server (no connection), it's kept locally and retried automatically once you're back online.
- Your Supabase project's free tier comfortably covers personal shift-tracking use (the data for years of shifts is a tiny fraction of the free storage/bandwidth limits).
