// Titles come exclusively from the loaded source document. No remote metadata,
// thumbnail requests, page fetches, observers or background scans.
(() => {
  const version = chrome.runtime.getManifest().version;
  const previous = globalThis.__youtubeTabParkerLinks;
  previous?.dispose();
  const videoPaths = /^\/(watch\/?|playlist\/?|(shorts|live|embed|v)(\/.*)?)$/;
  const cards = "ytd-rich-item-renderer, ytd-rich-grid-media, ytd-video-renderer, ytd-compact-video-renderer, ytd-playlist-video-renderer, ytd-grid-video-renderer, yt-lockup-view-model, yt-shorts-lockup-view-model, ytm-video-with-context-renderer";
  const headings = "#video-title, #video-title-link, .yt-lockup-metadata-view-model__title, [role='heading'], h2, h3";
  const cardDecorations = "ytd-thumbnail-overlay-time-status-renderer, #overlays, #duration, .yt-badge-shape__text, yt-thumbnail-overlay-badge-view-model, .yt-thumbnail-overlay-badge-view-model";
  const translatedText = ".immersive-translate-target-wrapper, .immersive-translate-target-inner, [data-immersive-translate-translation-element-mark]";
  let contextLink;

  function clean(value) {
    return typeof value === "string" ? Array.from(value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()).slice(0, 200).join("") : "";
  }

  function parsedVideo(value) {
    try {
      const url = new URL(value, location.href);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) return null;
      const youtube = url.hostname === "youtube.com" || url.hostname.endsWith(".youtube.com");
      return ((youtube && videoPaths.test(url.pathname)) || (url.hostname === "youtu.be" && url.pathname.length > 1)) ? url : null;
    } catch { return null; }
  }

  function keyFor(value) {
    const url = parsedVideo(value);
    if (!url) return "";
    const parts = url.pathname.split("/").filter(Boolean);
    const videoId = url.hostname === "youtu.be" ? parts[0] : url.searchParams.get("v") ||
      (["shorts", "live", "embed", "v"].includes(parts[0]) ? parts[1] : "");
    if (videoId) return `video:${videoId}`;
    if (parts[0] === "playlist" && url.searchParams.get("list")) return `playlist:${url.searchParams.get("list")}`;
    return url.href;
  }

  function useful(value, key) {
    const title = clean(value);
    if (!title || title === key.split(":").slice(1).join(":") || /^https?:\/\//i.test(title)) return "";
    // Thumbnails often contain only a duration or an action label.
    if (/^(?:\d+:){1,2}\d{2}$/.test(title) || /^(play|watch|open|ansehen|abspielen|wiedergabe)( video)?$/i.test(title)) return "";
    return title;
  }

  function hidden(node) {
    if (node.hidden || node.getAttribute("aria-hidden") === "true") return true;
    const style = getComputedStyle(node);
    return style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse";
  }

  function titleText(node, includeTranslation = false) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
    if (node.nodeType !== Node.ELEMENT_NODE || hidden(node) ||
        node.matches("script, style, template, noscript") || node.matches(cardDecorations) || (!includeTranslation && node.matches(translatedText))) return "";
    if (node.tagName === "BR") return " ";
    return Array.from(node.childNodes, child => titleText(child, includeTranslation)).join("");
  }

  function ownTitle(node, key) {
    // textContent also contains hidden originals and injected translations.
    // Read one rendered title, retaining a translation only when no visible
    // source text remains. Never join the original and translated versions.
    for (let parent = node; parent; parent = parent.parentElement) {
      if (hidden(parent)) return "";
    }
    const source = useful(titleText(node), key);
    const rendered = source || useful(titleText(node, true), key);
    return rendered || useful(node.getAttribute("title"), key);
  }

  function titleIn(scope, key, allowUnlinked = false) {
    for (const node of scope.querySelectorAll(headings)) {
      const anchor = node.closest("a[href]") || node.querySelector("a[href]");
      if (anchor ? keyFor(anchor.href) !== key : !allowUnlinked) continue;
      const title = ownTitle(node, key);
      if (title) return title;
    }
    for (const anchor of scope.querySelectorAll("a[href]")) {
      if (keyFor(anchor.href) !== key) continue;
      const title = ownTitle(anchor, key);
      if (title) return title;
    }
    return "";
  }

  function titleFor(anchor) {
    const key = keyFor(anchor.href);
    if (!key) return "";
    const direct = anchor.hasAttribute("title") && ownTitle(anchor, key);
    if (direct) return direct;
    const card = anchor.closest(cards);
    if (card) {
      const title = titleIn(card, key, true);
      if (title) return title;
    }
    // Future card markup: accept links only for the SAME video, even when
    // they use different tracking parameters, timestamps or YouTube hosts.
    let parent = anchor.parentElement;
    for (let depth = 0; parent && parent !== document.body && depth < 5; depth++, parent = parent.parentElement) {
      const title = titleIn(parent, key);
      if (title) return title;
    }
    return titleIn(document, key) || ownTitle(anchor, key) || useful(anchor.getAttribute("aria-label"), key);
  }

  function findTitle(target) {
    const key = keyFor(target);
    if (!key) return "";
    if (contextLink?.key === key) {
      const title = contextLink.anchor.isConnected ? titleFor(contextLink.anchor) : contextLink.title;
      if (title) return title;
    }
    if (key === keyFor(location.href)) {
      const heading = document.querySelector("h1");
      const title = (heading && ownTitle(heading, key)) ||
        useful(document.title.replace(/\s*[-–|]\s*YouTube\s*$/i, ""), key);
      if (title && title !== "YouTube") return title;
    }
    for (const anchor of document.querySelectorAll("a[href]")) {
      if (keyFor(anchor.href) !== key) continue;
      const title = titleFor(anchor);
      if (title) return title;
    }
    return "";
  }

  function metadataFor(target, preferredAnchor) {
    const key=keyFor(target);
    if(!key)return {title:"",channel:""};
    const anchor=preferredAnchor || (contextLink?.key===key&&contextLink.anchor.isConnected?contextLink.anchor:null) ||
      Array.from(document.querySelectorAll("a[href]")).find(node=>keyFor(node.href)===key);
    let scope=anchor?.closest(cards),title="",channel="";
    if(key===keyFor(location.href)) {
      const identity=document.querySelector('ytd-watch-flexy[video-id]')?.getAttribute('video-id');
      const declared=document.querySelector('meta[itemprop="videoId"]')?.content;
      const expected=key.slice(6);
      if((identity&&identity!==expected)||(declared&&declared!==expected))return {title:"",channel:""};
      scope=document.querySelector('#owner') || document.querySelector('ytd-video-owner-renderer');
      title=findTitle(target);
    } else if(anchor) title=titleFor(anchor);
    if(scope) for(const link of scope.querySelectorAll('ytd-channel-name a[href], #channel-name a[href], .yt-lockup-metadata-view-model__metadata a[href], a.yt-simple-endpoint[href]')) {
      try {
        const url=new URL(link.href);
        if(!/^\/(?:@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)\/?$/.test(url.pathname) ||
           !['youtube.com','www.youtube.com','m.youtube.com'].includes(url.hostname))continue;
        channel=ownTitle(link,key);if(channel)break;
      }catch{}
    }
    return {title:title||findTitle(target),channel};
  }

  function linkIn(event) {
    return event.composedPath().find(node => node instanceof HTMLAnchorElement);
  }

  function handle(event) {
    if (!chrome.runtime?.id) return; // An invalidated old script must not eat native clicks.
    const backgroundGesture = event.type === "auxclick" ? event.button === 1 :
      event.button === 0 && (event.metaKey || event.ctrlKey);
    if (!event.isTrusted || !backgroundGesture || event.shiftKey || event.altKey || event.defaultPrevented) return;
    const anchor = linkIn(event);
    if (!anchor || anchor.hasAttribute("download")) return;
    const url = parsedVideo(anchor.href);
    if (!url) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const request = {type:"park-link",url:url.href,...metadataFor(url.href,anchor),requestId:crypto.randomUUID()};
    function send() {
      return Promise.resolve().then(() => chrome.runtime.sendMessage(request)).then(response => {
        if (!response?.ok) throw Error(response?.error || "Could not park the link.");
      });
    }
    send().catch(() => showParkingError(send));
  }

  function showParkingError(retry) {
    document.getElementById("parker-parking-error")?.remove();
    const box = document.createElement("div");
    box.id = "parker-parking-error";
    box.setAttribute("role","alert");
    Object.assign(box.style,{position:"fixed",right:"16px",bottom:"16px",zIndex:"2147483647",
      padding:"12px",maxWidth:"320px",border:"1px solid #000",borderRadius:"8px",background:"#fff",color:"#141414",
      font:"14px system-ui"});
    const message = document.createElement("p");
    message.textContent = "Tab Parker could not confirm that the link was parked.";
    const button = document.createElement("button");
    button.textContent = "Try parking again";
    button.addEventListener("click",async event => {
      if (!event.isTrusted) return;
      button.disabled = true;
      try { await retry(); box.remove(); }
      catch { message.textContent = "The link still could not be parked."; button.disabled = false; }
    });
    const dismiss = document.createElement("button");
    dismiss.textContent = "Close";
    dismiss.addEventListener("click",() => box.remove());
    box.append(message,button,dismiss);
    document.documentElement.append(box);
  }

  function rememberContext(event) {
    const anchor = linkIn(event);
    contextLink = anchor && parsedVideo(anchor.href) ? { anchor, key: keyFor(anchor.href), title: titleFor(anchor) } : undefined;
  }
  function onMessage(message, sender, respond) {
    if (sender.id !== chrome.runtime.id) return false;
    if (message?.type === "parker-ping") respond({ version });
    else if (message?.type === "find-video-title") respond(metadataFor(message.url));
    return false;
  }
  window.addEventListener("click", handle, true);
  window.addEventListener("auxclick", handle, true);
  window.addEventListener("contextmenu", rememberContext, true);
  chrome.runtime.onMessage.addListener(onMessage);
  globalThis.__youtubeTabParkerLinks = {
    version,
    dispose() {
      window.removeEventListener("click", handle, true);
      window.removeEventListener("auxclick", handle, true);
      window.removeEventListener("contextmenu", rememberContext, true);
      try { chrome.runtime.onMessage.removeListener(onMessage); } catch { /* Old extension context after an update. */ }
    }
  };
})();
