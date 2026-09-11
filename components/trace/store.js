// The store (3.2): the trace's private way of reaching the other tabs of this
// origin. A BroadcastChannel carries one origin's tab-to-tab messages; the machine
// stays a pure definition by receiving this wrapper through input. Section 12: it
// bridges tabs in one browser, not devices.
export function openChannel(name) {
  const channel = new BroadcastChannel(name);
  return {
    post(message) {
      channel.postMessage(message);
    },
    subscribe(fn) {
      const handler = (event) => fn(event.data);
      channel.addEventListener("message", handler);
      return () => channel.removeEventListener("message", handler);
    },
    close() {
      channel.close();
    },
  };
}
