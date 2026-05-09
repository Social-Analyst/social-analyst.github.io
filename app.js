// Social Analyst — app.js
// ALL Instagram analysis happens here, client-side.
// The worker extension ships only raw { profile, followers[], following[] }.

const { API, SUPABASE_URL, SUPABASE_ANON } = window.SA_CONFIG;
const $ = (id) => document.getElementById(id);

// ─── Form submit ──────────────────────────────────────────────────────────────

$("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = $("u").value.trim().replace(/^@/, "").toLowerCase();
  if (!username) return;

  $("b").disabled = true;
  showStatus(`Submitting job for @${username}…`);

  try {
    const r = await fetch(`${API}/api/public/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `Server error ${r.status}`);
    await poll(j.id, username);
  } catch (err) {
    showError(err.message);
  } finally {
    $("b").disabled = false;
  }
});

// ─── Poll Supabase for job completion ────────────────────────────────────────

async function poll(id, username) {
  const start   = Date.now();
  const timeout = 8 * 60_000;  // 8 min — large accounts take time to collect
  let   attempt = 0;

  while (Date.now() - start < timeout) {
    attempt++;
    const elapsed = Math.round((Date.now() - start) / 1000);

    // After 10 seconds, show private-account follow notice
    if (elapsed > 10 && elapsed < 120) {
      showStatusWithFollowNotice(username, elapsed);
    } else {
      showStatus(`Collecting @${username}… (${elapsed}s elapsed)`);
    }

    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/jobs?id=eq.${id}&select=status,result,error`,
      { headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}` } }
    );
    const rows = await r.json();
    const job  = rows?.[0];

    if (job?.status === "done") {
      processAndRender(job.result, username);
      return;
    }
    if (job?.status === "failed") {
      showError(job.error || "Collection failed. Check the worker extension is running.");
      return;
    }

    // Back off poll frequency for large accounts
    await sleep(attempt < 6 ? 2000 : attempt < 15 ? 3000 : 5000);
  }

  showError("Timed out. The worker may still be collecting a large account — try again in a minute.");
}

// ─── CLIENT-SIDE ANALYSIS ────────────────────────────────────────────────────
// This is where all the logic lives. Worker sends raw arrays, we compute here.

function processAndRender(raw, queriedUsername) {
  const { profile, followers, following, collected_at } = raw;

  // Build lookup sets (by lowercase username for safety)
  const followerSet  = new Set(followers.map(u => u.username.toLowerCase()));
  const followingSet = new Set(following.map(u => u.username.toLowerCase()));

  // Non-followers: profile FOLLOWS them, they do NOT follow back
  const nonFollowers = following.filter(u => !followerSet.has(u.username.toLowerCase()));

  // Fans: they FOLLOW the profile, profile does NOT follow them back
  const fans = followers.filter(u => !followingSet.has(u.username.toLowerCase()));

  // Mutuals: profile follows them AND they follow back
  const mutuals = following.filter(u => followerSet.has(u.username.toLowerCase()));

  const analysis = {
    profile,
    summary: {
      followers:     followers.length,
      following:     following.length,
      non_followers: nonFollowers.length,
      fans:          fans.length,
      mutuals:       mutuals.length,
    },
    non_followers: nonFollowers,
    fans,
    mutuals,
    collected_at,
    analysed_at: new Date().toISOString(),
  };

  renderResults(analysis);
}

// ─── Render ───────────────────────────────────────────────────────────────────

let _currentAnalysis = null;

function renderResults(data) {
  _currentAnalysis = data;
  const { profile, summary } = data;

  const avatarEl = profile.avatar
    ? `<img class="avatar" src="${esc(profile.avatar)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
    : "";
  const avatarFallback = `<div class="avatar-fallback" style="${profile.avatar ? 'display:none' : ''}">${esc(profile.username.charAt(0).toUpperCase())}</div>`;

  $("result").innerHTML = `
    <div class="profile-header">
      ${avatarEl}${avatarFallback}
      <div class="profile-info">
        <div class="profile-name">
          ${esc(profile.full_name || profile.username)}
          ${profile.is_private ? '<span class="badge-private">Private</span>' : ''}
        </div>
        <div class="profile-handle">@${esc(profile.username)}</div>
        <div class="profile-meta">
          Collected ${new Date(data.collected_at).toLocaleString()} ·
          Analysed in browser
        </div>
      </div>
      <button class="export-btn" id="pdf-btn">⬇ Download PDF</button>
    </div>

    <div class="stats" id="stats">
      ${statCard(summary.followers,     "Followers")}
      ${statCard(summary.following,     "Following")}
      ${statCard(summary.non_followers, "Don't Follow Back")}
      ${statCard(summary.fans,          "Fans")}
      ${statCard(summary.mutuals,       "Mutuals")}
    </div>

    <div class="tabs" id="tabs">
      <button class="tab active" data-k="non_followers">Don't Follow Back (${summary.non_followers})</button>
      <button class="tab"        data-k="fans">Fans (${summary.fans})</button>
      <button class="tab"        data-k="mutuals">Mutuals (${summary.mutuals})</button>
    </div>

    <div class="list-wrap">
      <div class="list-search">
        <input type="text" id="search" placeholder="Filter by username or name…">
      </div>
      <div class="list-scroll" id="list-scroll">
        <div id="list"></div>
      </div>
    </div>
  `;

  // Tab switching
  let currentKey = "non_followers";

  const showList = (key, filter = "") => {
    currentKey = key;
    const items = data[key] || [];
    const q     = filter.toLowerCase();
    const shown = q
      ? items.filter(u =>
          u.username.toLowerCase().includes(q) ||
          (u.full_name || "").toLowerCase().includes(q)
        )
      : items;

    $("list").innerHTML = shown.length
      ? shown.map(u => userRow(u)).join("")
      : `<div class="list-empty">${q ? "No results for "" + esc(filter) + """ : "Empty list"}</div>`;
  };

  document.querySelectorAll(".tab").forEach(t => {
    t.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(x => x.classList.remove("active"));
      t.classList.add("active");
      $("search").value = "";
      showList(t.dataset.k);
    });
  });

  $("search").addEventListener("input", (e) => showList(currentKey, e.target.value));

  $("pdf-btn").addEventListener("click", () => exportPDF(data));

  showList("non_followers");
}

function statCard(n, label) {
  return `<div class="stat-card">
    <div class="stat-n">${Number(n).toLocaleString()}</div>
    <div class="stat-l">${label}</div>
  </div>`;
}

function userRow(u) {
  return `<div class="user-row">
    <div>
      <a class="user-handle" href="https://instagram.com/${esc(u.username)}" target="_blank" rel="noopener">@${esc(u.username)}</a>
      <div class="user-name">${esc(u.full_name || "")}</div>
    </div>
    <a class="user-ig" href="https://instagram.com/${esc(u.username)}" target="_blank" rel="noopener">View ↗</a>
  </div>`;
}

// ─── PDF Export ───────────────────────────────────────────────────────────────

async function exportPDF(data) {
  const { jsPDF } = window.jspdf;
  const doc  = new jsPDF({ unit: "mm", format: "a4" });
  const PW   = 210; // A4 width mm
  const M    = 18;  // margin
  const CW   = PW - M * 2;
  let   y    = M;

  const pink   = [225, 48, 108];
  const purple = [155, 89, 225];
  const dark   = [17, 17, 30];
  const mid    = [90, 90, 122];
  const light  = [238, 238, 245];

  // ── Header band ────────────────────────────────────────────────────────────
  doc.setFillColor(...pink);
  doc.rect(0, 0, PW, 36, "F");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  doc.setTextColor(255, 255, 255);
  doc.text("Social Analyst", M, 14);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(255, 200, 220);
  doc.text(`Report generated ${new Date().toLocaleString()}`, M, 21);
  doc.text(`Collected at: ${new Date(data.collected_at).toLocaleString()}`, M, 27);

  y = 46;

  // ── Profile block ──────────────────────────────────────────────────────────
  const p = data.profile;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.setTextColor(...dark);
  doc.text(`@${p.username}`, M, y); y += 6;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(...mid);
  if (p.full_name) { doc.text(p.full_name, M, y); y += 5; }
  if (p.is_private) { doc.text("⚿ Private account", M, y); y += 5; }

  y += 4;

  // ── Stats row ──────────────────────────────────────────────────────────────
  const s      = data.summary;
  const stats  = [
    ["Followers",        s.followers],
    ["Following",        s.following],
    ["Don't Follow Back",s.non_followers],
    ["Fans",             s.fans],
    ["Mutuals",          s.mutuals],
  ];
  const boxW = CW / stats.length;

  stats.forEach(([label, val], i) => {
    const x = M + i * boxW;
    doc.setFillColor(245, 245, 252);
    doc.roundedRect(x, y, boxW - 2, 22, 2, 2, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.setTextColor(...pink);
    doc.text(String(Number(val).toLocaleString()), x + boxW / 2 - 1, y + 11, { align: "center" });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(...mid);
    doc.text(label.toUpperCase(), x + boxW / 2 - 1, y + 18, { align: "center" });
  });

  y += 30;

  // ── List sections ──────────────────────────────────────────────────────────
  const sections = [
    { title: "Don't Follow Back", key: "non_followers", color: pink   },
    { title: "Fans",              key: "fans",          color: purple  },
    { title: "Mutuals",           key: "mutuals",        color: [80, 180, 120] },
  ];

  for (const sec of sections) {
    const items = data[sec.key] || [];

    // Section header
    doc.setFillColor(...sec.color);
    doc.rect(M, y, CW, 8, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(255, 255, 255);
    doc.text(`${sec.title} (${items.length})`, M + 4, y + 5.5);
    y += 11;

    if (items.length === 0) {
      doc.setFont("helvetica", "italic");
      doc.setFontSize(9);
      doc.setTextColor(...mid);
      doc.text("No users in this category.", M + 2, y + 4);
      y += 10;
      continue;
    }

    // Two-column grid
    const COL = 2;
    const colW = CW / COL;

    for (let i = 0; i < items.length; i += COL) {
      // New page if needed
      if (y > 270) {
        doc.addPage();
        y = M;
        // Repeat section label at top of continuation page
        doc.setFillColor(...sec.color);
        doc.rect(M, y, CW, 7, "F");
        doc.setFont("helvetica", "bold");
        doc.setFontSize(8);
        doc.setTextColor(255, 255, 255);
        doc.text(`${sec.title} (continued)`, M + 3, y + 5);
        y += 10;
      }

      for (let c = 0; c < COL; c++) {
        const u = items[i + c];
        if (!u) break;
        const x = M + c * colW;

        // Alternating row bg
        if (Math.floor(i / COL) % 2 === 0) {
          doc.setFillColor(248, 248, 252);
          doc.rect(x, y - 1, colW - 1, 7, "F");
        }

        doc.setFont("helvetica", "bold");
        doc.setFontSize(8.5);
        doc.setTextColor(...dark);
        doc.text(`@${u.username}`, x + 2, y + 4);

        if (u.full_name) {
          doc.setFont("helvetica", "normal");
          doc.setFontSize(7);
          doc.setTextColor(...mid);
          // Truncate long names
          const name = u.full_name.length > 28 ? u.full_name.slice(0, 25) + "…" : u.full_name;
          doc.text(name, x + colW * 0.45, y + 4);
        }
      }

      y += 7;
    }

    y += 6;
  }

  // ── Footer ─────────────────────────────────────────────────────────────────
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFontSize(7);
    doc.setTextColor(...mid);
    doc.text(
      `Social Analyst · Page ${i} of ${pages} · Not affiliated with Instagram or Meta`,
      PW / 2, 291, { align: "center" }
    );
  }

  const filename = `social-analyst-${data.profile.username}-${new Date().toISOString().slice(0,10)}.pdf`;
  doc.save(filename);
}

// ─── Status / loading states ─────────────────────────────────────────────────

function showStatus(msg) {
  $("result").innerHTML = `
    <div class="status-card">
      <div class="status-msg"><span class="spinner"></span>${esc(msg)}</div>
      <div class="status-sub">This can take a few minutes for large accounts.</div>
    </div>
  `;
}

function showStatusWithFollowNotice(username, elapsed) {
  $("result").innerHTML = `
    <div class="follow-notice">
      <div class="follow-icon">🔒</div>
      <div>
        <h3>Private Account? Accept the Follow Request</h3>
        <p>
          If <strong>@${esc(username)}</strong> is private, our worker extension has sent a follow request.
          Please have the account owner <strong>accept it</strong> so the worker can access their lists.
          The worker will automatically proceed once accepted.
        </p>
      </div>
    </div>
    <div class="status-card">
      <div class="status-msg"><span class="spinner"></span>Collecting @${esc(username)}… (${elapsed}s elapsed)</div>
      <div class="status-sub">Waiting for follow acceptance or fetching lists for large account.</div>
    </div>
  `;
}

function showError(msg) {
  $("result").innerHTML = `
    <div class="err-card">
      <strong>Error:</strong> ${esc(msg)}
    </div>
  `;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
