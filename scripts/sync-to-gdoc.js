import { google } from "googleapis";

const MARVIN_BASE = "https://serv.amazingmarvin.com/api";
const DOC_ID = process.env.GOOGLE_DOC_ID;
const MARVIN_API_TOKEN = process.env.MARVIN_API_TOKEN;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchMarvin(endpoint) {
    const res = await fetch(`${MARVIN_BASE}${endpoint}`, {
        headers: { "X-API-Token": MARVIN_API_TOKEN },
    });
    if (!res.ok) throw new Error(`Marvin API error: ${res.status} on ${endpoint}`);
    return res.json();
}

function isContainer(item) {
    return item.type === "project" || item.type === "category";
}

function isTask(item) {
    if (isContainer(item)) return false;
    return !!item.title;
}

// isUrgent: 4 = very urgent, 2 = urgent, missing/0 = none
function urgencyLevel(item) { return item.isUrgent || 0; }
function isVeryUrgent(item) { return urgencyLevel(item) === 4; }
function isUrgent(item) { return urgencyLevel(item) === 2; }
function isAnyUrgent(item) { return urgencyLevel(item) > 0; }

// mentalWeight: 4 = crushing, 2 = weighing on mind, missing/0 = none
function weightLevel(item) { return item.mentalWeight || 0; }
function isCrushing(item) { return weightLevel(item) === 4; }
function isWeighted(item) { return weightLevel(item) > 0; }

// orbit: true = in orbit
function isOrbit(item) { return !!item.orbit; }

function hasScheduled(item) { return item.day && item.day !== "unassigned"; }
function isScheduledTodayOrPast(item, today) { return hasScheduled(item) && item.day <= today; }

function taskToMarkdown(t, labelMap = {}) {
    const urgencyMap = { 4: " 🔴", 2: " 🟠" };
    const urgency = urgencyMap[urgencyLevel(t)] || "";

    const weightMap = { 4: " ⚫", 2: " 🔘" };
    const weight = weightMap[weightLevel(t)] || "";

    const orbit = isOrbit(t) ? " 🔵" : "";
    const scheduled = hasScheduled(t) ? ` 📆 ${t.day}` : "";
    const due = t.dueDate ? ` 📅 due ${t.dueDate}` : "";
    const time = t.timeEstimate && t.timeEstimate < 99999 ? ` ⏱ ${Math.round(t.timeEstimate / 60)}m` : "";

    const labelNames = (t.labelIds || []).map((id) => labelMap[id] || id).filter(Boolean);
    const labels = labelNames.length ? ` [${labelNames.join(", ")}]` : "";
    const category = t._categoryPath ? ` {${t._categoryPath}}` : "";

    let line = `- [ ] ${t.title}${urgency}${weight}${orbit}${scheduled}${due}${time}${labels}${category}`;

    if (t.note && t.note.trim() && t.note.trim() !== "\\") {
        const noteLines = t.note.trim().split("\n").map((l) => `  > ${l}`).join("\n");
        line += `\n${noteLines}`;
    }
    return line;
}

async function fetchAllTasksFlat() {
    const categories = await fetchMarvin("/categories");
    const allTasks = [];

    async function collectChildren(parentId, categoryPath) {
        let children;
        try {
            children = await fetchMarvin(`/children?parentId=${parentId}`);
            await sleep(200);
        } catch (err) {
            console.warn(`Skipping ${parentId} (${categoryPath}): ${err.message}`);
            return;
        }
        for (const item of children) {
            if (isTask(item)) {
                allTasks.push({ ...item, _categoryPath: categoryPath });
            } else if (isContainer(item)) {
                const childPath = categoryPath ? `${categoryPath} > ${item.title}` : item.title;
                await collectChildren(item._id, childPath);
            }
        }
    }

    const topCats = categories.filter((c) => c.parentId === "root" || !c.parentId);
    for (const cat of topCats) {
        await collectChildren(cat._id, cat.title);
    }

    const unassigned = await fetchMarvin("/children?parentId=unassigned");
    for (const item of unassigned) {
        if (isTask(item)) allTasks.push({ ...item, _categoryPath: "Inbox" });
    }

    return allTasks;
}

async function buildContent() {
    const today = new Date().toISOString().split("T")[0];
    const [allTasks, rawLabels] = await Promise.all([
        fetchAllTasksFlat(),
        fetchMarvin("/labels"),
    ]);
    const labelMap = Object.fromEntries(rawLabels.map((l) => [l._id, l.title]));
    const selfLabel = rawLabels.find((l) => l.title.toLowerCase() === "self");
    const selfId = selfLabel ? selfLabel._id : null;
    function hasSelfLabel(t) { return selfId && (t.labelIds || []).includes(selfId); }

    let out = `Last synced: ${new Date().toISOString()}\n\n`;

    // ── NOW ───────────────────────────────────────────────────────────────────
    // Very urgent OR scheduled today/overdue
    const now = allTasks.filter((t) =>
        isVeryUrgent(t) || isScheduledTodayOrPast(t, today)
    );
    const nowIds = new Set(now.map((t) => t._id));
    out += `# Now\n\n`;
    out += `_Very urgent or scheduled today/overdue._\n\n`;
    if (now.length === 0) out += `_Nothing here._\n`;
    else for (const t of now) out += taskToMarkdown(t, labelMap) + "\n";

    // ── NEXT ──────────────────────────────────────────────────────────────────
    // Urgent OR crushing weight — not in Now
    const next = allTasks.filter((t) =>
        !nowIds.has(t._id) &&
        (isUrgent(t) || isCrushing(t))
    );
    const nextIds = new Set(next.map((t) => t._id));
    out += `\n# Next\n\n`;
    out += `_Urgent or crushing weight — must happen soon._\n\n`;
    if (next.length === 0) out += `_Nothing here._\n`;
    else for (const t of next) out += taskToMarkdown(t, labelMap) + "\n";

    // ── ON DECK ───────────────────────────────────────────────────────────────
    // Weight (not crushing), no urgency — not in Now or Next
    const onDeck = allTasks.filter((t) =>
        !nowIds.has(t._id) &&
        !nextIds.has(t._id) &&
        isWeighted(t) &&
        !isCrushing(t) &&
        !isAnyUrgent(t)
    );
    const onDeckIds = new Set(onDeck.map((t) => t._id));
    out += `\n# On Deck\n\n`;
    out += `_Weighing on your mind — no urgency._\n\n`;
    if (onDeck.length === 0) out += `_Nothing here._\n`;
    else for (const t of onDeck) out += taskToMarkdown(t, labelMap) + "\n";

    // ── WANTS ─────────────────────────────────────────────────────────────────
    // Orbit + self label — things you want to do for yourself right now
    const wants = allTasks.filter((t) =>
        !nowIds.has(t._id) &&
        !nextIds.has(t._id) &&
        !onDeckIds.has(t._id) &&
        isOrbit(t) &&
        hasSelfLabel(t)
    );
    const wantsIds = new Set(wants.map((t) => t._id));
    out += `\n# Wants\n\n`;
    out += `_Orbit + self — things you want to do for yourself right now._\n\n`;
    if (wants.length === 0) out += `_Nothing here._\n`;
    else for (const t of wants) out += taskToMarkdown(t, labelMap) + "\n";

    // ── IN VIEW ───────────────────────────────────────────────────────────────
    // Orbit, no self label, no weight, no urgency — not already surfaced above
    const inView = allTasks.filter((t) =>
        !nowIds.has(t._id) &&
        !nextIds.has(t._id) &&
        !onDeckIds.has(t._id) &&
        !wantsIds.has(t._id) &&
        isOrbit(t) &&
        !hasSelfLabel(t) &&
        !isWeighted(t) &&
        !isAnyUrgent(t)
    );
    const inViewIds = new Set(inView.map((t) => t._id));
    out += `\n# In View\n\n`;
    out += `_In orbit, no pressure — consciously surfaced but not self-directed._\n\n`;
    if (inView.length === 0) out += `_Nothing here._\n`;
    else for (const t of inView) out += taskToMarkdown(t, labelMap) + "\n";

    // ── BACKBURNER ────────────────────────────────────────────────────────────
    // No signals at all
    const backburner = allTasks.filter((t) =>
        !nowIds.has(t._id) &&
        !nextIds.has(t._id) &&
        !onDeckIds.has(t._id) &&
        !wantsIds.has(t._id) &&
        !inViewIds.has(t._id)
    );
    out += `\n# Backburner\n\n`;
    out += `_No signals — not thinking about this yet._\n\n`;
    if (backburner.length === 0) out += `_Nothing here._\n`;
    else for (const t of backburner) out += taskToMarkdown(t, labelMap) + "\n";

    return out;
}

async function writeToDoc(content) {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ["https://www.googleapis.com/auth/documents"],
    });
    const docs = google.docs({ version: "v1", auth });

    const doc = await docs.documents.get({ documentId: DOC_ID });
    const docLength = doc.data.body.content.reduce((acc, el) => {
        if (el.endIndex) return Math.max(acc, el.endIndex);
        return acc;
    }, 1);

    const requests = [];
    if (docLength > 2) {
        requests.push({
            deleteContentRange: {
                range: { startIndex: 1, endIndex: docLength - 1 },
            },
        });
    }
    requests.push({
        insertText: { location: { index: 1 }, text: content },
    });

    await docs.documents.batchUpdate({
        documentId: DOC_ID,
        requestBody: { requests },
    });

    console.log(`✅ Doc updated at ${new Date().toISOString()}`);
}

const content = await buildContent();
await writeToDoc(content);
