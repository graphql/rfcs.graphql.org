(() => {
  // Keep previously shared month and meeting fragments pointing into the archive.
  function followArchiveFragment() {
    const feed = document.querySelector("[data-feed-base]");
    if (
      !feed ||
      !location.hash ||
      document.getElementById(location.hash.slice(1))
    )
      return;
    const fragment = location.hash.slice(1);
    const monthMatch = /^(\d{4})(0[1-9]|1[0-2])$/.exec(fragment);
    const meetingMatch = /^meeting-.+-(\d{4})-(0[1-9]|1[0-2])-\d{2}$/.exec(
      fragment,
    );
    const match = monthMatch || meetingMatch;
    if (!match) return;
    const month = match[1] + "-" + match[2];
    if (month >= feed.dataset.feedCutoff) return;
    const period = match[1] + (Number(match[2]) <= 6 ? "H1" : "H2");
    const pathname = feed.dataset.feedBase + period + "/";
    if (pathname !== location.pathname)
      location.replace(pathname + location.hash);
  }
  followArchiveFragment();
  window.addEventListener("hashchange", followArchiveFragment);

  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const hover = matchMedia("(hover: hover)");
  const previews = new Map();

  document.querySelectorAll(".video-still").forEach((still) => {
    const image = still.querySelector("img");
    const hoverArea = still.closest(".video-preview") || still;
    const automatic = still.dataset.rotate === "auto";
    const state = {
      visible: false,
      hovered: hover.matches && hoverArea.matches(":hover"),
      timer: null,
      frame: 1,
      version: 0,
    };
    previews.set(still, state);

    function advance(version, repeat) {
      const frame = state.frame === 1 ? 3 : 1;
      const src =
        "https://i.ytimg.com/vi/" +
        still.dataset.videoId +
        "/hq" +
        frame +
        ".jpg";
      const next = new Image();
      next.onload = () => {
        if (!still.isConnected || state.version !== version) return;
        state.frame = frame;
        image.src = src;
        if (repeat) {
          state.timer = setTimeout(
            () => advance(version, repeat),
            automatic ? 3500 : 1500,
          );
        }
      };
      next.src = src;
    }

    function update() {
      clearTimeout(state.timer);
      state.timer = null;
      const version = ++state.version;
      if (document.hidden || !state.visible) return;
      if (automatic) {
        if (!motion.matches) {
          state.timer = setTimeout(() => advance(version, true), 3500);
        }
      } else if (state.hovered) {
        advance(version, true);
      }
    }
    state.update = update;
    if (!automatic) {
      hoverArea.addEventListener("pointerenter", (event) => {
        state.hovered = event.pointerType !== "touch";
        update();
      });
      hoverArea.addEventListener("pointerleave", () => {
        state.hovered = false;
        update();
      });
    }
    image.addEventListener("error", () => {
      if (!image.src.endsWith("/hqdefault.jpg")) {
        image.src =
          "https://i.ytimg.com/vi/" + still.dataset.videoId + "/hqdefault.jpg";
      }
    });
  });

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(({ target, isIntersecting }) => {
      const state = previews.get(target);
      if (!state) return;
      state.visible = isIntersecting;
      state.update();
    });
  });
  previews.forEach((_, still) => observer.observe(still));
  function updatePreviews() {
    previews.forEach((state) => state.update());
  }
  document.addEventListener("visibilitychange", updatePreviews);
  motion.addEventListener("change", updatePreviews);

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-load-video]");
    if (!button) return;
    const still = button.querySelector(".video-still");
    const state = previews.get(still);
    if (state) {
      clearTimeout(state.timer);
      state.version++;
      observer.unobserve(still);
      previews.delete(still);
    }
    const iframe = document.createElement("iframe");
    iframe.className = "video-player";
    iframe.src =
      "https://www.youtube-nocookie.com/embed/" +
      button.dataset.loadVideo +
      "?autoplay=1";
    iframe.title = button.dataset.videoTitle;
    iframe.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
    iframe.allowFullscreen = true;
    iframe.referrerPolicy = "strict-origin-when-cross-origin";
    iframe.tabIndex = 0;
    button.replaceWith(iframe);
    iframe.focus();
  });
})();
