const { dbModify } = require("../../utils/db");
const { serverLog } = require("../../utils/logs");
const { reviewEmbed, logEmbed, fetchUser } = require("../../utils/misc");
const { notifyFollowers } = require("../../utils/actions");
const { string } = require("../../utils/strings");
const { checkSuggestion, checkDenied, baseConfig, checkReview } = require("../../utils/checks");
const { cleanCommand } = require("../../utils/actions");
const { actCard } = require("../../utils/trello");
module.exports = {
	controls: {
		name: "deny",
		permission: 3,
		usage: "deny [suggestion id] (reason)",
		aliases: ["reject", "refuse", "no"],
		description: "Denies a suggestion",
		image: "images/Deny.gif",
		enabled: true,
		examples: "`{{p}}deny 1`\nDenies suggestion #1\n\n`{{p}}deny 1 This isn't something we're interested in`\nDenies suggestion #1 with the reason \"This isn't something we're interested in\"",
		permissions: ["VIEW_CHANNEL", "SEND_MESSAGES", "EMBED_LINKS", "USE_EXTERNAL_EMOJIS"],
		cooldown: 5,
		cooldownMessage: "Need to deny multiple suggestions? Try the `mdeny` command!",
		docs: "staff/deny"
	},
	do: async (locale, message, client, args, Discord, noCommand=false) => {
		let [returned, qServerDB] = await baseConfig(locale, message.guild);
		if (returned) return message.channel.send(returned);
		const guildLocale = qServerDB.config.locale;

		if (qServerDB.config.mode === "autoapprove") return message.channel.send(string(locale, "MODE_AUTOAPPROVE_DISABLED_ERROR", {}, "error")).then(sent => cleanCommand(message, sent, qServerDB));
		let deniedCheck = checkDenied(locale, message.guild, qServerDB);
		if (deniedCheck) return message.channel.send(deniedCheck);

		let [fetchSuggestion, qSuggestionDB] = await checkSuggestion(locale, message.guild, args[0]);
		if (fetchSuggestion) return message.channel.send(fetchSuggestion).then(sent => cleanCommand(message, sent, qServerDB));

		let id = qSuggestionDB.suggestionId;

		let suggester = await fetchUser(qSuggestionDB.suggester, client);
		if (!suggester) return message.channel.send(string(locale, "ERROR", {}, "error")).then(sent => cleanCommand(message, sent, qServerDB));
		if (qSuggestionDB.status !== "awaiting_review") {
			switch (qSuggestionDB.status) {
			case "approved":
				return message.channel.send(string(guildLocale, "SUGGESTION_ALREADY_APPROVED_APPROVE_ERROR", { prefix: qServerDB.config.prefix, id: id.toString() }, "error")).then(sent => cleanCommand(message, sent, qServerDB));
			case "denied":
				return message.channel.send(string(guildLocale, "SUGGESTION_ALREADY_DENIED_DENIED_ERROR", {}, "error")).then(sent => cleanCommand(message, sent, qServerDB));
			}
		}

		qSuggestionDB.status = "denied";
		qSuggestionDB.staff_member = message.author.id;

		let reason;
		if (args.slice(1).join(" ").trim()) {
			reason = args.splice(1).join(" ");
			if (reason.length > 1024) return message.channel.send(string(locale, "DENIAL_REASON_TOO_LONG_ERROR", {}, "error")).then(sent => cleanCommand(message, sent, qServerDB));
			qSuggestionDB.denial_reason = reason;
		}

		if (qSuggestionDB.reviewMessage && (qSuggestionDB.channels.staff || qServerDB.config.channels.staff)) {
			let checkStaff = checkReview(locale, message.guild, qServerDB, qSuggestionDB);
			if (checkStaff) return message.channel.send(checkStaff);
			let returned = await client.channels.cache.get(qSuggestionDB.channels.staff || qServerDB.config.channels.staff).messages.fetch(qSuggestionDB.reviewMessage).then(fetched => {
				fetched.edit((reviewEmbed(locale, qSuggestionDB, suggester, "red", string(locale, "DENIED_BY", { user: message.author.tag }))));
				fetched.reactions.removeAll();
			}).catch(() => {});
			if (returned) return;
		}

		await dbModify("Suggestion", { suggestionId: id, id: message.guild.id }, qSuggestionDB);

		if (!noCommand) {
			let replyEmbed = new Discord.MessageEmbed()
				.setTitle(string(locale, "SUGGESTION_DENIED_TITLE"))
				.setAuthor(string(locale, "SUGGESTION_FROM_TITLE", {user: suggester.tag}), suggester.displayAvatarURL({
					format: "png",
					dynamic: true
				}))
				.setFooter(string(locale, "DENIED_BY", {user: message.author.tag}), message.author.displayAvatarURL({
					format: "png",
					dynamic: true
				}))
				.setDescription(qSuggestionDB.suggestion || string(locale, "NO_SUGGESTION_CONTENT"))
				.setColor(client.colors.red);
			reason ? replyEmbed.addField(string(locale, "REASON_GIVEN"), reason) : "";
			if (qSuggestionDB.attachment) {
				replyEmbed.addField(string(locale, "WITH_ATTACHMENT_HEADER"), qSuggestionDB.attachment)
					.setImage(qSuggestionDB.attachment);
			}
			await message.channel.send(replyEmbed).then(sent => cleanCommand(message, sent, qServerDB));
		}

		await notifyFollowers(client, qServerDB, qSuggestionDB, "red", { string: "DENIED_DM_TITLE", guild: message.guild.name }, qSuggestionDB.attachment, null,reason ? { header: "REASON_GIVEN", reason: reason } : null);

		if (qServerDB.config.channels.denied) {
			let deniedEmbed = new Discord.MessageEmbed()
				.setTitle(string(guildLocale, "SUGGESTION_DENIED_TITLE"))
				.setAuthor(string(guildLocale, "SUGGESTION_FROM_TITLE", { user: suggester.tag }), suggester.displayAvatarURL({format: "png", dynamic: true}))
				.setThumbnail(suggester.displayAvatarURL({format: "png", dynamic: true}))
				.setDescription(qSuggestionDB.suggestion || string(guildLocale, "NO_SUGGESTION_CONTENT"))
				.setFooter(string(guildLocale, "SUGGESTION_FOOTER", {id: id.toString()}))
				.setTimestamp(qSuggestionDB.submitted)
				.setColor(client.colors.red);
			reason ? deniedEmbed.addField(string(guildLocale, "REASON_GIVEN"), reason) : "";
			qSuggestionDB.attachment ? deniedEmbed.setImage(qSuggestionDB.attachment) : "";
			client.channels.cache.get(qServerDB.config.channels.denied).send(deniedEmbed);
		}

		if (qServerDB.config.channels.log) {
			let logs = logEmbed(guildLocale, qSuggestionDB, message.author, "DENIED_LOG", "red")
				.setDescription(qSuggestionDB.suggestion || string(guildLocale, "NO_SUGGESTION_CONTENT"));

			reason ? logs.addField(string(guildLocale, "REASON_GIVEN"), reason) : "";
			if (qSuggestionDB.attachment) {
				logs.setImage(qSuggestionDB.attachment);
				logs.addField(string(guildLocale, "WITH_ATTACHMENT_HEADER"), qSuggestionDB.attachment);
			}
			serverLog(logs, qServerDB, client);
		}

		await actCard("deny", qServerDB, qSuggestionDB, suggester, `${string(guildLocale, "DENIED_BY", { user: message.author.tag })}${qSuggestionDB.denial_reason ? `\n${string(guildLocale, "BLOCK_REASON_HEADER")} ${qSuggestionDB.denial_reason}` : ""}`);

		return { protip: { command: "deny", not: [reason ? "deny_reason" : null] } };
	}
};
