const { REST, Routes, SlashCommandBuilder } = require('discord.js');
require('dotenv').config();

const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song by name or URL')
    .addStringOption(option =>
      option.setName('song')
        .setDescription('URL or Song Title')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip the current song'),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop playback and disconnect'),
  new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Toggle loop on the current song'),
  new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pause or resume playback'),
  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show the current queue'),
  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a song from the queue by position')
    .addIntegerOption(option =>
      option.setName('number')
        .setDescription('Position in the queue to remove (1 = next up)')
        .setRequired(true)
        .setMinValue(1)
    ),
  new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Set playback volume (0-150)')
    .addIntegerOption(option =>
      option.setName('level')
        .setDescription('Volume level (0 = mute, 100 = normal, 150 = max)')
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(150)
    ),
  new SlashCommandBuilder()
    .setName('history')
    .setDescription('Show the last 10 songs played on this server'),
  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Show top requesters and most played songs for this server'),
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show a guide to all HypeBot commands and buttons'),
  new SlashCommandBuilder()
    .setName('fav')
    .setDescription('Manage your favorite songs')
    .addSubcommand(sub => sub
      .setName('add')
      .setDescription('Add the current song to your favorites')
    )
    .addSubcommand(sub => sub
      .setName('list')
      .setDescription("View your favorites or someone else's")
      .addUserOption(opt => opt
        .setName('user')
        .setDescription('User to view favorites for')
        .setRequired(false)
      )
    )
    .addSubcommand(sub => sub
      .setName('play')
      .setDescription('Play a song from favorites')
      .addIntegerOption(opt => opt
        .setName('number')
        .setDescription('Favorite number to play')
        .setRequired(true)
        .setMinValue(1)
      )
      .addUserOption(opt => opt
        .setName('user')
        .setDescription("Play from another user's favorites")
        .setRequired(false)
      )
    )
    .addSubcommand(sub => sub
      .setName('remove')
      .setDescription('Remove a song from your favorites')
      .addIntegerOption(opt => opt
        .setName('number')
        .setDescription('Favorite number to remove')
        .setRequired(true)
        .setMinValue(1)
      )
    ),
  new SlashCommandBuilder()
    .setName('playlist')
    .setDescription('Manage your playlists')
    .addSubcommand(sub => sub
      .setName('add')
      .setDescription('Add the current song to one of your playlists')
      .addStringOption(opt => opt
        .setName('name')
        .setDescription('Playlist name to add to')
        .setRequired(true)
      )
    )
    .addSubcommand(sub => sub
      .setName('list')
      .setDescription('List all of your playlists')
    )
    .addSubcommand(sub => sub
      .setName('remove')
      .setDescription('Remove a song from a playlist')
      .addStringOption(opt => opt
        .setName('name')
        .setDescription('Playlist name')
        .setRequired(true)
      )
      .addIntegerOption(opt => opt
        .setName('number')
        .setDescription('Song position to remove')
        .setRequired(true)
        .setMinValue(1)
      )
    )
    .addSubcommand(sub => sub
      .setName('delete')
      .setDescription('Delete an entire playlist')
      .addStringOption(opt => opt
        .setName('name')
        .setDescription('Playlist name to delete')
        .setRequired(true)
      )
    ),
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Registering slash commands...');
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );
    console.log('Done. Slash commands registered globally.');
  } catch (err) {
    console.error(err);
  }
})();
