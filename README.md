# IEP Progress Monitor v2
**Under Construction Education** — Free tool for special education teachers

## Setup

### 1. Google Cloud Console
1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Select your project
3. Go to **APIs & Services → Credentials**
4. Click your OAuth 2.0 Client ID
5. Under **Authorized JavaScript origins**, add:
   - `http://localhost:5173` (for local dev)
   - `https://YOUR-APP.vercel.app` (your Vercel URL once deployed)
6. Make sure **Google Drive API** is enabled

### 2. Add your Client ID to the app
In `src/App.jsx`, replace line:
```js
const GDRIVE_CLIENT_ID = "YOUR_GOOGLE_CLIENT_ID_HERE";
```
With your actual Client ID from Google Cloud Console.

### 3. Deploy to Vercel
1. Push this repo to GitHub
2. Go to [vercel.com](https://vercel.com) → New Project
3. Import your GitHub repo
4. Click Deploy — that's it!
5. Copy your Vercel URL and add it to Google Cloud Console authorized origins

## Local Development
```bash
npm install
npm run dev
```

## Features
- 📋 Roster view with score bars for all goal areas
- 🎯 Goal Area view — compare all students by area
- 📊 Student detail with quarterly progress tracking
- 📈 Trend charts across quarters
- 📅 Quarter manager (add, rename, reorder)
- 📂 CSV import (3-step wizard with fuzzy student matching)
- 🖨 Report builder (Print/PDF + Word doc export)
- 🔒 Privacy/Incognito mode (initials, animals, numbers)
- ☁️ Google Drive sync — data stored ONLY in teacher's own Drive
