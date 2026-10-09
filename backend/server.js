// ==========================================
// 🔑 CONFIGURATION (EDIT THE SYSTEM WHITELIST EXCLUSIONS MATRIX HERE)
// ==========================================
const SYSTEM_WHITELIST = ["joshfz"];
// Required environment variables to map inside the Render control dashboard:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BOT_SESSION_COOKIE
// ==========================================

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { IgApiClient } = require('instagram-private-api');

const app = express();
app.use(cors());
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !process.env.BOT_SESSION_COOKIE) {
  console.error("❌ Missing required environment keys: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BOT_SESSION_COOKIE");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

app.get('/', (req, res) => res.json({ ok: true }));
app.get('/health', (req, res) => res.json({ ok: true }));

function isUserWhitelisted(handle) {
  if (!handle) return false;
  const lower = handle.toLowerCase().trim();
  return SYSTEM_WHITELIST.some(item => item.toLowerCase().trim() === lower);
}

function filterUserList(userList, activeUsername) {
  if (!Array.isArray(userList)) return [];
  const activeLower = (activeUsername || '').toLowerCase().trim();

  return userList.filter(user => {
    const handle = typeof user === 'string' ? user : (user.username || '');
    if (!handle) return false;
    const cleanHandle = handle.toLowerCase().trim();

    if (isUserWhitelisted(cleanHandle)) {
      return cleanHandle === activeLower; 
    }
    return true;
  });
}

let isProcessing = false;

async function pollJobs() {
  if (isProcessing) return;

  try {
    const { data: jobs, error } = await supabase
      .from('jobs')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(1);

    if (error) {
      console.error('Error fetching pending jobs:', error.message);
      return;
    }

    if (!jobs || jobs.length === 0) return;

    // Unpack the active database row item safely from the array envelope
    const currentJob = jobs[0];
    isProcessing = true;

    console.log(`🚀 Processing job ${currentJob.id} for user @${currentJob.username}`);

    // Update table flag state to lock execution threads
    await supabase.from('jobs').update({ status: 'processing' }).eq('id', currentJob.id);

    const activeUsername = currentJob.username.toLowerCase().trim();
    const ig = new IgApiClient();

    // 1. Generate core state fingerprint variables natively
    ig.state.generateDevice(activeUsername);
    ig.state.appVersion = '315.0.0.33.109';
    ig.state.userAgent = 'Instagram 315.0.0.33.109 Android (29/10; 480dpi; 1080x2280; OnePlus; ONEPLUS A6003; enchilada; qcom; en_US; 564998083)';

    // 2. 🔓 THE BULLETPROOF INJECTION ROUTINE: 
    // We let the library build its own native, compiled cookie jar infrastructure first on state generation,
    // then cleanly inject your raw session string directly into that live runtime jar instance.
    const cookieString = `sessionid=${process.env.BOT_SESSION_COOKIE.trim()}; Domain=.instagram.com; Path=/; Secure; HttpOnly`;
    await ig.request.jar.setCookie(cookieString, 'https://instagram.com');

    // Automatically approve incoming follow requests if private to unlock channels safely
    try {
      const pendingFeed = ig.feed.pendingFriendships();
      const pendingItems = await pendingFeed.items();
      if (pendingItems && pendingItems.length > 0) {
        for (const user of pendingItems) {
          await ig.friendship.approve(user.pk);
        }
      }
    } catch (e) {
      console.log('Skipped pending friendship hooks check:', e.message);
    }

    const targetPk = await ig.user.getIdByUsername(activeUsername);

    const followersFeed = ig.feed.accountFollowers(targetPk);
    const followersItems = await followersFeed.all();
    const followersUsernames = followersItems.map(item => item.username);

    const followingFeed = ig.feed.accountFollowing(targetPk);
    const followingItems = await followingFeed.all();
    const followingUsernames = followingItems.map(item => item.username);

    const followersSet = new Set(followersUsernames.map(u => u.toLowerCase().trim()));
    const followingSet = new Set(followingUsernames.map(u => u.toLowerCase().trim()));

    const rawNonFollowers = followingUsernames.filter(u => !followersSet.has(u.toLowerCase().trim()));
    const rawMutuals = followingUsernames.filter(u => followersSet.has(u.toLowerCase().trim()));
    const rawFans = followersUsernames.filter(u => !followingSet.has(u.toLowerCase().trim()));

    const filteredNonFollowers = filterUserList(rawNonFollowers, activeUsername);
    const filteredMutuals = filterUserList(rawMutuals, activeUsername);
    const filteredFans = filterUserList(rawFans, activeUsername);

    const resultPayload = {
      non_followers: filteredNonFollowers.map(u => ({ username: u })),
      mutuals: filteredMutuals.map(u => ({ username: u })),
      fans: filteredFans.map(u => ({ username: u })),
      summary: {
        followers: followersUsernames.length,
        following: followingUsernames.length,
        non_followers: filteredNonFollowers.length,
        fans: filteredFans.length,
        mutuals: filteredMutuals.length
      }
    };

    await supabase.from('jobs').update({ status: 'done', result: resultPayload }).eq('id', currentJob.id);
    console.log(`✅ Successfully completed job ${currentJob.id} for @${activeUsername}`);

  } catch (err) {
    console.error('Error processing job execution branch:', err.message);
    try {
      isProcessing = false; 
      const { data: activeCheck } = await supabase.from('jobs').select('id').eq('status', 'processing').limit(1);
      if (activeCheck && activeCheck.length > 0) {
        await supabase.from('jobs').update({ status: 'error', error: err.message || 'Scraper parsing execution exception.' }).eq('id', activeCheck.id);
      }
    } catch (e) {
      console.error('Failed to clear error rows:', e.message);
    }
  } finally {
    isProcessing = false;
  }
}

setInterval(pollJobs, 3000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Social Analyzer worker listening on port ${PORT}`));
