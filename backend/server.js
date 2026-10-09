const SYSTEM_WHITELIST = ["joshfz"];

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { IgApiClient } = require('instagram-private-api');

const app = express();
app.use(cors());
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL || "https://supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "PASTE_YOUR_SUPABASE_SERVICE_ROLE_KEY_HERE";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Health check endpoint for Render backend worker
app.get('/', (req, res) => {
  res.json({ ok: true });
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// Helper: Filter user list with Whitelist Exclusion Mask
function isUserWhitelisted(handle) {
  if (!handle) return false;
  const lower = handle.toLowerCase();
  return SYSTEM_WHITELIST.some(item => item.toLowerCase() === lower);
}

function filterUserList(userList, activeUsername) {
  if (!Array.isArray(userList)) return [];
  const activeLower = (activeUsername || '').toLowerCase();

  return userList.filter(user => {
    const handle = typeof user === 'string' ? user : (user.username || '');
    if (!handle) return false;

    if (isUserWhitelisted(handle)) {
      // Exception: Whitelisted handle is ONLY permitted if it matches active profile running the sync
      return handle.toLowerCase() === activeLower;
    }
    return true;
  });
}

// Background Worker Loop
let isProcessing = false;

async function pollJobs() {
  if (isProcessing) return;

  try {
    // 1. Fetch pending job
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

    if (!jobs || jobs.length === 0) {
      return;
    }

    const currentJob = jobs[0];
    isProcessing = true;

    console.log(`Processing job ${currentJob.id} for user @${currentJob.username}`);

    // 2. Mark as processing
    await supabase
      .from('jobs')
      .update({ status: 'processing' })
      .eq('id', currentJob.id);

    // 3. Execute Instagram API processing
    const activeUsername = currentJob.username;
    const botSessionCookie = process.env.BOT_SESSION_COOKIE;

    const ig = new IgApiClient();

    if (botSessionCookie) {
      try {
        await ig.state.deserializeCookieJar(botSessionCookie);
      } catch (e) {
        console.warn('Could not deserialize BOT_SESSION_COOKIE jar directly:', e.message);
      }
    }

    // Accept pending connection requests if method exists
    try {
      const pendingRequests = await ig.friendship.pendingRequests();
      if (pendingRequests && pendingRequests.users) {
        for (const user of pendingRequests.users) {
          await ig.friendship.approve(user.pk);
        }
      }
    } catch (e) {
      // Non-fatal if pending requests check fails
      console.log('Pending requests check skipped/failed:', e.message);
    }

    // Resolve target user PK
    const targetPk = await ig.user.getIdByUsername(activeUsername);

    // Fetch Followers
    const followersFeed = ig.feed.accountFollowers(targetPk);
    const followersItems = await followersFeed.items();
    const followersUsernames = followersItems.map(item => item.username);

    // Fetch Following
    const followingFeed = ig.feed.accountFollowing(targetPk);
    const followingItems = await followingFeed.items();
    const followingUsernames = followingItems.map(item => item.username);

    const followersSet = new Set(followersUsernames.map(u => u.toLowerCase()));
    const followingSet = new Set(followingUsernames.map(u => u.toLowerCase()));

    // Relational calculations
    // Non-followers: users target is following, but who don't follow back
    const rawNonFollowers = followingUsernames.filter(u => !followersSet.has(u.toLowerCase()));

    // Mutuals: users target is following who also follow back
    const rawMutuals = followingUsernames.filter(u => followersSet.has(u.toLowerCase()));

    // Fans: users following target, but target doesn't follow back
    const rawFans = followersUsernames.filter(u => !followingSet.has(u.toLowerCase()));

    // Apply strict whitelist exclusion rules
    const filteredNonFollowers = filterUserList(rawNonFollowers, activeUsername);
    const filteredMutuals = filterUserList(rawMutuals, activeUsername);
    const filteredFans = filterUserList(rawFans, activeUsername);

    const resultPayload = {
      non_followers: filteredNonFollowers,
      mutuals: filteredMutuals,
      fans: filteredFans,
      counts: {
        non_followers: filteredNonFollowers.length,
        mutuals: filteredMutuals.length,
        fans: filteredFans.length
      },
      updated_at: new Date().toISOString()
    };

    // 4. Mark job as done and update result payload
    await supabase
      .from('jobs')
      .update({
        status: 'done',
        result: resultPayload
      })
      .eq('id', currentJob.id);

    console.log(`Successfully completed job ${currentJob.id} for @${activeUsername}`);

  } catch (err) {
    console.error('Error processing job:', err);
    // Attempt to record failure on current job if error occurred
    try {
      const { data: jobs } = await supabase
        .from('jobs')
        .select('id')
        .eq('status', 'processing')
        .limit(1);

      if (jobs && jobs.length > 0) {
        await supabase
          .from('jobs')
          .update({
            status: 'error',
            error: err.message || 'Error occurred during Instagram data analysis.'
          })
          .eq('id', jobs[0].id);
      }
    } catch (e) {
      console.error('Failed to set error status on job:', e.message);
    }
  } finally {
    isProcessing = false;
  }
}

// Poll every 3 seconds
setInterval(pollJobs, 3000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Social Analyzer worker listening on port ${PORT}`);
});
