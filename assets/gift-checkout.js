/**
 * Gift Checkout controller (M6 / Build Guide Page 5).
 *
 * Drives the gift checkout form:
 * - Reveals the bundle summary that matches the ?bundle= URL slug.
 * - Live 750-character note counter that blocks submission when exceeded.
 * - Send now / Schedule for later toggle with a brand-skinned flatpickr calendar.
 * - Client-side required-field + email validation with inline messaging.
 * - Persists form state to sessionStorage (with a URL-param fallback per Build
 *   Guide 4.4) so refresh, share, and Review -> Edit round-trips never lose data.
 * - Routes to the Review page on submit. It does NOT touch Shopify checkout and
 *   does NOT fire the Gift Purchased event — the gift is purchased on M7.
 *
 * Decisions (Build Guide 9):
 * - State: sessionStorage primary, URL fallback.
 * - Timezone: the gifter's browser IANA timezone, captured at submit; the final
 *   9 AM-recipient-local ISO is assembled downstream (M7/M12).
 * - Newsletter: the opt-in is captured into state only. The app subscribes the
 *   gifter to the Klaviyo Newsletter list on orders/paid when the checkbox was
 *   checked (so abandoned checkouts never join and Welcome cannot interrupt pay).
 */

const STATE_KEY = 'nb_gift_state';

/** Row name (Review's `edit_field`) -> the field to focus once scrolled into view. */
const ROW_FOCUS_TARGETS = {
  to: 'GiftRecipientName',
  from: 'GiftGifterName',
  note: 'GiftNote',
  sending: 'GiftSendNow',
};

/** Keys persisted to sessionStorage and mirrored to the Review URL. */
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class GiftCheckoutController {
  /** @param {HTMLElement} el - the <gift-checkout> custom element */
  constructor(el) {
    this.el = el;
    this.reviewUrl = el.dataset.reviewUrl || '/pages/gift-review';
    this.noteMax = parseInt(el.dataset.noteMax || '750', 10);
    this.flatpickrInstance = null;

    this.form = el.querySelector('[data-form]');
    if (!this.form) return;

    this.bundleField = el.querySelector('[data-field-bundle]');
    this.bundleProductIdField = el.querySelector('[data-field-bundle-product-id]');
    this.note = el.querySelector('[data-note]');
    this.counter = el.querySelector('[data-counter]');
    this.sendTypeField = el.querySelector('[data-field-send-type]');
    this.sendDateField = el.querySelector('[data-field-send-date]');
    this.sendTimezoneField = el.querySelector('[data-field-send-timezone]');
    this.toggleButtons = Array.from(el.querySelectorAll('[data-send-type]'));
    this.calendar = el.querySelector('[data-calendar]');
    this.calendarInput = el.querySelector('[data-calendar-input]');
    this.calendarError = el.querySelector('[data-calendar-error]');
    this.newsletter = el.querySelector('[name="newsletter_opt_in"]');

    this.#revealBundle();
    this.#restoreState();
    this.#bindNoteCounter();
    this.#bindToggle();
    this.#bindPersistence();
    this.#bindSubmit();
    this.#scrollToEditTarget();
  }

  /* ---------------------------------------------------------------- *
   * Scroll to the section a Review "Edit" link pointed at (URL hash points
   * at the section label, so the landing view is consistent across rows),
   * once the bundle summary/calendar reveal above it have settled. Then
   * focus the actual field for `edit_field`, if any.
   * ---------------------------------------------------------------- */

  #scrollToEditTarget() {
    const hash = window.location.hash;
    if (!hash) return;
    const target = document.getElementById(hash.slice(1));
    if (!target) return;

    const editField = new URLSearchParams(window.location.search).get('edit_field');
    const focusId = editField && ROW_FOCUS_TARGETS[editField];
    const focusTarget = focusId && document.getElementById(focusId);

    requestAnimationFrame(() => {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (focusTarget && typeof focusTarget.focus === 'function') {
        // Focusing in the same frame as a smooth scroll is unreliable across
        // browsers (Safari in particular drops it) — wait for the scroll to
        // settle first.
        setTimeout(() => focusTarget.focus({ preventScroll: true }), 450);
      }
    });
  }

  /* ---------------------------------------------------------------- *
   * Bundle summary
   * ---------------------------------------------------------------- */

  /** Build and insert the summary card for the ?bundle= slug (falls back to the first). */
  #revealBundle() {
    const summaryEl = this.el.querySelector('[data-summary]');
    const dataEl = this.el.querySelector('[data-bundles]');
    if (!summaryEl || !dataEl) return;

    let bundles = [];
    try {
      bundles = JSON.parse(dataEl.textContent);
    } catch {
      return;
    }
    if (!bundles.length) return;

    const slug = new URLSearchParams(window.location.search).get('bundle');
    const bundle = bundles.find((b) => b.slug === slug) || bundles[0];

    const card = document.createElement('div');
    card.className = 'gift-checkout__summary-card';

    card.innerHTML = `
      <div class="gift-checkout__summary-thumb">
        ${bundle.image ? `<img src="${bundle.image}" alt="${bundle.imageAlt}" class="gift-checkout__summary-image" width="88" height="88" loading="eager">` : ''}
      </div>
      <div class="gift-checkout__summary-info">
        <span class="gift-checkout__summary-label">${this.el.dataset.sendingLabel || 'SENDING'}</span>
        <span class="gift-checkout__summary-name">${bundle.name}</span>
        <span class="gift-checkout__summary-price">${bundle.price}</span>
      </div>
    `;

    summaryEl.appendChild(card);
    if (this.bundleField) this.bundleField.value = bundle.slug;
    if (this.bundleProductIdField) this.bundleProductIdField.value = bundle.id;

    if (!bundle.available) {
      this.#showUnavailableState();
    }
  }

  #showUnavailableState() {
    if (!this.form) return;
    const { unavailableLabel, unavailableNotify, unavailableChooseAnother, bundleCollectionUrl } = this.el.dataset;
    this.form.innerHTML = `
      <div class="gift-checkout__unavailable">
        <p class="gift-checkout__unavailable-label">${unavailableLabel || 'Currently unavailable'}</p>
        <button type="button" class="gift-checkout__unavailable-notify gift-checkout__submit">${unavailableNotify || 'Get Notified'}</button>
        <a class="gift-checkout__unavailable-link" href="${bundleCollectionUrl || '/collections/gifts-and-bundles'}">${unavailableChooseAnother || 'Choose another gift'}</a>
      </div>
    `;
  }

  /* ---------------------------------------------------------------- *
   * State restore (sessionStorage > URL > customer prefill)
   * ---------------------------------------------------------------- */

  #restoreState() {
    const saved = this.#readState();
    const url = this.#readUrlState();
    const state = { ...url, ...saved };

    STATE_FIELDS.forEach((key) => {
      if (key === 'bundle_slug' || key === 'bundle_product_id') return;
      const value = state[key];
      if (value == null || value === '') return;

      if (key === 'newsletter_opt_in') {
        if (this.newsletter) this.newsletter.checked = value === true || value === 'true';
        return;
      }
      if (key === 'send_type') {
        this.#setSendType(value, { skipPersist: true });
        return;
      }
      if (key === 'send_date') {
        if (this.sendDateField) this.sendDateField.value = value;
        return;
      }
      const input = this.form.querySelector(`[name="${key}"]`);
      if (input) input.value = value;
    });

    // First visit (no saved name/email): prefill from the logged-in customer.
    if (!saved.gifter_name && !url.gifter_name && this.el.dataset.prefillName) {
      const nameInput = this.form.querySelector('[name="gifter_name"]');
      if (nameInput && !nameInput.value) nameInput.value = this.el.dataset.prefillName;
    }
    if (!saved.gifter_email && !url.gifter_email && this.el.dataset.prefillEmail) {
      const emailInput = this.form.querySelector('[name="gifter_email"]');
      if (emailInput && !emailInput.value) emailInput.value = this.el.dataset.prefillEmail;
    }

    this.#updateCounter();

    // If a scheduled date was restored, re-open the calendar to reflect it.
    if (this.sendTypeField && this.sendTypeField.value === 'scheduled') {
      this.#setSendType('scheduled', { skipPersist: true });
    }
  }

  /** @returns {Record<string, unknown>} */
  #readState() {
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
    return out;
  }

  /* ---------------------------------------------------------------- *
   * Note counter
   * ---------------------------------------------------------------- */

  #bindNoteCounter() {
    if (!this.note) return;
    this.note.addEventListener('input', () => {
      this.#updateCounter();
      this.#autoResizeNote();
    });
    // Size for any value already restored onto the textarea (see #restoreState).
    this.#autoResizeNote();
  }

  /** Grows the textarea to fit its content instead of scrolling inside itself. */
  #autoResizeNote() {
    if (!this.note) return;
    this.note.style.height = 'auto';
    this.note.style.height = `${this.note.scrollHeight}px`;
  }

  #updateCounter() {
    if (!this.note || !this.counter) return;
    const count = this.note.value.length;
    const template = this.counter.dataset.counterTemplate || '__COUNT__';
    this.counter.textContent = template.replace('__COUNT__', String(count));
    this.counter.classList.toggle('gift-checkout__counter--over', count > this.noteMax);
  }

  /* ---------------------------------------------------------------- *
   * Send now / Schedule toggle + flatpickr
   * ---------------------------------------------------------------- */

  #bindToggle() {
    this.toggleButtons.forEach((btn) => {
      btn.addEventListener('click', () => this.#setSendType(btn.dataset.sendType || 'immediate'));
    });
  }

  /**
   * @param {string} type - 'immediate' or 'scheduled'
   * @param {{ skipPersist?: boolean }} [opts]
   */
  #setSendType(type, opts = {}) {
    const scheduled = type === 'scheduled';

    this.toggleButtons.forEach((btn) => {
      const active = btn.dataset.sendType === type;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    if (this.sendTypeField) this.sendTypeField.value = type;
    if (this.calendar) this.calendar.hidden = !scheduled;

    if (scheduled) {
      this.#initCalendar();
    } else if (this.calendarError) {
      this.calendarError.hidden = true;
    }

    if (!opts.skipPersist) this.#storeState();
  }

  async #initCalendar() {
    if (this.flatpickrInstance || !this.calendarInput) return;
    const flatpickr = await this.#waitForFlatpickr();
    if (!flatpickr) return;

    this.flatpickrInstance = flatpickr(this.calendarInput, {
      inline: true,
      minDate: 'today',
      dateFormat: 'M j, Y',
      defaultDate: this.#restoredCalendarDate(),
      onChange: (dates) => this.#onDatePicked(dates[0]),
    });
  }

  /** @returns {Date | undefined} */
  #restoredCalendarDate() {
    const iso = this.sendDateField && this.sendDateField.value;
    if (!iso) return undefined;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }

  /**
   * Build the provisional ISO datetime at 9 AM in the captured (browser) timezone.
   * @param {Date | undefined} date
   */
  #onDatePicked(date) {
    if (!date || !this.sendDateField) return;
    const timezone = this.#browserTimezone();
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const offset = this.#tzOffset(date, timezone);

    this.sendDateField.value = `${y}-${m}-${d}T09:00:00${offset}`;
    if (this.sendTimezoneField) this.sendTimezoneField.value = timezone;
    if (this.calendarError) this.calendarError.hidden = true;

    this.#storeState();
  }

  #browserTimezone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  }

  /**
   * Resolve the UTC offset (e.g. "+05:00") for a given date in an IANA timezone.
   * Falls back to the local offset when longOffset is unsupported.
   * @param {Date} date
   * @param {string} timeZone
   * @returns {string}
   */
  #tzOffset(date, timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        timeZoneName: 'longOffset',
      }).formatToParts(date);
      const name = parts.find((p) => p.type === 'timeZoneName');
      const match = name && name.value.match(/([+-]\d{2}:?\d{2})$/);
      if (match) {
        const raw = match[1].includes(':') ? match[1] : `${match[1].slice(0, 3)}:${match[1].slice(3)}`;
        return raw;
      }
    } catch {
      /* fall through */
    }
    const mins = -date.getTimezoneOffset();
    const sign = mins >= 0 ? '+' : '-';
    const abs = Math.abs(mins);
    return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  }

  /**
   * flatpickr is loaded as a deferred classic script (window.flatpickr).
   * Poll briefly so the module can be imported before the script settles.
   * @returns {Promise<typeof window.flatpickr | null>}
   */
  #waitForFlatpickr() {
    return new Promise((resolve) => {
      if (window.flatpickr) return resolve(window.flatpickr);
      let tries = 0;
      const timer = setInterval(() => {
        if (window.flatpickr) {
          clearInterval(timer);
          resolve(window.flatpickr);
        } else if (++tries > 60) {
          clearInterval(timer);
          resolve(null);
        }
      }, 50);
    });
  }

  /* ---------------------------------------------------------------- *
   * Persistence
   * ---------------------------------------------------------------- */

  #bindPersistence() {
    this.form.addEventListener('input', () => this.#storeState());
    this.form.addEventListener('change', () => this.#storeState());
  }

  /** @returns {Record<string, unknown>} */
  #collectState() {
    /** @type {Record<string, unknown>} */
    const state = {};
    STATE_FIELDS.forEach((key) => {
      if (key === 'newsletter_opt_in') {
        state[key] = !!(this.newsletter && this.newsletter.checked);
        return;
      }
      const input = this.form.querySelector(`[name="${key}"]`);
      state[key] = input ? input.value : '';
    });
    return state;
  }

  #storeState() {
    try {
      sessionStorage.setItem(STATE_KEY, JSON.stringify(this.#collectState()));
    } catch {
      /* sessionStorage unavailable (private mode) — URL fallback still applies on submit */
    }
  }

  /* ---------------------------------------------------------------- *
   * Validation + submit
   * ---------------------------------------------------------------- */

  #bindSubmit() {
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.#submit();
    });

    // Clear a field's error as soon as the user edits it.
    this.form.querySelectorAll('[data-input]').forEach((input) => {
      input.addEventListener('input', () => this.#clearFieldError(input));
    });
  }

  #submit() {
    if (!this.#validate()) return;

    // Timezone is meant to be captured at submit (Build Guide 9) — if the
    // hidden field somehow never picked one up, fall back to the browser's
    // rather than let a scheduled send go out with no IANA timezone.
    if (this.sendTypeField && this.sendTypeField.value === 'scheduled' && this.sendTimezoneField && !this.sendTimezoneField.value) {
      this.sendTimezoneField.value = this.#browserTimezone();
    }

    this.#storeState();

    // Route to the Review page carrying only bundle_slug in the URL — the
    // full state already lives in sessionStorage (#storeState above), and
    // recipient/gifter PII has no reason to sit in the URL bar, browser
    // history, or server logs. See docs/decisions/gift-checkout-state-and-timezone.md.
    const state = this.#collectState();
    const params = new URLSearchParams();
    params.set('bundle_slug', String(state.bundle_slug || ''));

    // Carry `edit_field` forward so Review can scroll back to the row the
    // gifter was editing instead of dropping them at the top of the page.
    const editField = new URLSearchParams(window.location.search).get('edit_field');
    if (editField) params.set('edit_field', editField);

    window.location.assign(`${this.reviewUrl}?${params.toString()}`);
  }

  /** @returns {boolean} */
  #validate() {
    let valid = true;
    let firstInvalid = null;

    this.form.querySelectorAll('[data-input][required]').forEach((input) => {
      const value = input.value.trim();
      if (!value) {
        this.#setFieldError(input, input.dataset.errorRequired || '');
        valid = false;
        firstInvalid = firstInvalid || input;
      } else if (input.type === 'email' && !EMAIL_RE.test(value)) {
        this.#setFieldError(input, input.dataset.errorFormat || '');
        valid = false;
        firstInvalid = firstInvalid || input;
      } else {
        this.#clearFieldError(input);
      }
    });

    // Note must not exceed the max.
    if (this.note && this.note.value.length > this.noteMax) {
      this.#updateCounter();
      valid = false;
      firstInvalid = firstInvalid || this.note;
    }

    // Scheduled gifts need a date.
    if (this.sendTypeField && this.sendTypeField.value === 'scheduled') {
      if (!this.sendDateField || !this.sendDateField.value) {
        if (this.calendarError) {
          this.calendarError.textContent = this.calendarError.dataset.message || '';
          this.calendarError.hidden = false;
        }
        valid = false;
        firstInvalid = firstInvalid || this.calendarInput;
      }
    }

    if (firstInvalid && typeof firstInvalid.focus === 'function') firstInvalid.focus();
    return valid;
  }

  /**
   * @param {HTMLElement} input
   * @param {string} message
   */
  #setFieldError(input, message) {
    const field = input.closest('[data-field]');
    if (!field) return;
    field.classList.add('gift-checkout__field--invalid');
    const error = field.querySelector('[data-error]');
    if (error) {
      error.textContent = message;
      error.hidden = false;
    }
    input.setAttribute('aria-invalid', 'true');
  }

  /** @param {HTMLElement} input */
  #clearFieldError(input) {
    const field = input.closest('[data-field]');
    if (!field) return;
    field.classList.remove('gift-checkout__field--invalid');
    const error = field.querySelector('[data-error]');
    if (error) error.hidden = true;
    input.removeAttribute('aria-invalid');
  }

}
