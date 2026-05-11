const { API, SUPABASE_URL, SUPABASE_ANON, OWNER_USERNAME, TIPS } = window.SA_CONFIG;
const $ = (id) => document.getElementById(id);
const result = $("result");

// Render tip cards from config into the page
(function renderTips() {
  const container = document.getElementById("tips");
  if (!container || !Array.isArray(TIPS)) return;
  container.innerHTML = TIPS.map((t) =>
    `<div class="tip"><span class="tip-icon">${t.icon}</span><span>${t.text}</span></div>`
  ).join("");
})();

// Filter out the owner account from any list
function filterOwner(list) {
  if (!OWNER_USERNAME) return list;
  const owner = OWNER_USERNAME.trim().toLowerCase();
  return list.filter((u) => u.username.toLowerCase() !== owner);
}

$("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = $("u").value.trim().replace(/^@/, "").toLowerCase();
  $("b").disabled = true;
  result.style.display = "block";
  result.innerHTML = `<div class="status"><span class="spin"></span> Submitting…</div>`;
  try {
    const r = await fetch(`${API}/api/public/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Submit failed");
    await poll(j.id, username);
  } catch (err) {
    result.innerHTML = `<div class="err">${escapeHtml(err.message)}</div>`;
  } finally { $("b").disabled = false; }
});

async function poll(id, username) {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < 5 * 60_000) {
    attempt++;
    result.innerHTML = `<div class="status"><span class="spin"></span> Analyzing @${escapeHtml(username)}… (${Math.round((Date.now() - start) / 1000)}s)</div>`;
    const r = await fetch(`${SUPABASE_URL}/rest/v1/jobs?id=eq.${id}&select=status,result,error`, {
      headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}` },
    });
    const rows = await r.json();
    const job = rows[0];
    if (job?.status === "done") return render(job.result);
    if (job?.status === "failed") {
      result.innerHTML = `<div class="err">Failed: ${escapeHtml(job.error || "unknown error")}</div>`;
      return;
    }
    await new Promise((r) => setTimeout(r, attempt < 5 ? 2000 : 4000));
  }
  result.innerHTML = `<div class="err">Timed out. No worker picked up the job — check the admin dashboard.</div>`;
}

function render(data) {
  const s = data.summary;
  const lists = {
    non_followers: filterOwner(data.non_followers),
    fans:          filterOwner(data.fans),
    mutuals:       filterOwner(data.mutuals),
  };
  result.innerHTML = `
    <div class="summary">
      <div class="stat"><div class="n">${s.followers}</div><div class="l">Followers</div></div>
      <div class="stat"><div class="n">${s.following}</div><div class="l">Following</div></div>
      <div class="stat"><div class="n">${s.non_followers}</div><div class="l">Don't follow back</div></div>
      <div class="stat"><div class="n">${s.fans}</div><div class="l">Fans</div></div>
      <div class="stat"><div class="n">${s.mutuals}</div><div class="l">Mutuals</div></div>
    </div>
    <div class="tabs">
      <button class="tab active" data-k="non_followers">Non-followers (${lists.non_followers.length})</button>
      <button class="tab" data-k="fans">Fans (${lists.fans.length})</button>
      <button class="tab" data-k="mutuals">Mutuals (${lists.mutuals.length})</button>
    </div>
    <div id="list" class="list"></div>
  `;
  const showList = (k) => {
    $("list").innerHTML = lists[k].map((u) =>
      `<a class="row" href="https://instagram.com/${encodeURIComponent(u.username)}" target="_blank" rel="noopener noreferrer">
        <div class="row-left">
          <span class="row-handle">@${escapeHtml(u.username)}</span>
          ${u.full_name ? `<span class="row-name">${escapeHtml(u.full_name)}</span>` : ""}
        </div>
        <span class="row-arrow">↗</span>
      </a>`
    ).join("") || `<div class="row"><span class="row-name">Empty</span></div>`;
  };
  showList("non_followers");
  document.querySelectorAll(".tab").forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      showList(t.dataset.k);
    };
  });
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
