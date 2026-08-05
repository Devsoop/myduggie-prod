(function() {
  var main = document.querySelector('#MainContent[data-template="product.standard-pdp"]');
  if (!main) return;

  // Rubik-active detection — runs for every standard-pdp product, independent of the
  // limited-run badge logic below (which early-returns when there are no special editions).
  // Flags the page once Rubik has rendered swatches so CSS can collapse the native fallback.
  function markRubikActive() {
    main.setAttribute('data-rubik-active', 'true');
  }
  function detectRubik(n) {
    if (n <= 0) return;
    var el = document.querySelector('rubik-swatch');
    var sr = el && el.shadowRoot;
    var items = sr && sr.querySelectorAll('.rubik-swatch__item-wrapper');
    if (items && items.length > 0) { markRubikActive(); }
    else { setTimeout(function() { detectRubik(n - 1); }, 500); }
  }
  detectRubik(30);
  window.addEventListener('load', function() { detectRubik(30); });

  // "(Currently unavailable)" suffix on the Rubik selected-value label for sold-out colors.
  // The native picker (which carries availability data) is hidden when Rubik is active,
  // so we read availability from it and reflect it on the Rubik-rendered label.
  var UNAVAILABLE_SUFFIX = ' (Currently unavailable)';
  function buildAvailabilityMap() {
    var map = {};
    var inputs = document.querySelectorAll('.variant-picker .variant-option--swatches input[data-option-available]');
    inputs.forEach(function(input) {
      var name = (input.value || '').trim().toLowerCase();
      if (!name) return;
      map[name] = input.getAttribute('data-option-available') === 'true';
    });
    return map;
  }
  function reconcileUnavailableSuffix(sr) {
    // The selected-value label carries the class `rubik-swatch__option-name-value`.
    // We append our suffix as a SIBLING of that span, so existence must be checked on
    // its parent (not inside the span) to stay idempotent and avoid an insertion loop.
    var valueEl = sr.querySelector('.rubik-swatch__option-name-value');
    var parent = valueEl && valueEl.parentNode;
    if (!parent) return;
    var map = buildAvailabilityMap();
    var name = (valueEl.textContent || '').replace(UNAVAILABLE_SUFFIX, '').trim().toLowerCase();
    var shouldShow = map[name] === false;
    var existing = parent.querySelector('.lr-unavailable-suffix');
    if (shouldShow && !existing) {
      var span = document.createElement('span');
      span.className = 'lr-unavailable-suffix';
      span.textContent = UNAVAILABLE_SUFFIX;
      valueEl.insertAdjacentElement('afterend', span);
    } else if (!shouldShow && existing) {
      existing.remove();
    }
  }
  function observeUnavailableSuffix(sr) {
    if (sr.__lrUnavailObserved) return;
    sr.__lrUnavailObserved = true;
    var scheduled = false;
    function schedule() {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(function() { scheduled = false; reconcileUnavailableSuffix(sr); });
    }
    schedule();
    var obs = new MutationObserver(schedule);
    obs.observe(sr, { childList: true, subtree: true, characterData: true });
  }
  function pollUnavailable(n) {
    if (n <= 0) return;
    var el = document.querySelector('rubik-swatch');
    var sr = el && el.shadowRoot;
    var valueEl = sr && sr.querySelector('.rubik-swatch__option-name-value');
    if (valueEl) { observeUnavailableSuffix(sr); }
    else { setTimeout(function() { pollUnavailable(n - 1); }, 500); }
  }
  pollUnavailable(30);
  window.addEventListener('load', function() { pollUnavailable(30); });

  var dataEl = document.querySelector('[data-limited-run-colors]');
  if (!dataEl) return;
  var colors;
  try { colors = JSON.parse(dataEl.textContent); } catch(e) { return; }
  var handleize = function(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); };
  var specialNames = {};
  colors.forEach(function(c) { if (c.isSpecial) specialNames[handleize(c.name)] = true; });
  if (Object.keys(specialNames).length === 0) return;
  var badgeText = dataEl.getAttribute('data-badge-text') || 'Limited Run';

  function injectBadges(sr) {
    if (sr.querySelector('.lr-badge')) return;

    // Check if any swatches on this product match a special-edition color
    var hasAnySpecial = false;
    var allWrappers = sr.querySelectorAll('.rubik-swatch__item-wrapper');
    allWrappers.forEach(function(w) {
      var label = w.querySelector('[data-rubik-option-value]');
      if (label && specialNames[handleize(label.getAttribute('data-rubik-option-value'))]) {
        hasAnySpecial = true;
      }
    });
    if (!hasAnySpecial) return;

    var firstSwatch = sr.querySelector('.rubik-swatch__item-wrapper');
    var swatchSize = firstSwatch ? firstSwatch.offsetHeight : 44;
    if (swatchSize < 10) swatchSize = 44;

    var badgeFont = Math.max(6, Math.round(swatchSize * 0.136));
    var badgePadV = Math.max(1, Math.round(swatchSize * 0.036));
    var badgePadH = Math.max(3, Math.round(swatchSize * 0.091));
    var badgeBottom = Math.round(swatchSize * 0.164);
    var wrapperMargin = badgeBottom + badgePadV + badgeFont;

    var style = document.createElement('style');
    style.textContent =
      '.lr-separator{align-self:flex-start;width:1px;height:' + swatchSize + 'px;margin-inline:4px;background:rgba(0,0,0,0.16)}' +
      '.lr-badge-wrapper{position:relative;overflow:visible !important;margin-block-end:' + wrapperMargin + 'px}' +
      '.lr-badge-wrapper *{overflow:visible !important}' +
      '.lr-badge{position:absolute;inset-block-end:-' + badgeBottom + 'px;inset-inline-start:50%;transform:translateX(-50%);z-index:1;' +
        'padding:' + badgePadV + 'px ' + badgePadH + 'px;border-radius:999px;' +
        'background:var(--color-foreground,#1a1a1a);color:var(--color-background,#fff);' +
        'font-size:' + badgeFont + 'px;font-weight:600;line-height:1;white-space:nowrap;pointer-events:none}';
    sr.appendChild(style);

    var containers = sr.querySelectorAll('.rubik-swatch__items');
    containers.forEach(function(container) {
      var wrappers = Array.from(container.querySelectorAll('.rubik-swatch__item-wrapper'));

      var regular = [];
      var special = [];
      wrappers.forEach(function(w) {
        var label = w.querySelector('[data-rubik-option-value]');
        if (!label) { regular.push(w); return; }
        var val = handleize(label.getAttribute('data-rubik-option-value'));
        if (specialNames[val]) { special.push(w); }
        else { regular.push(w); }
      });

      regular.forEach(function(w) { container.appendChild(w); });

      if (special.length > 0) {
        var sep = document.createElement('div');
        sep.className = 'lr-separator';
        sep.setAttribute('aria-hidden', 'true');
        container.appendChild(sep);

        special.forEach(function(w) {
          w.classList.add('lr-badge-wrapper');
          var b = document.createElement('span');
          b.className = 'lr-badge';
          b.textContent = badgeText;
          w.appendChild(b);
          container.appendChild(w);
        });
      }
    });
  }

  function productHasSpecialSwatches(sr) {
    var found = false;
    sr.querySelectorAll('.rubik-swatch__item-wrapper').forEach(function(w) {
      var label = w.querySelector('[data-rubik-option-value]');
      if (label && specialNames[handleize(label.getAttribute('data-rubik-option-value'))]) {
        found = true;
      }
    });
    return found;
  }

  function observeAndInject(sr) {
    injectBadges(sr);
    if (!productHasSpecialSwatches(sr)) return;
    var obs = new MutationObserver(function() {
      if (!sr.querySelector('.lr-badge')) {
        injectBadges(sr);
      }
    });
    obs.observe(sr, { childList: true, subtree: true });
  }

  function poll(n) {
    if (n <= 0) return;
    var el = document.querySelector('rubik-swatch');
    var sr = el && el.shadowRoot;
    var items = sr && sr.querySelectorAll('.rubik-swatch__item-wrapper');
    if (items && items.length > 0) { observeAndInject(sr); }
    else { setTimeout(function() { poll(n - 1); }, 500); }
  }
  poll(30);
  window.addEventListener('load', function() { poll(30); });
})();
