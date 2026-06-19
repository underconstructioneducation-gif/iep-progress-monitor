import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, ResponsiveContainer
} from "recharts";

// ── Constants ────────────────────────────────────────────────────────────────
const GOAL_AREAS = ["Reading", "Writing", "Math", "Behavior"];

const AREA_COLORS = {
  Reading:  { bg: "#EFF6FF", accent: "#3B82F6", badge: "#DBEAFE", text: "#1D4ED8" },
  Writing:  { bg: "#F0FDF4", accent: "#22C55E", badge: "#DCFCE7", text: "#15803D" },
  Math:     { bg: "#FFF7ED", accent: "#F97316", badge: "#FFEDD5", text: "#C2410C" },
  Behavior: { bg: "#FAF5FF", accent: "#A855F7", badge: "#F3E8FF", text: "#7E22CE" },
};

const STATUS = {
  not_started: { label: "Not Yet Started", color: "#6B7280", bg: "#F3F4F6" },
  continuing:  { label: "Continuing",      color: "#D97706", bg: "#FEF3C7" },
  mastered:    { label: "Mastered",        color: "#16A34A", bg: "#DCFCE7" },
};

// ── IMPORTANT: Replace this with your actual OAuth Client ID from Google Cloud Console
// Go to console.cloud.google.com → APIs & Services → Credentials
const GDRIVE_CLIENT_ID = "134368860675-f2m6sb51i7vkesrkk54sf0vlt5vtbfm4.apps.googleusercontent.com";
const GDRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const GDRIVE_FILE_NAME = "iep-progress-data.json";
const STORAGE_KEY = "iep_monitor_v2";

// ── Quarter helpers ───────────────────────────────────────────────────────────
function nextQuarterLabel(prevLabel) {
  const m = prevLabel.match(/^Q(\d)-(\d{2})$/);
  if (!m) return prevLabel + "+1";
  let q = parseInt(m[1]), yr = parseInt(m[2]);
  q++;
  if (q > 4) { q = 1; yr = (yr + 1) % 100; }
  return `Q${q}-${String(yr).padStart(2, "0")}`;
}

// ── Incognito helpers ─────────────────────────────────────────────────────────
const INCOGNITO_MODES = [
  { key: "initials", label: "Initials",     icon: "🔤" },
  { key: "animals",  label: "Animal Icons", icon: "🐾" },
  { key: "numbers",  label: "Student #",    icon: "🔢" },
];
const ANIMAL_ICONS = ["🐘","🦊","🐬","🦁","🐼","🦋","🐢","🦜","🦒","🐙",
  "🦈","🐧","🦝","🐨","🦄","🐸","🦩","🐯","🦔","🐳"];

function buildAliasMap(students, mode) {
  const sorted = [...students].sort((a, b) => a.name.localeCompare(b.name));
  const map = {};
  if (mode === "initials") {
    const raw = sorted.map(s => s.name.trim().split(/\s+/).map(p => p[0]?.toUpperCase() || "").join(""));
    const seen = {};
    raw.forEach(ini => { seen[ini] = (seen[ini] || 0) + 1; });
    const counts = {};
    raw.forEach((ini, i) => {
      if (seen[ini] > 1) { counts[ini] = (counts[ini] || 0) + 1; map[sorted[i].id] = `${ini}${counts[ini]}`; }
      else map[sorted[i].id] = ini;
    });
  } else if (mode === "animals") {
    sorted.forEach((s, i) => { map[s.id] = ANIMAL_ICONS[i % ANIMAL_ICONS.length]; });
  } else {
    sorted.forEach((s, i) => { map[s.id] = `S${i + 1}`; });
  }
  return map;
}

// ── Data helpers ──────────────────────────────────────────────────────────────
function getStatus(score, target) {
  if (score === null || score === undefined || score === "") return "not_started";
  return Number(score) >= Number(target) ? "mastered" : "continuing";
}
function entryPct(entry) {
  if (entry.type === "obs") return entry.checked ? 100 : 0;
  if (entry.total > 0) return Math.round((entry.correct / entry.total) * 100);
  return null;
}
function quarterAvg(entries) {
  if (!entries || entries.length === 0) return null;
  const pcts = entries.map(entryPct).filter(p => p !== null);
  if (pcts.length === 0) return null;
  return Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length);
}
function todayStr() { return new Date().toISOString().slice(0, 10); }

// ── Local Storage ─────────────────────────────────────────────────────────────
function loadLocal() {
  try { const r = localStorage.getItem(STORAGE_KEY); return r ? JSON.parse(r) : null; } catch { return null; }
}
function saveLocal(d) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(d)); } catch {} }

// ── Google Drive API ──────────────────────────────────────────────────────────
// Uses appDataFolder — data is ONLY in the teacher's own Drive, hidden from everyone else.

let _tokenClient = null;

function initTokenClient(callback) {
  if (!window.google?.accounts?.oauth2) return null;
  return window.google.accounts.oauth2.initTokenClient({
    client_id: GDRIVE_CLIENT_ID,
    scope: GDRIVE_SCOPE,
    callback,
  });
}

function getAccessToken() {
  return new Promise((resolve, reject) => {
    if (!window.google?.accounts?.oauth2) {
      reject(new Error("Google Identity Services not loaded yet. Please wait a moment and try again."));
      return;
    }
    const client = initTokenClient((resp) => {
      if (resp.error) reject(new Error(resp.error));
      else resolve(resp.access_token);
    });
    if (!client) { reject(new Error("Could not initialize Google auth client.")); return; }
    client.requestAccessToken({ prompt: "" });
  });
}

async function driveFindFile(token) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&fields=files(id,name)&q=name%3D%27${GDRIVE_FILE_NAME}%27`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Drive API error: ${res.status}`);
  const json = await res.json();
  return json.files?.[0] || null;
}

async function driveReadFile(token, fileId) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Drive read error: ${res.status}`);
  return res.json();
}

async function driveWriteFile(token, fileId, data) {
  const body = JSON.stringify(data);
  if (fileId) {
    const res = await fetch(
      `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
      { method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body }
    );
    if (!res.ok) throw new Error(`Drive update error: ${res.status}`);
    return fileId;
  } else {
    const meta = JSON.stringify({ name: GDRIVE_FILE_NAME, parents: ["appDataFolder"] });
    const form = new FormData();
    form.append("metadata", new Blob([meta], { type: "application/json" }));
    form.append("file", new Blob([body], { type: "application/json" }));
    const res = await fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
      { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form }
    );
    if (!res.ok) throw new Error(`Drive create error: ${res.status}`);
    const json = await res.json();
    return json.id;
  }
}

async function getUserEmail(token) {
  try {
    const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    return data.email || null;
  } catch { return null; }
}

// Merge: Drive wins for existing students; local-only students are kept.
function mergeData(local, remote) {
  if (!local) return remote;
  if (!remote) return local;
  const remoteIds = new Set(remote.students.map(s => s.id));
  const localOnly = local.students.filter(s => !remoteIds.has(s.id));
  return { ...remote, students: [...remote.students, ...localOnly] };
}

// ── Seed data ─────────────────────────────────────────────────────────────────
function seedData() {
  const q = (id, label, order) => ({ id, label, order });
  const s1q = [q("s1q1","Q1-24",0), q("s1q2","Q2-24",1), q("s1q3","Q3-24",2), q("s1q4","Q4-24",3)];
  const s2q = [q("s2q1","Q3-24",0), q("s2q2","Q4-24",1), q("s2q3","Q1-25",2)];
  const s3q = [q("s3q1","Q2-24",0), q("s3q2","Q3-24",1), q("s3q3","Q4-24",2), q("s3q4","Q1-25",3)];
  return {
    settings: { defaultView: "roster" },
    students: [
      { id:"s1", name:"Alex Rivera", quarters:s1q, goals:{
        Reading:  { description:"Read 2nd-grade passages at 90% accuracy", target:90, behaviorType:null,
          entries:{ s1q1:[{id:"e1",date:"2024-09-10",notes:"Running record",type:"scored",correct:14,total:20},{id:"e2",date:"2024-10-01",notes:"",type:"scored",correct:16,total:20}],
            s1q2:[{id:"e3",date:"2024-11-12",notes:"",type:"scored",correct:18,total:20}],
            s1q3:[{id:"e4",date:"2025-01-15",notes:"",type:"scored",correct:19,total:20}], s1q4:[] }},
        Writing:  { description:"Write 3+ sentence paragraphs with correct punctuation 80% of trials", target:80, behaviorType:null,
          entries:{ s1q1:[{id:"e5",date:"2024-09-15",notes:"",type:"scored",correct:4,total:6}],
            s1q2:[{id:"e6",date:"2024-11-20",notes:"Improved topic sentences",type:"scored",correct:5,total:6}],
            s1q3:[{id:"e7",date:"2025-01-20",notes:"",type:"scored",correct:5,total:6}], s1q4:[] }},
        Math:     { description:"Solve 2-digit addition/subtraction with regrouping at 85% accuracy", target:85, behaviorType:null,
          entries:{ s1q1:[{id:"e8",date:"2024-09-18",notes:"",type:"scored",correct:17,total:20}],
            s1q2:[{id:"e9",date:"2024-11-05",notes:"",type:"scored",correct:18,total:20}],
            s1q3:[{id:"e10",date:"2025-01-22",notes:"",type:"scored",correct:18,total:20}], s1q4:[] }},
        Behavior: { description:"Stay on-task for 10-min blocks without prompting 80% of observations", target:80, behaviorType:"obs",
          entries:{ s1q1:[{id:"e11",date:"2024-09-20",notes:"Morning session",type:"obs",checked:false},{id:"e12",date:"2024-09-25",notes:"",type:"obs",checked:true},{id:"e13",date:"2024-10-02",notes:"",type:"obs",checked:true}],
            s1q2:[{id:"e14",date:"2024-11-14",notes:"",type:"obs",checked:true},{id:"e15",date:"2024-12-01",notes:"",type:"obs",checked:false},{id:"e16",date:"2024-12-10",notes:"Good day",type:"obs",checked:true}],
            s1q3:[{id:"e17",date:"2025-01-18",notes:"",type:"obs",checked:true},{id:"e18",date:"2025-02-01",notes:"",type:"obs",checked:true}], s1q4:[] }},
      }},
      { id:"s2", name:"Jordan Kim", quarters:s2q, goals:{
        Reading:  { description:"Identify main idea and 2 details from 3rd-grade text at 80% accuracy", target:80, behaviorType:null,
          entries:{ s2q1:[{id:"f1",date:"2025-01-12",notes:"",type:"scored",correct:9,total:16}],
            s2q2:[{id:"f2",date:"2025-03-18",notes:"",type:"scored",correct:11,total:16}], s2q3:[] }},
        Writing:  { description:"Use topic sentences in written paragraphs 75% of assignments", target:75, behaviorType:null,
          entries:{ s2q1:[{id:"f3",date:"2025-01-22",notes:"",type:"scored",correct:3,total:6}],
            s2q2:[{id:"f4",date:"2025-03-22",notes:"",type:"scored",correct:5,total:6}], s2q3:[] }},
        Math:     { description:"Complete multiplication facts 0–5 at 90% accuracy in 3 min", target:90, behaviorType:null,
          entries:{ s2q1:[{id:"f5",date:"2025-01-14",notes:"Timed drill",type:"scored",correct:18,total:25}],
            s2q2:[{id:"f6",date:"2025-03-10",notes:"",type:"scored",correct:22,total:25}], s2q3:[] }},
        Behavior: { description:"Use self-regulation strategies independently 3/5 observed transitions", target:75, behaviorType:"scored",
          entries:{ s2q1:[{id:"f7",date:"2025-01-19",notes:"",type:"scored",correct:2,total:5},{id:"f8",date:"2025-02-03",notes:"",type:"scored",correct:3,total:5}],
            s2q2:[{id:"f9",date:"2025-03-15",notes:"",type:"scored",correct:3,total:5},{id:"f10",date:"2025-04-05",notes:"Better morning",type:"scored",correct:4,total:5}], s2q3:[] }},
      }},
      { id:"s3", name:"Morgan Ellis", quarters:s3q, goals:{
        Reading:  { description:"Decode multisyllabic words at 85% accuracy", target:85, behaviorType:null,
          entries:{ s3q1:[{id:"g1",date:"2024-11-11",notes:"",type:"scored",correct:16,total:20}],
            s3q2:[{id:"g2",date:"2025-01-09",notes:"",type:"scored",correct:17,total:20}],
            s3q3:[{id:"g3",date:"2025-03-12",notes:"",type:"scored",correct:19,total:20}], s3q4:[] }},
        Writing:  { description:"Organize writing with intro, body, conclusion 80% of tasks", target:80, behaviorType:null,
          entries:{ s3q1:[{id:"g4",date:"2024-11-16",notes:"",type:"scored",correct:3,total:5}],
            s3q2:[{id:"g5",date:"2025-01-21",notes:"",type:"scored",correct:4,total:5}],
            s3q3:[{id:"g6",date:"2025-03-18",notes:"",type:"scored",correct:4,total:5}], s3q4:[] }},
        Math:     { description:"Solve word problems using addition/subtraction at 70% accuracy", target:70, behaviorType:null,
          entries:{ s3q1:[{id:"g7",date:"2024-11-17",notes:"",type:"scored",correct:12,total:20}],
            s3q2:[{id:"g8",date:"2025-01-13",notes:"",type:"scored",correct:14,total:20}],
            s3q3:[{id:"g9",date:"2025-03-15",notes:"",type:"scored",correct:16,total:20}], s3q4:[] }},
        Behavior: { description:"Request breaks appropriately instead of eloping 4/5 opportunities", target:80, behaviorType:"scored",
          entries:{ s3q1:[{id:"g10",date:"2024-11-23",notes:"",type:"scored",correct:2,total:5},{id:"g11",date:"2024-12-07",notes:"",type:"scored",correct:3,total:5}],
            s3q2:[{id:"g12",date:"2025-01-16",notes:"",type:"scored",correct:3,total:5},{id:"g13",date:"2025-02-08",notes:"Used visual card",type:"scored",correct:4,total:5}],
            s3q3:[{id:"g14",date:"2025-03-20",notes:"",type:"scored",correct:4,total:5}], s3q4:[] }},
      }},
    ]
  };
}

// ── CSV helpers ───────────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));
  const rows = lines.slice(1).map(line => {
    const fields = []; let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') inQ = !inQ;
      else if (ch === ',' && !inQ) { fields.push(cur.trim()); cur = ""; }
      else cur += ch;
    }
    fields.push(cur.trim());
    const row = {};
    headers.forEach((h, i) => { row[h] = (fields[i] || "").replace(/^"|"$/g, "").trim(); });
    return row;
  }).filter(r => Object.values(r).some(v => v !== ""));
  return { headers, rows };
}

function fuzzyMatchStudent(csvName, students) {
  const n = csvName.toLowerCase().trim();
  return students.find(s => s.name.toLowerCase() === n)
    || students.find(s => { const p = s.name.toLowerCase().split(" "); return p[p.length - 1] === n.split(" ").pop(); })
    || students.find(s => s.name.toLowerCase().includes(n) || n.includes(s.name.toLowerCase()))
    || null;
}

// ── Shared UI ─────────────────────────────────────────────────────────────────
function StatusBadge({ score, target }) {
  const key = getStatus(score, target);
  const { label, color, bg } = STATUS[key];
  return (
    <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 99,
      background: bg, color, letterSpacing: ".2px", whiteSpace: "nowrap" }}>{label}</span>
  );
}

function ScoreBar({ score, target }) {
  if (score === null || score === undefined) return (
    <div style={{ height: 8, borderRadius: 4, background: "#E5E7EB", width: "100%" }} />
  );
  const pct = Math.min(Number(score), 100);
  const color = STATUS[getStatus(score, target)].color;
  return (
    <div style={{ position: "relative", height: 8, borderRadius: 4, background: "#E5E7EB", width: "100%" }}>
      <div style={{ height: "100%", borderRadius: 4, background: color, width: `${pct}%`, transition: "width .4s ease" }} />
      {target && <div style={{ position: "absolute", top: -4, bottom: -4,
        left: `${Math.min(Number(target), 100)}%`, width: 2,
        background: "#1F2937", borderRadius: 1, transform: "translateX(-50%)" }} />}
    </div>
  );
}

// ── Entry Modal ───────────────────────────────────────────────────────────────
function EntryModal({ goal, area, quarterLabel, onSave, onClose }) {
  const isObs = area === "Behavior" && goal.behaviorType === "obs";
  const [correct, setCorrect] = useState("");
  const [total, setTotal] = useState("");
  const [checked, setChecked] = useState(null);
  const [date, setDate] = useState(todayStr());
  const [notes, setNotes] = useState("");

  const pctPreview = isObs ? (checked !== null ? (checked ? 100 : 0) : null)
    : (correct !== "" && total !== "" && Number(total) > 0 ? Math.round((Number(correct) / Number(total)) * 100) : null);

  function handleSave() {
    const entry = { id: "e" + Date.now(), date, notes, type: isObs ? "obs" : "scored" };
    if (isObs) { if (checked === null) return; entry.checked = checked; }
    else { if (correct === "" || total === "" || Number(total) === 0) return; entry.correct = Number(correct); entry.total = Number(total); }
    onSave(entry);
  }
  const canSave = isObs ? checked !== null : (correct !== "" && total !== "" && Number(total) > 0);

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 1000,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ background: "#fff", borderRadius: 14, width: "100%", maxWidth: 440,
        boxShadow: "0 8px 32px rgba(0,0,0,.18)", overflow: "hidden" }}>
        <div style={{ background: AREA_COLORS[area].bg, borderBottom: `2px solid ${AREA_COLORS[area].accent}`,
          padding: "14px 20px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <span style={{ fontWeight: 800, fontSize: 15, color: AREA_COLORS[area].text }}>{area} — {quarterLabel}</span>
            <div style={{ fontSize: 11, color: "#6B7280", marginTop: 2 }}>New data entry</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "#6B7280" }}>✕</button>
        </div>
        <div style={{ padding: "20px 20px 24px" }}>
          <div style={{ fontSize: 12, color: "#6B7280", background: "#F9FAFB", borderRadius: 8,
            padding: "8px 12px", marginBottom: 18, lineHeight: 1.5 }}>
            {goal.description || "No goal description set."}
          </div>
          {!isObs && (
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: "#374151", display: "block", marginBottom: 8 }}>Score</label>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <input type="number" min={0} placeholder="Correct" value={correct} onChange={e => setCorrect(e.target.value)}
                  style={{ width: 90, padding: "8px 10px", borderRadius: 8, border: "1px solid #D1D5DB", fontSize: 15, textAlign: "center", outline: "none" }} />
                <span style={{ fontSize: 18, color: "#9CA3AF" }}>/</span>
                <input type="number" min={1} placeholder="Total" value={total} onChange={e => setTotal(e.target.value)}
                  style={{ width: 90, padding: "8px 10px", borderRadius: 8, border: "1px solid #D1D5DB", fontSize: 15, textAlign: "center", outline: "none" }} />
                {pctPreview !== null && <span style={{ fontSize: 22, fontWeight: 800, color: STATUS[getStatus(pctPreview, goal.target)].color }}>{pctPreview}%</span>}
              </div>
            </div>
          )}
          {isObs && (
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: "#374151", display: "block", marginBottom: 8 }}>Observed?</label>
              <div style={{ display: "flex", gap: 10 }}>
                {[true, false].map(val => (
                  <button key={String(val)} onClick={() => setChecked(val)}
                    style={{ flex: 1, padding: "12px 0", borderRadius: 10,
                      border: `2px solid ${checked === val ? (val ? "#16A34A" : "#DC2626") : "#D1D5DB"}`,
                      background: checked === val ? (val ? "#DCFCE7" : "#FEE2E2") : "#F9FAFB",
                      color: checked === val ? (val ? "#16A34A" : "#DC2626") : "#374151",
                      fontWeight: 800, fontSize: 15, cursor: "pointer" }}>
                    {val ? "✓  Yes" : "✗  No"}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 12, fontWeight: 700, color: "#374151", display: "block", marginBottom: 6 }}>Date</label>
            <input type="date" value={date} onChange={e => setDate(e.target.value)}
              style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #D1D5DB", fontSize: 14, outline: "none", width: "100%" }} />
          </div>
          <div style={{ marginBottom: 20 }}>
            <label style={{ fontSize: 12, fontWeight: 700, color: "#374151", display: "block", marginBottom: 6 }}>
              Notes <span style={{ fontWeight: 400, color: "#9CA3AF" }}>(optional)</span>
            </label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. used manipulatives, small group…" rows={2}
              style={{ width: "100%", padding: "8px 12px", borderRadius: 8, border: "1px solid #D1D5DB",
                fontSize: 13, resize: "vertical", fontFamily: "inherit", outline: "none", boxSizing: "border-box" }} />
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={onClose} style={{ flex: 1, padding: "10px 0", borderRadius: 8, border: "1px solid #D1D5DB",
              background: "#F9FAFB", color: "#374151", fontWeight: 700, fontSize: 14, cursor: "pointer" }}>Cancel</button>
            <button onClick={handleSave} disabled={!canSave}
              style={{ flex: 2, padding: "10px 0", borderRadius: 8, border: "none",
                background: canSave ? AREA_COLORS[area].accent : "#D1D5DB",
                color: "#fff", fontWeight: 700, fontSize: 14, cursor: canSave ? "pointer" : "not-allowed" }}>
              Save Entry
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Entry Row ─────────────────────────────────────────────────────────────────
function EntryRow({ entry, onDelete, accentColor }) {
  const pct = entryPct(entry);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
      borderRadius: 8, background: "#F9FAFB", border: "1px solid #E5E7EB" }}>
      <span style={{ fontSize: 12, color: "#6B7280", minWidth: 88 }}>{entry.date}</span>
      {entry.type === "obs"
        ? <span style={{ fontSize: 13, fontWeight: 700, color: entry.checked ? "#16A34A" : "#DC2626" }}>{entry.checked ? "✓ Yes" : "✗ No"}</span>
        : <span style={{ fontSize: 13, fontWeight: 700, color: "#374151" }}>{entry.correct}/{entry.total}</span>}
      <span style={{ fontSize: 13, fontWeight: 800, color: accentColor, minWidth: 44 }}>{pct !== null ? `${pct}%` : "—"}</span>
      {entry.notes
        ? <span style={{ fontSize: 12, color: "#6B7280", flex: 1, fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.notes}</span>
        : <span style={{ flex: 1 }} />}
      <button onClick={onDelete} style={{ background: "none", border: "none", color: "#EF4444", cursor: "pointer", fontSize: 14, padding: "0 4px" }}>✕</button>
    </div>
  );
}

// ── Quarter Manager Modal ─────────────────────────────────────────────────────
function QuarterManagerModal({ student, onSave, onClose }) {
  const [quarters, setQuarters] = useState(() => [...student.quarters].sort((a, b) => a.order - b.order));
  const [editingId, setEditingId] = useState(null);
  const [editLabel, setEditLabel] = useState("");
  const [newLabel, setNewLabel] = useState(() => {
    const last = [...student.quarters].sort((a, b) => a.order - b.order).pop();
    return last ? nextQuarterLabel(last.label) : "Q1-25";
  });
  const dragItem = useRef(null);
  const dragOver = useRef(null);

  function addQuarter() {
    if (!newLabel.trim()) return;
    const id = "q" + Date.now();
    const updated = [...quarters, { id, label: newLabel.trim(), order: quarters.length }];
    setQuarters(updated);
    setNewLabel(nextQuarterLabel(newLabel.trim()));
  }
  function removeQuarter(id) {
    setQuarters(prev => prev.filter(q => q.id !== id).map((q, i) => ({ ...q, order: i })));
  }
  function startEdit(q) { setEditingId(q.id); setEditLabel(q.label); }
  function commitEdit() {
    setQuarters(prev => prev.map(q => q.id === editingId ? { ...q, label: editLabel } : q));
    setEditingId(null);
  }
  function handleDragStart(i) { dragItem.current = i; }
  function handleDragEnter(i) { dragOver.current = i; }
  function handleDrop() {
    const updated = [...quarters];
    const dragged = updated.splice(dragItem.current, 1)[0];
    updated.splice(dragOver.current, 0, dragged);
    setQuarters(updated.map((q, i) => ({ ...q, order: i })));
    dragItem.current = null; dragOver.current = null;
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", zIndex: 1100,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ background: "#fff", borderRadius: 16, width: "100%", maxWidth: 480,
        boxShadow: "0 12px 40px rgba(0,0,0,.22)", overflow: "hidden", maxHeight: "90vh", display: "flex", flexDirection: "column" }}>
        <div style={{ background: "#4F46E5", padding: "14px 20px",
          display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 16, color: "#fff" }}>📅 Manage Quarters</div>
            <div style={{ fontSize: 12, color: "#C7D2FE", marginTop: 2 }}>Drag to reorder · click label to edit</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#fff", fontSize: 20, cursor: "pointer" }}>✕</button>
        </div>
        <div style={{ padding: "20px", overflowY: "auto", flex: 1 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
            {quarters.length === 0 && <div style={{ color: "#9CA3AF", textAlign: "center", padding: "16px 0" }}>No quarters yet — add one below.</div>}
            {quarters.map((q, i) => (
              <div key={q.id} draggable
                onDragStart={() => handleDragStart(i)} onDragEnter={() => handleDragEnter(i)}
                onDragEnd={handleDrop} onDragOver={e => e.preventDefault()}
                style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px",
                  borderRadius: 10, border: "1px solid #E5E7EB", background: "#F9FAFB", cursor: "grab", userSelect: "none" }}>
                <span style={{ fontSize: 16, color: "#9CA3AF" }}>⠿</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: "#4F46E5", minWidth: 20 }}>#{i + 1}</span>
                {editingId === q.id ? (
                  <input autoFocus value={editLabel} onChange={e => setEditLabel(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditingId(null); }}
                    onBlur={commitEdit}
                    style={{ flex: 1, padding: "4px 8px", borderRadius: 6, border: "1px solid #6366F1", fontSize: 14, fontWeight: 700, outline: "none" }} />
                ) : (
                  <span onClick={() => startEdit(q)}
                    style={{ flex: 1, fontSize: 14, fontWeight: 700, color: "#111827", cursor: "text",
                      padding: "4px 8px", borderRadius: 6, border: "1px solid transparent" }}
                    title="Click to edit label">{q.label}</span>
                )}
                <button onClick={() => removeQuarter(q.id)}
                  style={{ background: "none", border: "none", color: "#EF4444", cursor: "pointer", fontSize: 15, padding: "0 4px" }}>✕</button>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", borderTop: "1px solid #E5E7EB", paddingTop: 16 }}>
            <input value={newLabel} onChange={e => setNewLabel(e.target.value)}
              onKeyDown={e => e.key === "Enter" && addQuarter()} placeholder="e.g. Q3-25"
              style={{ flex: 1, padding: "8px 12px", borderRadius: 8, border: "1px solid #D1D5DB", fontSize: 14, outline: "none" }} />
            <button onClick={addQuarter}
              style={{ padding: "8px 18px", background: "#4F46E5", color: "#fff", border: "none", borderRadius: 8, fontWeight: 700, cursor: "pointer", fontSize: 14 }}>+ Add</button>
          </div>
          <p style={{ fontSize: 11, color: "#9CA3AF", marginTop: 8 }}>Labels auto-sequence but you can type anything. Drag rows to reorder.</p>
        </div>
        <div style={{ padding: "14px 20px", borderTop: "1px solid #E5E7EB", display: "flex", gap: 10, flexShrink: 0 }}>
          <button onClick={onClose} style={{ flex: 1, padding: "10px 0", borderRadius: 8, border: "1px solid #D1D5DB",
            background: "#F9FAFB", color: "#374151", fontWeight: 700, cursor: "pointer" }}>Cancel</button>
          <button onClick={() => onSave(quarters)}
            style={{ flex: 2, padding: "10px 0", borderRadius: 8, border: "none",
              background: "#4F46E5", color: "#fff", fontWeight: 700, cursor: "pointer" }}>Save Quarters</button>
        </div>
      </div>
    </div>
  );
}

// ── CSV Import Modal ──────────────────────────────────────────────────────────
function CsvImportModal({ students, onImport, onClose, incognito, aliasMap }) {
  const [step, setStep] = useState("upload");
  const [headers, setHeaders] = useState([]);
  const [rows, setRows] = useState([]);
  const [mapping, setMapping] = useState({ studentName: "", correct: "", total: "", date: "", notes: "" });
  const [area, setArea] = useState("Reading");
  const [quarterId, setQuarterId] = useState("");
  const [preview, setPreview] = useState([]);
  const [error, setError] = useState("");

  const allQuarters = [];
  students.forEach(s => {
    (s.quarters || []).forEach(q => {
      if (!allQuarters.find(x => x.label === q.label)) allQuarters.push({ ...q, studentId: s.id });
    });
  });

  function handleFile(e) {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const { headers: h, rows: r } = parseCSV(ev.target.result);
      if (h.length === 0) { setError("Could not read CSV."); return; }
      setHeaders(h); setRows(r);
      const guess = c => h.find(hh => c.some(x => hh.toLowerCase().includes(x))) || "";
      setMapping({ studentName: guess(["student", "name"]), correct: guess(["correct", "score", "right", "earned"]),
        total: guess(["total", "possible", "max", "out"]), date: guess(["date", "timestamp"]), notes: guess(["note", "comment"]) });
      setError(""); setStep("map");
    };
    reader.readAsText(file);
  }

  function buildPreview() {
    if (!mapping.studentName || !mapping.correct || !mapping.total) { setError("Map Student Name, Correct, and Total."); return; }
    const items = rows.map(row => {
      const csvName = row[mapping.studentName] || "";
      const matched = fuzzyMatchStudent(csvName, students);
      const correct = Number(row[mapping.correct]); const total = Number(row[mapping.total]);
      const date = mapping.date && row[mapping.date] ? row[mapping.date].slice(0, 10) : todayStr();
      const notes = mapping.notes ? (row[mapping.notes] || "") : "";
      const entry = { id: "csv" + Date.now() + Math.random(), date, notes, type: "scored", correct, total };
      const selectedQ = allQuarters.find(q => q.id === quarterId);
      const studentQ = matched ? (matched.quarters || []).find(q => q.label === selectedQ?.label) : null;
      return { csvName, matched, entry, valid: !!(matched && total > 0 && studentQ), studentQId: studentQ?.id };
    });
    setPreview(items); setError(""); setStep("preview");
  }

  const NONE = "— skip —";
  const colOptions = [NONE, ...headers];

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", zIndex: 1100,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ background: "#fff", borderRadius: 16, width: "100%", maxWidth: 560,
        boxShadow: "0 12px 40px rgba(0,0,0,.22)", overflow: "hidden", maxHeight: "90vh", display: "flex", flexDirection: "column" }}>
        <div style={{ background: "#4F46E5", padding: "14px 20px",
          display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 16, color: "#fff" }}>📂 CSV Import</div>
            <div style={{ fontSize: 12, color: "#C7D2FE", marginTop: 2 }}>
              {step === "upload" && "Step 1 of 3 — Upload file"}
              {step === "map" && "Step 2 of 3 — Map columns"}
              {step === "preview" && "Step 3 of 3 — Review"}
              {step === "done" && "Import complete!"}
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#fff", fontSize: 20, cursor: "pointer" }}>✕</button>
        </div>
        <div style={{ padding: "20px", overflowY: "auto", flex: 1 }}>
          {step === "upload" && (
            <div>
              <p style={{ fontSize: 14, color: "#374151", marginBottom: 16, lineHeight: 1.6 }}>Upload a CSV from Google Forms, a gradebook, or any assessment tool.</p>
              <div style={{ border: "2px dashed #C7D2FE", borderRadius: 12, padding: "32px", textAlign: "center", background: "#F5F3FF" }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>📄</div>
                <div style={{ fontWeight: 700, color: "#4F46E5", marginBottom: 6 }}>Choose a CSV file</div>
                <div style={{ fontSize: 12, color: "#6B7280", marginBottom: 16 }}>Tip: In Google Sheets → File → Download → CSV</div>
                <input type="file" accept=".csv,text/csv" onChange={handleFile} style={{ display: "block", margin: "0 auto", fontSize: 14 }} />
              </div>
              {error && <div style={{ color: "#DC2626", fontSize: 13, marginTop: 12 }}>{error}</div>}
            </div>
          )}
          {step === "map" && (
            <div>
              <p style={{ fontSize: 13, color: "#6B7280", marginBottom: 16 }}>Found <strong>{rows.length} rows</strong> and <strong>{headers.length} columns</strong>.</p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 700, color: "#374151", display: "block", marginBottom: 4 }}>Goal Area *</label>
                  <select value={area} onChange={e => setArea(e.target.value)}
                    style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid #D1D5DB", fontSize: 14, outline: "none" }}>
                    {GOAL_AREAS.map(a => <option key={a}>{a}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 700, color: "#374151", display: "block", marginBottom: 4 }}>Quarter *</label>
                  <select value={quarterId} onChange={e => setQuarterId(e.target.value)}
                    style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid #D1D5DB", fontSize: 14, outline: "none" }}>
                    <option value="">— select —</option>
                    {allQuarters.map(q => <option key={q.id} value={q.id}>{q.label}</option>)}
                  </select>
                </div>
              </div>
              {[{ key: "studentName", label: "Student Name", req: true }, { key: "correct", label: "Correct / Score", req: true },
                { key: "total", label: "Total / Possible", req: true }, { key: "date", label: "Date", req: false }, { key: "notes", label: "Notes", req: false }
              ].map(({ key, label, req }) => (
                <div key={key} style={{ marginBottom: 12 }}>
                  <label style={{ fontSize: 12, fontWeight: 700, color: "#374151", display: "block", marginBottom: 4 }}>
                    {label} {req && <span style={{ color: "#EF4444" }}>*</span>}
                  </label>
                  <select value={mapping[key] || NONE} onChange={e => setMapping(m => ({ ...m, [key]: e.target.value === NONE ? "" : e.target.value }))}
                    style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid #D1D5DB", fontSize: 14, outline: "none" }}>
                    {colOptions.map(o => <option key={o}>{o}</option>)}
                  </select>
                </div>
              ))}
              {error && <div style={{ color: "#DC2626", fontSize: 13, marginTop: 4 }}>{error}</div>}
              <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
                <button onClick={() => setStep("upload")} style={{ flex: 1, padding: "10px 0", borderRadius: 8, border: "1px solid #D1D5DB", background: "#F9FAFB", color: "#374151", fontWeight: 700, cursor: "pointer" }}>Back</button>
                <button onClick={buildPreview} style={{ flex: 2, padding: "10px 0", borderRadius: 8, border: "none", background: "#4F46E5", color: "#fff", fontWeight: 700, cursor: "pointer" }}>Preview →</button>
              </div>
            </div>
          )}
          {step === "preview" && (
            <div>
              <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
                <span style={{ fontSize: 13, color: "#16A34A", fontWeight: 600 }}>✓ {preview.filter(p => p.valid).length} matched</span>
                {preview.filter(p => !p.valid).length > 0 && <span style={{ fontSize: 13, color: "#DC2626", fontWeight: 600 }}>✗ {preview.filter(p => !p.valid).length} unmatched</span>}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
                {preview.map((p, i) => {
                  const pct = p.entry.total > 0 ? Math.round((p.entry.correct / p.entry.total) * 100) : null;
                  return (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
                      borderRadius: 8, border: `1px solid ${p.valid ? "#D1FAE5" : "#FEE2E2"}`,
                      background: p.valid ? "#F0FDF4" : "#FEF2F2" }}>
                      <span style={{ fontSize: 16 }}>{p.valid ? "✓" : "✗"}</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>
                          {incognito ? (p.matched ? aliasMap[p.matched.id] : p.csvName) : p.csvName}
                          {!incognito && p.matched && p.matched.name !== p.csvName &&
                            <span style={{ fontWeight: 400, color: "#6B7280", fontSize: 12 }}> → {p.matched.name}</span>}
                        </div>
                        {!p.matched && <div style={{ fontSize: 11, color: "#DC2626" }}>No matching student found</div>}
                        {p.matched && !p.studentQId && <div style={{ fontSize: 11, color: "#DC2626" }}>Student doesn't have this quarter — add it first</div>}
                      </div>
                      {pct !== null && <span style={{ fontWeight: 800, fontSize: 15, color: "#4F46E5" }}>{p.entry.correct}/{p.entry.total} = {pct}%</span>}
                    </div>
                  );
                })}
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button onClick={() => setStep("map")} style={{ flex: 1, padding: "10px 0", borderRadius: 8, border: "1px solid #D1D5DB", background: "#F9FAFB", color: "#374151", fontWeight: 700, cursor: "pointer" }}>Back</button>
                <button onClick={() => { onImport(preview.filter(p => p.valid).map(p => ({ studentId: p.matched.id, area, quarterId: p.studentQId, entry: p.entry }))); setStep("done"); }}
                  disabled={preview.filter(p => p.valid).length === 0}
                  style={{ flex: 2, padding: "10px 0", borderRadius: 8, border: "none",
                    background: preview.filter(p => p.valid).length > 0 ? "#16A34A" : "#D1D5DB",
                    color: "#fff", fontWeight: 700, cursor: preview.filter(p => p.valid).length > 0 ? "pointer" : "not-allowed" }}>
                  Import {preview.filter(p => p.valid).length} {preview.filter(p => p.valid).length === 1 ? "Entry" : "Entries"}
                </button>
              </div>
            </div>
          )}
          {step === "done" && (
            <div style={{ textAlign: "center", padding: "24px 0" }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>🎉</div>
              <div style={{ fontWeight: 800, fontSize: 18, color: "#111827", marginBottom: 8 }}>Import complete!</div>
              <button onClick={onClose} style={{ padding: "10px 32px", background: "#4F46E5", color: "#fff", border: "none", borderRadius: 8, fontWeight: 700, cursor: "pointer" }}>Done</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Report helpers ────────────────────────────────────────────────────────────
function buildReportHTML(students, options, incognito, aliasMap) {
  const { areas, quarters: selectedQLabels, sections, dateFrom, dateTo } = options;
  function dName(s) { return incognito ? (aliasMap[s.id] || "??") : s.name; }
  function filterEntries(entries) {
    if (!dateFrom && !dateTo) return entries;
    return entries.filter(e => {
      if (dateFrom && e.date < dateFrom) return false;
      if (dateTo && e.date > dateTo) return false;
      return true;
    });
  }
  const statusLabel = (score, target) => {
    if (score === null || score === undefined) return "Not Yet Started";
    return Number(score) >= Number(target) ? "Mastered" : "Continuing";
  };
  const statusColor = (score, target) => {
    if (score === null || score === undefined) return "#6B7280";
    return Number(score) >= Number(target) ? "#16A34A" : "#D97706";
  };
  const areaColor = { Reading: "#1D4ED8", Writing: "#15803D", Math: "#C2410C", Behavior: "#7E22CE" };
  const areaBg = { Reading: "#EFF6FF", Writing: "#F0FDF4", Math: "#FFF7ED", Behavior: "#FAF5FF" };

  let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>IEP Progress Report</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: 11pt; color: #111; background: #fff; }
  .page { max-width: 750px; margin: 0 auto; padding: 32px 40px; }
  h1 { font-size: 18pt; color: #4F46E5; margin-bottom: 4px; }
  .meta { font-size: 9pt; color: #6B7280; margin-bottom: 24px; border-bottom: 2px solid #4F46E5; padding-bottom: 10px; }
  .student-block { margin-bottom: 32px; page-break-inside: avoid; }
  .student-name { font-size: 15pt; font-weight: bold; color: #111; margin-bottom: 12px; padding: 8px 12px; background: #F3F4F6; border-left: 4px solid #4F46E5; border-radius: 4px; }
  .area-block { margin-bottom: 16px; border: 1px solid #E5E7EB; border-radius: 6px; overflow: hidden; page-break-inside: avoid; }
  .area-header { padding: 7px 12px; font-weight: bold; font-size: 11pt; }
  .area-body { padding: 10px 14px; }
  .goal-desc { font-size: 10pt; color: #374151; margin-bottom: 8px; font-style: italic; }
  .target-line { font-size: 9pt; color: #6B7280; margin-bottom: 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 9.5pt; margin-bottom: 10px; }
  th { background: #F3F4F6; padding: 5px 8px; text-align: left; font-weight: bold; border: 1px solid #D1D5DB; }
  td { padding: 5px 8px; border: 1px solid #E5E7EB; vertical-align: top; }
  .status-badge { font-size: 8.5pt; font-weight: bold; padding: 2px 6px; border-radius: 99px; display: inline-block; }
  .section-label { font-size: 9pt; font-weight: bold; color: #6B7280; margin: 8px 0 4px; text-transform: uppercase; letter-spacing: .5px; }
  @media print {
    .student-block { page-break-after: always; }
    .student-block:last-child { page-break-after: avoid; }
  }
</style></head><body><div class="page">`;

  html += `<h1>IEP Progress Report</h1>
<div class="meta">Generated: ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}
${dateFrom || dateTo ? ` · Date range: ${dateFrom || "start"} – ${dateTo || "present"}` : ""}
 · Goal areas: ${areas.join(", ")}</div>`;

  students.forEach(student => {
    const studentQuarters = [...(student.quarters || [])].sort((a, b) => a.order - b.order)
      .filter(q => selectedQLabels.length === 0 || selectedQLabels.includes(q.label));
    if (studentQuarters.length === 0 && selectedQLabels.length > 0) return;
    html += `<div class="student-block"><div class="student-name">${dName(student)}</div>`;
    areas.forEach(area => {
      const goal = student.goals[area];
      if (!goal) return;
      const color = areaColor[area]; const bg = areaBg[area];
      const qAvgs = studentQuarters.map(q => {
        const ents = filterEntries(goal.entries[q.id] || []);
        return { q, avg: quarterAvg(ents), count: ents.length };
      });
      const latestWithData = [...qAvgs].reverse().find(x => x.avg !== null);
      const latestAvg = latestWithData?.avg ?? null;
      const sKey = statusLabel(latestAvg, goal.target) === "Mastered" ? "mastered" : statusLabel(latestAvg, goal.target) === "Continuing" ? "continuing" : "not_started";
      html += `<div class="area-block"><div class="area-header" style="background:${bg};color:${color}">${area}
  <span class="status-badge" style="background:${STATUS[sKey].bg};color:${statusColor(latestAvg, goal.target)};margin-left:10px">${statusLabel(latestAvg, goal.target)}</span>
</div><div class="area-body">`;
      if (sections.includes("goal")) {
        html += `<div class="goal-desc">${goal.description || "No goal description entered."}</div>
<div class="target-line">Mastery target: <strong>${goal.target}%</strong>`;
        if (latestAvg !== null) html += ` · Latest avg: <strong style="color:${statusColor(latestAvg, goal.target)}">${latestAvg}%</strong>`;
        html += `</div>`;
      }
      if (sections.includes("table") && studentQuarters.length > 0) {
        html += `<div class="section-label">Quarterly Summary</div><table><tr><th>Quarter</th><th>Avg %</th><th>Entries</th><th>Status</th></tr>`;
        qAvgs.forEach(({ q, avg, count }) => {
          const sk = statusLabel(avg, goal.target) === "Mastered" ? "mastered" : statusLabel(avg, goal.target) === "Continuing" ? "continuing" : "not_started";
          html += `<tr><td>${q.label}</td>
<td style="font-weight:bold;color:${avg !== null ? statusColor(avg, goal.target) : "#9CA3AF"}">${avg !== null ? avg + "%" : "—"}</td>
<td>${count}</td>
<td><span class="status-badge" style="background:${STATUS[sk].bg};color:${statusColor(avg, goal.target)}">${statusLabel(avg, goal.target)}</span></td></tr>`;
        });
        html += `</table>`;
      }
      if (sections.includes("entries")) {
        studentQuarters.forEach(q => {
          const ents = filterEntries(goal.entries[q.id] || []);
          if (ents.length === 0) return;
          html += `<div class="section-label">Data Entries — ${q.label}</div>
<table><tr><th>Date</th><th>Score</th><th>%</th><th>Notes</th></tr>`;
          [...ents].sort((a, b) => a.date.localeCompare(b.date)).forEach(e => {
            const pct = entryPct(e);
            const scoreStr = e.type === "obs" ? (e.checked ? "✓ Yes" : "✗ No") : `${e.correct}/${e.total}`;
            html += `<tr><td>${e.date}</td><td>${scoreStr}</td>
<td style="font-weight:bold;color:${pct !== null ? statusColor(pct, goal.target) : "#9CA3AF"}">${pct !== null ? pct + "%" : "—"}</td>
<td style="color:#6B7280">${e.notes || ""}</td></tr>`;
          });
          html += `</table>`;
        });
      }
      html += `</div></div>`;
    });
    html += `</div>`;
  });
  html += `</div></body></html>`;
  return html;
}

// ── Report Builder Modal ──────────────────────────────────────────────────────
function ReportBuilderModal({ allStudents, onClose, incognito, aliasMap }) {
  const allQLabels = [];
  allStudents.forEach(s => (s.quarters || []).forEach(q => { if (!allQLabels.includes(q.label)) allQLabels.push(q.label); }));

  const [selStudents, setSelStudents] = useState(allStudents.map(s => s.id));
  const [selAreas, setSelAreas] = useState([...GOAL_AREAS]);
  const [selQLbls, setSelQLbls] = useState([...allQLabels]);
  const [selSections, setSelSections] = useState(["goal", "table", "entries"]);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [docxUrl, setDocxUrl] = useState(null);
  const [docStatus, setDocStatus] = useState("");

  function dName(s) { return incognito ? (aliasMap[s.id] || "??") : s.name; }
  function toggle(arr, setArr, val) { setArr(prev => prev.includes(val) ? prev.filter(x => x !== val) : [...prev, val]); }
  function allToggle(arr, setArr, all) { setArr(arr.length === all.length ? [] : [...all]); }

  const students = allStudents.filter(s => selStudents.includes(s.id));
  const canGenerate = students.length > 0 && selAreas.length > 0 && selSections.length > 0;

  function openPrint() {
    const html = buildReportHTML(students, { areas: selAreas, quarters: selQLbls, sections: selSections, dateFrom, dateTo }, incognito, aliasMap);
    const w = window.open("", "_blank");
    w.document.write(html);
    w.document.close();
    setTimeout(() => w.print(), 600);
  }

  function generateDocx() {
    setDocStatus("generating");
    try {
      const html = buildReportHTML(students, { areas: selAreas, quarters: selQLbls, sections: selSections, dateFrom, dateTo }, incognito, aliasMap);
      const wordHtml = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;font-size:11pt;}table{border-collapse:collapse;width:100%;}th,td{border:1px solid #D1D5DB;padding:5px 8px;}</style></head>
<body>${html.replace(/[\s\S]*<body[^>]*>/, "").replace(/<\/body>[\s\S]*/, "")}</body></html>`;
      const blob = new Blob(["\ufeff", wordHtml], { type: "application/msword" });
      const url = URL.createObjectURL(blob);
      setDocxUrl(url);
      setDocStatus("ready");
    } catch { setDocStatus("error"); }
  }

  const CheckRow = ({ label, checked, onClick, color }) => (
    <button onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px",
      borderRadius: 8, border: `1.5px solid ${checked ? (color || "#4F46E5") : "#D1D5DB"}`,
      background: checked ? (color ? color + "18" : "#EEF2FF") : "#F9FAFB",
      color: checked ? (color || "#4F46E5") : "#374151", fontWeight: checked ? 700 : 400,
      fontSize: 13, cursor: "pointer", width: "100%", textAlign: "left" }}>
      <span style={{ width: 16, height: 16, borderRadius: 4, border: `2px solid ${checked ? (color || "#4F46E5") : "#D1D5DB"}`,
        background: checked ? (color || "#4F46E5") : "#fff", display: "flex", alignItems: "center", justifyContent: "center",
        flexShrink: 0, color: "#fff", fontSize: 10 }}>{checked ? "✓" : ""}</span>
      {label}
    </button>
  );

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", zIndex: 1200,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ background: "#fff", borderRadius: 16, width: "100%", maxWidth: 680,
        boxShadow: "0 12px 40px rgba(0,0,0,.22)", overflow: "hidden", maxHeight: "92vh", display: "flex", flexDirection: "column" }}>
        <div style={{ background: "#4F46E5", padding: "14px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 16, color: "#fff" }}>🖨 Report Builder</div>
            <div style={{ fontSize: 12, color: "#C7D2FE", marginTop: 2 }}>Choose what to include, then print or export</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#fff", fontSize: 20, cursor: "pointer" }}>✕</button>
        </div>
        <div style={{ overflowY: "auto", flex: 1, padding: "20px" }}>
          <div style={{ marginBottom: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 13, color: "#111827" }}>Students</span>
              <button onClick={() => allToggle(selStudents, setSelStudents, allStudents.map(s => s.id))}
                style={{ fontSize: 11, color: "#4F46E5", background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}>
                {selStudents.length === allStudents.length ? "Deselect All" : "Select All"}
              </button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(200px,1fr))", gap: 6 }}>
              {allStudents.map(s => (
                <CheckRow key={s.id} label={dName(s)} checked={selStudents.includes(s.id)} onClick={() => toggle(selStudents, setSelStudents, s.id)} />
              ))}
            </div>
          </div>
          <div style={{ marginBottom: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 13, color: "#111827" }}>Goal Areas</span>
              <button onClick={() => allToggle(selAreas, setSelAreas, GOAL_AREAS)}
                style={{ fontSize: 11, color: "#4F46E5", background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}>
                {selAreas.length === GOAL_AREAS.length ? "Deselect All" : "Select All"}
              </button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 6 }}>
              {GOAL_AREAS.map(a => (
                <CheckRow key={a} label={a} checked={selAreas.includes(a)}
                  color={Object.values(AREA_COLORS)[GOAL_AREAS.indexOf(a)].accent}
                  onClick={() => toggle(selAreas, setSelAreas, a)} />
              ))}
            </div>
          </div>
          {allQLabels.length > 0 && (
            <div style={{ marginBottom: 18 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontWeight: 700, fontSize: 13, color: "#111827" }}>Quarters</span>
                <button onClick={() => allToggle(selQLbls, setSelQLbls, allQLabels)}
                  style={{ fontSize: 11, color: "#4F46E5", background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}>
                  {selQLbls.length === allQLabels.length ? "Deselect All" : "Select All"}
                </button>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(120px,1fr))", gap: 6 }}>
                {allQLabels.map(lbl => (
                  <CheckRow key={lbl} label={lbl} checked={selQLbls.includes(lbl)} onClick={() => toggle(selQLbls, setSelQLbls, lbl)} />
                ))}
              </div>
            </div>
          )}
          <div style={{ marginBottom: 18 }}>
            <span style={{ fontWeight: 700, fontSize: 13, color: "#111827", display: "block", marginBottom: 8 }}>Date Range <span style={{ fontWeight: 400, color: "#9CA3AF" }}>(optional)</span></span>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 11, color: "#6B7280", display: "block", marginBottom: 3 }}>From</label>
                <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
                  style={{ width: "100%", padding: "7px 10px", borderRadius: 8, border: "1px solid #D1D5DB", fontSize: 13, outline: "none" }} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 11, color: "#6B7280", display: "block", marginBottom: 3 }}>To</label>
                <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
                  style={{ width: "100%", padding: "7px 10px", borderRadius: 8, border: "1px solid #D1D5DB", fontSize: 13, outline: "none" }} />
              </div>
              {(dateFrom || dateTo) && (
                <button onClick={() => { setDateFrom(""); setDateTo(""); }}
                  style={{ alignSelf: "flex-end", padding: "7px 12px", borderRadius: 8, border: "1px solid #D1D5DB", background: "#F9FAFB", color: "#374151", fontSize: 12, cursor: "pointer" }}>Clear</button>
              )}
            </div>
          </div>
          <div style={{ marginBottom: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 13, color: "#111827" }}>Include Sections</span>
              <button onClick={() => allToggle(selSections, setSelSections, ["goal", "table", "entries"])}
                style={{ fontSize: 11, color: "#4F46E5", background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}>
                {selSections.length === 3 ? "Deselect All" : "Select All"}
              </button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 6 }}>
              {[["goal", "📋 Goal & Target"], ["table", "📊 Quarterly Summary"], ["entries", "📝 Data Entry Log"]].map(([key, label]) => (
                <CheckRow key={key} label={label} checked={selSections.includes(key)} onClick={() => toggle(selSections, setSelSections, key)} />
              ))}
            </div>
          </div>
          <div style={{ background: "#F0FDF4", borderRadius: 10, padding: "12px 16px", border: "1px solid #D1FAE5" }}>
            <div style={{ fontSize: 12, color: "#15803D", fontWeight: 700, marginBottom: 4 }}>Report will include:</div>
            <div style={{ fontSize: 12, color: "#374151" }}>
              {students.length} student{students.length !== 1 ? "s" : ""} · {selAreas.join(", ") || "no areas"} · {selQLbls.length > 0 ? selQLbls.join(", ") : "all quarters"} · {selSections.length} section{selSections.length !== 1 ? "s" : ""}
            </div>
          </div>
        </div>
        <div style={{ padding: "14px 20px", borderTop: "1px solid #E5E7EB", flexShrink: 0, background: "#F9FAFB" }}>
          {!canGenerate && <div style={{ fontSize: 12, color: "#EF4444", marginBottom: 8 }}>Select at least one student, goal area, and section.</div>}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={openPrint} disabled={!canGenerate}
              style={{ flex: 1, minWidth: 120, padding: "10px 0", borderRadius: 8, border: "none",
                background: canGenerate ? "#4F46E5" : "#D1D5DB", color: "#fff", fontWeight: 700, fontSize: 13, cursor: canGenerate ? "pointer" : "not-allowed" }}>
              🖨 Print / Save PDF
            </button>
            <button onClick={generateDocx} disabled={!canGenerate}
              style={{ flex: 1, minWidth: 120, padding: "10px 0", borderRadius: 8, border: "none",
                background: canGenerate ? "#2563EB" : "#D1D5DB", color: "#fff", fontWeight: 700, fontSize: 13, cursor: canGenerate ? "pointer" : "not-allowed" }}>
              {docStatus === "generating" ? "⏳ Generating…" : "📄 Download Word Doc"}
            </button>
          </div>
          {docStatus === "ready" && docxUrl && (
            <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10, background: "#DCFCE7", borderRadius: 8, padding: "8px 12px" }}>
              <span style={{ fontSize: 12, color: "#15803D", fontWeight: 600 }}>✓ Word doc ready!</span>
              <a href={docxUrl} download="IEP_Progress_Report.doc"
                style={{ fontSize: 12, color: "#15803D", fontWeight: 700, textDecoration: "underline", cursor: "pointer" }}>
                Click here to download
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [data, setData] = useState(null);
  const [view, setView] = useState("roster");
  const [search, setSearch] = useState("");
  const [goalFilter, setGoalFilter] = useState("Reading");
  const [selectedStudent, setSelectedStudent] = useState(null);
  const [editingGoal, setEditingGoal] = useState(null);
  const [entryModal, setEntryModal] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showAddStudent, setShowAddStudent] = useState(false);
  const [newStudentName, setNewStudentName] = useState("");
  const [flash, setFlash] = useState(null);
  const [expandedQ, setExpandedQ] = useState({});
  const [showCsvImport, setShowCsvImport] = useState(false);
  const [showReportBuilder, setShowReportBuilder] = useState(false);
  const [incognito, setIncognito] = useState(false);
  const [incognitoMode, setIncognitoMode] = useState("initials");
  const [quarterMgrStudent, setQuarterMgrStudent] = useState(null);
  const [activeQuarterIds, setActiveQuarterIds] = useState({});

  // Google Drive state
  const [driveStatus, setDriveStatus] = useState("idle"); // idle | connecting | synced | error
  const [driveToken, setDriveToken] = useState(null);
  const [driveFileId, setDriveFileId] = useState(null);
  const [driveEmail, setDriveEmail] = useState(null);
  const [driveSaving, setDriveSaving] = useState(false);

  // Load from localStorage on mount
  useEffect(() => {
    const stored = loadLocal();
    if (stored) { setData(stored); setView(stored.settings?.defaultView || "roster"); }
    else { const s = seedData(); setData(s); setView(s.settings.defaultView); saveLocal(s); }
  }, []);

  const showFlash = msg => { setFlash(msg); setTimeout(() => setFlash(null), 2500); };

  // ── Google Drive connect ──────────────────────────────────────────────────
  async function driveConnect() {
    setDriveStatus("connecting");
    try {
      const token = await getAccessToken();
      setDriveToken(token);
      const email = await getUserEmail(token);
      setDriveEmail(email);

      // Find existing file or create one
      let file = await driveFindFile(token);
      if (file) {
        const remote = await driveReadFile(token, file.id);
        const local = loadLocal();
        const merged = mergeData(local, remote);
        setData(merged);
        saveLocal(merged);
        setDriveFileId(file.id);
        showFlash("✅ Google Drive connected — data loaded!");
      } else {
        const local = loadLocal() || seedData();
        const newId = await driveWriteFile(token, null, local);
        setDriveFileId(newId);
        showFlash("✅ Google Drive connected — data saved to your Drive!");
      }
      setDriveStatus("synced");
    } catch (e) {
      console.error("Drive connect error:", e);
      setDriveStatus("error");
      showFlash("⚠️ Drive connection failed. Check popup blocker or try again.");
    }
  }

  function driveDisconnect() {
    // Revoke token if possible
    if (driveToken && window.google?.accounts?.oauth2) {
      window.google.accounts.oauth2.revoke(driveToken, () => {});
    }
    setDriveToken(null); setDriveFileId(null); setDriveEmail(null);
    setDriveStatus("idle");
    showFlash("Google Drive disconnected");
  }

  // ── Persist: save locally + push to Drive ────────────────────────────────
  const persist = useCallback(async (next) => {
    setData(next);
    saveLocal(next);
    if (driveToken && driveStatus === "synced") {
      setDriveSaving(true);
      try {
        let fid = driveFileId;
        if (!fid) {
          const found = await driveFindFile(driveToken);
          fid = found?.id || null;
          if (fid) setDriveFileId(fid);
        }
        await driveWriteFile(driveToken, fid, next);
      } catch (e) {
        console.error("Drive save error:", e);
        showFlash("⚠️ Drive save failed — data saved locally");
      } finally {
        setDriveSaving(false);
      }
    }
  }, [driveToken, driveFileId, driveStatus]);

  // Keyboard shortcut for incognito
  useEffect(() => {
    function handleKey(e) {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "I") { e.preventDefault(); setIncognito(p => !p); }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  const aliasMap = useMemo(
    () => buildAliasMap(data ? data.students : [], incognitoMode),
    [data, incognitoMode]
  );

  if (!data) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", fontFamily: "sans-serif", color: "#6B7280" }}>
      Loading…
    </div>
  );

  const filteredStudents = data.students.filter(s => s.name.toLowerCase().includes(search.toLowerCase()));
  function displayName(s) { return incognito ? (aliasMap[s.id] || "??") : s.name; }
  function displayAvatar(s) { return incognito ? (aliasMap[s.id] || "?") : s.name[0]; }

  // ── Quarter helpers ────────────────────────────────────────────────────────
  function getStudentQuarters(student) { return [...(student.quarters || [])].sort((a, b) => a.order - b.order); }
  function activeQId(student) { return activeQuarterIds[student.id] || getStudentQuarters(student)[0]?.id || null; }
  function setActiveQ(studentId, qId) { setActiveQuarterIds(prev => ({ ...prev, [studentId]: qId })); }

  // ── Mutations ──────────────────────────────────────────────────────────────
  function addEntry(studentId, area, quarterId, entry) {
    const next = { ...data, students: data.students.map(s => s.id !== studentId ? s : {
      ...s, goals: { ...s.goals, [area]: { ...s.goals[area],
        entries: { ...s.goals[area].entries, [quarterId]: [...(s.goals[area].entries[quarterId] || []), entry] } } }
    }) };
    persist(next); showFlash("Entry saved ✓"); setEntryModal(null);
  }
  function deleteEntry(studentId, area, quarterId, entryId) {
    const next = { ...data, students: data.students.map(s => s.id !== studentId ? s : {
      ...s, goals: { ...s.goals, [area]: { ...s.goals[area],
        entries: { ...s.goals[area].entries, [quarterId]: (s.goals[area].entries[quarterId] || []).filter(e => e.id !== entryId) } } }
    }) };
    persist(next); showFlash("Entry removed");
  }
  function updateGoalMeta(studentId, area, field, value) {
    const next = { ...data, students: data.students.map(s => s.id !== studentId ? s : {
      ...s, goals: { ...s.goals, [area]: { ...s.goals[area], [field]: field === "target" ? Number(value) : value } }
    }) };
    persist(next);
  }
  function saveQuarters(studentId, quarters) {
    const next = { ...data, students: data.students.map(s => {
      if (s.id !== studentId) return s;
      const goals = {};
      GOAL_AREAS.forEach(area => {
        const entries = { ...(s.goals[area].entries || {}) };
        quarters.forEach(q => { if (!entries[q.id]) entries[q.id] = []; });
        goals[area] = { ...s.goals[area], entries };
      });
      return { ...s, quarters, goals };
    }) };
    persist(next); setQuarterMgrStudent(null); showFlash("Quarters saved ✓");
  }
  function addStudent() {
    if (!newStudentName.trim()) return;
    const id = "s" + Date.now(); const qId = "q" + Date.now();
    const quarters = [{ id: qId, label: "Q1-25", order: 0 }];
    const goals = {};
    GOAL_AREAS.forEach(a => { goals[a] = { description: "", target: 80, behaviorType: a === "Behavior" ? "obs" : null, entries: { [qId]: [] } }; });
    persist({ ...data, students: [...data.students, { id, name: newStudentName.trim(), quarters, goals }] });
    setNewStudentName(""); setShowAddStudent(false); showFlash(`${newStudentName.trim()} added!`);
  }
  function deleteStudent(id) {
    persist({ ...data, students: data.students.filter(s => s.id !== id) });
    if (selectedStudent === id) setSelectedStudent(null);
  }
  function setDefaultView(v) { persist({ ...data, settings: { ...data.settings, defaultView: v } }); showFlash("Default view saved!"); }
  function handleCsvImport(items) {
    let next = { ...data, students: [...data.students] };
    items.forEach(({ studentId, area, quarterId, entry }) => {
      next = { ...next, students: next.students.map(s => s.id !== studentId ? s : {
        ...s, goals: { ...s.goals, [area]: { ...s.goals[area],
          entries: { ...s.goals[area].entries, [quarterId]: [...(s.goals[area].entries[quarterId] || []), entry] } } }
      }) };
    });
    persist(next); showFlash(`${items.length} ${items.length === 1 ? "entry" : "entries"} imported ✓`);
  }
  function toggleExpandQ(key) { setExpandedQ(prev => ({ ...prev, [key]: !prev[key] })); }

  // ── Roster View ────────────────────────────────────────────────────────────
  function RosterView() {
    return (
      <div>
        {filteredStudents.length === 0 && <div style={{ textAlign: "center", color: "#9CA3AF", padding: "48px 0", fontSize: 15 }}>No students found.</div>}
        {filteredStudents.map(student => {
          const quarters = getStudentQuarters(student);
          const latestQ = quarters[quarters.length - 1];
          return (
            <div key={student.id} style={{ background: "#fff", borderRadius: 12, border: "1px solid #E5E7EB", marginBottom: 16, overflow: "hidden", boxShadow: "0 1px 4px rgba(0,0,0,.06)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderBottom: "1px solid #F3F4F6", background: "#F9FAFB" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ width: 34, height: 34, borderRadius: "50%", background: "#6366F1", display: "flex", alignItems: "center", justifyContent: "center",
                    color: "#fff", fontWeight: 700, fontSize: incognito && incognitoMode === "animals" ? 20 : 14 }}>{displayAvatar(student)}</div>
                  <div>
                    <span style={{ fontWeight: 700, fontSize: 16, color: "#111827" }}>{displayName(student)}</span>
                    <div style={{ fontSize: 11, color: "#9CA3AF", marginTop: 1 }}>
                      {quarters.length} quarter{quarters.length !== 1 ? "s" : ""}{latestQ ? ` · latest: ${latestQ.label}` : ""}
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => { setSelectedStudent(student.id); setView("student"); }}
                    style={{ fontSize: 13, color: "#4F46E5", background: "#EEF2FF", border: "none", borderRadius: 6, padding: "5px 12px", cursor: "pointer", fontWeight: 600 }}>
                    View Detail
                  </button>
                  <button onClick={() => { if (window.confirm(`Remove ${incognito ? "this student" : student.name}?`)) deleteStudent(student.id); }}
                    style={{ fontSize: 13, color: "#EF4444", background: "#FEE2E2", border: "none", borderRadius: 6, padding: "5px 10px", cursor: "pointer" }}>✕</button>
                </div>
              </div>
              <div style={{ padding: "12px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
                {GOAL_AREAS.map(area => {
                  const goal = student.goals[area];
                  const { badge, text } = AREA_COLORS[area];
                  const avg = latestQ ? quarterAvg(goal.entries[latestQ.id] || []) : null;
                  return (
                    <div key={area} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <span style={{ fontSize: 12, fontWeight: 700, padding: "3px 10px", borderRadius: 99, background: badge, color: text, minWidth: 68, textAlign: "center" }}>{area}</span>
                      <div style={{ flex: 1 }}><ScoreBar score={avg} target={goal.target} /></div>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "#374151", minWidth: 36, textAlign: "right" }}>{avg !== null ? `${avg}%` : "—"}</span>
                      <StatusBadge score={avg} target={goal.target} />
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // ── Goal Area View ──────────────────────────────────────────────────────────
  function GoalView() {
    const { accent, bg, text } = AREA_COLORS[goalFilter];
    const allLabels = [];
    filteredStudents.forEach(s => getStudentQuarters(s).forEach(q => { if (!allLabels.includes(q.label)) allLabels.push(q.label); }));
    return (
      <div>
        <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
          {GOAL_AREAS.map(a => (
            <button key={a} onClick={() => setGoalFilter(a)}
              style={{ padding: "7px 18px", borderRadius: 99, border: "none", cursor: "pointer", fontWeight: 700, fontSize: 13,
                background: goalFilter === a ? AREA_COLORS[a].accent : "#F3F4F6", color: goalFilter === a ? "#fff" : "#374151" }}>{a}</button>
          ))}
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", background: "#fff", borderRadius: 12, overflow: "hidden", boxShadow: "0 1px 4px rgba(0,0,0,.06)" }}>
            <thead>
              <tr style={{ background: bg, borderBottom: `2px solid ${accent}` }}>
                <th style={{ padding: "10px 16px", textAlign: "left", fontWeight: 700, color: text, fontSize: 13, minWidth: 160 }}>Student</th>
                <th style={{ padding: "10px 12px", textAlign: "center", fontWeight: 700, color: text, fontSize: 13, minWidth: 70 }}>Target</th>
                {allLabels.map(lbl => (
                  <th key={lbl} style={{ padding: "10px 12px", textAlign: "center", fontWeight: 700, color: text, fontSize: 13, minWidth: 90 }}>{lbl}</th>
                ))}
                <th style={{ padding: "10px 12px", textAlign: "center", fontWeight: 700, color: text, fontSize: 13, minWidth: 120 }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {filteredStudents.length === 0 && (
                <tr><td colSpan={allLabels.length + 3} style={{ padding: "32px", textAlign: "center", color: "#9CA3AF" }}>No students found.</td></tr>
              )}
              {filteredStudents.map((student, i) => {
                const goal = student.goals[goalFilter];
                const quarters = getStudentQuarters(student);
                const avgByLabel = {};
                quarters.forEach(q => { avgByLabel[q.label] = quarterAvg(goal.entries[q.id] || []); });
                const latestQ = quarters[quarters.length - 1];
                const latestAvg = latestQ ? avgByLabel[latestQ.label] : null;
                return (
                  <tr key={student.id} style={{ background: i % 2 === 0 ? "#FAFAFA" : "#fff", borderBottom: "1px solid #F3F4F6" }}>
                    <td style={{ padding: "10px 16px" }}>
                      <button onClick={() => { setSelectedStudent(student.id); setView("student"); }}
                        style={{ background: "none", border: "none", cursor: "pointer", fontWeight: 600, color: "#4F46E5", fontSize: 14, textAlign: "left" }}>
                        {displayName(student)}
                      </button>
                    </td>
                    <td style={{ textAlign: "center", fontSize: 13, fontWeight: 600, color: "#374151", padding: "10px 12px" }}>{goal.target}%</td>
                    {allLabels.map(lbl => {
                      const avg = avgByLabel[lbl];
                      const hasQ = quarters.find(q => q.label === lbl);
                      const cnt = hasQ ? (goal.entries[hasQ.id] || []).length : 0;
                      return (
                        <td key={lbl} style={{ textAlign: "center", padding: "10px 12px" }}>
                          {hasQ ? (
                            <div>
                              <div style={{ fontWeight: 700, fontSize: 14, color: avg !== null ? STATUS[getStatus(avg, goal.target)].color : "#9CA3AF" }}>{avg !== null ? `${avg}%` : "—"}</div>
                              <div style={{ fontSize: 10, color: "#9CA3AF" }}>{cnt} {cnt === 1 ? "entry" : "entries"}</div>
                            </div>
                          ) : <span style={{ color: "#D1D5DB", fontSize: 12 }}>—</span>}
                        </td>
                      );
                    })}
                    <td style={{ textAlign: "center", padding: "10px 12px" }}>
                      <StatusBadge score={latestAvg} target={goal.target} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // ── Student Detail View ────────────────────────────────────────────────────
  function StudentDetailView() {
    const student = data.students.find(s => s.id === selectedStudent);
    if (!student) return null;
    const quarters = getStudentQuarters(student);
    const currentQId = activeQId(student);
    const currentQ = quarters.find(q => q.id === currentQId) || quarters[0];

    return (
      <div>
        <button onClick={() => setView(data.settings.defaultView)}
          style={{ marginBottom: 16, background: "none", border: "none", cursor: "pointer", color: "#4F46E5", fontWeight: 600, fontSize: 14, display: "flex", alignItems: "center", gap: 6 }}>
          ← Back
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <div style={{ width: 48, height: 48, borderRadius: "50%", background: "#6366F1", display: "flex", alignItems: "center", justifyContent: "center",
            color: "#fff", fontWeight: 800, fontSize: incognito && incognitoMode === "animals" ? 28 : 20 }}>{displayAvatar(student)}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 800, fontSize: 22, color: "#111827" }}>{displayName(student)}</div>
            <div style={{ fontSize: 13, color: "#6B7280" }}>IEP Progress — All Goal Areas</div>
          </div>
          <button onClick={() => setQuarterMgrStudent(student)}
            style={{ fontSize: 13, background: "#EEF2FF", color: "#4F46E5", border: "none", borderRadius: 8, padding: "7px 14px", cursor: "pointer", fontWeight: 700 }}>
            📅 Manage Quarters
          </button>
        </div>

        <div style={{ display: "flex", gap: 6, marginBottom: 20, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: "#6B7280", marginRight: 4 }}>Quarter:</span>
          {quarters.map(q => (
            <button key={q.id} onClick={() => setActiveQ(student.id, q.id)}
              style={{ padding: "6px 14px", borderRadius: 99, border: "2px solid",
                borderColor: currentQId === q.id ? "#4F46E5" : "#D1D5DB",
                background: currentQId === q.id ? "#4F46E5" : "#fff",
                color: currentQId === q.id ? "#fff" : "#374151",
                fontWeight: 700, fontSize: 13, cursor: "pointer" }}>{q.label}</button>
          ))}
          {quarters.length === 0 && <span style={{ fontSize: 13, color: "#9CA3AF" }}>No quarters — click Manage Quarters to add.</span>}
        </div>

        {GOAL_AREAS.map(area => {
          const goal = student.goals[area];
          const { accent, bg, text } = AREA_COLORS[area];
          const isEditing = editingGoal?.studentId === student.id && editingGoal?.area === area;
          const qEntries = currentQ ? (goal.entries[currentQ.id] || []) : [];
          const avg = quarterAvg(qEntries);
          const trendData = quarters.map(q => ({ label: q.label, avg: quarterAvg(goal.entries[q.id] || []), target: goal.target }));
          const hasTrend = trendData.some(d => d.avg !== null);
          const expandKey = `${student.id}-${area}-trend`;
          const trendOpen = !!expandedQ[expandKey];

          return (
            <div key={area} style={{ background: "#fff", borderRadius: 12, border: "1px solid #E5E7EB", marginBottom: 16, overflow: "hidden", boxShadow: "0 1px 4px rgba(0,0,0,.06)" }}>
              <div style={{ background: bg, padding: "12px 20px", borderBottom: `2px solid ${accent}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontWeight: 800, fontSize: 16, color: text }}>{area}</span>
                  <StatusBadge score={avg} target={goal.target} />
                  {currentQ && <span style={{ fontSize: 11, color: text, opacity: .7 }}>{currentQ.label}</span>}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  {hasTrend && (
                    <button onClick={() => toggleExpandQ(expandKey)}
                      style={{ fontSize: 12, background: "rgba(0,0,0,.08)", color: text, border: "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontWeight: 600 }}>
                      {trendOpen ? "Hide Trend" : "📈 Trend"}
                    </button>
                  )}
                  <button onClick={() => setEditingGoal(isEditing ? null : { studentId: student.id, area })}
                    style={{ fontSize: 12, background: accent, color: "#fff", border: "none", borderRadius: 6, padding: "4px 12px", cursor: "pointer", fontWeight: 600 }}>
                    {isEditing ? "Done" : "Edit Goal"}
                  </button>
                </div>
              </div>

              <div style={{ padding: "16px 20px" }}>
                {isEditing ? (
                  <div style={{ marginBottom: 16, background: "#F9FAFB", borderRadius: 8, padding: "12px 14px", border: "1px solid #E5E7EB", display: "flex", flexDirection: "column", gap: 10 }}>
                    <div>
                      <label style={{ fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 4 }}>Goal Description</label>
                      <textarea value={goal.description} onChange={e => updateGoalMeta(student.id, area, "description", e.target.value)} rows={2}
                        style={{ width: "100%", borderRadius: 6, border: "1px solid #D1D5DB", padding: "8px 10px", fontSize: 13, resize: "vertical", fontFamily: "inherit", boxSizing: "border-box" }} />
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <label style={{ fontSize: 12, fontWeight: 600, color: "#374151" }}>Mastery Target %</label>
                      <input type="number" min={0} max={100} value={goal.target} onChange={e => updateGoalMeta(student.id, area, "target", e.target.value)}
                        style={{ width: 72, padding: "5px 8px", borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 14, textAlign: "center" }} />
                    </div>
                    {area === "Behavior" && (
                      <div>
                        <label style={{ fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>Behavior goal type</label>
                        <div style={{ display: "flex", gap: 8 }}>
                          {[["obs", "Observational (Yes / No)"], ["scored", "Scored (correct / total)"]].map(([val, lbl]) => (
                            <button key={val} onClick={() => updateGoalMeta(student.id, area, "behaviorType", val)}
                              style={{ flex: 1, padding: "8px 0", borderRadius: 8, border: "2px solid",
                                borderColor: goal.behaviorType === val ? accent : "#D1D5DB",
                                background: goal.behaviorType === val ? bg : "#fff",
                                color: goal.behaviorType === val ? text : "#374151",
                                fontWeight: 700, fontSize: 12, cursor: "pointer" }}>{lbl}</button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{ marginBottom: 14 }}>
                    <p style={{ fontSize: 13, color: "#4B5563", lineHeight: 1.6, margin: "0 0 4px 0" }}>
                      {goal.description || <em style={{ color: "#9CA3AF" }}>No goal description yet — click Edit Goal.</em>}
                    </p>
                    <span style={{ fontSize: 12, color: "#9CA3AF" }}>Mastery target: {goal.target}%{area === "Behavior" ? ` · ${goal.behaviorType === "obs" ? "Observational" : "Scored"}` : ""}</span>
                  </div>
                )}

                {trendOpen && hasTrend && (
                  <div style={{ marginBottom: 20, background: "#F9FAFB", borderRadius: 10, padding: "14px 16px", border: "1px solid #E5E7EB" }}>
                    <div style={{ fontWeight: 700, fontSize: 13, color: "#374151", marginBottom: 12 }}>Progress Across All Quarters</div>
                    <ResponsiveContainer width="100%" height={160}>
                      <LineChart data={trendData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
                        <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#6B7280" }} />
                        <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: "#6B7280" }} unit="%" />
                        <Tooltip formatter={(v, n) => [v !== null ? `${v}%` : "—", n === "avg" ? "Score" : "Target"]} />
                        <ReferenceLine y={goal.target} stroke="#374151" strokeDasharray="4 2"
                          label={{ value: `Target ${goal.target}%`, position: "insideTopRight", fontSize: 10, fill: "#374151" }} />
                        <Line type="monotone" dataKey="avg" stroke={accent} strokeWidth={2.5} dot={{ r: 4, fill: accent }} connectNulls={false} name="avg" />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}

                {currentQ && (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                      <span style={{ fontSize: 12, color: "#6B7280" }}>{currentQ.label} average</span>
                      <span style={{ fontWeight: 700, color: "#111827", fontSize: 14 }}>{avg !== null ? `${avg}%` : "—"}</span>
                    </div>
                    <ScoreBar score={avg} target={goal.target} />
                    <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
                      <span style={{ fontSize: 11, color: "#9CA3AF" }}>▲ Target: {goal.target}%</span>
                    </div>
                  </div>
                )}

                {currentQ && (
                  <div>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: "#374151" }}>
                        Entries — {currentQ.label} ({qEntries.length})
                      </span>
                      <button onClick={() => setEntryModal({ studentId: student.id, area, quarterId: currentQ.id, quarterLabel: currentQ.label })}
                        style={{ fontSize: 12, background: accent, color: "#fff", border: "none", borderRadius: 6, padding: "5px 12px", cursor: "pointer", fontWeight: 700 }}>
                        + Add Entry
                      </button>
                    </div>
                    {qEntries.length === 0 ? (
                      <div style={{ fontSize: 13, color: "#9CA3AF", textAlign: "center", padding: "16px 0", background: "#F9FAFB", borderRadius: 8 }}>
                        No entries yet for {currentQ.label}.
                      </div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {[...qEntries].sort((a, b) => b.date.localeCompare(a.date)).map(entry => (
                          <EntryRow key={entry.id} entry={entry} accentColor={accent}
                            onDelete={() => deleteEntry(student.id, area, currentQ.id, entry.id)} />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // ── Layout ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: "100vh", background: "#F1F5F9", fontFamily: "'Inter', system-ui, sans-serif" }}>
      {/* Top bar */}
      <div style={{ background: "#4F46E5", color: "#fff", padding: "0 24px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 56, boxShadow: "0 2px 8px rgba(79,70,229,.4)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 20 }}>📊</span>
          <span style={{ fontWeight: 800, fontSize: 17, letterSpacing: "-.3px" }}>IEP Progress Monitor</span>
          {incognito && <span style={{ fontSize: 11, fontWeight: 700, background: "#312E81", color: "#C7D2FE", borderRadius: 99, padding: "2px 10px" }}>🔒 INCOGNITO</span>}
          {driveSaving && <span style={{ fontSize: 11, color: "#C7D2FE" }}>💾 Saving…</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {driveStatus === "synced" && (
            <span style={{ fontSize: 12, color: "#A5F3FC", fontWeight: 600 }}>✅ Drive synced</span>
          )}
          <button onClick={() => setIncognito(i => !i)} title="Ctrl+Shift+I"
            style={{ background: incognito ? "#C7D2FE" : "rgba(255,255,255,.15)", border: "none", borderRadius: 8,
              color: incognito ? "#312E81" : "#fff", padding: "6px 14px", cursor: "pointer", fontSize: 13, fontWeight: 700 }}>
            {incognito ? "👁 Privacy On" : "👁 Privacy Off"}
          </button>
          <button onClick={() => setShowSettings(!showSettings)}
            style={{ background: "rgba(255,255,255,.15)", border: "none", borderRadius: 8, color: "#fff", padding: "6px 14px", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
            ⚙ Settings
          </button>
        </div>
      </div>

      {/* Settings panel */}
      {showSettings && (
        <div style={{ background: "#EEF2FF", borderBottom: "1px solid #C7D2FE", padding: "16px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Default view */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 700, color: "#3730A3", fontSize: 14, minWidth: 110 }}>Default view:</span>
            {["roster", "goal"].map(v => (
              <button key={v} onClick={() => { setDefaultView(v); setShowSettings(false); }}
                style={{ padding: "6px 16px", borderRadius: 8, border: "2px solid",
                  borderColor: data.settings.defaultView === v ? "#4F46E5" : "#C7D2FE",
                  background: data.settings.defaultView === v ? "#4F46E5" : "#fff",
                  color: data.settings.defaultView === v ? "#fff" : "#4F46E5",
                  fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
                {v === "roster" ? "📋 Roster View" : "🎯 Goal Area View"}
              </button>
            ))}
          </div>

          {/* Privacy display */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#3730A3", minWidth: 110 }}>Privacy display:</span>
            {INCOGNITO_MODES.map(m => (
              <button key={m.key} onClick={() => { setIncognitoMode(m.key); showFlash(`Privacy display: ${m.label}`); }}
                style={{ padding: "5px 12px", borderRadius: 8, border: "2px solid",
                  borderColor: incognitoMode === m.key ? "#4F46E5" : "#C7D2FE",
                  background: incognitoMode === m.key ? "#4F46E5" : "#fff",
                  color: incognitoMode === m.key ? "#fff" : "#4F46E5",
                  fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
                {m.icon} {m.label}
              </button>
            ))}
            <span style={{ fontSize: 11, color: "#6B7280" }}>Shortcut: Ctrl+Shift+I</span>
          </div>

          {/* Google Drive */}
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#3730A3", minWidth: 110, paddingTop: 2 }}>Google Drive:</span>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {driveStatus === "idle" || driveStatus === "error" ? (
                <button onClick={driveConnect}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 16px",
                    borderRadius: 8, border: "2px solid #4285F4", background: "#fff",
                    color: "#4285F4", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
                  <svg width="18" height="18" viewBox="0 0 48 48">
                    <path fill="#4285F4" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                    <path fill="#34A853" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                    <path fill="#EA4335" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
                  </svg>
                  Connect Google Drive
                </button>
              ) : driveStatus === "connecting" ? (
                <span style={{ fontSize: 13, color: "#D97706", fontWeight: 600 }}>⏳ Connecting…</span>
              ) : (
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 13, color: "#15803D", fontWeight: 600 }}>✅ Connected{driveEmail ? ` — ${driveEmail}` : ""}</span>
                  <button onClick={driveDisconnect}
                    style={{ fontSize: 12, color: "#6B7280", background: "none", border: "1px solid #D1D5DB", borderRadius: 6, padding: "3px 10px", cursor: "pointer" }}>
                    Disconnect
                  </button>
                </div>
              )}
              <p style={{ fontSize: 11, color: "#6B7280", maxWidth: 420 }}>
                🔒 Your data is saved only to <strong>your own</strong> Google Drive. Under Construction Education never sees or touches your students' data.
              </p>
            </div>
          </div>

          <button onClick={() => setShowSettings(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "#6366F1", fontWeight: 600, alignSelf: "flex-start" }}>Close</button>
        </div>
      )}

      {/* Main content */}
      <div style={{ maxWidth: 960, margin: "0 auto", padding: "24px 16px" }}>
        {/* Toolbar */}
        {view !== "student" && (
          <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍  Search students…"
              style={{ flex: 1, minWidth: 180, padding: "9px 14px", borderRadius: 8, border: "1px solid #D1D5DB", fontSize: 14, outline: "none", boxShadow: "0 1px 3px rgba(0,0,0,.06)" }} />
            <button onClick={() => setView("roster")}
              style={{ padding: "9px 18px", borderRadius: 8, border: "2px solid", borderColor: view === "roster" ? "#4F46E5" : "#D1D5DB",
                background: view === "roster" ? "#4F46E5" : "#fff", color: view === "roster" ? "#fff" : "#374151", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>📋 Roster</button>
            <button onClick={() => setView("goal")}
              style={{ padding: "9px 18px", borderRadius: 8, border: "2px solid", borderColor: view === "goal" ? "#4F46E5" : "#D1D5DB",
                background: view === "goal" ? "#4F46E5" : "#fff", color: view === "goal" ? "#fff" : "#374151", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>🎯 By Goal</button>
            <button onClick={() => setShowAddStudent(true)}
              style={{ padding: "9px 18px", borderRadius: 8, border: "2px solid #22C55E", background: "#22C55E", color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>+ Add Student</button>
            <button onClick={() => setShowCsvImport(true)}
              style={{ padding: "9px 18px", borderRadius: 8, border: "2px solid #6366F1", background: "#6366F1", color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>📂 Import CSV</button>
            <button onClick={() => setShowReportBuilder(true)}
              style={{ padding: "9px 18px", borderRadius: 8, border: "2px solid #0891B2", background: "#0891B2", color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>🖨 Report</button>
          </div>
        )}

        {/* Add student */}
        {showAddStudent && (
          <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #D1D5DB", padding: "16px 20px", marginBottom: 20, display: "flex", gap: 10, alignItems: "center", boxShadow: "0 2px 8px rgba(0,0,0,.08)" }}>
            <input value={newStudentName} onChange={e => setNewStudentName(e.target.value)}
              onKeyDown={e => e.key === "Enter" && addStudent()} placeholder="Student name…" autoFocus
              style={{ flex: 1, padding: "8px 12px", borderRadius: 8, border: "1px solid #D1D5DB", fontSize: 14, outline: "none" }} />
            <button onClick={addStudent} style={{ padding: "8px 20px", background: "#4F46E5", color: "#fff", border: "none", borderRadius: 8, fontWeight: 700, cursor: "pointer", fontSize: 14 }}>Add</button>
            <button onClick={() => { setShowAddStudent(false); setNewStudentName(""); }} style={{ padding: "8px 14px", background: "#F3F4F6", color: "#374151", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 14 }}>Cancel</button>
          </div>
        )}

        {view === "roster" && <RosterView />}
        {view === "goal" && <GoalView />}
        {view === "student" && <StudentDetailView />}
      </div>

      {/* Modals */}
      {showReportBuilder && <ReportBuilderModal allStudents={data.students} onClose={() => setShowReportBuilder(false)} incognito={incognito} aliasMap={aliasMap} />}
      {quarterMgrStudent && <QuarterManagerModal student={quarterMgrStudent} onSave={q => saveQuarters(quarterMgrStudent.id, q)} onClose={() => setQuarterMgrStudent(null)} />}
      {showCsvImport && <CsvImportModal students={data.students} onImport={handleCsvImport} onClose={() => setShowCsvImport(false)} incognito={incognito} aliasMap={aliasMap} />}
      {entryModal && <EntryModal goal={data.students.find(s => s.id === entryModal.studentId)?.goals[entryModal.area]} area={entryModal.area} quarterLabel={entryModal.quarterLabel} onSave={entry => addEntry(entryModal.studentId, entryModal.area, entryModal.quarterId, entry)} onClose={() => setEntryModal(null)} />}

      {/* Toast */}
      {flash && <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: "#1F2937", color: "#fff", padding: "10px 24px", borderRadius: 99, fontWeight: 600, fontSize: 14, boxShadow: "0 4px 16px rgba(0,0,0,.25)", zIndex: 9999, pointerEvents: "none" }}>{flash}</div>}
    </div>
  );
}
