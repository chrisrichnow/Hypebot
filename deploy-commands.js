const { REST, Routes, SlashCommandBuilder } = require('discord.js');
require('dotenv').config();

const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song from a SoundCloud or YouTube URL')
    .addStringOption(option =>
      option.setName('url')
        .setDescription('SoundCloud or YouTube URL')
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
