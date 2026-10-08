const { createClient } = require('@supabase/supabase-js');
const { IgApiClient } = require('instagram-private-api');

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, BOT_SESSION_COOKIE } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !BOT_SESSION_COOKIE) {
  console.error("Missing critical environment keys.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const delay = (ms) => new Promise(r => setTimeout(r, ms));

console.log("🤖 Cloud Worker Node initialized. Polling database for incoming job loops...");

// Continuous active cron loop polling the Supabase table for pending entries
async function lookForPendingJobs() {
  while (true) {
    try {
      const { data: jobs, error } = await supabase
        .from('jobs')
        .select('*')
        .eq('status', 'pending')
        .limit(1);

      if (error) throw error;

      if (jobs && jobs.length > 0) {
        const currentJob = jobs[0];
        console.log(`🚀 Found active queue entry for @${currentJob.username}. Starting scrape loop...`);
        await processJobWorkerNode(currentJob.id, currentJob.username);
      }
    } catch (e) {
      console.error("Error reading queue table logs:", e.message);
    }
    await delay(3000); // Check database every 3 seconds
  }
}

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

    // 🛡️ COVERT SECURITY GUARD LAYER
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
    console.log(`✅ Successfully crunched tracking array charts for @${targetUser}`);
  } catch (err) {
    console.error(`❌ Scraper Exception for ${targetUser}:`, err.message);
    await supabase.from('jobs').update({ status: 'failed', error: err.message }).eq('id', jobId);
  }
}

// Kickstart the background execution listener thread
lookForPendingJobs();
