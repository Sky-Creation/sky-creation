/* Site-wide admin panel (site/admin.html) for skycreation.dev.
 *
 * Backed by functions/admin.mjs behind /api/admin/*. Login is username or
 * email + password; the panel holds a 15-minute HMAC access token in memory.
 * The httpOnly refresh cookie rotates it on reload and every 10 minutes while
 * the dashboard is open.
 *
 * Modules: Dashboard, Exchange (orders + rates), Posts, Settings, Audit log,
 * Account. Every destructive action goes through confirmPanel(); every status
 * change uses textContent, never innerHTML - server data is untrusted.
 *
 * Real security lives server-side; this file only ever *shows* what the API
 * confirms. A 401 anywhere drops the token and returns to the login screen.
 */
(function () {
  'use strict';

  var accessToken = null;
  var refreshTimer = null;
  var currentTab = 'dashboard';

  var MODULES = ['dashboard', 'exchange', 'posts', 'settings', 'audit', 'account'];

  function $(sel) {
    return document.querySelector(sel);
  }

  function fmt(value) {
    if (value === null || value === undefined || isNaN(value)) return '0';
    return Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  // Rates smaller than a cent (the MMK->THB direction, ~0.0078) must not be
  // rounded to 0.01; show them to full precision instead.
  function fmtRate(value) {
    if (value === null || value === undefined || isNaN(value)) return '0';
    if (Math.abs(value) < 0.01) return String(value);
    return Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  function dateLabel(value) {
    if (!value) return '';
    var parsed = new Date(value);
    if (isNaN(parsed.getTime())) return String(value);
    return parsed.toLocaleString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }

  function directionOf(direction) {
    return direction === 'THB_TO_MMK' ? 'THB' : 'MMK';
  }

  function receiveOf(direction) {
    return direction === 'THB_TO_MMK' ? 'MMK' : 'THB';
  }

  // rateUsed is stored per-direction: MMK per THB for THB_TO_MMK, THB per MMK
  // for MMK_TO_THB. One hard-coded "1 THB = X MMK" frame misread every MMK order.
  function rateSummary(rateUsed, direction) {
    if (!rateUsed) return '';
    return direction === 'THB_TO_MMK'
      ? '1 THB = ' + fmtRate(rateUsed) + ' MMK'
      : '1 MMK = ' + fmtRate(rateUsed) + ' THB';
  }

  function getToken() {
    return accessToken;
  }
  function storeToken(token) {
    accessToken = token || null;
  }

  /* Authenticated JSON request. 401 means the session is gone: drop the token
   * and show the login screen. */
  function apiAdmin(path, options) {
    options = options || {};
    options.headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    var token = getToken();
    if (token) options.headers.Authorization = 'Bearer ' + token;

    return fetch(path, options)
      .then(function (resp) {
        return resp.json()
          .then(function (body) { return { ok: resp.ok, status: resp.status, body: body }; })
          .catch(function () { return { ok: false, status: resp.status, body: { error: 'Bad response from server' } }; });
      })
      .then(function (result) {
        if (result.status === 401) {
          storeToken(null);
          showLogin('Your session has expired. Sign in again.');
        }
        return result;
      })
      .catch(function () { return { ok: false, status: 0, body: { error: 'Could not reach the server' } }; });
  }

  function showLogin(message) {
    var loginView = $('#admin-login');
    var adminView = $('#admin-app');
    if (loginView) loginView.hidden = false;
    if (adminView) adminView.hidden = true;
    var status = $('#admin-login-status');
    if (status && message) {
      status.textContent = message;
      status.setAttribute('data-state', 'error');
    }
  }

  function showDashboard() {
    var loginView = $('#admin-login');
    var adminView = $('#admin-app');
    if (loginView) loginView.hidden = true;
    if (adminView) adminView.hidden = false;
    switchTab(currentTab);
  }

  // ------------------------------------------------------------------ login

  function wireLogin() {
    var form = $('#admin-login-form');
    if (!form) return;
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var identifier = form.elements.identifier.value.trim();
      var password = form.elements.password.value;
      var status = $('#admin-login-status');
      var submit = form.querySelector('button[type="submit"]');
      function setStatus(message, kind) {
        if (!status) return;
        status.textContent = message;
        if (kind) status.setAttribute('data-state', kind);
        else status.removeAttribute('data-state');
      }
      if (!identifier || !password) {
        setStatus('Enter your email or username and password.', 'error');
        return;
      }
      if (submit) submit.disabled = true;
      setStatus('Signing in...', 'pending');

      apiAdmin('/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ identifier: identifier, password: password })
      })
        .then(function (result) {
          if (!result.ok) {
            throw new Error((result.body && result.body.error) || 'Sign in failed');
          }
          storeToken(result.body.accessToken);
          setStatus('', null);
          showDashboard();
          startRefreshLoop();
        })
        .catch(function (err) {
          setStatus(err.message || 'Sign in failed.', 'error');
        })
        .finally(function () {
          if (submit) submit.disabled = false;
        });
    });
  }

  function wireLogout() {
    var button = $('#admin-logout-btn');
    if (!button) return;
    button.addEventListener('click', function () {
      // Stop the refresh loop before the token is dropped; an orphan interval
      // kept pinging /api/admin/refresh every 10 minutes after sign-out.
      clearInterval(refreshTimer);
      refreshTimer = null;
      apiAdmin('/api/admin/logout', { method: 'POST' }).finally(function () {
        storeToken(null);
        showLogin('Signed out.');
      });
    });
  }

  // ------------------------------------------------------------------ tabs

  function panelFor(name) {
    return $('#admin-panel-' + name);
  }

  function switchTab(name) {
    if (MODULES.indexOf(name) === -1) name = 'dashboard';
    currentTab = name;
    Array.prototype.forEach.call(document.querySelectorAll('[data-admin-tab]'), function (btn) {
      var active = btn.getAttribute('data-admin-tab') === name;
      if (active) {
        if (btn.classList) btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');
      } else {
        if (btn.classList) btn.classList.remove('active');
        btn.setAttribute('aria-selected', 'false');
      }
    });
    MODULES.forEach(function (id) {
      var panel = panelFor(id);
      if (panel) panel.hidden = id !== name;
    });
    loadByName(name);
  }

  function wireTabs() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-admin-tab]'), function (btn) {
      btn.addEventListener('click', function () {
        switchTab(btn.getAttribute('data-admin-tab'));
      });
    });
  }

  function loadByName(name) {
    if (name === 'dashboard') loadDashboard();
    else if (name === 'exchange') loadExchange();
    else if (name === 'posts') loadPosts();
    else if (name === 'settings') loadSettings();
    else if (name === 'audit') loadAudit();
    else if (name === 'account') loadAccount();
  }

  // -------------------------------------------------------------- dashboard

  var dashFrom = '';
  var dashTo = '';
  var dashStatus = '';

  function dashboardQuery() {
    var parts = [];
    if (dashFrom) parts.push('from=' + encodeURIComponent(dashFrom));
    if (dashTo) parts.push('to=' + encodeURIComponent(dashTo));
    if (dashStatus) parts.push('status=' + encodeURIComponent(dashStatus));
    return parts.length ? '?' + parts.join('&') : '';
  }

  function loadDashboard() {
    var panel = panelFor('dashboard');
    if (!panel) return;
    panel.textContent = '';
    panel.appendChild(message('Loading...'));

    apiAdmin('/api/admin/dashboard' + dashboardQuery()).then(function (result) {
      panel.textContent = '';
      if (!result.ok || !result.body) {
        panel.appendChild(message((result.body && result.body.error) || 'Could not load the dashboard.'));
        return;
      }
      var s = result.body.stats || {};
      var r = result.body.rate || {};

      panel.appendChild(dashboardFilters());

      var cards = [
        ['Orders', fmt(s.total)],
        ['Pending', fmt(s.counts && s.counts.PENDING)],
        ['Approved', fmt(s.counts && s.counts.APPROVED)],
        ['Completed', fmt(s.counts && s.counts.COMPLETED)],
        ['Rejected', fmt(s.counts && s.counts.REJECTED)],
        ['Total volume (MMK)', fmt(s.volume)],
        ['Pending volume (MMK)', fmt(s.pendingVolume)]
      ];
      var grid = document.createElement('div');
      grid.className = 'admin-stats-grid';
      cards.forEach(function (pair) {
        var card = document.createElement('div');
        card.className = 'card ex-order-card';
        var num = document.createElement('div');
        num.className = 'admin-stat-number';
        num.textContent = pair[1];
        var label = document.createElement('div');
        label.className = 'muted';
        label.textContent = pair[0];
        card.appendChild(num);
        card.appendChild(label);
        grid.appendChild(card);
      });
      panel.appendChild(grid);

      if (r.open !== undefined) {
        var rateLine = document.createElement('p');
        rateLine.className = 'ex-order-card-line';
        rateLine.textContent = 'Rate: 1 THB = ' + fmt(r.thbToMmk) + ' MMK \u00b7 ' +
          (r.open ? 'exchange open' : 'exchange CLOSED');
        panel.appendChild(rateLine);
      }

      appendSeriesChart(panel, s.series || []);
      appendRateHistory(panel, result.body.recentRateHistory);

      var posts = result.body.posts || {};
      var postsLine = document.createElement('p');
      postsLine.className = 'muted';
      postsLine.textContent = 'Posts: ' + fmt(posts.company) + ' company, ' + fmt(posts.math) + ' math';
      panel.appendChild(postsLine);

      appendAuditList(panel, result.body.recentAudit, 'Recent activity');
    });
  }

  function dashboardFilters() {
    var row = document.createElement('div');
    row.className = 'admin-actions-row';

    var fromLabel = document.createElement('label');
    fromLabel.className = 'muted';
    fromLabel.textContent = 'From';
    var fromInput = document.createElement('input');
    fromInput.type = 'date';
    fromInput.className = 'admin-filter';
    fromInput.value = dashFrom;
    fromLabel.appendChild(fromInput);

    var toLabel = document.createElement('label');
    toLabel.className = 'muted';
    toLabel.textContent = 'To';
    var toInput = document.createElement('input');
    toInput.type = 'date';
    toInput.className = 'admin-filter';
    toInput.value = dashTo;
    toLabel.appendChild(toInput);

    var statusLabel = document.createElement('label');
    statusLabel.className = 'muted';
    statusLabel.textContent = 'Status';
    var select = document.createElement('select');
    select.className = 'admin-filter';
    [['', 'All'], ['PENDING', 'Pending'], ['APPROVED', 'Approved'], ['COMPLETED', 'Completed'], ['REJECTED', 'Rejected']]
      .forEach(function (opt) {
        var o = document.createElement('option');
        o.value = opt[0];
        o.textContent = opt[1];
        select.appendChild(o);
      });
    select.value = dashStatus;
    statusLabel.appendChild(select);

    var apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'btn btn-primary btn-sm';
    apply.textContent = 'Apply';
    apply.addEventListener('click', function () {
      dashFrom = fromInput.value || '';
      dashTo = toInput.value || '';
      dashStatus = select.value || '';
      loadDashboard();
    });

    row.appendChild(fromLabel);
    row.appendChild(toLabel);
    row.appendChild(statusLabel);
    row.appendChild(apply);
    return row;
  }

  function appendSeriesChart(container, series) {
    var head = document.createElement('h3');
    head.textContent = 'Daily volume';
    container.appendChild(head);
    if (!Array.isArray(series) || !series.length) {
      container.appendChild(message('No orders in this range.'));
      return;
    }
    var maxVol = 0;
    series.forEach(function (row) {
      if (row.volumeMmk > maxVol) maxVol = row.volumeMmk;
    });
    if (maxVol <= 0) maxVol = 1;

    var list = document.createElement('ul');
    list.className = 'admin-series';
    series.forEach(function (row) {
      var li = document.createElement('li');
      li.className = 'admin-series-row';
      var day = document.createElement('span');
      day.className = 'muted';
      day.textContent = row.day;
      var track = document.createElement('div');
      track.className = 'admin-series-bar-track';
      var bar = document.createElement('div');
      bar.className = 'admin-series-bar';
      bar.setAttribute('style', 'width:' + Math.max(2, Math.round((row.volumeMmk / maxVol) * 100)) + '%');
      track.appendChild(bar);
      var meta = document.createElement('span');
      meta.textContent = fmt(row.volumeMmk) + ' \u00b7 ' + fmt(row.count);
      li.appendChild(day);
      li.appendChild(track);
      li.appendChild(meta);
      list.appendChild(li);
    });
    container.appendChild(list);
  }

  function appendRateHistory(container, rows) {
    if (!Array.isArray(rows) || !rows.length) return;
    var head = document.createElement('h3');
    head.textContent = 'Recent rate updates';
    container.appendChild(head);
    var list = document.createElement('ul');
    list.className = 'admin-history';
    rows.forEach(function (entry) {
      var li = document.createElement('li');
      li.textContent = dateLabel(entry.updatedAt) + ' \u2014 1 THB = ' + fmt(entry.thbToMmk) + ' MMK' +
        (entry.actor ? ' (' + entry.actor + ')' : '');
      list.appendChild(li);
    });
    container.appendChild(list);
  }

  function appendAuditList(container, rows, title) {
    if (!Array.isArray(rows)) return;
    var head = document.createElement('h3');
    head.textContent = title;
    container.appendChild(head);
    var list = document.createElement('ul');
    list.className = 'admin-audit';
    rows.forEach(function (entry) {
      list.appendChild(auditRow(entry));
    });
    container.appendChild(list);
  }

  function auditRow(entry) {
    var li = document.createElement('li');
    var when = document.createElement('span');
    when.className = 'muted';
    when.textContent = dateLabel(entry.createdAt);
    var action = document.createElement('strong');
    action.textContent = entry.action;
    li.appendChild(when);
    li.appendChild(document.createTextNode('  '));
    li.appendChild(action);
    if (entry.actor) {
      var actor = document.createElement('span');
      actor.className = 'muted';
      actor.textContent = ' \u00b7 ' + entry.actor;
      li.appendChild(actor);
    }
    return li;
  }

  function message(text) {
    var p = document.createElement('p');
    p.className = 'muted';
    p.textContent = text;
    return p;
  }

  // ----------------------------------------------------------------- exchange

  var exchangeView = 'orders';
  var exchangeStatus = '';
  var exchangeQuery = '';
  var exchangePage = 1;

  function loadExchange() {
    var panel = panelFor('exchange');
    if (!panel) return;
    panel.textContent = '';
    var subnav = document.createElement('div');
    subnav.className = 'admin-subnav';
    var subNavItems = [
      ['orders', 'Orders'],
      ['rates', 'Rates']
    ];
    subNavItems.forEach(function (spec) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-ghost btn-sm' + (exchangeView === spec[0] ? ' active' : '');
      btn.textContent = spec[1];
      btn.addEventListener('click', function () {
        exchangeView = spec[0];
        loadExchange();
      });
      subnav.appendChild(btn);
    });
    panel.appendChild(subnav);
    if (exchangeView === 'orders') loadExchangeOrders(panel);
    else loadExchangeRates(panel);
  }

  function loadExchangeOrders(container) {
    container.appendChild(message('Loading orders...'));

    var filter = document.createElement('div');
    filter.className = 'admin-actions-row';

    var statusLabel = document.createElement('label');
    statusLabel.className = 'muted';
    statusLabel.textContent = 'Status ';
    var select = document.createElement('select');
    select.className = 'admin-filter';
    [['', 'All'], ['PENDING', 'Pending'], ['APPROVED', 'Approved'], ['COMPLETED', 'Completed'], ['REJECTED', 'Rejected']]
      .forEach(function (opt) {
        var o = document.createElement('option');
        o.value = opt[0];
        o.textContent = opt[1];
        select.appendChild(o);
      });
    select.value = exchangeStatus;
    statusLabel.appendChild(select);

    var searchLabel = document.createElement('label');
    searchLabel.className = 'muted';
    searchLabel.textContent = 'Search ';
    var search = document.createElement('input');
    search.type = 'search';
    search.className = 'admin-filter';
    search.placeholder = 'Reference, sender, method';
    search.value = exchangeQuery;
    searchLabel.appendChild(search);

    var apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'btn btn-primary btn-sm';
    apply.textContent = 'Apply';
    apply.addEventListener('click', function () {
      exchangeStatus = select.value;
      exchangeQuery = String(search.value || '').trim();
      exchangePage = 1;
      loadExchange();
    });

    var refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'btn btn-ghost btn-sm';
    refresh.textContent = 'Refresh';
    refresh.addEventListener('click', function () { loadExchange(); });

    filter.appendChild(statusLabel);
    filter.appendChild(searchLabel);
    filter.appendChild(apply);
    filter.appendChild(refresh);
    container.appendChild(filter);

    select.addEventListener('change', function () {
      exchangeStatus = select.value;
      exchangePage = 1;
      loadExchange();
    });

    var params = ['perPage=25', 'page=' + encodeURIComponent(String(exchangePage))];
    if (exchangeStatus) params.push('status=' + encodeURIComponent(exchangeStatus));
    if (exchangeQuery) params.push('q=' + encodeURIComponent(exchangeQuery));
    apiAdmin('/api/admin/exchange/orders?' + params.join('&')).then(function (result) {
      container.textContent = '';
      container.appendChild(filter);

      if (!result.ok || !Array.isArray(result.body.orders)) {
        container.appendChild(message('Could not load orders.'));
        return;
      }
      var rows = result.body.orders;
      var total = Number(result.body.total) || 0;
      var page = Number(result.body.page) || 1;
      var perPage = Number(result.body.perPage) || 25;
      var totalPages = Math.max(1, Math.ceil(total / perPage));

      if (!rows.length) {
        container.appendChild(message('No orders match.'));
        return;
      }
      rows.forEach(function (order) {
        container.appendChild(orderRow(order));
      });

      var pager = document.createElement('div');
      pager.className = 'admin-actions-row';
      var info = document.createElement('span');
      info.className = 'muted';
      info.textContent = 'Page ' + page + ' of ' + totalPages + ' \u00b7 ' + total + ' orders';
      pager.appendChild(info);
      var prev = document.createElement('button');
      prev.type = 'button';
      prev.className = 'btn btn-ghost btn-sm';
      prev.textContent = 'Previous';
      prev.disabled = page <= 1;
      prev.addEventListener('click', function () {
        exchangePage = Math.max(1, page - 1);
        loadExchange();
      });
      var next = document.createElement('button');
      next.type = 'button';
      next.className = 'btn btn-ghost btn-sm';
      next.textContent = 'Next';
      next.disabled = page >= totalPages;
      next.addEventListener('click', function () {
        exchangePage = page + 1;
        loadExchange();
      });
      pager.appendChild(prev);
      pager.appendChild(next);
      container.appendChild(pager);
    });
  }

  function orderRow(order) {
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
    line.textContent = fmt(order.amount) + ' ' + directionOf(order.direction) +
      ' \u2192 ' + fmt(order.receiveAmount) + ' ' + receiveOf(order.direction) +
      (order.rateUsed ? ' @ ' + rateSummary(order.rateUsed, order.direction) : '');
    card.appendChild(line);

    var meta = document.createElement('p');
    meta.className = 'ex-order-card-line muted';
    meta.textContent = [order.senderName, order.method, order.level, order.createdAt ? dateLabel(order.createdAt) : '']
      .filter(Boolean).join(' \u00b7 ');
    card.appendChild(meta);

    var actions = document.createElement('div');
    actions.className = 'ex-order-actions';

    var viewBtn = document.createElement('button');
    viewBtn.type = 'button';
    viewBtn.className = 'btn btn-ghost';
    viewBtn.textContent = 'View';
    viewBtn.addEventListener('click', function () {
      openOrderDetail(order.id);
    });
    actions.appendChild(viewBtn);

    appendOrderActionButtons(actions, order, function () { loadExchange(); });
    card.appendChild(actions);
    return card;
  }

  function appendOrderActionButtons(actions, order, after) {
    var buttons = [];
    if (order.status === 'PENDING') {
      buttons.push(['Approve', 'approve', 'btn btn-primary']);
      buttons.push(['Reject', 'reject', 'btn btn-ghost']);
    }
    if (order.status === 'APPROVED') {
      buttons.push(['Mark complete', 'complete', 'btn btn-primary']);
      buttons.push(['Reject', 'reject', 'btn btn-ghost']);
    }
    buttons.push(['Delete', 'delete', 'btn btn-ghost']);

    buttons.forEach(function (spec) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = spec[2];
      btn.textContent = spec[0];
      btn.addEventListener('click', function () {
        var run = function () {
          btn.disabled = true;
          apiAdmin('/api/admin/exchange/orders/' + encodeURIComponent(order.id) + '/' + spec[1], {
            method: 'POST',
            body: '{}'
          }).then(function (result) {
            if (!result.ok) {
              toast((result.body && result.body.error) || 'Action failed');
            } else {
              toast((spec[1] === 'delete' ? 'Deleted ' : 'Updated ') + (order.reference || order.id));
            }
            if (typeof after === 'function') after(spec[1], result);
          });
        };
        if (spec[1] === 'delete') {
          confirmPanel('Delete order ' + (order.reference || order.id) + '? This cannot be undone.').then(function (yes) {
            if (yes) run();
          });
        } else {
          run();
        }
      });
      actions.appendChild(btn);
    });
  }

  var detailProofUrl = null;

  function revokeDetailProof() {
    if (detailProofUrl && typeof URL !== 'undefined' && URL.revokeObjectURL) {
      URL.revokeObjectURL(detailProofUrl);
    }
    detailProofUrl = null;
  }

  var orderDetailKeyHandler = null;

  function closeOrderDetailOverlay(overlay) {
    if (orderDetailKeyHandler) {
      document.removeEventListener('keydown', orderDetailKeyHandler);
      orderDetailKeyHandler = null;
    }
    revokeDetailProof();
    if (!overlay) return;
    if (document.body && document.body.removeChild) document.body.removeChild(overlay);
    else if (overlay.parentNode && overlay.parentNode.removeChild) overlay.parentNode.removeChild(overlay);
  }

  function openOrderDetail(orderId) {
    apiAdmin('/api/admin/exchange/orders/' + encodeURIComponent(orderId)).then(function (result) {
      if (!result.ok || !result.body) {
        toast((result.body && result.body.error) || 'Could not load order');
        return;
      }
      showOrderDetailModal(result.body);
    });
  }

  function showOrderDetailModal(order) {
    revokeDetailProof();
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.setAttribute('data-admin-order-detail', '1');
    var box = document.createElement('div');
    box.className = 'modal admin-order-modal';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');

    var head = document.createElement('div');
    head.className = 'ex-order-card-head';
    var ref = document.createElement('strong');
    ref.textContent = order.reference || order.id;
    head.appendChild(ref);
    head.appendChild(statusBadge(order.status));
    box.appendChild(head);

    var details = document.createElement('dl');
    details.className = 'ex-details';
    var pairs = [
      ['Direction', directionOf(order.direction) + ' \u2192 ' + receiveOf(order.direction)],
      ['Amount', fmt(order.amount) + ' ' + directionOf(order.direction)],
      ['Receive', fmt(order.receiveAmount) + ' ' + receiveOf(order.direction)],
      ['Rate', order.rateUsed ? rateSummary(order.rateUsed, order.direction) : '\u2014'],
      ['Sender', order.senderName || '\u2014'],
      ['Contact', order.senderContact || '\u2014'],
      ['Account no.', order.accountNo || '\u2014'],
      ['Account name', order.accountName || '\u2014'],
      ['Note', order.note || '\u2014'],
      ['Fee', order.fee != null ? fmt(order.fee) : '\u2014'],
      ['Level', order.level || '\u2014'],
      ['Method', order.method || '\u2014'],
      ['Status', order.status || '\u2014'],
      ['Created', dateLabel(order.createdAt) || '\u2014'],
      ['Updated', dateLabel(order.updatedAt) || '\u2014'],
      ['Completed', dateLabel(order.completedAt) || '\u2014'],
      ['Has proof', order.hasProof ? 'Yes' : 'No'],
      ['Proof file', order.proofFileName || '\u2014']
    ];
    pairs.forEach(function (pair) {
      var dt = document.createElement('dt');
      dt.textContent = pair[0];
      var dd = document.createElement('dd');
      dd.textContent = pair[1];
      details.appendChild(dt);
      details.appendChild(dd);
    });

    var tokenDt = document.createElement('dt');
    tokenDt.textContent = 'View token';
    var tokenDd = document.createElement('dd');
    tokenDd.className = 'admin-token-row';
    var tokenCode = document.createElement('code');
    tokenCode.textContent = order.viewToken || '\u2014';
    tokenDd.appendChild(tokenCode);
    if (order.viewToken) {
      var copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'btn btn-ghost btn-sm';
      copyBtn.textContent = 'Copy';
      copyBtn.addEventListener('click', function () {
        copyText(order.viewToken);
      });
      tokenDd.appendChild(copyBtn);
    }
    details.appendChild(tokenDt);
    details.appendChild(tokenDd);
    box.appendChild(details);

    if (order.hasProof && order.viewToken) {
      var proofBox = document.createElement('div');
      proofBox.className = 'ex-proof';
      var proofTitle = document.createElement('h3');
      proofTitle.textContent = 'Proof of payment';
      proofBox.appendChild(proofTitle);
      var img = document.createElement('img');
      img.className = 'ex-proof-img';
      img.alt = 'Proof of payment';
      img.hidden = true;
      proofBox.appendChild(img);
      var proofStatus = document.createElement('p');
      proofStatus.className = 'muted';
      proofStatus.textContent = 'Loading proof...';
      proofBox.appendChild(proofStatus);
      box.appendChild(proofBox);

      fetch('/api/exchange/orders/' + encodeURIComponent(order.id) + '/proof', {
        headers: { 'X-View-Token': order.viewToken }
      })
        .then(function (resp) {
          if (!resp.ok) throw new Error('nope');
          return resp.blob();
        })
        .then(function (blob) {
          revokeDetailProof();
          detailProofUrl = URL.createObjectURL(blob);
          img.src = detailProofUrl;
          img.hidden = false;
          proofStatus.textContent = '';
        })
        .catch(function () {
          proofStatus.textContent = 'Could not load the proof image.';
        });
    }

    var actions = document.createElement('div');
    actions.className = 'ex-order-actions';
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn btn-ghost';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', function () {
      closeOrderDetailOverlay(overlay);
    });
    actions.appendChild(closeBtn);
    appendOrderActionButtons(actions, order, function (action) {
      closeOrderDetailOverlay(overlay);
      if (action === 'delete') loadExchange();
      else loadExchange();
    });
    box.appendChild(actions);

    overlay.appendChild(box);
    overlay.addEventListener('click', function (event) {
      if (event.target === overlay) closeOrderDetailOverlay(overlay);
    });
    if (orderDetailKeyHandler) document.removeEventListener('keydown', orderDetailKeyHandler);
    orderDetailKeyHandler = function (event) {
      if (event.key === 'Escape') closeOrderDetailOverlay(overlay);
    };
    document.addEventListener('keydown', orderDetailKeyHandler);
    if (document.body && document.body.appendChild) document.body.appendChild(overlay);
  }

  function copyText(text) {
    var done = function () { toast('Copied view token'); };
    var fail = function () { toast('Could not copy'); };
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () {
        fallbackCopy(text) ? done() : fail();
      });
      return;
    }
    if (fallbackCopy(text)) done();
    else fail();
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      if (document.body && document.body.appendChild) document.body.appendChild(ta);
      if (ta.select) ta.select();
      var ok = typeof document.execCommand === 'function' && document.execCommand('copy');
      if (document.body && document.body.removeChild) document.body.removeChild(ta);
      else if (ta.parentNode && ta.parentNode.removeChild) ta.parentNode.removeChild(ta);
      return Boolean(ok);
    } catch (err) {
      return false;
    }
  }

  function statusBadge(status) {
    var badge = document.createElement('span');
    badge.className = 'ex-status-badge';
    badge.setAttribute('data-status', status || 'UNKNOWN');
    badge.textContent = status || 'UNKNOWN';
    return badge;
  }

  function loadExchangeRates(container) {
    container.appendChild(message('Loading rates...'));
    apiAdmin('/api/admin/exchange/rates').then(function (result) {
      container.textContent = '';
      if (!result.ok || !result.body) {
        container.appendChild(message('Could not load rates.'));
        return;
      }
      var r = result.body;

      var current = document.createElement('p');
      current.className = 'ex-order-card-line';
      current.textContent = 'Current rate: 1 THB = ' + fmt(r.thbToMmk) + ' MMK ' +
        (r.open ? '(exchange open)' : '(exchange CLOSED)');
      container.appendChild(current);

      var form = document.createElement('form');
      form.className = 'admin-rate-form';
      var rateField = field('New THB \u2192 MMK rate', 'number', 'rate');
      rateField.input.min = '50';
      rateField.input.max = '500';
      form.appendChild(rateField.wrap);

      var openWrap = document.createElement('label');
      openWrap.className = 'admin-check';
      var openCheck = document.createElement('input');
      openCheck.type = 'checkbox';
      openCheck.checked = Boolean(r.open);
      openCheck.name = 'open';
      openWrap.appendChild(openCheck);
      openWrap.appendChild(document.createTextNode(' Exchange open'));
      form.appendChild(openWrap);

      var save = document.createElement('button');
      save.type = 'submit';
      save.className = 'btn btn-primary';
      save.textContent = 'Save rate';
      form.appendChild(save);

      var status = document.createElement('p');
      status.className = 'form-status';
      form.appendChild(status);

      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var body = { open: openCheck.checked };
        var raw = String(rateField.input.value || '').trim();
        if (raw) {
          var val = parseFloat(raw);
          if (!isFinite(val) || val < 50 || val > 500) {
            status.textContent = 'Rate must be between 50 and 500.';
            status.setAttribute('data-state', 'error');
            return;
          }
          body.thbToMmk = val;
        }
        save.disabled = true;
        status.textContent = 'Saving...';
        status.setAttribute('data-state', 'pending');
        apiAdmin('/api/admin/exchange/rates', { method: 'POST', body: JSON.stringify(body) })
          .then(function (res) {
            if (!res.ok) {
              status.textContent = (res.body && res.body.error) || 'Save failed';
              status.setAttribute('data-state', 'error');
            } else {
              status.textContent = 'Saved.';
              status.setAttribute('data-state', 'success');
              loadExchange();
            }
          })
          .finally(function () { save.disabled = false; });
      });
      container.appendChild(form);

      var history = document.createElement('div');
      history.className = 'mt-sm';
      var hTitle = document.createElement('h3');
      hTitle.textContent = 'Recent updates';
      history.appendChild(hTitle);
      var list = document.createElement('ul');
      list.className = 'admin-history';
      (r.history || []).forEach(function (entry) {
        var li = document.createElement('li');
        li.textContent = dateLabel(entry.updatedAt) + ' \u2014 1 THB = ' + fmt(entry.thbToMmk) + ' MMK' +
          (entry.actor ? ' (' + entry.actor + ')' : '');
        list.appendChild(li);
      });
      history.appendChild(list);
      container.appendChild(history);
    });
  }

  function field(label, type, name) {
    var wrap = document.createElement('label');
    wrap.className = 'field';
    var text = document.createElement('span');
    text.textContent = label;
    var input = document.createElement('input');
    input.type = type;
    input.name = name;
    input.step = 'any';
    input.min = '1';
    wrap.appendChild(text);
    wrap.appendChild(input);
    return { wrap: wrap, input: input };
  }

  // ------------------------------------------------------------------- posts

  function loadPosts() {
    var panel = panelFor('posts');
    if (!panel) return;
    panel.textContent = '';
    panel.appendChild(message('Loading posts...'));

    apiAdmin('/api/admin/posts').then(function (result) {
      panel.textContent = '';
      if (!result.ok || !result.body) {
        panel.appendChild(message((result.body && result.body.error) || 'Could not load posts.'));
        return;
      }
      ['company', 'math'].forEach(function (list) {
        panel.appendChild(postsSection(list, result.body[list] || []));
      });
    });
  }

  function postsSection(list, posts) {
    var section = document.createElement('div');
    section.className = 'mt-sm';

    var head = document.createElement('div');
    head.className = 'admin-actions-row';
    var title = document.createElement('h3');
    title.textContent = list === 'company' ? 'Company page' : 'A Noob Mathematician';
    head.appendChild(title);
    var add = document.createElement('button');
    add.type = 'button';
    add.className = 'btn btn-primary btn-sm';
    add.textContent = 'Add post';
    add.addEventListener('click', function () {
      section.appendChild(postEditor(list, null, function () { loadPosts(); }));
      add.disabled = true;
    });
    head.appendChild(add);
    section.appendChild(head);

    if (!posts.length) {
      section.appendChild(message('No posts yet.'));
      return section;
    }

    var ul = document.createElement('ul');
    ul.className = 'admin-posts';
    posts.forEach(function (post) {
      ul.appendChild(postCard(list, post));
    });
    section.appendChild(ul);
    return section;
  }

  function postCard(list, post) {
    var li = document.createElement('li');
    li.className = 'card post-admin-card';

    var when = document.createElement('p');
    when.className = 'post-date';
    when.textContent = post.date || '';
    li.appendChild(when);

    var body = document.createElement('p');
    body.className = 'post-text';
    body.textContent = post.text || '';
    li.appendChild(body);

    if (post.url) {
      var link = document.createElement('a');
      link.href = post.url;
      link.rel = 'noopener';
      link.textContent = 'View post';
      li.appendChild(link);
    }

    var actions = document.createElement('div');
    actions.className = 'ex-order-actions';
    var edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'btn btn-ghost btn-sm';
    edit.textContent = 'Edit';
    edit.addEventListener('click', function () {
      li.replaceWith(postEditor(list, post, function () { loadPosts(); }));
    });
    actions.appendChild(edit);

    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-ghost btn-sm';
    del.textContent = 'Delete';
    del.addEventListener('click', function () {
      confirmPanel('Delete this post? It will disappear from the public site.').then(function (yes) {
        if (!yes) return;
        apiAdmin('/api/admin/posts/' + list + '/' + encodeURIComponent(post.id), { method: 'DELETE' }).then(function (result) {
          if (!result.ok) toast((result.body && result.body.error) || 'Delete failed');
          else toast('Post deleted.');
          loadPosts();
        });
      });
    });
    actions.appendChild(del);
    li.appendChild(actions);
    return li;
  }

  function postEditor(list, post, done) {
    var wrap = document.createElement('div');
    wrap.className = 'card post-editor';

    var form = document.createElement('form');
    var dateField = field('Date (YYYY-MM-DD)', 'text', 'date');
    if (post) dateField.input.value = post.date;
    form.appendChild(dateField.wrap);

    var textLabel = document.createElement('label');
    textLabel.className = 'field';
    var textSpan = document.createElement('span');
    textSpan.textContent = 'Post text';
    var textArea = document.createElement('textarea');
    textArea.name = 'text';
    textArea.maxLength = 4000;
    textArea.rows = 4;
    if (post) textArea.value = post.text;
    textLabel.appendChild(textSpan);
    textLabel.appendChild(textArea);
    form.appendChild(textLabel);

    var urlField = field('Facebook URL (optional)', 'url', 'url');
    if (post) urlField.input.value = post.url || '';
    form.appendChild(urlField.wrap);

    var actions = document.createElement('div');
    actions.className = 'ex-order-actions';
    var save = document.createElement('button');
    save.type = 'submit';
    save.className = 'btn btn-primary btn-sm';
    save.textContent = post ? 'Save changes' : 'Create';
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-ghost btn-sm';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', done);
    actions.appendChild(save);
    actions.appendChild(cancel);
    var status = document.createElement('p');
    status.className = 'form-status';
    actions.appendChild(status);
    form.appendChild(actions);

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var payload = {
        date: dateField.input.value.trim(),
        text: textArea.value,
        url: urlField.input.value.trim()
      };
      if (!payload.date || !payload.text) {
        status.textContent = 'Date and text are required.';
        status.setAttribute('data-state', 'error');
        return;
      }
      save.disabled = true;
      status.textContent = 'Saving...';
      status.setAttribute('data-state', 'pending');
      var path = post
        ? '/api/admin/posts/' + list + '/' + encodeURIComponent(post.id)
        : '/api/admin/posts/' + list;
      apiAdmin(path, { method: post ? 'PUT' : 'POST', body: JSON.stringify(payload) })
        .then(function (result) {
          if (!result.ok) {
            status.textContent = (result.body && result.body.error) || 'Save failed';
            status.setAttribute('data-state', 'error');
            save.disabled = false;
          } else {
            toast(post ? 'Post updated.' : 'Post created.');
            done();
          }
        })
        .catch(function (err) {
          status.textContent = err.message || 'Save failed';
          status.setAttribute('data-state', 'error');
          save.disabled = false;
        });
    });

    wrap.appendChild(form);
    return wrap;
  }

  // ---------------------------------------------------------------- settings

  function loadSettings() {
    var panel = panelFor('settings');
    if (!panel) return;
    panel.textContent = '';
    panel.appendChild(message('Loading settings...'));

    apiAdmin('/api/admin/settings').then(function (result) {
      panel.textContent = '';
      if (!result.ok || !result.body) {
        panel.appendChild(message((result.body && result.body.error) || 'Could not load settings.'));
        return;
      }
      var s = result.body;

      var current = document.createElement('p');
      current.className = 'ex-order-card-line';
      current.textContent = 'Current live rate: 1 THB = ' + fmt(s.currentRate) + ' MMK';
      panel.appendChild(current);

      var form = document.createElement('form');
      form.className = 'admin-rate-form';

      var seedField = field('Default / live rate (also updates the live /exchange rate)', 'number', 'defaultRate');
      seedField.input.min = '50';
      seedField.input.max = '500';
      if (s.defaultRate) seedField.input.value = String(s.defaultRate);
      form.appendChild(seedField.wrap);

      var openWrap = document.createElement('label');
      openWrap.className = 'admin-check';
      var openCheck = document.createElement('input');
      openCheck.type = 'checkbox';
      openCheck.checked = Boolean(s.open);
      openCheck.name = 'open';
      openWrap.appendChild(openCheck);
      openWrap.appendChild(document.createTextNode(' Exchange open for orders'));
      form.appendChild(openWrap);

      var save = document.createElement('button');
      save.type = 'submit';
      save.className = 'btn btn-primary';
      save.textContent = 'Save settings';
      var status = document.createElement('p');
      status.className = 'form-status';
      form.appendChild(save);
      form.appendChild(status);

      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var body = { open: openCheck.checked };
        var val = parseFloat(seedField.input.value);
        if (seedField.input.value && (!isFinite(val) || val < 50 || val > 500)) {
          status.textContent = 'Default rate must be between 50 and 500.';
          status.setAttribute('data-state', 'error');
          return;
        }
        if (isFinite(val)) body.defaultRate = val;
        save.disabled = true;
        status.textContent = 'Saving...';
        status.setAttribute('data-state', 'pending');
        apiAdmin('/api/admin/settings', { method: 'POST', body: JSON.stringify(body) })
          .then(function (res) {
            if (!res.ok) {
              status.textContent = (res.body && res.body.error) || 'Save failed';
              status.setAttribute('data-state', 'error');
            } else {
              status.textContent = 'Saved.';
              status.setAttribute('data-state', 'success');
              if (res.body && res.body.currentRate != null) {
                current.textContent = 'Current live rate: 1 THB = ' + fmt(res.body.currentRate) + ' MMK';
              }
            }
          })
          .finally(function () { save.disabled = false; });
      });

      panel.appendChild(form);
    });
  }

  // ------------------------------------------------------------------- audit

  function loadAudit() {
    var panel = panelFor('audit');
    if (!panel) return;
    panel.textContent = '';
    panel.appendChild(message('Loading audit log...'));

    apiAdmin('/api/admin/audit').then(function (result) {
      panel.textContent = '';
      if (!result.ok || !Array.isArray(result.body.rows)) {
        panel.appendChild(message('Could not load the audit log.'));
        return;
      }
      var rows = result.body.rows;
      if (!rows.length) {
        panel.appendChild(message('No events recorded yet.'));
        return;
      }
      var list = document.createElement('ul');
      list.className = 'admin-audit';
      rows.forEach(function (entry) {
        list.appendChild(auditRow(entry));
      });
      panel.appendChild(list);
    });
  }

  // ----------------------------------------------------------------- account

  function loadAccount() {
    var panel = panelFor('account');
    if (!panel) return;
    panel.textContent = '';
    panel.appendChild(message('Loading account...'));

    apiAdmin('/api/admin/session').then(function (result) {
      panel.textContent = '';
      if (!result.ok || !result.body) {
        panel.appendChild(message('Could not load your account.'));
        return;
      }
      var who = result.body;

      var current = document.createElement('p');
      current.className = 'ex-order-card-line';
      current.textContent = 'Signed in as ' + (who.name || who.email) + ' (' + who.email + ')';
      panel.appendChild(current);

      var form = document.createElement('form');
      form.className = 'admin-rate-form';

      form.appendChild(field('Username', 'text', 'username').wrap);
      form.appendChild(field('Email', 'email', 'email').wrap);
      form.appendChild(field('Display name', 'text', 'name').wrap);
      var cur = field('Current password (required to save)', 'password', 'currentPassword');
      form.appendChild(cur.wrap);
      var next = field('New password (leave blank to keep)', 'password', 'newPassword');
      form.appendChild(next.wrap);

      var save = document.createElement('button');
      save.type = 'submit';
      save.className = 'btn btn-primary';
      save.textContent = 'Update account';
      var status = document.createElement('p');
      status.className = 'form-status';
      form.appendChild(save);
      form.appendChild(status);

      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var payload = { currentPassword: form.elements.currentPassword.value };
        var username = form.elements.username.value.trim();
        var email = form.elements.email.value.trim();
        var name = form.elements.name.value.trim();
        var newPassword = form.elements.newPassword.value;
        if (username) payload.username = username;
        if (email) payload.email = email;
        if (name) payload.name = name;
        if (newPassword) payload.newPassword = newPassword;
        save.disabled = true;
        status.textContent = 'Saving...';
        status.setAttribute('data-state', 'pending');
        apiAdmin('/api/admin/account', { method: 'PATCH', body: JSON.stringify(payload) })
          .then(function (res) {
            if (!res.ok) {
              status.textContent = (res.body && res.body.error) || 'Could not update';
              status.setAttribute('data-state', 'error');
            } else if (res.body && res.body.signedOut) {
              storeToken(null);
              clearInterval(refreshTimer);
              refreshTimer = null;
              showLogin('Password changed. Sign in with your new password.');
            } else {
              status.textContent = 'Account updated.';
              status.setAttribute('data-state', 'success');
              form.elements.currentPassword.value = '';
              form.elements.newPassword.value = '';
            }
          })
          .finally(function () { save.disabled = false; });
      });

      // Pre-fill the current values from the session data.
      var inputs = form.querySelectorAll('input[name="username"], input[name="email"], input[name="name"]');
      if (who.username && inputs.length) inputs[0].value = who.username;
      if (who.email && inputs.length) inputs[1].value = who.email;
      if (who.name && inputs.length) inputs[2].value = who.name;

      panel.appendChild(form);
    });
  }

  // ------------------------------------------------------------ shared bits

  function toast(msg) {
    var el = document.getElementById ? document.getElementById('admin-toast') : null;
    if (!el && document.createElement) {
      el = document.createElement('div');
      el.id = 'admin-toast';
      el.className = 'toast';
      if (document.body && document.body.appendChild) document.body.appendChild(el);
    }
    if (!el) return;
    el.textContent = msg;
    if (el.classList) el.classList.add('show');
    setTimeout(function () {
      if (el.classList) el.classList.remove('show');
    }, 3000);
  }

  function confirmPanel(msg) {
    return new Promise(function (resolve) {
      var overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      var box = document.createElement('div');
      box.className = 'modal';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      var text = document.createElement('p');
      text.textContent = msg;
      box.appendChild(text);
      var actions = document.createElement('div');
      actions.className = 'ex-order-actions';

      var cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'btn btn-ghost';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', function () {
        if (document.body && document.body.removeChild) document.body.removeChild(overlay);
        else overlay.parentNode && overlay.parentNode.removeChild(overlay);
        resolve(false);
      });

      var confirm = document.createElement('button');
      confirm.type = 'button';
      confirm.className = 'btn btn-primary';
      confirm.textContent = 'Confirm';
      confirm.addEventListener('click', function () {
        if (document.body && document.body.removeChild) document.body.removeChild(overlay);
        else overlay.parentNode && overlay.parentNode.removeChild(overlay);
        resolve(true);
      });

      actions.appendChild(cancel);
      actions.appendChild(confirm);
      box.appendChild(actions);
      overlay.appendChild(box);
      if (document.body && document.body.appendChild) document.body.appendChild(overlay);
    });
  }

  // -------------------------------------------------------------------- init

  function startRefreshLoop() {
    clearInterval(refreshTimer);
    refreshTimer = setInterval(function () {
      apiAdmin('/api/admin/refresh', { method: 'POST', body: '{}' }).then(function (result) {
        if (result.ok && result.body && result.body.accessToken) {
          storeToken(result.body.accessToken);
        }
      });
    }, 10 * 60 * 1000);
  }

  function init() {
    wireLogin();
    wireLogout();
    wireTabs();
    // The access token is intentionally never persisted. A page reload asks
    // the httpOnly refresh cookie for a fresh token before loading the panel.
    apiAdmin('/api/admin/refresh', { method: 'POST', body: '{}' }).then(function (result) {
      if (result.ok && result.body && result.body.accessToken) {
        storeToken(result.body.accessToken);
        showDashboard();
        startRefreshLoop();
      } else {
        showLogin();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
