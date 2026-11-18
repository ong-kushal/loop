# Loop

A minimal, mobile-friendly social app built with **HTML, CSS and vanilla JavaScript**. Supabase provides authentication, the database, file storage and realtime messaging.

## Visit Loop

**Live website:** [Open Loop](https://YOUR-GITHUB-USERNAME.github.io/loop/)

> Replace `YOUR-GITHUB-USERNAME` with the GitHub account that owns the repository. If your repository name is not `loop`, update that part of the URL too.

## Features

- Email and password sign-up and sign-in
- Minimal user profiles with avatar, display name, bio and city/region
- Photo and short-video posts
- Personalized **For You** feed using location, content interests and activity
- Individual post pages and a custom video player
- Bookmarks; no likes or dislikes
- Comments limited to 100 words, with basic word filtering
- Delete your own posts
- View counts: photo views after 3 seconds on a post page; video views after 6 seconds of playback (or after the full clip if it is shorter)
- One view per signed-in viewer per post; creators' own views are excluded
- Notifications for post interactions such as comments and bookmarks
- Private one-to-one direct messages and an inbox with unread indicators

## How Loop is hosted

- **GitHub Pages** serves the static website.
- **Supabase** handles sign-in, PostgreSQL data, uploaded media and realtime updates.
- There is no Python server or build step.

## Setup

### 1. Create a Supabase project

1. Create a project at [supabase.com](https://supabase.com/).
2. In Supabase, open **SQL Editor → New query**.
3. Copy the contents of [`supabase/schema.sql`](supabase/schema.sql) into the editor and run it.
4. Run [`supabase/disable-message-notifications.sql`](supabase/disable-message-notifications.sql) once if you want incoming DMs to appear only in the Inbox, not in the Notifications page.

### 2. Add your Supabase credentials

In **Supabase → Project Settings → API**, copy the Project URL and the publishable key (or legacy `anon` key).

Open [`js/config.js`](js/config.js) and replace the placeholders:

```js
window.LOOP_CONFIG = {
  SUPABASE_URL: "https://YOUR_PROJECT_REF.supabase.co",
  SUPABASE_PUBLIC_KEY: "YOUR_PUBLISHABLE_OR_ANON_KEY"
};
```

Use only the browser-safe publishable/anon key here. **Never put your `service_role` key or another secret key in this repository.**

### 3. Configure Supabase sign-in URLs

In **Supabase → Authentication → URL Configuration**:

- Set **Site URL** to your live Loop URL.
- Add your live Loop URL to **Redirect URLs**.
- Add your local development URL there too if you test locally.

For the default repository name `loop`, the GitHub Pages URL is usually:

```text
https://YOUR-GITHUB-USERNAME.github.io/loop/
```

### 4. Deploy with GitHub Pages

1. Put the contents of this project in the root of your GitHub repository. `index.html` and the `.github` folder should be at the repository root.
2. Push the files to the `main` branch.
3. In GitHub, open **Settings → Pages** and select **GitHub Actions** as the deployment source.
4. Open **Actions** and confirm that **Deploy Loop to GitHub Pages** completes successfully.
5. Visit the live URL shown in the Pages settings or deployment workflow.

The workflow in [`.github/workflows/pages.yml`](.github/workflows/pages.yml) publishes the repository root. It does not run a backend.

## Run locally

No Python, Node build process or virtual environment is required. Open the folder with VS Code and use the Live Server extension, or use any static file server. For example, if Node.js is already installed:

```powershell
npx serve .
```

Add the local address shown by the server to Supabase **Authentication → URL Configuration → Redirect URLs**.

## Project layout

```text
index.html
assets/                  # favicon and static assets
css/                     # stylesheets
js/
  config.js              # Supabase URL and public key
  app.js                 # application UI and interactions
supabase/
  schema.sql              # database, triggers, RLS and storage policies
  disable-message-notifications.sql
.github/workflows/
  pages.yml               # GitHub Pages deployment workflow
```

## Security notes

- Row Level Security (RLS) protects user data and private conversations. Keep the policies in `supabase/schema.sql` enabled.
- The browser publishable/anon key is expected to be public; the `service_role` key is not.
- Public post media and avatars can be viewed without signing in. Upload, update and delete operations are restricted by the storage policies.
- Location is entered by the user as a city/region. Loop does not request precise GPS location.
- The comment word filter is a basic starter moderation layer, not a complete content-safety system.

## Free-tier limits

Loop can be run on GitHub Pages and Supabase free plans, subject to each provider's current limits. Supabase free projects have finite database, file-storage and bandwidth allowances and may pause after a period of inactivity. This setup is suitable for a small beta, not an unlimited public video service. Compress uploads and monitor your Supabase usage.

Check the providers' current terms and limits before opening the app to a larger audience. GitHub Pages is static hosting and is not a replacement for a dedicated application backend.
