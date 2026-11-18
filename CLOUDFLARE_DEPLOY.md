# Deploy Loop from GitHub to Cloudflare Pages (free static hosting)

This keeps your source code in GitHub but serves the public website from Cloudflare Pages. It avoids relying on GitHub Pages for a site with account-password flows.

1. Push the `loop_github_supabase` folder contents to a GitHub repository (for example `loop`).
2. Create a Cloudflare account at <https://dash.cloudflare.com/>.
3. Open **Workers & Pages → Create → Pages → Connect to Git**.
4. Connect GitHub and select your repository.
5. Configure:
   - Production branch: `main`
   - Framework preset: `None`
   - Build command: leave empty
   - Build output directory: `.`
6. Click **Save and Deploy**.
7. Copy the `https://....pages.dev` URL from the deployment.
8. In Supabase → **Authentication → URL Configuration**, set Site URL to that URL and add it to Redirect URLs.

When you push changes to `main`, Cloudflare Pages redeploys from GitHub automatically. The Loop app uses Supabase directly from the browser, so no Cloudflare Worker or server-side build is required.

Cloudflare Pages Free currently permits 500 builds/month, up to 20,000 files per site and a maximum static asset size of 25 MiB. Cloudflare advertises its free start as requiring no credit card; confirm the current signup requirements yourself.
