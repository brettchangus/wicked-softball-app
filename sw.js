self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();
  const tasks = [
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/assets/dumpling.png',
      badge: '/assets/dumpling.png',
      tag: data.tag || 'wicked-score',
      renotify: true,
      vibrate: [200, 100, 200],
      data: { url: data.url || '/' }
    })
  ];
  // A "refresh" push tells any open tabs to reload (pull the latest app + data now).
  if (data.refresh) {
    tasks.push(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true })
        .then(list => list.forEach(c => c.postMessage({ type: 'refresh' })))
    );
  }
  event.waitUntil(Promise.all(tasks));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return ('navigate' in client ? client.navigate(target) : Promise.resolve(client))
            .then(c => c && c.focus ? c.focus() : client.focus());
        }
      }
      if (clients.openWindow) return clients.openWindow(target);
    })
  );
});
