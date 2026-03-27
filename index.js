import Anthropic from "@anthropic-ai/sdk";
import { WebClient } from "@slack/web-api";

// ── Config ──────────────────────────────────────────────────────────────
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const REPORT_CHANNEL = process.env.REPORT_CHANNEL_ID;
const LOOKBACK_DAYS = 3;
const MAX_MESSAGES_PER_CHANNEL = 200;

const SKIP_CHANNELS = new Set(
  (process.env.SKIP_CHANNELS || "").split(",").filter(Boolean)
);

// ── Helpers ─────────────────────────────────────────────────────────────
function daysAgo(n) {
  return Math.floor((Date.now() - n * 86400000) / 1000).toString();
}

async function getAllChannels() {
  const channels = [];
  let cursor;
  do {
    const res = await slack.conversations.list({
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
      cursor,
    });
    channels.push(...(res.channels || []));
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);

  // Auto-join all public channels the bot isn't in yet
  const toJoin = channels.filter((c) => !c.is_member && !c.is_private && !SKIP_CHANNELS.has(c.id));
  for (const ch of toJoin) {
    try {
      await slack.conversations.join({ channel: ch.id });
      console.log(`  ✅ Auto-joined #${ch.name}`);
    } catch (err) {
      console.log(`  ⚠️ Couldn't join #${ch.name}: ${err.data?.error || err.message}`);
    }
  }

  return channels.filter((c) => !SKIP_CHANNELS.has(c.id));
}
async function getMessages(channelId, oldest) {
  const messages = [];
  let cursor;
  do {
    const res = await slack.conversations.history({
      channel: channelId,
      oldest,
      limit: MAX_MESSAGES_PER_CHANNEL,
      cursor,
    });
    messages.push(...(res.messages || []));
    cursor = res.response_metadata?.next_cursor;
  } while (cursor && messages.length < MAX_MESSAGES_PER_CHANNEL);

  return messages.filter(
    (m) =>
      !m.bot_id &&
      !m.subtype?.includes("join") &&
      !m.subtype?.includes("leave") &&
      !m.subtype?.includes("channel_") &&
      m.text?.trim()
  );
}

async function getUserMap(userIds) {
  const map = {};
  const unique = [...new Set(userIds)];
  for (const id of unique) {
    try {
      const res = await slack.users.info({ user: id });
      map[id] =
        res.user?.profile?.display_name ||
        res.user?.profile?.real_name ||
        id;
    } catch {
      map[id] = id;
    }
  }
  return map;
}
// ── Main ────────────────────────────────────────────────────────────────
async function run() {
  console.log("🔍 Fetching channels...");
  const channels = await getAllChannels();
  console.log(`  Found ${channels.length} channels`);

  const oldest = daysAgo(LOOKBACK_DAYS);
  const allUserIds = [];
  const channelData = [];

  for (const ch of channels) {
    const msgs = await getMessages(ch.id, oldest);
    if (msgs.length === 0) continue;
    msgs.forEach((m) => m.user && allUserIds.push(m.user));
    channelData.push({ name: ch.name, id: ch.id, messages: msgs });
    console.log(`  #${ch.name}: ${msgs.length} messages`);
  }

  if (channelData.length === 0) {
    console.log("No messages found in the last 3 days. Skipping report.");
    return;
  }

  console.log("👥 Resolving users...");
  const userMap = await getUserMap(allUserIds);
  const transcript = channelData
    .map((ch) => {
      const msgs = ch.messages
        .sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts))
        .map((m) => {
          const name = userMap[m.user] || m.user || "unknown";
          const date = new Date(parseFloat(m.ts) * 1000).toLocaleDateString();
          return `[${date}] ${name}: ${m.text}`;
        })
        .join("\n");
      return `\n═══ #${ch.name} ═══\n${msgs}`;
    })
    .join("\n");

  console.log(`📊 Sending ${transcript.length} chars to Claude for analysis...`);

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4000,
    system: `You are an ops analyst for Alpine (a BNPL/fintech platform for coaching & education sellers) and Sire Apps (a B2B shipping/inventory platform for sneaker/streetwear resellers).

Your job: read Slack messages from the last 3 days and produce a crisp executive report identifying the most critical seller/merchant problems, bugs, and friction points.

Report format (use Slack mrkdwn formatting):

*🔥 Top Issues (ranked by severity & frequency)*
For each issue:
• What's happening (1-2 sentences)
• Which channels / how many people mentioned it
• Severity: 🔴 Critical / 🟡 Medium / 🟢 Low
*📈 Trends & Patterns*
• Recurring themes vs new issues
• Any positive signals or resolved items

*🎯 Recommended Actions*
• Top 3 things to address this cycle, who should own each

Keep it scannable. No fluff. Be direct — this goes to the CEO, CTO, and head of ops.`,
    messages: [
      {
        role: "user",
        content: `Here are all Slack messages from the last ${LOOKBACK_DAYS} days across ${channelData.length} active channels:\n\n${transcript}\n\nGenerate the seller feedback report.`,
      },
    ],
  });

  const report = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  console.log("📬 Posting report...");
  const header = `*📋 Seller Feedback Report — Last ${LOOKBACK_DAYS} Days*\n_${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}_\n_Scanned ${channelData.length} channels, ${channelData.reduce((s, c) => s + c.messages.length, 0)} messages_\n\n`;

  await slack.chat.postMessage({
    channel: REPORT_CHANNEL,
    text: header + report,
    unfurl_links: false,
  });

  console.log("✅ Report posted!");
}

run().catch((err) => {
  console.error("❌ Failed:", err);
  process.exit(1);
});