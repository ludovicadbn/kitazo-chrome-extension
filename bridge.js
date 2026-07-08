// Isolated world: ponte fra pagina (MAIN) e service worker, nei due sensi.

// pagina -> service worker
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const d = event.data;
  if (!d || typeof d.__tvtimeExport !== "string") return;

  switch (d.__tvtimeExport) {
    case "record":
      chrome.runtime.sendMessage({ type: "capture", record: d.record }).catch(() => {});
      break;
    case "token":
      chrome.runtime.sendMessage({ type: "token", jwt: d.jwt }).catch(() => {});
      break;
    case "uid":
      chrome.runtime.sendMessage({ type: "uid", uid: d.uid }).catch(() => {});
      break;
    case "pullStart":
      chrome.runtime.sendMessage({ type: "pullStart", total: d.total }).catch(() => {});
      break;
    case "pullProgress":
      chrome.runtime.sendMessage({ type: "pullProgress", done: d.done }).catch(() => {});
      break;
    case "pullSetTotal":
      chrome.runtime.sendMessage({ type: "pullSetTotal", total: d.total }).catch(() => {});
      break;
    case "pullSetTotalAdd":
      chrome.runtime.sendMessage({ type: "pullSetTotalAdd", add: d.add }).catch(() => {});
      break;
    case "pullProgressAdd":
      chrome.runtime.sendMessage({ type: "pullProgressAdd", add: d.add }).catch(() => {});
      break;
    case "pullResult":
      chrome.runtime
        .sendMessage({
          type: "savePull",
          label: d.label,
          target: d.target,
          status: d.status,
          ok: d.ok,
          data: d.data,
          error: d.error,
        })
        .catch(() => {});
      break;
    case "pullDone":
      chrome.runtime.sendMessage({ type: "pullDone", error: d.error }).catch(() => {});
      break;
  }
});

// service worker / popup -> pagina (avvio del pull)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "startPull") {
    window.postMessage(
      { __tvtimeExport: "startPull", jwt: msg.jwt, uid: msg.uid, deepVotes: msg.deepVotes },
      location.origin,
    );
  }
});
