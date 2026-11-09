# degoog Prowlarr plugin

Search every indexer in [Prowlarr](https://prowlarr.com) from [degoog](https://github.com/fccview/degoog). Results are sorted by seeders, and each one shows which indexer it came from and whether that tracker is **Public**, **Semi-Private** or **Private**, using the same colours as Prowlarr.

Only people signed into the degoog **settings** (with `DEGOOG_SETTINGS_PASSWORDS` or your settings-gate plugin) can use it. Everyone else sees a lock card, and the plugin's API routes answer `401`.

## Usage

```
!prowlarr ubuntu 24.04
!torrent some movie 2160p
!torrents some show s01
ubuntu !prowl
```

With streaming on (the default), each indexer is searched separately and in parallel. Results appear as soon as each indexer answers, and the header counts how many have answered so far. New results slot in sorted until you start reading (scrolling, filtering or clicking). After that, they wait behind a **"N new results, show sorted"** button so the list doesn't jump. Indexers that fail or time out are listed under the toolbar; hover a name to see its error.

### Torrents tab

When you're signed into the degoog settings, a **Torrents** tab appears at the end of the tab bar (Web, Images, News, …, Torrents). It runs `!prowlarr` for the current query. While Prowlarr results are on screen, the tab bar stays visible, and clicking Web/Images/etc. goes back to your plain query. Visitors who aren't signed in never get the tab.

degoog's built-in plugin tabs are public, and their search code can't tell who is asking. That's why this tab is added by the plugin's own script, and only after the server confirms your settings session. It depends on degoog's tab bar markup (`#results-tabs` / `#tools-bar`). If a degoog update changes that, the tab disappears; it doesn't leak anything.

### Results

On the results card you can:

- filter titles, pick a privacy level (All / Public / Semi-Private / Private), an indexer, or a protocol
- re-sort by seeders (the default), leechers, size, age, grabs or title, and hide dead torrents. Your sort choice and the "Hide dead" setting are remembered in this browser.
- click the title to open the tracker's details page.

Each result has two download options:

- **Send to qBittorrent** (named after your client): Prowlarr grabs the release and sends it to its own download client. That's the indexer's client if it has one, otherwise your highest-priority client for the protocol. Prowlarr also passes the indexer's seed ratio and seed time to the client.
- **Download .torrent / Open magnet / Download .nzb**: gets it onto the device you're browsing from. Which one you get is set by the "Download button on torrents" setting. By default it follows each indexer's **Prefer Magnet URL** setting in Prowlarr.

### Seed requirements

If an indexer has a **Seed Ratio**, **Seed Time** or **Pack Seed Time** set in Prowlarr (Indexers → edit → advanced), its results show a badge such as **Seed 3 d or ratio 1.0 (packs 5 d)**. After either download option, a reminder pops up with the same rule. Private trackers with no seed rules in Prowlarr get a **Seed rules not set** warning, because those trackers usually enforce hit-and-runs.

Results stay cached for 25 minutes, so paging and filtering don't run a new search. The refresh button forces a fresh one.

## Install

### Option A: copy the folder

Copy `plugins/prowlarr` into degoog's plugins directory (`data/plugins/`, or wherever `DEGOOG_PLUGINS_DIR` points), then restart degoog:

```
data/plugins/prowlarr/
  index.js
  template.html
  script.js
  style.css
  author.json
```

### Option B: add this repo to the degoog store

This repo is laid out as a degoog store repo (see `package.json`). Push it to a git host degoog can reach, then add its URL under **Settings → Store**, and install **Prowlarr** from there.

## Configure

Go to **Settings → Plugins → Prowlarr → Configure**:

| Setting | Notes |
| --- | --- |
| Prowlarr URL | e.g. `https://prowlarr.kevenyazz.nl`. This is the address the degoog **server** uses, so an internal Docker address such as `http://prowlarr:9696` also works and is faster. |
| API key | Prowlarr → Settings → General → Security. It's stored as a secret and never sent to the browser. |
| Categories | Optional Newznab IDs, e.g. `2000,5000`. Leave empty to search everything. |
| Indexer IDs | Optional. Leave empty to search every enabled indexer. |
| Stream results | On by default. On: one Prowlarr request per indexer, results appear as each answers. Off: one combined request, everything appears when the slowest indexer finishes. Your reverse proxy must not buffer responses for streaming to show up live (the plugin sends `X-Accel-Buffering: no` for nginx). |
| "Download" button on torrents | `auto` (default) follows each indexer's Prefer Magnet URL setting in Prowlarr. `magnet` opens the magnet when there is one. `file` saves the .torrent when there is one. |
| Results per indexer | Default 100. |
| Search timeout | Default 60s, max 110s. If a reverse proxy sits in front of degoog, its read timeout must be at least this long. |

## How the access check works

degoog doesn't pass the request to bang commands, so the gate lives in the plugin's HTTP routes:

1. `!prowlarr …` only renders an empty card containing the query.
2. `script.js` calls `/api/plugin/<id>/search` and sends the user's settings session: the HttpOnly `settings-token` cookie plus the `degoog-settings-token` from sessionStorage.
3. Each route forwards that session to degoog's own `GET /api/settings/auth` over loopback (`127.0.0.1:$DEGOOG_PORT`, falling back to the public origin) and only continues when the reply is `valid: true`. Cross-site requests are refused outright.

Prowlarr's download and magnet links include your API key. So the plugin never sends them to the browser. Downloads, magnets and grabs go through the plugin's routes using an opaque result ID, and the server follows those links.

> If degoog runs with `DEGOOG_DANGEROUSLY_NO_PASSWORD=true`, degoog itself treats every visitor as signed in. In that case so does this plugin.

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/session` | `200` when the visitor is signed into settings (used to show the Torrents tab) |
| GET | `/search?q=…[&fresh=1]` | Run (or reuse) a search, sorted by seeders |
| GET | `/stream?q=…[&fresh=1]` | Same search as server-sent events: `start`, then one `results` / `indexer-error` per indexer, then `done` |
| POST | `/magnet` `{ id }` | Resolve a magnet link |
| GET | `/download?id=…` | Proxy the `.torrent` / `.nzb` file |
| POST | `/grab` `{ id }` | Send to Prowlarr's download client |

All routes are admin-only. `/search` and `/stream` use degoog's rate limiter. Both modes share the same 25-minute cache.
