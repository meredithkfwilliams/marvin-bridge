const MARVIN_BASE = "https://serv.amazingmarvin.com/api";

function unauthorized(res) {
  res.status(401).json({ error: "Unauthorized" });
}

function taskToMarkdown(t, indent = "") {
  const star = t.isStarred ? " ⭐" : "";

  const frogMap = { 1: " 🐸", 2: " 🐸(baby)", 3: " 🐸(monster)" };
  const frog = t.isFrogged ? (frogMap[t.isFrogged] || " 🐸") : "";

  const priorityMap = { 1: " 🔴p1", 2: " 🟠p2", 3: " 🟡p3" };
  const priority = t.priority ? (priorityMap[t.priority] || "") : "";

  const due = t.dueDate ? ` 📅 due ${t.dueDate}` : "";
  const scheduled = t.day && t.day !== "unassigned" ? ` 📆 scheduled ${t.day}` : "";
  const time = t.timeEstimate && t.timeEstimate < 99999 ? ` ⏱ ${Math.round(t.timeEstimate / 60)}m` : "";
  const labels = t.labels && t.labels.length ? ` [${t.labels.join(", ")}]` : "";

  let line = `${indent}- [ ] ${t.title}${star}${frog}${priority}${due}${scheduled}${time}${labels}`;

  if (t.note && t.note.trim()) {
    // Indent note lines under the task
    const noteLines = t.note.trim().split("\n").map(l => `${indent}  > ${l}`).join("\n");
    line += `\n${noteLines}`;
  }

  return line;
}

async function fetchMarvin(endpoint, apiToken) {
  const res = await fetch(`${MARVIN_BASE}${endpoint}`, {
    headers: { "X-API-Token": apiToken },
  });
  if (!res.ok) throw new Error(`Marvin API error: ${res.status} on ${endpoint}`);
  return res.json();
}

// Recursively fetch and render a node and all its children
async function renderNode(id, title, apiToken, depth = 0) {
  const headingLevel = Math.min(depth + 2, 6);
  const heading = "#".repeat(headingLevel);
  const indent = "  ".repeat(Math.max(depth - 1, 0));
  let output = `\n${heading} ${title}\n`;

  try {
    const children = await fetchMarvin(`/children?parentId=${id}`, apiToken);

    const tasks = children.filter((i) => !i.type || i.type === "task");
    const containers = children.filter((i) => i.type === "project" || i.type === "category");

    for (const t of tasks) {
      output += taskToMarkdown(t, indent) + "\n";
    }

    for (const c of containers) {
      output += await renderNode(c._id, c.title, apiToken, depth + 1);
    }
  } catch (_) {
    // Silently skip nodes we can't fetch
  }

  return output;
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

    if (view === "today") {
      const targetDate = date || today;
      const items = await fetchMarvin(`/todayItems?date=${targetDate}`, MARVIN_API_TOKEN);
      const tasks = items.filter((i) => i.type !== "category");

      if (format === "json") return res.status(200).json({ date: targetDate, tasks });

      output = `# Today's Tasks — ${targetDate}\n\n`;
      if (tasks.length === 0) {
        output += "_No tasks scheduled for today._\n";
      } else {
        for (const t of tasks) output += taskToMarkdown(t) + "\n";
      }

    } else if (view === "overdue") {
      const items = await fetchMarvin("/dueItems", MARVIN_API_TOKEN);
      const overdue = items.filter((i) => i.dueDate && i.dueDate < today);

      if (format === "json") return res.status(200).json({ overdue });

      output = `# Overdue Tasks — as of ${today}\n\n`;
      if (overdue.length === 0) {
        output += "_No overdue tasks. Nice work._\n";
      } else {
        for (const t of overdue) output += taskToMarkdown(t) + "\n";
      }

    } else if (view === "all") {
      const [categories, unassigned] = await Promise.all([
        fetchMarvin("/categories", MARVIN_API_TOKEN),
        fetchMarvin("/children?parentId=unassigned", MARVIN_API_TOKEN),
      ]);

      if (format === "json") return res.status(200).json({ categories, unassigned });

      output = `# All Tasks — ${today}\n`;

      const topCats = categories.filter((c) => c.parentId === "root" || !c.parentId);
      for (const cat of topCats) {
        output += await renderNode(cat._id, cat.title, MARVIN_API_TOKEN, 0);
      }

      const unassignedTasks = unassigned.filter((i) => !i.type || i.type === "task");
      if (unassignedTasks.length > 0) {
        output += `\n## Unassigned\n`;
        for (const t of unassignedTasks) output += taskToMarkdown(t) + "\n";
      }

    } else if (view === "categories") {
      const categories = await fetchMarvin("/categories", MARVIN_API_TOKEN);
      if (format === "json") return res.status(200).json({ categories });

      output = `# Categories & Projects — ${today}\n\n`;
      const topCats = categories.filter((c) => c.parentId === "root" || !c.parentId);
      for (const cat of topCats) {
        output += `- **${cat.title}**\n`;
        const children = categories.filter((c) => c.parentId === cat._id);
        for (const child of children) {
          output += `  - ${child.title}\n`;
          const grandchildren = categories.filter((c) => c.parentId === child._id);
          for (const gc of grandchildren) output += `    - ${gc.title}\n`;
        }
      }

    } else {
      return res.status(400).json({ error: `Unknown view: ${view}. Use: today, overdue, all, categories` });
    }

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(output);

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
