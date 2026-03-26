import { google } from "googleapis";

const MARVIN_BASE = "https://serv.amazingmarvin.com/api";

function unauthorized(res) {
    res.status(401).json({ error: "Unauthorized" });
}

function isContainer(item) {
    return item.type === "project" || item.type === "category";
}

function isTask(item) {
    if (isContainer(item)) return false;
    return !!item.title;
}

// isStarred values: 3=red(p1), 2=orange(p2), 1=yellow(p3), 0/missing=none
function starLevel(item) {
    return item.isStarred || 0;
}

function isRedOrOrange(item) {
    return starLevel(item) === 3 || starLevel(item) === 2;
}

function isYellow(item) {
    return starLevel(item) === 1;
}

function hasFrog(item) {
    return !!item.isFrogged;
}

function hasScheduled(item) {
    return item.day && item.day !== "unassigned";
}

function isScheduledTodayOrPast(item, today) {
    return hasScheduled(item) && item.day <= today;
}

function isScheduledFuture(item, today) {
    return hasScheduled(item) && item.day > today;
}

function taskToMarkdown(t, labelMap = {}, indent = "") {
    const starMap = { 3: " 🔴", 2: " 🟠", 1: " 🟡" };
    const star = starMap[starLevel(t)] || "";
    const frog = hasFrog(t) ? " 🐸" : "";
    const scheduled = hasScheduled(t) ? ` 📆 ${t.day}` : "";
    const due = t.dueDate ? ` 📅 due ${t.dueDate}` : "";
    const time = t.timeEstimate && t.timeEstimate < 99999 ? ` ⏱ ${Math.round(t.timeEstimate / 60)}m` : "";

    const labelNames = (t.labelIds || [])
        .map((id) => labelMap[id] || id)
        .filter(Boolean);
    const labels = labelNames.length ? ` [${labelNames.join(", ")}]` : "";

    // Include category path if available
    const category = t._categoryPath ? ` {${t._categoryPath}}` : "";

    let line = `${indent}- [ ] ${t.title}${star}${frog}${scheduled}${due}${time}${labels}${category}`;

    if (t.note && t.note.trim() && t.note.trim() !== "\\") {
        const noteLines = t.note.trim().split("\n").map((l) => `${indent}  > ${l}`).join("\n");
        line += `\n${noteLines}`;
    }

    return line;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchMarvin(endpoint, apiToken) {
    const res = await fetch(`${MARVIN_BASE}${endpoint}`, {
        headers: { "X-API-Token": apiToken },
    });
    if (!res.ok) throw new Error(`Marvin API error: ${res.status} on ${endpoint}`);
    return res.json();
}

// Build a flat list of all tasks across the entire tree, with category path attached
async function fetchAllTasksFlat(apiToken) {
    const categories = await fetchMarvin("/categories", apiToken);
    const catMap = {};
    for (const c of categories) catMap[c._id] = c;

    const allTasks = [];

    async function collectChildren(parentId, categoryPath) {
        const children = await fetchMarvin(`/children?parentId=${parentId}`, apiToken);
        await sleep(200);
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

    // Also grab unassigned
    const unassigned = await fetchMarvin("/children?parentId=unassigned", apiToken);
    for (const item of unassigned) {
        if (isTask(item)) allTasks.push({ ...item, _categoryPath: "Unassigned" });
    }

    return allTasks;
}

// Recursively fetch and render a node and all its children (used for view=all and view=category)
async function renderNode(id, title, apiToken, labelMap = {}, depth = 0) {
    const headingLevel = Math.min(depth + 2, 6);
    const heading = "#".repeat(headingLevel);
    const indent = "  ".repeat(Math.max(depth - 1, 0));
    let output = `\n${heading} ${title}\n`;

    try {
        const children = await fetchMarvin(`/children?parentId=${id}`, apiToken);
        const tasks = children.filter(isTask);
        const containers = children.filter(isContainer);

        for (const t of tasks) {
            output += taskToMarkdown(t, labelMap, indent) + "\n";
        }
        for (const c of containers) {
            output += await renderNode(c._id, c.title, apiToken, labelMap, depth + 1);
        }
        if (tasks.length === 0 && containers.length === 0) {
            output += `${indent}_empty_\n`;
        }
    } catch (err) {
        output += `${indent}_error fetching: ${err.message}_\n`;
    }

    return output;
}

async function writeToDoc(content) {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ["https://www.googleapis.com/auth/documents"],
    });
    const docs = google.docs({ version: "v1", auth });
    const DOC_ID = process.env.GOOGLE_DOC_ID;

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
}

// Shared logic for building the full cached content string
async function buildCacheContent(MARVIN_API_TOKEN) {
    const today = new Date().toISOString().split("T")[0];
    const [allTasks, rawLabels] = await Promise.all([
        fetchAllTasksFlat(MARVIN_API_TOKEN),
        fetchMarvin("/labels", MARVIN_API_TOKEN),
    ]);
    const labelMap = Object.fromEntries(rawLabels.map((l) => [l._id, l.title]));
    const selfLabel = rawLabels.find((l) => l.title.toLowerCase() === "self");
    const selfId = selfLabel ? selfLabel._id : null;

    let content = `Last synced: ${new Date().toISOString()}\n\n`;

    // TODAY
    const todayTasks = allTasks.filter((t) => hasFrog(t) || isScheduledTodayOrPast(t, today));
    const actionable = todayTasks.filter(isRedOrOrange);
    const missingStars = todayTasks.filter((t) => !isRedOrOrange(t));
    content += `# Today - ${today}\n\n`;
    if (actionable.length === 0) {
        content += "_No actionable items for today._\n";
    } else {
        for (const t of actionable) content += taskToMarkdown(t, labelMap) + "\n";
    }
    if (missingStars.length > 0) {
        content += `\n## ⚠️ Missing Star\n`;
        for (const t of missingStars) content += taskToMarkdown(t, labelMap) + "\n";
    }

    // ON DECK
    const ondeck = allTasks.filter((t) => isRedOrOrange(t) && !hasFrog(t) && !hasScheduled(t));
    content += `\n# On Deck\n\n`;
    if (ondeck.length === 0) {
        content += "_Nothing on deck._\n";
    } else {
        for (const t of ondeck) content += taskToMarkdown(t, labelMap) + "\n";
    }

    // UPCOMING
    const upcoming = allTasks
        .filter((t) => isScheduledFuture(t, today))
        .sort((a, b) => a.day.localeCompare(b.day));
    content += `\n# Upcoming\n\n`;
    if (upcoming.length === 0) {
        content += "_Nothing scheduled ahead._\n";
    } else {
        for (const t of upcoming) content += taskToMarkdown(t, labelMap) + "\n";
    }

    // JUST FOR ME
    const justforme = allTasks.filter(
        (t) => isYellow(t) && selfId && (t.labelIds || []).includes(selfId)
    );
    content += `\n# Just For Me\n\n`;
    if (!selfId) {
        content += `_⚠️ Could not find "self" label._\n`;
    } else if (justforme.length === 0) {
        content += "_Nothing here right now._\n";
    } else {
        for (const t of justforme) content += taskToMarkdown(t, labelMap) + "\n";
    }

    // EVERYTHING ELSE
    const everything = allTasks.filter((t) => {
        const inToday = hasFrog(t) || isScheduledTodayOrPast(t, today);
        const inOndeck = isRedOrOrange(t) && !hasFrog(t) && !hasScheduled(t);
        const inUpcoming = isScheduledFuture(t, today);
        const inJustForMe = isYellow(t) && selfId && (t.labelIds || []).includes(selfId);
        return !inToday && !inOndeck && !inUpcoming && !inJustForMe;
    });
    content += `\n# Everything Else\n\n`;
    if (everything.length === 0) {
        content += "_Nothing here._\n";
    } else {
        for (const t of everything) content += taskToMarkdown(t, labelMap) + "\n";
    }

    return content;
}

export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(200).end();

    const { token, view = "today", format = "markdown", date } = req.query;
    const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
    const MARVIN_API_TOKEN = process.env.MARVIN_API_TOKEN;

    if (!token || token !== ACCESS_TOKEN) return unauthorized(res);
    if (!MARVIN_API_TOKEN) return res.status(500).json({ error: "Marvin API token not configured" });

    try {
        let output = "";
        const today = new Date().toISOString().split("T")[0];

        // ── LABELS ──────────────────────────────────────────────────────────────
        if (view === "labels") {
            const labels = await fetchMarvin("/labels", MARVIN_API_TOKEN);
            if (format === "json") return res.status(200).json({ labels });

            output = `# Labels - ${today}\n\n`;
            for (const l of labels) {
                output += `- **${l.title}** [id:${l._id}]\n`;
            }

        // ── TODAY ────────────────────────────────────────────────────────────────
        // Logic: (frog OR scheduled <= today) AND red/orange star
        // Missing star = flag as error
        } else if (view === "today") {
            const [allTasks, rawLabels] = await Promise.all([
                fetchAllTasksFlat(MARVIN_API_TOKEN),
                fetchMarvin("/labels", MARVIN_API_TOKEN),
            ]);
            const labelMap = Object.fromEntries(rawLabels.map((l) => [l._id, l.title]));

            const todayTasks = allTasks.filter(
                (t) => hasFrog(t) || isScheduledTodayOrPast(t, today)
            );

            const actionable = todayTasks.filter(isRedOrOrange);
            const missingStars = todayTasks.filter((t) => !isRedOrOrange(t));

            if (format === "json") return res.status(200).json({ today, actionable, missingStars });

            output = `# Today - ${today}\n\n`;
            if (actionable.length === 0) {
                output += "_No actionable items for today._\n";
            } else {
                for (const t of actionable) output += taskToMarkdown(t, labelMap) + "\n";
            }

            if (missingStars.length > 0) {
                output += `\n## ⚠️ Missing Star (frog/scheduled but no red/orange star — needs triage)\n`;
                for (const t of missingStars) output += taskToMarkdown(t, labelMap) + "\n";
            }

        // ── ON DECK ──────────────────────────────────────────────────────────────
        // Logic: red/orange star, no frog, no scheduled date
        } else if (view === "ondeck") {
            const [allTasks, rawLabels] = await Promise.all([
                fetchAllTasksFlat(MARVIN_API_TOKEN),
                fetchMarvin("/labels", MARVIN_API_TOKEN),
            ]);
            const labelMap = Object.fromEntries(rawLabels.map((l) => [l._id, l.title]));

            const tasks = allTasks.filter(
                (t) => isRedOrOrange(t) && !hasFrog(t) && !hasScheduled(t)
            );

            if (format === "json") return res.status(200).json({ tasks });

            output = `# On Deck - ${today}\n\n`;
            if (tasks.length === 0) {
                output += "_Nothing on deck._\n";
            } else {
                for (const t of tasks) output += taskToMarkdown(t, labelMap) + "\n";
            }

        // ── UPCOMING ─────────────────────────────────────────────────────────────
        // Logic: scheduled date > today, any star
        } else if (view === "upcoming") {
            const [allTasks, rawLabels] = await Promise.all([
                fetchAllTasksFlat(MARVIN_API_TOKEN),
                fetchMarvin("/labels", MARVIN_API_TOKEN),
            ]);
            const labelMap = Object.fromEntries(rawLabels.map((l) => [l._id, l.title]));

            const tasks = allTasks
                .filter((t) => isScheduledFuture(t, today))
                .sort((a, b) => a.day.localeCompare(b.day));

            if (format === "json") return res.status(200).json({ tasks });

            output = `# Upcoming - ${today}\n\n`;
            if (tasks.length === 0) {
                output += "_Nothing scheduled ahead._\n";
            } else {
                for (const t of tasks) output += taskToMarkdown(t, labelMap) + "\n";
            }

        // ── JUST FOR ME ──────────────────────────────────────────────────────────
        // Logic: yellow star + "self" label
        } else if (view === "justforme") {
            const [allTasks, rawLabels] = await Promise.all([
                fetchAllTasksFlat(MARVIN_API_TOKEN),
                fetchMarvin("/labels", MARVIN_API_TOKEN),
            ]);
            const labelMap = Object.fromEntries(rawLabels.map((l) => [l._id, l.title]));

            // Find the "self" label ID
            const selfLabel = rawLabels.find((l) => l.title.toLowerCase() === "self");
            const selfId = selfLabel ? selfLabel._id : null;

            const tasks = allTasks.filter(
                (t) =>
                    isYellow(t) &&
                    selfId &&
                    (t.labelIds || []).includes(selfId)
            );

            if (format === "json") return res.status(200).json({ selfLabelId: selfId, tasks });

            output = `# Just For Me - ${today}\n\n`;
            if (!selfId) {
                output += `_⚠️ Could not find a label named "self" — check label name in Marvin._\n`;
            } else if (tasks.length === 0) {
                output += "_Nothing here right now._\n";
            } else {
                for (const t of tasks) output += taskToMarkdown(t, labelMap) + "\n";
            }

        // ── EVERYTHING ELSE ──────────────────────────────────────────────────────
        // Logic: tasks that don't appear in today, ondeck, upcoming, or justforme
        } else if (view === "everything") {
            const [allTasks, rawLabels] = await Promise.all([
                fetchAllTasksFlat(MARVIN_API_TOKEN),
                fetchMarvin("/labels", MARVIN_API_TOKEN),
            ]);
            const labelMap = Object.fromEntries(rawLabels.map((l) => [l._id, l.title]));
            const selfLabel = rawLabels.find((l) => l.title.toLowerCase() === "self");
            const selfId = selfLabel ? selfLabel._id : null;

            const tasks = allTasks.filter((t) => {
                const inToday = hasFrog(t) || isScheduledTodayOrPast(t, today);
                const inOndeck = isRedOrOrange(t) && !hasFrog(t) && !hasScheduled(t);
                const inUpcoming = isScheduledFuture(t, today);
                const inJustForMe = isYellow(t) && selfId && (t.labelIds || []).includes(selfId);
                return !inToday && !inOndeck && !inUpcoming && !inJustForMe;
            });

            if (format === "json") return res.status(200).json({ tasks });

            output = `# Everything Else - ${today}\n\n`;
            if (tasks.length === 0) {
                output += "_Nothing here._\n";
            } else {
                for (const t of tasks) output += taskToMarkdown(t, labelMap) + "\n";
            }

        // ── ALL ───────────────────────────────────────────────────────────────────
        } else if (view === "all") {
            const [categories, rawLabels, unassigned] = await Promise.all([
                fetchMarvin("/categories", MARVIN_API_TOKEN),
                fetchMarvin("/labels", MARVIN_API_TOKEN),
                fetchMarvin("/children?parentId=unassigned", MARVIN_API_TOKEN),
            ]);
            const labelMap = Object.fromEntries(rawLabels.map((l) => [l._id, l.title]));

            if (format === "json") return res.status(200).json({ categories, unassigned });

            output = `# All Tasks - ${today}\n`;
            const topCats = categories.filter((c) => c.parentId === "root" || !c.parentId);
            for (const cat of topCats) {
                output += await renderNode(cat._id, cat.title, MARVIN_API_TOKEN, labelMap, 0);
            }
            const unassignedTasks = unassigned.filter(isTask);
            if (unassignedTasks.length > 0) {
                output += `\n## Unassigned\n`;
                for (const t of unassignedTasks) output += taskToMarkdown(t, labelMap) + "\n";
            }

        // ── CATEGORIES ────────────────────────────────────────────────────────────
        } else if (view === "categories") {
            const categories = await fetchMarvin("/categories", MARVIN_API_TOKEN);
            if (format === "json") return res.status(200).json({ categories });

            output = `# Categories & Projects - ${today}\n\n`;
            const topCats = categories.filter((c) => c.parentId === "root" || !c.parentId);
            for (const cat of topCats) {
                output += `- **${cat.title}** [id:${cat._id}]\n`;
                const children = categories.filter((c) => c.parentId === cat._id);
                for (const child of children) {
                    output += `  - ${child.title} [id:${child._id}]\n`;
                    const grandchildren = categories.filter((c) => c.parentId === child._id);
                    for (const gc of grandchildren) output += `    - ${gc.title} [id:${gc._id}]\n`;
                }
            }

        // ── CATEGORY (single) ────────────────────────────────────────────────────
        } else if (view === "category") {
            const catId = req.query.id;
            if (!catId) return res.status(400).json({ error: "Missing id parameter. Use ?view=category&id=CATEGORY_ID" });

            const [categories, rawLabels] = await Promise.all([
                fetchMarvin("/categories", MARVIN_API_TOKEN),
                fetchMarvin("/labels", MARVIN_API_TOKEN),
            ]);
            const labelMap = Object.fromEntries(rawLabels.map((l) => [l._id, l.title]));
            const cat = categories.find((c) => c._id === catId);
            const catTitle = cat ? cat.title : catId;

            output = `# ${catTitle} - ${today}\n`;
            output += await renderNode(catId, catTitle, MARVIN_API_TOKEN, labelMap, 0);
            output = output.replace(`# ${catTitle} - ${today}\n\n## ${catTitle}\n`, `# ${catTitle} - ${today}\n`);

        // ── DEBUG ─────────────────────────────────────────────────────────────────
        } else if (view === "debug") {
            const parentId = req.query.parentId || "root";
            const children = await fetchMarvin(`/children?parentId=${parentId}`, MARVIN_API_TOKEN);
            res.setHeader("Content-Type", "application/json");
            return res.status(200).json({ parentId, count: children.length, children });

        // ── REFRESH ───────────────────────────────────────────────────────────────
        } else if (view === "refresh") {
            const content = await buildCacheContent(MARVIN_API_TOKEN);
            await writeToDoc(content);
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            return res.status(200).send(`✅ Refreshed at ${new Date().toISOString()}`);

        // ── UNKNOWN ───────────────────────────────────────────────────────────────
        } else {
            return res.status(400).json({
                error: `Unknown view: ${view}. Use: today, ondeck, upcoming, justforme, everything, all, categories, category, labels, debug, refresh`,
            });
        }

        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        return res.status(200).send(output);

    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: err.message });
    }
}
