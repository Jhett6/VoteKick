import DiscordBasePlugin from './discord-base-plugin.js';

class VoteKickPlugin extends DiscordBasePlugin {
  static get description() {
    return 'Vote to kick a player with Discord alerts, exposed settings, and optional vote status command.';
  }

  static get defaultEnabled() {
    return true;
  }

  static get optionsSpecification() {
    return {
      voteDurationSec: {
        required: false,
        default: 120,
        description: 'Duration of the vote in seconds.'
      },
      requiredPercentage: {
        required: false,
        default: 60,
        description: 'Percentage of players required to pass the vote.'
      },
      discordChannelID: {
        required: true,
        description: 'The Discord channel ID to send vote notifications to.'
      },
      enableVoteStatusCommand: {
        required: false,
        default: true,
        description: 'Whether players can check vote status using !votes.'
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);
    this.voteDuration = options.voteDurationSec * 1000;
    this.requiredPercentage = options.requiredPercentage;
    this.channelID = options.discordChannelID;
    this.showVoteStatus = options.enableVoteStatusCommand;
    this.activeVote = null;
  }

  async onPlayerChat(message) {
    const msg = message.message.trim().toLowerCase();

    if (msg.startsWith('!votekick')) {
      const parts = message.message.split(' ').filter(Boolean);
      if (parts.length < 2) {
        this.server.rcon.warn(message.steamID, 'Usage: !votekick <player name or steamID>');
        return;
      }

      const targetQuery = parts.slice(1).join(' ').toLowerCase();
      const players = await this.server.getPlayers();
      const target = players.find(p =>
        p.steamID === targetQuery || p.name.toLowerCase().includes(targetQuery)
      );

      if (!target) {
        this.server.rcon.warn(message.steamID, `Player not found: ${targetQuery}`);
        return;
      }

      const voter = message.steamID;

      if (!this.activeVote) {
        this.activeVote = {
          target,
          votes: new Set([voter]),
          startTime: Date.now()
        };

        this.server.broadcast(`🗳️ VoteKick started on ${target.name}. Type !votekick ${target.name} to vote YES.`);
        this.sendDiscordMessage(`🗳️ **VoteKick started** on \`${target.name}\` by <${voter}>. Type \`!votekick ${target.name}\` in-game to vote YES.`);

        this.voteTimeout = setTimeout(() => {
          this.server.broadcast(`⏱️ VoteKick on ${target.name} expired.`);
          this.sendDiscordMessage(`❌ **VoteKick failed**: Not enough votes to kick \`${target.name}\`.`);
          this.activeVote = null;
        }, this.voteDuration);
      } else {
        if (this.activeVote.target.steamID !== target.steamID) {
          this.server.rcon.warn(message.steamID, `A vote is already in progress for ${this.activeVote.target.name}`);
          return;
        }

        this.activeVote.votes.add(voter);

        const totalPlayers = players.length;
        const voteCount = this.activeVote.votes.size;
        const percent = (voteCount / totalPlayers) * 100;

        this.server.broadcast(`${voteCount} voted YES to kick ${target.name} (${percent.toFixed(1)}%)`);

        if (percent >= this.requiredPercentage) {
          clearTimeout(this.voteTimeout);
          this.server.broadcast(`✅ Vote passed. Kicking ${target.name}`);
          await this.server.rcon.execute(`AdminKick ${target.steamID}`);
          this.sendDiscordMessage(`✅ **VoteKick passed**: \`${target.name}\` was kicked from the server.`);
          this.activeVote = null;
        }
      }
    }

    if (msg === '!votes' && this.showVoteStatus) {
      if (!this.activeVote) {
        this.server.rcon.warn(message.steamID, 'No vote currently active.');
        return;
      }

      const now = Date.now();
      const timeLeft = Math.max(0, Math.floor((this.activeVote.startTime + this.voteDuration - now) / 1000));
      const voteCount = this.activeVote.votes.size;
      const totalPlayers = (await this.server.getPlayers()).length;
      const percent = ((voteCount / totalPlayers) * 100).toFixed(1);

      const statusMsg = `🗳️ Vote to kick ${this.activeVote.target.name}: ${voteCount} YES votes (${percent}%) — ${timeLeft}s left`;
      this.server.rcon.warn(message.steamID, statusMsg);
    }
  }

  sendDiscordMessage(content) {
    if (this.channelID && this.discord) {
      this.discord.send(this.channelID, content);
    }
  }
}

export default VoteKickPlugin;