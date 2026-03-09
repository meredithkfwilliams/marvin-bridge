const MARVIN_BASE = "https://serv.amazingmarvin.com/api";

function unauthorized(res) {
  res.status(401).json({ error: "Unauthorized" });
}

function formatDate(ts) {
  if (!ts) return null;
  return new Date(ts).toISOString().split("T")[0];
}

function buildTaskTree(tasks, categories, parentMap) {
  // Build a map of id -> item
  const itemMap = {};
  for (const c of categories) itemMap[c._id] = { ...c, children: [], tasks: [] };
  for (const t of tasks) itemMap[t._id] = t;

  const roots = [];
  for (const t of tasks) {
    const parent = itemMap[t.parentId];
    if (parent && parent.tasks) {
      parent.tasks.push(t);
    } else {
      roots.push(t);
    }
  }
  return { roots, itemMap };
}

function taskToMarkdown(t, indent = "") {
  const due = t.dueDate ? ` 📅 due ${t.dueDate}` : "";
  const time = t.timeEstimate ? ` ⏱ ${Math.round(t.timeEstimate / 60)}m` : "";
  const star = t.isStarred ? " ⭐" : "";
  const labels = t.labels && t.labels.length ? ` [${t.labels.join(", ")}]` : "";
  return `${indent}- [ ] ${t.title}${star}${due}${time}${labels}`;
}

async function fetchMarvin(endpoint, apiToken) {
  const res = await fetch(`${MARVIN_BASE}${endpoint}`, {
    headers: { "X-API-Token": apiToken },
  });
  if (!res.ok) throw new Error(`Marvin API error: ${res.status} on ${endpoint}`);
  return res.json();
}

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Auth
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

      if (format === "json") {
        return res.status(200).json({ date: targetDate, tasks });
      }

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
      // Fetch categories + unassigned tasks
      const [categories, unassigned] = await Promise.all([
        fetchMarvin("/categories", MARVIN_API_TOKEN),
        fetchMarvin("/children?parentId=unassigned", MARVIN_API_TOKEN),
      ]);

      if (format === "json") return res.status(200).json({ categories, unassigned });

      output = `# All Tasks & Projects — ${today}\n\n`;

      // Top-level categories
      const topCats = categories.filter((c) => c.parentId === "root" || !c.parentId);
      for (const cat of topCats) {
        output += `\n## ${cat.title}\n`;
        try {
          const children = await fetchMarvin(`/children?parentId=${cat._id}`, MARVIN_API_TOKEN);
          const tasks = children.filter((i) => i.db === "Tasks" || (!i.type && i.title));
          const projects = children.filter((i) => i.type === "project");
          for (const t of tasks) output += taskToMarkdown(t) + "\n";
          for (const p of projects) {
            output += `\n### ${p.title}\n`;
            try {
              const ptasks = await fetchMarvin(`/children?parentId=${p._id}`, MARVIN_API_TOKEN);
              for (const t of ptasks.filter((i) => !i.type)) output += taskToMarkdown(t, "  ") + "\n";
            } catch (_) {}
          }
        } catch (_) {}
      }

      if (unassigned.length > 0) {
        output += `\n## Unassigned\n`;
        for (const t of unassigned.filter((i) => !i.type)) output += taskToMarkdown(t) + "\n";
      }

    } else if (view === "categories") {
      const categories = await fetchMarvin("/categories", MARVIN_API_TOKEN);
      if (format === "json") return res.status(200).json({ categories });

      output = `# Categories & Projects — ${today}\n\n`;
      const topCats = categories.filter((c) => c.parentId === "root" || !c.parentId);
      for (const cat of topCats) {
        output += `- **${cat.title}** (id: \`${cat._id}\`)\n`;
        const children = categories.filter((c) => c.parentId === cat._id);
        for (const child of children) output += `  - ${child.title} (id: \`${child._id}\`)\n`;
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
