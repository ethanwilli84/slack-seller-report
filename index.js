import Anthropic from "@anthropic-ai/sdk";
import { WebClient } from "@slack/web-api";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

// ── Config ──────────────────────────────────────────────────────────────
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const REPORT_CHANNEL = process.env.REPORT_CHANNEL_ID;
const LOOKBACK_DAYS = 3;
const MAX_MESSAGES_PER_CHANNEL = 200;
const REPORTS_DIR = path.join(process.cwd(), "reports");

const SKIP_CHANNELS = new Set(
  (process.env.SKIP_CHANNELS || "").split(",").filter(Boolean)
);

// ── Helpers ─────────────────────────────────────────────────────────────
function daysAgo(n) {
  return Math.floor((Date.now() - n * 86400000) / 1000).toString();
}

function getPastReports(maxReports = 5) {
  if (!fs.existsSync(REPORTS_DIR)) return "";
  const files = fs.readdirSync(REPORTS_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse()
    .slice(0, maxReports);
  if (files.length === 0) return "";
  return files
    .map((f) => {
      const content = fs.readFileSync(path.join(REPORTS_DIR, f), "utf-8");
      const date = f.replace(".md", "").replace("report-", "");
      return `\n── Past Report (${date}) ──\n${content}`;
    })
    .join("\n");
}

function saveReport(report) {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const date = new Date().toISOString().split("T")[0];
  const filePath = path.join(REPORTS_DIR, `report-${date}.md`);
  fs.writeFileSync(filePath, report, "utf-8");
  return filePath;
}

function gitCommitReport() {
  try {
    execSync("git config user.email 'bot@alpine.com'", { cwd: process.cwd() });
    execSync("git config user.name 'Alpine Report Bot'", { cwd: process.cwd() });
    execSync("git add reports/", { cwd: process.cwd() });
    execSync(`git commit -m "report: ${new Date().toISOString().split("T")[0]}"`, { cwd: process.cwd() });
    execSync("git push", { cwd: process.cwd() });
    console.log("📁 Report saved to repo");
  } catch (err) {
    console.log("⚠️ Git commit skipped:", err.message);
  }
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
      map[id] = res.user?.profile?.display_name || res.user?.profile?.real_name || id;
    } catch { map[id] = id; }
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

  // Load past reports for historical context
  const pastReports = getPastReports(5);
  const historyContext = pastReports
    ? `\n\nHere are the previous reports for historical context. Use these to identify issues that have persisted across multiple cycles and call them out aggressively:\n${pastReports}`
    : "";
  console.log(`📊 Sending ${transcript.length} chars to Claude for analysis...`);

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4000,
    system: `You are an ops analyst for Alpine — a BNPL/fintech platform that provides buy-now-pay-later financing for high-ticket coaching and education sellers. Alpine charges 36% APR on 6-month terms, takes a 15% seller fee, holds a 15% reserve, and the seller absorbs 20% first-loss. Alpine has ~35 active merchants and has originated ~$3.24M across ~1,600 loans.

Your job: read Slack messages from the last 3 days and produce a hard-hitting executive report identifying the most critical seller/merchant problems, bugs, and friction points that directly impact Alpine's revenue, seller retention, and loan volume.

You also have access to PREVIOUS REPORTS. Use them to:
- Flag issues that have persisted across multiple report cycles (e.g. "This has been reported for 2+ weeks and still unresolved")
- Call out when seller complaints are escalating or getting worse
- Highlight if volume/activity from specific high-value sellers has dropped since complaints started
- Be aggressive about unresolved issues — if something was flagged before and isn't fixed, escalate the severity

Known recurring pain points to watch for:
- Payout delays or reconciliation issues
- Plaid/bank compatibility failures during live sales calls
- API/webhook failures (404s, Zapier/GHL integration breaks)
- Reserve structure confusion (sellers reading 15% fee + 15% reserve as 30% flat cost)
- ACH statement descriptor issues
- Checkout bugs (ZIP code, flow breaks)
- Dispute resolution gaps

Report format (use Slack mrkdwn formatting):

*🔥 Top Issues (ranked by severity & revenue impact)*
For each issue:
• What's happening (1-2 sentences)
• Which channels / sellers mentioned it
• How long it's been an issue (reference past reports if applicable)
• Estimated revenue impact (if sellers are churning or volume dropping, say so)
• Severity: 🔴 Critical / 🟡 Medium / 🟢 Low
*⚠️ Persistent / Escalating Issues*
• Issues from past reports that are STILL unresolved — call these out hard
• Note how many cycles they've been flagged

*📈 Trends & Patterns*
• Recurring themes vs new issues
• Seller sentiment shift (getting better or worse?)
• Any positive signals or resolved items

*🎯 Recommended Actions*
• Top 3 things to address this cycle
• For each: who should own it (Ethan/CEO, Amine/CTO, Monte/Ops)
• Flag anything that's been deferred too long

Be direct and aggressive about unresolved issues. Don't sugarcoat. This report goes to the CEO, CTO, and head of ops. If something is costing Alpine money or about to lose a seller, make that crystal clear.`,
    messages: [
      {
        role: "user",
        content: `Here are all Slack messages from the last ${LOOKBACK_DAYS} days across ${channelData.length} active channels:\n\n${transcript}${historyContext}\n\nGenerate the seller feedback report.`,
      },
    ],
  });

  const report = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  // Save report for historical context
  saveReport(report);
  gitCommitReport();

  // Post to Slack
  console.log("📬 Posting report...");
  const header = `*📋 Alpine Seller Feedback Report — Last ${LOOKBACK_DAYS} Days*\n_${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}_\n_Scanned ${channelData.length} channels, ${channelData.reduce((s, c) => s + c.messages.length, 0)} messages_\n\n`;

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