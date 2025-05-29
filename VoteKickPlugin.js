import DiscordBasePlugin from './discord-base-plugin.js';

export default class VoteKickPlugin extends DiscordBasePlugin {
  static get description() {
    return 'Allows players to initiate a vote to kick via in-game chat, logs progress to Discord. Must be reviewed by admin.';
  }

  static get defaultEnabled() {
    return true;
  }

  static get optionsSpecification() {
    return {
      ...DiscordBasePlugin.optionsSpecification,
      channelID: {
        required: true,
        description: 'The ID of the channel to log votekick updates.',
        default: '',
        example: '667741905228136459'
      },
      voteDurationSec: {
        required: false,
        default: 120,
        description: 'How long a vote lasts in seconds.'
      },
      requiredPercentage: {
        required: false,
        default: 60,
        description: 'Percentage of players required to pass the vote.'
      },
      ignoreChats: {
        required: false,
        default: ['ChatSquad'],
        description: 'Chat types to ignore.'
      },
      pingGroups: {
        required: false,
        description: 'A list of Discord role IDs to ping.',
        default: [],
        example: ['500455137626554379']
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);
    this.activeVote = null;
    this.voteTimeout = null;
    this.onChatMessage = this.onChatMessage.bind(this);
  }

  async mount() {
    this.server.on('CHAT_MESSAGE', this.onChatMessage);
    console.log('[VoteKickPlugin] Mounted and listening for chat.');
  }

  async unmount() {
    this.server.removeEventListener('CHAT_MESSAGE', this.onChatMessage);
    if (this.voteTimeout) clearTimeout(this.voteTimeout);
  }

  async onChatMessage(info) {
    if (this.options.ignoreChats.includes(info.chat)) return;

    const message = info.message.trim().toLowerCase();
    const players = Array.from(this.server.players.values());
    const initiator = info.player;

    if (message === '!vote') {
      if (!this.activeVote) {
        this.server.rcon.warn(initiator.steamID, 'No active vote at this time. Type !kick with player name to start a vote.');
        return;
      }

      const yesVotes = this.activeVote.votes.size;
      const total = players.filter(p => p.steamID).length || 1;
      const percent = (yesVotes / total) * 100;
      const timeLeft = Math.max(0, this.options.voteDurationSec - Math.floor((Date.now() - this.activeVote.startTime) / 1000));

      this.server.rcon.warn(
        initiator.steamID,
        `Vote in progress to kick ${this.activeVote.target.name}: ${yesVotes} / ${total} votes (${percent.toFixed(1)}%) — ${timeLeft}s remaining`
      );
      return;
    }

    if (!message.startsWith('!kick')) return;
    const args = message.split(' ').slice(1);
    const query = args.join(' ').toLowerCase();

    if (this.activeVote) {
      if (this.activeVote.votes.has(initiator.steamID)) {
        this.server.rcon.warn(initiator.steamID, 'You have already voted.');
        return;
      }

      this.activeVote.votes.add(initiator.steamID);
      this.activeVote.voters.push(initiator.name);

      const yesVotes = this.activeVote.votes.size;
      const total = players.filter(p => p.steamID).length || 1;
      const percent = (yesVotes / total) * 100;

      await this.server.rcon.broadcast(`${yesVotes} voted YES to kick ${this.activeVote.target.name} (${percent.toFixed(1)}%)`);

      if (percent >= this.options.requiredPercentage) {
        clearTimeout(this.voteTimeout);
        await this.server.rcon.kick(this.activeVote.target.eosID, 'Vote passed');
        await this.server.rcon.broadcast(`Vote passed. ${this.activeVote.target.name} has been kicked.`);

        const pingContent = this.options.pingGroups.length > 0
          ? this.options.pingGroups.map(id => `<@&${id}>`).join(' ') + ' '
          : '';

        await this.sendDiscordMessage({
          content: pingContent,
          embed: {
            title: '✅ Vote Kick Passed',
            color: 65280,
            fields: [
              { name: 'Player Kicked', value: this.activeVote.target.name },
              { name: 'SteamID', value: `[${this.activeVote.target.steamID}](https://steamcommunity.com/profiles/${this.activeVote.target.steamID})` },
              { name: 'EOSID', value: this.activeVote.target.eosID },
              { name: 'Votes', value: `${yesVotes} / ${total} (${percent.toFixed(1)}%)` },
              { name: 'Voters', value: this.activeVote.voters.join(', ') },
              { name: 'Initiated By', value: `${this.activeVote.initiator} — [${initiator.steamID}](https://steamcommunity.com/profiles/${initiator.steamID})\nEOSID: ${initiator.eosID}` }
            ],
            timestamp: new Date().toISOString()
          }
        });

        this.activeVote = null;
        this.voteTimeout = null;
      }

      return;
    }

    if (!query) {
      this.server.rcon.warn(initiator.steamID, 'Usage: !kick <player name or SteamID>');
      return;
    }

    const target = players.find(p =>
      p.steamID === query || p.name.toLowerCase().includes(query)
    );

    if (!target) {
      this.server.rcon.warn(initiator.steamID, `Player not found: ${query}`);
      return;
    }

    this.activeVote = {
      target,
      votes: new Set([initiator.steamID]),
      voters: [initiator.name],
      startTime: Date.now(),
      initiator: initiator.name
    };

    await this.server.rcon.broadcast(`Vote Kick started on ${target.name}. Type !kick to vote YES.`);

    const pingContent = this.options.pingGroups.length > 0
      ? this.options.pingGroups.map(id => `<@&${id}>`).join(' ') + ' '
      : '';

    await this.sendDiscordMessage({
      content: pingContent,
      embed: {
        title: '🗳️ Vote Kick Started',
        color: 16776960,
        fields: [
          { name: 'Target', value: target.name, inline: true },
          { name: 'SteamID', value: `[${target.steamID}](https://steamcommunity.com/profiles/${target.steamID})`, inline: true },
          { name: 'EOSID', value: target.eosID, inline: true },
          { name: 'Started by', value: `${initiator.name} — [${initiator.steamID}](https://steamcommunity.com/profiles/${initiator.steamID})\nEOSID: ${initiator.eosID}`, inline: false }
        ],
        timestamp: new Date().toISOString()
      }
    });

    this.voteTimeout = setTimeout(() => this.expireVote(), this.options.voteDurationSec * 1000);
  }

  async expireVote() {
    const { target, votes, voters, initiator } = this.activeVote;

    await this.server.rcon.broadcast(`Vote to Kick on ${target.name} expired.`);

    const pingContent = this.options.pingGroups.length > 0
      ? this.options.pingGroups.map(id => `<@&${id}>`).join(' ') + ' '
      : '';

    await this.sendDiscordMessage({
      content: pingContent,
      embed: {
        title: '❌ Vote Kick Failed',
        color: 16711680,
        fields: [
          { name: 'Player', value: target.name },
          { name: 'SteamID', value: `[${target.steamID}](https://steamcommunity.com/profiles/${target.steamID})` },
          { name: 'EOSID', value: target.eosID },
          { name: 'Votes', value: `${votes.size}` },
          { name: 'Voters', value: voters.join(', ') || 'None' },
          { name: 'Initiated By', value: `${initiator}` }
        ],
        timestamp: new Date().toISOString()
      }
    });

    this.activeVote = null;
    this.voteTimeout = null;
  }
}