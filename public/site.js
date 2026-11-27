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
    const state = { visible: false, hovered: false, timer: null, frame: 1 };
    previews.set(still, state);

    function showFrame(frame) {
      const src =
        "https://i.ytimg.com/vi/" +
        still.dataset.videoId +
        "/hq" +
        frame +
        ".jpg";
      const next = new Image();
      next.onload = () => {
        if (still.isConnected && state.timer && state.frame === frame)
          image.src = src;
      };
      next.src = src;
    }

    function update() {
      clearInterval(state.timer);
      state.timer = null;
      if (motion.matches || document.hidden || !state.visible) return;
      if (still.dataset.rotate !== "auto" && !state.hovered) return;
      state.timer = setInterval(
        () => {
          state.frame = state.frame === 1 ? 3 : 1;
          showFrame(state.frame);
        },
        still.dataset.rotate === "auto" ? 3500 : 1000,
      );
    }
    state.update = update;
    const hoverArea = still.closest(".video-preview") || still;
    hoverArea.addEventListener("pointerenter", () => {
      state.hovered = hover.matches;
      update();
    });
    hoverArea.addEventListener("pointerleave", () => {
      state.hovered = false;
      update();
    });
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
      clearInterval(state.timer);
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
