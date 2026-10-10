/* Admin panel for the SCI Exchange app (site/admin.html).
 *
 * Real security lives server-side: every admin endpoint requires a Bearer
 * access token (15-minute HMAC JWT) and the apiAdmin wrapper clears the token
 * and returns to the login screen on any 401. The refresh cookie is rotated on
 * login and automatically refreshed in the background here, so an open
 * dashboard keeps working without ever storing the refresh token in
 * localStorage.
 *
 * xss: all server data is rendered via textContent, never innerHTML.
 */
(function () {
  'use strict';

  var TOKEN_KEY = 'sky_admin_token';
  var loginView = null;
  var adminView = null;
  var shortToken = null;

  function $(sel) {
    return document.querySelector(sel);
  }

  function fmt(value) {
    if (value === null || value === undefined || isNaN(value)) return '0';
    return Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  function getToken() {
    try {
      return window.localStorage.getItem(TOKEN_KEY);
    } catch (e) {
      return null;
    }
  }
  function storeToken(token) {
    try {
      if (token) window.localStorage.setItem(TOKEN_KEY, token);
      else window.localStorage.removeItem(TOKEN_KEY);
    } catch (e) {}
  }

  /* JSON request that carries the access token. A 401 means the session is
   * gone: drop the token and show the login screen. */
  function apiAdmin(path, options) {
    options = options || {};
    options.headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    var token = getToken();
    if (token) options.headers.Authorization = 'Bearer ' + token;

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
      .then(function (result) {
        if (result.status === 401) {
          storeToken(null);
          showLogin('Your session has expired. Sign in again.');
        }
        return result;
      })
      .catch(function () {
        return { ok: false, status: 0, body: { error: 'Could not reach the server' } };
      });
  }

  function showLogin(message) {
    if (loginView) loginView.hidden = false;
    if (adminView) adminView.hidden = true;
    var status = $('#admin-login-status');
    if (status && message) {
      status.textContent = message;
      status.setAttribute('data-state', 'error');
    }
  }

  function showDashboard() {
    if (loginView) loginView.hidden = true;
    if (adminView) adminView.hidden = false;
    loadStats();
    loadOrders();
    loadRates();
    loadAudit();
  }

  // ------------------------------------------------------------------ login

  function wireLogin() {
    var form = $('#admin-login-form');
    if (!form) return;
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var password = form.elements.password.value;
      var status = $('#admin-login-status');
      function setStatus(message, kind) {
        if (!status) return;
        status.textContent = message;
        if (kind) status.setAttribute('data-state', kind);
      }
      if (!password) {
        setStatus('Enter the passcode.', 'error');
        return;
      }
      var submit = form.querySelector('button[type="submit"]');
      if (submit) submit.disabled = true;
      setStatus('Signing in...', 'pending');

      apiAdmin('/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ password: password })
      })
        .then(function (result) {
          if (!result.ok) {
            throw new Error((result.body && result.body.error) || 'Sign in failed');
          }
          storeToken(result.body.accessToken);
          shortToken = result.body.accessToken;
          setStatus('', null);
          showDashboard();
        })
        .catch(function (err) {
          setStatus(err.message || 'Sign in failed.', 'error');
        })
        .then(function () {
          if (submit) submit.disabled = false;
        });
    });
  }

  function wireLogout() {
    var button = $('#admin-logout-btn');
    if (!button) return;
    button.addEventListener('click', function () {
      apiAdmin('/api/admin/logout', { method: 'POST' }).finally(function () {
        storeToken(null);
        showLogin('Signed out.');
      });
    });
  }

  // ---------------------------------------------------------------- tabs

  function wireTabs() {
    var tabs = document.querySelectorAll('[data-admin-tab]');
    Array.prototype.forEach.call(tabs, function (btn) {
      btn.addEventListener('click', function () {
        var target = btn.getAttribute('data-admin-tab');
        Array.prototype.forEach.call(tabs, function (b) {
          var active = b.classList.toggle('active', b === btn);
          b.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        ['stats', 'orders', 'rates', 'audit'].forEach(function (id) {
          var panel = $('#admin-panel-' + id);
          if (panel) panel.hidden = id !== target;
        });
        if (target === 'stats') loadStats();
        if (target === 'orders') loadOrders();
        if (target === 'rates') loadRates();
        if (target === 'audit') loadAudit();
      });
    });
  }

  // ---------------------------------------------------------------- stats

  function loadStats() {
    apiAdmin('/api/admin/stats').then(function (result) {
      var box = $('#admin-panel-stats');
      if (!box || !result.ok) return;
      box.textContent = '';
      var s = result.body;
      var cards = [
        ['Total orders', fmt(s.total)],
        ['Pending', fmt(s.counts && s.counts.PENDING)],
        ['Approved', fmt(s.counts && s.counts.APPROVED)],
        ['Completed', fmt(s.counts && s.counts.COMPLETED)],
        ['Rejected', fmt(s.counts && s.counts.REJECTED)],
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
      box.appendChild(grid);
    });
  }

  // ---------------------------------------------------------------- orders

  function loadOrders() {
    var container = $('#admin-panel-orders');
    if (!container) return;
    container.textContent = '';
    container.appendChild(spinner());

    apiAdmin('/api/admin/orders?perPage=100').then(function (result) {
      container.textContent = '';
      if (!result.ok || !Array.isArray(result.body.orders)) {
        container.appendChild(emptyRow('Could not load orders.'));
        return;
      }
      var rows = result.body.orders;
      if (!rows.length) {
        container.appendChild(emptyRow('No orders yet.'));
        return;
      }
      rows.forEach(function (order) {
        container.appendChild(orderRow(order));
      });
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
    line.textContent = fmt(order.amount) + ' ' + (order.direction === 'THB_TO_MMK' ? 'THB' : 'MMK') +
      ' \u2192 ' + fmt(order.receiveAmount) + ' MMK @ 1 THB = ' + fmt(order.rateUsed) + ' MMK';
    card.appendChild(line);

    if (!order.isRedacted) {
      var meta = document.createElement('p');
      meta.className = 'ex-order-card-line muted';
      meta.textContent = [order.senderName, order.method, order.level].filter(Boolean).join(' \u00b7 ');
      card.appendChild(meta);
    }

    var actions = document.createElement('div');
    actions.className = 'ex-order-actions';
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
        btn.disabled = true;
        apiAdmin('/api/admin/orders/' + encodeURIComponent(order.id) + '/' + spec[1], {
          method: 'POST',
          body: '{}'
        }).then(function (result) {
          if (!result.ok) alert((result.body && result.body.error) || 'Action failed');
          loadOrders();
          loadStats();
          loadAudit();
        });
      });
      actions.appendChild(btn);
    });
    card.appendChild(actions);

    return card;
  }

  function statusBadge(status) {
    var badge = document.createElement('span');
    badge.className = 'ex-status-badge';
    badge.setAttribute('data-status', status || 'UNKNOWN');
    badge.textContent = status || 'UNKNOWN';
    return badge;
  }

  function spinner() {
    var p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Loading...';
    return p;
  }

  function emptyRow(text) {
    var p = document.createElement('p');
    p.className = 'muted';
    p.textContent = text;
    return p;
  }

  // ----------------------------------------------------------------- rates

  function loadRates() {
    var box = $('#admin-panel-rates');
    if (!box) return;
    box.textContent = '';
    var spinner = document.createElement('p');
    spinner.className = 'muted';
    spinner.textContent = 'Loading...';
    box.appendChild(spinner);

    apiAdmin('/api/admin/rates').then(function (result) {
      box.textContent = '';
      if (!result.ok || !result.body) {
        box.appendChild(emptyRow('Could not load rates.'));
        return;
      }
      var r = result.body;

      var current = document.createElement('p');
      current.className = 'ex-order-card-line';
      current.textContent = 'Current rate: 1 THB = ' + fmt(r.thbToMmk) + ' MMK ' +
        (r.open ? '(exchange open)' : '(exchange CLOSED)');
      box.appendChild(current);

      var form = document.createElement('form');
      form.className = 'admin-rate-form';

      var rateField = field('New THB \u2192 MMK rate', 'number', 'rate');
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
      save.textContent = 'Save';
      form.appendChild(save);

      var status = document.createElement('p');
      status.className = 'form-status';
      form.appendChild(status);

      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var body = { open: openCheck.checked };
        var val = parseFloat(rateField.input.value);
        if (isFinite(val) && val > 0) body.thbToMmk = val;
        save.disabled = true;
        status.textContent = 'Saving...';
        status.setAttribute('data-state', 'pending');
        apiAdmin('/api/admin/rates', {
          method: 'POST',
          body: JSON.stringify(body)
        }).then(function (result) {
          if (!result.ok) {
            status.textContent = (result.body && result.body.error) || 'Save failed';
            status.setAttribute('data-state', 'error');
          } else {
            status.textContent = 'Saved.';
            status.setAttribute('data-state', 'success');
            loadRates();
            loadAudit();
          }
        }).finally(function () {
          save.disabled = false;
        });
      });
      box.appendChild(form);

      var history = document.createElement('div');
      history.className = 'mt-sm';
      var hTitle = document.createElement('h3');
      hTitle.textContent = 'Recent updates';
      history.appendChild(hTitle);
      var list = document.createElement('ul');
      list.className = 'admin-history';
      (result.body.history || []).forEach(function (entry) {
        var li = document.createElement('li');
        li.textContent = (entry.updatedAt || '').replace('T', ' ').slice(0, 16) +
          ' \u2014 1 THB = ' + fmt(entry.thbToMmk) + ' MMK' +
          (entry.actor ? ' (' + entry.actor + ')' : '');
        list.appendChild(li);
      });
      history.appendChild(list);
      box.appendChild(history);
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

  // ----------------------------------------------------------------- audit

  function loadAudit() {
    var box = $('#admin-panel-audit');
    if (!box) return;
    box.textContent = '';
    box.appendChild(spinner());

    apiAdmin('/api/admin/audit').then(function (result) {
      box.textContent = '';
      if (!result.ok || !Array.isArray(result.body.rows)) {
        box.appendChild(emptyRow('Could not load the audit log.'));
        return;
      }
      var rows = result.body.rows;
      if (!rows.length) {
        box.appendChild(emptyRow('No events recorded yet.'));
        return;
      }
      var list = document.createElement('ul');
      list.className = 'admin-audit';
      rows.forEach(function (entry) {
        var li = document.createElement('li');
        var when = document.createElement('span');
        when.textContent = (entry.createdAt || '').replace('T', ' ').slice(0, 16);
        when.className = 'muted';
        var action = document.createElement('strong');
        action.textContent = entry.action;
        li.appendChild(when);
        li.appendChild(document.createTextNode('  '));
        li.appendChild(action);
        if (entry.detail && entry.detail.id) {
          var id = document.createElement('span');
          id.textContent = ' ' + entry.detail.id + (entry.detail.reference ? ' (' + entry.detail.reference + ')' : '');
          id.className = 'muted';
          li.appendChild(id);
        }
        list.appendChild(li);
      });
      box.appendChild(list);
    });
  }

  // ------------------------------------------------------------------ init

  function init() {
    loginView = $('#admin-login');
    adminView = $('#admin-app');
    wireLogin();
    wireLogout();
    wireTabs();
    if (getToken()) {
      apiAdmin('/api/admin/session').then(function (result) {
        if (result.ok) showDashboard();
        else showLogin();
      });
    } else {
      showLogin();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();