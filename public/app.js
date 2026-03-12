// Google Sheets logging
const SHEET_WEBHOOK = "https://script.google.com/macros/s/AKfycbzPil5g2VOQnK0DBLmWLfdkOzPVprtFk1D7a0z06_Oew3uYW6Qtrz0H3aUYjMmFD5p60A/exec";

// ============ STATE ============
let allSounds = [];      // raw from API
let filteredSounds = [];  // after client-side filters
let currentSound = null;
let currentType = "email";
let displayCount = 10;
let searchTimeout = null;

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
  // Labels
  document.querySelectorAll(".label-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.label === "OTHERS");
  });
  // Country
  countrySelect.value = "";
  // Ranges
  document.getElementById("min-24h").value = "";
  document.getElementById("max-24h").value = "";
  document.getElementById("min-growth").value = "";
  document.getElementById("max-growth").value = "";
  document.getElementById("min-7d").value = "";
  document.getElementById("max-7d").value = "";
  document.getElementById("min-total").value = "";
  document.getElementById("max-total").value = "";
  // Sort
  sortSelect.value = "tiktok_last_24_hours_video_count";
  // Search
  searchInput.value = "";
  // Display count
  displayCount = 10;
  document.querySelectorAll(".display-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.count === "10");
  });
  updateFilterBadge();
  applyFilters();
}

// ============ FETCH & RENDER ============

function buildApiParams(filters) {
  const params = {};

  params.sort_by = filters.sortBy;

  if (filters.labels.length > 0) {
    params.label_categories = filters.labels.join(",");
  }

  if (filters.country) {
    params.country_codes = filters.country;
  }

  // Range filters — send to API (also applied client-side as backup)
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

    // Client-side range filtering (backup)
    filteredSounds = clientSideFilter(allSounds, filters);

    // Client-side search
    filteredSounds = clientSideSearch(filteredSounds, filters.search);

    renderSounds();
  } catch (err) {
    errorMsg.textContent = `Failed to load sounds: ${err.message}`;
    errorEl.hidden = false;
  } finally {
    loadingEl.hidden = true;
  }
}

function onSearchInput() {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    if (allSounds.length > 0) {
      const filters = getFilterValues();
      filteredSounds = clientSideFilter(allSounds, filters);
      filteredSounds = clientSideSearch(filteredSounds, filters.search);
      renderSounds();
    }
  }, 250);
}

function renderSounds() {
  const toShow = filteredSounds.slice(0, displayCount);

  // Update subtitle
  const sortLabel = sortSelect.options[sortSelect.selectedIndex].text.replace("Sort: ", "");
  const countryLabel = countrySelect.options[countrySelect.selectedIndex].text;
  resultsSubtitle.textContent = `Sorted by ${sortLabel} — ${countryLabel}`;

  // Results count
  if (filteredSounds.length > 0) {
    resultsCount.textContent = `Showing ${toShow.length} of ${filteredSounds.length} sounds`;
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

    const growthNum = parseFloat(growth24h);
    const growthDisplay = !isNaN(growthNum)
      ? `${growthNum > 0 ? "+" : ""}${growthNum.toFixed(1)}%`
      : growth24h;

    const tiktokLink = s.tiktok_official_link || "";

    const imgTag = artwork
      ? `<img class="sound-artwork" src="${escHtml(artwork)}" alt="" onerror="this.style.display='none'">`
      : `<div class="sound-artwork"></div>`;

    return `
      <div class="sound-card">
        <span class="sound-rank">${i + 1}</span>
        ${imgTag}
        <div class="sound-info">
          <div class="sound-name">${tiktokLink ? `<a href="${escHtml(tiktokLink)}" target="_blank" rel="noopener">${escHtml(name)}</a>` : escHtml(name)}</div>
          <div class="sound-artist">${escHtml(artist)}</div>
          ${label ? `<span class="sound-label">${escHtml(label)}</span>` : ""}
          <div class="sound-stats">
            <span class="stat growth"><strong>${growthDisplay}</strong> 24h</span>
            ${videos24h !== "" ? `<span class="stat"><strong>${formatNum(videos24h)}</strong> 24h vids</span>` : ""}
            ${videos7d !== "" ? `<span class="stat"><strong>${formatNum(videos7d)}</strong> 7d vids</span>` : ""}
            ${totalVideos !== "" ? `<span class="stat"><strong>${formatNum(totalVideos)}</strong> total</span>` : ""}
          </div>
        </div>
        <div class="sound-actions">
          <button class="outreach-btn" onclick="toggleDropdown(event, ${i})">Outreach</button>
        </div>
      </div>
    `;
  }).join("");

  soundsList.hidden = false;
}

// ============ DROPDOWN & OUTREACH ============

function toggleDropdown(e, index) {
  e.stopPropagation();

  // If already open for this index, close it
  if (!globalDropdown.hidden && activeDropdownIndex === index) {
    globalDropdown.hidden = true;
    activeDropdownIndex = null;
    return;
  }

  // Position the global dropdown near the clicked button
  const btn = e.currentTarget;
  const rect = btn.getBoundingClientRect();

  // Show above the button by default; if too close to top, show below
  globalDropdown.hidden = false;
  activeDropdownIndex = index;

  const ddHeight = globalDropdown.offsetHeight;
  const spaceAbove = rect.top;
  const spaceBelow = window.innerHeight - rect.bottom;

  if (spaceAbove > ddHeight + 8) {
    // Show above
    globalDropdown.style.top = (rect.top - ddHeight - 4) + "px";
  } else {
    // Show below
    globalDropdown.style.top = (rect.bottom + 4) + "px";
  }

  // Align right edge with button right edge
  const ddWidth = globalDropdown.offsetWidth;
  let left = rect.right - ddWidth;
  if (left < 8) left = 8; // Don't go off-screen left
  globalDropdown.style.left = left + "px";
}

function openOutreach(index, type) {
  const toShow = filteredSounds.slice(0, displayCount);
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

function fillTemplate(type, soundName, artistName) {
  if (type === "email") {
    emailSubject.value = `${soundName} - SUNDAY / Sony Music`;
    messageBody.value = `Hi ${artistName} & management,

I hope you're well.

My name is Oisín, and I'm an A&R at SUNDAY, part of the Sony Music family. We focus on scaling records that are already showing strong organic momentum - recently we worked on Kat Slater Native Remedies Remix alongside Epic Records UK (30M+ streams on Spotify).

I came across "${soundName}" on TikTok and really enjoyed it - it's a great record, and the reaction around it feels genuine and exciting.

Is it independently released?
I'd be interested in exploring whether there could be a fit of working together - either around this record or future releases.

Happy to set up a call to discuss further.

Best,`;
  } else {
    messageBody.value = `Hey ${artistName} - really excited about ${soundName}!
I'm Oisín, A&R at SUNDAY (part of the Sony Music family). We focus on scaling records that are already showing strong organic momentum - we recently worked on Kat Slater (Native Remedies Remix) alongside Epic Records UK (30M+ on Spotify).

Are you releasing independently?
Would be great to connect and hear more about what you're building around this release and explore whether there could be a fit to work together, either on this or future releases.

- Oisín, A&R @ SUNDAY (+45 22560259)`;
  }
}

function showList() {
  pageOutreach.hidden = true;
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
    // Open Outlook Web compose with pre-filled subject & body — signature auto-applied
    window.open(
      `https://outlook.office.com/mail/deeplink/compose?subject=${subject}&body=${body}`,
      "_blank"
    );
  } else {
    // Copy message then open Google search for artist's Instagram profile
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

  fetch(SHEET_WEBHOOK, {
    method: "POST",
    body: JSON.stringify({
      date: new Date().toLocaleDateString("en-US"),
      soundName: name,
      artist: artist,
      platform: platform,
      tiktokLink: tiktokLink,
    }),
  }).catch(() => {}); // fire and forget
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
applyFilters();
