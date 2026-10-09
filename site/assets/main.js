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

  // --- Scroll Progress & Back to Top ---------------------------------------
  var progressBar = document.querySelector ? document.querySelector('#scroll-progress') : null;
  var backToTop = document.querySelector ? document.querySelector('#back-to-top') : null;

  if (typeof window !== 'undefined' && (progressBar || backToTop)) {
    var updateScrollUI = function () {
      var scrollY = window.scrollY || window.pageYOffset || 0;
      if (progressBar) {
        var docHeight = (document.documentElement ? document.documentElement.scrollHeight : 0) - (window.innerHeight || 0);
        var progress = docHeight > 0 ? (scrollY / docHeight) * 100 : 0;
        progressBar.style.width = Math.min(100, Math.max(0, progress)) + '%';
      }
      if (backToTop && backToTop.classList) {
        if (scrollY > 350) {
          backToTop.classList.add('visible');
        } else {
          backToTop.classList.remove('visible');
        }
      }
    };
    window.addEventListener('scroll', updateScrollUI, { passive: true });
    updateScrollUI();

    if (backToTop) {
      backToTop.addEventListener('click', function () {
        if (typeof window.scrollTo === 'function') {
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
      });
    }
  }

  // --- Copy to Clipboard & Toast -------------------------------------------
  var toast = document.querySelector ? document.querySelector('#toast') : null;
  var toastTimer;
  function showToast(msg) {
    if (!toast) return;
    toast.textContent = msg;
    if (toast.classList) {
      toast.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () {
        toast.classList.remove('show');
      }, 2500);
    }
  }

  var copyButtons = document.querySelectorAll ? document.querySelectorAll('[data-copy]') : [];
  Array.prototype.forEach.call(copyButtons, function (btn) {
    btn.addEventListener('click', function () {
      var text = btn.getAttribute('data-copy');
      if (!text) return;
      if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          showToast('Copied ' + text + ' to clipboard');
        }).catch(function () {
          fallbackCopy(text);
        });
      } else {
        fallbackCopy(text);
      }
    });
  });

  function fallbackCopy(text) {
    try {
      var temp = document.createElement('textarea');
      temp.value = text;
      temp.setAttribute('readonly', '');
      temp.style.position = 'absolute';
      temp.style.left = '-9999px';
      if (document.body && document.body.appendChild) {
        document.body.appendChild(temp);
        temp.select();
        document.execCommand('copy');
        document.body.removeChild(temp);
        showToast('Copied ' + text + ' to clipboard');
      }
    } catch (e) {
      showToast('Copied ' + text);
    }
  }

  // --- Message Character Counter -------------------------------------------
  var messageField = document.querySelector ? document.querySelector('#message') : null;
  var charCount = document.querySelector ? document.querySelector('#message-count') : null;
  if (messageField && charCount) {
    var updateCharCount = function () {
      charCount.textContent = (messageField.value || '').length + ' / 4,000 characters';
    };
    messageField.addEventListener('input', updateCharCount);
    updateCharCount();
  }

  // --- Work Filter Tabs ----------------------------------------------------
  var filterBtns = document.querySelectorAll ? document.querySelectorAll('.filter-btn') : [];
  var projectCards = document.querySelectorAll ? document.querySelectorAll('.card-featured') : [];

  if (filterBtns.length && projectCards.length) {
    Array.prototype.forEach.call(filterBtns, function (btn) {
      btn.addEventListener('click', function () {
        var category = btn.getAttribute('data-filter');
        Array.prototype.forEach.call(filterBtns, function (b) {
          if (b.classList) b.classList.remove('active');
          b.setAttribute('aria-selected', 'false');
        });
        if (btn.classList) btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');

        Array.prototype.forEach.call(projectCards, function (card) {
          var cardCategory = card.getAttribute('data-category') || '';
          if (category === 'all' || cardCategory.indexOf(category) !== -1) {
            if (card.classList) card.classList.remove('is-hidden');
          } else {
            if (card.classList) card.classList.add('is-hidden');
          }
        });
      });
    });
  }

  // --- Hero Particle Mesh Canvas -------------------------------------------
  var heroCanvas = document.querySelector ? document.querySelector('#hero-canvas') : null;
  if (heroCanvas && heroCanvas.getContext) {
    var prefersReduced = false;
    if (typeof window.matchMedia === 'function') {
      prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }
    if (!prefersReduced) {
      (function () {
        var ctx = heroCanvas.getContext('2d');
        if (!ctx) return;
        var width = heroCanvas.width = 360;
        var height = heroCanvas.height = 320;
        var particles = [];
        var mouse = { x: -1000, y: -1000, active: false };
        var count = 20;

        for (var i = 0; i < count; i++) {
          particles.push({
            x: Math.random() * width,
            y: Math.random() * height,
            vx: (Math.random() - 0.5) * 0.7,
            vy: (Math.random() - 0.5) * 0.7,
            r: 2.5 + Math.random() * 2
          });
        }

        heroCanvas.addEventListener('mousemove', function (e) {
          var rect = heroCanvas.getBoundingClientRect();
          mouse.x = (e.clientX - rect.left) * (width / rect.width);
          mouse.y = (e.clientY - rect.top) * (height / rect.height);
          mouse.active = true;
        });

        heroCanvas.addEventListener('mouseleave', function () {
          mouse.active = false;
          mouse.x = -1000;
          mouse.y = -1000;
        });

        function loop() {
          ctx.clearRect(0, 0, width, height);

          for (var i = 0; i < particles.length; i++) {
            var p = particles[i];
            p.x += p.vx;
            p.y += p.vy;

            if (p.x < 5 || p.x > width - 5) p.vx *= -1;
            if (p.y < 5 || p.y > height - 5) p.vy *= -1;

            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fillStyle = '#0d6efd';
            ctx.fill();

            for (var j = i + 1; j < particles.length; j++) {
              var p2 = particles[j];
              var dx = p.x - p2.x;
              var dy = p.y - p2.y;
              var dist = Math.sqrt(dx * dx + dy * dy);
              if (dist < 70) {
                ctx.beginPath();
                ctx.moveTo(p.x, p.y);
                ctx.lineTo(p2.x, p2.y);
                ctx.strokeStyle = 'rgba(13, 110, 253, ' + (1 - dist / 70) * 0.35 + ')';
                ctx.lineWidth = 1;
                ctx.stroke();
              }
            }

            if (mouse.active) {
              var mdx = p.x - mouse.x;
              var mdy = p.y - mouse.y;
              var mdist = Math.sqrt(mdx * mdx + mdy * mdy);
              if (mdist < 90) {
                ctx.beginPath();
                ctx.moveTo(p.x, p.y);
                ctx.lineTo(mouse.x, mouse.y);
                ctx.strokeStyle = 'rgba(13, 202, 240, ' + (1 - mdist / 90) * 0.6 + ')';
                ctx.lineWidth = 1.2;
                ctx.stroke();
              }
            }
          }

          if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(loop);
          }
        }

        loop();
      })();
    }
  }

  // --- Math Waveform Playground --------------------------------------------
  var mathCanvas = document.querySelector ? document.querySelector('#math-canvas') : null;
  if (mathCanvas && mathCanvas.getContext) {
    (function () {
      var ctx = mathCanvas.getContext('2d');
      if (!ctx) return;
      var freqSlider = document.querySelector('#math-freq');
      var dampSlider = document.querySelector('#math-damp');
      var freqVal = document.querySelector('#math-freq-val');
      var dampVal = document.querySelector('#math-damp-val');

      function drawWave() {
        var w = mathCanvas.width = mathCanvas.offsetWidth || 600;
        var h = mathCanvas.height = 240;
        var freq = freqSlider ? parseFloat(freqSlider.value) : 2.5;
        var damp = dampSlider ? parseFloat(dampSlider.value) : 0.003;

        if (freqVal) freqVal.textContent = freq.toFixed(1) + ' Hz';
        if (dampVal) dampVal.textContent = damp.toFixed(3);

        ctx.clearRect(0, 0, w, h);

        ctx.beginPath();
        ctx.strokeStyle = '#dee2e6';
        ctx.lineWidth = 1;
        ctx.moveTo(0, h / 2);
        ctx.lineTo(w, h / 2);
        ctx.stroke();

        ctx.beginPath();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = '#0d6efd';

        var amplitude = (h / 2) * 0.75;
        for (var x = 0; x < w; x++) {
          var decay = Math.exp(-damp * x);
          var y = h / 2 - amplitude * decay * Math.sin((2 * Math.PI * freq * x) / w);
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      if (freqSlider) freqSlider.addEventListener('input', drawWave);
      if (dampSlider) dampSlider.addEventListener('input', drawWave);
      if (typeof window.addEventListener === 'function') {
        window.addEventListener('resize', drawWave);
      }
      drawWave();
    })();
  }

  // --- SCI Exchange Calculator App ----------------------------------------
  var exchangeApp = document.querySelector ? document.querySelector('#exchange-app') : null;
  if (exchangeApp) {
    (function () {
      var direction = 'THB_TO_MMK'; // 'THB_TO_MMK' or 'MMK_TO_THB'
      var defaultRate = 128.5;
      var currentRate = defaultRate;
      var selectedMethod = 'KBZPay / PromptPay';

      var sendInput = document.querySelector('#calc-send-amount');
      var receiveInput = document.querySelector('#calc-receive-amount');
      var swapBtn = document.querySelector('#calc-swap-btn');
      var rateText = document.querySelector('#calc-rate-display');
      var editRateBtn = document.querySelector('#calc-edit-rate-btn');
      var resetRateBtn = document.querySelector('#calc-reset-rate-btn');
      var customRateBox = document.querySelector('#calc-rate-custom');
      var customRateInput = document.querySelector('#calc-custom-rate');
      var saveRateBtn = document.querySelector('#calc-save-rate');

      var sendCode = document.querySelector('#calc-send-code');
      var receiveCode = document.querySelector('#calc-receive-code');
      var sendBadge = document.querySelector('#calc-send-badge');
      var receiveBadge = document.querySelector('#calc-receive-badge');

      var slipSend = document.querySelector('#slip-send');
      var slipRate = document.querySelector('#slip-rate');
      var slipMethod = document.querySelector('#slip-method');
      var slipTotal = document.querySelector('#slip-total');
      var slipCopyBtn = document.querySelector('#slip-copy-btn');
      var methodPills = document.querySelectorAll('.method-pill');

      function formatNumber(num) {
        if (isNaN(num) || num === 0) return '0';
        return Number(num).toLocaleString('en-US', { maximumFractionDigits: 2 });
      }

      function calculate() {
        var sendVal = sendInput ? parseFloat(sendInput.value) || 0 : 0;
        var receiveVal = 0;

        if (direction === 'THB_TO_MMK') {
          receiveVal = Math.round(sendVal * currentRate);
          if (sendCode) sendCode.textContent = 'THB';
          if (receiveCode) receiveCode.textContent = 'MMK';
          if (sendBadge) sendBadge.textContent = 'Thai Baht';
          if (receiveBadge) receiveBadge.textContent = 'Myanmar Kyat';
          if (rateText) rateText.textContent = '1 THB = ' + currentRate.toFixed(2) + ' MMK';
        } else {
          receiveVal = currentRate > 0 ? (sendVal / currentRate).toFixed(2) : 0;
          if (sendCode) sendCode.textContent = 'MMK';
          if (receiveCode) receiveCode.textContent = 'THB';
          if (sendBadge) sendBadge.textContent = 'Myanmar Kyat';
          if (receiveBadge) receiveBadge.textContent = 'Thai Baht';
          if (rateText) rateText.textContent = '1 THB = ' + currentRate.toFixed(2) + ' MMK';
        }

        if (receiveInput) {
          receiveInput.value = formatNumber(receiveVal);
        }

        // Update slip breakdown
        if (slipSend) {
          var sendUnit = direction === 'THB_TO_MMK' ? ' THB' : ' MMK';
          slipSend.textContent = formatNumber(sendVal) + sendUnit;
        }
        if (slipRate) {
          slipRate.textContent = '1 THB = ' + currentRate.toFixed(2) + ' MMK';
        }
        if (slipMethod) {
          slipMethod.textContent = selectedMethod;
        }
        if (slipTotal) {
          var receiveUnit = direction === 'THB_TO_MMK' ? ' MMK' : ' THB';
          slipTotal.textContent = formatNumber(receiveVal) + receiveUnit;
        }
      }

      if (sendInput) {
        sendInput.addEventListener('input', calculate);
      }

      if (swapBtn) {
        swapBtn.addEventListener('click', function () {
          direction = direction === 'THB_TO_MMK' ? 'MMK_TO_THB' : 'THB_TO_MMK';
          if (sendInput) {
            sendInput.value = direction === 'THB_TO_MMK' ? '5000' : '500000';
          }
          calculate();
        });
      }

      // Method selection
      Array.prototype.forEach.call(methodPills, function (pill) {
        pill.addEventListener('click', function () {
          Array.prototype.forEach.call(methodPills, function (p) {
            if (p.classList) p.classList.remove('active');
          });
          if (pill.classList) pill.classList.add('active');
          selectedMethod = pill.getAttribute('data-method') || pill.textContent;
          calculate();
        });
      });

      // Rate editing
      if (editRateBtn && customRateBox) {
        editRateBtn.addEventListener('click', function () {
          customRateBox.classList.toggle('show');
          if (customRateInput) customRateInput.value = currentRate;
        });
      }

      if (saveRateBtn && customRateInput) {
        saveRateBtn.addEventListener('click', function () {
          var val = parseFloat(customRateInput.value);
          if (!isNaN(val) && val > 0) {
            currentRate = val;
            if (customRateBox) customRateBox.classList.remove('show');
            calculate();
            showToast('Rate updated to 1 THB = ' + val.toFixed(2) + ' MMK');
          }
        });
      }

      if (resetRateBtn) {
        resetRateBtn.addEventListener('click', function () {
          currentRate = defaultRate;
          if (customRateBox) customRateBox.classList.remove('show');
          calculate();
          showToast('Rate reset to default');
        });
      }

      // Copy Slip
      if (slipCopyBtn) {
        slipCopyBtn.addEventListener('click', function () {
          var sendVal = sendInput ? sendInput.value : '0';
          var sendCurr = direction === 'THB_TO_MMK' ? 'THB' : 'MMK';
          var recvVal = receiveInput ? receiveInput.value : '0';
          var recvCurr = direction === 'THB_TO_MMK' ? 'MMK' : 'THB';

          var text = [
            'SCI Exchange Conversion:',
            sendVal + ' ' + sendCurr + ' = ' + recvVal + ' ' + recvCurr,
            'Rate: 1 THB = ' + currentRate.toFixed(2) + ' MMK',
            'Channels: KBZPay, WavePay, PromptPay, KBank',
            'https://skycreation.dev/app'
          ].join('\n');

          fallbackCopy(text);
          showToast('Conversion details copied!');
        });
      }

      calculate();
    })();
  }
})();
