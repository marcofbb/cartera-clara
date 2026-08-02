export function track(eventName, params = {}) {
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push({ event: eventName, ...params });
}
