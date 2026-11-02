const form = document.getElementById('loginForm');
const button = document.getElementById('loginSubmit');
const error = document.getElementById('loginError');

form.addEventListener('submit', async event => {
  event.preventDefault();
  error.textContent = '';
  button.disabled = true;
  try {
    const response = await fetch('/start-index/api/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('loginUser').value.trim(),
        password: document.getElementById('loginPass').value,
      }),
    });
    if (!response.ok) {
      error.textContent = response.status === 401 ? '用户名或密码错误' : '登录失败，请重试';
      return;
    }
    location.replace('/start-index/');
  } catch {
    error.textContent = '网络异常，请稍后重试';
  } finally {
    button.disabled = false;
  }
});
