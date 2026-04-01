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

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

// One queue per server — persists even when nothing is playing so hub stays alive
const queues = new Map();

function getQueue(guildId) {
  if (!queues.has(guildId)) {
    queues.set(guildId, {
      songs: [],        // priority queue — user-queued songs play before radio
      radioSongs: [],   // community radio queue — plays when priority queue is empty
      player: null,
      connection: null,
      loop: false,
      currentSong: null,
      textChannel: null,
      hubMessage: null,
      voiceChannelId: null,
      guild: null,
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
      { name: 'Channel', value: queue.voiceChannelId ? `<#${queue.voiceChannelId}>` : '—', inline: true },
      { name: 'Queue', value: `${queue.songs.length + queue.radioSongs.length} song(s) in queue${queue.radioSongs.length > 0 ? ` (${queue.radioSongs.length} radio)` : ''}`, inline: true },
      { name: 'Loop', value: queue.loop ? 'ON' : 'OFF', inline: true },
      { name: 'Requested by', value: song.requestedBy || 'Unknown', inline: true }
    )
    .setThumbnail(song.thumbnail || null);
}

function buildIdleEmbed() {
  return new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle('Nothing Playing')
    .setDescription('Use `/play` to add a song, or browse Server Favorites below.');
}

function buildControls(playing = true) {
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
    new ButtonBuilder().setCustomId('view_pool').setLabel('View Pool').setStyle(ButtonStyle.Secondary)
  );
  return [row1, row2];
}

// Edit hub message if it exists, otherwise send a new one
async function updateHub(guild) {
  const queue = getQueue(guild.id);
  if (!queue.textChannel) return;

  const isPlaying = !!queue.currentSong;
  const embed = isPlaying ? buildNowPlayingEmbed(queue.currentSong, queue) : buildIdleEmbed();
  const payload = { embeds: [embed], components: buildControls(isPlaying), content: null };

  if (queue.hubMessage) {
    try {
      await queue.hubMessage.edit(payload);
      return;
    } catch {
      queue.hubMessage = null; // message deleted, fall through to send fresh
    }
  }
  queue.hubMessage = await queue.textChannel.send(payload);
}

// Get all entries from a URL — works for single tracks and playlists
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

function getSongInfo(url) {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', ['--dump-json', '--no-playlist', '-f', 'bestaudio', url]);
    let data = '';
    proc.stdout.on('data', chunk => (data += chunk));
    proc.on('close', code => {
      if (code !== 0) return reject(new Error('Could not fetch song info'));
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

function createStream(streamUrl) {
  const ffmpeg = spawn('ffmpeg', [
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-probesize', '32', '-analyzeduration', '0',
    '-i', streamUrl, '-c:a', 'libopus', '-b:a', '192k', '-vbr', 'on', '-f', 'ogg', 'pipe:1'
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
  queue.player.play(createStream(song.streamUrl));
  await updateHub(guild);
}

// Set up voice connection + player if not already running. Returns true if player was just created.
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

    queue.player.on(AudioPlayerStatus.Idle, () => {
      if (queue.loop && queue.currentSong) {
        playSong(queue.guild, queue.currentSong);
      } else if (queue.songs.length > 0) {
        // user-queued songs always play first
        playSong(queue.guild, queue.songs.shift());
      } else if (queue.radioSongs.length > 0) {
        // fall back to community radio
        playSong(queue.guild, queue.radioSongs.shift());
      } else {
        queue.connection.destroy();
        queue.connection = null;
        queue.player = null;
        queue.currentSong = null;
        queue.voiceChannelId = null;
        updateHub(queue.guild);
      }
    });

    queue.player.on('error', err => console.error('Player error:', err));
    return true;
  }
  return false;
}

client.once('ready', () => console.log(`Bot is online as ${client.user.tag}`));

client.on('interactionCreate', async interaction => {

  // --- Slash Commands ---
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;
    const queue = getQueue(interaction.guild.id);

    if (commandName === 'play') {
      const url = interaction.options.getString('url');
      const voiceChannel = interaction.member.voice.channel;
      if (!voiceChannel) return interaction.reply({ content: 'Join a voice channel first.', ephemeral: true });

      await interaction.deferReply({ ephemeral: true });
      try {
        const entries = await getPlaylistEntries(url);
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
        await interaction.editReply({ content: 'Could not play that link. Make sure it is a valid SoundCloud or YouTube URL.' });
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
      if (queue.songs.length > 0) description += `\n\n**Up Next (${queue.songs.length}):**\n` + queue.songs.map((s, i) => `${i + 1}. ${s.title}`).join('\n');
      if (queue.radioSongs.length > 0) description += `\n\n**Community Radio (${queue.radioSongs.length}):**\n` + queue.radioSongs.slice(0, 5).map((s, i) => `${i + 1}. ${s.title}`).join('\n') + (queue.radioSongs.length > 5 ? `\n*...and ${queue.radioSongs.length - 5} more*` : '');
      const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('Queue').setDescription(description.slice(0, 4096));
      interaction.reply({ embeds: [embed], ephemeral: true });
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
        const list = favs.map((f, i) => `**${i + 1}.** ${f.uploader} — [${f.title}](${f.url}) ${f.duration ? `(${formatDuration(f.duration)})` : ''}`).join('\n');
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
      queue.player.stop();
      return interaction.deferUpdate();
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
        return interaction.followUp({ content: `Community Radio started — **${pool.length} songs** shuffled. Any song you queue will play before the radio resumes.`, ephemeral: true });
      } else {
        return interaction.reply({ content: `Community Radio queued — **${pool.length} songs** will play after your current queue finishes.`, ephemeral: true });
      }
    }

    if (interaction.customId === 'view_pool') {
      const pool = loadRadio();
      if (pool.length === 0) return interaction.reply({ content: 'The Community Radio pool is empty. Add songs while music is playing using the Add to Radio button.', ephemeral: true });
      const lines = pool.map((s, i) => `**${i + 1}.** ${s.uploader} — ${s.title}${s.duration ? ` (${formatDuration(s.duration)})` : ''} · *added by ${s.addedBy}*`);
      let description = '';
      for (const line of lines) {
        if ((description + '\n' + line).length > 4000) { description += `\n*...and ${pool.length - lines.indexOf(line)} more*`; break; }
        description = description ? description + '\n' + line : line;
      }
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`Community Radio Pool — ${pool.length} song(s)`)
        .setDescription(description);
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

  // --- Select Menu Interactions ---
  if (interaction.isStringSelectMenu()) {
    const queue = getQueue(interaction.guild.id);

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
          entry.songs.map((s, i) => `**${i + 1}.** ${s.uploader} — ${s.title}${s.duration ? ` (${formatDuration(s.duration)})` : ''}`).slice(0, 15).join('\n') +
          (entry.songs.length > 15 ? `\n*...and ${entry.songs.length - 15} more*` : '')
        );

      const menu = new StringSelectMenuBuilder()
        .setCustomId(`sf_song_select_${targetId}`)
        .setPlaceholder(`Pick a song from ${username}'s favorites`)
        .addOptions(entry.songs.slice(0, 25).map((song, i) => ({
          label: song.title.slice(0, 100),
          value: String(i),
          description: `${song.uploader}${song.duration ? ` · ${formatDuration(song.duration)}` : ''}`.slice(0, 100),
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
});

client.login(process.env.DISCORD_TOKEN);
