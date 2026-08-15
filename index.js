const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
} = require('@discordjs/voice');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// --- Persistent data directory ---
const DATA_DIR = process.env.DATA_DIR || '/data';

// --- Favorites storage ---
const FAVORITES_FILE = path.join(DATA_DIR, 'favorites.json');

function loadFavorites() {
  if (!fs.existsSync(FAVORITES_FILE)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(FAVORITES_FILE, 'utf8'));
    for (const [key, val] of Object.entries(data)) {
      if (Array.isArray(val)) data[key] = { username: 'Unknown', songs: val };
    }
    return data;
  } catch { return {}; }
}

function saveFavorites(data) {
  fs.writeFileSync(FAVORITES_FILE, JSON.stringify(data, null, 2));
}

function getUserFavorites(userId) {
  return loadFavorites()[userId]?.songs || [];
}

function setUserFavorites(userId, username, list) {
  const data = loadFavorites();
  data[userId] = { username, songs: list };
  saveFavorites(data);
}

// --- Community Radio storage ---
const RADIO_FILE = path.join(DATA_DIR, 'radio.json');

function loadRadio() {
  if (!fs.existsSync(RADIO_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(RADIO_FILE, 'utf8')); } catch { return []; }
}

function saveRadio(data) {
  fs.writeFileSync(RADIO_FILE, JSON.stringify(data, null, 2));
}

// --- History storage ---
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return []; }
}

function saveHistory(data) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2));
}

// --- Playlists storage ---
// Structure: { userId: { username, playlists: { name: { name, songs: [], createdAt, collaborators: [] } } } }
const PLAYLISTS_FILE = path.join(DATA_DIR, 'playlists.json');

function loadPlaylists() {
  if (!fs.existsSync(PLAYLISTS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(PLAYLISTS_FILE, 'utf8')); } catch { return {}; }
}

function savePlaylists(data) {
  fs.writeFileSync(PLAYLISTS_FILE, JSON.stringify(data, null, 2));
}

function getUserPlaylists(userId) {
  return loadPlaylists()[userId]?.playlists || {};
}

function createPlaylist(userId, username, name) {
  const data = loadPlaylists();
  if (!data[userId]) data[userId] = { username, playlists: {} };
  data[userId].username = username;
  if (data[userId].playlists[name]) return false; // already exists
  data[userId].playlists[name] = { name, songs: [], createdAt: new Date().toISOString(), collaborators: [] };
  savePlaylists(data);
  return true;
}

function deletePlaylist(userId, name) {
  const data = loadPlaylists();
  if (!data[userId]?.playlists?.[name]) return false;
  delete data[userId].playlists[name];
  savePlaylists(data);
  return true;
}

function addToPlaylist(callerId, ownerId, playlistName, song) {
  const data = loadPlaylists();
  if (!data[ownerId]?.playlists?.[playlistName]) return false;
  const pl = data[ownerId].playlists[playlistName];
  if (callerId !== ownerId && !(pl.collaborators || []).includes(callerId)) return false;
  if (pl.songs.some(s => s.url === song.url)) return false;
  pl.songs.push({ title: song.title, uploader: song.uploader, url: song.url, duration: song.duration, thumbnail: song.thumbnail });
  savePlaylists(data);
  return true;
}

function getEditablePlaylists(userId) {
  const data = loadPlaylists();
  const results = [];
  for (const [name, pl] of Object.entries(data[userId]?.playlists || {})) {
    results.push({ ownerId: userId, ownerUsername: data[userId].username, name, songs: pl.songs, isOwn: true });
  }
  for (const [ownerId, userData] of Object.entries(data)) {
    if (ownerId === userId) continue;
    for (const [name, pl] of Object.entries(userData.playlists || {})) {
      if ((pl.collaborators || []).includes(userId)) {
        results.push({ ownerId, ownerUsername: userData.username, name, songs: pl.songs, isOwn: false });
      }
    }
  }
  return results;
}

function findEditablePlaylist(callerId, name) {
  const data = loadPlaylists();
  if (data[callerId]?.playlists?.[name]) return { ownerId: callerId, pl: data[callerId].playlists[name] };
  const matches = [];
  for (const [ownerId, userData] of Object.entries(data)) {
    if (ownerId === callerId) continue;
    const pl = userData.playlists?.[name];
    if (pl && (pl.collaborators || []).includes(callerId)) matches.push({ ownerId, pl });
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return 'ambiguous';
  return null;
}

function logHistory(song, guildId) {
  const history = loadHistory();
  history.push({
    title: song.title,
    uploader: song.uploader,
    url: song.url,
    requestedBy: song.requestedBy || 'Unknown',
    guildId,
    timestamp: new Date().toISOString(),
  });
  saveHistory(history);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function isUrl(s) {
  return s.startsWith('http://') || s.startsWith('https://');
}

function isSpotifyUrl(s) {
  return /^https?:\/\/open\.spotify\.com\/(track|album|playlist)\//.test(s);
}

// Spotify token cache (client credentials — no user login needed)
let _spotifyToken = null;
let _spotifyTokenExpiry = 0;

async function getSpotifyToken() {
  if (_spotifyToken && Date.now() < _spotifyTokenExpiry) return _spotifyToken;
  const creds = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Spotify auth failed — check SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env');
  _spotifyToken = data.access_token;
  _spotifyTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return _spotifyToken;
}

// Returns array of { title, uploader } from a Spotify track/album/playlist URL
async function resolveSpotifyUrl(url) {
  const token = await getSpotifyToken();
  const match = url.match(/open\.spotify\.com\/(track|album|playlist)\/([A-Za-z0-9]+)/);
  if (!match) throw new Error('Invalid Spotify URL');
  const [, type, id] = match;
  const headers = { 'Authorization': `Bearer ${token}` };
  const PLAYLIST_CAP = 100;

  if (type === 'track') {
    const res = await fetch(`https://api.spotify.com/v1/tracks/${id}`, { headers });
    const data = await res.json();
    return [{ title: data.name, uploader: data.artists.map(a => a.name).join(', ') }];
  }

  if (type === 'album') {
    const tracks = [];
    let next = `https://api.spotify.com/v1/albums/${id}/tracks?limit=50`;
    while (next && tracks.length < PLAYLIST_CAP) {
      const res = await fetch(next, { headers });
      const data = await res.json();
      for (const track of data.items) {
        if (tracks.length >= PLAYLIST_CAP) break;
        tracks.push({ title: track.name, uploader: track.artists.map(a => a.name).join(', ') });
      }
      next = data.next;
    }
    return tracks;
  }

  if (type === 'playlist') {
    const tracks = [];
    let next = `https://api.spotify.com/v1/playlists/${id}/tracks?limit=100&fields=next,items(track(name,artists))`;
    while (next && tracks.length < PLAYLIST_CAP) {
      const res = await fetch(next, { headers });
      const data = await res.json();
      for (const item of data.items) {
        if (tracks.length >= PLAYLIST_CAP) break;
        if (item.track?.name) tracks.push({ title: item.track.name, uploader: item.track.artists.map(a => a.name).join(', ') });
      }
      next = data.next;
    }
    return tracks;
  }

  throw new Error('Unsupported Spotify URL type');
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

// One queue per server
const queues = new Map();

// Vote skip tracking: guildId -> Set of userIds
const skipVotes = new Map();

function isPrivileged(member) {
  return true;
}

// Weighted shuffle — higher net vote songs appear more often
function weightedShuffle(pool) {
  const items = pool.map(s => ({
    song: s,
    weight: Math.max(1, 1 + (s.upvotes?.length || 0) - (s.downvotes?.length || 0)),
  }));
  const result = [];
  const remaining = [...items];
  while (remaining.length > 0) {
    const total = remaining.reduce((sum, x) => sum + x.weight, 0);
    let r = Math.random() * total;
    let picked = remaining.length - 1;
    for (let i = 0; i < remaining.length; i++) {
      r -= remaining[i].weight;
      if (r <= 0) { picked = i; break; }
    }
    result.push(remaining[picked].song);
    remaining.splice(picked, 1);
  }
  return result;
}

function getQueue(guildId) {
  if (!queues.has(guildId)) {
    queues.set(guildId, {
      songs: [],
      radioSongs: [],
      player: null,
      connection: null,
      loop: false,
      currentSong: null,
      textChannel: null,
      hubMessage: null,
      voiceChannelId: null,
      guild: null,
      volume: 100,
      bassBoost: false,
      autoplay: false,
      advancing: false,
      startedAt: null,
    });
  }
  return queues.get(guildId);
}

function formatDuration(seconds) {
  if (!seconds) return 'Unknown';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}m ${s}s`;
}

function buildProgressBar(startedAt, duration, width = 16) {
  if (!startedAt || !duration) return '';
  const elapsed = Math.min((Date.now() - startedAt) / 1000, duration);
  const pct = elapsed / duration;
  const filled = Math.round(pct * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  return `\`${bar}\` ${formatDuration(Math.floor(elapsed))} / ${formatDuration(duration)}`;
}

function buildNowPlayingEmbed(song, queue) {
  const progressBar = buildProgressBar(queue.startedAt, song.duration);
  const desc = `**${song.uploader}** - **[${song.title}](${song.url})**` + (progressBar ? `\n${progressBar}` : '');
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Now Playing')
    .setDescription(desc)
    .addFields(
      { name: 'Channel', value: queue.voiceChannelId ? `<#${queue.voiceChannelId}>` : '\u2014', inline: true },
      { name: 'Queue', value: `${queue.songs.length + queue.radioSongs.length} song(s) in queue${queue.radioSongs.length > 0 ? ` (${queue.radioSongs.length} radio)` : ''}`, inline: true },
      { name: 'Loop', value: queue.loop ? 'ON' : 'OFF', inline: true },
      { name: 'Requested by', value: song.requestedBy || 'Unknown', inline: true },
      { name: 'Volume', value: `${queue.volume}%`, inline: true },
      { name: 'Bass Boost', value: queue.bassBoost ? 'ON' : 'OFF', inline: true }
    )
    .setThumbnail(song.thumbnail || null);
}

function buildIdleEmbed() {
  return new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle('Nothing Playing')
    .setDescription('Use `/play` to add a song by name or URL, or browse Server Favorites below.');
}

function buildControls(queue) {
  const playing = !!(queue && queue.currentSong);
  const bassBoost = !!(queue && queue.bassBoost);

  // Row 1 — Playback
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('pause').setLabel('Pause').setStyle(ButtonStyle.Secondary).setDisabled(!playing),
    new ButtonBuilder().setCustomId('skip').setLabel('Skip').setStyle(ButtonStyle.Secondary).setDisabled(!playing),
    new ButtonBuilder().setCustomId('stop').setLabel('Stop').setStyle(ButtonStyle.Danger).setDisabled(!playing),
    new ButtonBuilder().setCustomId('bass_boost').setLabel('Bass Boost').setStyle(bassBoost ? ButtonStyle.Primary : ButtonStyle.Secondary)
  );
  // Row 2 — Library
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('favorite').setLabel('Favorite').setStyle(ButtonStyle.Primary).setDisabled(!playing),
    new ButtonBuilder().setCustomId('add_to_playlist_hub').setLabel('Add to Playlist').setStyle(ButtonStyle.Success).setDisabled(!playing),
    new ButtonBuilder().setCustomId('add_to_radio').setLabel('Add to Radio').setStyle(ButtonStyle.Secondary).setDisabled(!playing),
    new ButtonBuilder().setCustomId('playlists').setLabel('Playlists').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('community_radio').setLabel('Community Radio').setStyle(ButtonStyle.Primary)
  );
  // Row 3 — Info
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('view_queue').setLabel('View Queue').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('clear_queue').setLabel('Clear Queue').setStyle(ButtonStyle.Danger).setDisabled(!playing),
    new ButtonBuilder().setCustomId('history').setLabel('History').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('help').setLabel('HypeBot Guide').setStyle(ButtonStyle.Secondary)
  );
  return [row1, row2, row3];
}

// Always delete old hub and send fresh so it stays pinned at the bottom
async function updateHub(guild) {
  const queue = getQueue(guild.id);
  if (!queue.textChannel) return;

  const isPlaying = !!queue.currentSong;
  const embed = isPlaying ? buildNowPlayingEmbed(queue.currentSong, queue) : buildIdleEmbed();
  const payload = { embeds: [embed], components: buildControls(queue), content: null };

  if (queue.hubMessage) {
    try { await queue.hubMessage.delete(); } catch {}
    queue.hubMessage = null;
  }
  queue.hubMessage = await queue.textChannel.send(payload);
}

// Edit the hub in place — used by progress bar timer to avoid constant delete/resend
async function editHub(guild) {
  const queue = getQueue(guild.id);
  if (!queue.textChannel || !queue.hubMessage) return;
  const isPlaying = !!queue.currentSong;
  const embed = isPlaying ? buildNowPlayingEmbed(queue.currentSong, queue) : buildIdleEmbed();
  try {
    await queue.hubMessage.edit({ embeds: [embed], components: buildControls(queue), content: null });
  } catch {
    await updateHub(guild);
  }
}

function getPlaylistEntries(url) {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', ['--flat-playlist', '--dump-json', url]);
    let data = '';
    let stderr = '';
    proc.stdout.on('data', chunk => (data += chunk));
    proc.stderr.on('data', chunk => (stderr += chunk));
    proc.on('close', code => {
      if (code !== 0) {
        console.error(`yt-dlp failed (code ${code}) for ${url}:`, stderr.trim().slice(-500));
        return reject(new Error('Could not fetch info'));
      }
      try {
        const entries = data.trim().split('\n').filter(Boolean).map(line => {
          const info = JSON.parse(line);
          return {
            title: info.title || 'Unknown Title',
            uploader: info.uploader || info.channel || info.artist || 'Unknown Artist',
            duration: info.duration,
            thumbnail: info.thumbnail,
            url: info.webpage_url || info.url,
            streamUrl: null,
          };
        });
        resolve(entries);
      } catch (e) { reject(e); }
    });
  });
}

function getSongInfo(url, attempt = 0) {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', ['--dump-json', '--no-playlist', '-f', 'bestaudio/best', url]);
    let data = '';
    let stderr = '';
    proc.stdout.on('data', chunk => (data += chunk));
    proc.stderr.on('data', chunk => (stderr += chunk));
    proc.on('close', code => {
      if (code !== 0) {
        console.error(`yt-dlp failed (code ${code}, attempt ${attempt}) for ${url}:`, stderr.trim().slice(-500));
        if (attempt < 2) {
          setTimeout(() => getSongInfo(url, attempt + 1).then(resolve).catch(reject), 1000);
        } else {
          reject(new Error('Could not fetch song info'));
        }
        return;
      }
      try {
        const info = JSON.parse(data);
        resolve({
          title: info.title || 'Unknown Title',
          uploader: info.uploader || info.channel || 'Unknown Artist',
          duration: info.duration,
          thumbnail: info.thumbnail,
          url,
          streamUrl: info.url,
          streamHeaders: info.http_headers || null,
        });
      } catch (e) { reject(e); }
    });
  });
}

function extractFailureReason(stderr) {
  const lines = stderr.split('\n').map(l => l.trim().replace(/^https?:\/\/\S+?:\s*/, '')).filter(Boolean);
  const errorKeywords = /error|forbidden|403|404|denied|refused|timed out|invalid data|reset by peer|no route|unable to|failed|aborting/i;
  const matches = lines.filter(l => errorKeywords.test(l));
  if (matches.length > 0) return matches[matches.length - 1];
  const nonUrlLines = lines.filter(l => !/^https?:\/\//.test(l));
  return nonUrlLines[nonUrlLines.length - 1] || null;
}

function buildAudioFilter(volume, bassBoost) {
  const vol = (volume / 100).toFixed(2);
  if (bassBoost) {
    return `volume=${vol},bass=g=5:f=110:w=0.5`;
  }
  return `volume=${vol}`;
}

function createStream(streamUrl, volume, bassBoost, streamHeaders) {
  const filter = buildAudioFilter(volume != null ? volume : 100, bassBoost || false);
  const args = [
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-reconnect_on_http_error', '4xx,5xx',
    '-timeout', '15000000',
    '-probesize', '32', '-analyzeduration', '0',
  ];
  if (streamHeaders) {
    const headerLines = Object.entries(streamHeaders).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n';
    args.push('-headers', headerLines);
  }
  args.push(
    '-i', streamUrl,
    '-filter:a', filter,
    '-c:a', 'libopus', '-b:a', '192k', '-vbr', 'on', '-f', 'ogg', 'pipe:1'
  );
  const ffmpeg = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  ffmpeg.stderr.on('data', chunk => {
    stderr += chunk;
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });
  const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.OggOpus });
  return { resource, ffmpeg, getStderr: () => stderr };
}

async function playSong(guild, song) {
  const queue = getQueue(guild.id);
  if (!song.streamUrl) {
    const info = await getSongInfo(song.url);
    Object.assign(song, info);
  }
  queue.currentSong = song;
  queue.startedAt = Date.now();
  // Clear skip votes for new song
  skipVotes.set(guild.id, new Set());
  const { resource, ffmpeg, getStderr } = createStream(song.streamUrl, queue.volume, queue.bassBoost, song.streamHeaders);
  queue.currentFfmpeg = ffmpeg;
  song._reported = false;
  ffmpeg.on('close', code => {
    if (queue.currentFfmpeg !== ffmpeg || song._reported) return;
    const elapsed = (Date.now() - queue.startedAt) / 1000;
    const expected = song.duration || 0;
    const suspiciouslyShort = expected > 20 && elapsed < Math.min(15, expected * 0.5);
    if (code !== 0 || suspiciouslyShort) {
      song._reported = true;
      const fullStderr = getStderr();
      const reason = extractFailureReason(fullStderr) || `stream ended after ${elapsed.toFixed(1)}s (code ${code})`;
      console.error(`ffmpeg failed for ${song.title}:`, reason, '\nfull stderr tail:', fullStderr.slice(-1500));
      if (queue.textChannel) {
        queue.textChannel.send({ content: `Playback failed for **${song.title}** (${reason.slice(0, 300)}) — skipping.` }).catch(() => {});
      }
    }
  });
  queue.player.play(resource);
  logHistory(song, guild.id);
  await updateHub(guild);
}

async function tryAutoplay(guild) {
  const queue = getQueue(guild.id);
  if (!queue.autoplay || !queue.currentSong) return false;
  const lastSong = queue.currentSong;
  const searchQuery = `ytsearch1:${lastSong.uploader} ${lastSong.title}`;
  try {
    const entries = await getPlaylistEntries(searchQuery);
    if (entries.length === 0) return false;
    const song = { ...entries[0], streamUrl: null, requestedBy: 'Autoplay' };
    queue.songs.push(song);
    return true;
  } catch {
    return false;
  }
}

async function playNext(guild) {
  const queue = getQueue(guild.id);
  if (!queue.player || queue.advancing) return;
  queue.advancing = true;
  let attemptedSong = null;
  try {
    if (queue.loop && queue.currentSong) {
      if (queue.currentSong.url?.includes('soundcloud.com')) {
        queue.currentSong.streamUrl = null;
        queue.currentSong.streamHeaders = null;
      }
      attemptedSong = queue.currentSong;
      await playSong(guild, queue.currentSong);
      return;
    }

    const next = queue.songs.length > 0 ? queue.songs.shift()
               : queue.radioSongs.length > 0 ? queue.radioSongs.shift()
               : null;

    if (next) {
      attemptedSong = next;
      await playSong(guild, next);
      return;
    }

    // Nothing queued — try autoplay
    const didAutoplay = await tryAutoplay(guild);
    if (didAutoplay && queue.songs.length > 0) {
      attemptedSong = queue.songs[0];
      await playSong(guild, queue.songs.shift());
      return;
    }

    // Truly empty — disconnect
    if (queue.connection) queue.connection.destroy();
    queue.connection = null;
    queue.player = null;
    queue.currentSong = null;
    queue.voiceChannelId = null;
    updateHub(guild);
  } catch (err) {
    console.error('Error playing next song, skipping:', err.message);
    if (attemptedSong && queue.textChannel) {
      const label = attemptedSong.title || attemptedSong.url || 'that song';
      queue.textChannel.send({ content: `Couldn't play **${label}** (${err.message}) — skipping.` }).catch(() => {});
    }
    queue.advancing = false;
    // Chain to next song instead of stopping
    if (queue.songs.length > 0 || queue.radioSongs.length > 0) {
      await playNext(guild);
    } else {
      if (queue.connection) queue.connection.destroy();
      queue.connection = null;
      queue.player = null;
      queue.currentSong = null;
      queue.voiceChannelId = null;
      updateHub(guild);
    }
  } finally {
    queue.advancing = false;
  }
}

function ensurePlayer(guild, voiceChannel, textChannel) {
  const queue = getQueue(guild.id);
  queue.guild = guild;
  queue.textChannel = textChannel;
  queue.voiceChannelId = voiceChannel.id;

  if (!queue.connection) {
    queue.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
    });
  }

  if (!queue.player) {
    queue.player = createAudioPlayer();
    queue.connection.subscribe(queue.player);

    queue.player.on(AudioPlayerStatus.Idle, () => playNext(queue.guild));

    queue.player.on('error', err => {
      console.error('Player error:', err.message);
      // Clear cached stream URL on error — SoundCloud CDN URLs expire quickly
      if (queue.currentSong?.url?.includes('soundcloud.com')) {
        queue.currentSong.streamUrl = null;
        queue.currentSong.streamHeaders = null;
      }
      if (queue.textChannel && queue.currentSong && !queue.currentSong._reported) {
        queue.currentSong._reported = true;
        const label = queue.currentSong.title || queue.currentSong.url || 'that song';
        queue.textChannel.send({ content: `Playback broke on **${label}** (${err.message}) — skipping.` }).catch(() => {});
      }
    });
    return true;
  }
  return false;
}


// If player exists but is idle and songs are waiting, start playing
function kickstart(guild) {
  const queue = getQueue(guild.id);
  if (!queue.player) return;
  if (queue.player.state.status !== AudioPlayerStatus.Idle) return;
  playNext(guild);
}

client.once('ready', async () => {
  console.log(`Bot is online as ${client.user.tag}`);

  for (const guild of client.guilds.cache.values()) {
    try {
      let channel = null;
      if (process.env.MUSIC_CHANNEL_ID) {
        channel = guild.channels.cache.get(process.env.MUSIC_CHANNEL_ID);
      }
      if (!channel) {
        channel = guild.channels.cache.find(
          c => c.isTextBased() && !c.isVoiceBased() && c.name.toLowerCase().includes('music')
        );
      }
      if (!channel) continue;
      const queue = getQueue(guild.id);
      queue.textChannel = channel;
      queue.guild = guild;
      await updateHub(guild);
      console.log(`Posted startup hub in #${channel.name} (${guild.name})`);
    } catch (err) {
      console.error(`Failed to post startup hub in ${guild.name}:`, err.message);
    }
  }
});

// Progress bar timer — edit hub in place every 20s while something is playing
setInterval(async () => {
  for (const [, queue] of queues) {
    if (queue.currentSong && queue.hubMessage && queue.startedAt && queue.guild) {
      try { await editHub(queue.guild); } catch {}
    }
  }
}, 20000);

client.on('interactionCreate', async interaction => { try {

  // --- Slash Commands ---
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;
    const queue = getQueue(interaction.guild.id);

    if (commandName === 'play') {
      const input = interaction.options.getString('song');
      const voiceChannel = interaction.member.voice.channel;
      if (!voiceChannel) return interaction.reply({ content: 'Join a voice channel first.', ephemeral: true });

      await interaction.deferReply({ ephemeral: true });

      // URL: play immediately (existing behavior)
      if (isUrl(input)) {
        // Spotify track/album/playlist — resolve metadata then search YouTube for each track
        if (isSpotifyUrl(input)) {
          try {
            const tracks = await resolveSpotifyUrl(input);
            const isMulti = tracks.length > 1;
            for (const track of tracks) {
              queue.songs.push({
                title: track.title,
                uploader: track.uploader,
                duration: null,
                thumbnail: null,
                url: `ytsearch1:${track.uploader} ${track.title}`,
                streamUrl: null,
                requestedBy: interaction.user.username,
              });
            }
            const isNew = ensurePlayer(interaction.guild, voiceChannel, interaction.channel);
            if (isNew) {
              const next = queue.songs.shift();
              await playSong(interaction.guild, next);
              await interaction.editReply({ content: isMulti ? `Queued **${tracks.length} songs** from Spotify. Now playing **${next.title}**` : `Now playing **${next.title}**` });
            } else {
              await interaction.editReply({ content: isMulti ? `Added **${tracks.length} songs** from Spotify to the queue.` : `Added **${tracks[0].title}** to the queue. Position: ${queue.songs.length}` });
            }
          } catch (err) {
            console.error(err);
            await interaction.editReply({ content: `Could not load that Spotify link. ${err.message}` });
          }
          return;
        }

        try {
          const entries = await getPlaylistEntries(input);
          const isPlaylist = entries.length > 1;
          entries.forEach(song => {
            song.requestedBy = interaction.user.username;
            queue.songs.push(song);
          });
          const isNew = ensurePlayer(interaction.guild, voiceChannel, interaction.channel);
          if (isNew) {
            const next = queue.songs.shift();
            await playSong(interaction.guild, next);
            await interaction.editReply({ content: isPlaylist ? `Queued **${entries.length} songs**. Now playing **${next.title}**` : `Now playing **${next.title}**` });
          } else {
            await interaction.editReply({ content: isPlaylist ? `Added **${entries.length} songs** to the queue.` : `Added **${entries[0].title}** to the queue. Position: ${queue.songs.length}` });
          }
        } catch (err) {
          console.error(err);
          await interaction.editReply({ content: 'Could not play that URL.' });
        }
        return;
      }

      // Text search: fetch top 5 results and show a pick menu
      try {
        const entries = await getPlaylistEntries(`ytsearch5:${input}`);
        if (entries.length === 0) return interaction.editReply({ content: 'No results found.' });

        const options = entries.slice(0, 5).map((entry, i) => ({
          label: `${i + 1}. ${entry.title}`.slice(0, 100),
          description: `${entry.uploader}${entry.duration ? ` · ${formatDuration(entry.duration)}` : ''}`.slice(0, 100),
          value: entry.url.slice(0, 100),
        }));
        const menu = new StringSelectMenuBuilder()
          .setCustomId('search_select')
          .setPlaceholder('Pick a song to play')
          .addOptions(options);
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle(`Results for "${input}"`)
          .setDescription(entries.slice(0, 5).map((e, i) =>
            `**${i + 1}.** ${e.uploader} \u2014 ${e.title}${e.duration ? ` (${formatDuration(e.duration)})` : ''}`
          ).join('\n'));
        await interaction.editReply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] });
      } catch (err) {
        console.error(err);
        await interaction.editReply({ content: 'Search failed. Try a different term or paste a URL directly.' });
      }
    }

    if (commandName === 'skip') {
      if (!queue.player) return interaction.reply({ content: 'Nothing is playing.', ephemeral: true });
      queue.player.stop();
      interaction.reply({ content: 'Skipped.', ephemeral: true });
    }

    if (commandName === 'stop') {
      if (!isPrivileged(interaction.member)) return interaction.reply({ content: 'Only DJs, admins, and the server owner can stop the bot.', ephemeral: true });
      if (!queue.connection) return interaction.reply({ content: 'Not connected.', ephemeral: true });
      queue.songs = [];
      queue.radioSongs = [];
      queue.currentSong = null;
      queue.player.stop();
      queue.connection.destroy();
      queue.connection = null;
      queue.player = null;
      queue.voiceChannelId = null;
      await updateHub(interaction.guild);
      interaction.reply({ content: 'Stopped and disconnected.', ephemeral: true });
    }

    if (commandName === 'pause') {
      if (!queue.player) return interaction.reply({ content: 'Nothing is playing.', ephemeral: true });
      if (queue.player.state.status === AudioPlayerStatus.Paused) {
        queue.player.unpause();
        interaction.reply({ content: 'Resumed.', ephemeral: true });
      } else {
        queue.player.pause();
        interaction.reply({ content: 'Paused.', ephemeral: true });
      }
    }

    if (commandName === 'loop') {
      queue.loop = !queue.loop;
      interaction.reply({ content: `Loop is now **${queue.loop ? 'ON' : 'OFF'}**.`, ephemeral: true });
    }

    if (commandName === 'queue') {
      if (!queue.currentSong && queue.songs.length === 0 && queue.radioSongs.length === 0) {
        return interaction.reply({ content: 'Queue is empty.', ephemeral: true });
      }
      let description = `**Now Playing:** ${queue.currentSong?.title || 'N/A'}`;
      if (queue.songs.length > 0) description += `\u000A\u000A**Up Next (${queue.songs.length}):**\u000A` + queue.songs.map((s, i) => `${i + 1}. ${s.title}`).join('\u000A');
      if (queue.radioSongs.length > 0) description += `\u000A\u000A**Community Radio (${queue.radioSongs.length}):**\u000A` + queue.radioSongs.slice(0, 5).map((s, i) => `${i + 1}. ${s.title}`).join('\u000A') + (queue.radioSongs.length > 5 ? `\u000A*...and ${queue.radioSongs.length - 5} more*` : '');
      const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('Queue').setDescription(description.slice(0, 4096));
      interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (commandName === 'remove') {
      if (!isPrivileged(interaction.member)) return interaction.reply({ content: 'Only DJs, admins, and the server owner can remove songs.', ephemeral: true });
      const pos = interaction.options.getInteger('number');
      if (queue.songs.length === 0) return interaction.reply({ content: 'The queue is empty.', ephemeral: true });
      if (pos > queue.songs.length) return interaction.reply({ content: `Only ${queue.songs.length} song(s) in the queue.`, ephemeral: true });
      const [removed] = queue.songs.splice(pos - 1, 1);
      return interaction.reply({ content: `Removed **${removed.title}** from position ${pos}.`, ephemeral: true });
    }

    if (commandName === 'purge') {
      if (!isPrivileged(interaction.member)) return interaction.reply({ content: 'Only DJs, admins, and the server owner can purge the queue.', ephemeral: true });
      if (queue.songs.length === 0) return interaction.reply({ content: 'The queue is empty.', ephemeral: true });
      const start = interaction.options.getInteger('start');
      const end = interaction.options.getInteger('end') ?? queue.songs.length;
      if (start > queue.songs.length) return interaction.reply({ content: `Only ${queue.songs.length} song(s) in the queue.`, ephemeral: true });
      const clampedEnd = Math.min(end, queue.songs.length);
      if (start > clampedEnd) return interaction.reply({ content: 'Start position must be less than or equal to end position.', ephemeral: true });
      const removed = queue.songs.splice(start - 1, clampedEnd - start + 1);
      return interaction.reply({ content: `Removed **${removed.length}** song(s) from position ${start}${clampedEnd !== start ? `–${clampedEnd}` : ''}. ${queue.songs.length} song(s) remaining.`, ephemeral: true });
    }

    if (commandName === 'move') {
      if (!isPrivileged(interaction.member)) return interaction.reply({ content: 'Only DJs, admins, and the server owner can move songs.', ephemeral: true });
      if (queue.songs.length < 2) return interaction.reply({ content: 'Need at least 2 songs in the queue to move.', ephemeral: true });
      const from = interaction.options.getInteger('from');
      const to = interaction.options.getInteger('to');
      if (from > queue.songs.length || to > queue.songs.length) return interaction.reply({ content: `Only ${queue.songs.length} song(s) in the queue.`, ephemeral: true });
      if (from === to) return interaction.reply({ content: 'That song is already in that position.', ephemeral: true });
      const [song] = queue.songs.splice(from - 1, 1);
      queue.songs.splice(to - 1, 0, song);
      return interaction.reply({ content: `Moved **${song.title}** from position ${from} to ${to}.`, ephemeral: true });
    }

    if (commandName === 'volume') {
      const level = interaction.options.getInteger('level');
      queue.volume = level;
      // Restart current stream with new volume if playing
      if (queue.currentSong && queue.player) {
        queue.player.play(createStream(queue.currentSong.streamUrl, queue.volume, queue.bassBoost));
        await updateHub(interaction.guild);
      }
      return interaction.reply({ content: `Volume set to **${level}%**.`, ephemeral: true });
    }

    if (commandName === 'history') {
      const history = loadHistory().filter(h => h.guildId === interaction.guild.id);
      if (history.length === 0) return interaction.reply({ content: 'No songs have been played yet.', ephemeral: true });
      const last10 = history.slice(-10).reverse();
      const lines = last10.map((h, i) => {
        const ts = new Date(h.timestamp).toLocaleDateString();
        return `**${i + 1}.** ${h.uploader} \u2014 [${h.title}](${h.url}) \u00B7 *${h.requestedBy}* \u00B7 ${ts}`;
      });
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('Recently Played')
        .setDescription(lines.join('\u000A').slice(0, 4096));
      const histOptions = last10.map((h, i) => ({
        label: `${h.uploader} — ${h.title}`.slice(0, 100),
        value: String(i),
        description: new Date(h.timestamp).toLocaleDateString(),
      }));
      const histComponents = [new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId('hist_add_song_select').setPlaceholder('Add a song to one of your playlists...').addOptions(histOptions)
      )];
      return interaction.reply({ embeds: [embed], components: histComponents, ephemeral: true });
    }

    if (commandName === 'stats') {
      const history = loadHistory().filter(h => h.guildId === interaction.guild.id);
      if (history.length === 0) return interaction.reply({ content: 'No play history yet.', ephemeral: true });

      // Top requesters
      const requesterCounts = {};
      for (const h of history) {
        const key = h.requestedBy || 'Unknown';
        requesterCounts[key] = (requesterCounts[key] || 0) + 1;
      }
      const topRequesters = Object.entries(requesterCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);

      // Top songs
      const songCounts = {};
      for (const h of history) {
        const key = `${h.uploader} \u2014 ${h.title}`;
        songCounts[key] = (songCounts[key] || 0) + 1;
      }
      const topSongs = Object.entries(songCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);

      const requesterLines = topRequesters.map(([ name, count ], i) => `**${i + 1}.** ${name} \u2014 ${count} song(s)`).join('\u000A');
      const songLines = topSongs.map(([ title, count ], i) => `**${i + 1}.** ${title} \u2014 ${count} play(s)`).join('\u000A');

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('Server Music Stats')
        .addFields(
          { name: 'Top Requesters', value: requesterLines || 'None', inline: false },
          { name: 'Most Played Songs', value: songLines || 'None', inline: false },
          { name: 'Total Songs Played', value: String(history.length), inline: true }
        );
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }


    if (commandName === 'help') {
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('HypeBot — Guide')
        .addFields(
          {
            name: '🎵 Playback',
            value: [
              '`/play <name or URL>` — Search by name or paste a YouTube/SoundCloud link',
              '`/pause` — Pause or resume',
              '`/skip` — Vote to skip (majority of voice channel must agree)',
              '`/stop` — Stop and disconnect',
              '`/loop` — Toggle loop on the current song',
              '`/volume <0-150>` — Adjust volume (100 = normal)',
            ].join('\n'),
            inline: false,
          },
          {
            name: '📋 Queue',
            value: [
              '`/queue` — Show the full queue',
              '`/remove <number>` — Remove a song by position',
              '`/purge <start> [end]` — Remove a range of songs (e.g. `/purge 5 200`). Omit end to clear everything from that position onward.',
              '**View Queue** button — See queue with who requested each song',
              '**Clear Queue** button — Wipe the entire queue (currently playing song is unaffected)',
            ].join('\n'),
            inline: false,
          },
          {
            name: '♥️ Favorites',
            value: [
              '`/fav add` — Save the current song',
              '`/fav list` — View your favorites (or `/fav list @user`)',
              '`/fav play <number>` — Play a saved favorite',
              '`/fav remove <number>` — Remove a saved favorite',
              '**Favorite** button — Quick-save current song',
              "**Server Favorites** button — Browse anyone's favorites",
            ].join('\n'),
            inline: false,
          },
          {
            name: '📻 Community Radio',
            value: [
              '**Community Radio** button — Shuffle and play the server radio pool',
              '**Add to Radio** button — Add current song to the pool',
              '**View Pool** button — See all songs in the pool',
              'Radio plays automatically when your queue runs out',
            ].join('\n'),
            inline: false,
          },
          {
            name: '⚙️ Extras',
            value: [
              '**Bass Boost** button — Toggle bass EQ (blue = active)',
              '**Autoplay** button — Auto-queue a related song when queue empties',
              '**History** button or `/history` — Last 10 songs played',
              '`/stats` — Top DJs and most played songs',
            ].join('\n'),
            inline: false,
          }
        )
        .setFooter({ text: 'All button responses are private — only you can see them.' });
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (commandName === 'fav') {
      const sub = interaction.options.getSubcommand();

      if (sub === 'add') {
        if (!queue.currentSong) return interaction.reply({ content: 'Nothing is playing right now.', ephemeral: true });
        const favs = getUserFavorites(interaction.user.id);
        const song = queue.currentSong;
        if (favs.some(f => f.url === song.url)) return interaction.reply({ content: `**${song.title}** is already in your favorites.`, ephemeral: true });
        favs.push({ title: song.title, uploader: song.uploader, url: song.url, duration: song.duration, thumbnail: song.thumbnail });
        setUserFavorites(interaction.user.id, interaction.user.username, favs);
        return interaction.reply({ content: `Added **${song.title}** to your favorites. (#${favs.length})`, ephemeral: true });
      }

      if (sub === 'list') {
        const target = interaction.options.getUser('user') || interaction.user;
        const favs = getUserFavorites(target.id);
        if (favs.length === 0) return interaction.reply({ content: `${target.id === interaction.user.id ? 'You have' : `**${target.username}** has`} no favorites yet.`, ephemeral: true });
        const list = favs.map((f, i) => `**${i + 1}.** ${f.uploader} \u2014 [${f.title}](${f.url}) ${f.duration ? `(${formatDuration(f.duration)})` : ''}`).join('\u000A');
        const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(`${target.username}'s Favorites`).setDescription(list.slice(0, 4096));
        const favAddOptions = favs.slice(0, 25).map((f, i) => ({
          label: `${f.uploader} — ${f.title}`.slice(0, 100),
          value: `${target.id}||${i}`,
          description: f.duration ? formatDuration(f.duration) : undefined,
        }));
        const favComponents = [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder().setCustomId('fav_to_pl_song_select').setPlaceholder('Add a favorite to one of your playlists...').addOptions(favAddOptions)
        )];
        return interaction.reply({ embeds: [embed], components: favComponents, ephemeral: true });
      }

      if (sub === 'play') {
        const target = interaction.options.getUser('user') || interaction.user;
        const num = interaction.options.getInteger('number');
        const favs = getUserFavorites(target.id);
        if (favs.length === 0) return interaction.reply({ content: `${target.id === interaction.user.id ? 'You have' : `**${target.username}** has`} no favorites saved.`, ephemeral: true });
        if (num > favs.length) return interaction.reply({ content: `Only ${favs.length} favorite(s) saved.`, ephemeral: true });
        const voiceChannel = interaction.member.voice.channel;
        if (!voiceChannel) return interaction.reply({ content: 'Join a voice channel first.', ephemeral: true });

        await interaction.deferReply({ ephemeral: true });
        try {
          const song = { ...favs[num - 1], streamUrl: null, requestedBy: interaction.user.username };
          queue.songs.push(song);
          const isNew = ensurePlayer(interaction.guild, voiceChannel, interaction.channel);
          if (isNew) {
            const next = queue.songs.shift();
            await playSong(interaction.guild, next);
            await interaction.editReply({ content: `Now playing **${next.title}** from ${target.username}'s favorites.` });
          } else {
            await interaction.editReply({ content: `Added **${song.title}** from ${target.username}'s favorites to the queue. Position: ${queue.songs.length}` });
          }
        } catch (err) {
          console.error(err);
          await interaction.editReply({ content: 'Could not play that favorite.' });
        }
      }

      if (sub === 'remove') {
        const num = interaction.options.getInteger('number');
        const favs = getUserFavorites(interaction.user.id);
        if (num > favs.length || favs.length === 0) return interaction.reply({ content: `You only have ${favs.length} favorite(s).`, ephemeral: true });
        const [removed] = favs.splice(num - 1, 1);
        setUserFavorites(interaction.user.id, interaction.user.username, favs);
        return interaction.reply({ content: `Removed **${removed.title}** from your favorites.`, ephemeral: true });
      }
    }

    if (commandName === 'playlist') {
      const sub = interaction.options.getSubcommand();

      if (sub === 'add') {
        const name = interaction.options.getString('name').trim();
        const songInput = interaction.options.getString('song');
        const found = findEditablePlaylist(interaction.user.id, name);
        if (!found) return interaction.reply({ content: `No playlist named **${name}** found that you can edit. Create one via the Playlists button.`, ephemeral: true });
        if (found === 'ambiguous') return interaction.reply({ content: `Multiple playlists named **${name}** exist that you can edit. Use the Add to Playlist button to pick the right one.`, ephemeral: true });
        const { ownerId } = found;

        if (!songInput) {
          if (!queue.currentSong) return interaction.reply({ content: 'Nothing is playing right now. Use `/playlist add <name> <song or URL>` to add any song directly.', ephemeral: true });
          const added = addToPlaylist(interaction.user.id, ownerId, name, queue.currentSong);
          if (!added) return interaction.reply({ content: `**${queue.currentSong.title}** is already in **${name}**.`, ephemeral: true });
          return interaction.reply({ content: `Added **${queue.currentSong.title}** to **${name}**.`, ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });
        try {
          let songInfo;
          if (isUrl(songInput)) {
            songInfo = await getSongInfo(songInput);
          } else {
            const results = await getPlaylistEntries(`ytsearch1:${songInput}`);
            if (!results.length) return interaction.editReply({ content: 'No results found.' });
            songInfo = results[0];
          }
          const song = { title: songInfo.title, uploader: songInfo.uploader, url: songInfo.url, duration: songInfo.duration, thumbnail: songInfo.thumbnail };
          const added = addToPlaylist(interaction.user.id, ownerId, name, song);
          if (!added) return interaction.editReply({ content: `**${song.title}** is already in **${name}**.` });
          return interaction.editReply({ content: `Added **${song.title}** to **${name}**.` });
        } catch (err) {
          console.error(err);
          return interaction.editReply({ content: 'Could not find that song. Try a different search or paste a direct URL.' });
        }
      }

      if (sub === 'save') {
        const name = interaction.options.getString('name').trim();
        const allSongs = [];
        if (queue.currentSong) allSongs.push(queue.currentSong);
        allSongs.push(...queue.songs);
        if (allSongs.length === 0) return interaction.reply({ content: 'Nothing is playing or queued right now.', ephemeral: true });

        const data = loadPlaylists();
        if (!data[interaction.user.id]) data[interaction.user.id] = { username: interaction.user.username, playlists: {} };
        data[interaction.user.id].username = interaction.user.username;
        const isNew = !data[interaction.user.id].playlists[name];
        if (isNew) data[interaction.user.id].playlists[name] = { name, songs: [], createdAt: new Date().toISOString() };

        const pl = data[interaction.user.id].playlists[name];
        let added = 0, skipped = 0;
        for (const song of allSongs) {
          if (pl.songs.some(s => s.url === song.url)) { skipped++; continue; }
          pl.songs.push({ title: song.title, uploader: song.uploader, url: song.url, duration: song.duration, thumbnail: song.thumbnail });
          added++;
        }
        savePlaylists(data);
        const action = isNew ? `Created **${name}**` : `Updated **${name}**`;
        const skippedNote = skipped > 0 ? ` (${skipped} duplicate(s) skipped)` : '';
        return interaction.reply({ content: `${action} — added **${added}** song(s)${skippedNote}. Playlist now has **${pl.songs.length}** song(s).`, ephemeral: true });
      }

      if (sub === 'list') {
        const editable = getEditablePlaylists(interaction.user.id);
        if (editable.length === 0) return interaction.reply({ content: 'You have no playlists. Create one via the Playlists button.', ephemeral: true });
        const ownLines = editable.filter(e => e.isOwn).map((e, i) => `**${i + 1}.** ${e.name} — ${e.songs.length} song(s)`);
        const collabLines = editable.filter(e => !e.isOwn).map(e => `• ${e.ownerUsername}: ${e.name} — ${e.songs.length} song(s)`);
        let desc = '';
        if (ownLines.length) desc += '**Your Playlists**\n' + ownLines.join('\n');
        if (collabLines.length) desc += (desc ? '\n\n' : '') + '**Shared With You**\n' + collabLines.join('\n');
        const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('Playlists').setDescription(desc);
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      if (sub === 'remove') {
        const name = interaction.options.getString('name').trim();
        const num = interaction.options.getInteger('number');
        const foundR = findEditablePlaylist(interaction.user.id, name);
        if (!foundR) return interaction.reply({ content: `No playlist named **${name}** found that you can edit.`, ephemeral: true });
        if (foundR === 'ambiguous') return interaction.reply({ content: `Multiple playlists named **${name}** exist that you can edit. Use a more specific name.`, ephemeral: true });
        const data = loadPlaylists();
        const pl = data[foundR.ownerId]?.playlists?.[name];
        if (num > pl.songs.length) return interaction.reply({ content: `Only ${pl.songs.length} song(s) in that playlist.`, ephemeral: true });
        const [removed] = pl.songs.splice(num - 1, 1);
        savePlaylists(data);
        return interaction.reply({ content: `Removed **${removed.title}** from **${name}**.`, ephemeral: true });
      }

      if (sub === 'delete') {
        const name = interaction.options.getString('name').trim();
        const deleted = deletePlaylist(interaction.user.id, name);
        if (!deleted) return interaction.reply({ content: `No playlist named **${name}** found.`, ephemeral: true });
        return interaction.reply({ content: `Deleted playlist **${name}**.`, ephemeral: true });
      }

      if (sub === 'invite') {
        const name = interaction.options.getString('name').trim();
        const target = interaction.options.getUser('user');
        if (target.id === interaction.user.id) return interaction.reply({ content: 'That\'s you — you already own that playlist.', ephemeral: true });
        const data = loadPlaylists();
        const pl = data[interaction.user.id]?.playlists?.[name];
        if (!pl) return interaction.reply({ content: `You don't have a playlist named **${name}**.`, ephemeral: true });
        if (!pl.collaborators) pl.collaborators = [];
        if (pl.collaborators.includes(target.id)) return interaction.reply({ content: `**${target.username}** already has access to **${name}**.`, ephemeral: true });
        pl.collaborators.push(target.id);
        savePlaylists(data);
        return interaction.reply({ content: `**${target.username}** can now add and remove songs from your playlist **${name}**.` });
      }

      if (sub === 'revoke') {
        const name = interaction.options.getString('name').trim();
        const target = interaction.options.getUser('user');
        const data = loadPlaylists();
        const pl = data[interaction.user.id]?.playlists?.[name];
        if (!pl) return interaction.reply({ content: `You don't have a playlist named **${name}**.`, ephemeral: true });
        const idx = (pl.collaborators || []).indexOf(target.id);
        if (idx === -1) return interaction.reply({ content: `**${target.username}** doesn't have access to **${name}**.`, ephemeral: true });
        pl.collaborators.splice(idx, 1);
        savePlaylists(data);
        return interaction.reply({ content: `Removed **${target.username}**'s access to **${name}**.`, ephemeral: true });
      }
    }
  }

  // --- Button Controls ---
  if (interaction.isButton()) {
    const queue = getQueue(interaction.guild.id);

    if (interaction.customId === 'pause') {
      if (!queue.player) return interaction.reply({ content: 'Nothing is playing.', ephemeral: true });
      if (queue.player.state.status === AudioPlayerStatus.Paused) {
        queue.player.unpause();
      } else {
        queue.player.pause();
      }
      return interaction.deferUpdate();
    }

    if (interaction.customId === 'skip') {
      if (!queue.player) return interaction.reply({ content: 'Nothing is playing.', ephemeral: true });

      // Owner, admins, or DJs skip instantly
      if (isPrivileged(interaction.member)) {
        skipVotes.set(interaction.guild.id, new Set());
        queue.player.stop();
        return interaction.reply({ content: 'Skipped.', ephemeral: true });
      }

      // Vote skip logic for everyone else
      const guildId = interaction.guild.id;
      if (!skipVotes.has(guildId)) skipVotes.set(guildId, new Set());
      const votes = skipVotes.get(guildId);
      votes.add(interaction.user.id);

      // Count non-bot members in voice channel
      let memberCount = 1;
      if (queue.voiceChannelId) {
        try {
          const vc = await interaction.guild.channels.fetch(queue.voiceChannelId);
          memberCount = vc.members.filter(m => !m.user.bot).size;
        } catch {}
      }
      const needed = Math.ceil(memberCount / 2);

      if (votes.size >= needed) {
        skipVotes.set(guildId, new Set());
        queue.player.stop();
        return interaction.reply({ content: 'Vote passed! Skipping.', ephemeral: true });
      }
      return interaction.reply({ content: `Vote to skip: **${votes.size}/${needed}** votes needed.`, ephemeral: true });
    }

    if (interaction.customId === 'stop') {
      if (!isPrivileged(interaction.member)) return interaction.reply({ content: 'Only DJs, admins, and the server owner can stop the bot.', ephemeral: true });
      if (!queue.connection) return interaction.reply({ content: 'Not connected.', ephemeral: true });
      queue.songs = [];
      queue.radioSongs = [];
      queue.currentSong = null;
      queue.player.stop();
      queue.connection.destroy();
      queue.connection = null;
      queue.player = null;
      queue.voiceChannelId = null;
      await updateHub(interaction.guild);
      return interaction.deferUpdate();
    }

    if (interaction.customId === 'favorite') {
      if (!queue.currentSong) return interaction.reply({ content: 'Nothing is playing right now.', ephemeral: true });
      const favs = getUserFavorites(interaction.user.id);
      const song = queue.currentSong;
      if (favs.some(f => f.url === song.url)) return interaction.reply({ content: `**${song.title}** is already in your favorites.`, ephemeral: true });
      favs.push({ title: song.title, uploader: song.uploader, url: song.url, duration: song.duration, thumbnail: song.thumbnail });
      setUserFavorites(interaction.user.id, interaction.user.username, favs);
      return interaction.reply({ content: `Added **${song.title}** to your favorites. (#${favs.length})`, ephemeral: true });
    }

    if (interaction.customId === 'bass_boost') {
      queue.bassBoost = !queue.bassBoost;
      // Restart stream with new filter settings if playing
      if (queue.currentSong && queue.player && queue.currentSong.streamUrl) {
        queue.player.play(createStream(queue.currentSong.streamUrl, queue.volume, queue.bassBoost));
      }
      await updateHub(interaction.guild);
      return interaction.deferUpdate();
    }

    if (interaction.customId === 'autoplay') {
      queue.autoplay = !queue.autoplay;
      await updateHub(interaction.guild);
      return interaction.reply({ content: `Autoplay is now **${queue.autoplay ? 'ON' : 'OFF'}**.`, ephemeral: true });
    }

    if (interaction.customId === 'history') {
      const history = loadHistory().filter(h => h.guildId === interaction.guild.id);
      if (history.length === 0) return interaction.reply({ content: 'No songs have been played yet.', ephemeral: true });
      const last10 = history.slice(-10).reverse();
      const lines = last10.map((h, i) => {
        const ts = new Date(h.timestamp).toLocaleDateString();
        return `**${i + 1}.** ${h.uploader} \u2014 [${h.title}](${h.url}) \u00B7 *${h.requestedBy}* \u00B7 ${ts}`;
      });
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('Recently Played')
        .setDescription(lines.join('\u000A').slice(0, 4096));
      const histOptions = last10.map((h, i) => ({
        label: `${h.uploader} — ${h.title}`.slice(0, 100),
        value: String(i),
        description: new Date(h.timestamp).toLocaleDateString(),
      }));
      const histComponents = [new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId('hist_add_song_select').setPlaceholder('Add a song to one of your playlists...').addOptions(histOptions)
      )];
      return interaction.reply({ embeds: [embed], components: histComponents, ephemeral: true });
    }

    if (interaction.customId === 'add_to_radio') {
      if (!queue.currentSong) return interaction.reply({ content: 'Nothing is playing right now.', ephemeral: true });
      const pool = loadRadio();
      if (pool.some(s => s.url === queue.currentSong.url)) return interaction.reply({ content: `**${queue.currentSong.title}** is already in the Community Radio pool.`, ephemeral: true });
      const modal = new ModalBuilder().setCustomId('modal_add_to_radio').setTitle('Add to Community Radio');
      const genreInput = new TextInputBuilder()
        .setCustomId('radio_genre')
        .setLabel('Genre tag (optional)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. Rap, Chill, House — leave blank for Untagged')
        .setRequired(false)
        .setMaxLength(30);
      modal.addComponents(new ActionRowBuilder().addComponents(genreInput));
      return interaction.showModal(modal);
    }

    if (interaction.customId === 'community_radio') {
      const pool = loadRadio();
      if (pool.length === 0) {
        return interaction.reply({ content: 'The Community Radio pool is empty — add songs while something is playing.', ephemeral: true });
      }
      const voiceChannel = interaction.member.voice.channel;
      if (!voiceChannel) return interaction.reply({ content: 'Join a voice channel first.', ephemeral: true });

      // If any songs have genre tags, show a genre filter first
      const genres = [...new Set(pool.map(s => s.genre).filter(Boolean))];
      if (genres.length > 0) {
        const options = [
          { label: 'All Genres', value: 'all', description: `${pool.length} songs` },
          ...genres.map(g => ({
            label: g,
            value: g,
            description: `${pool.filter(s => s.genre === g).length} songs`,
          })),
        ];
        const menu = new StringSelectMenuBuilder()
          .setCustomId('radio_genre_select')
          .setPlaceholder('Filter by genre (or pick All Genres)')
          .addOptions(options.slice(0, 25));
        return interaction.reply({ content: '**Community Radio** — pick a genre to play:', components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
      }

      // No genres — start immediately with weighted shuffle
      const shuffled = weightedShuffle(pool);
      queue.radioSongs = shuffled.map(s => ({ ...s, streamUrl: null, requestedBy: 'Community Radio' }));
      const isNew = ensurePlayer(interaction.guild, voiceChannel, interaction.channel);
      if (isNew) {
        await interaction.deferUpdate();
        const next = queue.radioSongs.shift();
        await playSong(interaction.guild, next);
        return interaction.followUp({ content: `Community Radio started \u2014 **${pool.length} songs** shuffled. Any song you queue will play before the radio resumes.`, ephemeral: true });
      } else {
        return interaction.reply({ content: `Community Radio queued \u2014 **${pool.length} songs** will play after your current queue finishes.`, ephemeral: true });
      }
    }

    if (interaction.customId === 'view_pool') {
      const pool = loadRadio();
      if (pool.length === 0) return interaction.reply({ content: 'The Community Radio pool is empty. Add songs while music is playing using the Add to Radio button.', ephemeral: true });
      const lines = pool.map((s, i) => {
        const up = s.upvotes?.length || 0;
        const down = s.downvotes?.length || 0;
        const votes = up > 0 || down > 0 ? ` · +${up}/-${down}` : '';
        const genre = s.genre ? ` · [${s.genre}]` : '';
        return `**${i + 1}.** ${s.uploader} \u2014 ${s.title}${s.duration ? ` (${formatDuration(s.duration)})` : ''}${votes}${genre} \u00B7 *${s.addedBy}*`;
      });
      let description = '';
      for (const line of lines) {
        if ((description + '\u000A' + line).length > 4000) { description += `\u000A*...and ${pool.length - lines.indexOf(line)} more*`; break; }
        description = description ? description + '\u000A' + line : line;
      }
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`Community Radio Pool \u2014 ${pool.length} song(s)`)
        .setDescription(description);

      const songOptions = pool.slice(0, 25).map((s, i) => ({
        label: `${i + 1}. ${s.title}`.slice(0, 100),
        value: String(i),
        description: `Added by ${s.addedBy}`.slice(0, 100),
      }));
      const removeMenu = new StringSelectMenuBuilder().setCustomId('radio_remove_select').setPlaceholder('Remove a song...').addOptions(songOptions);
      const upvoteMenu = new StringSelectMenuBuilder().setCustomId('radio_upvote_select').setPlaceholder('Upvote a song...').addOptions(songOptions);
      const downvoteMenu = new StringSelectMenuBuilder().setCustomId('radio_downvote_select').setPlaceholder('Downvote a song...').addOptions(songOptions);
      return interaction.reply({
        embeds: [embed],
        components: [
          new ActionRowBuilder().addComponents(upvoteMenu),
          new ActionRowBuilder().addComponents(downvoteMenu),
          new ActionRowBuilder().addComponents(removeMenu),
        ],
        ephemeral: true,
      });
    }

    if (interaction.customId === 'view_queue') {
      const vq = getQueue(interaction.guild.id);
      if (!vq.currentSong && vq.songs.length === 0 && vq.radioSongs.length === 0) {
        return interaction.reply({ content: 'The queue is empty.', ephemeral: true });
      }
      const cur = vq.currentSong;
      const lines = [];
      lines.push('**Now Playing:**');
      if (cur) {
        lines.push(`${cur.uploader} \u2014 ${cur.title}${cur.duration ? ` (${formatDuration(cur.duration)})` : ''} \u00B7 *${cur.requestedBy || 'Unknown'}*`);
      } else {
        lines.push('Nothing');
      }
      if (vq.songs.length > 0) {
        lines.push('');
        lines.push(`**Up Next (${vq.songs.length}):**`);
        vq.songs.forEach((s, i) => lines.push(`**${i + 1}.** ${s.uploader} \u2014 ${s.title}${s.duration ? ` (${formatDuration(s.duration)})` : ''} \u00B7 *${s.requestedBy || 'Unknown'}*`));
      }
      if (vq.radioSongs.length > 0) {
        lines.push('');
        lines.push(`**Community Radio (${vq.radioSongs.length}):**`);
        vq.radioSongs.slice(0, 5).forEach((s, i) => lines.push(`**${i + 1}.** ${s.uploader} \u2014 ${s.title}${s.duration ? ` (${formatDuration(s.duration)})` : ''}`));
        if (vq.radioSongs.length > 5) lines.push(`*...and ${vq.radioSongs.length - 5} more*`);
      }
      const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('Current Queue').setDescription(lines.join('\u000A').slice(0, 4096));

      // Build "Add to Playlist" select for queue songs
      const queueSongOptions = [];
      if (vq.currentSong) queueSongOptions.push({ label: `Now: ${vq.currentSong.title}`.slice(0, 100), value: 'current', description: vq.currentSong.uploader.slice(0, 100) });
      vq.songs.slice(0, 24).forEach((s, i) => queueSongOptions.push({ label: `${i + 1}. ${s.title}`.slice(0, 100), value: `q_${i}`, description: s.uploader.slice(0, 100) }));
      const queueComponents = [];
      if (queueSongOptions.length > 0) {
        queueComponents.push(new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder().setCustomId('q_add_song_select').setPlaceholder('Add a song to one of your playlists...').addOptions(queueSongOptions)
        ));
      }
      return interaction.reply({ embeds: [embed], components: queueComponents, ephemeral: true });
    }

    if (interaction.customId === 'clear_queue') {
      if (!isPrivileged(interaction.member)) return interaction.reply({ content: 'Only DJs, admins, and the server owner can clear the queue.', ephemeral: true });
      if (queue.songs.length === 0) return interaction.reply({ content: 'The queue is already empty.', ephemeral: true });
      const count = queue.songs.length;
      queue.songs = [];
      return interaction.reply({ content: `Cleared **${count}** song(s) from the queue. Currently playing song is unaffected.`, ephemeral: true });
    }

    if (interaction.customId === 'server_favorites') {
      const data = loadFavorites();
      const usersWithFavs = Object.entries(data).filter(([, v]) => v.songs?.length > 0);
      if (usersWithFavs.length === 0) return interaction.reply({ content: 'No one in this server has any favorites saved yet.', ephemeral: true });

      const memberResults = await Promise.allSettled(usersWithFavs.map(([userId]) => interaction.guild.members.fetch(userId)));
      const options = usersWithFavs.slice(0, 25).map(([userId, val], i) => {
        const member = memberResults[i].status === 'fulfilled' ? memberResults[i].value : null;
        return { label: member ? member.user.username : val.username, value: userId, description: `${val.songs.length} favorite(s)` };
      });

      const menu = new StringSelectMenuBuilder().setCustomId('sf_user_select').setPlaceholder('Pick a user to browse their favorites').addOptions(options);
      return interaction.reply({ content: '**Server Favorites**', components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
    }

    if (interaction.customId === 'playlists') {
      const favData = loadFavorites();
      const plData = loadPlaylists();

      const options = [];

      // Favorites playlists (one per user)
      const usersWithFavs = Object.entries(favData).filter(([, v]) => v.songs?.length > 0);
      const memberResults = await Promise.allSettled(usersWithFavs.map(([userId]) => interaction.guild.members.fetch(userId)));
      usersWithFavs.forEach(([userId, val], i) => {
        const member = memberResults[i].status === 'fulfilled' ? memberResults[i].value : null;
        const username = member ? member.user.username : val.username;
        options.push({ label: `${username}'s Favorites Playlist`, value: `fav_${userId}`, description: `${val.songs.length} song(s)` });
      });

      // Custom playlists
      for (const [userId, userData] of Object.entries(plData)) {
        for (const [, pl] of Object.entries(userData.playlists || {})) {
          if (options.length >= 25) break;
          options.push({ label: pl.name, value: `pl_${userId}||${pl.name}`, description: `${pl.songs.length} song(s) · by ${userData.username}` });
        }
      }

      // Community Radio pool (full + per-genre)
      const radioPool = loadRadio();
      if (radioPool.length > 0 && options.length < 25) {
        options.push({ label: 'Community Radio', value: 'radio_all', description: `${radioPool.length} songs · weighted shuffle` });
        const genres = [...new Set(radioPool.map(s => s.genre).filter(Boolean))];
        for (const g of genres) {
          if (options.length >= 25) break;
          const count = radioPool.filter(s => s.genre === g).length;
          options.push({ label: `Community Radio — ${g}`, value: `radio_genre_${g}`, description: `${count} songs · ${g}` });
        }
      }

      const components = [];
      if (options.length > 0) {
        const menu = new StringSelectMenuBuilder().setCustomId('playlist_select').setPlaceholder('Pick a playlist').addOptions(options.slice(0, 25));
        components.push(new ActionRowBuilder().addComponents(menu));
      }
      components.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('playlist_create').setLabel('Create Playlist').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('server_favorites').setLabel('Server Favorites').setStyle(ButtonStyle.Success)
      ));

      return interaction.reply({ content: '**Playlists**', components, ephemeral: true });
    }

    if (interaction.customId === 'playlist_create') {
      const modal = new ModalBuilder()
        .setCustomId('modal_create_playlist')
        .setTitle('Create a Playlist');
      const nameInput = new TextInputBuilder()
        .setCustomId('playlist_name')
        .setLabel('Playlist Name')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. Late Night Vibes')
        .setMaxLength(50)
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(nameInput));
      return interaction.showModal(modal);
    }

    if (interaction.customId === 'add_to_playlist_hub') {
      if (!queue.currentSong) return interaction.reply({ content: 'Nothing is playing right now.', ephemeral: true });
      const editable = getEditablePlaylists(interaction.user.id);
      if (editable.length === 0) return interaction.reply({ content: 'You have no playlists yet. Create one via the Playlists button first.', ephemeral: true });
      const options = editable.slice(0, 25).map(e => ({
        label: e.isOwn ? e.name : `${e.ownerUsername}: ${e.name}`,
        value: `${e.ownerId}||${e.name}`,
        description: `${e.songs.length} song(s)`,
      }));
      const menu = new StringSelectMenuBuilder().setCustomId('hub_pl_select').setPlaceholder('Pick a playlist').addOptions(options);
      return interaction.reply({ content: `Add **${queue.currentSong.title}** to which playlist?`, components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
    }

    if (interaction.customId.startsWith('playlist_play_') || interaction.customId.startsWith('playlist_shuffle_')) {
      const isShuffled = interaction.customId.startsWith('playlist_shuffle_');
      const value = interaction.customId.replace(isShuffled ? 'playlist_shuffle_' : 'playlist_play_', '');

      let rawSongs, title;
      if (value.startsWith('fav_')) {
        const userId = value.slice(4);
        const data = loadFavorites();
        const entry = data[userId];
        if (!entry || entry.songs.length === 0) return interaction.update({ content: 'That playlist is empty.', components: [], embeds: [] });
        let member = null;
        try { member = await interaction.guild.members.fetch(userId); } catch {}
        const username = member ? member.user.username : entry.username;
        rawSongs = entry.songs;
        title = `${username}'s Favorites Playlist`;
      } else {
        // pl_userId||playlistName
        const sep = value.slice(3).indexOf('||');
        const userId = value.slice(3, 3 + sep);
        const playlistName = value.slice(3 + sep + 2);
        const data = loadPlaylists();
        const pl = data[userId]?.playlists?.[playlistName];
        if (!pl || pl.songs.length === 0) return interaction.update({ content: 'That playlist is empty.', components: [], embeds: [] });
        rawSongs = pl.songs;
        title = pl.name;
      }

      const voiceChannel = interaction.member.voice.channel;
      if (!voiceChannel) return interaction.update({ content: 'Join a voice channel first.', components: [], embeds: [] });

      const songs = (isShuffled ? shuffle(rawSongs) : [...rawSongs]).map(s => ({ ...s, streamUrl: null, requestedBy: title }));
      songs.forEach(s => queue.songs.push(s));

      const isNew = ensurePlayer(interaction.guild, voiceChannel, interaction.channel);
      if (isNew) {
        await interaction.update({ content: `Loading **${title}**${isShuffled ? ' (shuffled)' : ''}...`, components: [], embeds: [] });
        const next = queue.songs.shift();
        await playSong(interaction.guild, next);
        return interaction.editReply({ content: `Playing **${title}**${isShuffled ? ' (shuffled)' : ''} — **${songs.length} songs**. Now playing **${next.title}**` });
      } else {
        return interaction.update({ content: `Added **${title}**${isShuffled ? ' (shuffled)' : ''} — **${songs.length} songs** queued.`, components: [], embeds: [] });
      }
    }
  }


    if (interaction.customId === 'help') {
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('HypeBot — Guide')
        .addFields(
          {
            name: 'Playback',
            value: [
              '**Pause** — Pause or resume',
              '**Skip** — Admins skip instantly. Everyone else votes (majority wins)',
              '**Stop** — Stop playback and disconnect',
              '**Bass Boost** — Toggle bass EQ (blue = active)',
              '`/play <name or URL>` — Search by name or paste a YouTube/SoundCloud/Spotify link',
              '`/pause` · `/skip` · `/stop` · `/loop` · `/volume <0-150>`',
            ].join('\n'),
            inline: false,
          },
          {
            name: 'Queue',
            value: [
              '**View Queue** — See the full queue with requesters',
              '**Clear Queue** — Wipe the entire queue instantly (currently playing song is unaffected)',
              '`/queue` · `/remove <number>`',
              '`/purge <start> [end]` — Remove a range (e.g. `/purge 5 200`). Omit end to clear everything from that position onward.',
            ].join('\n'),
            inline: false,
          },
          {
            name: 'Favorites',
            value: [
              '**Favorite** — Save the current song to your favorites',
              '**Playlists → Server Favorites** — Browse and play anyone\'s saved favorites',
              '`/fav add` · `/fav list` · `/fav play <number>` · `/fav remove <number>`',
            ].join('\n'),
            inline: false,
          },
          {
            name: 'Playlists',
            value: [
              '**Playlists** — Browse all favorites playlists and custom playlists',
              '**Create Playlist** (inside Playlists) — Name and create your own playlist',
              'Pick any playlist → **Play** or **Shuffle**',
              '**Add to Playlist** button — Instantly save the current song (pick from your playlists)',
              '**View Queue** → dropdown — Add any queued song to a playlist',
              '**History** → dropdown — Add a recently played song to a playlist',
              '`/fav list` → dropdown — Add any favorite to a playlist',
              '`/playlist add <name>` — Add the current song to a playlist',
              '`/playlist add <name> <song or URL>` — Add any song without playing it first',
              '`/playlist save <name>` — Dump the entire queue into a playlist (creates it if needed)',
              '`/playlist list` — See all your playlists and shared playlists',
              '`/playlist remove <name> <number>` — Remove a song',
              '`/playlist delete <name>` — Delete an entire playlist',
              '`/playlist invite <name> @user` — Give someone edit access to your playlist',
              '`/playlist revoke <name> @user` — Remove someone\'s edit access',
            ].join('\n'),
            inline: false,
          },
          {
            name: 'Community Radio',
            value: [
              '**Community Radio** — Shuffle and play the server radio pool',
              '**Add to Radio** (inside Community Radio) — Add current song to the pool',
              '**View Pool** (inside Community Radio) — See all songs in the pool',
              '**Autoplay** (inside Community Radio) — Auto-queue a related song when queue empties',
              'Radio plays automatically when your queue runs out',
            ].join('\n'),
            inline: false,
          },
          {
            name: 'History & Stats',
            value: [
              '**History** — Last 10 songs played on this server',
              '`/history` · `/stats`',
            ].join('\n'),
            inline: false,
          }
        )
        .setFooter({ text: 'All button responses are private — only you can see them.' });
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

  // --- Modal Submissions ---
  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'modal_create_playlist') {
      const name = interaction.fields.getTextInputValue('playlist_name').trim();
      if (!name) return interaction.reply({ content: 'Playlist name cannot be empty.', ephemeral: true });
      const created = createPlaylist(interaction.user.id, interaction.user.username, name);
      if (!created) return interaction.reply({ content: `You already have a playlist named **${name}**.`, ephemeral: true });
      return interaction.reply({ content: `Playlist **${name}** created.\n\n**Ways to add songs:**\n• **Add to Playlist** button on the hub — adds the current song instantly\n• \`/playlist add ${name}\` — adds the current song\n• \`/playlist add ${name} <song name or URL>\` — adds any song without playing it\n• \`/playlist save ${name}\` — dumps your entire queue into this playlist\n• **View Queue** → dropdown — pick any queued song\n• **History** → dropdown — pick from recently played\n• \`/fav list\` → dropdown — pick from your favorites`, ephemeral: true });
    }

    if (interaction.customId === 'modal_add_to_radio') {
      const queue = getQueue(interaction.guild.id);
      if (!queue.currentSong) return interaction.reply({ content: 'The song stopped before you could add it.', ephemeral: true });
      const pool = loadRadio();
      const song = queue.currentSong;
      if (pool.some(s => s.url === song.url)) return interaction.reply({ content: `**${song.title}** is already in the Community Radio pool.`, ephemeral: true });
      const genreRaw = interaction.fields.getTextInputValue('radio_genre').trim();
      const genre = genreRaw || null;
      pool.push({ title: song.title, uploader: song.uploader, url: song.url, duration: song.duration, thumbnail: song.thumbnail, addedBy: interaction.user.username, genre, upvotes: [], downvotes: [] });
      saveRadio(pool);
      const genreLabel = genre ? ` as **[${genre}]**` : '';
      return interaction.reply({ content: `Added **${song.title}**${genreLabel} to Community Radio. Pool is now **${pool.length} song(s)**.`, ephemeral: true });
    }
  }

  // --- Select Menu Interactions ---
  if (interaction.isStringSelectMenu()) {
    const queue = getQueue(interaction.guild.id);

    if (interaction.customId === 'search_select') {
      const url = interaction.values[0];
      const voiceChannel = interaction.member.voice.channel;
      if (!voiceChannel) return interaction.update({ content: 'Join a voice channel first.', components: [], embeds: [] });

      await interaction.update({ content: 'Loading...', components: [], embeds: [] });
      try {
        const song = await getSongInfo(url);
        song.streamUrl = null; // Don't cache the CDN URL — fetch fresh at play time to avoid stale/expired URLs
        song.requestedBy = interaction.user.username;
        queue.songs.push(song);
        const isNew = ensurePlayer(interaction.guild, voiceChannel, interaction.channel);
        if (isNew) {
          const next = queue.songs.shift();
          await playSong(interaction.guild, next);
          await interaction.editReply({ content: `Now playing **${next.title}**` });
        } else {
          await interaction.editReply({ content: `Added **${song.title}** to the queue. Position: ${queue.songs.length}` });
        }
      } catch (err) {
        console.error(err);
        await interaction.editReply({ content: 'Could not load that song. Try searching again.' });
      }
      return;
    }

    if (interaction.customId === 'radio_remove_select') {
      const idx = parseInt(interaction.values[0]);
      const pool = loadRadio();
      if (idx < 0 || idx >= pool.length) return interaction.update({ content: 'That song is no longer in the pool.', components: [], embeds: [] });
      const removed = pool.splice(idx, 1)[0];
      saveRadio(pool);
      return interaction.update({ content: `Removed **${removed.title}** from Community Radio. Pool is now **${pool.length} song(s)**.`, components: [], embeds: [] });
    }

    if (interaction.customId === 'radio_upvote_select') {
      const idx = parseInt(interaction.values[0]);
      const pool = loadRadio();
      if (idx < 0 || idx >= pool.length) return interaction.update({ content: 'That song is no longer in the pool.', components: [], embeds: [] });
      const song = pool[idx];
      if (!song.upvotes) song.upvotes = [];
      if (!song.downvotes) song.downvotes = [];
      if (song.upvotes.includes(interaction.user.id)) return interaction.update({ content: `You already upvoted **${song.title}**.`, components: [], embeds: [] });
      song.downvotes = song.downvotes.filter(id => id !== interaction.user.id);
      song.upvotes.push(interaction.user.id);
      saveRadio(pool);
      return interaction.update({ content: `Upvoted **${song.title}** — +${song.upvotes.length}/-${song.downvotes.length}`, components: [], embeds: [] });
    }

    if (interaction.customId === 'radio_downvote_select') {
      const idx = parseInt(interaction.values[0]);
      const pool = loadRadio();
      if (idx < 0 || idx >= pool.length) return interaction.update({ content: 'That song is no longer in the pool.', components: [], embeds: [] });
      const song = pool[idx];
      if (!song.upvotes) song.upvotes = [];
      if (!song.downvotes) song.downvotes = [];
      if (song.downvotes.includes(interaction.user.id)) return interaction.update({ content: `You already downvoted **${song.title}**.`, components: [], embeds: [] });
      song.upvotes = song.upvotes.filter(id => id !== interaction.user.id);
      song.downvotes.push(interaction.user.id);
      saveRadio(pool);
      return interaction.update({ content: `Downvoted **${song.title}** — +${song.upvotes.length}/-${song.downvotes.length}`, components: [], embeds: [] });
    }

    if (interaction.customId === 'radio_genre_select') {
      const genre = interaction.values[0];
      const pool = loadRadio();
      const filtered = genre === 'all' ? pool : pool.filter(s => s.genre === genre);
      if (filtered.length === 0) return interaction.update({ content: `No songs tagged as **${genre}** in the pool.`, components: [], embeds: [] });
      const queueState = getQueue(interaction.guild.id);
      const voiceChannel = interaction.member.voice.channel;
      if (!voiceChannel) return interaction.update({ content: 'Join a voice channel first.', components: [], embeds: [] });
      const shuffled = weightedShuffle(filtered);
      queueState.radioSongs = shuffled.map(s => ({ ...s, streamUrl: null, requestedBy: 'Community Radio' }));
      const isNew = ensurePlayer(interaction.guild, voiceChannel, interaction.channel);
      if (isNew) {
        await interaction.update({ content: `Loading Community Radio${genre !== 'all' ? ` [${genre}]` : ''}...`, components: [], embeds: [] });
        const next = queueState.radioSongs.shift();
        await playSong(interaction.guild, next);
        return interaction.editReply({ content: `Community Radio${genre !== 'all' ? ` [${genre}]` : ''} started \u2014 **${filtered.length} songs** shuffled.` });
      } else {
        return interaction.update({ content: `Community Radio${genre !== 'all' ? ` [${genre}]` : ''} queued \u2014 **${filtered.length} songs** will play after your current queue finishes.`, components: [], embeds: [] });
      }
    }

    if (interaction.customId === 'sf_user_select') {
      const targetId = interaction.values[0];
      const data = loadFavorites();
      const entry = data[targetId];
      if (!entry || entry.songs.length === 0) return interaction.update({ content: 'That user has no favorites.', components: [], embeds: [] });

      let member = null;
      try { member = await interaction.guild.members.fetch(targetId); } catch {}
      const username = member ? member.user.username : entry.username;
      const avatarURL = member ? member.user.displayAvatarURL({ size: 256 }) : null;

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setAuthor({ name: `${username}'s Favorites`, iconURL: avatarURL || undefined })
        .setThumbnail(avatarURL)
        .setDescription(
          entry.songs.map((s, i) => `**${i + 1}.** ${s.uploader} \u2014 ${s.title}${s.duration ? ` (${formatDuration(s.duration)})` : ''}`).slice(0, 15).join('\u000A') +
          (entry.songs.length > 15 ? `\u000A*...and ${entry.songs.length - 15} more*` : '')
        );

      const menu = new StringSelectMenuBuilder()
        .setCustomId(`sf_song_select_${targetId}`)
        .setPlaceholder(`Pick a song from ${username}'s favorites`)
        .addOptions(entry.songs.slice(0, 25).map((song, i) => ({
          label: song.title.slice(0, 100),
          value: String(i),
          description: `${song.uploader}${song.duration ? ` \u00B7 ${formatDuration(song.duration)}` : ''}`.slice(0, 100),
        })));
      return interaction.update({ content: null, embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] });
    }

    if (interaction.customId === 'playlist_select') {
      const value = interaction.values[0];

      // Community Radio playlists — start immediately (radio is always shuffled)
      if (value === 'radio_all' || value.startsWith('radio_genre_')) {
        const pool = loadRadio();
        const genre = value === 'radio_all' ? null : value.slice('radio_genre_'.length);
        const filtered = genre ? pool.filter(s => s.genre === genre) : pool;
        if (filtered.length === 0) return interaction.update({ content: 'That radio pool is empty.', components: [], embeds: [] });
        const voiceChannel = interaction.member.voice.channel;
        if (!voiceChannel) return interaction.update({ content: 'Join a voice channel first.', components: [], embeds: [] });
        const radioQueue = getQueue(interaction.guild.id);
        const shuffled = weightedShuffle(filtered);
        radioQueue.radioSongs = shuffled.map(s => ({ ...s, streamUrl: null, requestedBy: genre ? `Community Radio [${genre}]` : 'Community Radio' }));
        const isNew = ensurePlayer(interaction.guild, voiceChannel, interaction.channel);
        if (isNew) {
          await interaction.update({ content: `Loading Community Radio${genre ? ` [${genre}]` : ''}...`, components: [], embeds: [] });
          const next = radioQueue.radioSongs.shift();
          await playSong(interaction.guild, next);
          return interaction.editReply({ content: `Community Radio${genre ? ` [${genre}]` : ''} started \u2014 **${filtered.length} songs** shuffled.` });
        } else {
          return interaction.update({ content: `Community Radio${genre ? ` [${genre}]` : ''} queued \u2014 **${filtered.length} songs** will play after your current queue finishes.`, components: [], embeds: [] });
        }
      }

      let songs, title;

      if (value.startsWith('fav_')) {
        const userId = value.slice(4);
        const data = loadFavorites();
        const entry = data[userId];
        if (!entry || entry.songs.length === 0) return interaction.update({ content: 'That playlist is empty.', components: [], embeds: [] });
        let member = null;
        try { member = await interaction.guild.members.fetch(userId); } catch {}
        const username = member ? member.user.username : entry.username;
        songs = entry.songs;
        title = `${username}'s Favorites Playlist`;
      } else {
        // pl_userId||playlistName
        const sep = value.slice(3).indexOf('||');
        const userId = value.slice(3, 3 + sep);
        const playlistName = value.slice(3 + sep + 2);
        const data = loadPlaylists();
        const pl = data[userId]?.playlists?.[playlistName];
        if (!pl || pl.songs.length === 0) return interaction.update({ content: 'That playlist is empty.', components: [], embeds: [] });
        songs = pl.songs;
        title = pl.name;
      }

      const preview = songs.slice(0, 10).map((s, i) => `**${i + 1}.** ${s.uploader} — ${s.title}${s.duration ? ` (${formatDuration(s.duration)})` : ''}`).join('\n');
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(title)
        .setDescription(preview + (songs.length > 10 ? `\n*...and ${songs.length - 10} more*` : ''))
        .setFooter({ text: `${songs.length} song(s) total` });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`playlist_play_${value}`).setLabel('Play').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`playlist_shuffle_${value}`).setLabel('Shuffle').setStyle(ButtonStyle.Success)
      );
      return interaction.update({ content: null, embeds: [embed], components: [row] });
    }

    if (interaction.customId.startsWith('sf_song_select_')) {
      const targetId = interaction.customId.replace('sf_song_select_', '');
      const songIndex = parseInt(interaction.values[0]);
      const data = loadFavorites();
      const entry = data[targetId];
      const favSong = entry?.songs[songIndex];
      if (!favSong) return interaction.update({ content: 'Could not find that song.', components: [], embeds: [] });

      const voiceChannel = interaction.member.voice.channel;
      if (!voiceChannel) return interaction.update({ content: 'Join a voice channel first.', components: [], embeds: [] });

      const song = { ...favSong, streamUrl: null, requestedBy: interaction.user.username };
      queue.songs.push(song);
      const isNew = ensurePlayer(interaction.guild, voiceChannel, interaction.channel);

      if (isNew) {
        await interaction.update({ content: `Loading **${song.title}**...`, components: [], embeds: [] });
        const next = queue.songs.shift();
        await playSong(interaction.guild, next);
        return interaction.editReply({ content: `Now playing **${next.title}** from ${entry.username}'s favorites.` });
      } else {
        return interaction.update({ content: `Added **${song.title}** from ${entry.username}'s favorites to the queue. Position: ${queue.songs.length}`, components: [], embeds: [] });
      }
    }

    // --- Hub "Add to Playlist" playlist picker ---
    if (interaction.customId === 'hub_pl_select') {
      const sep = interaction.values[0].indexOf('||');
      const ownerId = interaction.values[0].slice(0, sep);
      const playlistName = interaction.values[0].slice(sep + 2);
      if (!queue.currentSong) return interaction.update({ content: 'The song stopped before you could add it.', components: [], embeds: [] });
      const added = addToPlaylist(interaction.user.id, ownerId, playlistName, queue.currentSong);
      if (!added) return interaction.update({ content: `**${queue.currentSong.title}** is already in **${playlistName}**.`, components: [], embeds: [] });
      return interaction.update({ content: `Added **${queue.currentSong.title}** to **${playlistName}**.`, components: [], embeds: [] });
    }

    // --- Queue "Add to Playlist" — step 1: pick song ---
    if (interaction.customId === 'q_add_song_select') {
      const songKey = interaction.values[0]; // "current" or "q_N"
      let song;
      if (songKey === 'current') {
        song = queue.currentSong;
      } else {
        const idx = parseInt(songKey.slice(2));
        song = queue.songs[idx];
      }
      if (!song) return interaction.reply({ content: 'That song is no longer in the queue.', ephemeral: true });
      const qEditable = getEditablePlaylists(interaction.user.id);
      if (qEditable.length === 0) return interaction.reply({ content: 'You have no playlists yet. Create one via the Playlists button first.', ephemeral: true });
      const options = qEditable.slice(0, 25).map(e => ({ label: e.isOwn ? e.name : `${e.ownerUsername}: ${e.name}`, value: `${e.ownerId}||${e.name}`, description: `${e.songs.length} song(s)` }));
      const menu = new StringSelectMenuBuilder().setCustomId(`q_add_pl_select_${songKey}`).setPlaceholder('Pick a playlist').addOptions(options);
      return interaction.reply({ content: `Add **${song.title}** to which playlist?`, components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
    }

    // --- Queue "Add to Playlist" — step 2: pick playlist ---
    if (interaction.customId.startsWith('q_add_pl_select_')) {
      const songKey = interaction.customId.slice('q_add_pl_select_'.length);
      const sep = interaction.values[0].indexOf('||');
      const ownerId = interaction.values[0].slice(0, sep);
      const playlistName = interaction.values[0].slice(sep + 2);
      let song;
      if (songKey === 'current') {
        song = queue.currentSong;
      } else {
        const idx = parseInt(songKey.slice(2));
        song = queue.songs[idx];
      }
      if (!song) return interaction.update({ content: 'That song is no longer in the queue.', components: [], embeds: [] });
      const added = addToPlaylist(interaction.user.id, ownerId, playlistName, song);
      if (!added) return interaction.update({ content: `**${song.title}** is already in **${playlistName}**.`, components: [], embeds: [] });
      return interaction.update({ content: `Added **${song.title}** to **${playlistName}**.`, components: [], embeds: [] });
    }

    // --- History "Add to Playlist" — step 1: pick song ---
    if (interaction.customId === 'hist_add_song_select') {
      const histIdx = parseInt(interaction.values[0]);
      const hEditable = getEditablePlaylists(interaction.user.id);
      if (hEditable.length === 0) return interaction.reply({ content: 'You have no playlists yet. Create one via the Playlists button first.', ephemeral: true });
      const history = loadHistory().filter(h => h.guildId === interaction.guild.id);
      const last10 = history.slice(-10).reverse();
      const entry = last10[histIdx];
      if (!entry) return interaction.reply({ content: 'Could not find that song in history.', ephemeral: true });
      const options = hEditable.slice(0, 25).map(e => ({ label: e.isOwn ? e.name : `${e.ownerUsername}: ${e.name}`, value: `${e.ownerId}||${e.name}`, description: `${e.songs.length} song(s)` }));
      const menu = new StringSelectMenuBuilder().setCustomId(`hist_add_pl_select_${histIdx}`).setPlaceholder('Pick a playlist').addOptions(options);
      return interaction.reply({ content: `Add **${entry.title}** to which playlist?`, components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
    }

    // --- History "Add to Playlist" — step 2: pick playlist ---
    if (interaction.customId.startsWith('hist_add_pl_select_')) {
      const histIdx = parseInt(interaction.customId.slice('hist_add_pl_select_'.length));
      const sep = interaction.values[0].indexOf('||');
      const ownerId = interaction.values[0].slice(0, sep);
      const playlistName = interaction.values[0].slice(sep + 2);
      const history = loadHistory().filter(h => h.guildId === interaction.guild.id);
      const last10 = history.slice(-10).reverse();
      const entry = last10[histIdx];
      if (!entry) return interaction.update({ content: 'Could not find that song in history.', components: [], embeds: [] });
      const song = { title: entry.title, uploader: entry.uploader, url: entry.url, duration: null, thumbnail: null };
      const added = addToPlaylist(interaction.user.id, ownerId, playlistName, song);
      if (!added) return interaction.update({ content: `**${entry.title}** is already in **${playlistName}**.`, components: [], embeds: [] });
      return interaction.update({ content: `Added **${entry.title}** to **${playlistName}**.`, components: [], embeds: [] });
    }

    // --- Favorites "Add to Playlist" — step 1: pick song ---
    if (interaction.customId === 'fav_to_pl_song_select') {
      const [targetId, favIdxStr] = interaction.values[0].split('||');
      const favIdx = parseInt(favIdxStr);
      const fEditable = getEditablePlaylists(interaction.user.id);
      if (fEditable.length === 0) return interaction.reply({ content: 'You have no playlists yet. Create one via the Playlists button first.', ephemeral: true });
      const favs = getUserFavorites(targetId);
      const song = favs[favIdx];
      if (!song) return interaction.reply({ content: 'Could not find that favorite.', ephemeral: true });
      const options = fEditable.slice(0, 25).map(e => ({ label: e.isOwn ? e.name : `${e.ownerUsername}: ${e.name}`, value: `${e.ownerId}||${e.name}`, description: `${e.songs.length} song(s)` }));
      const menu = new StringSelectMenuBuilder().setCustomId(`fav_to_pl_pl_select_${targetId}|${favIdx}`).setPlaceholder('Pick a playlist').addOptions(options);
      return interaction.reply({ content: `Add **${song.title}** to which playlist?`, components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
    }

    // --- Favorites "Add to Playlist" — step 2: pick playlist ---
    if (interaction.customId.startsWith('fav_to_pl_pl_select_')) {
      const parts = interaction.customId.slice('fav_to_pl_pl_select_'.length).split('|');
      const targetId = parts[0];
      const favIdx = parseInt(parts[1]);
      const sep = interaction.values[0].indexOf('||');
      const ownerId = interaction.values[0].slice(0, sep);
      const playlistName = interaction.values[0].slice(sep + 2);
      const favs = getUserFavorites(targetId);
      const song = favs[favIdx];
      if (!song) return interaction.update({ content: 'Could not find that favorite.', components: [], embeds: [] });
      const added = addToPlaylist(interaction.user.id, ownerId, playlistName, song);
      if (!added) return interaction.update({ content: `**${song.title}** is already in **${playlistName}**.`, components: [], embeds: [] });
      return interaction.update({ content: `Added **${song.title}** to **${playlistName}**.`, components: [], embeds: [] });
    }
  }
  } catch (err) {
    console.error('Interaction error:', err.message);
  }
});

client.on('error', err => console.error('Discord client error:', err.message));
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err?.message ?? err));

// YouTube changes frequently enough that yt-dlp goes stale within weeks — keep it current
// without relying on redeploys, since this bot runs 24/7 and may not get redeployed often.
function updateYtDlp() {
  const proc = spawn('pip3', ['install', '--upgrade', 'yt-dlp', '--break-system-packages']);
  let output = '';
  proc.stdout.on('data', chunk => (output += chunk));
  proc.stderr.on('data', chunk => (output += chunk));
  proc.on('close', code => {
    const summary = output.trim().split('\n').pop();
    if (code === 0) {
      console.log('yt-dlp update check:', summary);
    } else {
      console.error('yt-dlp update failed:', summary);
    }
  });
}
updateYtDlp();
setInterval(updateYtDlp, 7 * 24 * 60 * 60 * 1000);

client.login(process.env.DISCORD_TOKEN);
