# GA Insights – Experience Workspace side panel

A side-panel plugin for Experience Workspace (da.live) that shows Google Analytics 4 data for the page you are editing.

## What it shows

- **Realtime**: active users on the page in the last 30 min, compared with the whole site, with a per-minute sparkline. It refreshes every 60 s.
- **KPIs vs previous period**: views, users, new users, average engagement time, engagement rate, bounce rate, scroll reach and key events. Each is shown with its change and compared with the site average.
- **Trend**: daily views for the page.
- **Rank**: the page's position among all site pages and its share of total views.
- **Author insights**: plain-language tips, e.g. "readers leave before scrolling", "mostly mobile", "no conversions".
- **Acquisition**: channels, external referrers and entrance (landing) share.
- **Audience**: devices and top countries.

Date range options are 7, 28 or 90 days.

## The GA identifier: measurement ID vs property ID

The `G-XXXXXXX` **measurement ID** from your site's Google tag **cannot be used to query data**. The GA4 Data API needs the numeric **property ID** (e.g. `123456789`).

- If you know the property ID, enter it directly. In GA it's under Admin → Property details.
- Otherwise, enter the `G-` ID and click **Find property**. This uses the Analytics Admin API to look up which property owns that web stream.

## Google Cloud setup (one-time)

1. Create or choose a Google Cloud project.
2. Enable the **Google Analytics Data API** and the **Google Analytics Admin API**.
3. Configure the **OAuth consent screen**. Choose Internal for Workspace orgs, or External with test users. Add the scope `https://www.googleapis.com/auth/analytics.readonly`.
4. Create an OAuth client ID of type **Web application**. Add these under **Authorized JavaScript origins**:
   - `http://localhost:3000` (local dev)
   - `https://main--{site}--{org}.aem.page` and `https://main--{site}--{org}.aem.live`
5. In GA4, give each author at least the **Viewer** role on the property.

No secret is needed. Each author signs in with their own Google account. Their access token is kept only in the tab's `sessionStorage`.

## Install

1. Copy `tools/ga-insights/` into your Edge Delivery site repo and push it. Include `vendor/`, which holds the Spectrum bundle. Alternatively, host it on any static origin.
2. Open `https://da.live/config#/{org}/{site}` and go to the **library** tab. Add a row:

   | title | path | experience |
   |---|---|---|
   | Google Analytics | `https://main--{site}--{org}.aem.live/tools/ga-insights/ga-insights.html` | dialog / panel as per EW docs |

   For local dev, run `aem up` (port 3000) and use `http://localhost:3000/tools/ga-insights/ga-insights.html`.
3. Open a page in EW, open the plugin, click ⚙ and fill in:
   - **GA4 property ID**, or the Google tag ID plus **Find property**
   - **OAuth client ID**
   - **Site URL** (optional). It's shown in front of the page path, e.g. `www.example.com/coffee/cold-brew`. If it's blank, the website URL is read from the GA property's web stream. If that fails, the first hostname is used.
   - **Hostnames** (optional). Count only production traffic, e.g. `www.example.com`.
   - **Path prefix** (optional). Use this if published URLs differ from DA paths.
   - **Default range**

## Design system: Spectrum 2

The UI uses [Spectrum Web Components](https://opensource.adobe.com/spectrum-web-components/) (1.12.6) with `<sp-theme system="spectrum-two">`. The components used are buttons, action buttons and groups, text fields, pickers, badges, a progress circle and S2 workflow icons. Charts and cards are styled only with S2 design tokens (`--spectrum-*`).

The components are pre-bundled into `tools/ga-insights/vendor/spectrum.js` (~145 KB gzipped). This avoids any runtime build step or CDN, and stops custom elements from being registered twice. To add a component or icon, edit `build/spectrum-entry.js` and rebuild:

```
npm install
npm run build:spectrum
```

Some older icon names have no S2 version and render as an empty circle (e.g. `sp-icon-info`, `sp-icon-alert`). Use the S2 names instead, e.g. `sp-icon-info-circle` or `sp-icon-alert-triangle`.

## Configuration persistence

Settings are saved as a DA sheet at `/{org}/{site}/tools/ga-insights/settings.json`. Everyone on the site shares them, and they are also cached in localStorage. If the author can't write to DA, they are kept only locally.

The library `path` URL can also preset values with query params:

```
?property=123456789&client=XXX.apps.googleusercontent.com&url=https://www.example.com&hosts=www.example.com&prefix=&days=28
```

You can also set `measurement=G-...`, and `config=/other/path.json` to change where settings are stored.

## Testing outside EW

Serve the folder with any static server, e.g. `python3 -m http.server 3100`. Then use:

- `…/tools/ga-insights/ga-insights.html?demo&path=/some/page`: synthetic data, no Google sign-in.
- `…/tools/ga-insights/ga-insights.html?path=/some/page`: real data using the standalone settings.

## Known limitations

- **Realtime matching**: the GA Realtime API has no page-path dimension, so realtime data is matched by **page title** (`unifiedScreenName`). Pages that share a title are combined, and realtime can't be filtered by hostname.
- **GA data delay**: historical GA data is typically 24–48 h behind.
- **Sign-in popup**: Google sign-in opens a popup. This requires the EW plugin iframe to allow popups. Some browsers' storage partitioning may also force a fresh sign-in in each tab.
- **Page changes**: if the panel doesn't follow you to another page, use ↻ or click the path to edit it.
