const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

let currentPath = '/';
let role = 'guest';
let currentEditingPath = '';

const API_BASE = '/start-index/api';

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try { const data = await res.json(); msg = data.error || msg; } catch {}
    throw new Error(msg);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

function toast(message, ms = 1800) {
  const el = $('#toast');
  el.textContent = message;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, ms);
}

function formatSize(size) {
  if (size == null) return '-';
  const units = ['B','KB','MB','GB','TB'];
  let s = size, i = 0;
  while (s >= 1024 && i < units.length - 1) { s /= 1024; i++; }
  return `${s.toFixed(s < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function normalizeDirPath(input) {
  let p = (input || '').trim();
  if (!p) return '';
  if (!p.startsWith('/')) p = '/' + p;
  p = p.replace(/\/+/g, '/');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

async function refreshRole() {
  const data = await api(`${API_BASE}/whoami`);
  role = data.role;
  $('#role').textContent = role;
  const admin = role === 'admin';
  $('#loginBtn').style.display = admin ? 'none' : 'inline-block';
  $('#logoutBtn').style.display = admin ? 'inline-block' : 'none';
  $('#mkdirBtn').disabled = !admin;
  $('#uploadBtn').disabled = !admin;
  $('#uploadInput').disabled = !admin;
  $$('.admin-only').forEach(el => el.style.display = admin ? '' : 'none');
}

function renderBreadcrumbs() {
  const nav = $('#breadcrumbs');
  nav.innerHTML = '';
  const parts = currentPath.split('/').filter(Boolean);
  const root = document.createElement('a');
  root.href = 'javascript:void(0)';
  root.textContent = '/';
  root.onclick = () => list('/');
  nav.appendChild(root);
  let agg = '';
  parts.forEach((p) => {
    const sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = ' / ';
    nav.appendChild(sep);
    agg += '/' + p;
    const a = document.createElement('a');
    a.href = 'javascript:void(0)';
    a.textContent = p;
    a.onclick = () => list(agg);
    nav.appendChild(a);
  });
}

async function list(pathname = currentPath) {
  const data = await api(`${API_BASE}/list?path=${encodeURIComponent(pathname)}`);
  currentPath = data.path || '/';
  $('#currentPath').textContent = currentPath;
  renderBreadcrumbs();
  const body = $('#fileBody');
  body.innerHTML = '';
  for (const item of data.items) {
    const tr = document.createElement('tr');
    const iconTd = document.createElement('td');
    iconTd.innerHTML = item.type === 'dir' ? '📁' : '📄';
    const nameTd = document.createElement('td');
    if (item.type === 'dir') {
      const btn = document.createElement('button');
      btn.textContent = item.name + '/';
      btn.className = 'btn secondary op-btn';
      btn.onclick = () => list(joinPath(currentPath, item.name));
      nameTd.appendChild(btn);
    } else {
      const a = document.createElement('a');
      a.textContent = item.name;
      a.href = 'javascript:void(0)';
      a.onclick = () => openFile(joinPath(currentPath, item.name));
      nameTd.appendChild(a);
    }
    const sizeTd = document.createElement('td');
    sizeTd.textContent = item.type === 'file' ? formatSize(item.size) : '-';
    const timeTd = document.createElement('td');
    timeTd.textContent = new Date(item.mtimeMs).toLocaleString();
    const opsTd = document.createElement('td');

    const dl = document.createElement('a');
    dl.textContent = '下载';
    dl.className = 'dl op-btn';
    if (item.type === 'file') {
      dl.href = `${API_BASE}/download?path=${encodeURIComponent(joinPath(currentPath, item.name))}`;
    } else {
      dl.href = 'javascript:void(0)';
    }
    opsTd.appendChild(dl);

    if (role === 'admin') {
      const renameBtn = document.createElement('button');
      renameBtn.textContent = '重命名';
      renameBtn.className = 'btn op-btn';
      renameBtn.onclick = async () => {
        const newName = prompt('输入新名称：', item.name);
        if (!newName || newName === item.name) return;
        await api(`${API_BASE}/rename`, { method: 'POST', body: JSON.stringify({ path: joinPath(currentPath, item.name), newName }) });
        toast('已重命名');
        await list();
      };
      opsTd.appendChild(renameBtn);

      const moveBtn = document.createElement('button');
      moveBtn.textContent = '移动';
      moveBtn.className = 'btn op-btn';
      moveBtn.onclick = async () => {
        try {
          const toInput = prompt('移动到哪个文件夹？输入目标路径（例如 /docs ）：', currentPath || '/');
          if (toInput == null) return;
          const targetDir = normalizeDirPath(toInput);
          if (!targetDir) return;
          const fromPath = joinPath(currentPath, item.name);
          if (targetDir === currentPath) return toast('目标文件夹与当前相同');
          await api(`${API_BASE}/move`, { method: 'POST', body: JSON.stringify({ path: fromPath, to: targetDir }) });
          toast('已移动');
          await list();
        } catch (e) {
          toast(e.message || '移动失败');
        }
      };
      opsTd.appendChild(moveBtn);

      const delBtn = document.createElement('button');
      delBtn.textContent = '删除';
      delBtn.className = 'btn danger op-btn';
      delBtn.onclick = async () => {
        if (!confirm('确认删除？')) return;
        await api(`${API_BASE}/delete?path=${encodeURIComponent(joinPath(currentPath, item.name))}`, { method: 'DELETE' });
        toast('已删除');
        await list();
      };
      opsTd.appendChild(delBtn);
    }

    tr.appendChild(iconTd);
    tr.appendChild(nameTd);
    tr.appendChild(sizeTd);
    tr.appendChild(timeTd);
    tr.appendChild(opsTd);
    body.appendChild(tr);
  }
}

function joinPath(base, name) {
  if (base.endsWith('/')) return base + name;
  if (!base) return '/' + name;
  return base + '/' + name;
}

async function openFile(targetPath) {
  try {
    const data = await api(`${API_BASE}/read?path=${encodeURIComponent(targetPath)}`);
    currentEditingPath = targetPath;
    $('#editorSection').style.display = 'grid';
    $('#editorFilename').textContent = targetPath;
    $('#editorArea').value = data.content || '';
    renderPreview();
  } catch (e) {
    window.location.href = `${API_BASE}/download?path=${encodeURIComponent(targetPath)}`;
  }
}

function renderPreview() {
  const text = $('#editorArea').value || '';
  const isMd = /\.(md|markdown)$/i.test(currentEditingPath || '');
  if (isMd && window.marked) {
    $('#preview').innerHTML = marked.parse(text);
  } else {
    $('#preview').textContent = text;
  }
}

async function saveEdit() {
  if (!currentEditingPath) return;
  await api(`${API_BASE}/write`, { method: 'POST', body: JSON.stringify({ path: currentEditingPath, content: $('#editorArea').value }) });
  toast('已保存');
  await list();
}

function openLoginModal() {
  $('#loginModal').style.display = 'grid';
  $('#loginUser').focus();
}
function closeLoginModal() { $('#loginModal').style.display = 'none'; }

async function doLoginModal() {
  const username = $('#loginUser').value.trim();
  const password = $('#loginPass').value;
  if (!username || !password) return toast('请输入用户名和密码');
  await api(`${API_BASE}/login`, { method: 'POST', body: JSON.stringify({ username, password }) });
  toast('登录成功');
  closeLoginModal();
  await refreshRole();
}

async function doLogout() {
  await api(`${API_BASE}/logout`, { method: 'POST' });
  toast('已退出');
  await refreshRole();
}

async function mkdir() {
  const name = $('#folderName').value.trim();
  if (!name) return toast('请输入名称');
  await api(`${API_BASE}/mkdir`, { method: 'POST', body: JSON.stringify({ path: currentPath, name }) });
  $('#folderName').value = '';
  toast('已创建');
  await list();
}

async function upload(files) {
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  const res = await fetch(`${API_BASE}/upload?path=${encodeURIComponent(currentPath)}`, { method: 'POST', body: fd, credentials: 'include' });
  if (!res.ok) { toast('上传失败'); return; }
  toast('上传成功');
  $('#uploadInput').value = '';
  $('#chosenText').textContent = '未选择任何文件';
  await list();
}

function setupDropzone() {
  const dz = $('#dropzone');
  ['dragenter','dragover'].forEach(evt => dz.addEventListener(evt, e => { e.preventDefault(); e.stopPropagation(); dz.classList.add('dragover'); }));
  ['dragleave','drop'].forEach(evt => dz.addEventListener(evt, e => { e.preventDefault(); e.stopPropagation(); dz.classList.remove('dragover'); }));
  dz.addEventListener('drop', async (e) => {
    const files = e.dataTransfer?.files;
    if (files && files.length) await upload(files);
  });
}

function goUp() {
  if (currentPath === '/' || !currentPath) return;
  const parts = currentPath.split('/').filter(Boolean);
  parts.pop();
  const parent = '/' + parts.join('/');
  list(parent || '/');
}

window.addEventListener('DOMContentLoaded', async () => {
  // Auth
  $('#loginBtn').onclick = openLoginModal;
  $('#logoutBtn').onclick = doLogout;
  $('#loginClose').onclick = closeLoginModal;
  $('#loginCancel').onclick = closeLoginModal;
  $('#loginSubmit').onclick = doLoginModal;

  // FS actions
  $('#mkdirBtn').onclick = mkdir;
  // Removed explicit click to avoid double-open; label[for] handles opening
  $('#uploadBtn').onclick = () => { const files = $('#uploadInput').files; if (!files || !files.length) return toast('请选择文件'); upload(files); };
  $('#uploadInput').addEventListener('change', () => {
    const files = $('#uploadInput').files;
    if (!files || !files.length) $('#chosenText').textContent = '未选择任何文件';
    else if (files.length === 1) $('#chosenText').textContent = files[0].name;
    else $('#chosenText').textContent = `${files.length} 个文件`;
  });

  $('#upBtn').onclick = goUp;
  $('#saveBtn').onclick = saveEdit;
  $('#closeEditorBtn').onclick = () => { $('#editorSection').style.display = 'none'; currentEditingPath=''; };
  $('#editorArea').addEventListener('input', renderPreview);

  setupDropzone();
  await refreshRole();
  await list('/');
});
