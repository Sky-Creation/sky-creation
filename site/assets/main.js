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

    // Escape closes and hands focus back to the toggle. Without the focus()
    // call a keyboard user loses their place when the menu disappears.
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape' || nav.getAttribute('data-open') !== 'true') return;
      nav.setAttribute('data-open', 'false');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.focus();
    });

    // Clicking the page behind the open menu closes it. The toggle is
    // excluded because it manages its own state and would otherwise flip
    // twice in one click.
    document.addEventListener('click', function (event) {
      if (nav.getAttribute('data-open') !== 'true') return;
      if (nav.contains(event.target) || toggle.contains(event.target)) return;
      nav.setAttribute('data-open', 'false');
      toggle.setAttribute('aria-expanded', 'false');
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

  if (form) {
    var status = form.querySelector('.form-status');
    var submit = form.querySelector('button[type="submit"]');

    // Honeypot: disable it once the page has loaded so autofill and password
    // managers cannot populate it after JS runs. The value is still read and
    // forwarded below on purpose: a bot that fills it without running JS must be
    // visible to the server, and clearing it here would hide that.
    var honeypot = form.elements.company;
    if (honeypot) honeypot.disabled = true;

    // Mirrors the server's check. The server is still the authority - this only
    // spares a visitor a round trip that was always going to come back as a 400.
    var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

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

      if (!EMAIL_RE.test(data.email)) {
        setStatus('Please enter a valid email address.', 'error');
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
  }

  // --- Scroll Reveal Animation ---------------------------------------------
  if ('IntersectionObserver' in window) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('revealed');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1 });

    var revealElements = document.querySelectorAll('.reveal, .card, .section-head, .post, .person, .work-list > li');
    Array.prototype.forEach.call(revealElements, function (el) {
      el.classList.add('reveal');
      observer.observe(el);
    });
  }
})();
