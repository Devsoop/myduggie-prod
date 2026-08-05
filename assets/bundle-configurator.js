/**
 * =============================================================================
 * BUNDLE CONFIGURATOR
 * =============================================================================
 * Client-side orchestrator for the bundle product page. This is a plain class
 * (not a web component) instantiated by the <bundle-page> custom element
 * after dynamic import.
 *
 * Responsibilities:
 * 1. Color swatch selection — tracks one color per constituent product
 * 2. Outline composition — swaps outline silhouettes to variant images on pick
 * 3. Selection counter — updates "X of Y chosen" in header and CTA areas
 * 4. Add to cart — submits all selected variants as separate line items with
 *    _bundle_tag property for cart grouping
 * 5. Cross-sell recommendations — fetches and renders "Also made by" cards
 *    from Shopify's Product Recommendations API
 *
 * Data flow:
 * - Reads configuration from data-* attributes on the root <bundle-page> element
 * - Reads swatch data from data-* attributes on each swatch button
 * - Reads outline items from [data-outline-item] elements
 * - Communicates with Shopify via /cart/add.js, /cart.js, /products/{handle}.js,
 *   and /recommendations/products.json endpoints
 * - Dispatches CartAddEvent for the theme's cart drawer to react to
 * =============================================================================
 */

import { CartAddEvent } from '@theme/events';

/**
 * Represents a single color selection for one constituent product in the bundle.
 * One BundleSelection exists per picker (per constituent product).
 *
 * @typedef {Object} BundleSelection
 * @property {string} variantId - Shopify variant ID for cart submission
 * @property {string} colorName - Display name of the selected color (e.g., "Onyx Black")
 * @property {string} colorHex - Hex value for visual reference
 * @property {string} productHandle - Shopify product handle for API lookups
 * @property {number} pickerIndex - Index matching constituent_items order (for sort)
 * @property {boolean} isSpecial - Whether this is a special/limited edition color
 * @property {string | null} [variantImage] - Resolved variant image URL (set async)
 */

export class BundleConfigurator {
  /**
   * @param {HTMLElement} rootElement - The <bundle-page> custom element
   */
  constructor(rootElement) {
    this.root = rootElement;

    // Parse bundle configuration from data attributes set by Liquid
    const itemCountValue = rootElement.dataset.itemCount ?? '0';
    this.itemCount = parseInt(itemCountValue, 10) || 0; // Total items user must select
    this.productHandle = rootElement.dataset.productHandle || '';
    this.productId = rootElement.dataset.productId || '';
    this.productTitle = rootElement.dataset.productTitle || this.productHandle;
    this.outlineImageWidth = 300; // Width for variant images in outline composition

    /** @type {Map<string, BundleSelection>} Keyed by product ID — one selection per constituent */
    this.selections = new Map();

    /** @type {Map<string, { variants: Array<{ id: number, title: string, featured_image?: { src?: string } }> }>} Cache of /products/{handle}.js responses to avoid redundant fetches */
    this.productCache = new Map();

    // Query and cache all interactive DOM elements
    /** @type {NodeListOf<HTMLButtonElement>} All color swatch buttons across all pickers */
    this.swatchButtons = this.root.querySelectorAll('[data-swatch]');
    /** @type {NodeListOf<HTMLElement>} Outline composition items (one per constituent product) */
    this.outlineItems = this.root.querySelectorAll('[data-outline-item]');
    /** @type {NodeListOf<HTMLElement>} Counter text elements showing current selection count */
    this.counterElements = this.root.querySelectorAll('[data-counter-current]');
    /** @type {NodeListOf<HTMLElement>} Counter container elements (for error state styling) */
    this.counterContainers = this.root.querySelectorAll('[data-bundle-counter], [data-counter-caption]');
    /** @type {HTMLButtonElement | null} The "Add to cart" button */
    this.addToCartButton = this.root.querySelector('[data-add-to-cart]');
    /** @type {NodeListOf<HTMLButtonElement>} Any CTA button gated on full selection (add-to-cart or, on the gift recipient page, the receive-gift button) */
    this.ctaButtons = this.root.querySelectorAll('[data-add-to-cart], [data-receive-gift]');
    /** @type {HTMLElement | null} Text span inside the add-to-cart button (for success/error messages) */
    this.addToCartText = this.root.querySelector('.bundle-page__add-to-cart-text');
    /** @type {HTMLElement | null} Cross-sell section wrapper (hidden until recommendations load) */
    this.crossSellSection = this.root.querySelector('[data-cross-sell]');
    /** @type {HTMLElement | null} Cross-sell grid container (cards injected here by JS) */
    this.crossSellGrid = this.root.querySelector('[data-cross-sell-grid]');

    this.cacheElements();
    this.bindEvents();
    this.updateCounter(); // Initialize counter display to "0 of X"
    this.loadRecommendations(); // Fetch cross-sell products on page load
  }

  // ---------------------------------------------------------------------------
  // DOM CACHING
  // ---------------------------------------------------------------------------

  /**
   * Re-queries all interactive elements from the DOM.
   * Called in constructor and can be called after section re-render if needed.
   */
  cacheElements() {
    /** @type {NodeListOf<HTMLButtonElement>} */
    this.swatchButtons = this.root.querySelectorAll('[data-swatch]');
    /** @type {NodeListOf<HTMLElement>} */
    this.outlineItems = this.root.querySelectorAll('[data-outline-item]');
    /** @type {NodeListOf<HTMLElement>} */
    this.counterElements = this.root.querySelectorAll('[data-counter-current]');
    /** @type {NodeListOf<HTMLElement>} */
    this.counterContainers = this.root.querySelectorAll('[data-bundle-counter], [data-counter-caption]');
    /** @type {HTMLButtonElement | null} */
    this.addToCartButton = this.root.querySelector('[data-add-to-cart]');
    /** @type {NodeListOf<HTMLButtonElement>} */
    this.ctaButtons = this.root.querySelectorAll('[data-add-to-cart], [data-receive-gift]');
    /** @type {HTMLElement | null} */
    this.addToCartText = this.root.querySelector('.bundle-page__add-to-cart-text');
    /** @type {HTMLElement | null} */
    this.crossSellSection = this.root.querySelector('[data-cross-sell]');
    /** @type {HTMLElement | null} */
    this.crossSellGrid = this.root.querySelector('[data-cross-sell-grid]');
  }

  // ---------------------------------------------------------------------------
  // EVENT BINDING
  // ---------------------------------------------------------------------------

  /**
   * Attaches click handlers to all swatch buttons and the add-to-cart button.
   * Swatch clicks trigger color selection; add-to-cart triggers cart submission.
   */
  bindEvents() {
    this.swatchButtons.forEach((button) => {
      button.addEventListener('click', (event) => this.onSwatchClick(/** @type {MouseEvent} */ (event)));
    });

    if (this.addToCartButton) {
      this.addToCartButton.addEventListener('click', (event) => this.onAddToCart(/** @type {MouseEvent} */ (event)));
    }
  }

  // ---------------------------------------------------------------------------
  // SWATCH SELECTION
  // ---------------------------------------------------------------------------

  /**
   * Handles a color swatch click. This is the main interaction flow:
   * 1. Reads all data attributes from the clicked swatch button
   * 2. Marks the swatch as selected (deselects previous in same picker)
   * 3. Records the selection in the selections Map
   * 4. Triggers outline image update (loading state → resolved image)
   * 5. Updates the counter and clears any validation errors
   *
   * Image resolution strategy:
   * - First tries data-variant-image from the swatch (pre-set in Liquid)
   * - Falls back to fetching /products/{handle}.js and finding the variant image
   *
   * @param {MouseEvent} event
   */
  onSwatchClick(event) {
    const button = /** @type {HTMLButtonElement | null} */ (event.currentTarget);
    if (!button || button.disabled) return;

    // Read all swatch data from the button's data attributes (set by Liquid)
    const pickerIndex = button.dataset.pickerIndex || '';
    const productId = button.dataset.productId || '';
    const productHandle = button.dataset.productHandle || '';
    const variantId = button.dataset.variantId || '';
    const colorName = button.dataset.colorName || '';
    const colorHex = button.dataset.colorHex || '';
    const isSpecial = button.dataset.isSpecial === 'true';
    const variantImageUrl = button.dataset.variantImage || '';
    const currentSelection = this.selections.get(productId);

    // Skip if already selected (prevents redundant outline updates)
    if (button.classList.contains('bundle-page__swatch--selected')) return;
    if (currentSelection?.variantId === variantId && currentSelection?.colorName === colorName) return;

    // Update UI and state
    this.markSwatchSelected(pickerIndex, button);
    this.recordSelection(productId, variantId, colorName, colorHex, productHandle, pickerIndex, isSpecial);
    this.startOutlineLoading(productId, colorName); // Show loading spinner on outline

    // Resolve variant image — prefer pre-set URL, fall back to API fetch
    if (variantImageUrl) {
      // Fast path: image URL already available from Liquid template
      const sizedUrl = this.getSizedImageUrl(variantImageUrl);
      const selection = this.selections.get(productId);
      if (selection) selection.variantImage = sizedUrl;
      this.refreshOutline(productId, colorName, sizedUrl);
    } else {
      // Slow path: fetch product JSON to find variant's featured image
      this.resolveVariantImage(productId, variantId, colorName)
        .then((imageUrl) => {
          const selection = this.selections.get(productId);
          if (selection) selection.variantImage = imageUrl;
          this.refreshOutline(productId, colorName, imageUrl);
        })
        .catch(() => this.refreshOutline(productId, colorName, null));
    }

    this.clearValidationError();
    this.updateCounter();
  }

  // ---------------------------------------------------------------------------
  // OUTLINE COMPOSITION UPDATES
  // ---------------------------------------------------------------------------

  /**
   * Sets the outline item into a loading state — shows spinner overlay and
   * updates the color name label immediately (before image resolves).
   *
   * @param {string} productId - Which constituent product's outline to update
   * @param {string} colorName - Color name to display under the outline
   */
  startOutlineLoading(productId, colorName) {
    const item = /** @type {HTMLElement | null} */ (
      this.root.querySelector(`[data-outline-item][data-product-id="${productId}"]`)
    );
    if (!item) return;

    // Update label immediately so user sees feedback even before image loads
    const colorNameEl = /** @type {HTMLElement | null} */ (item.querySelector('[data-color-name]'));
    if (colorNameEl) colorNameEl.textContent = colorName;

    // CSS loading state: shows spinner pseudo-element and blurs current image
    item.classList.add('bundle-outline__item--loading');
    item.setAttribute('aria-busy', 'true');
  }

  /**
   * Visually marks one swatch as selected within a picker group.
   * Deselects all other swatches in the same picker first.
   *
   * @param {string} pickerIndex - Identifies which picker group
   * @param {HTMLElement} selectedButton - The swatch button to mark as selected
   */
  markSwatchSelected(pickerIndex, selectedButton) {
    // Remove selected state from all swatches in this picker
    const pickerSwatches = this.root.querySelectorAll(`[data-picker-index="${pickerIndex}"]`);
    pickerSwatches.forEach((swatch) => swatch.classList.remove('bundle-page__swatch--selected'));
    // Add selected state to clicked swatch
    selectedButton.classList.add('bundle-page__swatch--selected');
  }

  /**
   * Stores a color selection in the selections Map, keyed by product ID.
   * Each product can only have one selection — re-selecting overwrites.
   *
   * @param {string} productId
   * @param {string} variantId
   * @param {string} colorName
   * @param {string} colorHex
   * @param {string} productHandle
   * @param {string} pickerIndex
   * @param {boolean} isSpecial
   */
  recordSelection(productId, variantId, colorName, colorHex, productHandle, pickerIndex, isSpecial) {
    this.selections.set(productId, {
      variantId,
      colorName,
      colorHex,
      productHandle,
      pickerIndex: parseInt(pickerIndex, 10),
      isSpecial,
    });
  }

  /**
   * Returns selections sorted by picker index (matching constituent_items order).
   * This ensures cart line items appear in the same order as the bundle composition,
   * regardless of the order the user clicked swatches.
   *
   * @returns {BundleSelection[]}
   */
  getSelectionsInBundleOrder() {
    return Array.from(this.selections.values()).sort((selectionA, selectionB) => {
      const indexA = Number.isFinite(selectionA.pickerIndex) ? selectionA.pickerIndex : Number.MAX_SAFE_INTEGER;
      const indexB = Number.isFinite(selectionB.pickerIndex) ? selectionB.pickerIndex : Number.MAX_SAFE_INTEGER;
      return indexA - indexB;
    });
  }

  // ---------------------------------------------------------------------------
  // VARIANT IMAGE RESOLUTION
  // ---------------------------------------------------------------------------

  /**
   * Fetches the variant's featured image URL from Shopify's product JSON API.
   * Uses a product cache to avoid redundant network requests when the user
   * switches between colors on the same product.
   *
   * Resolution strategy:
   * 1. Exact match by variant ID (most reliable)
   * 2. Title match by color name (fallback for edge cases)
   *
   * @param {string} productId
   * @param {string} variantId
   * @param {string} colorName
   * @returns {Promise<string | null>} Sized image URL or null if not found
   */
  async resolveVariantImage(productId, variantId, colorName) {
    const handle = this.selections.get(productId)?.productHandle || this.findProductHandle(productId);
    if (!handle) return null;

    try {
      // Check cache first to avoid redundant fetches
      let product = this.productCache.get(handle);
      if (!product) {
        const response = await fetch(`/products/${handle}.js`);
        if (!response.ok) return null;
        product = /** @type {{ variants: Array<{ id: number, title: string, featured_image?: { src?: string } }> }} */ (
          await response.json()
        );
        this.productCache.set(handle, product);
      }

      if (!product) return null;

      // Strategy 1: exact match by variant ID
      const exactMatch = product.variants.find(
        /** @param {{ id: number, featured_image?: { src?: string } }} variant */
        (variant) => variant.id.toString() === variantId,
      );
      if (exactMatch?.featured_image?.src) {
        return this.getSizedImageUrl(exactMatch.featured_image.src);
      }

      // Strategy 2: fuzzy match by color name in variant title
      const titleMatch = product.variants.find(
        /** @param {{ title: string, featured_image?: { src?: string } }} variant */
        (variant) => variant.title.toLowerCase().includes(colorName.toLowerCase()),
      );
      return titleMatch?.featured_image?.src
        ? this.getSizedImageUrl(titleMatch.featured_image.src)
        : null;
    } catch {
      return null;
    }
  }

  /**
   * Appends or replaces the width parameter on a Shopify CDN image URL.
   * Used to request appropriately sized images for the outline composition
   * (300px wide by default) instead of full-resolution images.
   *
   * @param {string} src - Original image URL
   * @returns {string} URL with width parameter set to outlineImageWidth
   */
  getSizedImageUrl(src) {
    if (!src) return src;

    try {
      const imageUrl = new URL(src, window.location.origin);
      imageUrl.searchParams.set('width', String(this.outlineImageWidth));
      return imageUrl.toString();
    } catch {
      // Fallback for URLs that can't be parsed (shouldn't happen with Shopify CDN)
      if (src.includes('?')) {
        if (src.includes('width=')) {
          return src.replace(/width=\d+/g, `width=${this.outlineImageWidth}`);
        }

        return `${src}&width=${this.outlineImageWidth}`;
      }

      return `${src}?width=${this.outlineImageWidth}`;
    }
  }

  /**
   * Looks up a product's handle from its outline DOM element.
   * Used as fallback when the handle isn't in the selections Map yet.
   *
   * @param {string} productId
   * @returns {string} Product handle or empty string
   */
  findProductHandle(productId) {
    const item = /** @type {HTMLElement | null} */ (
      this.root.querySelector(`[data-outline-item][data-product-id="${productId}"]`)
    );
    return item?.dataset.productHandle || '';
  }

  // ---------------------------------------------------------------------------
  // IMAGE PRELOADING & ANIMATION HELPERS
  // ---------------------------------------------------------------------------

  /**
   * Preloads an image by creating a detached Image element and waiting for
   * it to load. This ensures the browser has the image in cache before we
   * swap it into the outline, preventing a flash of broken/loading state.
   *
   * @param {string | null} src - Image URL to preload
   * @returns {Promise<string | null>} Resolves with the URL when loaded
   */
  preloadImage(src) {
    return new Promise((resolve, reject) => {
      if (!src) {
        resolve(null);
        return;
      }

      const image = new Image();
      image.decoding = 'async';
      image.onload = () => resolve(src);
      image.onerror = reject;
      image.src = src;

      // Handle already-cached images (synchronous completion)
      if (image.complete) {
        resolve(src);
      }
    });
  }

  /**
   * Simple promise-based delay. Used to add a brief pause before showing
   * the filled outline state (gives the loading animation time to be visible).
   *
   * @param {number} duration - Milliseconds to wait
   * @returns {Promise<void>}
   */
  wait(duration) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, duration);
    });
  }

  /**
   * Updates an outline item with the resolved variant image. Handles the full
   * transition: loading → preload → reveal with CSS animation.
   *
   * Flow:
   * 1. Updates color name label and special edition badge visibility
   * 2. If no image URL, clears the outline back to its default state
   * 3. If same image already shown, just updates the alt text (no re-animate)
   * 4. Preloads image, then uses double-rAF to trigger CSS transition
   * 5. Sets --filled class which cross-fades outline → variant image via CSS
   *
   * Race condition handling: uses pendingImage to ensure only the latest
   * selection's image is applied (ignores stale responses from earlier clicks).
   *
   * @param {string} productId - Which constituent product's outline to update
   * @param {string} colorName - Color name for alt text and label
   * @param {string | null} imageUrl - Resolved variant image URL (null = no image)
   * @returns {Promise<void>}
   */
  async refreshOutline(productId, colorName, imageUrl) {
    const item = /** @type {HTMLElement | null} */ (
      this.root.querySelector(`[data-outline-item][data-product-id="${productId}"]`)
    );
    if (!item) return;

    const colorImage = /** @type {HTMLImageElement | null} */ (item.querySelector('[data-color-image]'));
    const colorNameEl = /** @type {HTMLElement | null} */ (item.querySelector('[data-color-name]'));
    const specialBadge = /** @type {HTMLElement | null} */ (item.querySelector('[data-special-badge]'));
    const selection = this.selections.get(productId);

    // Always update label text
    if (colorNameEl) colorNameEl.textContent = colorName;

    // Show/hide "LE" badge based on whether this is a special edition color
    if (specialBadge && selection) {
      specialBadge.style.display = selection.isSpecial ? 'inline-flex' : 'none';
    }

    if (!colorImage) return;

    // No image available — reset outline to default (show outline/placeholder)
    if (!imageUrl) {
      item.classList.remove('bundle-outline__item--loading', 'bundle-outline__item--filled');
      item.removeAttribute('aria-busy');
      colorImage.style.display = 'none';
      colorImage.removeAttribute('src');
      return;
    }

    // Same image already displayed — just update alt text, skip re-animation
    if (item.dataset.currentImage === imageUrl && item.classList.contains('bundle-outline__item--filled')) {
      colorImage.alt = colorName;
      return;
    }

    // Track pending image for race condition prevention
    item.dataset.pendingImage = imageUrl;

    try {
      const hadFilledImage = item.classList.contains('bundle-outline__item--filled') && !!item.dataset.currentImage;
      const preloaded = await this.preloadImage(imageUrl);

      // Race condition check: if user clicked another color while this was loading,
      // the pendingImage will have changed — abort this update
      if (item.dataset.pendingImage !== imageUrl) return;

      // Set the image source and make it visible
      colorImage.src = imageUrl;
      colorImage.alt = colorName;
      colorImage.style.display = 'block';

      // Brief delay before revealing (only for first fill, not color swaps)
      // Gives the loading spinner enough time to be visible to the user
      if (!hadFilledImage) {
        await this.wait(180);
      }

      // Double requestAnimationFrame ensures CSS transition triggers properly
      // (first rAF: browser processes style, second rAF: applies class change)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          item.classList.add('bundle-outline__item--filled');
          item.classList.remove('bundle-outline__item--loading');
          item.dataset.currentImage = preloaded || imageUrl;
          item.removeAttribute('aria-busy');
        });
      });
    } catch {
      // Image failed to load — just remove loading state, keep outline visible
      item.classList.remove('bundle-outline__item--loading');
      item.removeAttribute('aria-busy');
    }
  }

  // ---------------------------------------------------------------------------
  // COUNTER & VALIDATION
  // ---------------------------------------------------------------------------

  /**
   * Updates all counter display elements with the current selection count.
   * Called after every swatch click, add-to-cart, and reset.
   */
  updateCounter() {
    const currentCount = this.selections.size;
    this.counterElements.forEach((el) => {
      el.textContent = String(currentCount);
    });

    const isComplete = currentCount >= this.itemCount;
    this.ctaButtons.forEach((button) => {
      button.disabled = !isComplete;
    });

    // Counter stays red for as long as the selection is incomplete — not just
    // after a failed submit attempt, since the CTA button above is disabled
    // until complete and can never be clicked to trigger that path.
    if (isComplete) {
      this.clearValidationError();
    } else {
      this.setValidationError();
    }
  }

  /** Removes error styling (red text) from all counter elements */
  clearValidationError() {
    this.counterContainers.forEach((container) => {
      container.classList.remove(
        'bundle-page__counter--error',
        'bundle-page__counter-caption--error',
        'gift-recipient__counter--error',
        'gift-recipient__cta-counter--error',
      );
    });
  }

  /** Adds error styling (red text) to all counter elements to indicate incomplete selection */
  setValidationError() {
    this.counterContainers.forEach((container) => {
      container.classList.add(
        'bundle-page__counter--error',
        'bundle-page__counter-caption--error',
        'gift-recipient__counter--error',
        'gift-recipient__cta-counter--error',
      );
    });
  }

  // ---------------------------------------------------------------------------
  // ADD TO CART
  // ---------------------------------------------------------------------------

  /**
   * Handles the "Add to cart" button click. Validates that all constituent
   * products have a color selected, then submits to cart.
   *
   * @param {MouseEvent} event
   * @returns {Promise<void>}
   */
  async onAddToCart(event) {
    event.preventDefault();

    // Validate: all constituent items must have a color selected
    if (this.selections.size < this.itemCount) {
      this.setValidationError(); // Highlight counter in red
      return;
    }

    this.clearValidationError();
    if (!this.addToCartButton) return;
    this.addToCartButton.disabled = true; // Prevent double-submission

    try {
      await this.submitCartItems();
    } catch (error) {
      const fallbackMessage = this.addToCartButton.dataset.errorText || 'Unable to add items. Please try again.';
      const message = error instanceof Error ? error.message : fallbackMessage;
      this.showAddToCartError(message);
    } finally {
      this.updateCounter(); // Re-derives disabled state from current selection count
    }
  }

  /**
   * Submits selected bundle items to the Shopify cart via /cart/add.js.
   *
   * Bundle architecture: each constituent product is added as a SEPARATE line
   * item (not a single wrapper SKU). Line items are linked by a shared
   * _bundle_tag property formatted as "ProductTitle:ProductId".
   *
   * The "Bundle" property (without underscore) is visible to the customer
   * in the cart and shows which bundle the item belongs to.
   * The "_bundle_tag" property (with underscore) is hidden from the customer
   * and used internally for cart grouping logic.
   *
   * Items are reversed before submission so they appear in the correct order
   * in the cart (Shopify adds items in LIFO order).
   *
   * After successful submission:
   * 1. Fetches updated cart state
   * 2. Dispatches CartAddEvent for the theme's cart drawer to open
   * 3. Shows success message on button
   * 4. Resets all selections (clears swatches, outlines, counter)
   *
   * @returns {Promise<unknown>}
   */
  async submitCartItems() {
    /** @type {{ id: number, quantity: number, properties: { Bundle: string, _bundle_tag: string } }[]} */
    let items = [];

    // Sort selections to match the constituent_items display order
    const orderedSelections = this.getSelectionsInBundleOrder();

    orderedSelections.forEach((selection) => {
      if (!selection.variantId) return;
      items.push({
        id: parseInt(selection.variantId, 10),
        quantity: 1,
        properties: {
          Bundle: this.productTitle, // Visible to customer in cart
          _bundle_tag: `${this.productTitle}:${this.productId}`, // Hidden, for internal grouping
        },
      });
    });

    if (items.length === 0) throw new Error('No items to add');

    // Reverse so items appear in correct order in cart (Shopify LIFO behavior)
    items = items.reverse();

    const response = await fetch('/cart/add.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.description || 'Add to cart failed');
    }

    const result = await response.json();

    // Fetch full cart state for the CartAddEvent (cart drawer needs item_count)
    const cart = await this.fetchCart();

    // Dispatch theme event so cart drawer opens and updates its UI
    document.dispatchEvent(
      new CartAddEvent(cart || result, 'bundle-configurator', {
        source: 'bundle-configurator',
        itemCount: cart?.item_count ?? items.length,
      }),
    );

    this.showAddToCartSuccess();
    this.resetSelections(); // Clear all selections for next bundle configuration
    return result;
  }

  // ---------------------------------------------------------------------------
  // RESET & POST-CART CLEANUP
  // ---------------------------------------------------------------------------

  /**
   * Resets all bundle selections to their initial state. Called after
   * successful add-to-cart so the user can configure another bundle.
   *
   * Clears:
   * - selections Map
   * - swatch selected states
   * - outline images (back to outline/placeholder)
   * - color name labels
   * - special edition badges
   * - counter display
   */
  resetSelections() {
    this.selections.clear();
    this.clearValidationError();

    // Deselect all swatch buttons
    this.swatchButtons.forEach((button) => {
      button.classList.remove('bundle-page__swatch--selected');
    });

    // Reset all outline items to their default state
    this.outlineItems.forEach((item) => {
      item.classList.remove('bundle-outline__item--filled', 'bundle-outline__item--loading');
      item.removeAttribute('aria-busy');
      delete item.dataset.currentImage;
      delete item.dataset.pendingImage;

      // Hide the color variant image, show outline/placeholder again
      const colorImage = /** @type {HTMLImageElement | null} */ (item.querySelector('[data-color-image]'));
      if (colorImage) {
        colorImage.style.display = 'none';
        colorImage.removeAttribute('src');
        colorImage.alt = '';
      }

      // Clear color name label
      const colorNameEl = /** @type {HTMLElement | null} */ (item.querySelector('[data-color-name]'));
      if (colorNameEl) colorNameEl.textContent = '';

      // Hide special edition badge
      const specialBadge = /** @type {HTMLElement | null} */ (item.querySelector('[data-special-badge]'));
      if (specialBadge) specialBadge.style.display = 'none';
    });

    this.updateCounter();
  }

  // ---------------------------------------------------------------------------
  // CART API
  // ---------------------------------------------------------------------------

  /**
   * Fetches the current cart state from /cart.js.
   * Used after add-to-cart to get updated item_count for the CartAddEvent.
   *
   * @returns {Promise<{ item_count?: number, items?: unknown[] } | null>}
   */
  async fetchCart() {
    try {
      const response = await fetch('/cart.js');
      if (!response.ok) return null;

      return await response.json();
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // BUTTON FEEDBACK (SUCCESS / ERROR MESSAGES)
  // ---------------------------------------------------------------------------

  /**
   * Plays the checkmark-burst success animation on the add-to-cart button,
   * matching the standard PDP. The animation is entirely CSS-driven (see
   * assets/base.css), keyed off the `data-added="true"` attribute: the cart
   * icon + label slide out and the checkmark/ring/burst slides in. The
   * attribute is removed after the animation has played so the button returns
   * to its default "Add to cart" state, ready for the next bundle.
   */
  showAddToCartSuccess() {
    const button = this.addToCartButton;
    if (!button) return;

    if (button.dataset.added !== 'true') {
      button.dataset.added = 'true';
    }

    if (this._addedResetTimeout) clearTimeout(this._addedResetTimeout);
    this._addedResetTimeout = setTimeout(() => {
      button.removeAttribute('data-added');
    }, 1500);
  }

  /**
   * Temporarily shows an error message on the button for 3 seconds,
   * then reverts to the original text. Error gets slightly longer display
   * time than success so user can read the message.
   *
   * @param {string} message - Error message to display
   */
  showAddToCartError(message) {
    const originalText = this.addToCartText?.textContent;
    if (this.addToCartText) this.addToCartText.textContent = message;
    setTimeout(() => {
      if (this.addToCartText && originalText) this.addToCartText.textContent = originalText;
    }, 3000);
  }

  // ---------------------------------------------------------------------------
  // UTILITY METHODS
  // ---------------------------------------------------------------------------

  /**
   * Escapes HTML special characters to prevent XSS when injecting
   * recommendation data into innerHTML. Used by renderRecommendations().
   *
   * @param {string} value
   * @returns {string} HTML-safe string
   */
  escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Formats a price in cents to a localized currency string.
   * Uses Intl.NumberFormat for locale-aware formatting with the store's
   * currency code (from data-currency-code attribute).
   *
   * @param {number} cents - Price in cents (Shopify's native format)
   * @returns {string} Formatted price string (e.g., "$50.00")
   */
  formatRecommendationPrice(cents) {
    const currencyCode = this.root.dataset.currencyCode || 'USD';
    const numericPrice = Number(cents) / 100;

    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: currencyCode,
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }).format(numericPrice);
    } catch {
      // Fallback for browsers that don't support the currency
      return `$${numericPrice.toFixed(2)}`;
    }
  }

  // ---------------------------------------------------------------------------
  // CROSS-SELL RECOMMENDATIONS — "Also made by None Better"
  // ---------------------------------------------------------------------------

  /**
   * Renders cross-sell product cards into the grid.
   *
   * Cards show: product image, name, price, and variant swatches.
   * Each card links to its product page. On mobile, cards display
   * in a horizontal carousel with prev/next arrows.
   *
   * @param {{ title?: string, url?: string, handle?: string, price?: number, price_min?: number, featured_image?: string }[]} products
   */
  renderRecommendations(products) {
    if (!this.crossSellSection || !this.crossSellGrid) return;

    // No products — hide the entire cross-sell section
    if (!products.length) {
      this.crossSellSection.classList.add('hidden');
      this.crossSellGrid.innerHTML = '';
      return;
    }

    // Build and inject card HTML
    this.crossSellSection.classList.remove('hidden');
    this.crossSellGrid.innerHTML = products
      .map((product) => {
        const title = this.escapeHtml(product.title || '');
        const url = this.escapeHtml(product.url || '#');
        const handle = this.escapeHtml(product.handle || '');
        const price = this.formatRecommendationPrice(product.price ?? product.price_min ?? 0);
        const image = product.featured_image || (product.images && product.images[0]) || '';
        const imageSrc = typeof image === 'string' ? image : image.src || '';
        const imageMarkup = imageSrc
          ? `<img class="bundle-page__cross-sell-image" src="${this.escapeHtml(imageSrc)}" alt="${title}" loading="lazy" width="80" height="80">`
          : '';

        return `
          <a href="${url}" class="bundle-page__cross-sell-card" data-cross-sell-handle="${handle}">
            ${imageMarkup}
            <span class="bundle-page__cross-sell-info">
              <span class="bundle-page__cross-sell-name">${title}</span>
              <span class="bundle-page__cross-sell-price">${price}</span>
            </span>
            <span class="bundle-page__cross-sell-swatches" data-cross-sell-swatches></span>
          </a>
        `;
      })
      .join('');

    // Bind mobile carousel arrow buttons
    this.bindCrossSellArrows();

    // Fetch variant data and render swatches for each product
    this.loadCrossSellSwatches(products);
  }

  /**
   * Max visible swatches before showing "+X" overflow on desktop/mobile.
   */
  static CROSS_SELL_MAX_SWATCHES_DESKTOP = 4;
  static CROSS_SELL_MAX_SWATCHES_MOBILE = 3;

  /**
   * Fetches full product data for each cross-sell product and renders
   * variant image swatches below the price. Shows first N swatches
   * with a "+X" indicator for overflow.
   *
   * @param {{ handle?: string }[]} products
   */
  async loadCrossSellSwatches(products) {
    const handles = products
      .map((p) => p.handle)
      .filter(Boolean);

    // Fetch all products in parallel
    const productDataList = await Promise.all(
      handles.map(async (handle) => {
        try {
          let cached = this.productCache.get(handle);
          if (!cached) {
            const res = await fetch(`/products/${handle}.js`);
            if (!res.ok) return null;
            cached = await res.json();
            this.productCache.set(handle, cached);
          }
          return { handle, data: cached };
        } catch {
          return null;
        }
      })
    );

    // Render swatches for each card
    for (const entry of productDataList) {
      if (!entry) continue;
      const { handle, data } = entry;
      const card = this.crossSellGrid.querySelector(`[data-cross-sell-handle="${handle}"]`);
      if (!card) continue;

      const swatchContainer = card.querySelector('[data-cross-sell-swatches]');
      if (!swatchContainer) continue;

      // Get unique color variants (deduplicate by option1 which is typically Color)
      const seenOptions = new Set();
      const variantsWithImages = (data.variants || []).filter((v) => {
        const key = v.option1 || v.featured_image?.src;
        if (!key || seenOptions.has(key)) return false;
        seenOptions.add(key);
        return true;
      });

      if (variantsWithImages.length <= 1) continue; // No point showing swatches for single-variant products

      const maxVisible = window.innerWidth < 750
        ? BundleConfigurator.CROSS_SELL_MAX_SWATCHES_MOBILE
        : BundleConfigurator.CROSS_SELL_MAX_SWATCHES_DESKTOP;

      const visible = variantsWithImages.slice(0, maxVisible);
      const overflow = variantsWithImages.length - maxVisible;

      const swatchesHtml = visible
        .map((v) => {
          const imgSrc = this.escapeHtml(v.featured_image?.src || '');
          const variantTitle = this.escapeHtml(v.option1 || v.title || '');

          if (!imgSrc) {
            // Variant without an image — render a color dot placeholder
            return `<span
              class="bundle-page__cross-sell-swatch bundle-page__cross-sell-swatch--no-image"
              title="${variantTitle}"
              aria-label="${variantTitle}"
            ></span>`;
          }

          const thumbSrc = imgSrc.includes('?')
            ? `${imgSrc}&width=96`
            : `${imgSrc}?width=96`;
          return `<button
            type="button"
            class="bundle-page__cross-sell-swatch"
            data-cross-sell-variant-image="${imgSrc}"
            title="${variantTitle}"
            aria-label="${variantTitle}"
          ><img src="${thumbSrc}" alt="${variantTitle}" loading="lazy" width="32" height="32"></button>`;
        })
        .join('');

      const overflowHtml = overflow > 0
        ? `<span class="bundle-page__cross-sell-swatch-overflow">+${overflow}</span>`
        : '';

      swatchContainer.innerHTML = swatchesHtml + overflowHtml;

      // Bind swatch click — swap card image, prevent link navigation
      swatchContainer.querySelectorAll('[data-cross-sell-variant-image]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const newSrc = btn.dataset.crossSellVariantImage;
          const cardImage = card.querySelector('.bundle-page__cross-sell-image');
          if (cardImage && newSrc) {
            cardImage.src = newSrc;
          }
          // Mark active swatch
          swatchContainer.querySelectorAll('.bundle-page__cross-sell-swatch').forEach((s) =>
            s.classList.remove('bundle-page__cross-sell-swatch--active')
          );
          btn.classList.add('bundle-page__cross-sell-swatch--active');
        });
      });
    }
  }

  /**
   * Binds click handlers for mobile cross-sell carousel arrows.
   * Scrolls the grid container by one card width on each click.
   * Hides prev arrow at start, next arrow at end.
   */
  bindCrossSellArrows() {
    const prevBtn = this.root.querySelector('[data-cross-sell-prev]');
    const nextBtn = this.root.querySelector('[data-cross-sell-next]');
    if (!prevBtn || !nextBtn || !this.crossSellGrid) return;

    const grid = this.crossSellGrid;

    const updateArrowVisibility = () => {
      const atStart = grid.scrollLeft <= 1;
      const atEnd = grid.scrollLeft + grid.offsetWidth >= grid.scrollWidth - 1;
      prevBtn.style.visibility = atStart ? 'hidden' : 'visible';
      nextBtn.style.visibility = atEnd ? 'hidden' : 'visible';
    };

    const scrollByCard = (direction) => {
      const card = grid.querySelector('.bundle-page__cross-sell-card');
      if (!card) return;
      grid.scrollBy({ left: card.offsetWidth * direction, behavior: 'smooth' });
    };

    prevBtn.addEventListener('click', () => scrollByCard(-1));
    nextBtn.addEventListener('click', () => scrollByCard(1));
    grid.addEventListener('scroll', updateArrowVisibility, { passive: true });

    // Set initial state
    updateArrowVisibility();
  }

  /**
   * Fetches product recommendations from Shopify's Product Recommendations API.
   * Called once on page load during constructor initialization.
   *
   * API endpoint: /recommendations/products.json
   * Parameters:
   * - product_id: current bundle product's Shopify ID
   * - intent: 'related' or 'complementary' (from section settings)
   * - limit: max products to return (from section settings, default 3)
   *
   * The recommendations are configured in Shopify admin under
   * Search & Discovery > Product Recommendations.
   *
   * On success: calls renderRecommendations() to inject cards
   * On failure: hides the cross-sell section entirely (graceful degradation)
   */
  async loadRecommendations() {
    if (!this.crossSellSection || !this.crossSellGrid) return;

    const baseUrl = this.root.dataset.recommendationsUrl;
    const productId = this.productId;
    const intent = this.root.dataset.recommendationIntent || 'complementary';
    const limit = this.root.dataset.recommendationLimit || '3';

    // No URL or product ID — can't fetch, hide section
    if (!baseUrl || !productId) {
      this.crossSellSection.classList.add('hidden');
      return;
    }

    try {
      const url = new URL(baseUrl, window.location.origin);
      url.searchParams.set('product_id', productId);
      url.searchParams.set('intent', intent);
      url.searchParams.set('limit', limit);

      const response = await fetch(url.toString());
      if (!response.ok) throw new Error(`Server returned ${response.status}`);

      const payload = await response.json();
      const products = Array.isArray(payload.products) ? payload.products : [];
      this.renderRecommendations(products);
    } catch {
      // Graceful degradation: hide cross-sell on any error
      this.crossSellSection.classList.add('hidden');
      this.crossSellGrid.innerHTML = '';
    }
  }
}

export default BundleConfigurator;
