/**
 * Gift Review controller (M7 / Build Guide Page 6).
 *
 * Drives the gift review page:
 * - Reads gift state from sessionStorage (`nb_gift_state`) and URL params per
 *   the locked state contract in
 *   docs/decisions/gift-checkout-state-and-timezone.md, merging with URL
 *   params winning on conflict.
 * - Redirects to the gifts-and-bundles collection if no bundle state is
 *   present — this page never renders blank.
 * - Renders the bundle summary, TO / FROM / NOTE / SENDING rows, and total
 *   from that state.
 * - Every Edit link routes back to Gift Checkout with the full current state
 *   in the URL (route param `bundle=`, per the state contract) so editing one
 *   field never wipes the rest.
 * - Cancel discards state and returns to the bundle product page. No Klaviyo
 *   event fires.
 * - Send the gift clears the cart, adds the bundle's own variant via Ajax
 *   `/cart/add.js` (JSON body — required so plus-addresses in line-item
 *   properties are not corrupted), then redirects to `/checkout` with the
 *   gifter's email/name mirrored as `checkout[email]` /
 *   `checkout[billing_address]` query params so the gifter — who is paying —
 *   doesn't retype what they already gave us on Gift Checkout. The order
 *   line item is the bundle product itself (e.g. "The Pair"), with a
 *   customer-visible `Gift: "Yes"` property plus recipient/gifter details as
 *   underscore-prefixed line item properties. See
 *   docs/decisions/gift-review-checkout-mechanism.md for the full mechanism
 *   — including what still fires the Gift Purchased Klaviyo event and tags
 *   the order downstream of checkout, which this page cannot do on its own.
 */

const STATE_KEY = 'nb_gift_state';

/**
 * Row name -> the section label on Gift Checkout an Edit link should scroll
 * to. Anchoring on the label (rather than the first field) keeps the landing
 * view consistent across rows — every Edit always surfaces the section
 * heading, not just a field cropped at the top of the viewport.
 */
const ROW_EDIT_TARGETS = {
  to: 'GiftToLabel',
  from: 'GiftFromLabel',
  note: 'GiftNoteLabel',
  sending: 'GiftSendLabel',
};

/** Keys read from sessionStorage / URL. Must match gift-checkout.js exactly. */
const STATE_FIELDS = [
  'bundle_slug',
  'bundle_product_id',
  'recipient_name',
  'recipient_email',
  'gifter_name',
  'gifter_email',
  'buyer_note',
  'send_type',
  'send_date',
  'send_timezone',
  'newsletter_opt_in',
];

export class GiftReviewController {
  /** @param {HTMLElement} el - the <gift-review> custom element */
  constructor(el) {
    this.el = el;
    this.checkoutUrl = el.dataset.checkoutUrl || '/pages/gift-checkout';
    this.collectionUrl = el.dataset.collectionUrl || '/collections/gifts-and-bundles';

    this.summaryEl = el.querySelector('[data-summary]');
    this.rowsEl = el.querySelector('[data-rows]');
    this.submitButton = el.querySelector('[data-submit]');
    this.submitError = el.querySelector('[data-submit-error]');
    this.cancelLink = el.querySelector('[data-cancel]');

    /** @type {Record<string, unknown> | null} */
    this.state = null;
    /** @type {Record<string, unknown> | null} */
    this.bundle = null;

    this.#init();
  }

  /* ---------------------------------------------------------------- *
   * Init
   * ---------------------------------------------------------------- */

  #init() {
    const saved = this.#readSessionState();
    const state = this.#readMergedState();

    // Legit arrivals here (Checkout submit, an Edit round-trip) always carry
    // the gifter/recipient details in sessionStorage — the URL only ever
    // mirrors `bundle_slug`/`edit_field`. Someone opening this URL directly
    // (shared link, bookmark, no Checkout session behind it) has no saved
    // state even though `bundle_slug` reads fine off the URL, so check
    // sessionStorage specifically rather than the merged state.
    const hasBundle = Boolean(state.bundle_slug || state.bundle);
    const hasSavedState = Boolean(saved.recipient_email && saved.gifter_email);

    if (!hasBundle || !hasSavedState) {
      // No gift state to review — never render a blank/broken page.
      window.location.replace(this.collectionUrl);
      return;
    }

    this.state = state;

    const bundle = this.#resolveBundle(state);
    if (!bundle) {
      window.location.replace(this.collectionUrl);
      return;
    }
    this.bundle = bundle;

    this.#renderSummary(bundle);
    this.#renderRows(state);
    this.#renderTotal(bundle);
    this.#wireEditLinks(state, bundle);
    this.#wireCancel(bundle);
    this.#wireSubmit(state, bundle);
    this.#scrollToEditedRow();

    if (!bundle.available || !bundle.variantId) {
      this.#disableSubmit(this.el.dataset.errorUnavailable || '');
    }
  }

  /* ---------------------------------------------------------------- *
   * State read (sessionStorage -> URL, URL wins)
   * ---------------------------------------------------------------- */

  /** @returns {Record<string, string>} */
  #readMergedState() {
    const saved = this.#readSessionState();
    const url = this.#readUrlState();
    return { ...saved, ...url };
  }

  /** @returns {Record<string, string>} */
  #readSessionState() {
    try {
      return JSON.parse(sessionStorage.getItem(STATE_KEY) || '{}') || {};
    } catch {
      return {};
    }
  }

  /** @returns {Record<string, string>} */
  #readUrlState() {
    const params = new URLSearchParams(window.location.search);
    /** @type {Record<string, string>} */
    const out = {};
    STATE_FIELDS.forEach((key) => {
      const value = params.get(key);
      if (value != null) out[key] = value;
    });
    // 'bundle' is the M6 Edit-link route param — accept it as a bundle_slug alias.
    const bundleParam = params.get('bundle');
    if (bundleParam != null) out.bundle = bundleParam;
    return out;
  }

  /* ---------------------------------------------------------------- *
   * Bundle resolution
   * ---------------------------------------------------------------- */

  /**
   * @param {Record<string, unknown>} state
   * @returns {Record<string, unknown> | null}
   */
  #resolveBundle(state) {
    const dataEl = this.el.querySelector('[data-bundles]');
    if (!dataEl) return null;

    let bundles = [];
    try {
      bundles = JSON.parse(dataEl.textContent);
    } catch {
      return null;
    }
    if (!bundles.length) return null;

    const slug = state.bundle_slug || state.bundle;
    return bundles.find((b) => b.slug === slug) || null;
  }

  /* ---------------------------------------------------------------- *
   * Rendering
   * ---------------------------------------------------------------- */

  /** @param {Record<string, unknown>} bundle */
  #renderSummary(bundle) {
    if (!this.summaryEl) return;

    const card = document.createElement('div');
    card.className = 'gift-review__summary-card';
    card.innerHTML = `
      <div class="gift-review__summary-thumb">
        ${bundle.image ? `<img src="${bundle.image}" alt="${bundle.imageAlt}" class="gift-review__summary-image" width="88" height="88" loading="eager">` : ''}
      </div>
      <div class="gift-review__summary-info">
        <span class="gift-review__summary-label">${this.el.dataset.sendingLabel || 'SENDING'}</span>
        <span class="gift-review__summary-name">${bundle.name}</span>
        <span class="gift-review__summary-price">${bundle.price}</span>
      </div>
    `;
    this.summaryEl.appendChild(card);
  }

  /** @param {Record<string, unknown>} state */
  #renderRows(state) {
    if (!this.rowsEl) return;

    this.#setValue('recipient_name', state.recipient_name);
    this.#setValue('recipient_email', state.recipient_email);
    this.#setValue('gifter_name', state.gifter_name);
    this.#setValue('gifter_email', state.gifter_email);

    const noteRow = this.rowsEl.querySelector('[data-row="note"]');
    if (noteRow) {
      const hasNote = typeof state.buyer_note === 'string' && state.buyer_note.trim() !== '';
      noteRow.hidden = !hasNote;
      if (hasNote) this.#setValue('buyer_note', state.buyer_note);
    }

    this.#renderSending(state);
  }

  /** @param {Record<string, unknown>} state */
  #renderSending(state) {
    const dateEl = this.rowsEl.querySelector('[data-value="send_date_display"]');
    const helperEl = this.rowsEl.querySelector('[data-value="send_helper"]');
    if (!dateEl) return;

    if (state.send_type === 'scheduled' && state.send_date) {
      dateEl.textContent = this.#formatSendDate(String(state.send_date));
      if (helperEl) {
        helperEl.textContent = this.el.dataset.sendHelper || 'Email goes out at 9 AM.';
        helperEl.hidden = false;
      }
    } else {
      dateEl.textContent = this.el.dataset.sendingNowLabel || 'Sending now';
      if (helperEl) {
        helperEl.textContent = '';
        helperEl.hidden = true;
      }
    }
  }

  /**
   * @param {string} iso - ISO 8601 datetime, e.g. 2026-12-25T09:00:00-05:00
   * @returns {string}
   */
  #formatSendDate(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    try {
      return new Intl.DateTimeFormat('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      }).format(date);
    } catch {
      return iso;
    }
  }

  /** @param {Record<string, unknown>} bundle */
  #renderTotal(bundle) {
    const totalEl = this.el.querySelector('[data-value="total"]');
    if (totalEl) totalEl.textContent = String(bundle.price || '');
  }

  /**
   * @param {string} field
   * @param {unknown} value
   */
  #setValue(field, value) {
    const target = this.rowsEl.querySelector(`[data-value="${field}"]`);
    if (target) target.textContent = value == null ? '' : String(value);
  }

  /* ---------------------------------------------------------------- *
   * Edit links — full current state carried back to Gift Checkout
   * ---------------------------------------------------------------- */

  /**
   * Each Edit link carries the full current state back to Gift Checkout, plus
   * `edit_field` (the row name) so Checkout can jump straight to the relevant
   * field and Review can later scroll back to that same row — see
   * `#scrollToEditedRow`.
   *
   * @param {Record<string, unknown>} state
   * @param {Record<string, unknown>} bundle
   */
  #wireEditLinks(state, bundle) {
    const baseParams = new URLSearchParams();
    // Route param is `bundle=`, not `bundle_slug=`, per the state contract.
    baseParams.set('bundle', String(bundle.slug));
    STATE_FIELDS.forEach((key) => {
      const value = state[key];
      if (value != null && value !== '') baseParams.set(key, String(value));
    });

    this.el.querySelectorAll('[data-edit-link]').forEach((link) => {
      const row = link.closest('[data-row]');
      const rowName = row ? row.dataset.row : '';
      const params = new URLSearchParams(baseParams);
      if (rowName) params.set('edit_field', rowName);

      const target = ROW_EDIT_TARGETS[rowName];
      const hash = target ? `#${target}` : '';
      link.setAttribute('href', `${this.checkoutUrl}?${params.toString()}${hash}`);
    });
  }

  /**
   * If we arrived back here from a Checkout Edit round-trip (`?edit_field=`),
   * scroll to the row the gifter was editing instead of leaving them at the
   * top of the page.
   */
  #scrollToEditedRow() {
    const editField = new URLSearchParams(window.location.search).get('edit_field');
    if (!editField || !this.rowsEl) return;

    const row = this.rowsEl.querySelector(`[data-row="${editField}"]`);
    if (!row || row.hidden) return;

    requestAnimationFrame(() => {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  /* ---------------------------------------------------------------- *
   * Cancel — discard state, back to the bundle product page, no Klaviyo
   * ---------------------------------------------------------------- */

  /** @param {Record<string, unknown>} bundle */
  #wireCancel(bundle) {
    if (!this.cancelLink) return;
    const href = String(bundle.url || this.collectionUrl);
    this.cancelLink.setAttribute('href', href);
    this.cancelLink.addEventListener('click', () => {
      try {
        sessionStorage.removeItem(STATE_KEY);
      } catch {
        /* sessionStorage unavailable — nothing to clear */
      }
    });
  }

  /* ---------------------------------------------------------------- *
   * Send the gift
   * ---------------------------------------------------------------- */

  /**
   * @param {Record<string, unknown>} state
   * @param {Record<string, unknown>} bundle
   */
  #wireSubmit(state, bundle) {
    if (!this.submitButton) return;
    this.submitButton.addEventListener('click', () => this.#submit(state, bundle));
  }

  /**
   * Adds the gift line via Ajax `/cart/add.js` (JSON body), then redirects to
   * `/checkout` with `checkout[email]` / address prefill query params.
   *
   * Cart-permalink `?properties=<base64url>` was tried so prefill + properties
   * could share one navigation, but Shopify still stored plus-addresses with
   * the `+` turned into a space in Admin line-item properties (orders #1009,
   * #1012) even when Review/sessionStorage and `checkout[email]` kept the `+`.
   * JSON `/cart/add.js` sends properties outside the query string, so `+` in
   * `_buyer_email` / `_recipient_email` / `_send_date` survives.
   *
   * Clears the cart first so a prior gift attempt cannot leave a duplicate
   * line. Clears `nb_gift_state` before navigating — same convention as
   * Cancel (`#wireCancel`).
   *
   * @param {Record<string, unknown>} state
   * @param {Record<string, unknown>} bundle
   */
  async #submit(state, bundle) {
    if (!bundle.variantId) {
      this.#showError(this.el.dataset.errorUnavailable || '');
      return;
    }

    this.#setLoading(true);

    const properties = this.#buildLineItemProperties(state, bundle);
    const prefill = this.#buildCheckoutPrefillParams(state);

    try {
      sessionStorage.removeItem(STATE_KEY);
    } catch {
      /* sessionStorage unavailable — nothing to clear */
    }

    try {
      await fetch('/cart/clear.js', { method: 'POST' });

      const response = await fetch('/cart/add.js', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          items: [
            {
              id: Number(bundle.variantId),
              quantity: 1,
              properties,
            },
          ],
        }),
      });

      if (!response.ok) {
        let detail = '';
        try {
          const err = await response.json();
          detail = err.description || err.message || '';
        } catch {
          /* ignore parse errors */
        }
        throw new Error(detail || `Add to cart failed (${response.status})`);
      }

      // Prefill params on /checkout — gifter already typed email/name on
      // Gift Checkout. Permalink was previously required for prefill; if a
      // store build ignores these on /checkout, contact still works and
      // line-item emails remain correct (the encoding priority).
      const query = prefill.toString();
      window.location.assign(query ? `/checkout?${query}` : '/checkout');
    } catch (err) {
      console.error('Gift review checkout failed:', err);
      this.#setLoading(false);
      this.#showError(this.el.dataset.errorUnavailable || 'Could not start checkout.');
    }
  }

  /**
   * Mirrors the gifter's own info onto Shopify's documented checkout-prefill
   * query params (`checkout[email]`, `checkout[billing_address][...]`) — the
   * gifter is the one paying at checkout, so there's no reason to make them
   * retype the email/name they already gave us on Gift Checkout. The bundle
   * variant is expected to have `requiresShipping: false` (see
   * docs/decisions/gift-review-checkout-mechanism.md), so checkout normally
   * shows a "Billing address" section directly rather than a separate
   * "Delivery" shipping section — but that flag has drifted back to `true`
   * in Admin at least once already (2026-07-08) without anyone touching
   * theme code, silently swapping which address section is visible and
   * making the billing-only prefill below show up empty. Filling both
   * `billing_address` and `shipping_address` name fields is a cheap hedge
   * against that drift recurring — it's a few harmless extra query params
   * when shipping isn't required, and it's the difference between a filled
   * or blank name field when it drifts again.
   *
   * @param {Record<string, unknown>} state
   * @returns {URLSearchParams}
   */
  #buildCheckoutPrefillParams(state) {
    const buyer = this.#splitName(String(state.gifter_name || ''));
    const params = new URLSearchParams();
    if (state.gifter_email) params.set('checkout[email]', String(state.gifter_email));
    if (buyer.first) {
      params.set('checkout[billing_address][first_name]', buyer.first);
      params.set('checkout[shipping_address][first_name]', buyer.first);
    }
    if (buyer.last) {
      params.set('checkout[billing_address][last_name]', buyer.last);
      params.set('checkout[shipping_address][last_name]', buyer.last);
    }
    return params;
  }

  /**
   * `Gift` is customer-visible (no underscore prefix — matches the Build
   * Guide §8 convention of visible `Color`/`Bundle` properties on the
   * constituent-item flow), so the order confirmation shows this bundle
   * purchase as a gift. The remaining underscore-prefixed properties are
   * hidden from the customer-facing cart and order (same convention as the
   * bundle `_bundle` / `_color` line item properties) but remain available
   * for admin views and downstream automation (order tagging Flow, Klaviyo
   * Gift Purchased firing — see docs/decisions/gift-review-checkout-mechanism.md).
   *
   * `_bundle_slug` is written explicitly so the gift app (and recipient
   * redemption URL) can bind the gift card to that one bundle — REST
   * `orders/paid` webhooks do not include `product.handle`, so we cannot
   * rely on the line item's product reference alone. `_bundle_product_id`
   * pins the same bundle by id, which is what the redemption true-up checks
   * the recipient's cart against before adjusting the gift card.
   *
   * @param {Record<string, unknown>} state
   * @param {Record<string, unknown>} bundle
   * @returns {Record<string, string>}
   */
  #buildLineItemProperties(state, bundle) {
    const buyer = this.#splitName(String(state.gifter_name || ''));
    const recipient = this.#splitName(String(state.recipient_name || ''));
    const scheduled = state.send_type === 'scheduled';

    /** @type {Record<string, string>} */
    const properties = {
      Gift: 'Yes',
      _gift_flow: 'true',
      _bundle_slug: String(bundle.slug || state.bundle_slug || ''),
      _bundle_product_id: String(bundle.id || state.bundle_product_id || ''),
      _send_type: String(state.send_type || 'immediate'),
      _gift_link_token: crypto.randomUUID(),
      _buyer_first_name: buyer.first,
      _buyer_last_name: buyer.last,
      _buyer_email: String(state.gifter_email || ''),
      _recipient_first_name: recipient.first,
      _recipient_email: String(state.recipient_email || ''),
      _buyer_note: String(state.buyer_note || ''),
    };

    if (scheduled) {
      properties._send_date = String(state.send_date || '');
      properties._send_timezone = String(state.send_timezone || '');
    }

    // Captured on the gift form; the app honors this on orders/paid only.
    if (state.newsletter_opt_in === true || state.newsletter_opt_in === 'true') {
      properties._newsletter_opt_in = 'true';
    }

    return properties;
  }

  /**
   * @param {string} fullName
   * @returns {{ first: string, last: string }}
   */
  #splitName(fullName) {
    const trimmed = fullName.trim();
    if (!trimmed) return { first: '', last: '' };
    const parts = trimmed.split(/\s+/);
    return { first: parts[0], last: parts.slice(1).join(' ') };
  }

  /* ---------------------------------------------------------------- *
   * Submit button state
   * ---------------------------------------------------------------- */

  /** @param {boolean} loading */
  #setLoading(loading) {
    if (!this.submitButton) return;
    this.submitButton.disabled = loading;
    this.submitButton.textContent = loading
      ? this.el.dataset.submitLoadingLabel || 'Sending…'
      : this.el.dataset.submitLabel || 'Send the gift';
  }

  /** @param {string} message */
  #disableSubmit(message) {
    if (this.submitButton) this.submitButton.disabled = true;
    this.#showError(message);
  }

  /** @param {string} message */
  #showError(message) {
    if (!this.submitError || !message) return;
    this.submitError.textContent = message;
    this.submitError.hidden = false;
  }

}
