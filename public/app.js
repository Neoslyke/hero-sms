// Hero SMS Client Application
(() => {
  'use strict';

  // Determine API base path dynamically
  const isSubpath = window.location.pathname.startsWith('/hero-sms');
  const API_BASE = isSubpath ? '/hero-sms/api' : './api';

  // State
  let serverConfig = {
    hasServerApiKey: false,
    basePath: ''
  };

  let selectedService = {
    code: 'fz',
    name: 'KFC',
    icon: '🍗',
    price: '0.07'
  };

  // Map of active activations: key = activationId, value = activation object
  // Supports multiple numbers waiting in line simultaneously
  const activeActivations = new Map();

  let pollingInterval = null;
  let timerInterval = null;
  let syncInterval = null;
  let allServices = [];

  // DOM Elements
  const balanceCard = document.getElementById('balanceCard');
  const balanceStatusDot = document.getElementById('balanceStatusDot');
  const balanceCurrency = document.getElementById('balanceCurrency');
  const balanceAmount = document.getElementById('balanceAmount');
  const refreshBalanceBtn = document.getElementById('refreshBalanceBtn');

  // Multi-Active Numbers Container
  const activeNumbersSection = document.getElementById('activeNumbersSection');
  const activeCounterBadge = document.getElementById('activeCounterBadge');
  const activeNumbersGrid = document.getElementById('activeNumbersGrid');

  // Order Elements
  const featuredServicesGrid = document.getElementById('featuredServicesGrid');
  const toggleMoreServicesBtn = document.getElementById('toggleMoreServicesBtn');
  const moreServicesPanel = document.getElementById('moreServicesPanel');
  const serviceSearchInput = document.getElementById('serviceSearchInput');
  const servicesDropdownList = document.getElementById('servicesDropdownList');
  const requestNumberBtn = document.getElementById('requestNumberBtn');
  const orderSpinner = document.getElementById('orderSpinner');
  const orderBtnText = document.getElementById('orderBtnText');

  // Toast Container
  const toastContainer = document.getElementById('toastContainer');

  // Malaysia local phone formatting helper: ensures 011... instead of 6011...
  function toMalaysiaLocalNumber(phone) {
    let cleaned = String(phone || '').replace(/\D/g, '');
    if (cleaned.startsWith('60')) {
      cleaned = '0' + cleaned.slice(2);
    } else if (!cleaned.startsWith('0')) {
      cleaned = '0' + cleaned;
    }
    return cleaned;
  }

  // Display phone formatter (e.g. 011-6311 2901)
  function formatMalaysiaDisplayPhone(phone) {
    const local = toMalaysiaLocalNumber(phone);
    if (local.startsWith('011') && local.length >= 10) {
      return `${local.slice(0, 3)}-${local.slice(3, 7)} ${local.slice(7)}`;
    } else if (local.length >= 10) {
      return `${local.slice(0, 3)}-${local.slice(3, 6)} ${local.slice(6)}`;
    } else if (local.length >= 6) {
      return `${local.slice(0, 3)}-${local.slice(3)}`;
    }
    return local;
  }

  // Request Headers (Clean: relies on server .env)
  function getHeaders() {
    return { 'Content-Type': 'application/json' };
  }

  // Toast Helper
  function showToast(message, type = 'info', duration = 4000) {
    if (!toastContainer) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    let icon = 'ℹ️';
    if (type === 'success') icon = '✅';
    if (type === 'error') icon = '❌';

    toast.innerHTML = `<span>${icon}</span><span>${escapeHtml(message)}</span>`;
    toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // Sound notification using Web Audio API
  function playSuccessChime() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();

      const now = ctx.currentTime;
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();

      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(587.33, now); // D5
      osc1.frequency.setValueAtTime(880, now + 0.15); // A5

      osc2.type = 'triangle';
      osc2.frequency.setValueAtTime(1174.66, now + 0.15); // D6

      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ctx.destination);

      osc1.start(now);
      osc2.start(now + 0.15);
      osc1.stop(now + 0.6);
      osc2.stop(now + 0.6);
    } catch {
      // Audio context might be restricted
    }
  }

  // 1. Initialize Configuration from Server
  async function initConfig() {
    try {
      const res = await fetch(`${API_BASE}/config`);
      const data = await res.json();
      if (data.success) {
        serverConfig = data;
        if (data.hasServerApiKey) {
          balanceStatusDot.className = 'balance-status connected';
          balanceCard.title = 'Wallet Balance (Hero-SMS API Connected)';
        } else {
          balanceStatusDot.className = 'balance-status warning';
          balanceCard.title = 'No API Key configured in server .env';
        }
      }
    } catch (err) {
      console.warn('Failed to fetch config:', err);
    }
  }

  // 2. Fetch Wallet Balance
  async function fetchBalance() {
    refreshBalanceBtn.classList.add('spinning');
    try {
      const res = await fetch(`${API_BASE}/balance`, { headers: getHeaders() });
      const data = await res.json();

      if (data.success) {
        balanceAmount.textContent = data.formatted;
        balanceStatusDot.className = 'balance-status connected';
        balanceCard.title = 'Click to refresh balance';
      } else {
        balanceAmount.textContent = '--.--';
        balanceStatusDot.className = 'balance-status warning';
        if (data.error) {
          balanceCard.title = data.error;
        }
      }
    } catch (err) {
      balanceAmount.textContent = 'Err';
      balanceStatusDot.className = 'balance-status warning';
    } finally {
      setTimeout(() => refreshBalanceBtn.classList.remove('spinning'), 600);
    }
  }

  // 3. Fetch Services List
  async function fetchServices() {
    try {
      const res = await fetch(`${API_BASE}/services`, { headers: getHeaders() });
      const data = await res.json();
      if (data.success && Array.isArray(data.all)) {
        allServices = data.all;
        renderServicesDropdown(allServices);

        // Update featured cards with prices if provided
        if (Array.isArray(data.featured)) {
          for (const f of data.featured) {
            const card = document.querySelector(`.service-card[data-service-code="${f.code}"]`);
            if (card && f.price) {
              const formattedPrice = Number(f.price).toFixed(2);
              card.setAttribute('data-price', formattedPrice);
              const catEl = card.querySelector('.service-category');
              if (catEl) {
                const baseCategory = f.category || catEl.textContent.split('•')[0].trim();
                catEl.textContent = `${baseCategory} • $${formattedPrice}`;
              }
              if (selectedService.code === f.code) {
                selectService(f.code, f.name, f.icon || '📱', formattedPrice);
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn('Failed to load services:', err);
    }
  }

  function renderServicesDropdown(list) {
    if (!servicesDropdownList) return;
    if (!Array.isArray(list) || list.length === 0) {
      servicesDropdownList.innerHTML = '<div class="empty-history-text">No matching services</div>';
      return;
    }

    // Sort list alphabetically by Name (A-Z) instead of ID/code
    const sorted = list.slice().sort((a, b) => {
      const nameA = (a.name || a.code || '').toLowerCase();
      const nameB = (b.name || b.code || '').toLowerCase();
      return nameA.localeCompare(nameB, undefined, { sensitivity: 'base' });
    });

    servicesDropdownList.innerHTML = sorted.map(item => {
      const priceStr = item.price ? `$${Number(item.price).toFixed(2)}` : '$0.07';
      const rawPrice = item.price || '0.07';
      return `
        <div class="dropdown-service-item" data-code="${escapeHtml(item.code)}" data-name="${escapeHtml(item.name)}" data-price="${escapeHtml(rawPrice)}">
          <div class="dropdown-service-info">
            <span class="dropdown-service-name">${escapeHtml(item.name)}</span>
            <span class="dropdown-service-code">${escapeHtml(item.code)}</span>
          </div>
          <span class="dropdown-service-price">${priceStr}</span>
        </div>
      `;
    }).join('');

    servicesDropdownList.querySelectorAll('.dropdown-service-item').forEach(el => {
      el.addEventListener('click', () => {
        const code = el.getAttribute('data-code');
        const name = el.getAttribute('data-name');
        const price = el.getAttribute('data-price') || '0.07';
        selectService(code, name, '📱', price);
        moreServicesPanel.classList.add('hidden');
        toggleMoreServicesBtn.classList.remove('open');
      });
    });
  }

  // Service Selection Logic
  function selectService(code, name, icon, price) {
    let finalPrice = price;
    if (!finalPrice) {
      const found = allServices.find(s => s.code === code);
      finalPrice = (found && found.price) ? found.price : '0.07';
    }
    const formattedPrice = Number(finalPrice).toFixed(2);
    selectedService = { code, name, icon, price: formattedPrice };

    document.querySelectorAll('.service-card').forEach(card => {
      if (card.getAttribute('data-service-code') === code) {
        card.classList.add('active');
      } else {
        card.classList.remove('active');
      }
    });

    orderBtnText.textContent = `Buy Number for ${name} ($${formattedPrice})`;
  }

  // 4. Request Temporary Number
  async function requestNumber() {
    requestNumberBtn.disabled = true;
    orderSpinner.classList.remove('hidden');

    try {
      const res = await fetch(`${API_BASE}/number`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ service: selectedService.code })
      });

      const data = await res.json();

      if (data.success) {
        const actId = String(data.activationId);
        const rawPhone = String(data.phoneNumber);
        const local = data.localPhone || toMalaysiaLocalNumber(rawPhone);
        const formatted = data.formattedPhone || formatMalaysiaDisplayPhone(rawPhone);

        const newActivation = {
          id: actId,
          phoneNumber: rawPhone,
          localPhone: local,
          formattedPhone: formatted,
          serviceCode: data.serviceCode || selectedService.code,
          serviceName: data.serviceName || selectedService.name,
          serviceIcon: data.serviceIcon || selectedService.icon,
          startTime: data.startTime || Date.now(),
          durationSeconds: data.durationSeconds || 1200,
          code: null,
          smsText: null,
          status: 'WAIT_CODE'
        };

        activeActivations.set(actId, newActivation);
        saveLocalSessions();
        renderActiveCards();

        showToast(`Number received: ${local} (${newActivation.serviceName})!`, 'success');

        // Scroll to the newly created card
        const newCardEl = document.getElementById(`activeCard-${actId}`);
        if (newCardEl) {
          newCardEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }

        fetchBalance(); // Refresh deducted wallet balance
      } else {
        showToast(data.error || 'Failed to get number from Hero-SMS.', 'error', 5000);
      }
    } catch (err) {
      showToast(`Network error: ${err.message}`, 'error');
    } finally {
      requestNumberBtn.disabled = false;
      orderSpinner.classList.add('hidden');
    }
  }

  // 5. Render Multi-Active Number Cards
  function renderActiveCards() {
    if (!activeNumbersSection || !activeNumbersGrid) return;

    if (activeActivations.size === 0) {
      activeNumbersSection.classList.add('hidden');
      activeNumbersGrid.innerHTML = '';
      return;
    }

    activeNumbersSection.classList.remove('hidden');
    const count = activeActivations.size;
    activeCounterBadge.textContent = `${count} ${count === 1 ? 'Number Waiting' : 'Numbers Waiting'}`;

    // Sort activations newest first
    const items = Array.from(activeActivations.values()).sort((a, b) => (b.startTime || 0) - (a.startTime || 0));

    activeNumbersGrid.innerHTML = items.map(item => {
      const actId = item.id;
      const local = item.localPhone || toMalaysiaLocalNumber(item.phoneNumber);
      const displayPhone = item.formattedPhone || formatMalaysiaDisplayPhone(item.phoneNumber);
      const isOtpReceived = Boolean(item.code);

      return `
        <div class="card active-activation-card" id="activeCard-${actId}" data-id="${actId}">
          <div class="active-card-header">
            <div class="active-service-tag">
              <span class="active-service-icon">${escapeHtml(item.serviceIcon || '📱')}</span>
              <span class="active-service-name">${escapeHtml(item.serviceName || item.serviceCode)}</span>
            </div>
            <div class="active-meta-badges">
              <span class="badge badge-flag">🇲🇾 Malaysia (+60)</span>
              <span class="badge badge-type">📩 SMS</span>
              <div class="timer-badge" id="timerBadge-${actId}">
                <svg class="timer-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                  <circle cx="12" cy="12" r="10"></circle>
                  <polyline points="12 6 12 12 16 14"></polyline>
                </svg>
                <span id="countdownTimer-${actId}">20:00</span>
              </div>
            </div>
          </div>

          <!-- Timer Progress Bar -->
          <div class="progress-container">
            <div class="progress-bar" id="progressBar-${actId}" style="width: 100%;"></div>
          </div>

          <div class="active-card-body">
            <!-- Phone Number Row (Copies Malaysian Local Format 011...) -->
            <div class="phone-number-box">
              <div class="phone-label">TEMPORARY MALAYSIA NUMBER</div>
              <div class="phone-row">
                <span class="phone-digits">${escapeHtml(displayPhone)}</span>
                <button class="btn btn-secondary copy-btn copy-phone-btn" data-copy="${escapeHtml(local)}" title="Copy Phone Number (${escapeHtml(local)})">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                  </svg>
                  <span>Copy</span>
                </button>
              </div>
              <div class="phone-hint">
                Copies local format: <code>${escapeHtml(local)}</code>.
                ${isOtpReceived 
                  ? '✅ SMS received! Auto-confirms when the 20m timer expires if not completed earlier.' 
                  : '⏳ If no SMS arrives within 20m, it automatically cancels & refunds to your wallet.'}
              </div>
            </div>

            <!-- SMS Status & Received OTP -->
            <div class="sms-status-box" id="smsStatusBox-${actId}">
              <!-- Waiting State -->
              <div class="sms-waiting-state ${isOtpReceived ? 'hidden' : ''}" id="smsWaitingState-${actId}">
                <div class="pulse-ring"></div>
                <div class="sms-waiting-text">
                  <div class="waiting-title">Waiting for incoming SMS...</div>
                  <div class="waiting-subtitle">Checking every 3 seconds automatically</div>
                </div>
              </div>

              <!-- Received State -->
              <div class="sms-received-state ${isOtpReceived ? '' : 'hidden'}" id="smsReceivedState-${actId}">
                <div class="otp-header">
                  <span class="otp-label">VERIFICATION CODE RECEIVED</span>
                  <span class="otp-timestamp">Ready</span>
                </div>
                <div class="otp-display-row">
                  <div class="otp-code" id="otpCode-${actId}">${escapeHtml(item.code || '')}</div>
                  <button class="btn btn-primary copy-btn copy-otp-btn" data-otp="${escapeHtml(item.code || '')}" title="Copy OTP Code">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                    </svg>
                    <span>Copy Code</span>
                  </button>
                </div>
                <div class="sms-full-text" id="smsFullText-${actId}">${escapeHtml(item.smsText || `Verification code: ${item.code || ''}`)}</div>
              </div>
            </div>

            <!-- Active Actions -->
            <div class="active-actions-row">
              <button class="btn btn-danger-outline cancel-btn ${isOtpReceived ? 'hidden' : ''}" id="cancelBtn-${actId}" data-id="${actId}">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"></circle>
                  <line x1="15" y1="9" x2="9" y2="15"></line>
                  <line x1="9" y1="9" x2="15" y2="15"></line>
                </svg>
                <span class="cancel-btn-text" id="cancelText-${actId}">Cancel & Refund</span>
              </button>

              <button class="btn btn-success finish-btn" id="finishBtn-${actId}" data-id="${actId}">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
                <span>Complete Activation</span>
              </button>
            </div>
            <div class="cancel-lock-hint ${isOtpReceived ? 'hidden' : ''}" id="cancelLockHint-${actId}">
              🔒 Hero-SMS 2-min policy: cancellation unlocks in 120s
            </div>
          </div>
        </div>
      `;
    }).join('');

    updateAllTimers();
  }

  // 6. Live Timer & 2-Minute Lock Counter
  function updateAllTimers() {
    if (activeActivations.size === 0) return;

    const now = Date.now();
    const toRemove = [];

    for (const [id, item] of activeActivations.entries()) {
      const elapsed = Math.floor((now - (item.startTime || now)) / 1000);
      const total = item.durationSeconds || 1200;
      const remaining = Math.max(0, total - elapsed);

      const timerEl = document.getElementById(`countdownTimer-${id}`);
      const progressEl = document.getElementById(`progressBar-${id}`);
      const badgeEl = document.getElementById(`timerBadge-${id}`);
      const cancelBtn = document.getElementById(`cancelBtn-${id}`);
      const cancelText = document.getElementById(`cancelText-${id}`);
      const cancelHint = document.getElementById(`cancelLockHint-${id}`);

      // Countdown display
      if (timerEl) {
        const mins = Math.floor(remaining / 60);
        const secs = remaining % 60;
        timerEl.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      }

      // Progress bar
      if (progressEl) {
        const pct = Math.max(0, Math.min(100, (remaining / total) * 100));
        progressEl.style.width = `${pct}%`;
      }

      // Urgent badge styling for last 3 minutes
      if (badgeEl) {
        if (remaining <= 180) {
          badgeEl.classList.add('urgent');
        } else {
          badgeEl.classList.remove('urgent');
        }
      }

      // Check Hero-SMS 2-minute cancellation lock (120 seconds)
      if (!item.code && cancelBtn && cancelText && cancelHint) {
        const lockRemaining = Math.max(0, 120 - elapsed);
        if (lockRemaining > 0) {
          cancelBtn.disabled = true;
          cancelBtn.classList.add('btn-locked');
          cancelText.textContent = `Cancel (Wait ${lockRemaining}s)`;
          cancelHint.classList.remove('hidden');
          cancelHint.textContent = `🔒 Hero-SMS 2-min policy: cancellation unlocks in ${lockRemaining}s`;
        } else {
          cancelBtn.disabled = false;
          cancelBtn.classList.remove('btn-locked');
          cancelText.textContent = 'Cancel & Refund';
          cancelHint.classList.add('hidden');
        }
      }

      // If full 20 minutes expired
      if (remaining <= 0) {
        toRemove.push(item);
      }
    }

    if (toRemove.length > 0) {
      for (const item of toRemove) {
        const name = item.serviceName || item.serviceCode;
        const local = item.localPhone || toMalaysiaLocalNumber(item.phoneNumber);

        activeActivations.delete(item.id);

        if (item.code) {
          // Scenario A: SMS code was received -> Auto-confirm on timeout
          showToast(`⏰ 20m expired: ${name} (${local}) auto-confirmed. SMS code was received: ${item.code}`, 'info', 8000);
          addToHistory({
            id: item.id,
            phone: item.formattedPhone || local,
            serviceName: item.serviceName,
            serviceIcon: item.serviceIcon,
            code: item.code,
            time: new Date().toLocaleTimeString(),
            status: 'Auto-Confirmed'
          });
          // Notify server to finalize with Hero-SMS
          fetch(`${API_BASE}/finish/${item.id}`, { method: 'POST', headers: getHeaders() }).catch(() => {});
        } else {
          // Scenario B: No SMS received -> Auto-cancel on timeout & full refund
          showToast(`⏰ 20m expired: No SMS received for ${name} (${local}). Auto-canceled & 100% refunded to wallet!`, 'info', 8000);
          addToHistory({
            id: item.id,
            phone: item.formattedPhone || local,
            serviceName: item.serviceName,
            serviceIcon: item.serviceIcon,
            code: null,
            time: new Date().toLocaleTimeString(),
            status: 'Auto-Refunded'
          });
          // Call cancel on server to immediately release refund
          fetch(`${API_BASE}/cancel/${item.id}`, { method: 'POST', headers: getHeaders() }).catch(() => {});
        }
      }

      saveLocalSessions();
      renderActiveCards();
      setTimeout(fetchBalance, 1200);
    }
  }

  // 7. Polling for Incoming SMS from Hero-SMS (every 3s)
  async function pollAllActiveActivations() {
    if (activeActivations.size === 0) return;

    for (const [id, item] of activeActivations.entries()) {
      // Only poll activations that don't have an OTP yet
      if (item.code) continue;

      try {
        const res = await fetch(`${API_BASE}/status/${id}`, { headers: getHeaders() });
        const data = await res.json();

        if (data.status === 'OK' && data.code) {
          item.code = data.code;
          item.smsText = data.smsText || `Verification code: ${data.code}`;
          item.status = 'OK';

          saveLocalSessions();

          // Update UI for this card
          const waitingEl = document.getElementById(`smsWaitingState-${id}`);
          const receivedEl = document.getElementById(`smsReceivedState-${id}`);
          const otpCodeEl = document.getElementById(`otpCode-${id}`);
          const smsTextEl = document.getElementById(`smsFullText-${id}`);
          const copyOtpBtn = document.querySelector(`.copy-otp-btn[data-otp]`);
          const cancelBtn = document.getElementById(`cancelBtn-${id}`);
          const cancelHint = document.getElementById(`cancelLockHint-${id}`);

          if (waitingEl) waitingEl.classList.add('hidden');
          if (receivedEl) receivedEl.classList.remove('hidden');
          if (otpCodeEl) otpCodeEl.textContent = data.code;
          if (smsTextEl) smsTextEl.textContent = item.smsText;
          if (copyOtpBtn) copyOtpBtn.setAttribute('data-otp', data.code);
          if (cancelBtn) cancelBtn.classList.add('hidden');
          if (cancelHint) cancelHint.classList.add('hidden');

          playSuccessChime();
          showToast(`SMS Code received for ${item.serviceName}: ${data.code}!`, 'success', 7000);

          addToHistory({
            id: item.id,
            phone: item.formattedPhone || item.localPhone,
            serviceName: item.serviceName,
            serviceIcon: item.serviceIcon,
            code: data.code,
            time: new Date().toLocaleTimeString(),
            status: 'Received'
          });

          fetchBalance();
        } else if (data.status === 'AUTO_CONFIRMED') {
          showToast(`Activation for ${item.serviceName} auto-confirmed on timeout (OTP: ${data.code || item.code}).`, 'info', 7000);
          addToHistory({
            id: item.id,
            phone: item.formattedPhone || item.localPhone,
            serviceName: item.serviceName,
            serviceIcon: item.serviceIcon,
            code: data.code || item.code,
            time: new Date().toLocaleTimeString(),
            status: 'Auto-Confirmed'
          });
          activeActivations.delete(id);
          saveLocalSessions();
          renderActiveCards();
          fetchBalance();
        } else if (data.status === 'AUTO_CANCELLED') {
          showToast(`Activation for ${item.serviceName} expired with no SMS. Auto-canceled & refunded on Hero-SMS.`, 'info', 7000);
          addToHistory({
            id: item.id,
            phone: item.formattedPhone || item.localPhone,
            serviceName: item.serviceName,
            serviceIcon: item.serviceIcon,
            code: null,
            time: new Date().toLocaleTimeString(),
            status: 'Auto-Refunded'
          });
          activeActivations.delete(id);
          saveLocalSessions();
          renderActiveCards();
          fetchBalance();
        } else if (data.status === 'CANCEL') {
          // Cancelled either here or on hero-sms.com official site
          showToast(`Activation for ${item.serviceName} was canceled on Hero-SMS. Balance refunded.`, 'info');
          addToHistory({
            id: item.id,
            phone: item.formattedPhone || item.localPhone,
            serviceName: item.serviceName,
            serviceIcon: item.serviceIcon,
            code: null,
            time: new Date().toLocaleTimeString(),
            status: 'Canceled & Refunded'
          });
          activeActivations.delete(id);
          saveLocalSessions();
          renderActiveCards();
          fetchBalance();
        }
      } catch (err) {
        console.warn(`Polling error for ${id}:`, err);
      }
    }
  }

  // 8. Cancel Activation (Strictly Verified with Hero-SMS API)
  async function cancelActivation(id) {
    const item = activeActivations.get(id);
    if (!item) return;

    const elapsed = Math.floor((Date.now() - (item.startTime || Date.now())) / 1000);
    if (elapsed < 120) {
      const wait = 120 - elapsed;
      showToast(`Hero-SMS locks cancellation for the first 2 minutes. Please wait ${wait} seconds.`, 'info');
      return;
    }

    const localNumber = item.localPhone || toMalaysiaLocalNumber(item.phoneNumber);
    if (!confirm(`Cancel activation for ${localNumber} (${item.serviceName})?\n\nHero-SMS will verify cancellation with the API and refund the cost to your wallet.`)) {
      return;
    }

    const cancelBtn = document.getElementById(`cancelBtn-${id}`);
    const cancelText = document.getElementById(`cancelText-${id}`);
    if (cancelBtn) cancelBtn.disabled = true;
    if (cancelText) cancelText.textContent = 'Verifying with Hero-SMS...';

    try {
      const res = await fetch(`${API_BASE}/cancel/${id}`, {
        method: 'POST',
        headers: getHeaders()
      });
      const data = await res.json();

      if (data.success) {
        showToast(data.message || 'Activation canceled on Hero-SMS. Funds refunded!', 'success');
        addToHistory({
          id: item.id,
          phone: item.formattedPhone || localNumber,
          serviceName: item.serviceName,
          serviceIcon: item.serviceIcon,
          code: null,
          time: new Date().toLocaleTimeString(),
          status: 'Canceled & Refunded'
        });

        // ONLY clear active activation after Hero-SMS API confirms successful cancellation
        activeActivations.delete(id);
        saveLocalSessions();
        renderActiveCards();
        fetchBalance();
      } else {
        // CANCELLATION REJECTED BY HERO-SMS!
        // DO NOT REMOVE THE CARD! KEEP NUMBER VISIBLE!
        showToast(data.error || 'Cancellation rejected by Hero-SMS API.', 'error', 6000);
        if (cancelBtn) cancelBtn.disabled = false;
        if (cancelText) cancelText.textContent = 'Cancel & Refund';
      }
    } catch (err) {
      showToast(`Network error: ${err.message}`, 'error');
      if (cancelBtn) cancelBtn.disabled = false;
      if (cancelText) cancelText.textContent = 'Cancel & Refund';
    }
  }

  // 9. Complete / Finish Activation
  async function finishActivation(id) {
    const item = activeActivations.get(id);
    if (!item) return;

    const finishBtn = document.getElementById(`finishBtn-${id}`);
    if (finishBtn) finishBtn.disabled = true;

    try {
      const res = await fetch(`${API_BASE}/finish/${id}`, {
        method: 'POST',
        headers: getHeaders()
      });
      const data = await res.json();

      if (data.success) {
        showToast(data.message || 'Activation completed on Hero-SMS.', 'success');
        addToHistory({
          id: item.id,
          phone: item.formattedPhone || item.localPhone,
          serviceName: item.serviceName,
          serviceIcon: item.serviceIcon,
          code: item.code || 'Completed',
          time: new Date().toLocaleTimeString(),
          status: 'Completed'
        });

        activeActivations.delete(id);
        saveLocalSessions();
        renderActiveCards();
        fetchBalance();
      } else {
        showToast(data.error || 'Failed to complete activation on Hero-SMS.', 'error');
        if (finishBtn) finishBtn.disabled = false;
      }
    } catch (err) {
      showToast(`Network error: ${err.message}`, 'error');
      if (finishBtn) finishBtn.disabled = false;
    }
  }

  // 10. Local Storage Persistence & Multi-Window Sync
  function saveLocalSessions() {
    try {
      const list = Array.from(activeActivations.values());
      localStorage.setItem('hero_sms_active_sessions_v2', JSON.stringify(list));
    } catch {
      // ignore
    }
  }

  function loadLocalSessions() {
    try {
      const raw = localStorage.getItem('hero_sms_active_sessions_v2');
      if (raw) {
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          const now = Date.now();
          for (const item of list) {
            if (item && item.id) {
              const elapsed = Math.floor((now - (item.startTime || now)) / 1000);
              if (elapsed < (item.durationSeconds || 1200)) {
                activeActivations.set(String(item.id), item);
              }
            }
          }
        }
      }
    } catch {
      localStorage.removeItem('hero_sms_active_sessions_v2');
    }
  }

  // 11. Server-Side Sync: Guarantees Incognito, Page Refreshes, and Multiple Numbers Sync
  async function syncWithServer() {
    try {
      const res = await fetch(`${API_BASE}/active`);
      const data = await res.json();

      if (data.success && Array.isArray(data.activations)) {
        const remoteIds = new Set();

        for (const remote of data.activations) {
          const actId = String(remote.activationId || remote.id);
          remoteIds.add(actId);

          const rawPhone = String(remote.phoneNumber);
          const local = remote.localPhone || toMalaysiaLocalNumber(rawPhone);
          const formatted = remote.formattedPhone || formatMalaysiaDisplayPhone(rawPhone);

          const existing = activeActivations.get(actId);
          activeActivations.set(actId, {
            id: actId,
            phoneNumber: rawPhone,
            localPhone: local,
            formattedPhone: formatted,
            serviceCode: remote.serviceCode,
            serviceName: remote.serviceName || (existing ? existing.serviceName : remote.serviceCode),
            serviceIcon: remote.serviceIcon || (existing ? existing.serviceIcon : '📱'),
            startTime: remote.startTime || (existing ? existing.startTime : Date.now()),
            durationSeconds: remote.durationSeconds || 1200,
            code: remote.code || (remote.smsCode ? (Array.isArray(remote.smsCode) ? remote.smsCode[0] : remote.smsCode) : (existing ? existing.code : null)),
            smsText: remote.smsText || (existing ? existing.smsText : null),
            status: remote.status || (existing ? existing.status : 'WAIT_CODE')
          });
        }

        // If local had sessions that are no longer on server, remove them
        for (const localId of activeActivations.keys()) {
          if (!remoteIds.has(localId)) {
            activeActivations.delete(localId);
          }
        }

        saveLocalSessions();
        renderActiveCards();
      }
    } catch (err) {
      console.warn('Failed to sync active activations with server:', err);
    }
  }

  // History Management (Disabled per user request)
  function addToHistory() {}

  // Clipboard Helper (Copies Malaysian local number 011...)
  async function copyToClipboard(text, btnElement, successText = 'Copied!') {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      const originalHTML = btnElement.innerHTML;
      btnElement.innerHTML = `<span>✓</span><span>${escapeHtml(successText)}</span>`;
      btnElement.classList.add('btn-success');

      showToast(`Copied: ${text}`, 'success', 2500);

      setTimeout(() => {
        btnElement.innerHTML = originalHTML;
        btnElement.classList.remove('btn-success');
      }, 1800);
    } catch {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        showToast(`Copied: ${text}`, 'success', 2500);
      } catch {
        showToast('Clipboard access denied. Please copy manually.', 'error');
      }
      ta.remove();
    }
  }

  // Escape HTML Helper
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Attach Event Listeners
  function attachEvents() {
    balanceCard.addEventListener('click', (e) => {
      if (e.target.closest('#refreshBalanceBtn')) return;
      fetchBalance();
    });
    refreshBalanceBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      fetchBalance();
    });

    // Featured Services click
    featuredServicesGrid.querySelectorAll('.service-card').forEach(card => {
      card.addEventListener('click', () => {
        const code = card.getAttribute('data-service-code');
        const name = card.getAttribute('data-service-name');
        const icon = card.getAttribute('data-service-icon');
        const price = card.getAttribute('data-price') || '0.07';
        selectService(code, name, icon, price);
      });
    });

    // Accordion toggle
    toggleMoreServicesBtn.addEventListener('click', () => {
      const isHidden = moreServicesPanel.classList.toggle('hidden');
      toggleMoreServicesBtn.classList.toggle('open', !isHidden);
    });

    // Service search filter
    serviceSearchInput.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase().trim();
      const filtered = allServices.filter(s => 
        (s.name && s.name.toLowerCase().includes(q)) || 
        (s.code && s.code.toLowerCase().includes(q))
      );
      renderServicesDropdown(filtered);
    });

    // Request number CTA
    requestNumberBtn.addEventListener('click', requestNumber);

    // Event Delegation for dynamically rendered active cards
    activeNumbersGrid.addEventListener('click', (e) => {
      // Copy phone button (copies 011...)
      const copyPhoneBtn = e.target.closest('.copy-phone-btn');
      if (copyPhoneBtn) {
        const text = copyPhoneBtn.getAttribute('data-copy');
        copyToClipboard(text, copyPhoneBtn, 'Copied!');
        return;
      }

      // Copy OTP button
      const copyOtpBtn = e.target.closest('.copy-otp-btn');
      if (copyOtpBtn) {
        const text = copyOtpBtn.getAttribute('data-otp');
        copyToClipboard(text, copyOtpBtn, 'Code Copied!');
        return;
      }

      // Cancel button
      const cancelBtn = e.target.closest('.cancel-btn');
      if (cancelBtn) {
        const id = cancelBtn.getAttribute('data-id');
        cancelActivation(id);
        return;
      }

      // Complete button
      const finishBtn = e.target.closest('.finish-btn');
      if (finishBtn) {
        const id = finishBtn.getAttribute('data-id');
        finishActivation(id);
        return;
      }
    });
  }

  // Bootstrap
  async function init() {
    attachEvents();
    loadLocalSessions();
    renderActiveCards();

    // Start background loops
    timerInterval = setInterval(updateAllTimers, 1000);
    pollingInterval = setInterval(pollAllActiveActivations, 3000);
    syncInterval = setInterval(syncWithServer, 15000);

    // Initial load
    await initConfig();
    fetchBalance();
    fetchServices();
    await syncWithServer();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
