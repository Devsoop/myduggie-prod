/**
 * Gift Recipient controller (M8 / Build Guide Page 7).
 *
 * - ?mock=ready|preparing|redeemed|error|ready_no_note — layout preview fixtures
 *   (always available so design QA works on the live storefront).
 * - Real tokens: gift app GET /api/gifts/{token} → banner/note + associated
 *   bundle only → Storefront gift-card validate → cartLinesAdd → checkout ($0).
 */

const STOREFRONT_API_VERSION = '2024-10';
const DEFAULT_GIFT_API_BASE = 'https://oyster-app-3c672.ondigitalocean.app';

/**
 * @typedef {{
 *   status?: string,
 *   recipient_first_name?: string,
 *   recipient_email?: string,
 *   gifter_first_name?: string,
 *   gifter_email?: string,
 *   buyer_note?: string,
 *   bundle_slug?: string,
 *   gift_card_code?: string,
 * }} GiftRecord
 */

const MOCK_FIXTURES = {
  ready: {
    status: 'ready',
    recipient_first_name: 'Sarah',
    recipient_email: 'sarah@example.com',
    gifter_first_name: 'Brian',
    gifter_email: 'brian@example.com',
    buyer_note:
      "Hey Sarah — I saw this and immediately thought of you. The whole brand is about objects that earn their place, made carefully, designed to last. Pick whatever colors feel right.",
    bundle_slug: 'the-complete-carry',
    gift_card_code: 'MOCK-GIFT-CARD-CODE',
  },
  ready_no_note: {
    status: 'ready',
    recipient_first_name: 'Sarah',
    recipient_email: 'sarah@example.com',
    gifter_first_name: 'Brian',
    gifter_email: 'brian@example.com',
    buyer_note: '',
    bundle_slug: 'the-complete-carry',
    gift_card_code: 'MOCK-GIFT-CARD-CODE',
  },
  preparing: { status: 'pending' },
  redeemed: { status: 'redeemed' },
  error: { status: 'not_found' },
};

export class GiftRecipientController {
  /** @param {HTMLElement} el */
  constructor(el) {
    this.el = el;
    this.apiBase = (el.dataset.giftApiBase || DEFAULT_GIFT_API_BASE).trim().replace(/\/$/, '');
    this.configuratorSrc = el.dataset.configuratorSrc;
    this.shopDomain = el.dataset.shopDomain || '';
    this.storefrontToken =
      el.dataset.storefrontToken || this.#readShopifyFeaturesToken() || '';
    this.configurator = null;
    /** @type {GiftRecord|null} */
    this.gift = null;
    this.token = null;
    this.cartId = null;
    this.isMock = false;

    this.states = {
      preparing: el.querySelector('[data-state="preparing"]'),
      error: el.querySelector('[data-state="error"]'),
      redeemed: el.querySelector('[data-state="redeemed"]'),
      ready: el.querySelector('[data-state="ready"]'),
    };

    this.#init();
  }

  async #init() {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    if (!token) {
      this.#renderState('error');
      return;
    }
    this.token = token;

    let gift;
    try {
      gift = await this.#resolveGift(token, params);
    } catch (err) {
      console.error('Gift resolve failed:', err);
      this.#renderState('error');
      return;
    }

    this.gift = gift;
    const status = this.#normalizeStatus(gift.status);

    if (status === 'not_found') {
      this.#renderState('error');
      return;
    }
    if (status === 'redeemed') {
      this.#renderState('redeemed');
      return;
    }
    if (status === 'pending' || status === 'preparing') {
      this.#renderState('preparing');
      return;
    }

    const bundleRoot = this.#revealBundle(gift.bundle_slug);
    if (!bundleRoot) {
      this.#renderState('error');
      return;
    }

    this.#revealDescription(gift.bundle_slug);
    this.#fillBanner(gift);
    this.#fillNoteCard(gift);
    this.#fillPriceLine(bundleRoot, gift);
    await this.#instantiateConfigurator(bundleRoot);
    this.#bindReceiveGift(bundleRoot, gift);
    this.#renderState('ready');

    // Validate gift card after painting the ready layout so banner/note match
    // the mock preview. If validation fails, keep the layout; redeem will retry.
    if (!this.isMock) {
      const code = gift.gift_card_code || token;
      try {
        this.cartId = await this.#validateGiftCard(code);
      } catch (err) {
        console.error('Gift card validation failed:', err);
      }
    }
  }

  /**
   * @param {string|undefined} status
   * @returns {string}
   */
  #normalizeStatus(status) {
    const s = (status || '').toLowerCase();
    if (s === 'fulfilled' || s === 'ready') return 'ready';
    if (s === 'pending' || s === 'preparing' || s === 'card_created' || s === 'emailed') {
      return 'preparing';
    }
    if (s === 'redeemed') return 'redeemed';
    if (s === 'not_found') return 'not_found';
    return s || 'not_found';
  }

  /**
   * @param {string} token
   * @param {URLSearchParams} params
   * @returns {Promise<GiftRecord>}
   */
  async #resolveGift(token, params) {
    const mockParam = params.get('mock');
    // Layout preview must work on the live storefront (not only theme editor).
    if (mockParam && MOCK_FIXTURES[mockParam]) {
      this.isMock = true;
      return MOCK_FIXTURES[mockParam];
    }

    if (!this.apiBase) throw new Error('Gift app API base URL is not configured');

    const response = await fetch(
      `${this.apiBase}/api/gifts/${encodeURIComponent(token)}`,
      { headers: { Accept: 'application/json' } },
    );
    if (response.status === 404) return { status: 'not_found' };
    if (!response.ok) throw new Error(`Gift lookup failed: ${response.status}`);
    /** @type {GiftRecord} */
    const body = await response.json();
    const urlBundle = (params.get('bundle') || params.get('bundle_slug') || '').trim();
    if (urlBundle && body.bundle_slug && urlBundle !== body.bundle_slug) {
      throw new Error('URL bundle does not match gift record');
    }
    return body;
  }

  /** @param {'preparing'|'error'|'redeemed'|'ready'} name */
  #renderState(name) {
    Object.entries(this.states).forEach(([key, node]) => {
      if (node) node.hidden = key !== name;
    });
  }

  /**
   * @param {string|undefined} slug
   * @returns {HTMLElement | null}
   */
  #revealBundle(slug) {
    const readyState = this.states.ready;
    if (!readyState || !slug) return null;
    const blocks = readyState.querySelectorAll('[data-bundle-slug]');
    let matched = null;
    blocks.forEach((block) => {
      const isMatch = block.dataset.bundleSlug === slug;
      block.hidden = !isMatch;
      if (isMatch) matched = block;
    });
    return matched;
  }

  /** @param {string|undefined} slug */
  #revealDescription(slug) {
    if (!slug) return;
    const descriptions = this.el.querySelectorAll(
      '.gift-recipient__description[data-bundle-slug]',
    );
    descriptions.forEach((description) => {
      description.hidden = description.dataset.bundleSlug !== slug;
    });
  }

  /** @param {GiftRecord} gift */
  #fillBanner(gift) {
    const banner = this.el.querySelector('[data-banner]');
    if (!banner) return;
    const template = this.el.dataset.bannerTemplate || '__RECIPIENT__ — a gift from __GIFTER__.';
    banner.textContent = template
      .replace('__RECIPIENT__', gift.recipient_first_name || '')
      .replace('__GIFTER__', gift.gifter_first_name || '');
  }

  /** @param {GiftRecord} gift */
  #fillNoteCard(gift) {
    const card = this.el.querySelector('[data-note-card]');
    const body = this.el.querySelector('[data-note-body]');
    if (!card || !body) return;

    const note = this.#formatBuyerNote(gift.buyer_note, gift);
    if (!note) {
      card.hidden = true;
      return;
    }

    body.textContent = note;
    card.hidden = false;
  }

  /**
   * Banner already shows who the gift is from, so strip a trailing sign-off
   * like "Love,\n\nBrian" to match the mock note (message body only).
   * @param {string|undefined} note
   * @param {GiftRecord} gift
   * @returns {string}
   */
  #formatBuyerNote(note, gift) {
    let text = String(note || '').replace(/\s+$/u, '');
    if (!text) return '';

    // "Love,\n\nBrian" / "Best,\nName" / "xo,\nAlex"
    text = text.replace(
      /(?:\r?\n)+\s*(?:Love|Best|Cheers|Yours|xo|xoxo)[,!]?\s*(?:\r?\n)+\s*[A-Za-z][A-Za-z'. -]{0,40}\s*$/iu,
      '',
    );

    // Trailing standalone line matching gifter (or recipient) first name
    const names = [gift.gifter_first_name, gift.recipient_first_name]
      .map((n) => (n || '').trim())
      .filter(Boolean);
    for (const name of names) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp(`(?:\\r?\\n)+\\s*${escaped}\\s*$`, 'iu'), '');
    }

    // Leftover closing word with no name ("Love,")
    text = text.replace(
      /(?:\r?\n)+\s*(?:Love|Best|Cheers|Yours|xo|xoxo)[,!]?\s*$/iu,
      '',
    );

    return text.trim();
  }

  /**
   * @param {HTMLElement} bundleRoot
   * @param {GiftRecord} gift
   */
  #fillPriceLine(bundleRoot, gift) {
    const priceLine = bundleRoot.querySelector('[data-price-line]');
    if (!priceLine) return;
    const template = this.el.dataset.priceLineTemplate || '__PRICE__ (__GIFTER__ took care of it.)';
    const price = priceLine.dataset.price || '';
    const filled = template
      .replace('__PRICE__', price)
      .replace('__GIFTER__', gift.gifter_first_name || '');

    const parenMatch = filled.match(/^(.*?)(\(.*\))\s*$/);
    if (parenMatch) {
      priceLine.textContent = '';
      priceLine.append(document.createTextNode(`${parenMatch[1]} `));
      const em = document.createElement('em');
      em.textContent = parenMatch[2];
      priceLine.append(em);
    } else {
      priceLine.textContent = filled;
    }
  }

  /** @param {HTMLElement} bundleRoot */
  async #instantiateConfigurator(bundleRoot) {
    if (!this.configuratorSrc) return;
    try {
      const module = await import(this.configuratorSrc);
      this.configurator = new module.BundleConfigurator(bundleRoot);
    } catch (err) {
      console.error('Failed to load bundle configurator:', err);
    }
  }

  /**
   * @param {HTMLElement} bundleRoot
   * @param {GiftRecord} gift
   */
  #bindReceiveGift(bundleRoot, gift) {
    const button = bundleRoot.querySelector('[data-receive-gift]');
    if (!button || !this.configurator) return;

    const errorEl = bundleRoot.querySelector('[data-redeem-error]');
    /** @param {string} message */
    const showError = (message) => {
      if (!errorEl) return;
      errorEl.textContent = message;
      errorEl.hidden = false;
    };
    const clearError = () => {
      if (!errorEl) return;
      errorEl.textContent = '';
      errorEl.hidden = true;
    };

    button.addEventListener('click', async () => {
      if (this.isMock) {
        console.info('Mock gift — redemption skipped');
        return;
      }

      const configurator = this.configurator;
      if (configurator.selections.size < configurator.itemCount) {
        configurator.setValidationError();
        return;
      }
      configurator.clearValidationError();
      clearError();

      const loadingLabel = this.el.dataset.receiveLoadingLabel || 'Receiving…';
      const originalLabel = button.textContent;
      button.disabled = true;
      button.textContent = loadingLabel;

      try {
        // Always start from a fresh cart. Reusing a cart from a failed attempt
        // re-adds line items and makes the true-up reject the cart as mismatched.
        const code = gift.gift_card_code || this.token;
        this.cartId = await this.#validateGiftCard(code, gift.recipient_email);
        const checkoutUrl = await this.#redeemGift(bundleRoot, gift, configurator);
        window.location.assign(checkoutUrl);
      } catch (err) {
        console.error('Gift redemption failed:', err);
        const detail = err instanceof Error ? err.message : '';
        showError(
          detail ||
            this.el.dataset.receiveErrorLabel ||
            'We couldn’t complete your gift just now. Please try again.',
        );
        button.disabled = false;
        button.textContent = originalLabel;
      }
    });
  }

  /**
   * @param {string} giftCardCode
   * @param {string} [recipientEmail] - Pre-fills the checkout contact email
   *   via the cart's buyerIdentity, so the recipient doesn't have to retype
   *   an email Shopify already has on file for this order (order line item
   *   property `_recipient_email`). Storefront API only supports prefilling
   *   email/phone this way — not name or shipping address.
   * @returns {Promise<string>}
   */
  async #validateGiftCard(giftCardCode, recipientEmail) {
    const input = recipientEmail ? { buyerIdentity: { email: recipientEmail } } : {};
    const createResult = await this.#storefrontFetch(
      `mutation CartCreate($input: CartInput!) {
        cartCreate(input: $input) {
          cart { id }
          userErrors { field message }
        }
      }`,
      { input },
    );

    const cartCreate = createResult.cartCreate;
    if (cartCreate.userErrors?.length) {
      throw new Error(cartCreate.userErrors.map((e) => e.message).join(', '));
    }
    const cartId = cartCreate.cart.id;

    const giftCardResult = await this.#storefrontFetch(
      `mutation CartGiftCardCodesUpdate($cartId: ID!, $giftCardCodes: [String!]!) {
        cartGiftCardCodesUpdate(cartId: $cartId, giftCardCodes: $giftCardCodes) {
          cart { id appliedGiftCards { id } }
          userErrors { field message }
        }
      }`,
      { cartId, giftCardCodes: [giftCardCode] },
    );

    const giftCardUpdate = giftCardResult.cartGiftCardCodesUpdate;
    if (giftCardUpdate.userErrors?.length) {
      throw new Error(giftCardUpdate.userErrors.map((e) => e.message).join(', '));
    }
    if (!giftCardUpdate.cart.appliedGiftCards?.length) {
      throw new Error('Gift card code was not applied');
    }

    return giftCardUpdate.cart.id;
  }

  /**
   * @param {HTMLElement} bundleRoot
   * @param {GiftRecord} gift
   * @param {import('./bundle-configurator.js').BundleConfigurator} configurator
   * @returns {Promise<string>}
   */
  async #redeemGift(bundleRoot, gift, configurator) {
    if (!this.cartId) throw new Error('Gift cart is not ready');

    const bundleTitle = bundleRoot.dataset.productTitle || '';
    const bundleProductId = bundleRoot.dataset.productId || '';
    const giftCardCode = gift.gift_card_code || this.token;

    // Sort by picker/bundle order, then reverse so cart/checkout/receipt show
    // Lil' Duggie first (Storefront cartLinesAdd is LIFO, same as Ajax /cart/add.js).
    const lines = configurator
      .getSelectionsInBundleOrder()
      .map((selection) => ({
        merchandiseId: `gid://shopify/ProductVariant/${selection.variantId}`,
        quantity: 1,
        attributes: [
          { key: 'Bundle', value: bundleTitle },
          { key: 'Color', value: selection.colorName },
          { key: '_bundle_tag', value: `${bundleTitle}:${bundleProductId}` },
          { key: '_gift_flow', value: 'true' },
          { key: '_gift_redemption_token', value: this.token },
        ],
      }))
      .reverse();

    const result = await this.#storefrontFetch(
      `mutation CartLinesAdd($cartId: ID!, $lines: [CartLineInput!]!) {
        cartLinesAdd(cartId: $cartId, lines: $lines) {
          cart { id checkoutUrl }
          userErrors { field message }
        }
      }`,
      { cartId: this.cartId, lines },
    );

    const cartLinesAdd = result.cartLinesAdd;
    if (cartLinesAdd.userErrors?.length) {
      throw new Error(cartLinesAdd.userErrors.map((e) => e.message).join(', '));
    }

    this.cartId = cartLinesAdd.cart.id;
    await this.#trueUpGiftCard(giftCardCode);
    return this.#refreshCheckoutUrl(giftCardCode);
  }

  /**
   * Ask the gift app to credit/debit the Shopify gift card so its balance
   * matches the live redemption cart total before the recipient checks out.
   * @param {string} giftCardCode
   */
  async #trueUpGiftCard(giftCardCode) {
    if (!this.apiBase || !this.token || !this.cartId) {
      throw new Error('Gift true-up is not configured');
    }
    if (!this.storefrontToken) {
      throw new Error('Storefront access token is required for gift true-up');
    }

    const response = await fetch(
      `${this.apiBase}/api/gifts/${encodeURIComponent(this.token)}/true-up`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          cart_id: this.cartId,
          storefront_access_token: this.storefrontToken,
        }),
      },
    );

    if (!response.ok) {
      let detail = `Gift true-up failed: ${response.status}`;
      try {
        const body = await response.json();
        if (body?.error) detail = body.error;
      } catch {
        /* keep status-based message */
      }
      throw new Error(detail);
    }
  }

  /**
   * Re-apply the gift card after any balance true-up so checkout sees the
   * updated available amount, then return the fresh checkout URL.
   * @param {string} giftCardCode
   * @returns {Promise<string>}
   */
  async #refreshCheckoutUrl(giftCardCode) {
    const giftCardResult = await this.#storefrontFetch(
      `mutation CartGiftCardCodesUpdate($cartId: ID!, $giftCardCodes: [String!]!) {
        cartGiftCardCodesUpdate(cartId: $cartId, giftCardCodes: $giftCardCodes) {
          cart {
            id
            checkoutUrl
            cost { totalAmount { amount } }
            appliedGiftCards { id amountUsed { amount } }
          }
          userErrors { field message }
        }
      }`,
      { cartId: this.cartId, giftCardCodes: [giftCardCode] },
    );

    const giftCardUpdate = giftCardResult.cartGiftCardCodesUpdate;
    if (giftCardUpdate.userErrors?.length) {
      throw new Error(giftCardUpdate.userErrors.map((e) => e.message).join(', '));
    }
    if (!giftCardUpdate.cart.appliedGiftCards?.length) {
      throw new Error('Gift card code was not re-applied after true-up');
    }

    this.cartId = giftCardUpdate.cart.id;
    return giftCardUpdate.cart.checkoutUrl;
  }

  /** @returns {string} */
  #readShopifyFeaturesToken() {
    try {
      const el = document.getElementById('shopify-features');
      if (!el?.textContent) return '';
      const features = JSON.parse(el.textContent);
      return typeof features.accessToken === 'string' ? features.accessToken : '';
    } catch {
      return '';
    }
  }

  /**
   * @param {string} query
   * @param {Record<string, unknown>} variables
   */
  async #storefrontFetch(query, variables) {
    if (!this.shopDomain || !this.storefrontToken) {
      throw new Error('Storefront API is not configured (shop domain / access token missing)');
    }
    const response = await fetch(
      `https://${this.shopDomain}/api/${STOREFRONT_API_VERSION}/graphql.json`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Shopify-Storefront-Access-Token': this.storefrontToken,
        },
        body: JSON.stringify({ query, variables }),
      },
    );
    if (!response.ok) throw new Error(`Storefront API request failed: ${response.status}`);
    const body = await response.json();
    if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join(', '));
    return body.data;
  }
}
