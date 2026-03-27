import Anthropic from "@anthropic-ai/sdk";
import { WebClient } from "@slack/web-api";
import { MongoClient } from "mongodb";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

// ── Config ──────────────────────────────────────────────────────────────
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const REPORT_CHANNEL = process.env.REPORT_CHANNEL_ID;
const MONGO_URI = process.env.MONGO_URI;
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

function daysAgoDate(n) {
  return new Date(Date.now() - n * 86400000);
}
// ── MongoDB: Pull seller volume data ────────────────────────────────────
async function getSellerVolumeData() {
  if (!MONGO_URI) {
    console.log("⚠️ No MONGO_URI set — skipping volume data");
    return null;
  }

  const mongo = new MongoClient(MONGO_URI);
  try {
    await mongo.connect();
    const db = mongo.db("sire-pay");

    const now = new Date();
    const currentStart = daysAgoDate(LOOKBACK_DAYS);
    const prevStart = daysAgoDate(LOOKBACK_DAYS * 2);

    // Get all companies for name mapping
    const companies = await db.collection("companies").find({}).toArray();
    const companyMap = {};
    companies.forEach((c) => (companyMap[c._id.toString()] = c.name));

    // Current period transactions by company
    const currentTxns = await db.collection("transactions").aggregate([
      { $match: { createdAt: { $gte: currentStart }, status: "SUCCESS" } },
      { $group: { _id: "$company", count: { $sum: 1 }, total: { $sum: "$amount" } } },
    ]).toArray();

    // Previous period for comparison
    const prevTxns = await db.collection("transactions").aggregate([
      { $match: { createdAt: { $gte: prevStart, $lt: currentStart }, status: "SUCCESS" } },
      { $group: { _id: "$company", count: { $sum: 1 }, total: { $sum: "$amount" } } },
    ]).toArray();
    const prevMap = {};
    prevTxns.forEach((t) => (prevMap[t._id?.toString()] = t));

    // Build seller volume summary
    const sellerVolume = currentTxns
      .map((t) => {
        const id = t._id?.toString();
        const name = companyMap[id] || "Unknown";
        const prev = prevMap[id] || { count: 0, total: 0 };
        const countChange = prev.count ? ((t.count - prev.count) / prev.count * 100).toFixed(1) : "new";
        const totalChange = prev.total ? ((t.total - prev.total) / prev.total * 100).toFixed(1) : "new";
        return { name, count: t.count, total: t.total, prevCount: prev.count, prevTotal: prev.total, countChange, totalChange };
      })
      .filter((s) => s.name !== "Demo company" && s.name !== "test")
      .sort((a, b) => b.total - a.total);

    // Delinquent / overdue loans
    const overdue = await db.collection("sessionloans").find({
      status: "PENDING",
      dueDate: { $lt: now },
    }).toArray();

    const overdueByCompany = {};
    for (const loan of overdue) {
      const tracker = await db.collection("sessiontrackers").findOne({ _id: loan.sessionTracker });
      const compId = tracker?.company?.toString();
      const sellerName = companyMap[compId] || "Unknown";
      if (!overdueByCompany[sellerName]) overdueByCompany[sellerName] = { count: 0, total: 0 };
      overdueByCompany[sellerName].count++;
      overdueByCompany[sellerName].total += loan.amount || 0;
    }
    // Failed transactions this period
    const failedTxns = await db.collection("transactions").aggregate([
      { $match: { createdAt: { $gte: currentStart }, status: "FAILED" } },
      { $group: { _id: "$company", count: { $sum: 1 }, total: { $sum: "$amount" } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]).toArray();

    const failedSummary = failedTxns.map((t) => {
      const name = companyMap[t._id?.toString()] || "Unknown";
      return `${name}: ${t.count} failed txns ($${t.total.toFixed(2)})`;
    });

    // Format output
    let summary = "═══ SELLER VOLUME DATA (from MongoDB) ═══\n\n";
    summary += `Period: ${currentStart.toLocaleDateString()} – ${now.toLocaleDateString()}\n\n`;
    summary += "SELLER VOLUME (current vs previous 3 days):\n";
    for (const s of sellerVolume) {
      summary += `• ${s.name}: ${s.count} txns ($${s.total.toFixed(2)}) | prev: ${s.prevCount} txns ($${s.prevTotal.toFixed(2)}) | change: ${s.countChange}%\n`;
    }

    if (Object.keys(overdueByCompany).length > 0) {
      summary += "\nOVERDUE BNPL INSTALLMENTS:\n";
      for (const [name, data] of Object.entries(overdueByCompany)) {
        summary += `• ${name}: ${data.count} overdue ($${data.total.toFixed(2)})\n`;
      }
    }

    if (failedSummary.length > 0) {
      summary += "\nFAILED TRANSACTIONS THIS PERIOD:\n";
      failedSummary.forEach((f) => (summary += `• ${f}\n`));
    }

    console.log("📊 Volume data pulled from MongoDB");
    return summary;
  } finally {
    await mongo.close();
  }
}
// ── Report History ──────────────────────────────────────────────────────
function getPastReports(maxReports = 5) {
  if (!fs.existsSync(REPORTS_DIR)) return "";
  const files = fs.readdirSync(REPORTS_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort().reverse().slice(0, maxReports);
  if (files.length === 0) return "";
  return files.map((f) => {
    const content = fs.readFileSync(path.join(REPORTS_DIR, f), "utf-8");
    const date = f.replace(".md", "").replace("report-", "");
    return `\n── Past Report (${date}) ──\n${content}`;
  }).join("\n");
}

function saveReport(report) {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const date = new Date().toISOString().split("T")[0];
  fs.writeFileSync(path.join(REPORTS_DIR, `report-${date}.md`), report, "utf-8");
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
// ── Slack Helpers ───────────────────────────────────────────────────────
async function getAllChannels() {
  const channels = [];
  let cursor;
  do {
    const res = await slack.conversations.list({
      types: "public_channel,private_channel",
      exclude_archived: true, limit: 200, cursor,
    });
    channels.push(...(res.channels || []));
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);

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
      channel: channelId, oldest,
      limit: MAX_MESSAGES_PER_CHANNEL, cursor,
    });
    messages.push(...(res.messages || []));
    cursor = res.response_metadata?.next_cursor;
  } while (cursor && messages.length < MAX_MESSAGES_PER_CHANNEL);
  return messages.filter((m) =>
    !m.bot_id && !m.subtype?.includes("join") &&
    !m.subtype?.includes("leave") && !m.subtype?.includes("channel_") && m.text?.trim()
  );
}
async function getUserMap(userIds) {
  const map = {};
  for (const id of [...new Set(userIds)]) {
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

  const transcript = channelData.map((ch) => {
    const msgs = ch.messages
      .sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts))
      .map((m) => {
        const name = userMap[m.user] || m.user || "unknown";
        const date = new Date(parseFloat(m.ts) * 1000).toLocaleDateString();
        return `[${date}] ${name}: ${m.text}`;
      }).join("\n");
    return `\n═══ #${ch.name} ═══\n${msgs}`;
  }).join("\n");

  // Pull MongoDB volume data
  console.log("📊 Pulling seller volume from MongoDB...");
  const volumeData = await getSellerVolumeData();

  // Load past reports
  const pastReports = getPastReports(5);
  const historyContext = pastReports
    ? `\n\nPREVIOUS REPORTS (use to identify persistent issues):\n${pastReports}` : "";
  const volumeContext = volumeData
    ? `\n\nREAL SELLER VOLUME DATA (from MongoDB — use this to correlate complaints with actual revenue impact):\n${volumeData}` : "";

  console.log(`📊 Sending to Claude for analysis...`);

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4000,
    system: `You are an ops analyst for Alpine — a BNPL/fintech platform that provides buy-now-pay-later financing for high-ticket coaching and education sellers. Alpine charges 36% APR on 6-month terms, takes a 15% seller fee, holds a 15% reserve, and the seller absorbs 20% first-loss. Alpine has ~35 active merchants and has originated ~$3.24M across ~1,600 loans.

You have access to THREE data sources:
1. SLACK MESSAGES — raw seller feedback and internal team discussions from the last 3 days
2. MONGODB VOLUME DATA — real transaction counts, dollar amounts, failed payments, and overdue loans per seller, comparing current period vs previous period
3. PREVIOUS REPORTS — past reports so you can track persistent issues

YOUR JOB: Cross-reference all three to produce a hard-hitting report. When a seller complains in Slack, check if their volume actually dropped in the MongoDB data. When you see failed transactions spike for a seller, check if anyone mentioned it in Slack. Match seller names between Slack and MongoDB using fuzzy matching (names won't always be exact).

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
• Which sellers mentioned it + their actual volume data from MongoDB
• How long it's been an issue (reference past reports)
• Real revenue impact using MongoDB numbers (e.g. "Seller X volume dropped 35% from $12K to $7.8K this period")
• Severity: 🔴 Critical / 🟡 Medium / 🟢 Low

*💰 Volume & Revenue Snapshot*
• Total platform volume this period vs previous
• Sellers with biggest volume drops (correlate with complaints)
• Sellers with rising volume (positive signals)
• Overdue BNPL installments and failed transaction spikes

*⚠️ Persistent / Escalating Issues*
• Issues from past reports still unresolved — call these out hard
• Note how many cycles they've been flagged
• If volume keeps dropping alongside complaints, escalate aggressively

*🎯 Recommended Actions*
• Top 3 things to address this cycle
• For each: who should own it (Ethan/CEO, Amine/CTO, Monte/Ops)
• Include specific seller names and dollar amounts when relevant

Be direct and aggressive about unresolved issues. If a seller doing $10K+/month is complaining and their volume is dropping, that's a 🔴. This report goes to the CEO, CTO, and head of ops.`,
    messages: [
      {
        role: "user",
        content: `SLACK MESSAGES (last ${LOOKBACK_DAYS} days, ${channelData.length} channels):\n${transcript}${volumeContext}${historyContext}\n\nGenerate the Alpine seller feedback report.`,
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
  const totalMsgs = channelData.reduce((s, c) => s + c.messages.length, 0);
  const header = `*📋 Alpine Seller Feedback Report — Last ${LOOKBACK_DAYS} Days*\n_${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}_\n_Scanned ${channelData.length} channels, ${totalMsgs} messages${volumeData ? " + MongoDB volume data" : ""}_\n\n`;

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