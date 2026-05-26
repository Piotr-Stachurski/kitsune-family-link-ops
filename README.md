# 🦊 Kitsune — Family Link Ops

**AI-powered screen time analytics for Google Family Link.**

Google Family Link doesn't export data or provide usage statistics. This tool bridges that gap — you take screenshots of the daily screen time view, compile them into a PDF, upload it, and Gemini AI extracts structured data automatically. The result is a full analytics dashboard with behavioral insights, trend analysis, and multi-child support.

Built on zero-cost, zero-infrastructure Google Workspace stack: **Apps Script + Gemini API + Google Sheets + Drive**.

---

## 📸 Screenshots

### Desktop
![Kitsune Dashboard Desktop](screenshots/desktop.png)

### Mobile
![Kitsune Dashboard Mobile](screenshots/mobile-kpi.png)
![Kitsune Dashboard Mobile — Tooltip & Behavioral Analysis](screenshots/mobile-behavioral.png)

---

## ✨ Features

- **AI PDF extraction** — Gemini multimodal API reads screenshots of Family Link reports and extracts structured time data per app, per day
- **Automatic categorization** — Gemini classifies each app (Entertainment / Social / Education / Other) at extraction time, no manual configuration
- **Multi-child support** — tab-based switching between profiles, all data in one Sheets SSoT
- **Time filters** — Last 7/30 days, current month/quarter/year, or any specific month from your data
- **Behavioral analysis** — Functional breakdown (ROI bar), Weekend Anomaly detection (weekday vs weekend delta)
- **Timeline log** — day-by-day bar chart with per-app tooltip; auto-aggregates to monthly view for larger datasets
- **Admin / Viewer roles** — shareable read-only link via URL parameter (`?role=viewer`), upload and share controls hidden automatically
- **Bilingual UI** — Polish / English toggle, all labels translated
- **Fully mobile-responsive** — tested on Android Chrome

---

## 🏗️ Architecture

```
[You]
  └─ Screenshots of Family Link daily view
       └─ Compiled into PDF (Imię_YYYY-MM.pdf)
            └─ Uploaded via FAB button (+ in corner)
                 └─ Saved to Google Drive / Dropzone folder
                      └─ processDropzone() [GAS time trigger]
                           └─ extractDataWithGemini()
                                └─ Gemini multimodal API
                                     └─ Structured JSON: { date, apps: { name: { min, category } } }
                                          └─ upsertToSheet() → Google Sheets SSoT
                                               └─ getTelemetryData() → Frontend SPA
                                                    └─ Dashboard renders
```

**Stack:**
- `Code.gs` — Google Apps Script backend (data pipeline, Gemini API calls, Drive/Sheets operations)
- `Index.html` — Single-page frontend served by GAS HtmlService (Tailwind CSS, Chart.js)
- Google Sheets — SSoT for all extracted telemetry data
- Google Drive — Dropzone (incoming PDFs) and Archive (processed PDFs)
- Gemini API — multimodal PDF parsing and app categorization

**No servers. No databases. No subscriptions. No recurring cost beyond Gemini API usage (free tier covers typical family use).**

---

## 🚀 Setup

### Prerequisites
- Google account (same account used for Family Link)
- Gemini API key — free at [aistudio.google.com/apikey](https://aistudio.google.com/apikey)

### Steps

**1. Create the Apps Script project**

Go to [script.google.com](https://script.google.com) → **New project**

In the editor:
- Rename `Code.gs` → paste the contents of `Code.gs` from this repo
- Click **"+"** next to Files → **HTML** → name it `Index` → paste contents of `Index.html`

**2. Deploy as Web App**

Click **Deploy** → **New deployment**
- Type: **Web App**
- Execute as: **Me**
- Who has access: **Anyone** (required for the viewer link to work)

Copy the deployment URL.

**3. First run — Setup screen**

Open the deployment URL. You'll see the Setup screen asking for your Gemini API key.

Paste your key (format: `AIzaSy...`, 35+ characters) → click **Wdróż Ekosystem**.

The script will automatically create:
- `Kitsune_Link_Ops_System/` folder in your Google Drive
- `Dropzone/` subfolder (incoming PDFs)
- `Archiwum/` subfolder (processed PDFs)
- Headers in the active Sheets tab

**4. Set up the processing trigger**

In the GAS editor: **Triggers** (clock icon in left menu) → **+ Add Trigger**

| Setting | Value |
|---|---|
| Function | `processDropzone` |
| Event source | `Time-driven` |
| Type | `Minutes timer` |
| Interval | `Every 5 minutes` |

> **Note:** Alternatively, the app uses a one-shot `ScriptApp.newTrigger` that fires ~10 seconds after each upload, so you don't have to wait for the 5-minute cycle. The standing trigger is a fallback for files dropped directly into the Drive folder.

**5. Upload your first PDF**

Family Link doesn't export data — you need to capture it manually:
1. Open Google Family Link app → tap your child's name → **App activity**
2. Screenshot each day's screen time breakdown
3. Compile screenshots into a single PDF document
4. Name the file: `ChildName_YYYY-MM.pdf` (e.g. `Zuzia_2024-03.pdf`)
5. Tap the **+** button in the dashboard → select your PDF

Data appears in the dashboard within ~30–60 seconds.

---

## 📁 File naming convention

```
ChildName_Period.pdf

Examples:
  Zuzia_2024-03.pdf
  Kacper_2024-Q1.pdf
  Anna_2025-01-15.pdf
```

The child's name is extracted from the filename (first word before `_` or space) and used as the profile identifier in the dashboard. Multiple children = multiple files = multiple tabs.

---

## 🗂️ Sheets data structure

| Column | Field | Format |
|---|---|---|
| A | Child name | `String` |
| B | Date | `YYYY-MM-DD` |
| C | Total minutes | `Integer` |
| D | Apps payload | `JSON: { "AppName": { "min": 120, "category": "entertainment" } }` |

---

## ⚠️ Known limitations

- **Manual data capture** — Family Link has no export API. Screenshots must be taken manually per day.
- **Screenshot quality** — Gemini extraction accuracy depends on screenshot clarity. Blurry or cropped screenshots may cause missing data for that day.
- **GAS execution limit** — 6 minutes per execution. Very large PDFs (50+ days in one file) may hit the limit. Recommended: one PDF per month.
- **Screen ratio metric** — "Screen vs Awake" is calculated against a fixed 16h/day denominator. It's a relative indicator, not a precise measurement.

---

## 🔐 Privacy

All data stays within your Google account. No data is sent to any third-party service except:
- **Gemini API** — receives the PDF content for extraction. Subject to [Google AI usage policies](https://ai.google.dev/gemini-api/terms).

The viewer link (`?role=viewer`) disables upload and system controls but does not add authentication. Anyone with the link can view the data. Share accordingly.

---

## 📄 License

MIT — use it, fork it, adapt it.

---

*Part of the [Kitsune](https://github.com/CoffeeDiver) personal automation ecosystem — built with Google Apps Script and Gemini AI.*
