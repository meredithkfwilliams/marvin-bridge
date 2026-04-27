# marvin-bridge

A lightweight Vercel middleman that syncs your Amazing Marvin tasks to a Google Doc every 30 minutes, making them available to Claude (or any AI) via Google Drive.

---

## How It Works

1. A GitHub Action runs every 30 minutes (or on demand) and fetches all tasks from the Marvin API
2. Tasks are organized into seven priority buckets and written to a Google Doc
3. Claude reads the Google Doc via the Google Drive connector during planning sessions
4. Claude can also trigger a manual refresh via the `/api/tasks?view=refresh` endpoint

---

## Architecture

```
Amazing Marvin API
       ↓
GitHub Action (every 30 min)
       ↓
scripts/sync-to-gdoc.js
       ↓
Google Doc (task cache)
       ↓
Claude (reads via Google Drive connector)
```

---

## Setup

### 1. Get your Marvin API token
Go to [https://app.amazingmarvin.com/pre?api](https://app.amazingmarvin.com/pre?api) and copy your **API Token**.

### 2. Set up Google Docs sync

1. Create a Google Cloud service account and download the JSON key
2. Create a Google Doc and share it with the service account email (Editor access)
3. Note the Doc ID from the URL: `https://docs.google.com/document/d/DOC_ID_HERE/edit`

### 3. Deploy to Vercel

1. Push this repo to GitHub
2. Go to [vercel.com](https://vercel.com) → New Project → Import this repo
3. Add these **Environment Variables** in Vercel's project settings:

| Variable | Value |
|---|---|
| `MARVIN_API_TOKEN` | Your Marvin API token |
| `ACCESS_TOKEN` | A secret string you make up (e.g. `mysecret42`) |
| `GITHUB_TOKEN` | A GitHub classic PAT with `repo` scope (for triggering syncs) |

4. Hit Deploy

### 4. Set up GitHub Secrets

In your GitHub repo settings, add these secrets:

| Secret | Value |
|---|---|
| `MARVIN_API_TOKEN` | Your Marvin API token |
| `ACCESS_TOKEN` | Same secret string as Vercel |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Full contents of your service account JSON key |
| `GOOGLE_DOC_ID` | The ID of your Google Doc |

---

## The Seven Buckets

Tasks are automatically sorted into seven priority buckets based on signals set in Marvin:

| Bucket | Logic | What it means |
|---|---|---|
| **Now** | On fire OR scheduled today/past | Must happen today |
| **Next** | Extremely urgent OR overwhelming weight — not on fire, not scheduled today/past | Must happen soon |
| **Upcoming** | Future scheduled date — all tasks regardless of other signals | Parked until that day |
| **On Deck** | Heavy weight, no urgency, no date, not in Wants | Weighing on mind, no fire |
| **Wants** | Orbit + self label | Things you want to do for yourself |
| **In View** | Orbit, no self label, no urgency, no weight, no date | Consciously surfaced, no pressure |
| **Backburner** | No signals | Not thinking about it yet |

### Signal Reference

| Signal | Marvin property | Values |
|---|---|---|
| 🔥 On fire | `isUrgent` | API value: 4 |
| 🟠 Extremely urgent | `isUrgent` | API value: 2 |
| ⚫ Overwhelming weight | `mentalWeight` | API value: 4 |
| 🔘 Heavy weight | `mentalWeight` | API value: 2 |
| 🔵 Orbit | `orbit` | true |
| 📆 Scheduled | `day` | YYYY-MM-DD |

---

## Endpoints

| URL | What you get |
|---|---|
| `/api/tasks?token=YOUR_TOKEN&view=refresh` | Triggers a manual sync to Google Doc (updates in ~30-60 seconds) |
| `/api/tasks?token=YOUR_TOKEN&view=categories` | Your full category/project structure with IDs |
| `/api/tasks?token=YOUR_TOKEN&view=debug&parentId=ID` | Raw JSON for a specific category — useful for debugging |
| `/api/tasks?token=YOUR_TOKEN&view=labels` | All your Marvin labels with IDs |

---

## Using with Claude

This system is designed to work with Claude via the Google Drive connector in a Claude Project.

1. Connect Google Drive in your Claude Project
2. Add the planning assistant system prompt to your Project instructions
3. Claude will automatically read the Google Doc when you ask for help planning your day

To trigger a manual refresh (e.g. after making changes in Marvin):
```
https://your-project.vercel.app/api/tasks?token=YOUR_TOKEN&view=refresh
```

Or just tell Claude — it knows to trigger a refresh if you say your data feels stale.

---

## Security

- Your Marvin API token lives in Vercel's encrypted environment variables and GitHub Secrets, never in code
- The `ACCESS_TOKEN` prevents unauthorized access to your endpoints
- The Google service account JSON is stored only in GitHub Secrets
- Only read operations are performed against Marvin — nothing writes back
