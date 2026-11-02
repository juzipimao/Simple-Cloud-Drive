const { test } = require('node:test');
const assert = require('node:assert/strict');
const downloads = import('../server/download-links.js');

test('links have independent unpredictable tokens and expire after exactly one hour without sliding', async () => {
  const { DownloadLinks, DOWNLOAD_LINK_TTL_MS } = await downloads;
  assert.equal(DOWNLOAD_LINK_TTL_MS, 3600000);
  let now = 1000000;
  const links = new DownloadLinks({ now: () => now });
  const first = links.create({ filePath: '/one.txt', identity: 'one' });
  const second = links.create({ filePath: '/two.txt', identity: 'two' });
  assert.notEqual(first.token, second.token);
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(first.expiresAt, now + 3600000);
  assert.equal(links.get(first.token).filePath, '/one.txt');
  now = first.expiresAt - 1;
  assert.equal(links.get(first.token).expiresAt, first.expiresAt);
  now++;
  assert.equal(links.get(first.token), null);
  assert.equal(links.get(second.token), null);
  now = 1000000;
  assert.equal(links.get(first.token), null, 'an expired entry must not revive on clock rollback');
});

test('invalid token formats fail closed without coercion', async () => {
  const { DownloadLinks } = await downloads;
  const links = new DownloadLinks();
  for (const token of [null, undefined, {}, [], 42, '', 'a'.repeat(42), 'a'.repeat(44), '../private.txt']) {
    assert.equal(links.get(token), null);
  }
});

test('the store is bounded, does not evict active links, and reclaims expired entries', async () => {
  const { DownloadLinks } = await downloads;
  let now = 1000;
  const links = new DownloadLinks({ now: () => now, limit: 2 });
  const first = links.create({ filePath: '/one.txt' });
  links.create({ filePath: '/two.txt' });
  assert.throws(() => links.create({ filePath: '/three.txt' }), { status: 429 });
  assert.equal(links.get(first.token).filePath, '/one.txt');
  now = first.expiresAt;
  const fresh = links.create({ filePath: '/fresh.txt' });
  assert.equal(links.get(fresh.token).filePath, '/fresh.txt');
  assert.equal(links.get(first.token), null);
});

test('revocation and process/store restart invalidate existing links', async () => {
  const { DownloadLinks } = await downloads;
  const links = new DownloadLinks();
  const first = links.create({ filePath: '/one.txt' });
  const second = links.create({ filePath: '/two.txt' });
  links.revoke(first.token);
  assert.equal(links.get(first.token), null);
  assert.equal(links.get(second.token).filePath, '/two.txt');
  assert.equal(new DownloadLinks().get(second.token), null);
});
