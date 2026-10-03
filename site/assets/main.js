/* Sky Creation Innovations - site behaviour.
   Progressive enhancement only: every page works with JS disabled. */
(function () {
  'use strict';

  // --- Footer year ---------------------------------------------------------
  Array.prototype.forEach.call(document.querySelectorAll('[data-year]'), function (el) {
    el.textContent = String(new Date().getFullYear());
  });

  // --- Sticky header border on scroll -------------------------------------
  var header = document.querySelector('.site-header');
  if (header) {
    var onScroll = function () {
      header.setAttribute('data-scrolled', window.scrollY > 8 ? 'true' : 'false');
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  // --- Mobile nav ---------------------------------------------------------
  var toggle = document.querySelector('.nav-toggle');
  var nav = document.querySelector('.site-nav');

  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.getAttribute('data-open') === 'true';
      nav.setAttribute('data-open', open ? 'false' : 'true');
      toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
    });

    nav.addEventListener('click', function (event) {
      if (event.target.closest('a')) {
        nav.setAttribute('data-open', 'false');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // --- Active section highlight (same-page anchors only) -------------------
  var navLinks = Array.prototype.slice.call(document.querySelectorAll('.site-nav a[href^="#"]'));
  var byId = {};

  navLinks.forEach(function (link) {
    var id = link.getAttribute('href').slice(1);
    var target = id && document.getElementById(id);
    if (target) byId[id] = link;
  });

  var observed = Object.keys(byId).map(function (id) {
    return document.getElementById(id);
  });

  if (observed.length && 'IntersectionObserver' in window) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var link = byId[entry.target.id];
        if (link) link.style.color = entry.isIntersecting ? 'var(--text)' : '';
      });
    }, { rootMargin: '-45% 0px -50% 0px' });

    observed.forEach(function (el) {
      observer.observe(el);
    });
  }

  // --- Facebook posts ----------------------------------------------------
  // Rendered from assets/posts.js. The containing <section> is hidden while the
  // matching list is empty, so an unfilled slot never shows a bare heading.
  var postLists = document.querySelectorAll('[data-posts]');

  Array.prototype.forEach.call(postLists, function (section) {
    var key = section.getAttribute('data-posts');
    var posts = (window.SKY_POSTS && window.SKY_POSTS[key]) || [];

    if (!posts.length) {
      section.hidden = true;
      return;
    }

    var list = section.querySelector('.post-list');
    if (!list) return;

    posts
      .slice()
      .sort(function (a, b) {
        return String(b.date || '').localeCompare(String(a.date || ''));
      })
      .forEach(function (post) {
        var item = document.createElement('li');
        item.className = 'post';

        var when = document.createElement('p');
        when.className = 'post-date';
        when.textContent = formatDate(post.date);
        item.appendChild(when);

        var body = document.createElement('p');
        body.className = 'post-text';
        // textContent, never innerHTML: post copy is untrusted input.
        body.textContent = post.text || '';
        item.appendChild(body);

        if (post.url) {
          var link = document.createElement('a');
          link.className = 'post-link';
          link.href = post.url;
          link.rel = 'noopener';
          link.textContent = 'View on Facebook';
          item.appendChild(link);
        }

        list.appendChild(item);
      });
  });

  function formatDate(value) {
    if (!value) return '';
    var parsed = new Date(value);
    if (isNaN(parsed.getTime())) return String(value);
    return parsed.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
  }

  // --- Contact form -------------------------------------------------------
  var form = document.querySelector('[data-contact-form]');
  if (!form) return;

  var status = form.querySelector('.form-status');
  var submit = form.querySelector('button[type="submit"]');

  function setStatus(message, state) {
    if (!status) return;
    status.textContent = message;
    if (state) status.setAttribute('data-state', state);
    else status.removeAttribute('data-state');
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();

    var data = {
      name: form.elements.name.value.trim(),
      email: form.elements.email.value.trim(),
      subject: form.elements.subject.value.trim(),
      message: form.elements.message.value.trim(),
      company: form.elements.company.value.trim()
    };

    if (!data.name || !data.email || !data.message) {
      setStatus('Please fill in your name, email and message.', 'error');
      return;
    }

    if (submit) submit.disabled = true;
    setStatus('Sending your message...', 'pending');

    fetch('/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    })
      .then(function (response) {
        return response.json().then(function (body) {
          return { ok: response.ok, body: body };
        });
      })
      .then(function (result) {
        if (result.ok) {
          form.reset();
          setStatus('Message sent. We will reply within one business day.', 'success');
        } else {
          setStatus(result.body.error || 'Something went wrong. Please email us directly.', 'error');
        }
      })
      .catch(function () {
        setStatus('Could not reach the server. Please email us directly.', 'error');
      })
      .then(function () {
        if (submit) submit.disabled = false;
      });
  });
})();
