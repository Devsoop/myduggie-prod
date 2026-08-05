import { Component } from '@theme/component';
import { CartAddEvent, ThemeEvents } from '@theme/events';
import { DialogCloseEvent } from '@theme/dialog';
import { onDocumentLoaded, changeMetaThemeColor, setHeaderMenuStyle, debounce } from '@theme/utilities';

/**
 * @typedef {Object} HeaderComponentRefs
 * @property {HTMLDivElement} headerDrawerContainer - The header drawer container element
 * @property {HTMLElement} headerMenu - The header menu element
 * @property {HTMLElement} headerRowTop - The header top row element
 */

/**
 * @typedef {CustomEvent<{ minimumReached: boolean }>} OverflowMinimumEvent
 */

/**
 * A custom element that manages the site header.
 *
 * @extends {Component<HeaderComponentRefs>}
 */

class HeaderComponent extends Component {
  requiredRefs = ['headerDrawerContainer', 'headerMenu', 'headerRowTop'];

  /**
   * Width of window when header drawer was hidden
   * @type {number | null}
   */
  #menuDrawerHiddenWidth = null;

  /**
   * An intersection observer for monitoring sticky header position
   * @type {IntersectionObserver | null}
   */
  #intersectionObserver = null;

  /**
   * Whether the header has been scrolled offscreen, when sticky behavior is 'scroll-up'
   * @type {boolean}
   */
  #offscreen = false;

  /**
   * The last recorded scrollTop of the document, when sticky behavior is 'scroll-up
   * @type {number}
   */
  #lastScrollTop = 0;

  /**
   * A timeout to allow for hiding animation, when sticky behavior is 'scroll-up'
   * @type {number | null}
   */
  #timeout = null;

  /**
   * RAF ID for scroll handler throttling
   * @type {number | null}
   */
  #scrollRafId = null;

  /**
   * Timestamp of the last auto-hide state change, used as a cooldown to prevent flickering.
   * @type {number}
   */
  #lastAutoHideToggle = 0;

  /**
   * Whether the header intro phase is active (visible before auto-hide).
   * @type {boolean}
   */
  #introPhase = false;

  /**
   * Timeout for ending the header intro phase.
   * @type {number | null}
   */
  #introHideTimeout = null;

  /** @type {number} */
  #introDurationMs = 3000;

  /**
   * Whether the header cart-reveal phase is active (visible after add-to-cart).
   * @type {boolean}
   */
  #cartRevealPhase = false;

  /**
   * Timeout for ending the header cart-reveal phase.
   * @type {number | null}
   */
  #cartRevealHideTimeout = null;

  /** @type {number} */
  #cartRevealDurationMs = 3000;

  /**
   * Timeout for settle delay after cart attention cue completes.
   * @type {number | null}
   */
  #cartRevealSettleTimeout = null;

  /** @type {number} */
  #cartRevealSettleDelayMs = 300;

  /**
   * Media query for mobile and tablet portrait — scroll-up/down header reveal.
   * @type {MediaQueryList}
   */
  #scrollRevealQuery = window.matchMedia('(max-width: 989px)');

  /**
   * Media query for desktop hover-capable pointer input.
   * @type {MediaQueryList}
   */
  #canHoverReveal = window.matchMedia('(hover: hover) and (pointer: fine)');

  /**
   * Fixed zone at the top of the viewport to reveal the hidden header.
   * @type {HTMLDivElement | null}
   */
  #revealZone = null;

  /**
   * Debounce timeout for hiding after pointer leaves the header area.
   * @type {number | null}
   */
  #hideDebounceTimeout = null;

  /**
   * Debounced resize handler to update drawer vs desktop menu layout.
   */
  #menuStyleResizeListener = debounce(() => {
    setHeaderMenuStyle();
  }, 100);

  /**
   * which other theme components can then consume
   */
  #resizeObserver = new ResizeObserver(([entry]) => {
    if (!entry || !entry.borderBoxSize[0]) return;

    // The initial height is calculated using the .offsetHeight property, which returns an integer.
    // We round to the nearest integer to avoid unnecessaary reflows.
    const roundedHeaderHeight = Math.round(entry.borderBoxSize[0].blockSize);
    document.body.style.setProperty('--header-height', `${roundedHeaderHeight}px`);

    // Check if the menu drawer should be hidden in favor of the header menu
    if (this.#menuDrawerHiddenWidth && window.innerWidth > this.#menuDrawerHiddenWidth && window.innerWidth > 989) {
      this.#updateMenuVisibility(false);
    }
  });

  /**
   * Observes the header while scrolling the viewport to track when its actively sticky
   * @param {Boolean} alwaysSticky - Determines if we need to observe when the header is offscreen
   */
  #observeStickyPosition = (alwaysSticky = true) => {
    if (this.#intersectionObserver) return;

    const config = {
      threshold: alwaysSticky ? 1 : 0,
    };

    this.#intersectionObserver = new IntersectionObserver(([entry]) => {
      if (!entry) return;

      const { isIntersecting } = entry;

      if (alwaysSticky) {
        if (this.dataset.headerBehavior !== 'auto_hide') {
          this.dataset.stickyState = isIntersecting ? 'inactive' : 'active';
        }
        if (this.dataset.themeColor) changeMetaThemeColor(this.dataset.themeColor);
      } else {
        this.#offscreen = !isIntersecting || this.dataset.stickyState === 'active';
      }
    }, config);

    this.#intersectionObserver.observe(this);
  };

  /**
   * Handles the overflow minimum event from the header menu
   * @param {OverflowMinimumEvent} event
   */
  #handleOverflowMinimum = (event) => {
    this.#updateMenuVisibility(event.detail.minimumReached);
  };

  /**
   * Updates the visibility of the menu and drawer
   * @param {boolean} hideMenu - Whether to hide the menu and show the drawer
   */
  #updateMenuVisibility(hideMenu) {
    if (hideMenu) {
      this.#menuDrawerHiddenWidth = window.innerWidth;
    } else {
      this.#menuDrawerHiddenWidth = null;
    }
    setHeaderMenuStyle();
  }

  #handleWindowScroll = () => {
    if (this.#scrollRafId !== null) return;

    this.#scrollRafId = requestAnimationFrame(() => {
      this.#scrollRafId = null;
      this.#updateScrollState();
    });
  };

  #isScrollRevealActive = () => {
    return this.dataset.headerBehavior === 'auto_hide' && this.#scrollRevealQuery.matches;
  };

  #isHoverRevealActive = () => {
    return (
      this.dataset.headerBehavior === 'auto_hide' &&
      !this.#scrollRevealQuery.matches &&
      this.#canHoverReveal.matches
    );
  };

  #revealAutoHiddenHeader = () => {
    if (!this.#isHoverRevealActive() || this.dataset.stickyState !== 'idle') return;

    if (this.#hideDebounceTimeout !== null) {
      clearTimeout(this.#hideDebounceTimeout);
      this.#hideDebounceTimeout = null;
    }

    this.dataset.stickyState = 'active';
    this.dataset.revealSource = 'hover';
  };

  #hideAutoHiddenHeader = () => {
    if (!this.#isHoverRevealActive() || this.#introPhase || this.#cartRevealPhase) return;
    if (this.dataset.stickyState !== 'active') return;
    if (this.contains(document.activeElement)) return;

    this.dataset.stickyState = 'idle';
    delete this.dataset.revealSource;
    this.#lastAutoHideToggle = performance.now();
  };

  #scheduleHideAutoHiddenHeader = () => {
    if (this.#hideDebounceTimeout !== null) {
      clearTimeout(this.#hideDebounceTimeout);
    }

    this.#hideDebounceTimeout = window.setTimeout(() => {
      this.#hideDebounceTimeout = null;
      this.#hideAutoHiddenHeader();
    }, 300);
  };

  #cancelScheduledHide = () => {
    if (this.#hideDebounceTimeout !== null) {
      clearTimeout(this.#hideDebounceTimeout);
      this.#hideDebounceTimeout = null;
    }
  };

  #handleRevealZonePointerEnter = () => {
    this.#cancelCartRevealAutoHide();
    this.#revealAutoHiddenHeader();
  };

  #handleHeaderPointerEnter = () => {
    this.#cancelCartRevealAutoHide();
    this.#revealAutoHiddenHeader();
  };

  /**
   * @param {PointerEvent} event
   */
  #handleHeaderPointerLeave = (event) => {
    if (!this.#isHoverRevealActive()) return;

    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && (this.contains(relatedTarget) || this.#revealZone?.contains(relatedTarget))) {
      return;
    }

    this.#scheduleHideAutoHiddenHeader();
  };

  /**
   * @param {PointerEvent} event
   */
  #handleRevealZonePointerLeave = (event) => {
    if (!this.#isHoverRevealActive()) return;

    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && (this.contains(relatedTarget) || this.#revealZone?.contains(relatedTarget))) {
      return;
    }

    this.#scheduleHideAutoHiddenHeader();
  };

  #handleHeaderFocusIn = () => {
    this.#cancelCartRevealAutoHide();
    this.#revealAutoHiddenHeader();
  };

  /**
   * @param {FocusEvent} event
   */
  #handleHeaderFocusOut = (event) => {
    if (!this.#isHoverRevealActive()) return;

    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && this.contains(relatedTarget)) return;

    this.#scheduleHideAutoHiddenHeader();
  };

  #setupRevealZone = () => {
    if (this.#revealZone) return;

    const zone = document.createElement('div');
    zone.className = 'header-reveal-zone';
    zone.setAttribute('aria-hidden', 'true');
    document.body.appendChild(zone);
    this.#revealZone = zone;

    zone.addEventListener('pointerenter', this.#handleRevealZonePointerEnter);
    zone.addEventListener('pointerleave', this.#handleRevealZonePointerLeave);
    this.addEventListener('pointerenter', this.#handleHeaderPointerEnter);
    this.addEventListener('pointerleave', this.#handleHeaderPointerLeave);
    this.addEventListener('focusin', this.#handleHeaderFocusIn);
    this.addEventListener('focusout', this.#handleHeaderFocusOut);
  };

  #teardownRevealZone = () => {
    if (!this.#revealZone) return;

    this.#revealZone.removeEventListener('pointerenter', this.#handleRevealZonePointerEnter);
    this.#revealZone.removeEventListener('pointerleave', this.#handleRevealZonePointerLeave);
    this.removeEventListener('pointerenter', this.#handleHeaderPointerEnter);
    this.removeEventListener('pointerleave', this.#handleHeaderPointerLeave);
    this.removeEventListener('focusin', this.#handleHeaderFocusIn);
    this.removeEventListener('focusout', this.#handleHeaderFocusOut);
    this.#revealZone.remove();
    this.#revealZone = null;
  };

  #initAutoHideRevealMode = () => {
    if (this.#isScrollRevealActive()) {
      this.#cancelScheduledHide();
      this.#teardownRevealZone();
      const scrollTop = document.scrollingElement?.scrollTop ?? 0;
      this.#lastScrollTop = scrollTop;
      this.dataset.scrollDirection = 'none';

      if (scrollTop <= 0) {
        if (!this.#introPhase && this.#introHideTimeout === null) {
          this.#startAutoHideIntro();
        }
      } else {
        this.#clearIntroHideTimeout();
        this.#introPhase = false;
        this.dataset.stickyState = 'active';
        delete this.dataset.revealSource;
      }
    } else if (this.#isHoverRevealActive()) {
      this.#setupRevealZone();
      if (!this.#introPhase && this.#introHideTimeout === null) {
        this.#startAutoHideIntro();
      }
    } else {
      this.#cancelScheduledHide();
      this.#clearIntroHideTimeout();
      this.#introPhase = false;
      this.#teardownRevealZone();
      this.dataset.stickyState = 'active';
      delete this.dataset.revealSource;
    }
  };

  #handleRevealModeChange = () => {
    if (this.dataset.headerBehavior !== 'auto_hide') return;
    this.#initAutoHideRevealMode();
  };

  #updateScrollState = () => {
    const stickyMode = this.getAttribute('sticky');
    const isAutoHideScroll = this.#isScrollRevealActive();

    if (!this.#offscreen && stickyMode !== 'always' && !isAutoHideScroll) return;

    const scrollTop = document.scrollingElement?.scrollTop ?? 0;
    const headerTop = this.getBoundingClientRect().top;
    const isScrollingUp = scrollTop < this.#lastScrollTop;
    const isAtTop = headerTop >= 0;

    if (this.#timeout) {
      clearTimeout(this.#timeout);
      this.#timeout = null;
    }

    if (this.dataset.headerBehavior === 'auto_hide') {
      if (this.#introPhase || this.#cartRevealPhase) {
        this.#lastScrollTop = scrollTop;
        return;
      }

      if (this.#isScrollRevealActive()) {
        if (isScrollingUp) {
          if (isAtTop) {
            this.#offscreen = false;
            this.dataset.stickyState = 'active';
            delete this.dataset.revealSource;
            this.dataset.scrollDirection = 'none';
          } else {
            this.dataset.stickyState = 'active';
            delete this.dataset.revealSource;
            this.dataset.scrollDirection = 'up';
          }
        } else if (this.dataset.stickyState === 'active') {
          this.dataset.scrollDirection = 'none';
          this.dataset.stickyState = 'idle';
          delete this.dataset.revealSource;
        } else {
          this.dataset.scrollDirection = 'none';
          this.dataset.stickyState = 'idle';
          delete this.dataset.revealSource;
        }

        this.#lastScrollTop = scrollTop;
        return;
      }

      if (this.#isHoverRevealActive()) {
        if (isAtTop) {
          this.dataset.scrollDirection = 'none';
        } else if (isScrollingUp) {
          this.dataset.scrollDirection = 'up';
        } else {
          this.dataset.scrollDirection = 'down';
        }

        this.#lastScrollTop = scrollTop;
        return;
      }

      this.#lastScrollTop = scrollTop;
      return;
    }

    if (stickyMode === 'always') {
      if (isAtTop) {
        this.dataset.scrollDirection = 'none';
      } else if (isScrollingUp) {
        this.dataset.scrollDirection = 'up';
      } else {
        this.dataset.scrollDirection = 'down';
      }

      this.#lastScrollTop = scrollTop;
      return;
    }

    if (isScrollingUp) {
      if (isAtTop) {
        // reset sticky state when header is scrolled up to natural position
        this.#offscreen = false;
        this.dataset.stickyState = 'inactive';
        this.dataset.scrollDirection = 'none';
      } else {
        // show sticky header when scrolling up
        this.dataset.stickyState = 'active';
        this.dataset.scrollDirection = 'up';
        delete this.dataset.revealSource;
      }
    } else if (this.dataset.stickyState === 'active') {
      this.dataset.scrollDirection = 'none';

      this.dataset.stickyState = 'idle';
      delete this.dataset.revealSource;
    } else {
      this.dataset.scrollDirection = 'none';
      this.dataset.stickyState = 'idle';
      delete this.dataset.revealSource;
    }

    this.#lastScrollTop = scrollTop;
  };

  #startAutoHideIntro = () => {
    const introDuration = parseInt(
      getComputedStyle(this).getPropertyValue('--header-intro-duration'),
      10
    );
    if (!Number.isNaN(introDuration) && introDuration > 0) {
      this.#introDurationMs = introDuration;
    }

    this.#introPhase = true;
    this.dataset.stickyState = 'active';
    this.dataset.revealSource = 'intro';
    this.#clearIntroHideTimeout();
    this.#introHideTimeout = window.setTimeout(() => {
      this.#introPhase = false;
      this.#introHideTimeout = null;
      this.dataset.stickyState = 'idle';
      delete this.dataset.revealSource;
      this.#lastAutoHideToggle = performance.now();
    }, this.#introDurationMs);
  };

  #clearIntroHideTimeout = () => {
    if (this.#introHideTimeout !== null) {
      clearTimeout(this.#introHideTimeout);
      this.#introHideTimeout = null;
    }
  };

  /**
   * @param {Event} event
   */
  #handleCartAdd = (event) => {
    if (!(event instanceof CartAddEvent)) return;
    if (this.dataset.headerBehavior !== 'auto_hide') return;
    if (event.detail.data?.didError) return;

    const wasIdle = this.dataset.stickyState === 'idle';

    if (wasIdle) {
      this.#revealForCartAdd();
      const transitionDuration = this.#getHeaderTransitionDurationMs();
      window.setTimeout(() => {
        if (!this.#cartRevealPhase) return;
        this.#dispatchCartAttentionReady();
      }, transitionDuration);
    } else {
      requestAnimationFrame(() => {
        this.#dispatchCartAttentionReady();
      });
    }
  };

  #dispatchCartAttentionReady = () => {
    this.dispatchEvent(new CustomEvent('header:cart-attention-ready', { bubbles: true }));
  };

  #getHeaderTransitionDurationMs = () => {
    const raw = getComputedStyle(this).getPropertyValue('--header-opacity-transition-duration').trim();
    if (raw.endsWith('ms')) return parseFloat(raw);
    if (raw.endsWith('s')) return parseFloat(raw) * 1000;
    return 500;
  };

  #revealForCartAdd = () => {
    const revealDuration = parseInt(
      getComputedStyle(this).getPropertyValue('--header-cart-reveal-duration'),
      10
    );
    if (!Number.isNaN(revealDuration) && revealDuration > 0) {
      this.#cartRevealDurationMs = revealDuration;
    }

    this.#clearIntroHideTimeout();
    this.#introPhase = false;
    this.#clearCartRevealHideTimeout();
    this.#clearCartRevealSettleTimeout();
    this.#cartRevealPhase = true;
    this.dataset.stickyState = 'active';
    this.dataset.revealSource = 'cart';

    this.#cartRevealHideTimeout = window.setTimeout(() => {
      this.#endCartRevealPhase();
    }, this.#cartRevealDurationMs);
  };

  #handleCartAttentionComplete = () => {
    // Header stays visible for the full cart-reveal duration; no early hide.
  };

  /**
   * Hides the auto-hide header again once the cart drawer closes.
   * @param {Event} event
   */
  #handleCartDrawerClose = (event) => {
    if (this.dataset.headerBehavior !== 'auto_hide') return;
    if (!(event.target instanceof Element) || !event.target.matches('cart-drawer-component')) return;

    // cancel any active reveal phases / pending hides
    this.#clearIntroHideTimeout();
    this.#introPhase = false;
    this.#cancelCartRevealAutoHide();
    this.#cancelScheduledHide();

    // hide immediately (hover/scroll handlers will re-reveal if applicable)
    this.dataset.stickyState = 'idle';
    delete this.dataset.revealSource;
    this.dataset.scrollDirection = 'none';
    this.#lastScrollTop = document.scrollingElement?.scrollTop ?? 0;
    this.#lastAutoHideToggle = performance.now();
  };

  #endCartRevealPhase = () => {
    this.#cartRevealPhase = false;
    this.#clearCartRevealHideTimeout();
    this.#clearCartRevealSettleTimeout();

    if (this.dataset.revealSource !== 'cart') return;

    this.dataset.stickyState = 'idle';
    delete this.dataset.revealSource;
    this.#lastAutoHideToggle = performance.now();
  };

  #cancelCartRevealAutoHide = () => {
    if (!this.#cartRevealPhase) return;

    this.#clearCartRevealHideTimeout();
    this.#clearCartRevealSettleTimeout();
    this.#cartRevealPhase = false;

    if (this.dataset.revealSource === 'cart') {
      delete this.dataset.revealSource;
    }
  };

  #clearCartRevealHideTimeout = () => {
    if (this.#cartRevealHideTimeout !== null) {
      clearTimeout(this.#cartRevealHideTimeout);
      this.#cartRevealHideTimeout = null;
    }
  };

  #clearCartRevealSettleTimeout = () => {
    if (this.#cartRevealSettleTimeout !== null) {
      clearTimeout(this.#cartRevealSettleTimeout);
      this.#cartRevealSettleTimeout = null;
    }
  };

  connectedCallback() {
    super.connectedCallback();
    this.#resizeObserver.observe(this);
    this.addEventListener('overflowMinimum', this.#handleOverflowMinimum);

    this.dataset.headerBehavior = 'auto_hide';
    if (!this.getAttribute('sticky')) {
      this.setAttribute('sticky', 'always');
    }

    this.#scrollRevealQuery.addEventListener('change', this.#handleRevealModeChange);
    this.#canHoverReveal.addEventListener('change', this.#handleRevealModeChange);
    setHeaderMenuStyle();
    this.#initAutoHideRevealMode();

    const stickyMode = this.getAttribute('sticky');
    if (stickyMode) {
      this.#observeStickyPosition(stickyMode === 'always');

      if (stickyMode === 'scroll-up' || stickyMode === 'always') {
        document.addEventListener('scroll', this.#handleWindowScroll, { passive: true });
      }
    }

    window.addEventListener('resize', this.#menuStyleResizeListener);
    document.addEventListener(ThemeEvents.cartUpdate, this.#handleCartAdd);
    document.addEventListener('cart-attention-complete', this.#handleCartAttentionComplete);
    // Capture phase: DialogCloseEvent does not bubble, so a document-level
    // bubble listener never fires; capturing still receives it from descendants.
    document.addEventListener(DialogCloseEvent.eventName, this.#handleCartDrawerClose, true);
    setHeaderMenuStyle();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#resizeObserver.disconnect();
    this.#intersectionObserver?.disconnect();
    this.removeEventListener('overflowMinimum', this.#handleOverflowMinimum);
    this.#scrollRevealQuery.removeEventListener('change', this.#handleRevealModeChange);
    this.#canHoverReveal.removeEventListener('change', this.#handleRevealModeChange);
    this.#teardownRevealZone();
    this.#cancelScheduledHide();
    document.removeEventListener('scroll', this.#handleWindowScroll);
    window.removeEventListener('resize', this.#menuStyleResizeListener);
    this.#clearIntroHideTimeout();
    this.#clearCartRevealHideTimeout();
    this.#clearCartRevealSettleTimeout();
    document.removeEventListener(ThemeEvents.cartUpdate, this.#handleCartAdd);
    document.removeEventListener('cart-attention-complete', this.#handleCartAttentionComplete);
    document.removeEventListener(DialogCloseEvent.eventName, this.#handleCartDrawerClose, true);
    if (this.#scrollRafId !== null) {
      cancelAnimationFrame(this.#scrollRafId);
      this.#scrollRafId = null;
    }
    document.body.style.setProperty('--header-height', '0px');
  }
}

if (!customElements.get('header-component')) {
  customElements.define('header-component', HeaderComponent);
}

onDocumentLoaded(() => {
  const header = document.querySelector('header-component');
  const headerGroup = document.querySelector('#header-group');

  // Note: Initial header heights are set via inline script in theme.liquid
  // This ResizeObserver handles dynamic updates after page load

  // Update header group height on resize of any child
  if (headerGroup) {
    const resizeObserver = new ResizeObserver((entries) => {
      const headerGroupHeight = entries.reduce((totalHeight, entry) => {
        if (
          entry.target !== header ||
          (header.hasAttribute('transparent') && header.parentElement?.nextElementSibling)
        ) {
          return totalHeight + (entry.borderBoxSize[0]?.blockSize ?? 0);
        }
        return totalHeight;
      }, 0);
      // The initial height is calculated using the .offsetHeight property, which returns an integer.
      // We round to the nearest integer to avoid unnecessaary reflows.
      const roundedHeaderGroupHeight = Math.round(headerGroupHeight);
      document.body.style.setProperty('--header-group-height', `${roundedHeaderGroupHeight}px`);
    });

    if (header instanceof HTMLElement) {
      resizeObserver.observe(header);
    }

    // Observe all children of the header group
    const children = headerGroup.children;
    for (let i = 0; i < children.length; i++) {
      const element = children[i];
      if (element instanceof HTMLElement) {
        resizeObserver.observe(element);
      }
    }

    // Also observe the header group itself for child changes
    const mutationObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          // Re-observe all children when the list changes
          const children = headerGroup.children;
          for (let i = 0; i < children.length; i++) {
            const element = children[i];
            if (element instanceof HTMLElement) {
              resizeObserver.observe(element);
            }
          }
        }
      }
    });

    mutationObserver.observe(headerGroup, { childList: true });
  }
});

