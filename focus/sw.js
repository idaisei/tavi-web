self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((client) => 'focus' in client);
    if (existing) return existing.focus();
    return clients.openWindow('./');
  })());
});
