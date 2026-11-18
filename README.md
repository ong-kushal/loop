# Loop — GitHub Pages + Supabase

A static, mobile-first social web app built with **HTML, CSS and vanilla JavaScript**. GitHub Pages serves the frontend; Supabase provides authentication, Postgres, storage and realtime messaging. No Python server, Node build step or paid hosting is required for this starter deployment.

## Included features

- Email/password registration and login through Supabase Auth
- Minimal profiles with avatar, display name, bio and manually entered city/region
- Photo and short-video posts (photos up to 10 MB; videos up to 50 MB and 60 seconds)
- Compact media feed, custom video player and individual post pages
- For You ranking using city/region, tags, bookmarks, comments, viewing activity and recency
- Bookmarks; no likes or dislikes
- Comments limited to 100 words, with a basic client-side blocklist and a database trigger blocklist
- Delete your own posts; storage ownership is enforced by RLS policies
- Photo view after 3 seconds on an individual post page
- Video view after 6 seconds of actual playback, or the full video if shorter than 6 seconds
- One counted view per signed-in account per post; creators' own views are not counted
- Notifications for comments, bookmarks and direct messages
- Inbox and private one-to-one conversations with realtime incoming message updates
- Supabase Row Level Security policies for profiles, posts, comments, bookmarks, views, notifications, messages and storage

## 1. Create a Supabase project

1. Open <https://supabase.com/> and create a Free project.
2. Open **SQL Editor → New query**.
3. Open `supabase/schema.sql` from this repository, copy the entire file into the SQL Editor and run it.
4. In **Project Settings → API**, copy the Project URL and the **publishable key**. The legacy `anon` key is also accepted by the client.
5. Open `js/config.js` and replace the two placeholder values:

```js
window.LOOP_CONFIG = {
  SUPABASE_URL: "https://YOUR_PROJECT_REF.supabase.co",
  SUPABASE_PUBLIC_KEY: "YOUR_PUBLISHABLE_OR_ANON_KEY"
};
```

Only use the publishable/anon key in browser code. **Never use the `service_role` key or any secret key in this repository.** RLS is the security boundary for browser requests.

## 2. Configure Supabase Auth URLs

In **Authentication → URL Configuration**:

- Set **Site URL** to your GitHub Pages URL, for example `https://YOUR_GITHUB_NAME.github.io/loop/`.
- Add that exact URL to **Redirect URLs**.
- If you also test locally, add `http://127.0.0.1:5500/**` and/or your local static server URL to Redirect URLs.

Email confirmation may be enabled by default. With confirmation enabled, users receive a confirmation email before their first sign-in. The signup screen tells them to check their email.

## 3. Publish to GitHub Pages

1. Create a GitHub repository named `loop` (public repositories can use GitHub Pages on GitHub Free).
2. Upload/commit the **contents of this folder** to the repository root. Keep `.github/workflows/pages.yml` included.
3. Push the default branch named `main`.
4. In GitHub, open **Settings → Pages** and choose **GitHub Actions** as the build/deployment source.
5. Open the **Actions** tab and wait for “Deploy Loop to GitHub Pages” to finish.
6. Your site will be available at `https://YOUR_GITHUB_NAME.github.io/loop/`.

The included GitHub Actions workflow publishes the repository root as a static site. It does not run a backend.

## 4. Local testing (optional)

You do not need Python or a virtual environment. In VS Code, use the Live Server extension, or run another static file server. Example if Node.js is already installed:

```powershell
npx serve .
```

Then add the local URL (for example `http://localhost:3000/**`) under Supabase **Authentication → URL Configuration → Redirect URLs**.

## Security and behavior notes

- Row Level Security is enabled on all app tables. Users can only edit their own profile, delete their own posts, see their own bookmarks/notifications, and read conversations where they are a sender or recipient.
- Private message text is never publicly readable. Realtime notifications are scoped by recipient ID and still subject to RLS.
- The `loop-posts` and `loop-avatars` buckets are public-read so public posts and profile images can load without signed-in sessions. Upload/update/delete operations require the object path to start with the authenticated user's UUID.
- The publishable/anon key is intentionally visible in browser JavaScript. Never expose a `service_role` or secret key.
- Location is user-entered city/region. This app does not request precise GPS.
- The comment blocklist is a small editable starter list, not a complete safety/moderation system. Review and extend the pattern in `moderate_loop_comment()` in `supabase/schema.sql` and the matching blocklist in `js/app.js`.
- View counts only track signed-in accounts and are de-duplicated by a `(post_id, viewer_id)` primary key. Photo views are recorded after 3 seconds on the detail page. Video views use accumulated forward playback deltas and do not count seeking.
- The client uses Supabase's browser SDK from jsDelivr, and DM/notification live updates use Supabase Realtime. If a CDN or Realtime connection is unavailable, core page loads and manual refresh still work.

## Free-tier constraints

Supabase's Free plan currently includes 500 MB database size, 1 GB file storage and 10 GB combined bandwidth (5 GB cached + 5 GB uncached). Free projects may pause after a week of low activity. GitHub Pages has a published site size limit of 1 GB and a soft bandwidth limit of 100 GB/month. These limits can change; check provider pricing and docs before inviting a large audience.

This is suitable for a small beta, not an unlimited video platform. Compress media and monitor storage/egress.

## Project files

```text
index.html
css/style.css
js/config.js       # paste Supabase URL and public key here
js/app.js          # application routes, UI and interactions
assets/favicon.svg
supabase/schema.sql # database, triggers, RLS and storage policies
.github/workflows/pages.yml
```

## Recommended public hosting: Cloudflare Pages connected to GitHub

**For Loop's real login/messaging use case, prefer Cloudflare Pages as the static host and keep GitHub as the source-code repository.** GitHub Pages is a static host, but GitHub's current usage limits say Pages should not be used for sensitive transactions such as sending passwords, and restrict sites primarily providing commercial SaaS. Loop includes password sign-in and private messages, so check those terms before choosing GitHub Pages for a public deployment.

Cloudflare Pages can deploy directly from a GitHub repository. The static frontend files in this repo are small and fit its Free plan asset limits.

1. Create a free Cloudflare account at <https://dash.cloudflare.com/>.
2. Open **Workers & Pages → Create → Pages → Connect to Git**.
3. Authorize GitHub and select the `loop` repository.
4. Set the production branch to `main`.
5. Choose **None** as the framework preset.
6. Leave the build command empty and set the build output directory to `.` (the repository root).
7. Click **Save and Deploy**.
8. In Supabase **Authentication → URL Configuration**, set Site URL and Redirect URL to the Cloudflare `*.pages.dev` address.

After that, commits pushed to GitHub automatically deploy to Cloudflare Pages. Cloudflare's static Pages assets are served globally and its free plan currently allows up to 500 builds/month, 20,000 files/site and 25 MiB per static asset. Cloudflare advertises its free start without a credit card; check the current signup flow and plan limits before use.

If you choose GitHub Pages for a noncommercial prototype, the included `.github/workflows/pages.yml` publishes the static site. In the repository choose **Settings → Pages → GitHub Actions**.
