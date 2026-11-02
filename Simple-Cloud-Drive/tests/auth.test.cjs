const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, copyFile, symlink, writeFile, rm, rename, readdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');

const root = path.resolve(__dirname, '..');
const username = 'test-admin';
const password = 'test-password';
const secret = 'test-jwt-secret';
let directory;
let server;
let baseUrl;

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'cloud-drive-auth-'));
  await mkdir(path.join(directory, 'server'));
  await mkdir(path.join(directory, 'storage'));
  await copyFile(path.join(root, 'server/index.js'), path.join(directory, 'server/index.js'));
  await copyFile(path.join(root, 'server/download-links.js'), path.join(directory, 'server/download-links.js'));
  await copyFile(path.join(root, 'package.json'), path.join(directory, 'package.json'));
  await symlink(path.join(root, 'public'), path.join(directory, 'public'), 'dir');
  await symlink(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
  await writeFile(path.join(directory, 'storage/private.txt'), 'private fixture content');
  // Freeze/advance time in the test child only. No testing clock or expiry
  // override is exposed by the production API or environment configuration.
  await writeFile(path.join(directory, 'clock.cjs'), `
    let now = Date.now();
    Date.now = () => now;
    process.on('message', message => {
      if (typeof message.now === 'number') {
        now = message.now;
        process.send({ now });
      }
    });
  `);

  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['--require', './clock.cjs', 'server/index.js'], {
    cwd: directory,
    env: {
      ...process.env,
      PORT: String(port),
      STORAGE_ROOT: path.join(directory, 'storage'),
      ADMIN_USERNAME: username,
      ADMIN_PASSWORD: password,
      JWT_SECRET: secret,
      NODE_ENV: 'test',
      HTTPS: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Startup timed out: ${output}`)), 5000);
    server.on('error', error => { clearTimeout(timer); reject(error); });
    server.on('exit', code => { clearTimeout(timer); reject(new Error(`Server exited: ${code}; ${output}`)); });
    server.stderr.on('data', chunk => { output += chunk; });
    server.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('Simple Cloud Drive running on')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
});

after(async () => {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = once(server, 'exit');
    server.kill();
    await exited;
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

function request(url, options = {}) {
  return fetch(`${baseUrl}${url}`, { redirect: 'manual', ...options });
}

async function login(prefix = '/start-index/api') {
  const response = await request(`${prefix}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}

test('guest page requests are redirected before management HTML or scripts are served', async () => {
  for (const url of ['/start-index', '/start-index/', '/start-index/index.html', '/start-index/index%2ehtml', '/start-index/%69ndex.html', '/start-index/app.js']) {
    const response = await request(url);
    assert.equal(response.status, 302, url);
    assert.equal(response.headers.get('location'), '/start-index/login', url);
    assert.equal(response.headers.get('cache-control'), 'no-store', url);
    assert.doesNotMatch(await response.text(), /id="fileTable"|currentEditingPath/);
  }
});

test('the standalone login screen and its assets remain public', async () => {
  for (const url of ['/start-index/login', '/start-index/login.html']) {
    const response = await request(url);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /id="loginForm"/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  for (const file of ['style.css', 'login.js']) {
    assert.equal((await request(`/start-index/${file}`)).status, 200);
  }
});

test('both API prefixes block file listing, preview and download for guests', async () => {
  for (const prefix of ['/api', '/start-index/api']) {
    assert.deepEqual(await (await request(`${prefix}/whoami`)).json(), { role: 'guest' });
    for (const endpoint of ['list', 'read', 'download']) {
      const response = await request(`${prefix}/${endpoint}?path=/private.txt`);
      assert.equal(response.status, 401, `${prefix}/${endpoint}`);
      assert.deepEqual(await response.json(), { error: 'Authentication required' });
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    for (const endpoint of ['write', 'mkdir', 'rename', 'move', 'upload', 'share']) {
      assert.equal((await request(`${prefix}/${endpoint}`, { method: 'POST' })).status, 401);
    }
    assert.equal((await request(`${prefix}/delete`, { method: 'DELETE' })).status, 401);
  }
});

test('invalid and expired cookies cannot access private files', async () => {
  for (const token of ['invalid', jwt.sign({ role: 'admin' }, secret, { expiresIn: -1 })]) {
    const headers = { Cookie: `token=${token}` };
    assert.equal((await request('/api/read?path=/private.txt', { headers })).status, 401);
    assert.equal((await request('/start-index/index%2ehtml', { headers })).status, 302);
  }
});

test('wrong credentials do not issue a cookie', async () => {
  const response = await request('/start-index/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'wrong' }),
  });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('set-cookie'), null);
});

test('login permits browsing, reading and downloading through both API prefixes', async () => {
  for (const prefix of ['/api', '/start-index/api']) {
    const headers = { Cookie: await login(prefix) };
    const page = await request('/start-index/', { headers });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /id="fileTable"/);
    const list = await request(`${prefix}/list`, { headers });
    assert.equal(list.status, 200);
    assert.equal((await list.json()).items[0].name, 'private.txt');
    const read = await request(`${prefix}/read?path=/private.txt`, { headers });
    assert.equal(read.status, 200);
    assert.equal((await read.json()).content, 'private fixture content');
    const download = await request(`${prefix}/download?path=/private.txt`, { headers });
    assert.equal(download.status, 200);
    assert.equal(await download.text(), 'private fixture content');
    assert.equal(download.headers.get('cache-control'), 'no-store');
    const loginPage = await request('/start-index/login', { headers });
    assert.equal(loginPage.status, 302);
    assert.equal(loginPage.headers.get('location'), '/start-index/');
    const logout = await request(`${prefix}/logout`, { method: 'POST', headers });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie'), /^token=;/);
    assert.equal((await request('/start-index/')).status, 302);
    assert.equal((await request(`${prefix}/list`)).status, 401);
  }
});

async function share(filePath = '/private.txt', extra = {}, prefix = '/start-index/api') {
  return request(`${prefix}/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: await login(), ...extra.headers },
    body: JSON.stringify({ path: filePath, ...extra.body }),
  });
}

async function createShare(filePath = '/private.txt') {
  const response = await share(filePath);
  assert.equal(response.status, 201);
  return response.json();
}

test('both API prefixes issue opaque, fixed one-hour links that work without login', async () => {
  for (const prefix of ['/start-index/api', '/api']) {
    const response = await share('/private.txt', { body: { expiresAt: 9999999999999, ttl: 9999999, role: 'admin' } }, prefix);
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const link = await response.json();
    assert.match(link.url, /^\/start-index\/share\/[A-Za-z0-9_-]{43}$/);
    assert.ok(Math.abs(link.expiresAt - Date.now() - 3600000) < 10000);
    assert.doesNotMatch(JSON.stringify(link), /private\.txt|test-admin|test-jwt-secret/);
    for (let attempt = 0; attempt < 2; attempt++) {
      const download = await request(link.url);
      assert.equal(download.status, 200);
      assert.equal(await download.text(), 'private fixture content');
      assert.equal(download.headers.get('set-cookie'), null);
      assert.equal(download.headers.get('cache-control'), 'no-store');
      assert.equal(download.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
      assert.match(download.headers.get('content-disposition'), /^attachment;/);
      assert.equal(download.headers.get('content-type'), 'application/octet-stream');
      assert.match(download.headers.get('content-security-policy'), /sandbox/);
      assert.match(download.headers.get('x-robots-tag'), /noindex/);
    }
  }
});

test('a public link cannot choose a different file, browse, or become an admin JWT', async () => {
  const { url } = await createShare();
  const token = url.split('/').pop();
  await writeFile(path.join(directory, 'storage/other.txt'), 'do not share this');
  const response = await request(`${url}?path=/other.txt&role=admin&expiresAt=9999999999999`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'private fixture content');
  for (const prefix of ['/api', '/start-index/api']) {
    for (const endpoint of ['list', 'read', 'download']) {
      assert.equal((await request(`${prefix}/${endpoint}?path=/other.txt&token=${token}`, {
        headers: { Cookie: `token=${token}`, Authorization: `Bearer ${token}` },
      })).status, 401);
    }
    assert.deepEqual(await (await request(`${prefix}/whoami`, { headers: { Cookie: `token=${token}` } })).json(), { role: 'guest' });
    const mint = await request(`${prefix}/share`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `token=${token}` },
      body: JSON.stringify({ path: '/other.txt' }),
    });
    assert.equal(mint.status, 401);
  }
});

test('forged/malformed tokens and login JWTs cannot be used as download links', async () => {
  const { url } = await createShare();
  const token = url.split('/').pop();
  const tampered = (token[0] === 'A' ? 'B' : 'A') + token.slice(1);
  for (const candidate of [tampered, 'a'.repeat(43), 'invalid', 'a'.repeat(44), jwt.sign({ role: 'admin' }, secret)]) {
    const response = await request(`/start-index/share/${candidate}`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'Download link invalid or expired' });
  }
  for (const cookie of ['invalid', jwt.sign({ role: 'admin' }, secret, { expiresIn: -1 })]) {
    const response = await request('/api/share', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `token=${cookie}` },
      body: JSON.stringify({ path: '/private.txt' }),
    });
    assert.equal(response.status, 401);
  }
});

test('HEAD returns only metadata and does not consume or leak the download descriptor', async () => {
  const { url } = await createShare();
  const before = (await readdir(`/proc/${server.pid}/fd`)).length;
  for (let i = 0; i < 20; i++) {
    const response = await request(url, { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-length'), String(Buffer.byteLength('private fixture content')));
    assert.equal(await response.text(), '');
  }
  const after = (await readdir(`/proc/${server.pid}/fd`)).length;
  assert.ok(after <= before + 2, `${before} -> ${after} descriptors`);
  assert.equal(await (await request(url)).text(), 'private fixture content');
});

test('creation rejects directories, missing files, path traversal and malformed path types', async () => {
  await writeFile(path.join(directory, 'outside.txt'), 'outside storage');
  for (const filePath of ['/', '', '../outside.txt', '/nested/../../outside.txt', '/private.txt\0', '/..\\outside.txt', null, 42, {}, ['/private.txt']]) {
    const response = await share(filePath);
    assert.equal(response.status, 400, JSON.stringify(filePath));
    assert.deepEqual(await response.json(), { error: 'File unavailable or invalid path' });
  }
  assert.equal((await share('/missing.txt')).status, 404);
});

test('creation and normal downloads reject file and parent-directory symlinks', async () => {
  await mkdir(path.join(directory, 'external'));
  await writeFile(path.join(directory, 'external/secret.txt'), 'external secret');
  await symlink(path.join(directory, 'external/secret.txt'), path.join(directory, 'storage/linked.txt'));
  await symlink(path.join(directory, 'external'), path.join(directory, 'storage/linked-dir'), 'dir');
  await symlink(path.join(directory, 'storage/private.txt'), path.join(directory, 'storage/internal-link.txt'));
  for (const filePath of ['/linked.txt', '/linked-dir/secret.txt', '/internal-link.txt']) {
    assert.equal((await share(filePath)).status, 400, filePath);
    const headers = { Cookie: await login() };
    assert.equal((await request(`/api/download?path=${encodeURIComponent(filePath)}`, { headers })).status, 400);
    assert.equal((await request(`/api/read?path=${encodeURIComponent(filePath)}`, { headers })).status, 400);
  }
});

test('editing or replacing a shared file invalidates its old link', async () => {
  const target = path.join(directory, 'storage/change.txt');
  await writeFile(target, 'old contents');
  const edited = await createShare('/change.txt');
  await writeFile(target, 'new contents');
  assert.equal((await request(edited.url)).status, 404);
  await writeFile(target, 'old contents');
  assert.equal((await request(edited.url)).status, 404, 'restoring bytes must not revive the link');

  const replaced = await createShare('/change.txt');
  await writeFile(path.join(directory, 'replacement.txt'), 'old contents');
  await rename(path.join(directory, 'replacement.txt'), target);
  assert.equal((await request(replaced.url)).status, 404, 'a different inode is not the shared file');
  const fresh = await createShare('/change.txt');
  assert.equal(await (await request(fresh.url)).text(), 'old contents');
});

test('deletion, rename and symlink swaps never expose replacement contents', async () => {
  const target = path.join(directory, 'storage/swap.txt');
  await writeFile(target, 'shared contents');
  const swapped = await createShare('/swap.txt');
  await rename(target, target + '.old');
  await symlink(path.join(directory, 'external/secret.txt'), target);
  assert.equal((await request(swapped.url)).status, 404);
  await rm(target);
  await rename(target + '.old', target);
  assert.equal((await request(swapped.url)).status, 404);

  const deleted = await createShare('/swap.txt');
  await rm(target);
  assert.equal((await request(deleted.url)).status, 404);

  await mkdir(path.join(directory, 'storage/nested'));
  await writeFile(path.join(directory, 'storage/nested/secret.txt'), 'shared nested contents');
  const nested = await createShare('/nested/secret.txt');
  assert.equal(await (await request(nested.url)).text(), 'shared nested contents');
  await rename(path.join(directory, 'storage/nested'), path.join(directory, 'storage/nested-old'));
  await symlink(path.join(directory, 'external'), path.join(directory, 'storage/nested'), 'dir');
  assert.equal((await request(nested.url)).status, 404);
});

test('foreign origins cannot mint links and bearer URLs ignore forwarded hosts', async () => {
  for (const headers of [
    { Origin: 'https://evil.example' },
    { Origin: 'null' },
    { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'same-site' },
    { 'Sec-Fetch-Site': 'cross-site' },
  ]) {
    const response = await share('/private.txt', { headers });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  const response = await share('/private.txt', { headers: {
    Origin: baseUrl, 'Sec-Fetch-Site': 'same-origin', 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-Proto': 'https',
  } });
  assert.equal(response.status, 201);
  assert.match((await response.json()).url, /^\/start-index\/share\//);
});

test('Unicode/HTML filenames download as attachments without rendering active content', async () => {
  const filename = '测试 <script> & "文件.html';
  const content = '<script>fetch("/api/share")</script>';
  await writeFile(path.join(directory, 'storage', filename), content);
  const { url } = await createShare('/' + filename);
  const response = await request(url);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), content);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.match(response.headers.get('content-disposition'), /^attachment;.*filename\*=UTF-8''/);
});

test('the sanitizer is available only after login and is loaded before the application', async () => {
  assert.equal((await request('/start-index/dompurify.min.js')).status, 302);
  const headers = { Cookie: await login() };
  const script = await request('/start-index/dompurify.min.js', { headers });
  assert.equal(script.status, 200);
  assert.match(await script.text(), /DOMPurify/);
  const html = await (await request('/start-index/', { headers })).text();
  assert.ok(html.indexOf('/start-index/dompurify.min.js') < html.indexOf('/start-index/app.js'));
  assert.match(html, /id="shareDialog"/);
});

test('public GET and HEAD expire at the one-hour boundary, even with an admin cookie', async () => {
  const cookie = await login();
  const { url, expiresAt } = await createShare();
  async function setClock(now) {
    const ack = once(server, 'message');
    server.send({ now });
    assert.deepEqual((await ack)[0], { now });
  }
  try {
    await setClock(expiresAt - 1);
    assert.equal(await (await request(url)).text(), 'private fixture content');
    assert.equal((await request(url, { method: 'HEAD' })).status, 200);
    await setClock(expiresAt);
    for (const options of [{}, { method: 'HEAD' }, { headers: { Cookie: cookie } }]) {
      const response = await request(url, options);
      assert.equal(response.status, 404);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    await setClock(expiresAt + 3600000);
    assert.equal((await request(url)).status, 404);
  } finally {
    await setClock(Date.now());
  }
});
