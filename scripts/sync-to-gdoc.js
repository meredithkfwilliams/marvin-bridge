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

function starLevel(item) { return item.isStarred || 0; }
function isRedOrOrange(item) { return starLevel(item) === 3 || starLevel(item) === 2; }
function isYellow(item) { return starLevel(item) === 1; }
function hasFrog(item) { return !!item.isFrogged; }
function hasScheduled(item) { return item.day && item.day !== "unassigned"; }
function isScheduledTodayOrPast(item, today) { return hasScheduled(item) && item.day <= today; }
function isScheduledFuture(item, today) { return hasScheduled(item) && item.day > today; }

function taskToMarkdown(t, labelMap = {}) {
    const starMap = { 3: " 🔴", 2: " 🟠", 1: " 🟡" };
    const star = starMap[starLevel(t)] || "";
    const frog = hasFrog(t) ? " 🐸" : "";
    const scheduled = hasScheduled(t) ? ` 📆 ${t.day}` : "";
    const due = t.dueDate ? ` 📅 due ${t.dueDate}` : "";
    const time = t.timeEstimate && t.timeEstimate < 99999 ? ` ⏱ ${Math.round(t.timeEstimate / 60)}m` : "";
    const labelNames = (t.labelIds || []).map((id) => labelMap[id] || id).filter(Boolean);
    const labels = labelNames.length ? ` [${labelNames.join(", ")}]` : "";
    const category = t._categoryPath ? ` {${t._categoryPath}}` : "";
    let line = `- [ ] ${t.title}${star}${frog}${scheduled}${due}${time}${labels}${category}`;
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
        if (isTask(item)) allTasks.push({ ...item, _categoryPath: "Unassigned" });
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

    let out = `Last synced: ${new Date().toISOString()}\n\n`;

    // TODAY
    const todayTasks = allTasks.filter((t) => hasFrog(t) || isScheduledTodayOrPast(t, today));
    const actionable = todayTasks.filter(isRedOrOrange);
    const missingStars = todayTasks.filter((t) => !isRedOrOrange(t));
    out += `# Today - ${today}\n\n`;
    if (actionable.length === 0) out += "_No actionable items for today._\n";
    else for (const t of actionable) out += taskToMarkdown(t, labelMap) + "\n";
    if (missingStars.length > 0) {
        out += `\n## ⚠️ Missing Star\n`;
        for (const t of missingStars) out += taskToMarkdown(t, labelMap) + "\n";
    }

    // ON DECK
    const ondeck = allTasks.filter((t) => isRedOrOrange(t) && !hasFrog(t) && !hasScheduled(t));
    out += `\n# On Deck\n\n`;
    if (ondeck.length === 0) out += "_Nothing on deck._\n";
    else for (const t of ondeck) out += taskToMarkdown(t, labelMap) + "\n";

    // UPCOMING
    const upcoming = allTasks
        .filter((t) => isScheduledFuture(t, today))
        .sort((a, b) => a.day.localeCompare(b.day));
    out += `\n# Upcoming\n\n`;
    if (upcoming.length === 0) out += "_Nothing scheduled ahead._\n";
    else for (const t of upcoming) out += taskToMarkdown(t, labelMap) + "\n";

    // JUST FOR ME
    const justforme = allTasks.filter(
        (t) => isYellow(t) && selfId && (t.labelIds || []).includes(selfId)
    );
    out += `\n# Just For Me\n\n`;
    if (!selfId) out += `_⚠️ Could not find "self" label._\n`;
    else if (justforme.length === 0) out += "_Nothing here right now._\n";
    else for (const t of justforme) out += taskToMarkdown(t, labelMap) + "\n";

    // EVERYTHING ELSE
    const everything = allTasks.filter((t) => {
        const inToday = hasFrog(t) || isScheduledTodayOrPast(t, today);
        const inOndeck = isRedOrOrange(t) && !hasFrog(t) && !hasScheduled(t);
        const inUpcoming = isScheduledFuture(t, today);
        const inJustForMe = isYellow(t) && selfId && (t.labelIds || []).includes(selfId);
        return !inToday && !inOndeck && !inUpcoming && !inJustForMe;
    });
    out += `\n# Everything Else\n\n`;
    if (everything.length === 0) out += "_Nothing here._\n";
    else for (const t of everything) out += taskToMarkdown(t, labelMap) + "\n";

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
