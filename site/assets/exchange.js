/* SCI Exchange public app: converter, order creation and order tracking.
 *
 * Loaded on /exchange and /orders. Plain ES5-ish JavaScript, no dependencies.
 * Server-side validation is authoritative; this only spares a visitor a round
 * trip that was always going to come back as a 400 (same rule as the contact
 * form). Order confirmation only ever happens after the server answers with a
 * real order id - a message that is shown before the send is a bug, and has
 * happened here before.
 *
 * xss: every value rendered from the server or from storage is written through
 * textContent, never innerHTML.
 */
(function () {
  'use strict';

  var RATES_URL = '/api/exchange/rates';
  var CALC_URL = '/api/exchange/calculate';
  var ORDERS_URL = '/api/exchange/orders';
  var LIST_URL = '/api/exchange/orders/list';
  var GUEST_KEY = 'sky_exchange_guest_orders';
  var FALLBACK_RATE = 128.5;
  // Mirror functions/exchange-lib/validate.mjs MAX_ORDER_AMOUNT.
  var MAX_ORDER_AMOUNT = 1e9;

  var state = {
    rates: null,
    direction: 'THB_TO_MMK',
    offline: false,
  };

  function $(sel) {
    return typeof document !== 'undefined' ? document.querySelector(sel) : null;
  }

  function fmt(value) {
    if (value === undefined || value === null || isNaN(value)) return '0';
    return Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  // Rates smaller than a cent (the MMK->THB direction, ~0.0078) must not be
  // rounded to 0.01; show them to full precision instead.
  function fmtRate(value) {
    if (value === undefined || value === null || isNaN(value)) return '0';
    if (Math.abs(value) < 0.01) return String(value);
    return Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  function api(path, options) {
    return fetch(path, options)
      .then(function (resp) {
        return resp
          .json()
          .then(function (body) {
            return { ok: resp.ok, status: resp.status, body: body };
          })
          .catch(function () {
            return { ok: false, status: resp.status, body: { error: 'Bad response from server' } };
          });
      })
      .catch(function () {
        return { ok: false, status: 0, body: { error: 'Could not reach the server' } };
      });
  }

  function showToast(message) {
    var toast = $('#toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(function () {
      toast.classList.remove('show');
    }, 2500);
  }

  function directionOf(direction) {
    return direction === 'THB_TO_MMK' ? 'THB' : 'MMK';
  }

  function receiveOf(direction) {
    return direction === 'THB_TO_MMK' ? 'MMK' : 'THB';
  }

  // rateUsed is stored per-direction: MMK per THB for THB_TO_MMK, THB per MMK
  // for MMK_TO_THB. Framing it as "1 THB = ... MMK" for a MMK-order was wrong.
  function rateSummary(rateUsed, direction) {
    if (!rateUsed) return '';
    return direction === 'THB_TO_MMK'
      ? '1 THB = ' + fmtRate(rateUsed) + ' MMK'
      : '1 MMK = ' + fmtRate(rateUsed) + ' THB';
  }

  function getGuestOrders() {
    try {
      var raw = window.localStorage.getItem(GUEST_KEY);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  function saveGuestOrder(entry) {
    var list = getGuestOrders().filter(function (item) {
      return item.id !== entry.id;
    });
    list.unshift({ id: entry.id, viewToken: entry.viewToken, createdAt: entry.createdAt || Date.now() });
    try {
      window.localStorage.setItem(GUEST_KEY, JSON.stringify(list.slice(0, 20)));
    } catch (e) {}
  }

  // --------------------------------------------------------- rates + converter

  // The rate input and the "1 THB = X MMK" display always use the live
  // thbToMmk rate in BOTH directions; MMK_TO_THB divides by it in calculate().
  // Returning the reciprocal here inverted the reset/empty-field result ~rate^2.
  function rateForDirection() {
    if (!state.rates) return FALLBACK_RATE;
    return state.rates.thbToMmk;
  }

  function setOrderFormOpen(isOpen) {
    var form = $('#order-form');
    if (!form) return;
    var submit = form.querySelector('button[type="submit"]');
    var status = form.querySelector('.form-status');
    if (submit) submit.disabled = !isOpen;
    if (!isOpen && status && status.getAttribute('data-state') !== 'success') {
      status.textContent = 'The exchange is currently closed. Orders cannot be placed right now.';
      status.setAttribute('data-state', 'error');
    }
    if (isOpen && status && status.getAttribute('data-state') === 'error' &&
        status.textContent.indexOf('currently closed') !== -1) {
      status.textContent = '';
      status.removeAttribute('data-state');
    }
  }

  function applyRates(data) {
    state.rates = data;
    state.offline = Boolean(data && data.source === 'offline');

    var pill = $('#calc-status');
    if (pill) {
      if (state.offline) {
        pill.textContent = 'Offline Rate';
        pill.setAttribute('data-state', 'offline');
      } else {
        pill.textContent = data.open ? 'Live Rate' : 'Exchange Closed';
        pill.setAttribute('data-state', data.open ? 'live' : 'closed');
      }
    }

    var display = $('#calc-rate-display');
    if (display) {
      display.textContent = '1 THB = ' + fmt(data.thbToMmk) + ' MMK';
    }

    var rateInput = $('#calc-rate-input');
    if (rateInput && rateInput.value === '') {
      rateInput.value = Number(data.thbToMmk).toFixed(2);
    }

    var method = $('#order-method');
    if (method && data.channels && data.channels.length) {
      method.textContent = '';
      data.channels.forEach(function (channel) {
        var option = document.createElement('option');
        option.value = channel.id;
        option.textContent = channel.name;
        method.appendChild(option);
      });
    }

    var levels = $('#order-level');
    if (levels && data.levels && data.levels.length) {
      levels.textContent = '';
      data.levels.forEach(function (level) {
        var option = document.createElement('option');
        option.value = level.id;
        option.textContent = level.name;
        levels.appendChild(option);
      });
    }

    // Offline fallback is not orderable: no live channels/levels and no open flag.
    setOrderFormOpen(Boolean(data.open) && !state.offline);
  }

  function loadRates() {
    api(RATES_URL)
      .then(function (result) {
        if (result.ok && result.body && result.body.thbToMmk) {
          applyRates(result.body);
        } else {
          enterOffline();
        }
      })
      .catch(function () {
        enterOffline();
      });
  }

  function enterOffline() {
    applyRates({
      open: false,
      thbToMmk: Number((window.localStorage && window.localStorage.getItem('SCI_DEFAULT_RATE')) || FALLBACK_RATE),
      mmkToThb: FALLBACK_RATE ? 1 / FALLBACK_RATE : 0,
      updatedAt: null,
      source: 'offline',
      minimums: { THB: 100, MMK: 10000 },
      levels: [],
      channels: [],
    });
  }

  // --------------------------------------------------------------- converter

  function syncBadges() {
    var thbToMmk = state.direction === 'THB_TO_MMK';
    var sendCode = $('#calc-send-code');
    var receiveCode = $('#calc-receive-code');
    var sendBadge = $('#calc-send-badge');
    var receiveBadge = $('#calc-receive-badge');
    if (sendCode) sendCode.textContent = thbToMmk ? 'THB' : 'MMK';
    if (receiveCode) receiveCode.textContent = thbToMmk ? 'MMK' : 'THB';
    if (sendBadge) sendBadge.textContent = thbToMmk ? 'Thai Baht' : 'Myanmar Kyat';
    if (receiveBadge) receiveBadge.textContent = thbToMmk ? 'Myanmar Kyat' : 'Thai Baht';

    var field = $('#order-direction');
    if (field) field.value = state.direction;
  }

  function calculate() {
    var sendInput = $('#calc-send-amount');
    var receiveInput = $('#calc-receive-amount');
    var rateInput = $('#calc-rate-input');
    var sendVal = sendInput ? parseFloat(sendInput.value) || 0 : 0;
    var rate = rateInput ? parseFloat(rateInput.value) : rateForDirection();
    if (isNaN(rate) || rate <= 0) rate = rateForDirection();
    var receive = 0;
    if (state.direction === 'THB_TO_MMK') receive = Math.round(sendVal * rate);
    else receive = rate > 0 ? Math.round(sendVal / rate * 100) / 100 : 0;
    if (receiveInput) receiveInput.value = fmt(receive);

    var display = $('#calc-rate-display');
    if (display) display.textContent = '1 THB = ' + fmt(rate) + ' MMK';

    var amountInput = $('#order-amount');
    if (amountInput && document.activeElement !== amountInput) {
      amountInput.value = sendVal ? String(sendVal) : '';
    }
    updateMinHint();
  }

  function updateMinHint() {
    var minimums = (state.rates && state.rates.minimums) || { THB: 100, MMK: 10000 };
    var min = state.direction === 'THB_TO_MMK' ? minimums.THB : minimums.MMK;
    var hint = $('#order-min-hint');
    if (hint) hint.textContent = 'Minimum ' + fmt(min) + (state.direction === 'THB_TO_MMK' ? ' THB' : ' MMK');
  }

  function swapDirection() {
    state.direction = state.direction === 'THB_TO_MMK' ? 'MMK_TO_THB' : 'THB_TO_MMK';
    var sendInput = $('#calc-send-amount');
    if (sendInput) sendInput.value = state.direction === 'THB_TO_MMK' ? '5000' : '10000';
    syncBadges();
    calculate();
  }

  function wireConverter() {
    syncBadges();
    calculate();

    var sendInput = $('#calc-send-amount');
    var swapBtn = $('#calc-swap-btn');
    var rateInput = $('#calc-rate-input');
    var resetBtn = $('#calc-reset-rate');

    if (sendInput) sendInput.addEventListener('input', calculate);
    if (rateInput) {
      rateInput.addEventListener('input', function () {
        var val = parseFloat(rateInput.value);
        if (!isNaN(val) && val > 0) calculate();
      });
    }
    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        if (rateInput) rateInput.value = Number(rateForDirection()).toFixed(2);
        calculate();
        showToast('Rate reset to the live rate');
      });
    }
    if (swapBtn) swapBtn.addEventListener('click', swapDirection);

    // Deep links keep working: ?amount= / ?from=THB|MMK prefill the converter.
    if (window.location && window.location.search) {
      try {
        var params = new URLSearchParams(window.location.search);
        var amount = params.get('amount') || params.get('send');
        if (amount && !isNaN(parseFloat(amount)) && sendInput) {
          sendInput.value = String(parseFloat(amount));
        }
        var from = params.get('from');
        if (from && from.toUpperCase() === 'MMK') state.direction = 'MMK_TO_THB';
        else if (from && from.toUpperCase() === 'THB') state.direction = 'THB_TO_MMK';
        if (amount || from) {
          syncBadges();
          calculate();
          if (sendInput) sendInput.focus();
        }
      } catch (e) {}
    }
  }

  // ------------------------------------------------------------ order creation

  function wireOrderForm() {
    var form = $('#order-form');
    if (!form) return;

    var honeypot = form.elements.company;
    if (honeypot) honeypot.disabled = true;

    var directions = form.elements.direction;
    if (directions) {
      directions.value = state.direction;
      directions.addEventListener('change', function () {
        if (directions.value === 'MMK_TO_THB' || directions.value === 'THB_TO_MMK') {
          state.direction = directions.value;
          syncBadges();
          var sendInput = $('#calc-send-amount');
          if (sendInput) sendInput.value = directions.value === 'MMK_TO_THB' ? '10000' : '5000';
          calculate();
        }
      });
    }

    var amountField = form.elements.amount;
    if (amountField) {
      amountField.addEventListener('input', function () {
        var sendInput = $('#calc-send-amount');
        if (sendInput) sendInput.value = amountField.value;
        calculate();
      });
      amountField.addEventListener('blur', function () {
        var sendInput = $('#calc-send-amount');
        if (sendInput) sendInput.value = amountField.value;
        calculate();
      });
    }

    form.addEventListener('submit', function (event) {
      event.preventDefault();

      var data = {
        direction: state.direction,
        amount: parseFloat(form.elements.amount.value),
        method: form.elements.method.value,
        level: form.elements.level.value,
        senderName: form.elements.senderName.value.trim(),
        senderContact: form.elements.senderContact.value.trim(),
        accountNo: form.elements.accountNo ? form.elements.accountNo.value.trim() : '',
        accountName: form.elements.accountName ? form.elements.accountName.value.trim() : '',
        note: form.elements.note ? form.elements.note.value.trim() : '',
        company: form.elements.company.value.trim()
      };

      var status = form.querySelector('.form-status');
      function setStatus(message, kind) {
        if (!status) return;
        status.textContent = message;
        if (kind) status.setAttribute('data-state', kind);
        else status.removeAttribute('data-state');
      }

      if (state.offline || (state.rates && state.rates.open === false)) {
        return setStatus('The exchange is currently closed. Orders cannot be placed right now.', 'error');
      }
      if (!isFinite(data.amount) || data.amount <= 0) return setStatus('Enter an amount to exchange.', 'error');
      if (data.amount > MAX_ORDER_AMOUNT) {
        return setStatus('Amount is too large.', 'error');
      }
      var minimums = (state.rates && state.rates.minimums) || { THB: 100, MMK: 10000 };
      var min = data.direction === 'THB_TO_MMK' ? minimums.THB : minimums.MMK;
      if (!isFinite(data.amount) || data.amount < min) {
        return setStatus('Minimum amount is ' + fmt(min) + ' for this direction.', 'error');
      }
      if (!data.method) return setStatus('Choose how you will pay.', 'error');
      if (!data.level) return setStatus('Choose a service level.', 'error');
      if (!data.senderName || !data.senderContact) {
        return setStatus('Your name and contact are required so we can confirm the transfer.', 'error');
      }

      var submit = form.querySelector('button[type="submit"]');
      if (submit) submit.disabled = true;
      setStatus('Creating your order...', 'pending');

      api(ORDERS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      })
        .then(function (result) {
          if (!result.ok) {
            throw new Error((result.body && result.body.error) || 'Could not create the order');
          }
          var body = result.body;
          if (body.discarded) {
            setStatus('Thank you. Your order was received.', 'success');
            return;
          }
          saveGuestOrder({ id: body.orderId, viewToken: body.viewToken, createdAt: Date.now() });
          showOrderCreated(body);
          setStatus('', null);
        })
        .catch(function (err) {
          setStatus(err.message || 'Could not create the order. Please try again.', 'error');
        })
        .then(function () {
          if (submit) submit.disabled = false;
        });
    });
  }

  function showOrderCreated(body) {
    var panel = $('#order-created');
    var form = $('#order-form');
    if (form) form.hidden = true;
    if (!panel) return;

    panel.hidden = false;
    panel.querySelector('[data-ref]').textContent = body.reference;
    panel.querySelector('[data-amount]').textContent = fmt(body.amount) + ' ' + directionOf(body.direction);
    panel.querySelector('[data-receive]').textContent = fmt(body.receiveAmount) + ' (' + receiveOf(body.direction) + ')';
    panel.querySelector('[data-rate]').textContent = rateSummary(body.rateUsed, body.direction);

    var track = panel.querySelector('[data-track]');
    var href = '/orders?id=' + encodeURIComponent(body.orderId) + '#token=' + encodeURIComponent(body.viewToken);
    track.setAttribute('href', href);

    var copy = panel.querySelector('[data-copy-link]');
    if (copy) {
      copy.addEventListener('click', function (e) {
        e.preventDefault();
        (navigator.clipboard ? navigator.clipboard.writeText('https://skycreation.dev' + href) : Promise.reject(new Error('no clipboard')))
          .then(function () { showToast('Tracking link copied'); })
          .catch(function () {
            var t = document.createElement('textarea');
            t.value = 'https://skycreation.dev' + href;
            document.body.appendChild(t);
            t.select();
            document.execCommand('copy');
            document.body.removeChild(t);
            showToast('Tracking link copied');
          });
      });
    }
  }

  // -------------------------------------------------------------- order tacking

  var TIMELINE = [
    { status: 'PENDING', label: 'Order created' },
    { status: 'APPROVED', label: 'Payment confirmed' },
    { status: 'COMPLETED', label: 'Payout sent' },
  ];

  var proofObjectUrl = null;

  function revokeProofUrl(url) {
    if (url && typeof URL !== 'undefined' && URL.revokeObjectURL) {
      URL.revokeObjectURL(url);
    }
  }

  function statusBadge(status) {
    var badge = document.createElement('span');
    badge.className = 'ex-status-badge';
    badge.setAttribute('data-status', status || 'UNKNOWN');
    badge.textContent = status || 'UNKNOWN';
    return badge;
  }

  function statusIndex(status) {
    var idx = TIMELINE.findIndex(function (step) { return step.status === status; });
    return status === 'REJECTED' ? -1 : (idx === -1 ? 0 : idx);
  }

  function renderTimeline(status, container) {
    container.textContent = '';
    if (status === 'REJECTED') {
      var rejected = document.createElement('p');
      rejected.className = 'status-inline';
      rejected.textContent = 'This order was rejected. Contact us for details.';
      container.appendChild(rejected);
      return;
    }
    var current = statusIndex(status);
    TIMELINE.forEach(function (step, i) {
      var item = document.createElement('div');
      var done = i <= current;
      item.className = 'ex-timeline-step' + (done ? ' ex-timeline-done' : '');
      var dot = document.createElement('span');
      dot.className = 'ex-timeline-dot';
      var label = document.createElement('span');
      label.textContent = step.label;
      item.appendChild(dot);
      item.appendChild(label);
      container.appendChild(item);
    });
  }

  function renderOrderCard(order, anchor) {
    var card = document.createElement('article');
    card.className = 'card ex-order-card';

    var head = document.createElement('div');
    head.className = 'ex-order-card-head';
    var ref = document.createElement('strong');
    ref.textContent = order.reference || order.id;
    head.appendChild(ref);
    head.appendChild(statusBadge(order.status));
    card.appendChild(head);

    var line = document.createElement('p');
    line.className = 'ex-order-card-line';
    line.textContent = order.isRedacted
      ? 'Private details are available from your tracking link.'
      : fmt(order.amount) + ' ' + directionOf(order.direction) +
        ' \u2192 ' + fmt(order.receiveAmount) + ' ' + receiveOf(order.direction) +
        (order.rateUsed ? ' @ ' + rateSummary(order.rateUsed, order.direction) : '');
    card.appendChild(line);

    var meta = document.createElement('p');
    meta.className = 'ex-order-card-line muted';
    meta.textContent = (order.createdAt || '').replace('T', ' ').slice(0, 16) + (order.method ? ' \u00b7 ' + order.method : '');
    card.appendChild(meta);

    var view = document.createElement('a');
    view.className = 'btn btn-ghost';
    view.href = anchor;
    view.textContent = 'View order';
    card.appendChild(view);

    var list = $('#guest-orders-list');
    if (list) list.appendChild(card);
  }

  function renderEmptyOrders() {
    var list = $('#guest-orders-list');
    if (!list) return;
    list.textContent = '';
    var empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No orders yet. Create one on the exchange page and it will appear here.';
    list.appendChild(empty);
  }

  function wireOrdersList() {
    var list = $('#guest-orders-list');
    if (!list) return;
    var guests = getGuestOrders();
    if (!guests.length) {
      renderEmptyOrders();
      return;
    }
    list.textContent = '';
    api(LIST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orders: guests.map(function (guest) { return { id: guest.id }; }) })
    }).then(function (result) {
      if (!result.ok || !Array.isArray(result.body.orders)) {
        renderEmptyOrders();
        return;
      }
      var rendered = 0;
      result.body.orders.forEach(function (order) {
        if (!order) return;
        var guest = guests.find(function (g) { return g.id === order.id; });
        var anchor = '/orders?id=' + encodeURIComponent(order.id) +
          (guest && guest.viewToken ? '#token=' + encodeURIComponent(guest.viewToken) : '');
        renderOrderCard(order, anchor);
        rendered += 1;
      });
      if (!rendered) renderEmptyOrders();
    }).catch(function () {
      renderEmptyOrders();
    });
  }

  function trackingTokenFromLocation() {
    var params = new URLSearchParams(window.location.search || '');
    var legacy = params.get('token');
    var fragment = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
    var token = fragment.get('token') || legacy || '';
    if (legacy && window.history && window.history.replaceState) {
      params.delete('token');
      var query = params.toString();
      window.history.replaceState(null, '', (window.location.pathname || '/orders') + (query ? '?' + query : '') + '#token=' + encodeURIComponent(legacy));
    }
    return token;
  }

  function wireOrderDetail() {
    var panel = $('#order-detail');
    if (!panel) return;
    var params = new URLSearchParams(window.location.search);
    var id = params.get('id');
    var token = trackingTokenFromLocation();
    if (!id) {
      panel.hidden = true;
      return;
    }

    api(ORDERS_URL + '/' + encodeURIComponent(id), {
      headers: token ? { 'X-View-Token': token } : {}
    }).then(function (result) {
      var order = result.ok && result.body;
      if (!order) {
        panel.textContent = 'We could not find that order. Check the link or contact us.';
        return;
      }
      renderDetail(panel, order, token);
    }).catch(function () {
      panel.textContent = 'Could not reach the server. Try again in a moment.';
    });
  }

  function renderDetail(panel, order, token) {
    revokeProofUrl(proofObjectUrl);
    proofObjectUrl = null;
    panel.textContent = '';

    var head = document.createElement('div');
    head.className = 'ex-order-card-head';
    var ref = document.createElement('h2');
    ref.textContent = order.reference || order.id;
    head.appendChild(ref);
    head.appendChild(statusBadge(order.status));
    panel.appendChild(head);

    if (!order.isRedacted) {
      var amount = document.createElement('p');
      amount.className = 'ex-order-card-line';
      amount.textContent = fmt(order.amount) + ' ' + directionOf(order.direction) +
        ' \u2192 ' + fmt(order.receiveAmount) + ' ' + receiveOf(order.direction) +
        ' @ ' + rateSummary(order.rateUsed, order.direction);
      panel.appendChild(amount);
    }

    var timeline = document.createElement('div');
    timeline.className = 'ex-timeline';
    panel.appendChild(timeline);
    renderTimeline(order.status, timeline);

    if (!order.isRedacted) {
      var details = document.createElement('dl');
      details.className = 'ex-details';
      [
        ['Recipient details', [order.senderName, order.senderContact].filter(Boolean).join(' \u00b7 ')],
        ['Account', [order.accountName, order.accountNo].filter(Boolean).join(' \u00b7 ') || '\u2014'],
        ['Method', order.method || '\u2014'],
        ['Service level', order.level || '\u2014'],
        ['Your note', order.note || '\u2014'],
        ['Created', (order.createdAt || '').replace('T', ' ').slice(0, 16)]
      ].forEach(function (pair) {
        var dt = document.createElement('dt');
        dt.textContent = pair[0];
        var dd = document.createElement('dd');
        dd.textContent = pair[1];
        details.appendChild(dt);
        details.appendChild(dd);
      });
      panel.appendChild(details);
    }

    if (order.isRedacted || !token) return;

    var proofBox = document.createElement('div');
    proofBox.className = 'ex-proof';
    var proofTitle = document.createElement('h3');
    proofTitle.textContent = 'Proof of payment';
    proofBox.appendChild(proofTitle);

    if (order.hasProof) {
      var img = document.createElement('img');
      img.className = 'ex-proof-img';
      img.alt = 'Proof of payment';
      img.hidden = true;
      fetch(ORDERS_URL + '/' + encodeURIComponent(order.id) + '/proof', { headers: { 'X-View-Token': token } })
        .then(function (resp) {
          if (!resp.ok) throw new Error('nope');
          return resp.blob();
        })
        .then(function (blob) {
          revokeProofUrl(proofObjectUrl);
          proofObjectUrl = URL.createObjectURL(blob);
          img.src = proofObjectUrl;
          img.hidden = false;
        })
        .catch(function () {
          img.hidden = true;
        });
      panel.appendChild(img);
    } else if (order.status === 'PENDING') {
      var p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'Upload your payment receipt so we can confirm the transfer.';
      proofBox.appendChild(p);

      var fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/jpeg,image/png,image/webp';
      proofBox.appendChild(fileInput);

      var status = document.createElement('p');
      status.className = 'form-status';
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      proofBox.appendChild(status);

      fileInput.addEventListener('change', function () {
        var file = fileInput.files && fileInput.files[0];
        if (!file) return;
        fileInput.disabled = true;
        status.setAttribute('data-state', 'pending');
        status.textContent = 'Uploading...';
        compressImage(file)
          .then(function (payload) {
            return api(ORDERS_URL + '/' + encodeURIComponent(order.id) + '/proof', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-View-Token': token },
              body: JSON.stringify(payload)
            });
          })
          .then(function (result) {
            if (!result.ok) throw new Error((result.body && result.body.error) || 'Upload failed');
            status.setAttribute('data-state', 'success');
            status.textContent = 'Proof uploaded. We will review it shortly.';
            setTimeout(function () { window.location.reload(); }, 1200);
          })
          .catch(function (err) {
            fileInput.disabled = false;
            status.setAttribute('data-state', 'error');
            status.textContent = err.message || 'Upload failed. Try a JPEG or PNG under 5 MB.';
          });
      });
    }
    panel.appendChild(proofBox);
  }

  function compressImage(file) {
    return new Promise(function (resolve, reject) {
      if (!window.FileReader || !document.createElement('canvas').getContext) {
        reject(new Error('Your browser cannot compress images. Use a JPEG under 5 MB.'));
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        reject(new Error('Image is over 5 MB. Compress it and try again.'));
        return;
      }
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('Could not read the file')); };
      reader.onload = function () {
        var image = new Image();
        image.onerror = function () { reject(new Error('Not a readable image')); };
        image.onload = function () {
          var scale = Math.min(1, 1600 / Math.max(image.width, image.height));
          var canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(image.width * scale));
          canvas.height = Math.max(1, Math.round(image.height * scale));
          canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
          var dataBase64 = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
          resolve({ mimeType: 'image/jpeg', fileName: file.name || 'proof.jpg', dataBase64: dataBase64 });
        };
        image.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // ------------------------------------------------------------------ init

  function init() {
    if ($('#exchange-app')) {
      loadRates();
      wireConverter();
      wireOrderForm();
    }
    if ($('#orders-page')) {
      wireOrdersList();
      wireOrderDetail();
    }
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  // Exposed for the behavioural tests. These are the same order entries the
  // renderer already keeps in memory and localStorage under GUEST_KEY, so a
  // same-origin script could read them anyway; hiding them from the test hook
  // would be security theatre and would blank out the viewToken assertions.
  if (typeof window !== 'undefined') {
    window.SKY_EXCHANGE = { init: init, state: state, getGuestOrders: getGuestOrders };
  }
})();
