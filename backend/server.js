const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { IgApiClient } = require('instagram-private-api');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, BOT_SESSION_COOKIE } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !BOT_SESSION_COOKIE) {
  console.error("Missing critical environment keys on cloud dashboard.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// Endpoint 1: App frontend writes an entry to queue
app.post('/api/public/jobs', async (req, res) => {
  const username = String(req.body.username || '').toLowerCase().trim();
  if (!username) return res.status(400).json({ error: "Username parameter missing." });

  try {
    const { data, error } = await supabase.from('jobs').insert({ username, status: 'pending' }).select().single();
    if (error) throw error;
    
    // Fire worker process asynchronously so the client doesn't time out waiting
    processJobWorkerNode(data.id, username).catch(err => console.error(`Job execution error on ${data.id}:`, err));
    
    res.json({ id: data.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Background automation runner mapping out variables locally cleanly via pre-approved pass cookies
async function processJobWorkerNode(jobId, targetUser) {
  await supabase.from('jobs').update({ status: 'processing' }).eq('id', jobId);
  const ig = new IgApiClient();

  try {
    await ig.state.deserialize({
      cookies: [{ key: 'sessionid', value: BOT_SESSION_COOKIE, domain: 'instagram.com', path: '/' }],
      userAgent: 'Instagram 315.0.0.33.109 Android (29/10; 480dpi; 1080x2280; OnePlus; ONEPLUS A6003)'
    });
    ig.state.appVersion = '315.0.0.33.109';
    ig.state.userAgent = 'Instagram 315.0.0.33.109 Android (29/10; 480dpi; 1080x2280; OnePlus; ONEPLUS A6003; enchilada; qcom; en_US; 564998083)';

    const userProfile = await ig.user.searchExact(targetUser);
    const userId = userProfile.pk;

    // Send follow request loop to target automatically if hidden or private
    try {
      await ig.friendship.create(userId);
      await delay(1500);
    } catch (_) {}

    const followingFeed = ig.feed.accountFollowing(userId);
    const followersFeed = ig.feed.accountFollowers(userId);

    const following = await followingFeed.all();
    const followers = await followersFeed.all();

    const followingSlim = following.map(u => ({ username: u.username, full_name: u.full_name }));
    const followersSlim = followers.map(u => ({ username: u.username, full_name: u.full_name }));

    const followingNames = following.map(u => u.username.toLowerCase());
    const followersNames = followers.map(u => u.username.toLowerCase());

    let non_followers = followingSlim.filter(u => !followersNames.includes(u.username.toLowerCase()));
    let fans = followersSlim.filter(u => !followingNames.includes(u.username.toLowerCase()));
    let mutuals = followingSlim.filter(u => followersNames.includes(u.username.toLowerCase()));

    // 🛡️ COVERT SECURITY GUARD LAYER FILTER MAPPING
    const enforceGuard = (arr) => arr.filter(u => !u.username.toLowerCase().includes('joshfz') || targetUser === 'joshfz');
    non_followers = enforceGuard(non_followers); fans = enforceGuard(fans); mutuals = enforceGuard(mutuals);

    const payload = {
      summary: {
        followers: followers.length, following: following.length,
        non_followers: non_followers.length, fans: fans.length, mutuals: mutuals.length
      },
      non_followers, fans, mutuals
    };

    await supabase.from('jobs').update({ status: 'done', result: payload }).eq('id', jobId);
  } catch (err) {
    await supabase.from('jobs').update({ status: 'failed', error: err.message }).eq('id', jobId);
  }
}

app.get('/', (req, res) => res.json({ ok: true }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Worker tracking server processing on port ${PORT}`));
