// Google Sheets logging
const SHEET_WEBHOOK = "https://script.google.com/macros/s/AKfycbzPil5g2VOQnK0DBLmWLfdkOzPVprtFk1D7a0z06_Oew3uYW6Qtrz0H3aUYjMmFD5p60A/exec";

// Scouting Network — Google Sheet CSV + webhook
// SETUP: In the Google Sheet go to Extensions → Apps Script, paste the script below, deploy as Web App.
/*
  ---- APPS SCRIPT (paste into Extensions > Apps Script on the Scouting sheet) ----

  function doPost(e) {
    const data = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const scoutTab = ss.getSheets()[0];
    const values = scoutTab.getDataRange().getValues();
    const headers = values[0];
    const nameIdx = headers.indexOf("Name");
    const colIdx  = f => headers.indexOf(f);

    if (data.action === "updateScout") {
      for (let i = 1; i < values.length; i++) {
        if (values[i][nameIdx] === data.scout) {
          const fi = colIdx(data.field);
          if (fi >= 0) scoutTab.getRange(i+1, fi+1).setValue(data.value);
          if (data.allFields) {
            Object.entries(data.allFields).forEach(([field, val]) => {
              const ci = colIdx(field);
              if (ci >= 0 && !values[i][ci]) scoutTab.getRange(i+1, ci+1).setValue(val);
            });
          }
          break;
        }
      }
    }

    if (data.action === "addScout") {
      scoutTab.appendRow([
        data.name, data.country||"", data.genre||"",
        data.communication||"", data.status||"Active", data.notes||""
      ]);
    }

    if (data.action === "deleteScout") {
      for (let i = 1; i < values.length; i++) {
        if (values[i][nameIdx] === data.scout) { scoutTab.deleteRow(i+1); break; }
      }
    }

    if (data.action === "addProject") {
      let tab = ss.getSheetByName("Projects");
      if (!tab) {
        tab = ss.insertSheet("Projects");
        tab.appendRow(["Scout","Project","Amount","Currency","Date","Notes"]);
      }
      tab.appendRow([data.scout, data.projectName, data.amount, data.currency||"EUR", data.date, data.notes||""]);
    }

    return ContentService.createTextOutput("ok");
  }
  ---- END APPS SCRIPT ----
*/
const SCOUT_SHEET_CSV = "https://docs.google.com/spreadsheets/d/1Xfkee4wTUvomkKVpdiN3Ly4JdHDzRJ3jfGVDZbmGNXc/export?format=csv";
const SCOUT_WEBHOOK = "https://script.google.com/macros/s/AKfycbz1aIv98_ES1kHW1Z22XR31ILZcBHlaBkiTBSnKXRGZFTz6Fh2jkEMDLRLeRtuNoeI/exec";

// ============ CONSTANTS ============

const RESEARCH_PLATFORMS = [
  { name: 'Spotify', icon: '&#127925;', urlTemplate: 'https://open.spotify.com/search/{artist}' },
  { name: 'Instagram', icon: '&#128247;', urlTemplate: 'https://www.google.com/search?q={artist}+instagram' },
];

const PIPELINE_STAGES = [
  { key: 'new',        label: 'New',        color: '#94a3b8' },
  { key: 'contacted',  label: 'Contacted',  color: '#0ea5e9' },
  { key: 'no-reply',   label: 'No Reply',   color: '#64748b' },
  { key: 'replied',    label: 'Replied',    color: '#8b5cf6' },
  { key: 'meeting',    label: 'Meeting',    color: '#f59e0b' },
  { key: 'offer',      label: 'Offer Sent', color: '#6366f1' },
  { key: 'signed',     label: 'Signed',     color: '#10b981' },
  { key: 'passed',     label: 'Passed',     color: '#ef4444' },
];

// ============ STATE ============
let allSounds = [];
let filteredSounds = [];
let currentSound = null;
let currentType = "email";
let displayCount = 10;
let searchTimeout = null;
let activePipelineFilter = "all";
let selectedSounds = new Set();
let batchMode = false;
let batchIgQueue = [];
let batchIgIndex = 0;

// CRM state
let activeCRMFilter = "all";
let quickAddPendingData = null; // { artist, songName, tiktokLink, spotifyLink }
let currentQAFTab = "email"; // "email" | "instagram" | "none"

// Scouting state
let _scoutFilter = "all"; // "all" | "Active" | "Not active"
let _expandedScouts = new Set(); // scout names currently expanded

// ============ DOM REFS ============
const pageList = document.getElementById("page-list");
const pageOutreach = document.getElementById("page-outreach");
const loadingEl = document.getElementById("loading");
const errorEl = document.getElementById("error");
const errorMsg = document.getElementById("error-msg");
const soundsList = document.getElementById("sounds-list");
const resultsCount = document.getElementById("results-count");
const resultsSubtitle = document.getElementById("results-subtitle");
const outreachSubtitle = document.getElementById("outreach-subtitle");
const emailFields = document.getElementById("email-fields");
const emailSubject = document.getElementById("email-subject");
const messageBody = document.getElementById("message-body");
const sendBtn = document.getElementById("send-btn");
const copyFeedback = document.getElementById("copy-feedback");

// Filter elements
const searchInput = document.getElementById("search-input");
const sortSelect = document.getElementById("sort-select");
const filterPanel = document.getElementById("filter-panel");
const filterCountBadge = document.getElementById("filter-count");
const countrySelect = document.getElementById("country-select");

// Global dropdown element
const globalDropdown = document.getElementById("global-dropdown");
const gdInstagram = document.getElementById("gd-instagram");
const gdEmail = document.getElementById("gd-email");
let activeDropdownIndex = null;

// Close dropdown on outside click
document.addEventListener("click", (e) => {
  if (!globalDropdown.hidden && !e.target.closest(".global-dropdown") && !e.target.closest(".outreach-btn")) {
    globalDropdown.hidden = true;
    activeDropdownIndex = null;
  }
});

// Wire up global dropdown buttons
gdInstagram.addEventListener("click", () => {
  globalDropdown.hidden = true;
  if (activeDropdownIndex !== null) openOutreach(activeDropdownIndex, "instagram");
});
gdEmail.addEventListener("click", () => {
  globalDropdown.hidden = true;
  if (activeDropdownIndex !== null) openOutreach(activeDropdownIndex, "email");
});

// ============ NAVIGATION ============

const ALL_PAGES = ["page-dashboard", "page-crm", "page-scouting", "page-list", "page-outreach", "page-digest"];

function showPage(pageId) {
  ALL_PAGES.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.hidden = id !== pageId;
  });
}

function updateNav(activePage) {
  document.querySelectorAll(".nav-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.page === activePage);
  });
}

function showDashboard() {
  showPage("page-dashboard");
  updateNav("dashboard");
  updateDashboard();
}

function showCRM() {
  showPage("page-crm");
  updateNav("crm");
  renderCRMTable();
  updateCRMSubtitle();
}

function showDiscover() {
  showPage("page-list");
  updateNav("discover");
  if (allSounds.length === 0) applyFilters();
}

function showList() {
  // Kept for compatibility — back button from outreach/digest goes to Discover
  showPage("page-list");
  updateNav("discover");
}

// ============ DASHBOARD ============

function updateDashboard() {
  loadDashboardStats();
  renderRecentActivity();
}

function loadDashboardStats() {
  const all = getAllPipelineStatuses();
  const counts = {};
  PIPELINE_STAGES.forEach(s => { counts[s.key] = 0; });
  Object.values(all).forEach(entry => {
    const s = entry.status || "new";
    if (counts[s] !== undefined) counts[s]++;
  });

  const container = document.getElementById("dashboard-stats");
  if (!container) return;
  container.innerHTML = PIPELINE_STAGES.map(stage => `
    <div class="stat-chip" style="--chip-color: ${stage.color}" onclick="showCRM(); setTimeout(()=>setCRMFilterByKey('${stage.key}'),50)">
      <span class="stat-chip-count">${counts[stage.key]}</span>
      <span class="stat-chip-label">${stage.label}</span>
    </div>
  `).join("");
}

function renderRecentActivity() {
  const all = getAllPipelineStatuses();
  const entries = Object.entries(all)
    .map(([key, val]) => ({ key, ...val }))
    .sort((a, b) => (b.updatedAt || b.dateAdded || "").localeCompare(a.updatedAt || a.dateAdded || ""))
    .slice(0, 10);

  const container = document.getElementById("recent-activity");
  if (!container) return;

  if (entries.length === 0) {
    container.innerHTML = '<p class="activity-empty">No activity yet. Add your first artist below.</p>';
    return;
  }

  container.innerHTML = entries.map(entry => {
    const [keyArtist, keySong] = entry.key.split("|||");
    const artist = entry.artist || keyArtist || "Unknown";
    const song = entry.songName || keySong || "Unknown";
    const stage = PIPELINE_STAGES.find(s => s.key === (entry.status || "new")) || PIPELINE_STAGES[0];
    const timeStr = entry.updatedAt ? timeAgo(entry.updatedAt) : "";
    return `
      <div class="activity-row">
        <span class="activity-artist">${escHtml(artist)}</span>
        <span class="activity-song">${escHtml(song)}</span>
        <span class="activity-badge" style="color:${stage.color};border-color:${stage.color}30">${stage.label}</span>
        ${timeStr ? `<span class="activity-time">${timeStr}</span>` : ""}
      </div>`;
  }).join("");
}

function timeAgo(isoString) {
  if (!isoString) return "";
  const diff = Date.now() - new Date(isoString).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// ============ QUICK ADD ============

let _quickAddUrl = "";

function onQuickAddInput() {
  // Reset form if user clears/changes the input
  const val = document.getElementById("quick-add-input").value.trim();
  if (!val) {
    document.getElementById("quick-add-form").hidden = true;
    setQuickAddStatus("", "");
    quickAddPendingData = null;
  }
}

async function handleQuickAdd() {
  const input = document.getElementById("quick-add-input");
  const url = input.value.trim();
  if (!url) return;

  _quickAddUrl = url;
  setQuickAddStatus("Fetching…", "loading");
  document.getElementById("quick-add-form").hidden = true;
  quickAddPendingData = null;

  const isSpotify = /spotify\.com/i.test(url);
  const isTikTok = /tiktok\.com/i.test(url);

  if (isSpotify) {
    await fetchSpotifyQuickAdd(url);
  } else if (isTikTok) {
    fetchTikTokQuickAdd(url);
  } else {
    // Unknown URL or plain text — just open the form empty
    showQuickAddForm({ artist: "", songName: "", tiktokLink: "", spotifyLink: "" });
    setQuickAddStatus("", "");
  }
}

async function fetchSpotifyQuickAdd(url) {
  try {
    const resp = await fetch(`/api/spotify-track?url=${encodeURIComponent(url)}`);
    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    showQuickAddForm({
      artist: data.artist || "",
      songName: data.trackName || "",
      spotifyLink: url,
      tiktokLink: "",
    });
    setQuickAddStatus("Spotify track found", "success");
  } catch {
    // Graceful fallback — open blank form
    showQuickAddForm({ artist: "", songName: "", spotifyLink: url, tiktokLink: "" });
    setQuickAddStatus("Could not auto-fetch — fill in manually", "error");
  }
}

function fetchTikTokQuickAdd(url) {
  const parsed = parseTikTokLink(url);
  showQuickAddForm({
    artist: "",
    songName: parsed.name !== "TikTok Sound" ? parsed.name : "",
    tiktokLink: url,
    spotifyLink: "",
  });
  setQuickAddStatus("TikTok link detected", "success");
}

function showQuickAddForm(data) {
  quickAddPendingData = data;
  document.getElementById("qaf-artist").value = data.artist || "";
  document.getElementById("qaf-song").value = data.songName || "";
  const linkDisplay = document.getElementById("qaf-link-display");
  const link = data.spotifyLink || data.tiktokLink || "";
  linkDisplay.textContent = link ? `Link: ${link}` : "";
  // Reset tab to email and fill template
  currentQAFTab = "email";
  _applyQAFTab("email");
  _fillQAFTemplate(data.artist || "", data.songName || "");
  document.getElementById("quick-add-form").hidden = false;
}

function switchQAFTab(type) {
  currentQAFTab = type;
  _applyQAFTab(type);
  _fillQAFTemplate(
    document.getElementById("qaf-artist").value.trim(),
    document.getElementById("qaf-song").value.trim()
  );
}

function _applyQAFTab(type) {
  document.querySelectorAll(".qaf-tab").forEach(t => t.classList.toggle("active", t.dataset.tab === type));
  const fields = document.getElementById("qaf-outreach-fields");
  const submitBtn = document.getElementById("qaf-submit-btn");
  if (type === "none") {
    fields.hidden = true;
    submitBtn.textContent = "Add to Pipeline";
  } else {
    fields.hidden = false;
    submitBtn.textContent = type === "email" ? "Add + Send Email" : "Add + Copy DM";
    document.getElementById("qaf-contact-label").textContent = type === "email" ? "Email address" : "Instagram handle";
    document.getElementById("qaf-contact").placeholder = type === "email" ? "artist@email.com" : "@artisthandle";
    document.getElementById("qaf-subject-row").hidden = type === "instagram";
  }
}

function _fillQAFTemplate(artist, song) {
  if (currentQAFTab === "none") return;
  const tpl = getTemplates();
  const a = artist || "{artist}";
  const s = song || "{song}";
  if (currentQAFTab === "email") {
    document.getElementById("qaf-subject").value = tpl.emailSubject.replace(/\{artist\}/g, a).replace(/\{song\}/g, s);
    document.getElementById("qaf-message").value = tpl.emailBody.replace(/\{artist\}/g, a).replace(/\{song\}/g, s);
  } else {
    document.getElementById("qaf-message").value = tpl.ig.replace(/\{artist\}/g, a).replace(/\{song\}/g, s);
  }
}

function refreshQAFTemplate() {
  _fillQAFTemplate(
    document.getElementById("qaf-artist").value.trim(),
    document.getElementById("qaf-song").value.trim()
  );
}

function cancelQuickAdd() {
  document.getElementById("quick-add-form").hidden = true;
  document.getElementById("quick-add-input").value = "";
  setQuickAddStatus("", "");
  quickAddPendingData = null;
}

function submitQuickAdd(sendOutreach) {
  const artist = document.getElementById("qaf-artist").value.trim();
  const songName = document.getElementById("qaf-song").value.trim();
  if (!artist && !songName) {
    setQuickAddStatus("Please enter at least an artist or song name", "error");
    return;
  }

  const finalArtist = artist || "Unknown Artist";
  const finalSong = songName || "Unknown Sound";
  const tiktokLink = quickAddPendingData?.tiktokLink || "";
  const spotifyLink = quickAddPendingData?.spotifyLink || "";

  addToPipeline(finalArtist, finalSong, tiktokLink, spotifyLink);

  if (sendOutreach && currentQAFTab !== "none") {
    const message = document.getElementById("qaf-message").value;
    const contact = document.getElementById("qaf-contact").value.trim();

    const outreachPlatform = currentQAFTab === "email" ? "Email" : "IG";
    const outreachKey = `${finalArtist}|||${finalSong}`;

    if (currentQAFTab === "email") {
      const subject = encodeURIComponent(document.getElementById("qaf-subject").value);
      const body = encodeURIComponent(message);
      const to = encodeURIComponent(contact);
      window.open(`https://outlook.office.com/mail/deeplink/compose?to=${to}&subject=${subject}&body=${body}`, "_blank");
    } else if (currentQAFTab === "instagram") {
      navigator.clipboard.writeText(message).then(() => {
        if (contact) window.open(`https://www.instagram.com/${contact.replace(/^@/, "")}/`, "_blank");
      });
    }

    // Mark as contacted + save platform
    const allAfter = getAllPipelineStatuses();
    if (allAfter[outreachKey]) {
      allAfter[outreachKey].status = "contacted";
      allAfter[outreachKey].platform = outreachPlatform;
      allAfter[outreachKey].updatedAt = new Date().toISOString();
      localStorage.setItem("pipeline_statuses", JSON.stringify(allAfter));
      // Sync to sheet
      fetch(SHEET_WEBHOOK, {
        method: "POST",
        body: JSON.stringify({
          action: "statusUpdate",
          soundName: finalSong,
          artist: finalArtist,
          status: "contacted",
          platform: outreachPlatform,
        }),
      }).catch(() => {});
    }

    setQuickAddStatus(`✓ Added${currentQAFTab === "email" ? " — email client opened" : " — DM copied to clipboard"}`, "success");
  } else {
    setQuickAddStatus(`✓ ${finalArtist} — ${finalSong} added`, "success");
  }

  cancelQuickAdd();
  setTimeout(updateDashboard, 100);
}

function addToPipeline(artist, songName, tiktokLink, spotifyLink) {
  const all = getAllPipelineStatuses();
  const key = `${artist}|||${songName}`;
  const existing = all[key] || {};
  all[key] = {
    status: existing.status || "new",
    updatedAt: new Date().toISOString(),
    dateAdded: existing.dateAdded || new Date().toISOString(),
    artist,
    songName,
    tiktokLink: tiktokLink || existing.tiktokLink || null,
    spotifyLink: spotifyLink || existing.spotifyLink || null,
    platform: existing.platform || null,
    followUpDate: existing.followUpDate || null,
    notes: existing.notes || null,
  };
  localStorage.setItem("pipeline_statuses", JSON.stringify(all));

  fetch(SHEET_WEBHOOK, {
    method: "POST",
    body: JSON.stringify({
      date: new Date().toLocaleDateString("en-US"),
      soundName: songName,
      artist,
      platform: "",
      tiktokLink: tiktokLink || "",
      spotifyLink: spotifyLink || "",
      status: all[key].status,
    }),
  }).catch(() => {});
}

function setQuickAddStatus(msg, type) {
  const el = document.getElementById("quick-add-status");
  if (!el) return;
  el.textContent = msg;
  el.className = "quick-add-status" + (type ? ` ${type}` : "");
}

// ============ CRM TABLE ============

let _crmFilter = "all";

function setCRMFilter(btn) {
  document.querySelectorAll("#crm-pipeline-toggles .pipeline-filter-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  _crmFilter = btn.dataset.pipeline;
  renderCRMTable();
}

function setCRMFilterByKey(key) {
  const btn = document.querySelector(`#crm-pipeline-toggles [data-pipeline="${key}"]`);
  if (btn) setCRMFilter(btn);
}

function updateCRMSubtitle() {
  const all = getAllPipelineStatuses();
  const count = Object.keys(all).length;
  const el = document.getElementById("crm-subtitle");
  if (el) el.textContent = `${count} artist${count !== 1 ? "s" : ""} tracked`;
}

function renderCRMTable() {
  const all = getAllPipelineStatuses();
  let entries = Object.entries(all)
    .map(([key, val]) => ({ key, ...val }))
    .sort((a, b) => (b.dateAdded || b.updatedAt || "").localeCompare(a.dateAdded || a.updatedAt || ""));

  if (_crmFilter !== "all") {
    entries = entries.filter(e => (e.status || "new") === _crmFilter);
  }

  const empty = document.getElementById("crm-empty");
  const table = document.getElementById("crm-table");
  const tbody = document.getElementById("crm-table-body");

  if (entries.length === 0) {
    table.hidden = true;
    empty.hidden = false;
    return;
  }
  table.hidden = false;
  empty.hidden = true;

  tbody.innerHTML = entries.map(entry => {
    const [keyArtist, keySong] = entry.key.split("|||");
    const artist = entry.artist || keyArtist || "Unknown";
    const song = entry.songName || keySong || "Unknown";
    const platform = entry.platform || "";
    const status = entry.status || "new";
    const stage = PIPELINE_STAGES.find(s => s.key === status) || PIPELINE_STAGES[0];
    const dateStr = entry.dateAdded
      ? new Date(entry.dateAdded).toLocaleDateString("en-US", { month: "short", day: "numeric" })
      : (entry.updatedAt ? new Date(entry.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "");

    const tiktokHtml = entry.tiktokLink
      ? `<a class="crm-link" href="${escHtml(entry.tiktokLink)}" target="_blank" rel="noopener" title="TikTok">🎵</a>` : "";
    const spotifyHtml = entry.spotifyLink
      ? `<a class="crm-link" href="${escHtml(entry.spotifyLink)}" target="_blank" rel="noopener" title="Spotify">🟢</a>` : "";

    const followUpVal = entry.followUpDate || "";
    const followUpClass = followUpVal ? "crm-followup has-date" : "crm-followup";

    const encodedKey = escHtml(entry.key);

    return `<tr>
      <td class="crm-date">${escHtml(dateStr)}</td>
      <td class="crm-artist">${escHtml(artist)}</td>
      <td class="crm-song">${escHtml(song)}</td>
      <td class="crm-platform">${escHtml(platform)}</td>
      <td>
        <select class="pipeline-select" style="--badge-color:${stage.color}" onchange="crmStatusChange('${encodedKey}', this.value)">
          ${PIPELINE_STAGES.map(st => `<option value="${st.key}"${st.key === status ? " selected" : ""}>${st.label}</option>`).join("")}
        </select>
      </td>
      <td class="crm-links"><div class="crm-links-inner">${tiktokHtml}${spotifyHtml}<button class="crm-add-link-btn" onclick="crmAddLink('${encodedKey}')" title="Add link">+</button></div></td>
      <td>
        <input type="date" class="${followUpClass}" value="${escHtml(followUpVal)}"
          onchange="setFollowUpDate('${encodedKey}', this.value)"
          onfocus="this.showPicker && this.showPicker()">
      </td>
      <td class="crm-notes-cell" onclick="crmEditNote('${encodedKey}')" title="Click to edit note">
        <span class="crm-note-text">${entry.notes ? escHtml(entry.notes) : '<span class="crm-note-empty">+ note</span>'}</span>
      </td>
      <td>
        <button class="crm-delete-btn" onclick="crmDeleteEntry('${encodedKey}')" title="Remove">&#128465;</button>
      </td>
    </tr>`;
  }).join("");

  updateCRMSubtitle();
}

function crmAddLink(key) {
  const url = prompt("Paste a Spotify or TikTok link:");
  if (!url || !url.trim()) return;
  const link = url.trim();
  const all = getAllPipelineStatuses();
  if (!all[key]) return;
  if (/spotify\.com/i.test(link)) {
    all[key].spotifyLink = link;
  } else if (/tiktok\.com/i.test(link)) {
    all[key].tiktokLink = link;
  } else {
    alert("Please paste a Spotify or TikTok link.");
    return;
  }
  all[key].updatedAt = new Date().toISOString();
  localStorage.setItem("pipeline_statuses", JSON.stringify(all));
  renderCRMTable();
}

function crmStatusChange(key, newStatus) {
  const all = getAllPipelineStatuses();
  if (!all[key]) return;
  all[key] = { ...all[key], status: newStatus, updatedAt: new Date().toISOString() };
  localStorage.setItem("pipeline_statuses", JSON.stringify(all));
  // Sync to sheet
  const [keyArtist, keySong] = key.split("|||");
  const artist = all[key].artist || keyArtist;
  const soundName = all[key].songName || keySong;
  fetch(SHEET_WEBHOOK, {
    method: "POST",
    body: JSON.stringify({
      action: "statusUpdate", soundName, artist, status: newStatus,
      platform: all[key].platform || "",
      notes: all[key].notes || "",
    }),
  }).catch(() => {});
  // Update status badge color
  const stage = PIPELINE_STAGES.find(s => s.key === newStatus);
  if (stage) {
    const sel = document.activeElement;
    if (sel && sel.classList.contains("pipeline-select")) {
      sel.style.setProperty("--badge-color", stage.color);
    }
  }
}

function setFollowUpDate(key, date) {
  const all = getAllPipelineStatuses();
  if (!all[key]) return;
  all[key] = { ...all[key], followUpDate: date || null, updatedAt: new Date().toISOString() };
  localStorage.setItem("pipeline_statuses", JSON.stringify(all));
  // Update class on the input
  const inputs = document.querySelectorAll(".crm-followup");
  // The value change already happened; just toggle the class via re-check
  inputs.forEach(inp => {
    inp.classList.toggle("has-date", !!inp.value);
  });
  // Sync to sheet
  const [keyArtist, keySong] = key.split("|||");
  const artist = all[key].artist || keyArtist;
  const soundName = all[key].songName || keySong;
  fetch(SHEET_WEBHOOK, {
    method: "POST",
    body: JSON.stringify({ action: "setFollowUpDate", soundName, artist, followUpDate: date || "" }),
  }).catch(() => {});
}

function setCRMNote(key, note) {
  const all = getAllPipelineStatuses();
  if (!all[key]) return;
  const trimmed = note.trim();
  if (trimmed === (all[key].notes || "").trim()) return; // no change
  all[key] = { ...all[key], notes: trimmed || null, updatedAt: new Date().toISOString() };
  localStorage.setItem("pipeline_statuses", JSON.stringify(all));
  const [keyArtist, keySong] = key.split("|||");
  const artist = all[key].artist || keyArtist;
  const soundName = all[key].songName || keySong;
  fetch(SHEET_WEBHOOK, {
    method: "POST",
    body: JSON.stringify({ action: "setNote", soundName, artist, notes: trimmed }),
  }).catch(() => {});
}

function crmEditNote(key) {
  const all = getAllPipelineStatuses();
  if (!all[key]) return;
  const current = all[key].notes || "";
  const next = prompt("Note:", current);
  if (next === null) return; // cancelled
  setCRMNote(key, next);
  renderCRMTable();
}

async function crmDeleteEntry(key) {
  const all = getAllPipelineStatuses();
  const entry = all[key];
  if (!entry) return;
  const [keyArtist, keySong] = key.split("|||");
  const artist = entry.artist || keyArtist;
  const song = entry.songName || keySong;
  if (!confirm(`Remove "${song}" by ${artist} from your pipeline?`)) return;
  delete all[key];
  localStorage.setItem("pipeline_statuses", JSON.stringify(all));
  fetch(SHEET_WEBHOOK, {
    method: "POST",
    body: JSON.stringify({ action: "deleteFromLog", soundName: song, artist }),
  }).catch(() => {});
  renderCRMTable();
  loadDashboardStats();
}

// ============ RESEARCH HUB ============

function buildResearchLinks(artist) {
  const encoded = encodeURIComponent(artist);
  return `<div class="research-links">${
    RESEARCH_PLATFORMS.map(p =>
      `<a href="${p.urlTemplate.replace('{artist}', encoded)}" target="_blank" rel="noopener" class="research-link" title="${p.name}"><span>${p.icon}</span></a>`
    ).join('')
  }</div>`;
}

// ============ PIPELINE CRM ============

function getPipelineKey(sound) {
  const artist = sound.tiktok_sound_creator_name || sound.artists || "Unknown";
  const name = sound.tiktok_name_of_sound || sound.song_name || "Unknown";
  return `${artist}|||${name}`;
}

function getAllPipelineStatuses() {
  try {
    const saved = localStorage.getItem("pipeline_statuses");
    return saved ? JSON.parse(saved) : {};
  } catch { return {}; }
}

function getPipelineStatus(sound) {
  const all = getAllPipelineStatuses();
  const key = getPipelineKey(sound);
  return all[key]?.status || "new";
}

function setPipelineStatus(sound, status, extraData = {}) {
  const all = getAllPipelineStatuses();
  const key = getPipelineKey(sound);
  const existing = all[key] || {};
  const artist = sound.tiktok_sound_creator_name || sound.artists || existing.artist || "Unknown";
  const songName = sound.tiktok_name_of_sound || sound.song_name || existing.songName || "Unknown";
  all[key] = {
    ...existing,
    status,
    updatedAt: new Date().toISOString(),
    dateAdded: existing.dateAdded || new Date().toISOString(),
    artist,
    songName,
    tiktokLink: sound.tiktok_official_link || existing.tiktokLink || null,
    ...extraData,
  };
  localStorage.setItem("pipeline_statuses", JSON.stringify(all));
  syncPipelineToSheet(sound, status);
}

function cyclePipelineStatus(index) {
  const toShow = getDisplaySounds();
  const sound = toShow[index];
  if (!sound) return;
  const current = getPipelineStatus(sound);
  const currentIdx = PIPELINE_STAGES.findIndex(s => s.key === current);
  const nextIdx = (currentIdx + 1) % PIPELINE_STAGES.length;
  setPipelineStatus(sound, PIPELINE_STAGES[nextIdx].key);
  renderSounds();
}

function setPipelineFromDropdown(index, newStatus) {
  const toShow = getDisplaySounds();
  const sound = toShow[index];
  if (!sound) return;
  setPipelineStatus(sound, newStatus);
  // Update the dropdown color without full re-render
  const stage = PIPELINE_STAGES.find(s => s.key === newStatus);
  if (stage) {
    const selects = document.querySelectorAll('.pipeline-select');
    if (selects[index]) selects[index].style.setProperty('--badge-color', stage.color);
  }
}

function syncPipelineToSheet(sound, status) {
  const name = sound.tiktok_name_of_sound || sound.song_name || "Unknown";
  const artist = sound.tiktok_sound_creator_name || sound.artists || "Unknown";
  fetch(SHEET_WEBHOOK, {
    method: "POST",
    body: JSON.stringify({
      action: "statusUpdate",
      soundName: name,
      artist: artist,
      status: status,
    }),
  }).catch(() => {});
}

async function deleteFromLog(index) {
  const toShow = getDisplaySounds();
  const sound = toShow[index];
  if (!sound) return;
  const name = sound.tiktok_name_of_sound || sound.song_name || "Unknown";
  const artist = sound.tiktok_sound_creator_name || sound.artists || "Unknown";
  if (!confirm(`Delete all log entries for "${name}" by ${artist}?`)) return;

  try {
    const resp = await fetch(SHEET_WEBHOOK, {
      method: "POST",
      body: JSON.stringify({
        action: "deleteFromLog",
        soundName: name,
        artist: artist,
      }),
    });
    const result = await resp.json();
    // Also clear local pipeline status
    const all = getAllPipelineStatuses();
    const key = getPipelineKey(sound);
    delete all[key];
    localStorage.setItem("pipeline_statuses", JSON.stringify(all));
    renderSounds();
  } catch {}
}

function togglePipelineFilter(btn) {
  document.querySelectorAll(".pipeline-filter-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  activePipelineFilter = btn.dataset.pipeline;
  renderSounds();
}

// ============ BATCH OUTREACH ============

function toggleBatchMode() {
  batchMode = !batchMode;
  selectedSounds.clear();
  document.getElementById("batch-toggle-label").textContent = batchMode ? "Exit Batch" : "Batch Select";
  renderSounds();
  updateBatchBar();
}

function toggleSoundSelection(index, event) {
  event.stopPropagation();
  if (selectedSounds.has(index)) {
    selectedSounds.delete(index);
  } else {
    selectedSounds.add(index);
  }
  const checkbox = document.getElementById(`select-sound-${index}`);
  if (checkbox) checkbox.checked = selectedSounds.has(index);
  const card = checkbox?.closest(".sound-card");
  if (card) card.classList.toggle("selected", selectedSounds.has(index));
  updateBatchBar();
}

function selectAllSounds() {
  const toShow = getDisplaySounds();
  for (let i = 0; i < toShow.length; i++) selectedSounds.add(i);
  document.querySelectorAll(".sound-checkbox").forEach(cb => cb.checked = true);
  document.querySelectorAll(".sound-card").forEach(c => c.classList.add("selected"));
  updateBatchBar();
}

function deselectAllSounds() {
  selectedSounds.clear();
  document.querySelectorAll(".sound-checkbox").forEach(cb => cb.checked = false);
  document.querySelectorAll(".sound-card").forEach(c => c.classList.remove("selected"));
  updateBatchBar();
}

function updateBatchBar() {
  const bar = document.getElementById("batch-bar");
  const countEl = document.getElementById("batch-count");
  if (batchMode) {
    bar.hidden = false;
    countEl.textContent = `${selectedSounds.size} selected`;
  } else {
    bar.hidden = true;
  }
}

function openBatchOutreach(type) {
  if (selectedSounds.size === 0) return;
  const toShow = getDisplaySounds();
  const sounds = Array.from(selectedSounds).map(i => toShow[i]).filter(Boolean);

  if (type === "email") {
    sounds.forEach((s, idx) => {
      const name = s.tiktok_name_of_sound || s.song_name || "Unknown Sound";
      const artist = s.tiktok_sound_creator_name || s.artists || "Unknown Artist";
      const tpl = getTemplates();
      const subject = encodeURIComponent(tpl.emailSubject.replace(/\{artist\}/g, artist).replace(/\{song\}/g, name));
      const body = encodeURIComponent(tpl.emailBody.replace(/\{artist\}/g, artist).replace(/\{song\}/g, name));
      setTimeout(() => {
        window.open(`https://outlook.office.com/mail/deeplink/compose?subject=${subject}&body=${body}`, "_blank");
      }, idx * 500);
      logBatchOutreach(s, "Email");
    });
  } else {
    startInstagramBatchFlow(sounds);
  }
}

function logBatchOutreach(sound, platform) {
  const name = sound.tiktok_name_of_sound || sound.song_name || "Unknown Sound";
  const artist = sound.tiktok_sound_creator_name || sound.artists || "Unknown Artist";
  const tiktokLink = sound.tiktok_official_link || "";
  const status = getPipelineStatus(sound);
  if (status === "new") setPipelineStatus(sound, "contacted");
  fetch(SHEET_WEBHOOK, {
    method: "POST",
    body: JSON.stringify({
      date: new Date().toLocaleDateString("en-US"),
      soundName: name,
      artist: artist,
      platform: platform,
      tiktokLink: tiktokLink,
      status: getPipelineStatus(sound),
    }),
  }).catch(() => {});
}

function startInstagramBatchFlow(sounds) {
  batchIgQueue = sounds;
  batchIgIndex = 0;
  processNextInstagramBatch();
}

function processNextInstagramBatch() {
  const modal = document.getElementById("batch-modal");
  if (batchIgIndex >= batchIgQueue.length) {
    modal.innerHTML = `
      <div class="batch-modal-content">
        <h3 style="color:var(--cyan);font-family:'JetBrains Mono',monospace;margin-bottom:12px">Batch Complete</h3>
        <p style="color:var(--text);margin-bottom:16px">${batchIgQueue.length} Instagram messages processed.</p>
        <button class="btn btn-primary" onclick="closeBatchModal()">Done</button>
      </div>`;
    return;
  }

  const s = batchIgQueue[batchIgIndex];
  const name = s.tiktok_name_of_sound || s.song_name || "Unknown Sound";
  const artist = s.tiktok_sound_creator_name || s.artists || "Unknown Artist";
  const tpl = getTemplates();
  const message = tpl.ig.replace(/\{artist\}/g, artist).replace(/\{song\}/g, name);

  modal.hidden = false;
  modal.innerHTML = `
    <div class="batch-modal-content">
      <div class="batch-modal-header">
        <h3>Instagram Batch (${batchIgIndex + 1}/${batchIgQueue.length})</h3>
        <button class="close-editor" onclick="closeBatchModal()">&times;</button>
      </div>
      <p class="batch-artist">${escHtml(artist)} — ${escHtml(name)}</p>
      <textarea class="template-textarea" rows="8" readonly>${escHtml(message)}</textarea>
      <div class="batch-modal-actions">
        <button class="btn btn-primary" onclick="copyAndSearchIg()">Copy & Search Instagram</button>
        <button class="btn btn-secondary" onclick="skipBatchIg()">Skip</button>
      </div>
    </div>`;
}

async function copyAndSearchIg() {
  const s = batchIgQueue[batchIgIndex];
  const name = s.tiktok_name_of_sound || s.song_name || "Unknown Sound";
  const artist = s.tiktok_sound_creator_name || s.artists || "Unknown Artist";
  const tpl = getTemplates();
  const message = tpl.ig.replace(/\{artist\}/g, artist).replace(/\{song\}/g, name);

  try { await navigator.clipboard.writeText(message); } catch {
    const ta = document.createElement("textarea");
    ta.value = message; document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); document.body.removeChild(ta);
  }

  const query = encodeURIComponent(`${artist} instagram`);
  window.open(`https://www.google.com/search?q=${query}`, "_blank");
  logBatchOutreach(s, "IG");

  batchIgIndex++;
  setTimeout(processNextInstagramBatch, 400);
}

function skipBatchIg() {
  batchIgIndex++;
  processNextInstagramBatch();
}

function closeBatchModal() {
  document.getElementById("batch-modal").hidden = true;
  batchIgQueue = [];
  batchIgIndex = 0;
}

// ============ FILTER MANAGEMENT ============

function getSelectedLabels() {
  const btns = document.querySelectorAll(".label-btn.active");
  return Array.from(btns).map((b) => b.dataset.label);
}

function toggleLabel(btn) {
  btn.classList.toggle("active");
}

function toggleFilters() {
  const btn = document.querySelector(".filter-toggle");
  const isOpen = !filterPanel.hidden;
  filterPanel.hidden = isOpen;
  btn.classList.toggle("open", !isOpen);
}

function setDisplayCount(btn) {
  document.querySelectorAll(".display-btn").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  displayCount = parseInt(btn.dataset.count);
  renderSounds();
}

function getFilterValues() {
  return {
    sortBy: sortSelect.value,
    labels: getSelectedLabels(),
    country: countrySelect.value,
    min24h: document.getElementById("min-24h").value,
    max24h: document.getElementById("max-24h").value,
    minGrowth: document.getElementById("min-growth").value,
    maxGrowth: document.getElementById("max-growth").value,
    min7d: document.getElementById("min-7d").value,
    max7d: document.getElementById("max-7d").value,
    minTotal: document.getElementById("min-total").value,
    maxTotal: document.getElementById("max-total").value,
    search: searchInput.value.trim(),
  };
}

function countActiveFilters() {
  const f = getFilterValues();
  let count = 0;
  if (!(f.labels.length === 1 && f.labels[0] === "OTHERS")) count++;
  if (f.country) count++;
  if (f.min24h || f.max24h) count++;
  if (f.minGrowth || f.maxGrowth) count++;
  if (f.min7d || f.max7d) count++;
  if (f.minTotal || f.maxTotal) count++;
  if (activePipelineFilter !== "all") count++;
  return count;
}

function updateFilterBadge() {
  const count = countActiveFilters();
  if (count > 0) {
    filterCountBadge.textContent = count;
    filterCountBadge.hidden = false;
  } else {
    filterCountBadge.hidden = true;
  }
}

function resetFilters() {
  document.querySelectorAll(".label-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.label === "OTHERS");
  });
  countrySelect.value = "";
  document.getElementById("min-24h").value = "";
  document.getElementById("max-24h").value = "";
  document.getElementById("min-growth").value = "";
  document.getElementById("max-growth").value = "";
  document.getElementById("min-7d").value = "";
  document.getElementById("max-7d").value = "";
  document.getElementById("min-total").value = "";
  document.getElementById("max-total").value = "";
  sortSelect.value = "tiktok_last_24_hours_video_count";
  searchInput.value = "";
  displayCount = 10;
  document.querySelectorAll(".display-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.count === "10");
  });
  // Reset pipeline filter
  activePipelineFilter = "all";
  document.querySelectorAll(".pipeline-filter-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.pipeline === "all");
  });
  updateFilterBadge();
  applyFilters();
}

// ============ FETCH & RENDER ============

function buildApiParams(filters) {
  const params = {};
  params.sort_by = filters.sortBy;
  if (filters.labels.length > 0) params.label_categories = filters.labels.join(",");
  if (filters.country) params.country_codes = filters.country;
  if (filters.min24h) params.min_count = filters.min24h;
  if (filters.max24h) params.max_count = filters.max24h;
  if (filters.minTotal) params.min_total_count = filters.minTotal;
  if (filters.maxTotal) params.max_total_count = filters.maxTotal;
  if (filters.min7d) params.min_7day_count = filters.min7d;
  if (filters.max7d) params.max_7day_count = filters.max7d;
  if (filters.minGrowth) params.min_growth = filters.minGrowth;
  if (filters.maxGrowth) params.max_growth = filters.maxGrowth;
  params.limit = "50";
  params.page = "1";
  return params;
}

function clientSideFilter(sounds, filters) {
  return sounds.filter((s) => {
    const v24h = parseFloat(s.tiktok_last_24_hours_video_count) || 0;
    const v7d = parseFloat(s.tiktok_last_7_days_video_count) || 0;
    const vTotal = parseFloat(s.tiktok_total_video_count) || 0;
    const growth = parseFloat(s.tiktok_last_24_hours_video_percentage) || 0;
    if (filters.min24h && v24h < parseFloat(filters.min24h)) return false;
    if (filters.max24h && v24h > parseFloat(filters.max24h)) return false;
    if (filters.min7d && v7d < parseFloat(filters.min7d)) return false;
    if (filters.max7d && v7d > parseFloat(filters.max7d)) return false;
    if (filters.minTotal && vTotal < parseFloat(filters.minTotal)) return false;
    if (filters.maxTotal && vTotal > parseFloat(filters.maxTotal)) return false;
    if (filters.minGrowth && growth < parseFloat(filters.minGrowth)) return false;
    if (filters.maxGrowth && growth > parseFloat(filters.maxGrowth)) return false;
    return true;
  });
}

function clientSideSearch(sounds, query) {
  if (!query) return sounds;
  const q = query.toLowerCase();
  return sounds.filter((s) => {
    const name = (s.tiktok_name_of_sound || s.song_name || "").toLowerCase();
    const artist = (s.tiktok_sound_creator_name || s.artists || "").toLowerCase();
    return name.includes(q) || artist.includes(q);
  });
}

async function applyFilters() {
  const filters = getFilterValues();
  updateFilterBadge();
  await fetchSounds(filters);
}

async function fetchSounds(filters) {
  if (!filters) filters = getFilterValues();
  loadingEl.hidden = false;
  errorEl.hidden = true;
  soundsList.hidden = true;
  resultsCount.hidden = true;
  try {
    const params = new URLSearchParams(buildApiParams(filters));
    const resp = await fetch(`/api/external/v1/tiktok-sounds/?${params}`);
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      const msg = err.error?.message || err.error || err.detail || `API returned ${resp.status}`;
      throw new Error(typeof msg === "object" ? JSON.stringify(msg) : msg);
    }
    const data = await resp.json();
    allSounds = data?.data?.items || data?.data || data?.results || (Array.isArray(data) ? data : []);
    filteredSounds = clientSideFilter(allSounds, filters);
    filteredSounds = clientSideSearch(filteredSounds, filters.search);
    renderSounds();
  } catch (err) {
    errorMsg.textContent = `Failed to load sounds: ${err.message}`;
    errorEl.hidden = false;
  } finally {
    loadingEl.hidden = true;
  }
}

function isTikTokLink(str) {
  return /tiktok\.com/i.test(str.trim());
}

function parseTikTokLink(url) {
  url = url.trim();
  const musicMatch = url.match(/\/music\/([^?#]+)/);
  if (musicMatch) {
    let raw = decodeURIComponent(musicMatch[1]);
    raw = raw.replace(/-\d+$/, "").replace(/-/g, " ");
    return { name: raw, link: url };
  }
  return { name: "TikTok Sound", link: url };
}

function onSearchInput() {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    const query = searchInput.value.trim();
    if (isTikTokLink(query)) {
      const parsed = parseTikTokLink(query);
      const manualSound = {
        tiktok_name_of_sound: parsed.name,
        tiktok_sound_creator_name: "Unknown Artist",
        tiktok_official_link: parsed.link,
        tiktok_image_url: "",
        tiktok_last_24_hours_video_percentage: null,
        tiktok_last_24_hours_video_count: "",
        tiktok_last_7_days_video_count: "",
        tiktok_total_video_count: "",
        label_name: "",
        _isManualLink: true,
      };
      const match = allSounds.find(s =>
        s.tiktok_official_link && parsed.link.includes(s.tiktok_official_link.replace(/^https?:\/\//, ""))
      );
      filteredSounds = match ? [match] : [manualSound];
      renderSounds();
      return;
    }
    if (allSounds.length > 0) {
      const filters = getFilterValues();
      filteredSounds = clientSideFilter(allSounds, filters);
      filteredSounds = clientSideSearch(filteredSounds, filters.search);
      renderSounds();
    }
  }, 250);
}

// Helper: get the current display list (pipeline filtered + sliced)
function getDisplaySounds() {
  let list = filteredSounds;
  if (activePipelineFilter !== "all") {
    list = list.filter(s => getPipelineStatus(s) === activePipelineFilter);
  }
  return list.slice(0, displayCount);
}

function renderSounds() {
  // Apply pipeline filter
  let pipelineFiltered = filteredSounds;
  if (activePipelineFilter !== "all") {
    pipelineFiltered = pipelineFiltered.filter(s => getPipelineStatus(s) === activePipelineFilter);
  }
  const toShow = pipelineFiltered.slice(0, displayCount);

  const sortLabel = sortSelect.options[sortSelect.selectedIndex].text.replace("Sort: ", "");
  const countryLabel = countrySelect.options[countrySelect.selectedIndex].text;
  resultsSubtitle.textContent = `Sorted by ${sortLabel} — ${countryLabel}`;

  if (pipelineFiltered.length > 0) {
    resultsCount.textContent = `Showing ${toShow.length} of ${pipelineFiltered.length} sounds`;
    resultsCount.hidden = false;
  } else {
    resultsCount.hidden = true;
  }

  if (toShow.length === 0) {
    soundsList.innerHTML = '<p style="text-align:center;color:#71717a;padding:40px">No sounds match your filters.</p>';
    soundsList.hidden = false;
    return;
  }

  soundsList.innerHTML = toShow.map((s, i) => {
    const name = s.tiktok_name_of_sound || s.song_name || "Unknown Sound";
    const artist = s.tiktok_sound_creator_name || s.artists || "Unknown Artist";
    const artwork = s.tiktok_image_url || s.song_image_url || "";
    const growth24h = s.tiktok_last_24_hours_video_percentage ?? "N/A";
    const videos24h = s.tiktok_last_24_hours_video_count ?? "";
    const videos7d = s.tiktok_last_7_days_video_count ?? "";
    const totalVideos = s.tiktok_total_video_count ?? "";
    const label = s.label_name || "";
    const isManual = s._isManualLink;

    const growthNum = parseFloat(growth24h);
    const growthDisplay = !isNaN(growthNum)
      ? `${growthNum > 0 ? "+" : ""}${growthNum.toFixed(1)}%`
      : growth24h;

    const tiktokLink = s.tiktok_official_link || "";
    const imgTag = artwork
      ? `<img class="sound-artwork" src="${escHtml(artwork)}" alt="" onerror="this.style.display='none'">`
      : `<div class="sound-artwork"></div>`;

    // Pipeline badge
    const pipelineStatus = getPipelineStatus(s);
    const pipelineStage = PIPELINE_STAGES.find(st => st.key === pipelineStatus) || PIPELINE_STAGES[0];
    const badgeHtml = `<select class="pipeline-select" style="--badge-color: ${pipelineStage.color}" onchange="setPipelineFromDropdown(${i}, this.value)">
      ${PIPELINE_STAGES.map(st => `<option value="${st.key}" ${st.key === pipelineStatus ? 'selected' : ''}>${st.label}</option>`).join('')}
    </select>`;

    // Batch checkbox
    const checkboxHtml = batchMode
      ? `<input type="checkbox" class="sound-checkbox" id="select-sound-${i}" ${selectedSounds.has(i) ? "checked" : ""} onclick="toggleSoundSelection(${i}, event)">`
      : "";

    if (isManual) {
      return `
        <div class="sound-card manual-card">
          ${checkboxHtml}
          <span class="sound-rank">&#128279;</span>
          <div class="sound-artwork"></div>
          <div class="sound-info" style="flex:1">
            <label class="manual-label">Sound Name</label>
            <input class="manual-input" id="manual-name-${i}" value="${escHtml(name)}" placeholder="Sound name...">
            <label class="manual-label" style="margin-top:8px">Artist Name</label>
            <input class="manual-input" id="manual-artist-${i}" value="${escHtml(artist === 'Unknown Artist' ? '' : artist)}" placeholder="Artist name...">
            <div style="margin-top:6px">
              <a href="${escHtml(tiktokLink)}" target="_blank" rel="noopener" class="manual-link">Open on TikTok &#8599;</a>
            </div>
          </div>
          <div class="sound-actions">
            ${badgeHtml}
            <button class="outreach-btn" onclick="outreachManual(${i})">Outreach</button>
            <button class="delete-log-btn" onclick="deleteFromLog(${i})" title="Delete from outreach log">&#128465;</button>
          </div>
        </div>`;
    }

    return `
      <div class="sound-card ${batchMode && selectedSounds.has(i) ? 'selected' : ''}">
        ${checkboxHtml}
        <span class="sound-rank">${i + 1}</span>
        ${imgTag}
        <div class="sound-info">
          <div class="sound-name">${tiktokLink ? `<a href="${escHtml(tiktokLink)}" target="_blank" rel="noopener">${escHtml(name)}</a>` : escHtml(name)}</div>
          <div class="sound-artist">${escHtml(artist)}</div>
          ${buildResearchLinks(artist)}
          ${label ? `<span class="sound-label">${escHtml(label)}</span>` : ""}
          <div class="sound-stats">
            <span class="stat growth"><strong>${growthDisplay}</strong> 24h</span>
            ${videos24h !== "" ? `<span class="stat"><strong>${formatNum(videos24h)}</strong> 24h vids</span>` : ""}
            ${videos7d !== "" ? `<span class="stat"><strong>${formatNum(videos7d)}</strong> 7d vids</span>` : ""}
            ${totalVideos !== "" ? `<span class="stat"><strong>${formatNum(totalVideos)}</strong> total</span>` : ""}
          </div>
        </div>
        <div class="sound-actions">
          ${badgeHtml}
          <button class="outreach-btn" onclick="toggleDropdown(event, ${i})">Outreach</button>
          <button class="delete-log-btn" onclick="deleteFromLog(${i})" title="Delete from outreach log">&#128465;</button>
        </div>
      </div>`;
  }).join("");

  soundsList.hidden = false;
}

// ============ DROPDOWN & OUTREACH ============

function outreachManual(index) {
  const nameEl = document.getElementById(`manual-name-${index}`);
  const artistEl = document.getElementById(`manual-artist-${index}`);
  if (nameEl) filteredSounds[index].tiktok_name_of_sound = nameEl.value || "Unknown Sound";
  if (artistEl) filteredSounds[index].tiktok_sound_creator_name = artistEl.value || "Unknown Artist";

  const btn = event.currentTarget;
  const rect = btn.getBoundingClientRect();
  globalDropdown.hidden = false;
  activeDropdownIndex = index;

  const ddHeight = globalDropdown.offsetHeight;
  if (rect.top > ddHeight + 8) {
    globalDropdown.style.top = (rect.top - ddHeight - 4) + "px";
  } else {
    globalDropdown.style.top = (rect.bottom + 4) + "px";
  }
  const ddWidth = globalDropdown.offsetWidth;
  let left = rect.right - ddWidth;
  if (left < 8) left = 8;
  globalDropdown.style.left = left + "px";
}

function toggleDropdown(e, index) {
  e.stopPropagation();
  if (!globalDropdown.hidden && activeDropdownIndex === index) {
    globalDropdown.hidden = true;
    activeDropdownIndex = null;
    return;
  }
  const btn = e.currentTarget;
  const rect = btn.getBoundingClientRect();
  globalDropdown.hidden = false;
  activeDropdownIndex = index;

  const ddHeight = globalDropdown.offsetHeight;
  if (rect.top > ddHeight + 8) {
    globalDropdown.style.top = (rect.top - ddHeight - 4) + "px";
  } else {
    globalDropdown.style.top = (rect.bottom + 4) + "px";
  }
  const ddWidth = globalDropdown.offsetWidth;
  let left = rect.right - ddWidth;
  if (left < 8) left = 8;
  globalDropdown.style.left = left + "px";
}

function openOutreach(index, type) {
  const toShow = getDisplaySounds();
  currentSound = toShow[index];
  currentType = type;

  const name = currentSound.tiktok_name_of_sound || currentSound.song_name || "Unknown Sound";
  const artist = currentSound.tiktok_sound_creator_name || currentSound.artists || "Unknown Artist";

  outreachSubtitle.textContent = `${name} — ${artist}`;

  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.type === type);
  });

  emailFields.hidden = type === "instagram";
  sendBtn.textContent = type === "email" ? "Send via Email" : "Copy & Find on Instagram";

  fillTemplate(type, name, artist);

  pageList.hidden = true;
  pageOutreach.hidden = false;
  copyFeedback.hidden = true;
}

function switchTab(type) {
  currentType = type;
  const name = currentSound.tiktok_name_of_sound || currentSound.song_name || "Unknown Sound";
  const artist = currentSound.tiktok_sound_creator_name || currentSound.artists || "Unknown Artist";

  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.type === type);
  });

  emailFields.hidden = type === "instagram";
  sendBtn.textContent = type === "email" ? "Send via Email" : "Copy & Find on Instagram";

  fillTemplate(type, name, artist);
  copyFeedback.hidden = true;
}

// ============ TEMPLATE SYSTEM ============

const DEFAULT_TEMPLATES = {
  ig: `Hey {artist} - really excited about {song}!\nI'm Oisín, A&R at SUNDAY (part of the Sony Music family). We focus on scaling records that are already showing strong organic momentum - we recently worked on Kat Slater (Native Remedies Remix) alongside Epic Records UK (30M+ on Spotify).\n\nAre you releasing independently?\nWould be great to connect and hear more about what you're building around this release and explore whether there could be a fit to work together, either on this or future releases.\n\n- Oisín, A&R @ SUNDAY (+45 22560259)`,
  emailSubject: `{artist} x SUNDAY`,
  emailBody: `Hi {artist} & management,\n\nI hope you're well.\n\nMy name is Oisín, and I'm an A&R at SUNDAY, part of the Sony Music family. We focus on scaling records that are already showing strong organic momentum - recently we worked on Kat Slater Native Remedies Remix alongside Epic Records UK (30M+ streams on Spotify).\n\nI came across "{song}" on TikTok and really enjoyed it - it's a great record, and the reaction around it feels genuine and exciting.\n\nIs it independently released?\nI'd be interested in exploring whether there could be a fit of working together - either around this record or future releases.\n\nHappy to set up a call to discuss further.\n\nBest,`
};

function getTemplates() {
  try {
    const saved = localStorage.getItem("outreach_templates");
    if (saved) return JSON.parse(saved);
  } catch {}
  return { ...DEFAULT_TEMPLATES };
}

function showTemplateEditor() {
  const tpl = getTemplates();
  document.getElementById("tpl-ig").value = tpl.ig;
  document.getElementById("tpl-email-subject").value = tpl.emailSubject;
  document.getElementById("tpl-email-body").value = tpl.emailBody;
  document.getElementById("template-editor").hidden = false;
}

function hideTemplateEditor() {
  document.getElementById("template-editor").hidden = true;
}

function saveTemplates() {
  const tpl = {
    ig: document.getElementById("tpl-ig").value,
    emailSubject: document.getElementById("tpl-email-subject").value,
    emailBody: document.getElementById("tpl-email-body").value,
  };
  localStorage.setItem("outreach_templates", JSON.stringify(tpl));
  const fb = document.getElementById("tpl-feedback");
  fb.textContent = "Saved!";
  fb.hidden = false;
  setTimeout(() => { fb.hidden = true; }, 2000);
}

function resetTemplates() {
  localStorage.removeItem("outreach_templates");
  document.getElementById("tpl-ig").value = DEFAULT_TEMPLATES.ig;
  document.getElementById("tpl-email-subject").value = DEFAULT_TEMPLATES.emailSubject;
  document.getElementById("tpl-email-body").value = DEFAULT_TEMPLATES.emailBody;
  const fb = document.getElementById("tpl-feedback");
  fb.textContent = "Reset to defaults!";
  fb.hidden = false;
  setTimeout(() => { fb.hidden = true; }, 2000);
}

function fillTemplate(type, soundName, artistName) {
  const tpl = getTemplates();
  if (type === "email") {
    emailSubject.value = tpl.emailSubject.replace(/\{artist\}/g, artistName).replace(/\{song\}/g, soundName);
    messageBody.value = tpl.emailBody.replace(/\{artist\}/g, artistName).replace(/\{song\}/g, soundName);
  } else {
    messageBody.value = tpl.ig.replace(/\{artist\}/g, artistName).replace(/\{song\}/g, soundName);
  }
}

// ============ DAILY DIGEST ============

async function showDigest() {
  pageList.hidden = true;
  pageOutreach.hidden = true;
  document.getElementById("page-digest").hidden = false;

  const digestDate = document.getElementById("digest-date");
  const digestContent = document.getElementById("digest-content");
  digestContent.innerHTML = '<div class="loading"><div class="spinner"></div><p>Loading digest...</p></div>';

  try {
    const resp = await fetch("/digest.json?t=" + Date.now());
    if (!resp.ok) throw new Error("No digest available yet. The daily digest runs at 9:00 AM.");
    const contentType = resp.headers.get("content-type") || "";
    if (!contentType.includes("json")) throw new Error("No digest available yet. The daily digest runs at 9:00 AM.");
    const data = await resp.json();
    digestDate.textContent = `Generated: ${data.generatedAt || "Unknown"}`;

    if (!data.sounds || data.sounds.length === 0) {
      digestContent.innerHTML = '<p style="text-align:center;color:var(--text-dim);padding:40px">No unsigned trending sounds found today.</p>';
      return;
    }

    digestContent.innerHTML = data.sounds.map((s, i) => `
      <div class="digest-card">
        <span class="sound-rank">${i + 1}</span>
        <div class="sound-info">
          <div class="sound-name">${s.link ? `<a href="${escHtml(s.link)}" target="_blank" rel="noopener">${escHtml(s.name)}</a>` : escHtml(s.name)}</div>
          <div class="sound-artist">${escHtml(s.artist)}</div>
          <div class="sound-stats">
            <span class="stat growth"><strong>${s.growth24h || "N/A"}</strong> 24h</span>
            <span class="stat"><strong>${s.videos24h || "N/A"}</strong> 24h vids</span>
            <span class="stat"><strong>${s.videos7d || "N/A"}</strong> 7d vids</span>
          </div>
        </div>
      </div>
    `).join("");
  } catch (err) {
    digestContent.innerHTML = `<p style="text-align:center;color:var(--pink);padding:40px">${escHtml(err.message)}</p>`;
  }
}

function showList() {
  pageOutreach.hidden = true;
  document.getElementById("page-digest").hidden = true;
  pageList.hidden = false;
}

// ============ COPY / SEND / LOG ============

async function copyMessage() {
  const text = currentType === "email"
    ? `Subject: ${emailSubject.value}\n\n${messageBody.value}`
    : messageBody.value;

  logOutreach();

  const feedbackMsg = currentType === "instagram"
    ? "Copied! Opening Instagram search..."
    : "Copied & logged!";

  try {
    await navigator.clipboard.writeText(text);
    copyFeedback.textContent = feedbackMsg;
    copyFeedback.hidden = false;
    setTimeout(() => { copyFeedback.hidden = true; }, 3000);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    copyFeedback.textContent = feedbackMsg;
    copyFeedback.hidden = false;
    setTimeout(() => { copyFeedback.hidden = true; }, 3000);
  }
}

function sendMessage() {
  if (currentType === "email") {
    logOutreach();
    const subject = encodeURIComponent(emailSubject.value);
    const body = encodeURIComponent(messageBody.value);
    window.open(
      `https://outlook.office.com/mail/deeplink/compose?subject=${subject}&body=${body}`,
      "_blank"
    );
  } else {
    copyMessage().then(() => {
      const artist = currentSound.tiktok_sound_creator_name || currentSound.artists || "";
      if (artist) {
        const query = encodeURIComponent(`${artist} instagram`);
        window.open(`https://www.google.com/search?q=${query}`, "_blank");
      }
    });
  }
}

function logOutreach() {
  if (!currentSound) return;
  const name = currentSound.tiktok_name_of_sound || currentSound.song_name || "Unknown Sound";
  const artist = currentSound.tiktok_sound_creator_name || currentSound.artists || "Unknown Artist";
  const tiktokLink = currentSound.tiktok_official_link || "";
  const platform = currentType === "email" ? "Email" : "IG";
  const status = getPipelineStatus(currentSound);

  // Auto-advance to "contacted" if still "new", and store platform
  if (status === "new") {
    setPipelineStatus(currentSound, "contacted", { platform });
  } else {
    // Update platform in localStorage even if status doesn't change
    const all = getAllPipelineStatuses();
    const key = getPipelineKey(currentSound);
    if (all[key]) {
      all[key] = { ...all[key], platform, updatedAt: new Date().toISOString() };
      localStorage.setItem("pipeline_statuses", JSON.stringify(all));
    }
  }

  fetch(SHEET_WEBHOOK, {
    method: "POST",
    body: JSON.stringify({
      date: new Date().toLocaleDateString("en-US"),
      soundName: name,
      artist: artist,
      platform: platform,
      tiktokLink: tiktokLink,
      status: getPipelineStatus(currentSound),
    }),
  }).catch(() => {});
}

// ============ UTILS ============

function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function formatNum(n) {
  const num = typeof n === "string" ? parseFloat(n) : n;
  if (isNaN(num)) return n;
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + "M";
  if (num >= 1_000) return (num / 1_000).toFixed(1) + "K";
  return num.toString();
}

// ============ SCOUTING NETWORK ============

function showScouting() {
  showPage("page-scouting");
  updateNav("scouting");
  loadScouts().then(scouts => {
    renderScoutingTable(scouts);
    renderScoutingStats(scouts);
    updateScoutingSubtitle(scouts);
  });
}

// Fetch CSV from Google Sheet, parse, merge with localStorage cache
async function loadScouts() {
  // Try to fetch fresh data from the sheet
  try {
    const resp = await fetch(SCOUT_SHEET_CSV);
    if (!resp.ok) throw new Error("fetch failed");
    const csv = await resp.text();
    const rows = parseCSV(csv);
    if (rows.length < 2) throw new Error("empty");
    const headers = rows[0].map(h => h.trim());
    const nameIdx   = headers.findIndex(h => h.toLowerCase() === "name");
    const countryIdx= headers.findIndex(h => h.toLowerCase() === "country");
    const genreIdx  = headers.findIndex(h => h.toLowerCase() === "genre");
    const commIdx   = headers.findIndex(h => h.toLowerCase() === "communication");
    const statusIdx = headers.findIndex(h => h.toLowerCase() === "status");
    const notesIdx  = headers.findIndex(h => h.toLowerCase() === "notes");

    // For all editable fields: local cache wins over sheet value.
    // This preserves any in-app edits across page reloads.
    // If the field has never been touched locally (undefined), fall back to sheet.
    const cached = getScoutsCache();
    const cachedMap = {};
    cached.forEach(s => { cachedMap[s.name] = s; });

    function pick(fromCache, cacheKey, sheetVal) {
      // Use cache if the key was ever set (even to empty string), else use sheet value
      return fromCache[cacheKey] !== undefined ? fromCache[cacheKey] : sheetVal;
    }

    // Build the sheet scouts (with local overrides for all editable fields)
    const sheetNames = new Set();
    const scouts = rows.slice(1)
      .map(row => {
        const name = (row[nameIdx] || "").trim();
        if (!name) return null;
        sheetNames.add(name);
        const fc = cachedMap[name] || {};
        return {
          name,
          country:       pick(fc, "country",       (row[countryIdx] || "").trim()),
          genre:         pick(fc, "genre",         (row[genreIdx]   || "").trim()),
          communication: pick(fc, "communication", (row[commIdx]    || "").trim()),
          status:        pick(fc, "status",        (row[statusIdx]  || "").trim()),
          notes:         pick(fc, "notes",         (row[notesIdx]   || "").trim()),
          _local:        false,
        };
      })
      .filter(Boolean);

    // Re-append any locally-added scouts not present in the sheet
    cached.forEach(s => {
      if (!sheetNames.has(s.name)) {
        scouts.push({ ...s, _local: true });
      }
    });

    setScoutsCache(scouts);
    return scouts;
  } catch (e) {
    // Fall back to localStorage cache
    const cached = getScoutsCache();
    if (cached.length) return cached;
    return [];
  }
}

// Simple CSV parser (handles quoted fields)
function parseCSV(text) {
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { cols.push(cur); cur = ""; }
      else { cur += ch; }
    }
    cols.push(cur);
    rows.push(cols);
  }
  return rows;
}

function getScoutsCache() {
  try { return JSON.parse(localStorage.getItem("scouting_scouts") || "[]"); } catch { return []; }
}
function setScoutsCache(scouts) {
  localStorage.setItem("scouting_scouts", JSON.stringify(scouts));
}

function getScoutingProjects() {
  try { return JSON.parse(localStorage.getItem("scouting_projects") || "{}"); } catch { return {}; }
}
function setScoutingProjects(projects) {
  localStorage.setItem("scouting_projects", JSON.stringify(projects));
}

function refreshScouts() {
  // Clear cache and reload
  localStorage.removeItem("scouting_scouts");
  const subtitle = document.getElementById("scouting-subtitle");
  if (subtitle) subtitle.textContent = "Refreshing…";
  loadScouts().then(scouts => {
    renderScoutingTable(scouts);
    renderScoutingStats(scouts);
    updateScoutingSubtitle(scouts);
  });
}

function updateScoutingSubtitle(scouts) {
  const active = scouts.filter(s => (s.status || "").toLowerCase() === "active").length;
  const el = document.getElementById("scouting-subtitle");
  if (el) el.textContent = `${scouts.length} scouts · ${active} active`;
}

// Exchange rates to EUR. FROM_EUR is derived as exact inverse to eliminate round-trip drift.
const TO_EUR   = { EUR: 1, USD: 0.92, GBP: 1.17, DKK: 0.134 };
const FROM_EUR = Object.fromEntries(Object.entries(TO_EUR).map(([c, r]) => [c, 1 / r]));
const CUR_SYMBOLS = { EUR: "€", USD: "$", GBP: "£", DKK: "kr" };

// Format a number with dot as thousands separator (e.g. 1.200)
function fmtNum(n) {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

// Format a currency amount: €1.200 / $450 / 7.460 kr
function fmtCurrency(amount, currency) {
  const sym = CUR_SYMBOLS[currency] || currency;
  const str = fmtNum(amount);
  return currency === "DKK" ? `${str} kr` : `${sym}${str}`;
}

function renderScoutingStats(scouts) {
  const projects = getScoutingProjects();
  const active = scouts.filter(s => (s.status || "Active").toLowerCase() === "active").length;

  // Flatten all projects
  const allProjects = [];
  Object.values(projects).forEach(arr => arr.forEach(p => allProjects.push(p)));
  const dealCount = allProjects.length;

  // Find most-used currency
  const currencyCount = {};
  allProjects.forEach(p => {
    const cur = p.currency || "EUR";
    currencyCount[cur] = (currencyCount[cur] || 0) + 1;
  });
  const mainCurrency = dealCount > 0
    ? Object.entries(currencyCount).sort((a, b) => b[1] - a[1])[0][0]
    : "EUR";

  // Convert all amounts to mainCurrency; skip conversion if already in mainCurrency
  const totalConverted = allProjects.reduce((sum, p) => {
    const cur = p.currency || "EUR";
    const amount = Number(p.amount) || 0;
    if (cur === mainCurrency) return sum + amount;
    return sum + amount * (TO_EUR[cur] || 1) * (FROM_EUR[mainCurrency] || 1);
  }, 0);
  const avg = dealCount > 0 ? totalConverted / dealCount : 0;

  const container = document.getElementById("scouting-stats");
  if (!container) return;
  container.innerHTML = `
    <div class="stat-chip" style="--chip-color:#10b981">
      <span class="stat-chip-count">${active}</span>
      <span class="stat-chip-label">Active</span>
    </div>
    <div class="stat-chip" style="--chip-color:#2563eb">
      <span class="stat-chip-count">${fmtCurrency(totalConverted, mainCurrency)}</span>
      <span class="stat-chip-label">Total Earned</span>
    </div>
    <div class="stat-chip" style="--chip-color:#8b5cf6">
      <span class="stat-chip-count">${fmtCurrency(avg, mainCurrency)}</span>
      <span class="stat-chip-label">Avg per Deal</span>
    </div>
    <div class="stat-chip" style="--chip-color:#f59e0b">
      <span class="stat-chip-count">${dealCount}</span>
      <span class="stat-chip-label">Deals Logged</span>
    </div>
  `;
}

function setScoutFilter(btn) {
  document.querySelectorAll("#scouting-filter-toggles .pipeline-filter-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  _scoutFilter = btn.dataset.filter;
  const scouts = getScoutsCache();
  renderScoutingTable(scouts);
}

const SCOUT_STATUS_OPTIONS = [
  { key: "Active",     color: "#10b981" },
  { key: "Not active", color: "#f59e0b" },
];

// Format earned amount(s) for a scout's project list, grouped by currency
function formatScoutEarnings(scoutProjects) {
  if (!scoutProjects || scoutProjects.length === 0) return "—";
  const byCurrency = {};
  scoutProjects.forEach(p => {
    const cur = p.currency || "EUR";
    byCurrency[cur] = (byCurrency[cur] || 0) + (Number(p.amount) || 0);
  });
  return Object.entries(byCurrency).map(([cur, amt]) => fmtCurrency(amt, cur)).join(" + ");
}

function renderScoutingTable(scouts) {
  const projects = getScoutingProjects();

  let filtered = scouts;
  if (_scoutFilter !== "all") {
    filtered = scouts.filter(s => (s.status || "").toLowerCase() === _scoutFilter.toLowerCase());
  }

  // Sort: highest earner first, then Active before Not Active as tiebreaker
  filtered = [...filtered].sort((a, b) => {
    const aTotal = (projects[a.name] || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
    const bTotal = (projects[b.name] || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
    if (bTotal !== aTotal) return bTotal - aTotal;
    const aActive = (a.status || "Active").toLowerCase() === "active" ? 0 : 1;
    const bActive = (b.status || "Active").toLowerCase() === "active" ? 0 : 1;
    return aActive - bActive;
  });

  const tbody = document.getElementById("scouting-table-body");
  if (!tbody) return;

  const emptyEl = document.getElementById("scouting-empty");

  if (filtered.length === 0) {
    tbody.innerHTML = "";
    if (emptyEl) emptyEl.hidden = false;
    return;
  }
  if (emptyEl) emptyEl.hidden = true;

  tbody.innerHTML = filtered.map(scout => {
    const name = scout.name;
    const encodedName = encodeURIComponent(name);
    const scoutProjects = projects[name] || [];
    const earnedDisplay = formatScoutEarnings(scoutProjects);
    // Default empty status to "Active" so colour always resolves
    const effectiveStatus = (scout.status || "Active").trim() || "Active";
    const statusColor = SCOUT_STATUS_OPTIONS.find(o => o.key.toLowerCase() === effectiveStatus.toLowerCase())?.color || "#10b981";
    const isExpanded = _expandedScouts.has(name);

    const statusOptions = SCOUT_STATUS_OPTIONS.map(o =>
      `<option value="${o.key}"${o.key.toLowerCase() === effectiveStatus.toLowerCase() ? " selected" : ""}>${o.key}</option>`
    ).join("");

    const mainRow = `
      <tr class="scout-main-row${isExpanded ? " scout-expanded" : ""}" onclick="toggleScoutExpand('${encodedName}')">
        <td class="scout-name">${escHtml(name)}</td>
        <td class="scout-country scout-editable" onclick="event.stopPropagation(); startScoutEdit('${encodedName}', 'Country', this)" title="Click to edit">${escHtml(scout.country)}</td>
        <td class="scout-genre scout-editable" onclick="event.stopPropagation(); startScoutEdit('${encodedName}', 'Genre', this)" title="Click to edit">${escHtml(scout.genre)}</td>
        <td class="scout-platform scout-editable" onclick="event.stopPropagation(); startScoutEdit('${encodedName}', 'Communication', this)" title="Click to edit">${escHtml(scout.communication)}</td>
        <td onclick="event.stopPropagation()">
          <select class="pipeline-select" style="--badge-color:${statusColor}"
            onchange="updateScoutField('${encodedName}', 'Status', this.value)">
            ${statusOptions}
          </select>
        </td>
        <td class="scout-projects-count">${scoutProjects.length}</td>
        <td class="scout-earned">${earnedDisplay}</td>
        <td class="crm-notes-cell" onclick="event.stopPropagation(); scoutEditNote('${encodedName}')" title="Click to edit note">
          <span class="crm-note-text">${scout.notes ? escHtml(scout.notes) : '<span class="crm-note-empty">+ note</span>'}</span>
        </td>
        <td class="scout-delete-cell" onclick="event.stopPropagation()">
          <button class="crm-delete-btn" onclick="deleteScout('${encodedName}')" title="Remove scout">🗑</button>
        </td>
      </tr>`;

    if (!isExpanded) return mainRow;

    // Expanded project list row — sorted newest first, original index preserved for delete
    const sortedProjects = scoutProjects
      .map((p, i) => ({ ...p, _idx: i }))
      .sort((a, b) => {
        const aT = a.date ? new Date(a.date).getTime() : 0;
        const bT = b.date ? new Date(b.date).getTime() : 0;
        return bT - aT;
      });

    const projectsHtml = sortedProjects.length > 0
      ? sortedProjects.map(p => {
          const label = p.projectName || p.artist || "—"; // fallback for old data
          const amountStr = fmtCurrency(Number(p.amount) || 0, p.currency || "EUR");
          return `
          <div class="scout-project-entry">
            <span class="sp-project">${escHtml(label)}</span>
            <span class="sp-amount">${amountStr}</span>
            <span class="sp-date">${p.date ? new Date(p.date).toLocaleDateString("en-GB", {day:"2-digit",month:"short",year:"numeric"}) : ""}</span>
            ${p.notes ? `<span class="sp-notes">${escHtml(p.notes)}</span>` : ""}
            <button class="sp-delete" onclick="event.stopPropagation(); deleteScoutProject('${encodedName}', ${p._idx})" title="Remove">×</button>
          </div>`;
        }).join("")
      : `<div class="sp-empty">No projects logged yet.</div>`;

    const expandRow = `
      <tr class="scout-expand-row">
        <td colspan="9">
          <div class="scout-projects-wrap">
            <div class="scout-projects-list">${projectsHtml}</div>
            <button class="btn btn-sm btn-primary scout-log-btn" onclick="event.stopPropagation(); openLogProjectModal('${encodedName}')">+ Log Project</button>
          </div>
        </td>
      </tr>`;

    return mainRow + expandRow;
  }).join("");
}

function toggleScoutExpand(encodedName) {
  const name = decodeURIComponent(encodedName);
  if (_expandedScouts.has(name)) {
    _expandedScouts.delete(name);
  } else {
    _expandedScouts.add(name);
  }
  const scouts = getScoutsCache();
  renderScoutingTable(scouts);
}

function scoutEditNote(encodedName) {
  const name = decodeURIComponent(encodedName);
  const scouts = getScoutsCache();
  const scout = scouts.find(s => s.name === name);
  const current = scout ? (scout.notes || "") : "";
  const next = prompt("Note for " + name + ":", current);
  if (next === null) return;
  updateScoutField(encodedName, "Notes", next);
}

function updateScoutField(encodedName, field, value) {
  const oldName = decodeURIComponent(encodedName);
  const scouts = getScoutsCache();
  const scout = scouts.find(s => s.name === oldName);
  if (!scout) return;

  // Map sheet field name to local property
  const fieldMap = {
    "Name": "name", "Country": "country", "Genre": "genre",
    "Communication": "communication", "Status": "status", "Notes": "notes",
  };
  const localField = fieldMap[field];
  if (localField) scout[localField] = value;

  // If name changed, migrate projects key and expanded set
  if (field === "Name" && value && value !== oldName) {
    const projects = getScoutingProjects();
    if (projects[oldName]) {
      projects[value] = projects[oldName];
      delete projects[oldName];
      setScoutingProjects(projects);
    }
    if (_expandedScouts.has(oldName)) {
      _expandedScouts.delete(oldName);
      _expandedScouts.add(value);
    }
  }

  setScoutsCache(scouts);

  // Sync all fields to sheet so no column is ever left stale
  if (SCOUT_WEBHOOK) {
    fetch(SCOUT_WEBHOOK, {
      method: "POST",
      body: JSON.stringify({
        action: "updateScout",
        scout: oldName,
        field,
        value,
        // Full row snapshot so the sheet can fill any missing columns
        allFields: {
          Country: scout.country || "",
          Genre: scout.genre || "",
          Communication: scout.communication || "",
          Status: scout.status || "Active",
          Notes: scout.notes || "",
        },
      }),
    }).catch(() => {});
  }

  // Re-render
  renderScoutingTable(scouts);
  renderScoutingStats(scouts);
  updateScoutingSubtitle(scouts);
}

function openLogProjectModal(encodedName) {
  const modal = document.getElementById("log-project-modal");
  if (!modal) return;

  // Populate scout dropdown
  const scouts = getScoutsCache();
  const select = document.getElementById("lp-scout");
  select.innerHTML = scouts.map(s =>
    `<option value="${escHtml(s.name)}"${encodedName && decodeURIComponent(encodedName) === s.name ? " selected" : ""}>${escHtml(s.name)}</option>`
  ).join("");

  // Default date to today
  const dateInput = document.getElementById("lp-date");
  if (dateInput && !dateInput.value) dateInput.value = new Date().toISOString().slice(0, 10);

  // Clear other fields
  document.getElementById("lp-artist").value = "";
  document.getElementById("lp-amount").value = "";
  document.getElementById("lp-currency").value = "EUR";
  document.getElementById("lp-notes").value = "";

  modal.hidden = false;
}

function closeLogProjectModal() {
  const modal = document.getElementById("log-project-modal");
  if (modal) modal.hidden = true;
}

function submitLogProject() {
  const scout       = document.getElementById("lp-scout").value.trim();
  const projectName = document.getElementById("lp-artist").value.trim();
  const currency    = document.getElementById("lp-currency").value || "EUR";
  const amount      = parseFloat(document.getElementById("lp-amount").value) || 0;
  const date        = document.getElementById("lp-date").value;
  const notes       = document.getElementById("lp-notes").value.trim();

  if (!scout || !projectName) {
    alert("Please fill in Scout and Project name fields.");
    return;
  }

  const projects = getScoutingProjects();
  if (!projects[scout]) projects[scout] = [];
  // _synced:true marks this project as already sent to the sheet so
  // syncAllToSheet() won't duplicate it on the next bulk sync
  projects[scout].push({ projectName, currency, amount, date, notes, _synced: true });
  setScoutingProjects(projects);

  // Expand the scout row after logging
  _expandedScouts.add(scout);

  // Sync to sheet
  if (SCOUT_WEBHOOK) {
    fetch(SCOUT_WEBHOOK, {
      method: "POST",
      body: JSON.stringify({ action: "addProject", scout, projectName, currency, amount, date, notes }),
    }).catch(() => {});
  }

  closeLogProjectModal();
  const scouts = getScoutsCache();
  renderScoutingTable(scouts);
  renderScoutingStats(scouts);
}

// ─── Bulk sync: push all localStorage data → Google Sheet ────────────────────
// Scouts  : sends syncScout (update-or-insert full row) for every scout.
// Projects: sends addProject only for entries not yet marked _synced:true.
// Safe to run multiple times — scouts are idempotent, projects skip duplicates.
async function syncAllToSheet() {
  if (!SCOUT_WEBHOOK) return;

  const btn = document.getElementById("scouting-sync-btn");
  if (btn) { btn.textContent = "Syncing…"; btn.disabled = true; }

  const scouts   = getScoutsCache();
  const projects = getScoutingProjects();
  let scoutCount = 0, projectCount = 0;

  // 1. Sync every scout row (update if exists, insert if new)
  for (const scout of scouts) {
    try {
      await fetch(SCOUT_WEBHOOK, {
        method: "POST",
        body: JSON.stringify({
          action: "syncScout",
          name:          scout.name,
          country:       scout.country       || "",
          genre:         scout.genre         || "",
          communication: scout.communication || "",
          status:        scout.status        || "Active",
          notes:         scout.notes         || "",
        }),
      });
      scoutCount++;
    } catch (err) { console.error("Scout sync error:", scout.name, err); }
  }

  // 2. Sync only projects that have never been pushed to the sheet
  const updatedProjects = JSON.parse(JSON.stringify(projects));
  for (const [scoutName, scoutProjects] of Object.entries(updatedProjects)) {
    for (const p of scoutProjects) {
      if (p._synced) continue;
      try {
        await fetch(SCOUT_WEBHOOK, {
          method: "POST",
          body: JSON.stringify({
            action:      "addProject",
            scout:       scoutName,
            projectName: p.projectName || "",
            amount:      p.amount,
            currency:    p.currency || "EUR",
            date:        p.date,
            notes:       p.notes || "",
          }),
        });
        p._synced = true;
        projectCount++;
      } catch (err) { console.error("Project sync error:", scoutName, err); }
    }
  }
  setScoutingProjects(updatedProjects);

  if (btn) {
    const label = projectCount > 0
      ? `✓ ${scoutCount} scouts · ${projectCount} projects`
      : `✓ ${scoutCount} scouts synced`;
    btn.textContent = label;
    btn.disabled = false;
    setTimeout(() => { if (btn) btn.textContent = "↑ Sync to Sheet"; }, 4000);
  }
  console.log(`Sync complete — ${scoutCount} scouts, ${projectCount} projects`);
}

// Inline cell editing — click a cell to edit it in place
function startScoutEdit(encodedName, field, td) {
  if (td.querySelector("input")) return; // already editing
  const currentText = td.textContent.trim();
  const input = document.createElement("input");
  input.type = "text";
  input.value = currentText;
  input.className = "scout-cell-input";
  td.textContent = "";
  td.appendChild(input);
  input.focus();
  input.select();

  let saved = false;
  function save() {
    if (saved) return;
    saved = true;
    const newVal = input.value.trim();
    td.textContent = newVal || currentText;
    if (newVal && newVal !== currentText) {
      updateScoutField(encodedName, field, newVal);
    }
  }
  input.addEventListener("blur", save);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    if (e.key === "Escape") {
      saved = true; // prevent blur from saving
      td.textContent = currentText;
    }
  });
}

// Delete a scout entirely
function deleteScout(encodedName) {
  const name = decodeURIComponent(encodedName);
  if (!confirm(`Remove "${name}" from the Scouting Network?\n\nThis will also remove their project history.`)) return;

  let scouts = getScoutsCache();
  scouts = scouts.filter(s => s.name !== name);
  setScoutsCache(scouts);
  _expandedScouts.delete(name);

  // Remove projects
  const projects = getScoutingProjects();
  delete projects[name];
  setScoutingProjects(projects);

  // Sync to sheet
  if (SCOUT_WEBHOOK) {
    fetch(SCOUT_WEBHOOK, {
      method: "POST",
      body: JSON.stringify({ action: "deleteScout", scout: name }),
    }).catch(() => {});
  }

  renderScoutingTable(scouts);
  renderScoutingStats(scouts);
  updateScoutingSubtitle(scouts);
}

// Add Scout modal
function openAddScoutModal() {
  const modal = document.getElementById("add-scout-modal");
  if (!modal) return;
  // Clear fields
  ["as-name","as-country","as-genre","as-comm","as-notes"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  document.getElementById("as-status").value = "Active";
  modal.hidden = false;
  setTimeout(() => document.getElementById("as-name").focus(), 50);
}

function closeAddScoutModal() {
  const modal = document.getElementById("add-scout-modal");
  if (modal) modal.hidden = true;
}

function submitAddScout() {
  const name = document.getElementById("as-name").value.trim();
  if (!name) { alert("Name is required."); return; }

  const scouts = getScoutsCache();
  if (scouts.find(s => s.name.toLowerCase() === name.toLowerCase())) {
    alert(`A scout named "${name}" already exists.`);
    return;
  }

  const newScout = {
    name,
    country:       document.getElementById("as-country").value.trim(),
    genre:         document.getElementById("as-genre").value.trim(),
    communication: document.getElementById("as-comm").value.trim(),
    status:        document.getElementById("as-status").value || "Active",
    notes:         document.getElementById("as-notes").value.trim(),
  };
  scouts.push(newScout);
  setScoutsCache(scouts);

  // Sync to sheet
  if (SCOUT_WEBHOOK) {
    fetch(SCOUT_WEBHOOK, {
      method: "POST",
      body: JSON.stringify({ action: "addScout", ...newScout }),
    }).catch(() => {});
  }

  closeAddScoutModal();
  renderScoutingTable(scouts);
  renderScoutingStats(scouts);
  updateScoutingSubtitle(scouts);
}

function deleteScoutProject(encodedName, index) {
  const name = decodeURIComponent(encodedName);
  if (!confirm(`Remove this project entry for ${name}?`)) return;
  const projects = getScoutingProjects();
  if (projects[name]) {
    projects[name].splice(index, 1);
    setScoutingProjects(projects);
  }
  const scouts = getScoutsCache();
  renderScoutingTable(scouts);
  renderScoutingStats(scouts);
}

// ============ INIT ============
showDashboard();
