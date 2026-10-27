// Everything Amazon.in-specific lives here: finding cards, reading product
// pages, and boiling a 1-2 MB product page down to a few KB of useful text.
// Amazon A/B tests layouts, so every selector list has fallbacks.

const Amazon = (() => {
  const CARD_SEL = 'div[data-component-type="s-search-result"][data-asin]';

  function getCards(root = document) {
    return [...root.querySelectorAll(CARD_SEL)].filter((c) => /^[A-Z0-9]{10}$/.test(c.dataset.asin || ''));
  }

  function getTitle(card) {
    const el = card.querySelector('[data-cy="title-recipe"] h2, h2');
    return (el?.textContent || '').trim().replace(/\s+/g, ' ');
  }

  // Where the badge goes: right under the title block, else top of the card.
  function injectionPoint(card) {
    const title = card.querySelector('[data-cy="title-recipe"]') || card.querySelector('h2')?.closest('div');
    if (title) return { parent: title.parentElement, before: title.nextSibling };
    const box = card.querySelector('.s-card-container, .puis-card-container') || card;
    return { parent: box, before: box.firstChild };
  }

  const productUrl = (asin) => `${location.origin}/dp/${asin}`;

  function isBlocked(status, html) {
    return (
      status === 503 ||
      html.includes('/errors/validateCaptcha') ||
      html.includes('Enter the characters you see below') ||
      html.length < 5000
    );
  }

  // Ordered by importance: when the total cap is hit, later sections are dropped.
  const SECTIONS = [
    ['Title', '#productTitle'],
    ['Price', '#corePriceDisplay_desktop_feature_div, #corePrice_feature_div, #apex_desktop'],
    ['Offers', '#vsxoffers_feature_div, #itembox-InstantBankDiscount, #sopp_feature_div, #applicablePromotionList_feature_div, #promoPriceBlockMessage_feature_div'],
    ['Returns and services', '#iconfarsdesktop_feature_div, #icon-farm-container, #RETURNS_POLICY, #productSupportAndReturnPolicy_feature_div'],
    ['Delivery', '#mir-layout-DELIVERY_BLOCK, #deliveryBlockMessage, #deliveryMessageMirId'],
    ['Availability', '#availability'],
    ['Seller', '#merchantInfoFeature_feature_div, #merchant-info, #tabular-buybox, #offerDisplayFeatures_desktop'],
    ['Warranty', '#warranty_feature_div, #productWarranty_feature_div'],
    ['Overview', '#productOverview_feature_div'],
    ['About this item', '#feature-bullets'],
    ['Details', '#productDetails_techSpec_section_1, #productDetails_detailBullets_sections1, #detailBullets_feature_div'],
    ['Description', '#productDescription'],
  ];
  const SECTION_CAP = 700;
  const TOTAL_CAP = 3500; // ~900 tokens: free tiers cap tokens per minute

  const squash = (s) => s.replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{2,}/g, '\n').trim();

  function textOf(el) {
    el.querySelectorAll('script, style, noscript, svg, iframe, img, input, select').forEach((n) => n.remove());
    // Drop repeated lines (Amazon renders prices and labels twice for a11y).
    const seen = new Set();
    return squash(el.textContent || '')
      .split('\n')
      .filter((l) => l.length > 1 && !seen.has(l) && seen.add(l))
      .join('\n');
  }

  function clean(html) {
    // Scripts and styles are ~70% of the page; cutting them before parsing
    // makes DOMParser several times faster.
    const slim = html
      .replace(/<script\b[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[\s\S]*?<\/style>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '');
    const doc = new DOMParser().parseFromString(slim, 'text/html');

    let out = '';
    for (const [label, sel] of SECTIONS) {
      const parts = [...doc.querySelectorAll(sel)].map(textOf).filter(Boolean);
      if (!parts.length) continue;
      const block = `## ${label}\n${parts.join('\n').slice(0, SECTION_CAP)}\n`;
      if (out.length + block.length > TOTAL_CAP) break;
      out += block;
    }
    if (out.length < 300) {
      const main = doc.querySelector('#centerCol, #dp-container, #ppd') || doc.body;
      out = main ? textOf(main).slice(0, TOTAL_CAP) : '';
    }
    return { text: out, rules: rules(out) };
  }

  // Deterministic facts we can read without an LLM; shown instantly while
  // the LLM answer is on its way.
  function rules(text) {
    const r = {};
    const ret = text.match(/(\d{1,2})\s*days?\s*(replacement|return|returnable)/i);
    if (/non[-\s]?returnable/i.test(text)) r.returns = 'Non-returnable';
    else if (ret) r.returns = `${ret[1]} days ${/replace/i.test(ret[2]) ? 'replacement' : 'return'}`;
    const warranty = text.match(/(\d+)\s*(year|month)s?\s*(?:manufacturer\s*)?warranty/i);
    if (warranty) r.warranty = warranty[0];
    return r;
  }

  return { getCards, getTitle, injectionPoint, productUrl, isBlocked, clean };
})();
