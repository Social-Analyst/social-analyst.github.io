const { API, SUPABASE_URL, SUPABASE_ANON } = window.SA_CONFIG;
const \$ = (id) => document.getElementById(id);
const result = \$("result");

\$("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = \$("u").value.trim().replace(/^@/, "").toLowerCase();
  \$("b").disabled = true;
  result.style.display = "block";
  result.innerHTML = `<div class="status"><span class="spin"></span> Submitting request to queue...</div>`;
  
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
  } finally { 
    \$("b").disabled = false; 
  }
});

async function poll(id, username) {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < 5 * 60_000) {
    attempt++;
    result.innerHTML = `<div class="status"><span class="spin"></span> Bot network running analytics loop on @${escapeHtml(username)}… (${Math.round((Date.now() - start) / 1000)}s)</div>`;
    
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/jobs?id=eq.${id}&select=status,result,error`, {
        headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}` },
      });
      const rows = await r.json();
      
      // CRITICAL FIX: Properly select the index 0 item from the Supabase array envelope
      const job = Array.isArray(rows) ? rows[0] : rows;
      
      if (job?.status === "done") return render(job.result);
      if (job?.status === "failed") {
        result.innerHTML = `<div class="err">Scraper Exception: ${escapeHtml(job.error || "unknown error")}</div>`;
        return;
      }
    } catch (e) {
      console.warn("Polling retry error:", e.message);
    }
    await new Promise((r) => setTimeout(r, attempt < 5 ? 2000 : 4000));
  }
  result.innerHTML = `<div class="err">Timed out. Cloud task worker did not return array records. Check Render console.</div>`;
}

function render(data) {
  const s = data.summary;
  const lists = {
    non_followers: data.non_followers || [],
    fans: data.fans || [],
    mutuals: data.mutuals || [],
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
      <button class="tab active" data-k="non_followers">Non-followers (${s.non_followers})</button>
      <button class="tab" data-k="fans">Fans (${s.fans})</button>
      <button class="tab" data-k="mutuals">Mutuals (${s.mutuals})</button>
    </div>
    <div id="list" class="list"></div>
  `;
  
  const showList = (k) => {
    \$("list").innerHTML = lists[k].map((u) =>
      `<div class="row">
        <div class="user-info">
          <span class="handle-name">@${escapeHtml(u.username)}</span>
          <span class="full">${escapeHtml(u.full_name || "Instagram Profile")}</span>
        </div>
        <a href="instagram://user?username=${escapeHtml(u.username)}" class="app-btn">View App ↗</a>
      </div>`
    ).join("") || `<div class="row"><span class="full">Empty array list context.</span></div>`;
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

function escapeHtml(s) { 
  return String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"'"}[c])); 
}
