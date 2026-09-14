/** Fixed outer-page code; deck content is only rendered in opaque frames. */
export const offlineHostScript = String.raw`(() => {
  const main = document.querySelector('iframe');
  let popup, frame, latest;
  const send = data => { if (popup && !popup.closed) popup.postMessage(data, '*'); };
  window.addEventListener('message', event => {
    if (event.source === main.contentWindow) {
      if (event.data?.type === 'offline-state') { latest = event.data; send(latest); }
      if (event.data?.type !== 'offline-open') return;
      if (popup && !popup.closed) { popup.focus(); return; }
      popup = window.open('', '_blank', 'popup,width=1200,height=800');
      if (!popup) { main.contentWindow.postMessage({type:'offline-blocked'}, '*'); return; }
      popup.document.title = document.title;
      popup.document.body.style.cssText = 'margin:0;height:100vh;overflow:hidden';
      frame = popup.document.createElement('iframe');
      frame.name = 'octo-ppt-speaker'; frame.title = 'Speaker view';
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.style.cssText = 'border:0;width:100%;height:100%;display:block';
      // A fixed relay runs in the popup realm; both sides check the sender.
      const relay = popup.document.createElement('script');
      relay.textContent = "(() => { const host = opener; let latest; addEventListener('message', e => { const f = document.querySelector('iframe'); if(e.source===host && e.data?.type==='offline-state'){ latest=e.data; f.contentWindow.postMessage(latest,'*'); } else if(e.source===f?.contentWindow){ if(e.data?.type==='offline-ready' && latest) f.contentWindow.postMessage(latest,'*'); if(e.data?.type==='presenter-navigate') host.postMessage(e.data,'*'); } }); opener=null; })();";
      popup.document.head.append(relay);
      frame.srcdoc = main.srcdoc;
      popup.document.body.append(frame);
      if (latest) send(latest);
    } else if (popup && event.source === popup && event.data?.type === 'presenter-navigate' && Number.isInteger(event.data.index)) {
      main.contentWindow.postMessage(event.data, '*');
    }
  });
  addEventListener('pagehide', () => { if (popup && !popup.closed) popup.close(); });
})();`
