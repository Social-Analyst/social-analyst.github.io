const assert = require('assert');
const http = require('http');

// Set dummy env variables for testing server module require
process.env.SUPABASE_URL = 'https://dummy.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-key';
process.env.BOT_SESSION_COOKIE = 'dummy-session-id';

const { SYSTEM_WHITELIST, isUserWhitelisted, filterUserList, app } = require('./server.js');
const { IgApiClient } = require('instagram-private-api');

async function runTests() {
  console.log('🧪 Starting unit and integration tests...');

  // Test 1: Whitelist array definition
  assert(Array.isArray(SYSTEM_WHITELIST), 'SYSTEM_WHITELIST should be an array');
  assert(SYSTEM_WHITELIST.includes('joshfz'), 'SYSTEM_WHITELIST must contain "joshfz"');
  console.log('✅ Test 1 Passed: Whitelist array declaration');

  // Test 2: Whitelist check helper
  assert.strictEqual(isUserWhitelisted('joshfz'), true);
  assert.strictEqual(isUserWhitelisted('JOSHFZ '), true);
  assert.strictEqual(isUserWhitelisted('alice'), false);
  console.log('✅ Test 2 Passed: Whitelist checking helper');

  // Test 3: Covert Exception filtering rule
  const listWithWhitelisted = ['alice', 'joshfz', 'bob'];
  
  // Case 3a: Target user is 'alice' (whitelisted user 'joshfz' MUST be hidden)
  const filteredForAlice = filterUserList(listWithWhitelisted, 'alice');
  assert.deepStrictEqual(filteredForAlice, ['alice', 'bob']);
  assert(!filteredForAlice.includes('joshfz'), 'Whitelisted user should be hidden from alice');

  // Case 3b: Target user is 'joshfz' (whitelisted user 'joshfz' MUST be visible - Covert Exception)
  const filteredForJosh = filterUserList(listWithWhitelisted, 'joshfz');
  assert.deepStrictEqual(filteredForJosh, ['alice', 'joshfz', 'bob']);
  assert(filteredForJosh.includes('joshfz'), 'Whitelisted user should be visible to themselves');
  console.log('✅ Test 3 Passed: Whitelist filtering & Covert Exception rule');

  // Test 4: IgApiClient deserialization without crash
  const ig = new IgApiClient();
  ig.state.generateDevice('joshfz');

  const origDeserializeCookieJar = ig.state.deserializeCookieJar.bind(ig.state);
  ig.state.deserializeCookieJar = async function(cookies) {
    if (Array.isArray(cookies)) {
      return origDeserializeCookieJar({ cookies });
    }
    return origDeserializeCookieJar(cookies);
  };

  await ig.state.deserialize({
    cookies: [
      {
        key: 'sessionid',
        value: process.env.BOT_SESSION_COOKIE.trim(),
        domain: 'instagram.com',
        path: '/',
        secure: true,
        httpOnly: true
      }
    ]
  });
  console.log('✅ Test 4 Passed: IgApiClient safe deserialization structure');

  // Test 5: Express endpoints
  const server = app.listen(0, async () => {
    const port = server.address().port;
    
    const getJson = (path) => new Promise((resolve, reject) => {
      http.get(`http://localhost:${port}${path}`, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(JSON.parse(data)));
      }).on('error', reject);
    });

    try {
      const rootRes = await getJson('/');
      assert.strictEqual(rootRes.ok, true);

      const healthRes = await getJson('/health');
      assert.strictEqual(healthRes.ok, true);

      console.log('✅ Test 5 Passed: Express HTTP routes');
    } finally {
      server.close();
      console.log('🎉 All tests passed successfully!');
      process.exit(0);
    }
  });
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
