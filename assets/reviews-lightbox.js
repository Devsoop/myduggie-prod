/**
 * GLightbox init for review card photos (§5.6).
 * Exposes reviewsLightboxReload() for reviews-display.js after cursor fetch.
 */
(function () {
  /** @type {{ reload: () => void } | null} */
  let lightbox = null;

  function initLightbox() {
    if (typeof GLightbox !== 'function') return null;
    if (!lightbox) {
      lightbox = GLightbox({
        selector: '.glightbox',
        touchNavigation: true,
        touchFollowAxis: true,
        keyboardNavigation: true,
        closeOnOutsideClick: true,
        loop: true,
        zoomable: true,
        draggable: true,
        dragAutoSnap: true,
        dragToleranceX: 30,
        dragToleranceY: 40,
      });
    }
    return lightbox;
  }

  /** @type {Window & { reviewsLightboxReload?: () => void }} */
  const win = window;

  win.reviewsLightboxReload = function () {
    if (lightbox) {
      lightbox.reload();
    } else {
      initLightbox();
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initLightbox);
  } else {
    initLightbox();
  }
})();
