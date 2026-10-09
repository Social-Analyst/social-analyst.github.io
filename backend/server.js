// ==========================================
// 🔑 GLOBAL EXCLUSION WHITELIST (EDIT HERE)
// ==========================================
const SYSTEM_WHITELIST = ["joshfz"];
// ==========================================
//
// Social Analyzer — background worker
//
// Environment variables (Render → Environment):
//   SUPABASE_URL          https://<project-ref>.supabase.co
//   SUPABASE_SERVICE_KEY  service_role key (server only — never put it in index.html)
//   BOT_SESSION_COOKIE    saved session for the analyzer account. Accepted formats:
//                           - a Cookie header string:  sessionid=...; csrftoken=...; ds_user_id=...
//                           - a JSON array of cookies exported from a browser
//                           - a serialized tough-cookie jar (JSON with a "cookies" array)
//   BOT_USERNAME          (optional) username of the analyzer account
//   MAX_CONCURRENT        (optional) jobs handled in parallel, default 3
//   PORT                  provided by Render

const http = require('http');
const { IgApiClient, IgLoginRequiredError, IgCheckpointError } = require('instagram-private-api');
const { CookieJar, Cookie } = require('tough-cookie');

// ---------- config ----------
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const BOT_SESSION_COOKIE = process.env.BOT_SESSION_COOKIE || '';
const BOT_USERNAME = process.env.BOT_USERNAME || '';
const MAX_CONCURRENT = Math.max(1, Number(process.env.MAX_CONCURRENT || 3));
const POLL_MS = 3000;
const APPROVAL_CHECK_MS = 15000;
const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;

// ---------- whitelist guard ----------
const WHITELIST_LC = SYSTEM_WHITELIST.map((h) => String(h).toLowerCase());

// A whitelisted handle is masked everywhere, except when it is the very
// profile being analysed.
function isMasked(handle, activeUser) {
  const h = String(handle || '').toLowerCase();
  return WHITELIST_LC.includes(h) && h !== String(activeUser || '').toLowerCase();
}
function applyWhitelist(list, activeUser) {
  return list.filter((h) => !isMasked(h, activeUser));
}

// ---------- tiny helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a));
const log = (...a) => console.log(new Date().toISOString(), ...a);

class UserError extends Error {}

// ---------- Supabase REST ----------
async function sb(path, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase ${method} ${path} -> ${res.status} ${await res.text()}`);
  return method === 'GET' ? res.json() : null;
}
const updateJob = (id, patch) =>
  sb(`jobs?id=eq.${id}`, { method: 'PATCH', body: patch, prefer: 'return=minimal' });
const setStatus = (id, status) => updateJob(id, { status });

// ---------- session cookie → tough-cookie state ----------
function parseCookieInput(raw) {
  const s = String(raw || '').trim();
  if (!s) throw new Error('BOT_SESSION_COOKIE is empty.');

  let parsed = null;
  if (s[0] === '{' || s[0] === '[') {
    try { parsed = JSON.parse(s); } catch (_) { parsed = null; }
  }

  let list = [];
  if (parsed && !Array.isArray(parsed) && Array.isArray(parsed.cookies)) list = parsed.cookies;
  else if (Array.isArray(parsed)) list = parsed;
  else {
    list = s
      .split(/;\s*/)
      .map((p) => {
        const i = p.indexOf('=');
        return i > 0 ? { key: p.slice(0, i).trim(), value: p.slice(i + 1).trim() } : null;
      })
      .filter(Boolean);
  }

  const out = list
    .map((c) => ({ key: c.key || c.name, value: c.value }))
    .filter((c) => c.key && typeof c.value === 'string' && c.value.length);
  if (!out.length) throw new Error('BOT_SESSION_COOKIE contains no usable cookies.');
  return out;
}

// Builds a structurally valid serialized tough-cookie jar ({ cookies: [...] }).
function buildSerializedJar(cookies) {
  const byKey = new Map(cookies.map((c) => [c.key, c.value]));
  const sid = byKey.get('sessionid');
  if (!sid) throw new Error('BOT_SESSION_COOKIE has no "sessionid" cookie.');

  // Fill in the cookies the private API expects when they are missing.
  if (!byKey.has('ds_user_id')) byKey.set('ds_user_id', decodeURIComponent(sid).split(':')[0]);
  if (!byKey.has('csrftoken')) {
    byKey.set('csrftoken', Array.from({ length: 32 }, () => rand(0, 16).toString(16)).join(''));
  }

  const jar = new CookieJar();
  const expires = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  for (const [key, value] of byKey) {
    const cookie = new Cookie({
      key,
      value,
      domain: 'instagram.com',
      path: '/',
      secure: true,
      httpOnly: key === 'sessionid',
      expires,
    });
    jar.setCookieSync(cookie, 'https://i.instagram.com/');
  }

  const serialized = jar.serializeSync();
  if (!serialized || !Array.isArray(serialized.cookies) || !serialized.cookies.length) {
    throw new Error('Cookie jar serialization produced no cookies.');
  }
  return { serialized, userId: byKey.get('ds_user_id') };
}

async function initClient(rawCookie, botUsername) {
  const ig = new IgApiClient();
  const { serialized, userId } = buildSerializedJar(parseCookieInput(rawCookie));

  // 1) device first, 2) then the cookie jar — avoids the init race conditions.
  ig.state.generateDevice(botUsername || `u${userId}`);
  // Optional: route Instagram traffic through a (residential) proxy, e.g. http://user:pass@host:port
  if (process.env.IG_PROXY_URL) ig.state.proxyUrl = process.env.IG_PROXY_URL;
  await ig.state.deserializeCookieJar(JSON.stringify(serialized));
  return ig;
}

let clientPromise = null;
function getClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const ig = await initClient(BOT_SESSION_COOKIE, BOT_USERNAME);
      const me = await ig.account.currentUser(); // proves the session is alive
      log(`Analyzer account ready: @${me.username}`);
      return ig;
    })();
    clientPromise.catch(() => { clientPromise = null; });
  }
  return clientPromise;
}

// ---------- feeds ----------
async function drainFeed(feed) {
  const names = [];
  let retries = 0;
  while (true) {
    try {
      const page = await feed.items();
      for (const u of page) names.push(String(u.username).toLowerCase());
      retries = 0;
    } catch (err) {
      if (++retries > 3) throw err;
      await sleep(5000 * retries);
      continue;
    }
    if (!feed.isMoreAvailable()) break;
    await sleep(rand(1200, 2800)); // be gentle between pages
  }
  return [...new Set(names)];
}

// ---------- one job ----------
async function processJob(job) {
  const target = String(job.username).toLowerCase();
  const ig = await getClient();

  let userId;
  try {
    userId = await ig.user.getIdByUsername(target);
  } catch (err) {
    if (/NotFound/i.test(err.name || err.constructor.name)) {
      throw new UserError('That username could not be found.');
    }
    throw err;
  }

  const info = await ig.user.info(userId);
  let fs = await ig.friendship.show(userId);

  // Step 1–2: private profile we don't follow yet → follow handshake.
  if (info.is_private && !fs.following) {
    if (!fs.outgoing_request) await ig.friendship.create(userId);
    await setStatus(job.id, 'pending_follow');

    const started = Date.now();
    let announcedWaiting = false;
    while (true) {
      await sleep(APPROVAL_CHECK_MS);
      fs = await ig.friendship.show(userId);
      if (fs.following) break;
      if (!fs.outgoing_request) throw new UserError('The follow request was declined or cancelled.');
      if (!announcedWaiting) {
        await setStatus(job.id, 'waiting_approval');
        announcedWaiting = true;
      }
      if (Date.now() - started > APPROVAL_TIMEOUT_MS) {
        try { await ig.friendship.destroy(userId); } catch (_) {}
        throw new UserError('Timed out waiting for the follow request to be accepted.');
      }
    }
  }

  // Step 3: analysis.
  await setStatus(job.id, 'processing');
  const rawFollowers = await drainFeed(ig.feed.accountFollowers(userId));
  const rawFollowing = await drainFeed(ig.feed.accountFollowing(userId));

  // Whitelist guard runs BEFORE any calculation so every list and counter agrees.
  const followers = applyWhitelist(rawFollowers, target).sort();
  const following = applyWhitelist(rawFollowing, target).sort();
  const followerSet = new Set(followers);
  const followingSet = new Set(following);

  const dontFollowBack = following.filter((u) => !followerSet.has(u));
  const fans = followers.filter((u) => !followingSet.has(u));
  const mutuals = followers.filter((u) => followingSet.has(u));

  const result = {
    target,
    generated_at: new Date().toISOString(),
    counts: {
      followers: followers.length,
      following: following.length,
      dontFollowBack: dontFollowBack.length,
      fans: fans.length,
      mutuals: mutuals.length,
    },
    followers,
    following,
    dontFollowBack,
    fans,
    mutuals,
  };

  await updateJob(job.id, { status: 'done', result, error: null });
  log(`Job ${job.id} done for @${target} (${followers.length}/${following.length})`);
}

// ---------- scheduler ----------
const active = new Set();

async function runJob(job) {
  try {
    await processJob(job);
  } catch (err) {
    console.error(`Job ${job.id} failed:`, err && err.message ? err.message : err);
    if (err && err.response) {
      console.error('  HTTP status:', err.response.statusCode);
      try { console.error('  Response body:', JSON.stringify(err.response.body).slice(0, 800)); } catch (_) {}
    }
    let message = 'Analysis failed. Please try again in a moment.';
    if (err instanceof UserError) message = err.message;
    else if (/accounts\/current_user/.test(String(err && err.message))) {
      clientPromise = null; // force a fresh session init on the next job
      message = 'The analyzer account session was rejected. Please try again later.';
    }
    else if (err instanceof IgLoginRequiredError || err instanceof IgCheckpointError) {
      clientPromise = null; // force a fresh init on the next job
      message = 'The analyzer account needs attention. Please try again later.';
    }
    await updateJob(job.id, { status: 'error', error: message }).catch(() => {});
  } finally {
    active.delete(job.id);
  }
}

async function tick() {
  if (active.size >= MAX_CONCURRENT) return;
  const rows = await sb(
    'jobs?select=id,username,status&status=in.(pending,pending_follow,waiting_approval)&order=created_at.asc&limit=20'
  );
  for (const job of rows) {
    if (active.size >= MAX_CONCURRENT) break;
    if (active.has(job.id)) continue;
    active.add(job.id);
    runJob(job); // intentionally not awaited — jobs run concurrently
  }
}

async function main() {
  for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_KEY, BOT_SESSION_COOKIE })) {
    if (!v) { console.error(`Missing environment variable: ${k}`); process.exit(1); }
  }

  // Render web services must listen on $PORT; also handy for uptime pings.
  http
    .createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); })
    .listen(Number(process.env.PORT || 3000));

  // Recover jobs interrupted mid-analysis by a restart.
  await sb('jobs?status=eq.processing', { method: 'PATCH', body: { status: 'pending' }, prefer: 'return=minimal' })
    .catch((e) => console.error('Recovery step failed:', e.message));

  log(`Worker started. Polling every ${POLL_MS / 1000}s. Whitelist: ${SYSTEM_WHITELIST.join(', ') || '(none)'}`);
  while (true) {
    try { await tick(); } catch (err) { console.error('Tick error:', err.message); }
    await sleep(POLL_MS);
  }
}

module.exports = { buildSerializedJar, parseCookieInput, initClient, applyWhitelist, isMasked };

if (require.main === module) main();
