/**
 * M7/M8 reviews page — server-driven filter / sort / cursor pagination (§5.10 / §4.6).
 *
 * Page 1 Liquid markup is a fast shell (SEO). On boot the client always
 * re-fetches page 1 from the App Proxy (`/apps/reviews/cards`), which reads
 * Admin API — so edit/hide/restore match storefront without waiting for
 * Storefront/Liquid metaobject cache. Filter / sort / load-more use the same path.
 */
(function () {
  const FILTER_KEYS = [
    'reviewer',
    'rating',
    'color',
    'owns',
    'photos',
    'frequency',
    'carry',
    'experience',
    'variant',
  ];

  // `variant` is a Shopify-reserved page-URL param (the PDP variant selector), so
  // our swatch filter travels in the page URL as `rv` to avoid the collision that
  // made `?variant=<id>` read as a bogus review filter.
  const URL_PARAM_OVERRIDES = { variant: 'rv' };
  function urlParamName(key) {
    return URL_PARAM_OVERRIDES[key] || key;
  }

  /** @returns {Record<string, string[]>} */
  function emptyFilters() {
    return {
      reviewer: [],
      rating: [],
      color: [],
      owns: [],
      photos: [],
      frequency: [],
      carry: [],
      experience: [],
      variant: [],
    };
  }

  /** @param {HTMLElement} root */
  function initReviewsSurface(root) {
    if (root.dataset.reviewsDisplayInit === 'true') return;
    root.dataset.reviewsDisplayInit = 'true';

    const cardsRoot = root.querySelector('[data-reviews-cards]');
    if (!cardsRoot) return;

    const pageSize = parseInt(root.dataset.pageSize || '10', 10) || 10;
    const cardsBase = root.dataset.cardsBase || '/apps/reviews/cards';

    const countEl = root.querySelector('[data-reviews-count-value]');
    const countNounEl = root.querySelector('[data-reviews-count-noun]');
    const emptyEl = root.querySelector('[data-reviews-empty]');
    const sparseEl = root.querySelector('[data-reviews-sparse]');
    const loadMoreBtn = root.querySelector('[data-reviews-load-more]');
    const sortSelect = root.querySelector('[data-reviews-sort]');
    const pillsEl = root.querySelector('[data-reviews-active-pills]');
    const clearBtn = root.querySelector('[data-reviews-clear-filters]');
    const labelMapScript = root.querySelector('[data-reviews-filter-labels]');
    let filterLabels = {};
    if (labelMapScript) {
      try {
        filterLabels = JSON.parse(labelMapScript.textContent || '{}');
      } catch (_err) {
        filterLabels = {};
      }
    }

    /** Cursor (handle of the last loaded card) for the next page; null when exhausted. */
    let nextCursor = null;
    let loading = false;
    let pillsExpanded = false;

    /** Filters without sidebar checkboxes (variant from card swatches). */
    /** @type {Record<string, string[]>} */
    const programmaticFilters = { variant: [] };

    // —— Filter state I/O ——————————————————————————————————————————————

    function readFiltersFromUI() {
      /** @type {Record<string, string[]>} */
      const out = emptyFilters();
      root.querySelectorAll('[data-reviews-filter]').forEach((input) => {
        if (!(input instanceof HTMLInputElement) || input.type !== 'checkbox' || !input.checked) return;
        const key = input.dataset.reviewsFilter;
        if (key && out[key]) out[key].push(input.value);
      });
      out.variant = [...programmaticFilters.variant];
      return out;
    }

    function readFiltersFromURL() {
      const params = new URLSearchParams(window.location.search);
      /** @type {Record<string, string[]>} */
      const out = emptyFilters();
      FILTER_KEYS.forEach((key) => {
        const raw = params.get(urlParamName(key));
        if (raw) out[key] = raw.split(',').map((s) => s.trim()).filter(Boolean);
      });
      // Back-compat: older shared links carried the swatch filter as `variant` or
      // `gave`. Only accept composite keys (handle:finish); ignore Shopify's
      // reserved numeric `?variant=<id>` PDP selector so it never filters reviews.
      ['variant', 'gave'].forEach((legacyKey) => {
        const legacy = (params.get(legacyKey) || '')
          .split(',')
          .map((s) => s.trim())
          .filter((v) => v.includes(':'));
        if (legacy.length) out.variant = Array.from(new Set([...out.variant, ...legacy]));
      });
      programmaticFilters.variant = [...out.variant];
      return out;
    }

    /** @param {Record<string, string[]>} filters */
    function syncFiltersToUI(filters) {
      root.querySelectorAll('[data-reviews-filter]').forEach((input) => {
        if (!(input instanceof HTMLInputElement)) return;
        const key = input.dataset.reviewsFilter;
        const list = key ? filters[key] || [] : [];
        input.checked = list.includes(input.value);
      });
      programmaticFilters.variant = [...(filters.variant || [])];
      syncCollapsibleSections(filters);
      syncFilterTriggerPressed(filters);
    }

    /** @param {Record<string, string[]>} filters */
    function syncFiltersToURL(filters) {
      const url = new URL(window.location.href);
      // Clean up the legacy `gave` param; never write `variant` — that's Shopify's
      // reserved PDP selector, our swatch filter uses `rv` (see urlParamName).
      url.searchParams.delete('gave');
      FILTER_KEYS.forEach((key) => {
        url.searchParams.delete(urlParamName(key));
        const vals = filters[key];
        if (vals && vals.length) url.searchParams.set(urlParamName(key), vals.join(','));
      });
      const sort = readSort();
      if (sort && sort !== 'recent') url.searchParams.set('sort', sort);
      else url.searchParams.delete('sort');
      window.history.replaceState({}, '', url.toString());
    }

    function readSort() {
      return sortSelect instanceof HTMLSelectElement ? sortSelect.value : 'recent';
    }

    /** @param {Record<string, string[]>} filters */
    function hasActiveFilters(filters) {
      return FILTER_KEYS.some((k) => (filters[k] || []).length > 0);
    }

    function getHeaderOffset() {
      const raw = getComputedStyle(document.body).getPropertyValue('--header-height').trim();
      const n = parseFloat(raw);
      return Number.isFinite(n) ? n : 80;
    }

    /** Scroll the count row + active pills into view after a filter apply/remove. */
    function scrollToFilterResults() {
      const anchor = root.querySelector('.reviews-page__list-controls');
      if (!anchor) return;

      const top = anchor.getBoundingClientRect().top + window.scrollY - getHeaderOffset() - 12;
      const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
      window.scrollTo({ top: Math.max(0, top), behavior });
    }

    /** @param {Record<string, string[]>} filters */
    function syncCollapsibleSections(filters) {
      const sectionToFilterKey = {
        reviewer: 'reviewer',
        color: 'color',
        rating: 'rating',
        owns: 'owns',
        photos: 'photos',
        frequency: 'frequency',
        carry: 'carry',
        experience: 'experience',
      };
      root.querySelectorAll('[data-reviews-filter-section]').forEach((el) => {
        if (!(el instanceof HTMLDetailsElement)) return;
        const section = el.dataset.reviewsFilterSection;
        const key = section ? sectionToFilterKey[section] : null;
        if (!key) return;
        let active = (filters[key] || []).length > 0;
        // Nested finish pills live under Owns — open that section when card-tap
        // variant filters are active (deep-linked ?rv= / swatch tap), not only
        // when an Owns product checkbox is checked.
        if (key === 'owns' && (filters.variant || []).length > 0) active = true;
        if (active) el.open = true;
      });
    }

    /** @param {Record<string, string[]>} filters */
    function syncFilterTriggerPressed(filters) {
      root.querySelectorAll('[data-reviews-filter-trigger]').forEach((el) => {
        if (!(el instanceof HTMLElement)) return;
        const key = el.dataset.reviewsFilterTrigger;
        const value = el.dataset.filterValue;
        if (!key || !value) return;
        const list = filters[key] || [];
        const pressed = list.includes(value);
        el.setAttribute('aria-pressed', pressed ? 'true' : 'false');
      });
    }

    /**
     * @param {string} key
     * @param {string} value
     * @param {{ mode?: 'toggle' | 'replace' | 'add' }} [opts]
     */
    function applyFilter(key, value, opts = {}) {
      const mode = opts.mode || 'toggle';

      if (key === 'variant') {
        const list = programmaticFilters.variant;
        const idx = list.indexOf(value);
        let added = false;
        if (mode === 'replace') {
          if (list.length === 1 && idx >= 0) {
            scrollToFilterResults();
            return;
          }
          programmaticFilters.variant = [value];
          added = true;
        } else if (mode === 'add') {
          if (idx >= 0) {
            scrollToFilterResults();
            return;
          }
          list.push(value);
          added = true;
        } else if (idx >= 0) {
          list.splice(idx, 1);
        } else {
          list.push(value);
          added = true;
        }
        // Narrowing is symmetric with broadening: picking a specific finish
        // clears that product's Owns box, mirroring how checking the Owns box
        // clears the nested finish pills. Only when a finish is added, not removed.
        if (added) uncheckOwnsForHandle(value.split(':')[0]);
        onFilterChange();
        return;
      }

      if (key === 'rating' && mode === 'replace') {
        const alreadySelected = root.querySelector(
          `[data-reviews-filter="rating"][value="${CSS.escape(value)}"]`
        );
        if (alreadySelected instanceof HTMLInputElement && alreadySelected.checked) {
          scrollToFilterResults();
          return;
        }
        root.querySelectorAll('[data-reviews-filter="rating"]').forEach((input) => {
          if (input instanceof HTMLInputElement) input.checked = false;
        });
        const target = root.querySelector(
          `[data-reviews-filter="rating"][value="${CSS.escape(value)}"]`
        );
        if (target instanceof HTMLInputElement) target.checked = true;
        onFilterChange();
        return;
      }

      if (key === 'photos') {
        const input = root.querySelector('[data-reviews-filter="photos"]');
        if (input instanceof HTMLInputElement) {
          if (mode === 'add') {
            if (input.checked) {
              scrollToFilterResults();
              return;
            }
            input.checked = true;
          } else {
            input.checked = mode === 'replace' ? true : !input.checked;
          }
        }
        onFilterChange();
        return;
      }

      const input = root.querySelector(
        `[data-reviews-filter="${CSS.escape(key)}"][value="${CSS.escape(value)}"]`
      );
      if (input instanceof HTMLInputElement) {
        if (mode === 'replace') {
          if (input.checked) {
            scrollToFilterResults();
            return;
          }
          root.querySelectorAll(`[data-reviews-filter="${CSS.escape(key)}"]`).forEach((el) => {
            if (el instanceof HTMLInputElement) el.checked = false;
          });
          input.checked = true;
        } else if (mode === 'add') {
          if (input.checked) {
            scrollToFilterResults();
            return;
          }
          input.checked = true;
        } else {
          input.checked = !input.checked;
        }
        onFilterChange();
      }
    }

    // —— Active filter pills ————————————————————————————————————————————

    const PILL_ICON_COLORS = {
      buyer: '#2E8B57',
      recipient: '#CC5500',
      gifter: '#2F5BB5',
    };

    const SVG_CHECK =
      '<svg class="reviews-page__pill-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
    const SVG_GIFT =
      '<svg class="reviews-page__pill-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5"/></svg>';
    const SVG_STAR =
      '<svg class="reviews-page__pill-icon-svg reviews-page__pill-icon-svg--star" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';

    /** @param {string} reviewerValue */
    function pillIconHtml(reviewerValue) {
      const color = PILL_ICON_COLORS[reviewerValue];
      if (!color) return '';
      const svg = reviewerValue === 'buyer' ? SVG_CHECK : SVG_GIFT;
      return `<span class="reviews-page__pill-icon" style="color:${color}">${svg}</span>`;
    }

    /** @param {{ key: string, value: string, label: string, swatchHex?: string }} entry */
    function pillModClass(entry) {
      if (entry.key === 'reviewer' && entry.value === 'buyer') return ' reviews-page__pill--verified';
      if (entry.key === 'reviewer' && entry.value === 'recipient') return ' reviews-page__pill--recipient';
      if (entry.key === 'reviewer' && entry.value === 'gifter') return ' reviews-page__pill--gifter';
      if (entry.key === 'rating') return ' reviews-page__pill--rating';
      if (entry.key === 'color' || entry.key === 'variant') return ' reviews-page__pill--color';
      return '';
    }

    /** @param {{ key: string, value: string, label: string, swatchHex?: string, swatchUrl?: string }} entry */
    function buildPillContent(entry) {
      if (entry.key === 'reviewer') {
        if (entry.value === 'sample') return escapeHtml(entry.label);
        const icon = pillIconHtml(entry.value);
        if (icon) return `${icon}${escapeHtml(entry.label)}`;
      }
      if (entry.key === 'rating') {
        return `${escapeHtml(entry.label)}<span class="reviews-page__pill-icon reviews-page__pill-icon--star">${SVG_STAR}</span>`;
      }
      if (entry.key === 'variant' && entry.swatchUrl) {
        return (
          `<img class="reviews-page__pill-swatch-img" src="${escapeAttr(entry.swatchUrl)}" alt="" aria-hidden="true">` +
          `<span class="visually-hidden">${escapeHtml(entry.label)}</span>`
        );
      }
      if (entry.key === 'color' || entry.key === 'variant') {
        const swatch = entry.swatchHex
          ? `<span class="reviews-page__pill-swatch" style="background-color:${escapeAttr(entry.swatchHex)}" aria-hidden="true"></span>`
          : '';
        return `${swatch}<span>${escapeHtml(entry.label)}</span>`;
      }
      return escapeHtml(entry.label);
    }

    /** @param {string} key @param {string} value */
    function labelForFilterOption(key, value) {
      const mapped = filterLabels?.[key]?.[value];
      if (typeof mapped === 'string' && mapped.trim()) return mapped;
      const input = root.querySelector(`[data-reviews-filter="${CSS.escape(key)}"][value="${CSS.escape(value)}"]`);
      if (input instanceof HTMLInputElement) {
        return (
          input.dataset.optionLabel ||
          input.dataset.finishLabel ||
          input.dataset.ownsLabel ||
          input.closest('label')?.querySelector('span:not(.reviews-filter__count)')?.textContent?.trim() ||
          value
        );
      }
      return prettifyToken(value);
    }

    /** @param {string} ariaLabel */
    function labelFromFilterTriggerAria(ariaLabel) {
      const prefix = 'Filter by ';
      if (ariaLabel.startsWith(prefix)) return ariaLabel.slice(prefix.length).trim();
      return ariaLabel.trim();
    }

    /** @param {string} label @param {string} handle */
    function variantLabelUsesRawHandle(label, handle) {
      const productPart = label.split('·')[0]?.trim();
      return productPart === handle;
    }

    /** @param {string} composite product_handle:finish_key */
    function labelForVariantKey(composite) {
      const mapped = filterLabels?.variant?.[composite];
      const handle = composite.split(':')[0] || '';
      if (mapped && typeof mapped.label === 'string') {
        const mappedLabel = mapped.label.trim();
        if (mappedLabel && !variantLabelUsesRawHandle(mappedLabel, handle)) return mappedLabel;
      }

      for (const triggerKey of ['variant', 'gave']) {
        const trigger = root.querySelector(
          `[data-reviews-filter-trigger="${triggerKey}"][data-filter-value="${CSS.escape(composite)}"]`
        );
        if (trigger instanceof HTMLElement) {
          const fromAria = labelFromFilterTriggerAria(trigger.getAttribute('aria-label') || '');
          if (fromAria && !variantLabelUsesRawHandle(fromAria, handle)) return fromAria;
        }
      }

      const parts = composite.split(':');
      const finishKey = parts.slice(1).join(':');
      const finishInput = root.querySelector(`[data-reviews-filter="color"][value="${CSS.escape(finishKey)}"]`);
      const finishLabel =
        (finishInput instanceof HTMLInputElement && finishInput.dataset.finishLabel) || prettifyToken(finishKey);
      const ownsInput = findOwnsInput(handle);
      const productLabel =
        (ownsInput instanceof HTMLInputElement && ownsInput.dataset.ownsLabel) || prettifyToken(handle);
      return `${productLabel} · ${finishLabel}`;
    }

    /** @param {string} composite */
    function swatchUrlForVariantKey(composite) {
      const mapped = filterLabels?.variant?.[composite];
      if (mapped && typeof mapped.swatchUrl === 'string' && mapped.swatchUrl.trim()) return mapped.swatchUrl;
      const trigger = root.querySelector(
        `[data-reviews-filter-trigger="variant"][data-filter-value="${CSS.escape(composite)}"] img`
      );
      if (trigger instanceof HTMLImageElement) return trigger.currentSrc || trigger.src || '';
      return '';
    }

    /** @param {string} value */
    function prettifyToken(value) {
      return value
        .split('-')
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
    }

    /** @param {Record<string, string[]>} filters */
    function buildActivePills(filters) {
      if (!pillsEl) return;

      const labels = {
        buyer: 'Verified buyers',
        recipient: 'Gift recipients',
        gifter: 'Gift givers',
        sample: 'Samples',
      };

      /** @type {Array<{ key: string, value: string, label: string, swatchHex?: string, swatchUrl?: string }>} */
      const entries = [];

      filters.reviewer.forEach((v) => entries.push({ key: 'reviewer', value: v, label: labels[v] || v }));
      filters.rating.forEach((v) => entries.push({ key: 'rating', value: v, label: String(v) }));
      filters.color.forEach((v) => {
        const input = root.querySelector(`[data-reviews-filter="color"][value="${CSS.escape(v)}"]`);
        const label =
          (input instanceof HTMLInputElement && input.dataset.finishLabel) ||
          input?.closest('label')?.querySelector('.reviews-filter__finish-label')?.textContent?.trim() ||
          'Color';
        const swatchHex = input instanceof HTMLInputElement ? input.dataset.swatchHex || '' : '';
        entries.push({ key: 'color', value: v, label, swatchHex });
      });
      filters.owns.forEach((v) => {
        const input = findOwnsInput(v);
        const label =
          (input instanceof HTMLInputElement && input.dataset.ownsLabel) ||
          input?.closest('label')?.querySelector('.reviews-filter__owns-label')?.textContent?.trim() ||
          v;
        entries.push({ key: 'owns', value: v, label });
      });
      filters.frequency.forEach((v) =>
        entries.push({ key: 'frequency', value: v, label: labelForFilterOption('frequency', v) })
      );
      filters.carry.forEach((v) =>
        entries.push({ key: 'carry', value: v, label: labelForFilterOption('carry', v) })
      );
      filters.experience.forEach((v) =>
        entries.push({ key: 'experience', value: v, label: labelForFilterOption('experience', v) })
      );
      filters.variant.forEach((v) => {
        const finishKey = v.split(':').slice(1).join(':');
        const colorInput = root.querySelector(`[data-reviews-filter="color"][value="${CSS.escape(finishKey)}"]`);
        const swatchHex = colorInput instanceof HTMLInputElement ? colorInput.dataset.swatchHex || '' : '';
        const swatchUrl = swatchUrlForVariantKey(v);
        entries.push({ key: 'variant', value: v, label: labelForVariantKey(v), swatchHex, swatchUrl });
      });
      if (filters.photos.includes('1')) entries.push({ key: 'photos', value: '1', label: 'With photos' });

      if (!entries.length) {
        pillsEl.classList.add('hidden');
        pillsEl.innerHTML = '';
        pillsExpanded = false;
        return;
      }

      pillsEl.classList.remove('hidden');
      const pillsHtml = entries
        .map(
          (entry) =>
            `<span class="reviews-page__pill${pillModClass(entry)}" data-reviews-pill-item${entry.key === 'variant' ? ` title="${escapeAttr(entry.label)}" aria-label="${escapeAttr(entry.label)}"` : ''}>` +
            `${buildPillContent(entry)}` +
            `<button type="button" class="reviews-page__pill-remove" data-reviews-pill-key="${escapeAttr(entry.key)}" data-reviews-pill-value="${escapeAttr(entry.value)}" aria-label="Remove ${escapeHtml(entry.label)} filter">×</button>` +
            `</span>`
        )
        .join('');

      pillsEl.innerHTML =
        `<div class="reviews-page__pills-track" data-reviews-pills-track>` +
        pillsHtml +
        `<button type="button" class="reviews-page__pills-more button-unstyled hidden" data-reviews-pills-more aria-expanded="false"></button>` +
        `<button type="button" class="reviews-page__clear-filters-inline button-unstyled" data-reviews-clear-filters-inline>Clear filters</button>` +
        `</div>`;

      layoutPillOverflow();
      requestAnimationFrame(() => layoutPillOverflow());
    }

    /** @param {string} handle */
    function ownsNestedPillEntries(handle) {
      return programmaticFilters.variant
        .filter((v) => v.split(':')[0] === handle)
        .map((v) => {
          const finishKey = v.split(':').slice(1).join(':');
          const colorInput = root.querySelector(`[data-reviews-filter="color"][value="${CSS.escape(finishKey)}"]`);
          const swatchHex = colorInput instanceof HTMLInputElement ? colorInput.dataset.swatchHex || '' : '';
          return { value: v, label: labelForVariantKey(v), swatchHex, swatchUrl: swatchUrlForVariantKey(v) };
        });
    }

    /** Nested finish pills under each Owns product row, reflecting card-tap (`variant`) filters. */
    function renderOwnsNestedPills() {
      root.querySelectorAll('[data-owns-pills-for]').forEach((container) => {
        if (!(container instanceof HTMLElement)) return;
        const handle = container.dataset.ownsPillsFor || '';
        const entries = handle ? ownsNestedPillEntries(handle) : [];
        if (!entries.length) {
          container.hidden = true;
          container.innerHTML = '';
          return;
        }
        container.hidden = false;
        container.innerHTML = entries
          .map((entry) => {
            const swatch = entry.swatchUrl
              ? `<img class="reviews-page__pill-swatch-img" src="${escapeAttr(entry.swatchUrl)}" alt="" aria-hidden="true">`
              : entry.swatchHex
                ? `<span class="reviews-page__pill-swatch" style="background-color:${escapeAttr(entry.swatchHex)}" aria-hidden="true"></span>`
                : '';
            return (
              `<li class="reviews-page__pill reviews-page__pill--color reviews-page__pill--nested" title="${escapeAttr(entry.label)}">` +
              `${swatch}<span class="visually-hidden">${escapeHtml(entry.label)}</span>` +
              `<button type="button" class="reviews-page__pill-remove" data-owns-pill-remove data-reviews-pill-value="${escapeAttr(entry.value)}" aria-label="Remove ${escapeHtml(entry.label)} filter">×</button>` +
              `</li>`
            );
          })
          .join('');
      });
    }

    /** @param {string} handle Prune card-tap filters for a product once its Owns checkbox is checked. */
    function pruneVariantForHandle(handle) {
      programmaticFilters.variant = programmaticFilters.variant.filter((v) => v.split(':')[0] !== handle);
    }

    /**
     * Resolve an Owns checkbox from either its value (a product identity) or any
     * handle that product has been known under. Variant composites are
     * `handle:finish`, so callers still hand us handles.
     * @param {string} token
     * @returns {HTMLInputElement | null}
     */
    function findOwnsInput(token) {
      if (!token) return null;
      const direct = root.querySelector(
        `[data-reviews-filter="owns"][value="${CSS.escape(token)}"]`
      );
      if (direct instanceof HTMLInputElement) return direct;
      const inputs = root.querySelectorAll('[data-reviews-filter="owns"]');
      for (const input of inputs) {
        if (!(input instanceof HTMLInputElement)) continue;
        const aliases = (input.dataset.ownsHandles || '')
          .split(',')
          .map((h) => h.trim())
          .filter(Boolean);
        if (aliases.includes(token)) return input;
      }
      return null;
    }

    /**
     * Symmetric counterpart to pruneVariantForHandle: choosing a specific finish
     * under a product is a *narrowing*, so it clears that product's broad Owns box
     * ("all finishes" → "one finish"), the same way checking the box clears the
     * nested finish pills. Returns true if a checked box was cleared.
     * @param {string} handle
     */
    function uncheckOwnsForHandle(handle) {
      if (!handle) return false;
      const ownsInput = findOwnsInput(handle);
      if (ownsInput instanceof HTMLInputElement && ownsInput.checked) {
        ownsInput.checked = false;
        return true;
      }
      return false;
    }

    const MAX_VISIBLE_PILL_ROWS = 2;

    function layoutPillOverflow() {
      if (!pillsEl) return;
      const track = pillsEl.querySelector('[data-reviews-pills-track]');
      const moreBtn = pillsEl.querySelector('[data-reviews-pills-more]');
      const clearBtn = track?.querySelector('[data-reviews-clear-filters-inline]');
      if (!(track instanceof HTMLElement) || !(moreBtn instanceof HTMLButtonElement)) return;

      const items = [...track.querySelectorAll('[data-reviews-pill-item]')];
      items.forEach((el) => el.classList.remove('hidden'));

      if (pillsExpanded) {
        moreBtn.classList.add('hidden');
        pillsEl.classList.add('reviews-page__active-filters--expanded');
        if (clearBtn instanceof HTMLElement) clearBtn.classList.remove('hidden');
        return;
      }

      pillsEl.classList.remove('reviews-page__active-filters--expanded');
      moreBtn.classList.add('hidden');
      if (clearBtn instanceof HTMLElement) clearBtn.classList.remove('hidden');

      if (items.length === 0) return;

      /** Count pill rows only; hide Clear filters so it cannot wrap pills or trigger overflow. */
      function trackRowCount() {
        const clearHidden = clearBtn instanceof HTMLElement && !clearBtn.classList.contains('hidden');
        if (clearHidden) clearBtn.classList.add('hidden');
        const tops = new Set();
        track.querySelectorAll('[data-reviews-pill-item]:not(.hidden)').forEach((el) => {
          if (el instanceof HTMLElement) tops.add(el.offsetTop);
        });
        if (clearHidden) clearBtn.classList.remove('hidden');
        return tops.size;
      }

      if (trackRowCount() <= MAX_VISIBLE_PILL_ROWS) return;

      // Reveal "+N more" inside the track before shrinking so row-count checks
      // include the width the button will occupy beside the last visible pill.
      moreBtn.classList.remove('hidden');
      moreBtn.setAttribute('aria-expanded', 'false');

      let visibleCount = items.length;
      while (visibleCount > 1) {
        const hiddenCount = items.length - visibleCount;
        moreBtn.textContent = `+${hiddenCount} more`;
        items.forEach((item, index) => {
          if (item instanceof HTMLElement) {
            item.classList.toggle('hidden', index >= visibleCount);
          }
        });
        if (trackRowCount() <= MAX_VISIBLE_PILL_ROWS) break;
        visibleCount -= 1;
      }

      const hiddenCount = items.length - visibleCount;
      if (hiddenCount > 0) {
        moreBtn.textContent = `+${hiddenCount} more`;
        moreBtn.classList.remove('hidden');
        moreBtn.setAttribute('aria-expanded', 'false');
      } else {
        moreBtn.classList.add('hidden');
      }
    }

    /** @param {string} s */
    function escapeAttr(s) {
      return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    }

    /** @param {string} s */
    function escapeHtml(s) {
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // —— Cursor fetch ——————————————————————————————————————————————————

    /** @param {string | null} cursor */
    function buildParams(cursor) {
      const params = new URLSearchParams();
      params.set('scope', root.dataset.scopeMode || 'product');
      if (root.dataset.productHandle) params.set('product_handle', root.dataset.productHandle);
      if (root.dataset.productId) params.set('product_id', root.dataset.productId);
      if (root.dataset.productTitle) params.set('product_title', root.dataset.productTitle);
      if (root.dataset.productType) params.set('product_type', root.dataset.productType);
      // Theme resolves bundle via type / constituent_items / suffix — not review_category
      if (root.dataset.isBundle === 'true') params.set('is_bundle', 'true');
      else if (root.dataset.isBundle === 'false') params.set('is_bundle', 'false');
      params.set('limit', String(pageSize));
      params.set('sort', readSort());

      const filters = readFiltersFromUI();
      FILTER_KEYS.forEach((key) => {
        const vals = filters[key];
        if (vals && vals.length) params.set(key, vals.join(','));
      });
      if (cursor) params.set('cursor', cursor);

      const labelMap = {
        l_buyer: root.dataset.labelBuyer,
        l_recipient: root.dataset.labelRecipient,
        l_gifter: root.dataset.labelGifter,
        l_sample: root.dataset.labelSample,
        l_returns: root.dataset.labelReturns,
        l_photo_limit: root.dataset.photoLimit,
      };
      Object.entries(labelMap).forEach(([k, v]) => {
        if (v) params.set(k, v);
      });
      return params;
    }

    /**
     * Fetch one page of rendered cards.
     * @param {{ reset: boolean }} opts reset = replace list (filter/sort); else append (load-more)
     */
    async function fetchPage({ reset }) {
      if (loading) return;
      loading = true;
      if (loadMoreBtn) {
        loadMoreBtn.disabled = true;
        if (!reset) loadMoreBtn.textContent = 'Loading…';
      }

      const cursor = reset ? null : nextCursor;
      try {
        const res = await fetch(`${cardsBase}?${buildParams(cursor).toString()}`, {
          credentials: 'same-origin',
          headers: { Accept: 'text/html' },
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const frag = doc.querySelector('[data-reviews-fragment]');
        if (!frag) throw new Error('no fragment in response');

        const total = parseInt(frag.dataset.total || '0', 10) || 0;
        nextCursor = frag.dataset.nextCursor || null;

        /** @type {{ facets?: object, aggregate?: object, cards?: object[] } | null} */
        let payload = null;
        const payloadScript = frag.querySelector('[data-reviews-page-payload]');
        if (payloadScript) {
          try {
            payload = JSON.parse(payloadScript.textContent || 'null');
          } catch (_e) {
            payload = null;
          }
        }
        // Back-compat if an older proxy only emits facets.
        let facets = payload?.facets ?? null;
        if (!facets) {
          const facetScript = frag.querySelector('[data-reviews-facets]');
          if (facetScript) {
            try {
              facets = JSON.parse(facetScript.textContent || 'null');
            } catch (_e) {
              facets = null;
            }
          }
        }

        const newCards = [...frag.querySelectorAll('.reviews-card-wrapper')].map((c) =>
          document.importNode(c, true)
        );
        if (payload?.cards?.length) hydrateCardsFromAdmin(newCards, payload.cards);

        if (reset) {
          cardsRoot.replaceChildren(...newCards);
        } else {
          newCards.forEach((c) => cardsRoot.appendChild(c));
        }

        if (countEl) countEl.textContent = String(total);
        if (countNounEl) countNounEl.textContent = total === 1 ? 'review' : 'reviews';
        updateResultsState(total, reset);
        updateFacetCounts(facets);
        if (payload?.aggregate) updateAggregateBlock(payload.aggregate);
        syncFilterTriggerPressed(readFiltersFromUI());
        if (typeof window.reviewsLightboxReload === 'function') {
          window.reviewsLightboxReload();
        }
      } catch (err) {
        if (!reset) nextCursor = null;
      } finally {
        loading = false;
        if (loadMoreBtn) {
          loadMoreBtn.disabled = false;
          loadMoreBtn.textContent = 'Load more';
        }
        updateLoadMore();
      }
    }

    /** @param {number} total @param {boolean} reset */
    function updateResultsState(total, reset) {
      const filtersActive = hasActiveFilters(readFiltersFromUI());

      if (emptyEl) {
        if (reset && total === 0 && filtersActive) {
          emptyEl.classList.remove('hidden');
          cardsRoot.classList.add('hidden');
        } else {
          emptyEl.classList.add('hidden');
          cardsRoot.classList.remove('hidden');
        }
      }
    }

    /** @param {number} total */
    function updateEndCap(total) {
      if (!sparseEl) return;
      const msgEl = sparseEl.querySelector('.reviews-page__sparse-message');
      if (!(msgEl instanceof HTMLElement)) return;

      const filtersActive = hasActiveFilters(readFiltersFromUI());
      const allLoaded = !nextCursor && total > 0;

      if (!allLoaded) {
        sparseEl.classList.add('hidden');
        return;
      }

      if (filtersActive) {
        msgEl.textContent =
          total === 1
            ? 'Only 1 review matches these filters.'
            : `Only ${total} reviews match these filters.`;
      } else {
        msgEl.textContent =
          total === 1 ? 'Showing all 1 review' : `Showing all ${total} reviews`;
      }
      sparseEl.classList.remove('hidden');
    }

    function updateLoadMore() {
      if (loadMoreBtn) loadMoreBtn.classList.toggle('hidden', !nextCursor);
      const total = parseInt(countEl?.textContent || '0', 10) || 0;
      updateEndCap(total);
    }

    /**
     * @param {Record<string, any> | null} facets
     */
    function updateFacetCounts(facets) {
      if (!facets) return;
      root.querySelectorAll('[data-reviews-filter]').forEach((input) => {
        if (!(input instanceof HTMLInputElement)) return;
        const cat = input.dataset.reviewsFilter;
        const val = input.value;
        let count;
        if (cat === 'photos') count = facets.photos;
        else count = facets[cat] ? facets[cat][val] : undefined;
        if (typeof count !== 'number') return;

        const countEl2 = input.closest('label')?.querySelector('.reviews-filter__count');
        if (countEl2) countEl2.textContent = `(${count})`;
        const item = input.closest('.reviews-filter__item');
        if (item) item.classList.toggle('reviews-filter__item--empty', count === 0 && !input.checked);
      });
    }

    /**
     * Patch card prose / usage from Admin payload when Liquid metaobject fields lag.
     * @param {Element[]} cardEls
     * @param {Array<{ handle: string, answers?: object, rating?: number }>} adminCards
     */
    function hydrateCardsFromAdmin(cardEls, adminCards) {
      const byHandle = new Map(adminCards.map((c) => [c.handle, c]));
      cardEls.forEach((el) => {
        if (!(el instanceof HTMLElement)) return;
        const handle = el.dataset.reviewHandle || '';
        const admin = byHandle.get(handle);
        if (!admin?.answers) return;
        // Title — patch in place, or insert at the top of the card article
        // when Liquid hasn't caught up to a freshly submitted/edited title yet.
        if (typeof admin.title === 'string') {
          const article = el.querySelector('.reviews-card');
          let titleEl = el.querySelector('.reviews-card__title');
          if (admin.title && !titleEl && article) {
            titleEl = document.createElement('p');
            titleEl.className = 'reviews-card__title';
            article.prepend(titleEl);
          }
          if (titleEl) {
            if (admin.title) {
              titleEl.textContent = admin.title;
            } else {
              titleEl.remove();
            }
          }
        }
        const answers = admin.answers;
        const proseItems = el.querySelectorAll('.reviews-card__prose-item');
        const prose = Array.isArray(answers.prose) ? answers.prose : [];
        proseItems.forEach((item, i) => {
          const entry = prose[i];
          if (!entry) return;
          const prompt = item.querySelector('.reviews-card__prompt');
          const body = item.querySelector('.reviews-card__body');
          if (prompt instanceof HTMLElement) {
            prompt.textContent = entry.display_label ?? entry.label ?? prompt.textContent;
          }
          if (body instanceof HTMLElement) {
            body.textContent = entry.body ?? '';
          }
        });
        // Usage qualifier pills — update labels + filter values from canonical answers.
        const usage = el.querySelector('.reviews-card__usage');
        if (usage instanceof HTMLElement) {
          const freqBtn = usage.querySelector('[data-reviews-filter-trigger="frequency"]');
          const carryBtn = usage.querySelector('[data-reviews-filter-trigger="carry"]');
          const expBtn = usage.querySelector('[data-reviews-filter-trigger="experience"]');
          if (freqBtn instanceof HTMLElement && answers.how_often) {
            freqBtn.dataset.filterValue = String(answers.how_often);
            const freqLabels = filterLabels.frequency || {};
            freqBtn.textContent = freqLabels[answers.how_often] || String(answers.how_often);
          }
          if (carryBtn instanceof HTMLElement && answers.where_it_lives) {
            carryBtn.dataset.filterValue = String(answers.where_it_lives);
            const carryLabels = filterLabels.carry || {};
            carryBtn.textContent = carryLabels[answers.where_it_lives] || String(answers.where_it_lives);
          }
          if (expBtn instanceof HTMLElement && answers.dugout_experience) {
            expBtn.dataset.filterValue = String(answers.dugout_experience);
            expBtn.textContent = String(answers.dugout_experience);
          }
        }
      });
    }

    /**
     * Sync §5.9 aggregate block to Admin-fresh scoped stats (hide/restore).
     * @param {{ total?: number, average?: number, counts?: Record<string, number> }} aggregate
     */
    function updateAggregateBlock(aggregate) {
      const block = root.querySelector('.reviews-aggregate');
      if (!block || !aggregate) return;
      const total = typeof aggregate.total === 'number' ? aggregate.total : 0;
      const average = typeof aggregate.average === 'number' ? aggregate.average : 0;
      const counts = aggregate.counts || {};

      const scoreEl = block.querySelector('.reviews-aggregate__score');
      if (scoreEl) scoreEl.textContent = total > 0 ? String(average) : '0';

      const captionEl = block.querySelector('.reviews-aggregate__caption');
      if (captionEl) {
        const raw = captionEl.textContent || '';
        const prefixMatch = raw.match(/^(.*?)(\s+)\d/);
        const prefix = (prefixMatch ? prefixMatch[1] : raw.replace(/\s+\d[\d,]*\s+reviews?.*$/i, '')).trim() || 'From';
        captionEl.textContent =
          total === 1 ? `${prefix} 1 review` : `${prefix} ${total} reviews`;
      }

      const maxCount = Math.max(
        1,
        Number(counts[5]) || 0,
        Number(counts[4]) || 0,
        Number(counts[3]) || 0,
        Number(counts[2]) || 0,
        Number(counts[1]) || 0
      );

      for (let star = 5; star >= 1; star -= 1) {
        const n = Number(counts[star]) || 0;
        const pct = Math.round((n * 100) / maxCount);
        const row =
          block.querySelector(`[data-reviews-filter-trigger="rating"][data-filter-value="${star}"]`) ||
          [...block.querySelectorAll('.reviews-aggregate__row')].find((r) =>
            (r.querySelector('.reviews-aggregate__row-label')?.textContent || '').startsWith(`${star}`)
          );
        if (!(row instanceof HTMLElement)) continue;
        const fill = row.querySelector('.reviews-aggregate__bar-fill');
        const countNode = row.querySelector('.reviews-aggregate__row-count');
        if (fill instanceof HTMLElement) fill.style.width = n > 0 ? `${pct}%` : '0%';
        if (countNode) countNode.textContent = String(n);
      }
    }

    function seedInitialCursor() {
      const cards = [...cardsRoot.querySelectorAll('.reviews-card-wrapper')];
      const total = parseInt(countEl?.textContent || '0', 10) || cards.length;
      nextCursor =
        cards.length && cards.length < total ? cards[cards.length - 1].dataset.reviewHandle || null : null;
      updateLoadMore();
      updateResultsState(total, false);
    }

    function onFilterChange() {
      const filters = readFiltersFromUI();
      buildActivePills(filters);
      renderOwnsNestedPills();
      syncFiltersToURL(filters);
      syncFilterTriggerPressed(filters);
      syncCollapsibleSections(filters);
      updateFilterFab(filters);
      scrollToFilterResults();
      fetchPage({ reset: true });
    }

    function onSortChange() {
      syncFiltersToURL(readFiltersFromUI());
      fetchPage({ reset: true });
    }

    function removeFilter(key, value) {
      if (key === 'variant') {
        programmaticFilters.variant = programmaticFilters.variant.filter((v) => v !== value);
        seedDrawerFromCommitted();
        onFilterChange();
        return;
      }
      const input = root.querySelector(
        `[data-reviews-filter="${CSS.escape(key)}"][value="${CSS.escape(value || '')}"]`
      );
      if (input instanceof HTMLInputElement) input.checked = false;
      seedDrawerFromCommitted();
      onFilterChange();
    }

    // —— Events ————————————————————————————————————————————————————————

    root.querySelectorAll('[data-reviews-filter]').forEach((input) => {
      input.addEventListener('change', () => {
        // Checking a product's Owns box overrides its narrower card-tap finish
        // pills — the broader selection wins, so drop those first.
        if (input instanceof HTMLInputElement && input.dataset.reviewsFilter === 'owns' && input.checked) {
          pruneVariantForHandle(input.value);
        }
        onFilterChange();
      });
    });

    root.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const removeBtn = target?.closest('[data-owns-pill-remove]');
      if (removeBtn instanceof HTMLElement) {
        removeFilter('variant', removeBtn.dataset.reviewsPillValue || '');
      }
    });

    if (sortSelect) {
      sortSelect.addEventListener('change', onSortChange);
    }

    if (loadMoreBtn) {
      loadMoreBtn.addEventListener('click', () => {
        if (nextCursor) fetchPage({ reset: false });
      });
    }

    function clearAllFilters() {
      root.querySelectorAll('[data-reviews-filter]').forEach((input) => {
        if (input instanceof HTMLInputElement) input.checked = false;
      });
      programmaticFilters.variant = [];
      pillsExpanded = false;
      if (sortSelect instanceof HTMLSelectElement) sortSelect.value = 'recent';
      seedDrawerFromCommitted();
      onFilterChange();
    }

    if (pillsEl) {
      pillsEl.addEventListener('click', (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;

        const moreBtn = target.closest('[data-reviews-pills-more]');
        if (moreBtn instanceof HTMLElement) {
          pillsExpanded = true;
          layoutPillOverflow();
          moreBtn.setAttribute('aria-expanded', 'true');
          return;
        }

        const removeBtn = target.closest('[data-reviews-pill-key]');
        if (removeBtn instanceof HTMLElement && removeBtn.dataset.reviewsPillKey) {
          removeFilter(removeBtn.dataset.reviewsPillKey, removeBtn.dataset.reviewsPillValue || '');
          return;
        }

        if (target.closest('[data-reviews-clear-filters-inline]')) {
          clearAllFilters();
        }
      });
    }

    if (clearBtn) {
      clearBtn.addEventListener('click', clearAllFilters);
    }

    root.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;

      const trigger = target.closest('[data-reviews-filter-trigger]');
      if (!(trigger instanceof HTMLElement)) return;

      const key = trigger.dataset.reviewsFilterTrigger;
      const value = trigger.dataset.filterValue;
      if (!key || !value) return;

      const modeRaw = trigger.dataset.filterMode;
      const mode = modeRaw === 'replace' || modeRaw === 'add' ? modeRaw : 'toggle';
      applyFilter(key, value, { mode });
    });

    window.addEventListener('resize', () => {
      if (pillsEl && !pillsEl.classList.contains('hidden')) layoutPillOverflow();
    });

    if (pillsEl && typeof ResizeObserver !== 'undefined') {
      const pillObserver = new ResizeObserver(() => {
        if (!pillsEl.classList.contains('hidden')) layoutPillOverflow();
      });
      pillObserver.observe(pillsEl);
    }

    // —— M8 mobile filter drawer (draft → Apply) ——————————————————————

    const drawerEl = root.querySelector('[data-reviews-filter-drawer]');
    const drawerSheet = root.querySelector('[data-reviews-drawer-sheet]');
    const openFilterBtn = root.querySelector('[data-reviews-open-filter]');
    const filterBadge = root.querySelector('[data-reviews-filter-badge]');
    const stackMq = window.matchMedia('(max-width: 799px)');
    let drawerOpen = false;
    /** True while any part of the reviews surface intersects the viewport. */
    let fabSectionVisible = false;
    /** @type {HTMLElement | null} */
    let focusBeforeDrawer = null;

    function countActiveFilterValues(filters) {
      return FILTER_KEYS.reduce((n, k) => n + ((filters[k] || []).length), 0);
    }

    function updateFilterFab(filters) {
      if (!openFilterBtn) return;
      // Mobile-only, and only while the reviews section is on screen — otherwise
      // the fixed FAB floats over ATC / recommendations / footer on PDPs.
      const show = stackMq.matches && fabSectionVisible;
      openFilterBtn.hidden = !show;
      openFilterBtn.setAttribute('aria-hidden', show ? 'false' : 'true');
      if (!filterBadge) return;
      const n = countActiveFilterValues(filters || readFiltersFromUI());
      if (n > 0) {
        filterBadge.textContent = String(n);
        filterBadge.classList.remove('hidden');
        openFilterBtn.setAttribute('aria-label', `Filter, ${n} active`);
      } else {
        filterBadge.classList.add('hidden');
        openFilterBtn.setAttribute('aria-label', 'Filter');
      }
    }

    if (openFilterBtn && typeof IntersectionObserver === 'function') {
      const fabVisibilityObserver = new IntersectionObserver(
        (entries) => {
          fabSectionVisible = entries.some((entry) => entry.isIntersecting);
          updateFilterFab();
        },
        { threshold: 0 }
      );
      fabVisibilityObserver.observe(root);
    } else if (openFilterBtn) {
      fabSectionVisible = true;
    }

    function seedDrawerFromCommitted() {
      if (!drawerEl) return;
      const committed = readFiltersFromUI();
      drawerEl.querySelectorAll('[data-reviews-drawer-filter]').forEach((input) => {
        if (!(input instanceof HTMLInputElement)) return;
        const key = input.dataset.reviewsDrawerFilter;
        const list = key ? committed[key] || [] : [];
        input.checked = list.includes(input.value);
      });
      const sectionToKey = {
        reviewer: 'reviewer',
        color: 'color',
        rating: 'rating',
        owns: 'owns',
        photos: 'photos',
        frequency: 'frequency',
        carry: 'carry',
        experience: 'experience',
      };
      drawerEl.querySelectorAll('[data-reviews-filter-section]').forEach((el) => {
        if (!(el instanceof HTMLDetailsElement)) return;
        const key = sectionToKey[el.dataset.reviewsFilterSection || ''];
        if (!key) return;
        let active = (committed[key] || []).length > 0;
        if (key === 'owns' && (committed.variant || []).length > 0) active = true;
        if (active) el.open = true;
      });
      renderOwnsNestedPills();
    }

    function commitDrawerToSidebar() {
      if (!drawerEl) return;
      /** @type {Record<string, string[]>} */
      const draft = emptyFilters();
      drawerEl.querySelectorAll('[data-reviews-drawer-filter]').forEach((input) => {
        if (!(input instanceof HTMLInputElement) || !input.checked) return;
        const key = input.dataset.reviewsDrawerFilter;
        if (key && draft[key]) draft[key].push(input.value);
      });
      draft.variant = [...programmaticFilters.variant];
      syncFiltersToUI(draft);
    }

    function getDrawerFocusables() {
      if (!drawerSheet) return [];
      return [
        ...drawerSheet.querySelectorAll(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ),
      ].filter((el) => el instanceof HTMLElement && !el.hasAttribute('disabled'));
    }

    function onDrawerKeydown(event) {
      if (!drawerOpen) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeDrawer();
        return;
      }
      if (event.key !== 'Tab' || !drawerSheet) return;
      const focusables = getDrawerFocusables();
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    function openDrawer() {
      if (!drawerEl || drawerOpen) return;
      focusBeforeDrawer = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      seedDrawerFromCommitted();
      drawerEl.hidden = false;
      void drawerEl.offsetWidth;
      drawerEl.classList.add('is-open');
      document.documentElement.classList.add('reviews-filter-drawer-open');
      document.body.style.overflow = 'hidden';
      drawerOpen = true;
      document.addEventListener('keydown', onDrawerKeydown);
      const focusables = getDrawerFocusables();
      const closeBtn = drawerEl.querySelector('[data-reviews-drawer-close]');
      (closeBtn instanceof HTMLElement ? closeBtn : focusables[0])?.focus();
    }

    function closeDrawer() {
      if (!drawerEl || !drawerOpen) return;
      drawerEl.classList.remove('is-open');
      document.documentElement.classList.remove('reviews-filter-drawer-open');
      document.body.style.overflow = '';
      document.removeEventListener('keydown', onDrawerKeydown);
      drawerOpen = false;

      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        drawerEl.hidden = true;
        if (focusBeforeDrawer && document.contains(focusBeforeDrawer)) focusBeforeDrawer.focus();
        focusBeforeDrawer = null;
      };

      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        finish();
      } else if (drawerSheet) {
        const onEnd = (event) => {
          if (event.target !== drawerSheet || event.propertyName !== 'transform') return;
          drawerSheet.removeEventListener('transitionend', onEnd);
          finish();
        };
        drawerSheet.addEventListener('transitionend', onEnd);
        window.setTimeout(finish, 320);
      } else {
        finish();
      }
    }

    function applyDrawerFilters() {
      commitDrawerToSidebar();
      closeDrawer();
      onFilterChange();
    }

    function clearDrawerAndClose() {
      closeDrawer();
      clearAllFilters();
    }

    if (openFilterBtn) {
      openFilterBtn.addEventListener('click', openDrawer);
    }

    if (drawerEl) {
      drawerEl.querySelector('[data-reviews-drawer-overlay]')?.addEventListener('click', () => {
        closeDrawer();
      });
      drawerEl.querySelector('[data-reviews-drawer-close]')?.addEventListener('click', () => {
        closeDrawer();
      });
      drawerEl.querySelector('[data-reviews-drawer-apply]')?.addEventListener('click', applyDrawerFilters);
      drawerEl.querySelector('[data-reviews-drawer-clear]')?.addEventListener('click', clearDrawerAndClose);
      drawerEl.querySelectorAll('[data-reviews-drawer-filter="owns"]').forEach((input) => {
        input.addEventListener('change', () => {
          // Prune + repaint immediately (matches the "no draft state" pill removal),
          // but don't force a fetch/scroll behind the still-open drawer — Apply
          // (commitDrawerToSidebar → onFilterChange) picks up the pruned state.
          if (!(input instanceof HTMLInputElement) || !input.checked) return;
          pruneVariantForHandle(input.value);
          renderOwnsNestedPills();
          buildActivePills(readFiltersFromUI());
        });
      });
    }

    const onStackChange = () => {
      updateFilterFab(readFiltersFromUI());
      if (!stackMq.matches && drawerOpen) closeDrawer();
    };
    if (typeof stackMq.addEventListener === 'function') {
      stackMq.addEventListener('change', onStackChange);
    } else if (typeof stackMq.addListener === 'function') {
      stackMq.addListener(onStackChange);
    }

    // —— Boot ——————————————————————————————————————————————————————————

    const urlFilters = readFiltersFromURL();
    const urlSort = new URLSearchParams(window.location.search).get('sort');
    syncFiltersToUI(urlFilters);
    if (sortSelect instanceof HTMLSelectElement && urlSort) sortSelect.value = urlSort;

    buildActivePills(urlFilters);
    renderOwnsNestedPills();
    updateFilterFab(urlFilters);
    syncCollapsibleSections(urlFilters);

    // Always pull page 1 from App Proxy (Admin-backed) so edit/hide/restore
    // match first interactive paint without waiting for Liquid metaobject sync.
    fetchPage({ reset: true });
  }

  function boot() {
    document.querySelectorAll('[data-reviews-surface]').forEach(initReviewsSurface);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
