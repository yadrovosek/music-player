# MoonlightHere Music Player

Desktop music player built with Electron. It includes a Discord voice playback bot that can play the local music library in a configured voice channel.

## Requirements

- Node.js (LTS)
- A Discord bot and a voice channel, if you want to use Discord playback

## Run

```powershell
npm install
npm start
```

## Discord bot setup

The app reads its Discord settings from `discord.config.json`. Create it by copying the example:

```powershell
Copy-Item discord.config.example.json discord.config.json
```

Then fill in `token` and `channelId` locally. `allowedUserIds` can contain Discord user IDs allowed to use the bot commands. The real config file is ignored by Git; never commit your bot token.
