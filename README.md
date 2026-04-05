# HypeBot

Discord music bot with YouTube, SoundCloud, and Spotify support.

## Deployment
- **App:** music-bot-billowing-lake-2690
- **Machine:** 7817939cd799e8
- **Region:** Dallas, TX (dfw)
- **Volume:** vol_re138qy0m7w65ld4 mounted at `/data` — all data persists through redeploys

## Slash Commands
| Command | Description |
|---|---|
| `/play <name or URL>` | Search by name or paste a YouTube/SoundCloud/Spotify link |
| `/pause` | Pause or resume playback |
| `/skip` | Force skip (admins only — others use vote skip button) |
| `/stop` | Stop playback and disconnect |
| `/loop` | Toggle loop on the current song |
| `/queue` | Show the full current queue |
| `/remove <number>` | Remove a song from the queue by position |
| `/volume <0-150>` | Set playback volume (100 = normal) |
| `/fav add` | Save current song to your favorites |
| `/fav list [@user]` | View your favorites or someone else's |
| `/fav play <number>` | Play a song from favorites |
| `/fav remove <number>` | Remove a song from favorites |
| `/playlist add <name>` | Add current song to a playlist |
| `/playlist list` | List all your playlists |
| `/playlist remove <name> <number>` | Remove a song from a playlist |
| `/playlist delete <name>` | Delete an entire playlist |
| `/history` | Show last 10 songs played on this server |
| `/stats` | Top DJs and most played songs |

## Hub Buttons

**Row 1 — Playback**
| Button | Description |
|---|---|
| Pause | Pause or resume |
| Skip | Vote to skip (admins skip instantly) |
| Stop | Stop and disconnect |
| Bass Boost | Toggle bass EQ — turns blue when active |

**Row 2 — Library**
| Button | Description |
|---|---|
| Favorite | Save current song to your favorites |
| Playlists | Browse all playlists + create new ones |
| Community Radio | Shuffle and play the server radio pool |

**Row 3 — Info**
| Button | Description |
|---|---|
| View Queue | See the full queue with requesters |
| History | Last 10 songs played on this server |
| HypeBot Guide | Full command and button reference |

## Secondary Menus
- **Playlists** — playlist select menu, Create Playlist button, Server Favorites button
- **Community Radio** — Add to Radio, View Pool, Autoplay toggle

## Data Files (stored on Fly volume at `/data`)
| File | Contents |
|---|---|
| `favorites.json` | Per-user saved songs |
| `radio.json` | Community radio pool |
| `history.json` | Full play history with timestamps |
| `playlists.json` | Custom user-created playlists |

## Stack
- **Node.js** + **discord.js v14**
- **@discordjs/voice** — voice connection and audio player
- **yt-dlp** — metadata, stream URLs, and search
- **FFmpeg** — Opus encoding at 192k with optional volume/EQ filters

## Key Files
- `index.js` — all bot logic
- `deploy-commands.js` — registers slash commands (run once after changes)
- `fly.toml` — Fly.io deployment config
- `Dockerfile` — container build

## Deploy Process
1. `flyctl deploy` — build and push to Fly.io
2. `node deploy-commands.js` — register slash commands globally (only needed after command changes)

## Patch Notes

### Patch 5 — Persistent storage, playlists, UI cleanup (2026-04-05)
- **Fly volume** — all data files moved to `/data`, survives redeploys
- **Custom playlists** — create via Playlists button modal, manage via `/playlist` commands
- **Playlists hub button** — shows all favorites playlists + custom playlists, Play/Shuffle per playlist
- **Homepage redesigned** — 3 clean rows, niche buttons moved to secondary menus
- **Community Radio secondary** — Add to Radio, View Pool, Autoplay moved off homepage
- **Admin skip** — users with Administrator permission bypass vote skip instantly
- **playNext() helper** — recursive queue chaining fixes songs getting skipped when radio + user queue mix
- **FFmpeg stream fix** — `-reconnect_on_http_error` and `-timeout` flags fix SoundCloud stream hangs
- **HypeBot Guide** — help embed rewritten to match current layout
- **Bug fix** — playlist name delimiter changed to `||` to support any characters in playlist names

### Patch 4 — Spotify support (2026-04-01)
- Spotify track/album/playlist URLs supported in `/play`
- Resolves Spotify metadata then searches YouTube for each track
- Playlist/album cap: 100 songs
- Blocked on: needs `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` set as Fly secrets

### Patch 3 — SoundCloud reliability (2026-04-02)
- Format selector changed from `bestaudio` to `bestaudio/best`
- Retry logic added to `getSongInfo` — retries up to 2x with 1s delay
- Loop fix — SoundCloud songs on loop clear cached CDN URL each iteration

### Patch 2 — Search menu (2026-04-01)
- `/play` with a song name shows top 5 YouTube results as a select menu
- Command option renamed from `url` to `song`
- URLs still play immediately with no menu

### Patch 1 — Initial deployment
- Bot moved from local machine to Fly.io for 24/7 hosting
- Oracle Cloud free tier blocked (card already used), Fly.io chosen as alternative

## Backlog / Ideas
- Progress bar on the hub
- Move songs in queue (`/move 3 1`)
- DJ role — lock controls to a specific role
- Spotify credentials setup
- Per-genre radio playlists with tags
- Radio pool voting (upvote/downvote to weight shuffle)
