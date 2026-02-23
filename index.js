const {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  Collection,
  PermissionsBitField,
  ChannelType,
} = require("discord.js");
require("dotenv").config();
const fs = require("fs");
const SAVE_FILE = "save.json";

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;

if (!token) {
  console.error("No Discord token found! Please check your .env file.");
  process.exit(1);
}
if (!clientId) {
  console.error("No Discord client ID found! Please check your .env file.");
  process.exit(1);
}

// Add required intents for message monitoring
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Add max slowmode config to persistent config
// In-memory config storage
const config = {
  supervisedChannels: new Map(), // guildId => Set(channelId)
  channelRates: new Map(), // guildId:channelId => rate
  logChannels: new Map(), // guildId => channelId
  maxSlowmodes: new Map(), // guildId:channelId => max_slowmode_seconds
  slowmodeDecay: new Map(), // guildId:channelId => decay_seconds
  scamBusterChannels: new Map(), // guildId => Set(channelId)
};

// Persistent config helpers
function loadConfig() {
  if (fs.existsSync(SAVE_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
      // Convert arrays back to Sets and Maps
      config.supervisedChannels = new Map(
        Object.entries(data.supervisedChannels || {}).map(([guildId, arr]) => [
          guildId,
          new Set(arr),
        ])
      );
      config.channelRates = new Map(Object.entries(data.channelRates || {}));
      config.logChannels = new Map(Object.entries(data.logChannels || {}));
      config.maxSlowmodes = new Map(Object.entries(data.maxSlowmodes || {}));
      config.slowmodeDecay = new Map(Object.entries(data.slowmodeDecay || {}));
      config.scamBusterChannels = new Map(
        Object.entries(data.scamBusterChannels || {}).map(([guildId, arr]) => [
          guildId,
          new Set(arr),
        ])
      );
    } catch (e) {
      console.error("Failed to load config:", e);
    }
  }
}
function saveConfig() {
  const data = {
    supervisedChannels: Object.fromEntries(
      Array.from(config.supervisedChannels.entries()).map(([guildId, set]) => [
        guildId,
        Array.from(set),
      ])
    ),
    channelRates: Object.fromEntries(config.channelRates),
    logChannels: Object.fromEntries(config.logChannels),
    maxSlowmodes: Object.fromEntries(config.maxSlowmodes),
    slowmodeDecay: Object.fromEntries(config.slowmodeDecay),
    scamBusterChannels: Object.fromEntries(
      Array.from(config.scamBusterChannels.entries()).map(([guildId, set]) => [
        guildId,
        Array.from(set),
      ])
    ),
  };
  fs.writeFileSync(SAVE_FILE, JSON.stringify(data, null, 2));
}

loadConfig();

// Slash commands definition
const commands = [
  new SlashCommandBuilder()
    .setName("add-channel")
    .setDescription("Add a channel to be supervised by the rate limiter.")
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("Channel to supervise")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("remove-channel")
    .setDescription("Remove a channel from supervision.")
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("Channel to remove")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("channels")
    .setDescription("List all supervised channels."),
  new SlashCommandBuilder()
    .setName("set-rate")
    .setDescription("Set the message rate threshold for a channel.")
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("Channel to set rate for")
        .setRequired(true)
    )
    .addIntegerOption((option) =>
      option
        .setName("msg_rate")
        .setDescription("Messages per interval")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("set-log-channel")
    .setDescription("Set the log channel for rate limiter events.")
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("Channel to log to")
        .setRequired(true)
    ),
].map((cmd) => cmd.toJSON());

// Add /set-max-slowmode command
commands.push(
  new SlashCommandBuilder()
    .setName("set-max-slowmode")
    .setDescription("Set the maximum slowmode (in seconds) for a channel.")
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("Channel to set max slowmode for")
        .setRequired(true)
    )
    .addIntegerOption((option) =>
      option
        .setName("max_seconds")
        .setDescription("Maximum slowmode in seconds")
        .setRequired(true)
    )
    .toJSON()
);

// Add /set-slowmode-decay command
commands.push(
  new SlashCommandBuilder()
    .setName("set-slowmode-decay")
    .setDescription(
      "Set the slowmode decay interval (in seconds) for a channel."
    )
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("Channel to set decay for")
        .setRequired(true)
    )
    .addIntegerOption((option) =>
      option
        .setName("seconds")
        .setDescription("Decay interval in seconds")
        .setRequired(true)
    )
    .toJSON()
);

// Add /get-started and /help commands
commands.push(
  new SlashCommandBuilder()
    .setName("get-started")
    .setDescription("Learn what the bot does and how to set it up.")
    .toJSON()
);
commands.push(
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("List all commands and their usage.")
    .toJSON()
);
commands.push(
  new SlashCommandBuilder()
    .setName("scam-buster")
    .setDescription("Enable or disable Scam Buster for a channel (only admins can post when enabled).")
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("Channel to monitor")
        .setRequired(true)
    )
    .addBooleanOption((option) =>
      option
        .setName("enabled")
        .setDescription("True to enable, False to disable")
        .setRequired(true)
    )
    .toJSON()
);

function hasManageChannels(interaction) {
  return interaction.member.permissions.has(
    PermissionsBitField.Flags.ManageChannels
  );
}

client.commands = new Collection();

// Embed helper
function makeEmbed({
  title,
  description,
  color = 0x5865f2,
  emoji = "",
  fields = [],
  footer = "Rate Limiter",
}) {
  return {
    color,
    title: emoji ? `${emoji} ${title}` : title,
    description,
    fields,
    timestamp: new Date(),
    footer: { text: footer },
  };
}

client.commands.set("add-channel", {
  execute: async (interaction) => {
    if (!hasManageChannels(interaction)) {
      return interaction.reply({
        embeds: [
          makeEmbed({
            title: "Permission Denied",
            description:
              "You need the **Manage Channels** permission to use this command.",
            color: 0xed4245,
            emoji: "⛔",
          }),
        ],
        flags: 1 << 6,
      });
    }
    const channel = interaction.options.getChannel("channel");
    if (channel.type !== ChannelType.GuildText) {
      return interaction.reply({
        embeds: [
          makeEmbed({
            title: "Invalid Channel",
            description: "Only text channels can be supervised.",
            color: 0xed4245,
            emoji: "⚠️",
          }),
        ],
        flags: 1 << 6,
      });
    }
    const guildId = interaction.guildId;
    if (!config.supervisedChannels.has(guildId))
      config.supervisedChannels.set(guildId, new Set());
    config.supervisedChannels.get(guildId).add(channel.id);
    saveConfig();
    await interaction.reply({
      embeds: [
        makeEmbed({
          title: "Channel Added",
          description: `Channel <#${channel.id}> is now supervised.`,
          color: 0x57f287,
          emoji: "✅",
        }),
      ],
    });
  },
});

client.commands.set("remove-channel", {
  execute: async (interaction) => {
    if (!hasManageChannels(interaction)) {
      return interaction.reply({
        embeds: [
          makeEmbed({
            title: "Permission Denied",
            description:
              "You need the **Manage Channels** permission to use this command.",
            color: 0xed4245,
            emoji: "⛔",
          }),
        ],
        flags: 1 << 6,
      });
    }
    const channel = interaction.options.getChannel("channel");
    const guildId = interaction.guildId;
    if (
      !config.supervisedChannels.has(guildId) ||
      !config.supervisedChannels.get(guildId).has(channel.id)
    ) {
      return interaction.reply({
        embeds: [
          makeEmbed({
            title: "Not Supervised",
            description: `Channel <#${channel.id}> is not supervised.`,
            color: 0xed4245,
            emoji: "⚠️",
          }),
        ],
        flags: 1 << 6,
      });
    }
    config.supervisedChannels.get(guildId).delete(channel.id);
    saveConfig();
    await interaction.reply({
      embeds: [
        makeEmbed({
          title: "Channel Removed",
          description: `Channel <#${channel.id}> is no longer supervised.`,
          color: 0x57f287,
          emoji: "✅",
        }),
      ],
    });
  },
});

client.commands.set("channels", {
  execute: async (interaction) => {
    const guildId = interaction.guildId;
    const channels = config.supervisedChannels.get(guildId);
    if (!channels || channels.size === 0) {
      return interaction.reply({
        embeds: [
          makeEmbed({
            title: "No Channels",
            description: "No channels are currently supervised.",
            color: 0xed4245,
            emoji: "ℹ️",
          }),
        ],
        flags: 1 << 6,
      });
    }
    const channelMentions = Array.from(channels)
      .map((id) => `<#${id}>`)
      .join(", ");
    await interaction.reply({
      embeds: [
        makeEmbed({
          title: "Supervised Channels",
          description: channelMentions,
          color: 0x5865f2,
          emoji: "👀",
        }),
      ],
    });
  },
});

client.commands.set("set-rate", {
  execute: async (interaction) => {
    if (!hasManageChannels(interaction)) {
      return interaction.reply({
        embeds: [
          makeEmbed({
            title: "Permission Denied",
            description:
              "You need the **Manage Channels** permission to use this command.",
            color: 0xed4245,
            emoji: "⛔",
          }),
        ],
        flags: 1 << 6,
      });
    }
    const channel = interaction.options.getChannel("channel");
    const rate = interaction.options.getInteger("msg_rate");
    if (channel.type !== ChannelType.GuildText) {
      return interaction.reply({
        embeds: [
          makeEmbed({
            title: "Invalid Channel",
            description: "Only text channels can have a rate set.",
            color: 0xed4245,
            emoji: "⚠️",
          }),
        ],
        flags: 1 << 6,
      });
    }
    const key = `${interaction.guildId}:${channel.id}`;
    config.channelRates.set(key, rate);
    saveConfig();
    await interaction.reply({
      embeds: [
        makeEmbed({
          title: "Rate Set",
          description: `Set message rate for <#${channel.id}> to **${rate}** messages per interval.`,
          color: 0x57f287,
          emoji: "⏱️",
        }),
      ],
    });
  },
});

client.commands.set("set-log-channel", {
  execute: async (interaction) => {
    if (!hasManageChannels(interaction)) {
      return interaction.reply({
        embeds: [
          makeEmbed({
            title: "Permission Denied",
            description:
              "You need the **Manage Channels** permission to use this command.",
            color: 0xed4245,
            emoji: "⛔",
          }),
        ],
        flags: 1 << 6,
      });
    }
    const channel = interaction.options.getChannel("channel");
    if (channel.type !== ChannelType.GuildText) {
      return interaction.reply({
        embeds: [
          makeEmbed({
            title: "Invalid Channel",
            description: "Log channel must be a text channel.",
            color: 0xed4245,
            emoji: "⚠️",
          }),
        ],
        flags: 1 << 6,
      });
    }
    config.logChannels.set(interaction.guildId, channel.id);
    saveConfig();
    await interaction.reply({
      embeds: [
        makeEmbed({
          title: "Log Channel Set",
          description: `Set <#${channel.id}> as the log channel.`,
          color: 0x57f287,
          emoji: "📝",
        }),
      ],
    });
  },
});

client.commands.set("set-max-slowmode", {
  execute: async (interaction) => {
    if (!hasManageChannels(interaction)) {
      return interaction.reply({
        embeds: [
          makeEmbed({
            title: "Permission Denied",
            description:
              "You need the **Manage Channels** permission to use this command.",
            color: 0xed4245,
            emoji: "⛔",
          }),
        ],
        flags: 1 << 6,
      });
    }
    const channel = interaction.options.getChannel("channel");
    const maxSeconds = interaction.options.getInteger("max_seconds");
    if (channel.type !== ChannelType.GuildText) {
      return interaction.reply({
        embeds: [
          makeEmbed({
            title: "Invalid Channel",
            description: "Only text channels can have slowmode set.",
            color: 0xed4245,
            emoji: "⚠️",
          }),
        ],
        flags: 1 << 6,
      });
    }
    if (maxSeconds < 0 || maxSeconds > 21600) {
      return interaction.reply({
        embeds: [
          makeEmbed({
            title: "Invalid Value",
            description:
              "Slowmode must be between 0 and 21600 seconds (6 hours).",
            color: 0xed4245,
            emoji: "⚠️",
          }),
        ],
        flags: 1 << 6,
      });
    }
    const key = `${interaction.guildId}:${channel.id}`;
    config.maxSlowmodes.set(key, maxSeconds);
    saveConfig();
    await interaction.reply({
      embeds: [
        makeEmbed({
          title: "Max Slowmode Set",
          description: `Set max slowmode for <#${channel.id}> to **${maxSeconds}** seconds.`,
          color: 0x57f287,
          emoji: "🐢",
        }),
      ],
    });
  },
});

client.commands.set("set-slowmode-decay", {
  execute: async (interaction) => {
    if (!hasManageChannels(interaction)) {
      return interaction.reply({
        embeds: [
          makeEmbed({
            title: "Permission Denied",
            description:
              "You need the **Manage Channels** permission to use this command.",
            color: 0xed4245,
            emoji: "⛔",
          }),
        ],
        flags: 1 << 6,
      });
    }
    const channel = interaction.options.getChannel("channel");
    const seconds = interaction.options.getInteger("seconds");
    if (channel.type !== ChannelType.GuildText) {
      return interaction.reply({
        embeds: [
          makeEmbed({
            title: "Invalid Channel",
            description: "Only text channels can have slowmode decay set.",
            color: 0xed4245,
            emoji: "⚠️",
          }),
        ],
        flags: 1 << 6,
      });
    }
    if (seconds < 5 || seconds > 3600) {
      return interaction.reply({
        embeds: [
          makeEmbed({
            title: "Invalid Value",
            description:
              "Decay interval must be between 5 and 3600 seconds (1 hour).",
            color: 0xed4245,
            emoji: "⚠️",
          }),
        ],
        flags: 1 << 6,
      });
    }
    const key = `${interaction.guildId}:${channel.id}`;
    config.slowmodeDecay.set(key, seconds);
    saveConfig();
    await interaction.reply({
      embeds: [
        makeEmbed({
          title: "Slowmode Decay Set",
          description: `Set slowmode decay for <#${channel.id}> to **${seconds}** seconds.`,
          color: 0x57f287,
          emoji: "⏳",
        }),
      ],
    });
  },
});

client.commands.set("get-started", {
  execute: async (interaction) => {
    const embed = makeEmbed({
      title: "Getting Started",
      emoji: "🚦",
      color: 0x5865f2,
      description:
        `**WGG Rate Limiter Bot** helps you control message flow in busy channels by automatically adjusting slowmode based on activity.\n\n` +
        `**How it works:**\n` +
        `- Monitors selected channels for message bursts.\n` +
        `- If messages exceed your set rate, slowmode increases automatically.\n` +
        `- Slowmode decays back down after inactivity.\n\n` +
        `**Quick Setup for One Channel:**\n` +
        `1. Use "/add-channel" to select a channel to supervise.\n` +
        `2. Use "/set-rate" to set the max messages per second for that channel.\n` +
        `3. (Optional) Use "/set-log-channel" to pick a channel for logs.\n` +
        `4. (Optional) Use "/set-max-slowmode" and "/set-slowmode-decay" to fine-tune slowmode behavior.\n\n` +
        `For a full list of commands and details, use "/help"!`,
    });
    await interaction.reply({ embeds: [embed], flags: 1 << 6 });
  },
});

async function sendScamBusterLog(guild, embed) {
  const logChannelId = config.logChannels.get(guild.id);
  if (!logChannelId) return;
  const logChannel = guild.channels.cache.get(logChannelId);
  if (logChannel && logChannel.type === ChannelType.GuildText) {
    await logChannel.send({ embeds: [embed] }).catch(() => {});
  }
}

client.commands.set("scam-buster", {
  execute: async (interaction) => {
    if (!hasManageChannels(interaction)) {
      return interaction.reply({
        embeds: [
          makeEmbed({
            title: "Permission Denied",
            description:
              "You need the **Manage Channels** permission to use this command.",
            color: 0xed4245,
            emoji: "⛔",
          }),
        ],
        flags: 1 << 6,
      });
    }
    const channel = interaction.options.getChannel("channel");
    const enabled = interaction.options.getBoolean("enabled");
    if (channel.type !== ChannelType.GuildText) {
      return interaction.reply({
        embeds: [
          makeEmbed({
            title: "Invalid Channel",
            description: "Only text channels can be monitored by Scam Buster.",
            color: 0xed4245,
            emoji: "⚠️",
          }),
        ],
        flags: 1 << 6,
      });
    }
    const guildId = interaction.guildId;
    if (!config.scamBusterChannels.has(guildId)) {
      config.scamBusterChannels.set(guildId, new Set());
    }
    const set = config.scamBusterChannels.get(guildId);
    if (enabled) {
      set.add(channel.id);
      saveConfig();
      const logEmbed = makeEmbed({
        title: "Scam Buster enabled",
        description: `Scam Buster is now monitoring <#${channel.id}>. Only users with **Administrator** may post; others will be banned.`,
        color: 0x57f287,
        emoji: "🛡️",
        fields: [
          { name: "Channel", value: `<#${channel.id}>`, inline: true },
          { name: "Enabled by", value: `<@${interaction.user.id}>`, inline: true },
        ],
      });
      await sendScamBusterLog(interaction.guild, logEmbed);
      await interaction.reply({
        embeds: [
          makeEmbed({
            title: "Scam Buster enabled",
            description: `Channel <#${channel.id}> is now protected. Only users with Administrator can post; others will be banned.`,
            color: 0x57f287,
            emoji: "🛡️",
          }),
        ],
      });
    } else {
      if (!set.has(channel.id)) {
        return interaction.reply({
          embeds: [
            makeEmbed({
              title: "Not monitored",
              description: `Channel <#${channel.id}> is not currently monitored by Scam Buster.`,
              color: 0xed4245,
              emoji: "⚠️",
            }),
          ],
          flags: 1 << 6,
        });
      }
      set.delete(channel.id);
      saveConfig();
      const logEmbed = makeEmbed({
        title: "Scam Buster disabled",
        description: `Scam Buster has been disabled for <#${channel.id}>.`,
        color: 0xfee75c,
        emoji: "🛡️",
        fields: [
          { name: "Channel", value: `<#${channel.id}>`, inline: true },
          { name: "Disabled by", value: `<@${interaction.user.id}>`, inline: true },
        ],
      });
      await sendScamBusterLog(interaction.guild, logEmbed);
      await interaction.reply({
        embeds: [
          makeEmbed({
            title: "Scam Buster disabled",
            description: `Channel <#${channel.id}> is no longer monitored by Scam Buster.`,
            color: 0x57f287,
            emoji: "🛡️",
          }),
        ],
      });
    }
  },
});

client.commands.set("help", {
  execute: async (interaction) => {
    const embed = makeEmbed({
      title: "Bot Commands",
      emoji: "📖",
      color: 0x5865f2,
      description: "Here are all available commands:",
      fields: [
        {
          name: "/add-channel channel",
          value: "Add a text channel to be supervised by the rate limiter.",
        },
        {
          name: "/remove-channel channel",
          value: "Remove a channel from supervision.",
        },
        {
          name: "/channels",
          value: "List all currently supervised channels.",
        },
        {
          name: "/set-rate channel msg_rate",
          value: "Set the allowed messages per second for a channel.",
        },
        {
          name: "/set-log-channel channel",
          value: "Set the channel where logs will be sent.",
        },
        {
          name: "/set-max-slowmode channel max_seconds",
          value:
            "Set the maximum slowmode (in seconds) for a channel (default: 30s).",
        },
        {
          name: "/set-slowmode-decay channel seconds",
          value:
            "Set how many seconds of inactivity before slowmode drops by 5s (default: 20s).",
        },
        {
          name: "/scam-buster channel enabled",
          value:
            "Enable or disable Scam Buster for a channel. When enabled, only users with Administrator can post; others are banned and logged.",
        },
        {
          name: "/get-started",
          value: "Get a quick explanation and setup guide for the bot.",
        },
        {
          name: "/help",
          value: "Show this help message.",
        },
      ],
      footer: "Use the commands above to configure and monitor your channels!",
    });
    await interaction.reply({ embeds: [embed], flags: 1 << 6 });
  },
});

// Rate limiting state: { [guildId:channelId]: { count, lastReset, warnedAt } }
const rateState = {};

// Track original slowmode and last infraction for decay
const slowmodeState = {};

client.on("messageCreate", async (message) => {
  // Scam Buster: in protected channels, only allow users with Administrator
  if (
    !message.author.bot &&
    message.channel.type === ChannelType.GuildText &&
    message.guild &&
    config.scamBusterChannels.has(message.guildId) &&
    config.scamBusterChannels.get(message.guildId).has(message.channel.id)
  ) {
    const hasAdmin = message.member?.permissions.has(
      PermissionsBitField.Flags.Administrator
    );
    if (!hasAdmin) {
      const contentSnippet = (message.content || "(no text content)").slice(
        0,
        3900
      );
      const baseFields = [
        {
          name: "User",
          value: `${message.author.tag} (${message.author.id})`,
          inline: true,
        },
        {
          name: "Channel",
          value: `<#${message.channel.id}>`,
          inline: true,
        },
      ];

      let banSucceeded = false;
      try {
        await message.guild.members.ban(message.author.id, {
          reason: "Scam Buster: unauthorized message in protected channel",
          deleteMessageSeconds: 86400, // delete their messages from last 1 day
        });
        banSucceeded = true;
      } catch (e) {
        console.error("Scam Buster ban failed:", e);
        const isMissingPerms = e.code === 50013;
        const permNote = isMissingPerms
          ? "Bot lacks **Ban Members** permission, or cannot ban this user (e.g. above bot in role hierarchy / server owner)."
          : (e.message || String(e));
        const logEmbed = makeEmbed({
          title: "Scam Buster — Ban failed",
          description:
            `Could not ban <@${message.author.id}> for posting in a Scam Buster protected channel.\n\n**Reason:** ${permNote}\n\n**Message that triggered the action:**\n\`\`\`\n${contentSnippet}\n\`\`\``,
          color: 0xed4245,
          emoji: "⚠️",
          fields: baseFields,
          footer: "Scam Buster",
        });
        await sendScamBusterLog(message.guild, logEmbed);
        return;
      }

      if (banSucceeded) {
        await new Promise((r) => setTimeout(r, 5000));
        try {
          await message.guild.members.unban(message.author.id, "Scam Buster: temporary ban ended");
        } catch (e) {
          console.error("Scam Buster unban failed:", e);
        }
        const logEmbed = makeEmbed({
          title: "Scam Buster Ban",
          description:
            `User <@${message.author.id}> was temporarily banned (5s) and unbanned. Their messages from the last 1 day were deleted.\n\n**Message that triggered the action:**\n\`\`\`\n${contentSnippet}\n\`\`\``,
          color: 0xed4245,
          emoji: "🔨",
          fields: baseFields,
          footer: "Scam Buster",
        });
        await sendScamBusterLog(message.guild, logEmbed);
      }
      return;
    }
  }

  // Only monitor text channels, ignore bots, and only for supervised channels
  if (
    message.author.bot ||
    message.channel.type !== ChannelType.GuildText ||
    !config.supervisedChannels.has(message.guildId) ||
    !config.supervisedChannels.get(message.guildId).has(message.channel.id)
  ) {
    return;
  }
  const key = `${message.guildId}:${message.channel.id}`;
  const now = Date.now();
  const rate = parseInt(config.channelRates.get(key), 10) || 0;
  if (!rate) return; // No rate set, do nothing

  if (!rateState[key]) {
    rateState[key] = { count: 0, lastReset: now, warnedAt: 0 };
  }
  // Reset count if more than 1 second has passed
  if (now - rateState[key].lastReset >= 1000) {
    rateState[key].count = 0;
    rateState[key].lastReset = now;
    rateState[key].warnedAt = 0;
  }
  rateState[key].count++;

  // Debug logging
  console.log(
    `[RateLimit] Channel ${message.channel.id} | Count: ${rateState[key].count} | Rate: ${rate}/sec`
  );

  if (rateState[key].count >= rate) {
    // Only warn once per second
    if (rateState[key].warnedAt && now - rateState[key].warnedAt < 1000) return;
    rateState[key].warnedAt = now;

    // Slowmode logic
    let currentSlowmode = message.channel.rateLimitPerUser || 0;
    const maxSlowmode = parseInt(config.maxSlowmodes.get(key), 10) || 30;
    // Track original slowmode for decay
    if (!slowmodeState[key]) {
      slowmodeState[key] = {
        original: currentSlowmode,
        lastInfraction: now,
      };
    } else {
      slowmodeState[key].lastInfraction = now;
    }
    let newSlowmode = Math.min(currentSlowmode + 5, maxSlowmode);
    if (newSlowmode > currentSlowmode) {
      try {
        await message.channel.setRateLimitPerUser(
          newSlowmode,
          "Rate limit exceeded by users"
        );
      } catch (e) {
        console.error("Failed to set slowmode:", e);
      }
    }

    // Prepare embeds
    const warningEmbed = makeEmbed({
      title: "Rate Limit Exceeded",
      description: `🚨 This channel has exceeded the configured rate of **${rate} messages/second**! Slowmode is now **${newSlowmode}** seconds. Please slow down.`,
      color: 0xed4245,
      emoji: "🚨",
    });
    const logEmbed = makeEmbed({
      title: "Rate Limit Triggered",
      description: `Channel <#${
        message.channel.id
      }> exceeded **${rate} messages/second** at <t:${Math.floor(
        now / 1000
      )}:T>. Slowmode set to **${newSlowmode}** seconds.`,
      color: 0xed4245,
      emoji: "🚨",
      fields: [
        { name: "Guild", value: message.guild.name, inline: true },
        { name: "Channel", value: `<#${message.channel.id}>`, inline: true },
        {
          name: "Triggered By",
          value: `<@${message.author.id}>`,
          inline: true,
        },
      ],
    });

    // Send warning to the channel
    message.channel.send({ embeds: [warningEmbed] }).catch(() => {});

    // Send log to the log channel if set
    const logChannelId = config.logChannels.get(message.guildId);
    if (logChannelId) {
      const logChannel = message.guild.channels.cache.get(logChannelId);
      if (logChannel && logChannel.type === ChannelType.GuildText) {
        logChannel.send({ embeds: [logEmbed] }).catch(() => {});
      }
    }
  } else if (slowmodeState[key]) {
    // Update last infraction time if a message is sent (but not an infraction)
    slowmodeState[key].lastMessage = now;
  }
});

// Periodic interval to decay slowmode
setInterval(async () => {
  const now = Date.now();
  for (const key in slowmodeState) {
    const [guildId, channelId] = key.split(":");
    const state = slowmodeState[key];
    // Use per-channel decay interval if set, else default to 20s
    const decayMs = (parseInt(config.slowmodeDecay.get(key), 10) || 20) * 1000;
    // If no infraction in the last decay interval, try to decay
    if (state.lastInfraction && now - state.lastInfraction >= decayMs) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;
      const channel = guild.channels.cache.get(channelId);
      if (!channel || channel.type !== ChannelType.GuildText) continue;
      let currentSlowmode = channel.rateLimitPerUser || 0;
      let newSlowmode = Math.max(currentSlowmode - 5, state.original);
      if (newSlowmode < currentSlowmode) {
        try {
          await channel.setRateLimitPerUser(
            newSlowmode,
            "Slowmode decay after inactivity"
          );
          // Log decay
          const logChannelId = config.logChannels.get(guildId);
          if (logChannelId) {
            const logChannel = guild.channels.cache.get(logChannelId);
            if (logChannel && logChannel.type === ChannelType.GuildText) {
              const decayEmbed = makeEmbed({
                title: "Slowmode Decayed",
                description: `Slowmode for <#${channelId}> decreased to **${newSlowmode}** seconds after ${
                  decayMs / 1000
                }s of no infractions.`,
                color: 0x57f287,
                emoji: "🐢",
              });
              logChannel.send({ embeds: [decayEmbed] }).catch(() => {});
            }
          }
        } catch (e) {
          console.error("Failed to decay slowmode:", e);
        }
      }
      // If we've reached the original, stop tracking
      if (newSlowmode === state.original) {
        delete slowmodeState[key];
      } else {
        // Update lastInfraction so we wait another decay interval
        slowmodeState[key].lastInfraction = now;
      }
    }
  }
}, 5000);

const GUILD_IDS = [
  "857689267744800800",
  "1326315584417435648",
  "766791173129502751",
  "1392172773111107594",
];

// Register slash commands on startup (for the specified guilds for instant updates)
client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}!`);
  const rest = new REST({ version: "10" }).setToken(token);
  for (const guildId of GUILD_IDS) {
    try {
      console.log(
        "Started refreshing application (/) commands for guild:",
        guildId
      );
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
        body: commands,
      });
      console.log(
        "Successfully reloaded application (/) commands for guild:",
        guildId
      );
    } catch (error) {
      console.error(`Failed to register commands for guild ${guildId}:`, error);
    }
  }
});

// Handle slash command interactions
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const command = client.commands.get(interaction.commandName);
  if (!command) return;
  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(error);
    await interaction.reply({
      content: "There was an error while executing this command!",
      ephemeral: true,
    });
  }
});

client.on("error", (error) => {
  console.error("Discord client error:", error);
});

client.login(token);
