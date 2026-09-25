export function isSyncConfigured() {
  return window.parent !== window && new URLSearchParams(location.search).get('private') === '1';
}

export async function syncRequest(path, { method = 'GET', body } = {}) {
  if (!isSyncConfigured()) throw new Error('本人版でのみNotion同期を利用できます');
  const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      window.removeEventListener('message', receive);
      reject(new Error('同期が時間内に終わりませんでした'));
    }, 20000);
    function receive(event) {
      const data = event.data;
      if (event.source !== window.parent || data?.channel !== 'tavi-private' || data.id !== id) return;
      clearTimeout(timeout);
      window.removeEventListener('message', receive);
      if (data.error) reject(new Error(data.error)); else resolve(data.result);
    }
    window.addEventListener('message', receive);
    window.parent.postMessage({ channel: 'tavi-private', id, path, method, body }, '*');
  });
}
