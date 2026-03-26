// Google Sheets logging
const SHEET_WEBHOOK = "https://script.google.com/macros/s/AKfycbzPil5g2VOQnK0DBLmWLfdkOzPVprtFk1D7a0z06_Oew3uYW6Qtrz0H3aUYjMmFD5p60A/exec";

// ============ CONSTANTS ============

const RESEARCH_PLATFORMS = [
  { name: 'Spotify', icon: '&#127925;', urlTemplate: 'https://open.spotify.com/search/{artist}' },
  { name: 'Instagram', icon: '&#128247;', urlTemplate: 'https://www.google.com/search?q={artist}+instagram' },
];

const PIPELINE_STAGES = [
  { key: 'new',       label: 'New',       color: '#6a7091' },
  { key: 'contacted', label: 'Contacted', color: '#00f0ff' },
  { key: 'replied',   label: 'Replied',   color: '#b44aff' },
  { key: 'meeting',   label: 'Meeting',   color: '#ff9f1a' },
  { key: 'signed',    label: 'Signed',    color: '#00ff88' },
  { key: 'passed',    label: 'Passed',    color: '#ff2d95' },
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

const ALL_PAGES = ["page-dashboard", "page-crm", "page-list", "page-outreach", "page-digest"];

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

    if (currentQAFTab === "email") {
      const subject = encodeURIComponent(document.getElementById("qaf-subject").value);
      const body = encodeURIComponent(message);
      const mailto = `mailto:${encodeURIComponent(contact)}?subject=${subject}&body=${body}`;
      window.open(mailto, "_blank");
      // Mark as contacted
      const all = getAllPipelineStatuses();
      const key = `${finalArtist}|||${finalSong}`;
      if (all[key]) { all[key].status = "contacted"; all[key].updatedAt = new Date().toISOString(); }
      localStorage.setItem("pipeline_statuses", JSON.stringify(all));
    } else if (currentQAFTab === "instagram") {
      navigator.clipboard.writeText(message).then(() => {
        if (contact) window.open(`https://www.instagram.com/${contact.replace(/^@/, "")}/`, "_blank");
      });
      // Mark as contacted
      const all = getAllPipelineStatuses();
      const key = `${finalArtist}|||${finalSong}`;
      if (all[key]) { all[key].status = "contacted"; all[key].updatedAt = new Date().toISOString(); }
      localStorage.setItem("pipeline_statuses", JSON.stringify(all));
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
      <td class="crm-links">${tiktokHtml}${spotifyHtml}</td>
      <td>
        <input type="date" class="${followUpClass}" value="${escHtml(followUpVal)}"
          onchange="setFollowUpDate('${encodedKey}', this.value)"
          onfocus="this.showPicker && this.showPicker()">
      </td>
      <td>
        <button class="crm-delete-btn" onclick="crmDeleteEntry('${encodedKey}')" title="Remove">&#128465;</button>
      </td>
    </tr>`;
  }).join("");

  updateCRMSubtitle();
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
    body: JSON.stringify({ action: "statusUpdate", soundName, artist, status: newStatus }),
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
  emailSubject: `{song} - SUNDAY / Sony Music`,
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

// ============ INIT ============
showDashboard();
