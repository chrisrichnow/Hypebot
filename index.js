const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
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

// --- Favorites storage ---
const FAVORITES_FILE = path.join(__dirname, 'favorites.json');

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
const RADIO_FILE = path.join(__dirname, 'radio.json');

function loadRadio() {
  if (!fs.existsSync(RADIO_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(RADIO_FILE, 'utf8')); } catch { return []; }
}

function saveRadio(data) {
  fs.writeFileSync(RADIO_FILE, JSON.stringify(data, null, 2));
}

// --- History storage ---
const HISTORY_FILE = path.join(__dirname, 'history.json');

function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return []; }
}

function saveHistory(data) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2));
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

function buildNowPlayingEmbed(song, queue) {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Now Playing')
    .setDescription(`**${song.uploader}** - **[${song.title}](${song.url})** - ${formatDuration(song.duration)}`)
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
  const autoplay = !!(queue && queue.autoplay);

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('pause').setLabel('Pause').setStyle(ButtonStyle.Secondary).setDisabled(!playing),
    new ButtonBuilder().setCustomId('skip').setLabel('Skip').setStyle(ButtonStyle.Secondary).setDisabled(!playing),
    new ButtonBuilder().setCustomId('stop').setLabel('Stop').setStyle(ButtonStyle.Danger).setDisabled(!playing),
    new ButtonBuilder().setCustomId('favorite').setLabel('Favorite').setStyle(ButtonStyle.Primary).setDisabled(!playing),
    new ButtonBuilder().setCustomId('server_favorites').setLabel('Server Favorites').setStyle(ButtonStyle.Success)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('add_to_radio').setLabel('Add to Radio').setStyle(ButtonStyle.Secondary).setDisabled(!playing),
    new ButtonBuilder().setCustomId('community_radio').setLabel('Community Radio').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('view_pool').setLabel('View Pool').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('view_queue').setLabel('View Queue').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('bass_boost')
      .setLabel('Bass Boost')
      .setStyle(bassBoost ? ButtonStyle.Primary : ButtonStyle.Secondary)
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('autoplay')
      .setLabel(autoplay ? 'Autoplay: ON' : 'Autoplay: OFF')
      .setStyle(autoplay ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('history').setLabel('History').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('help').setLabel('Help').setStyle(ButtonStyle.Secondary)
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

function getPlaylistEntries(url) {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', ['--flat-playlist', '--dump-json', url]);
    let data = '';
    proc.stdout.on('data', chunk => (data += chunk));
    proc.on('close', code => {
      if (code !== 0) return reject(new Error('Could not fetch info'));
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
    proc.stderr.on('data', () => {});
  });
}

function getSongInfo(url, attempt = 0) {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', ['--dump-json', '--no-playlist', '-f', 'bestaudio/best', url]);
    let data = '';
    proc.stdout.on('data', chunk => (data += chunk));
    proc.on('close', code => {
      if (code !== 0) {
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
        });
      } catch (e) { reject(e); }
    });
    proc.stderr.on('data', () => {});
  });
}

function buildAudioFilter(volume, bassBoost) {
  const vol = (volume / 100).toFixed(2);
  if (bassBoost) {
    return `volume=${vol},bass=g=5:f=110:w=0.5`;
  }
  return `volume=${vol}`;
}

function createStream(streamUrl, volume, bassBoost) {
  const filter = buildAudioFilter(volume != null ? volume : 100, bassBoost || false);
  const ffmpeg = spawn('ffmpeg', [
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-reconnect_on_http_error', '4xx,5xx',
    '-timeout', '15000000',
    '-probesize', '32', '-analyzeduration', '0',
    '-i', streamUrl,
    '-filter:a', filter,
    '-c:a', 'libopus', '-b:a', '192k', '-vbr', 'on', '-f', 'ogg', 'pipe:1'
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  return createAudioResource(ffmpeg.stdout, { inputType: StreamType.OggOpus });
}

async function playSong(guild, song) {
  const queue = getQueue(guild.id);
  if (!song.streamUrl) {
    const info = await getSongInfo(song.url);
    Object.assign(song, info);
  }
  queue.currentSong = song;
  // Clear skip votes for new song
  skipVotes.set(guild.id, new Set());
  queue.player.play(createStream(song.streamUrl, queue.volume, queue.bassBoost));
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
  try {
    if (queue.loop && queue.currentSong) {
      if (queue.currentSong.url?.includes('soundcloud.com')) {
        queue.currentSong.streamUrl = null;
      }
      await playSong(guild, queue.currentSong);
      return;
    }

    const next = queue.songs.length > 0 ? queue.songs.shift()
               : queue.radioSongs.length > 0 ? queue.radioSongs.shift()
               : null;

    if (next) {
      await playSong(guild, next);
      return;
    }

    // Nothing queued — try autoplay
    const didAutoplay = await tryAutoplay(guild);
    if (didAutoplay && queue.songs.length > 0) {
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
      const pos = interaction.options.getInteger('number');
      if (queue.songs.length === 0) return interaction.reply({ content: 'The queue is empty.', ephemeral: true });
      if (pos > queue.songs.length) return interaction.reply({ content: `Only ${queue.songs.length} song(s) in the queue.`, ephemeral: true });
      const [removed] = queue.songs.splice(pos - 1, 1);
      return interaction.reply({ content: `Removed **${removed.title}** from position ${pos}.`, ephemeral: true });
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
      return interaction.reply({ embeds: [embed], ephemeral: true });
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
              '**View Queue** button — See queue with who requested each song',
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
              '**Server Favorites** button — Browse anyone’s favorites',
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
        return interaction.reply({ embeds: [embed], ephemeral: true });
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

      // Admins skip instantly
      if (interaction.member.permissions.has('Administrator')) {
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
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.customId === 'add_to_radio') {
      if (!queue.currentSong) return interaction.reply({ content: 'Nothing is playing right now.', ephemeral: true });
      const pool = loadRadio();
      const song = queue.currentSong;
      if (pool.some(s => s.url === song.url)) return interaction.reply({ content: `**${song.title}** is already in the Community Radio pool.`, ephemeral: true });
      pool.push({ title: song.title, uploader: song.uploader, url: song.url, duration: song.duration, thumbnail: song.thumbnail, addedBy: interaction.user.username });
      saveRadio(pool);
      return interaction.reply({ content: `Added **${song.title}** to Community Radio. Pool is now **${pool.length} song(s)**.`, ephemeral: true });
    }

    if (interaction.customId === 'community_radio') {
      const pool = loadRadio();
      if (pool.length === 0) return interaction.reply({ content: 'The Community Radio pool is empty. Add songs with the Add to Radio button first.', ephemeral: true });
      const voiceChannel = interaction.member.voice.channel;
      if (!voiceChannel) return interaction.reply({ content: 'Join a voice channel first.', ephemeral: true });

      const shuffled = shuffle(pool);
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
      const lines = pool.map((s, i) => `**${i + 1}.** ${s.uploader} \u2014 ${s.title}${s.duration ? ` (${formatDuration(s.duration)})` : ''} \u00B7 *added by ${s.addedBy}*`);
      let description = '';
      for (const line of lines) {
        if ((description + '\u000A' + line).length > 4000) { description += `\u000A*...and ${pool.length - lines.indexOf(line)} more*`; break; }
        description = description ? description + '\u000A' + line : line;
      }
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`Community Radio Pool \u2014 ${pool.length} song(s)`)
        .setDescription(description);
      return interaction.reply({ embeds: [embed], ephemeral: true });
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
      return interaction.reply({ embeds: [embed], ephemeral: true });
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
  }


    if (interaction.customId === 'help') {
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('HypeBot — Guide')
        .addFields(
          {
            name: '🎵 Playback',
            value: [
              '`/play <name or URL>` — Play a song by searching by name or pasting a YouTube/SoundCloud link',
              '`/pause` — Pause or resume the current song',
              '`/skip` — Vote to skip (majority of voice channel must agree)',
              '`/stop` — Stop playback and disconnect the bot',
              '`/loop` — Toggle loop on the current song',
              '`/volume <0-150>` — Adjust playback volume (100 = normal)',
            ].join('\n'),
            inline: false,
          },
          {
            name: '📋 Queue',
            value: [
              '`/queue` — Show the full current queue',
              '`/remove <number>` — Remove a song from the queue by position',
              '**View Queue** button — See the queue with who requested each song',
            ].join('\n'),
            inline: false,
          },
          {
            name: '♥️ Favorites',
            value: [
              '`/fav add` — Save the current song to your favorites',
              '`/fav list` — View your favorites (or `/fav list @user` for someone else)',
              '`/fav play <number>` — Play a song from your favorites',
              '`/fav remove <number>` — Remove a song from your favorites',
              '**Favorite** button — Quick-save the current song',
              '**Server Favorites** button — Browse and play anyone’s saved favorites',
            ].join('\n'),
            inline: false,
          },
          {
            name: '📻 Community Radio',
            value: [
              '**Community Radio** button — Shuffle and play the server’s shared radio pool',
              '**Add to Radio** button — Add the current song to the radio pool',
              '**View Pool** button — See all songs in the radio pool',
              'Radio songs play automatically when your personal queue runs out',
            ].join('\n'),
            inline: false,
          },
          {
            name: '⚙️ Settings & Extras',
            value: [
              '**Bass Boost** button — Toggle bass-heavy EQ (turns blue when active)',
              '**Autoplay** button — Auto-queue a related song when everything runs out',
              '**History** button — See the last 10 songs played on this server',
              '`/history` — Same as the History button',
              '`/stats` — Top DJs and most played songs on this server',
            ].join('\n'),
            inline: false,
          }
        )
        .setFooter({ text: 'Tip: all button responses are private — only you can see them.' });
      return interaction.reply({ embeds: [embed], ephemeral: true });
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
  }
  } catch (err) {
    console.error('Interaction error:', err.message);
  }
});

client.login(process.env.DISCORD_TOKEN);
