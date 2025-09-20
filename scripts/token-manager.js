// ==UserScript==
// @name         WPlace Token Manager
// @namespace    http://tampermonkey.net/
// @version      2025-09-16.1
// @description  Turnstile token management for WPlace AutoBot
// @author       Wbot
// @match        https://wplace.live/*
// @grant        nones
// ==/UserScript==

/**
 * TokenManager - Handles Turnstile token generation, caching, and validation for WPlace AutoBot
 * Extracted from Auto-Image.js for better modularity and reusabilitys
 */
class TokenManager {
  constructor() {
    // Token state
    this.turnstileToken = null;
    this.tokenExpiryTime = 0;
    this.tokenGenerationInProgress = false;
    this._resolveToken = null;
    this.tokenPromise = new Promise((resolve) => {
      this._resolveToken = resolve;
    });
    
    // Configuration constants
    this.TOKEN_LIFETIME = 240000; // 4 minutes (tokens typically last 5 min, use 4 for safety)
    this.MAX_RETRIES = 10;
    this.MAX_BATCH_RETRIES = 10; // Maximum attempts for batch sending
    
    // Turnstile widget state
    this.turnstileLoaded = false;
    this._turnstileContainer = null;
    this._turnstileOverlay = null;
    this._turnstileWidgetId = null;
    this._lastSitekey = null;
    this._cachedSitekey = null;
    
    // Retry counter
    this.retryCount = 0;
    
    // Initialize message listener for token capture
    this._initializeTokenCapture();
  }

  /**
   * Initialize token capture from injected script
   */
  _initializeTokenCapture() {
    window.addEventListener('message', (event) => {
      const { source, token } = event.data;
      if (source === 'turnstile-capture' && token) {
        this.setTurnstileToken(token);
        // Show success message if UI is expecting it
        if (document.querySelector('#statusText')?.textContent.includes('CAPTCHA')) {
          this._showAlert('Token captured successfully', 'success');
        }
      }
    });
  }

  /**
   * Set a new Turnstile token with expiry
   * @param {string} token - The Turnstile token
   */
  setTurnstileToken(token) {
    if (this._resolveToken) {
      this._resolveToken(token);
      this._resolveToken = null;
    }
    this.turnstileToken = token;
    this.tokenExpiryTime = Date.now() + this.TOKEN_LIFETIME;
    console.log('✅ Turnstile token set successfully');
  }

  /**
   * Check if current token is valid
   * @returns {boolean} True if token exists and not expired
   */
  isTokenValid() {
    return this.turnstileToken && Date.now() < this.tokenExpiryTime;
  }

  /**
   * Invalidate current token
   */
  invalidateToken() {
    this.turnstileToken = null;
    this.tokenExpiryTime = 0;
    console.log('🗑️ Token invalidated, will force fresh generation');
  }

  /**
   * Ensure a valid token is available, generating if necessary
   * @param {boolean} forceRefresh - Force generation of new token
   * @returns {Promise<string|null>} The token or null if failed
   */
  async ensureToken(forceRefresh = false) {
    // Return cached token if still valid and not forcing refresh
    if (this.isTokenValid() && !forceRefresh) {
      return this.turnstileToken;
    }

    // Invalidate token if forcing refresh
    if (forceRefresh) this.invalidateToken();

    // Avoid multiple simultaneous token generations
    if (this.tokenGenerationInProgress) {
      console.log('🔄 Token generation already in progress, waiting...');
      await this._sleep(2000);
      return this.isTokenValid() ? this.turnstileToken : null;
    }

    this.tokenGenerationInProgress = true;

    try {
      console.log('🔄 Token expired or missing, generating new one...');
      const token = await this.handleCaptchaWithRetry();
      if (token && token.length > 20) {
        this.setTurnstileToken(token);
        console.log('✅ Token captured and cached successfully');
        return token;
      }

      console.log('⚠️ Invisible Turnstile failed, forcing browser automation...');
      const fallbackToken = await this.handleCaptchaFallback();
      if (fallbackToken && fallbackToken.length > 20) {
        this.setTurnstileToken(fallbackToken);
        console.log('✅ Fallback token captured successfully');
        return fallbackToken;
      }

      console.log('❌ All token generation methods failed');
      return null;
    } finally {
      this.tokenGenerationInProgress = false;
    }
  }

  /**
   * Handle captcha generation with retry logic
   * @returns {Promise<string|null>} The token or null if failed
   */
  async handleCaptchaWithRetry() {
    const startTime = performance.now();

    try {
      const { sitekey, token: preGeneratedToken } = await this.obtainSitekeyAndToken();

      if (!sitekey) {
        throw new Error('No valid sitekey found');
      }

      console.log('🔑 Using sitekey:', sitekey);

      if (typeof window !== 'undefined' && window.navigator) {
        console.log(
          '🧭 UA:',
          window.navigator.userAgent.substring(0, 50) + '...',
          'Platform:',
          window.navigator.platform
        );
      }

      let token = null;

      if (
        preGeneratedToken &&
        typeof preGeneratedToken === 'string' &&
        preGeneratedToken.length > 20
      ) {
        console.log('♻️ Reusing pre-generated Turnstile token');
        token = preGeneratedToken;
      } else {
        if (this.isTokenValid()) {
          console.log('♻️ Using existing cached token (from previous session)');
          token = this.turnstileToken;
        } else {
          console.log('🔐 Generating new token with executeTurnstile...');
          token = await this.executeTurnstile(sitekey, 'paint');
          if (token) this.setTurnstileToken(token);
        }
      }

      if (token && typeof token === 'string' && token.length > 20) {
        const elapsed = Math.round(performance.now() - startTime);
        console.log(`✅ Turnstile token generated successfully in ${elapsed}ms`);
        return token;
      } else {
        throw new Error(`Invalid or empty token received - Length: ${token?.length || 0}`);
      }
    } catch (error) {
      const elapsed = Math.round(performance.now() - startTime);
      console.error(`❌ Turnstile token generation failed after ${elapsed}ms:`, error);
      throw error;
    }
  }

  /**
   * Fallback token generation method using pixel placement automation
   * @returns {Promise<string|null>} The token or null if failed
   */
  async handleCaptchaFallback() {
    return new Promise(async (resolve, reject) => {
      try {
        // Ensure we have a fresh promise to await for a new token capture
        if (!this._resolveToken) {
          this.tokenPromise = new Promise((res) => {
            this._resolveToken = res;
          });
        }
        
        const timeoutPromise = this._sleep(20000).then(() =>
          reject(new Error('Auto-CAPTCHA timed out.'))
        );

        const solvePromise = (async () => {
          // Wait for main paint button
          const mainPaintBtn = await this._waitForSelector(
            'button.btn.btn-primary.btn-lg, button.btn.btn-primary.sm\\:btn-xl',
            200,
            10000
          );
          if (!mainPaintBtn) throw new Error('Could not find the main paint button.');
          mainPaintBtn.click();
          await this._sleep(500);

          // Click transparent color button
          const transBtn = await this._waitForSelector('button#color-0', 200, 5000);
          if (!transBtn) throw new Error('Could not find the transparent color button.');
          transBtn.click();
          await this._sleep(500);

          // Find canvas and simulate painting
          const canvas = await this._waitForSelector('canvas', 200, 5000);
          if (!canvas) throw new Error('Could not find the canvas element.');

          canvas.setAttribute('tabindex', '0');
          canvas.focus();
          const rect = canvas.getBoundingClientRect();
          const centerX = Math.round(rect.left + rect.width / 2);
          const centerY = Math.round(rect.top + rect.height / 2);

          // Simulate mouse movement and spacebar press
          canvas.dispatchEvent(
            new MouseEvent('mousemove', {
              clientX: centerX,
              clientY: centerY,
              bubbles: true,
            })
          );
          canvas.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: ' ',
              code: 'Space',
              bubbles: true,
            })
          );
          await this._sleep(50);
          canvas.dispatchEvent(
            new KeyboardEvent('keyup', {
              key: ' ',
              code: 'Space',
              bubbles: true,
            })
          );
          await this._sleep(500);

          // Delay before sending confirmation
          await this._sleep(800);

          // Keep confirming until token is captured
          const confirmLoop = async () => {
            while (!this.turnstileToken) {
              let confirmBtn = await this._waitForSelector(
                'button.btn.btn-primary.btn-lg, button.btn.btn-primary.sm\\:btn-xl'
              );
              if (!confirmBtn) {
                const allPrimary = Array.from(document.querySelectorAll('button.btn-primary'));
                confirmBtn = allPrimary.length ? allPrimary[allPrimary.length - 1] : null;
              }
              if (confirmBtn) {
                confirmBtn.click();
              }
              await this._sleep(500); // 500ms delay between confirmation attempts
            }
          };

          // Start confirmation loop and wait for token
          confirmLoop();
          const token = await this.tokenPromise;
          await this._sleep(300); // small delay after token is captured
          resolve(token);
        })();

        await Promise.race([solvePromise, timeoutPromise]);
      } catch (error) {
        console.error('Auto-CAPTCHA process failed:', error);
        reject(error);
      }
    });
  }

  /**
   * Load Turnstile script if not already loaded
   * @returns {Promise<void>}
   */
  async loadTurnstile() {
    // If Turnstile is already present, just resolve.
    if (window.turnstile) {
      this.turnstileLoaded = true;
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      // Avoid adding the script twice
      if (
        document.querySelector(
          'script[src^="https://challenges.cloudflare.com/turnstile/v0/api.js"]'
        )
      ) {
        const checkReady = () => {
          if (window.turnstile) {
            this.turnstileLoaded = true;
            resolve();
          } else {
            setTimeout(checkReady, 100);
          }
        };
        return checkReady();
      }

      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;
      script.onload = () => {
        this.turnstileLoaded = true;
        console.log('✅ Turnstile script loaded successfully');
        resolve();
      };
      script.onerror = () => {
        console.error('❌ Failed to load Turnstile script');
        reject(new Error('Failed to load Turnstile'));
      };
      document.head.appendChild(script);
    });
  }

  /**
   * Create or reuse the turnstile container - completely hidden for token generation
   * @returns {HTMLElement} The container element
   */
  ensureTurnstileContainer() {
    if (!this._turnstileContainer || !document.body.contains(this._turnstileContainer)) {
      // Clean up old container if it exists
      if (this._turnstileContainer) {
        this._turnstileContainer.remove();
      }

      this._turnstileContainer = document.createElement('div');
      this._turnstileContainer.className = 'wplace-turnstile-hidden';
      this._turnstileContainer.setAttribute('aria-hidden', 'true');
      this._turnstileContainer.id = 'turnstile-widget-container';
      document.body.appendChild(this._turnstileContainer);
    }
    return this._turnstileContainer;
  }

  /**
   * Interactive overlay container for visible widgets when needed
   * @returns {HTMLElement} The overlay element
   */
  ensureTurnstileOverlayContainer() {
    if (this._turnstileOverlay && document.body.contains(this._turnstileOverlay)) {
      return this._turnstileOverlay;
    }

    const overlay = document.createElement('div');
    overlay.id = 'turnstile-overlay-container';
    overlay.className = 'wplace-turnstile-overlay wplace-overlay-hidden';

    const title = document.createElement('div');
    title.textContent = this._getText('turnstileInstructions', 'Complete the verification');
    title.className = 'wplace-turnstile-title';

    const host = document.createElement('div');
    host.id = 'turnstile-overlay-host';
    host.className = 'wplace-turnstile-host';

    const hideBtn = document.createElement('button');
    hideBtn.textContent = this._getText('hideTurnstileBtn', 'Hide');
    hideBtn.className = 'wplace-turnstile-hide-btn';
    hideBtn.addEventListener('click', () => overlay.remove());

    overlay.appendChild(title);
    overlay.appendChild(host);
    overlay.appendChild(hideBtn);
    document.body.appendChild(overlay);

    this._turnstileOverlay = overlay;
    return overlay;
  }

  /**
   * Execute Turnstile widget to generate token
   * @param {string} sitekey - The site key
   * @param {string} action - The action name (default: 'paint')
   * @returns {Promise<string|null>} The token or null if failed
   */
  async executeTurnstile(sitekey, action = 'paint') {
    await this.loadTurnstile();

    // Try reusing existing widget first if sitekey matches
    if (this._turnstileWidgetId && this._lastSitekey === sitekey && window.turnstile?.execute) {
      try {
        console.log('🔄 Reusing existing Turnstile widget...');
        const token = await Promise.race([
          window.turnstile.execute(this._turnstileWidgetId, { action }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Execute timeout')), 15000)
          ),
        ]);
        if (token && token.length > 20) {
          console.log('✅ Token generated via widget reuse');
          return token;
        }
      } catch (error) {
        console.log('⚠️ Widget reuse failed, will create a fresh widget:', error.message);
      }
    }

    // Try invisible widget first
    const invisibleToken = await this.createTurnstileWidget(sitekey, action);
    if (invisibleToken && invisibleToken.length > 20) {
      return invisibleToken;
    }

    console.log('⚠️ Falling back to interactive Turnstile (visible).');
    return await this.createTurnstileWidgetInteractive(sitekey, action);
  }

  /**
   * Create invisible Turnstile widget
   * @param {string} sitekey - The site key
   * @param {string} action - The action name
   * @returns {Promise<string|null>} The token or null if failed
   */
  async createTurnstileWidget(sitekey, action) {
    return new Promise((resolve) => {
      try {
        // Force cleanup of any existing widget
        if (this._turnstileWidgetId && window.turnstile?.remove) {
          try {
            window.turnstile.remove(this._turnstileWidgetId);
            console.log('🧹 Cleaned up existing Turnstile widget');
          } catch (e) {
            console.warn('⚠️ Widget cleanup warning:', e.message);
          }
        }

        const container = this.ensureTurnstileContainer();
        container.innerHTML = '';

        // Verify Turnstile is available
        if (!window.turnstile?.render) {
          console.error('❌ Turnstile not available for rendering');
          resolve(null);
          return;
        }

        console.log('🔧 Creating invisible Turnstile widget...');
        const widgetId = window.turnstile.render(container, {
          sitekey,
          action,
          size: 'invisible',
          retry: 'auto',
          'retry-interval': 8000,
          callback: (token) => {
            console.log('✅ Invisible Turnstile callback');
            resolve(token);
          },
          'error-callback': () => resolve(null),
          'timeout-callback': () => resolve(null),
        });

        this._turnstileWidgetId = widgetId;
        this._lastSitekey = sitekey;

        if (!widgetId) {
          return resolve(null);
        }

        // Execute the widget and race with timeout
        Promise.race([
          window.turnstile.execute(widgetId, { action }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Invisible execute timeout')), 12000)
          ),
        ])
          .then(resolve)
          .catch(() => resolve(null));
      } catch (e) {
        console.error('❌ Invisible Turnstile creation failed:', e);
        resolve(null);
      }
    });
  }

  /**
   * Create interactive Turnstile widget (visible)
   * @param {string} sitekey - The site key  
   * @param {string} action - The action name
   * @returns {Promise<string|null>} The token or null if failed
   */
  async createTurnstileWidgetInteractive(sitekey, action) {
    // Create a visible widget that users can interact with if needed
    console.log('🔄 Creating interactive Turnstile widget (visible)');

    return new Promise((resolve) => {
      try {
        // Force cleanup of any existing widget
        if (this._turnstileWidgetId && window.turnstile?.remove) {
          try {
            window.turnstile.remove(this._turnstileWidgetId);
          } catch (e) {
            console.warn('⚠️ Widget cleanup warning:', e.message);
          }
        }

        const overlay = this.ensureTurnstileOverlayContainer();
        overlay.classList.remove('wplace-overlay-hidden');
        overlay.style.display = 'block';

        const host = overlay.querySelector('#turnstile-overlay-host');
        host.innerHTML = '';

        // Set a timeout for interactive mode
        const timeout = setTimeout(() => {
          console.warn('⏰ Interactive Turnstile widget timeout');
          overlay.classList.add('wplace-overlay-hidden');
          overlay.style.display = 'none';
          resolve(null);
        }, 60000); // 60 seconds for user interaction

        const widgetId = window.turnstile.render(host, {
          sitekey,
          action,
          size: 'normal',
          theme: 'light',
          callback: (token) => {
            clearTimeout(timeout);
            overlay.classList.add('wplace-overlay-hidden');
            overlay.style.display = 'none';
            console.log('✅ Interactive Turnstile completed successfully');

            if (typeof token === 'string' && token.length > 20) {
              resolve(token);
            } else {
              console.warn('❌ Invalid token from interactive widget');
              resolve(null);
            }
          },
          'error-callback': (error) => {
            clearTimeout(timeout);
            overlay.classList.add('wplace-overlay-hidden');
            overlay.style.display = 'none';
            console.warn('❌ Interactive Turnstile error:', error);
            resolve(null);
          },
        });

        this._turnstileWidgetId = widgetId;
        this._lastSitekey = sitekey;

        if (!widgetId) {
          clearTimeout(timeout);
          overlay.classList.add('wplace-overlay-hidden');
          overlay.style.display = 'none';
          console.warn('❌ Failed to create interactive Turnstile widget');
          resolve(null);
        } else {
          console.log('✅ Interactive Turnstile widget created, waiting for user interaction...');
        }
      } catch (e) {
        console.error('❌ Interactive Turnstile creation failed:', e);
        resolve(null);
      }
    });
  }

  /**
   * Cleanup method for when the script is disabled/reloaded
   */
  cleanupTurnstile() {
    if (this._turnstileWidgetId && window.turnstile?.remove) {
      try {
        window.turnstile.remove(this._turnstileWidgetId);
      } catch (e) {
        console.warn('Failed to cleanup Turnstile widget:', e);
      }
    }

    if (this._turnstileContainer && document.body.contains(this._turnstileContainer)) {
      this._turnstileContainer.remove();
    }

    if (this._turnstileOverlay && document.body.contains(this._turnstileOverlay)) {
      this._turnstileOverlay.remove();
    }

    this._turnstileWidgetId = null;
    this._turnstileContainer = null;
    this._turnstileOverlay = null;
    this._lastSitekey = null;
  }

  /**
   * Obtain sitekey and token
   * @param {string} fallback - Fallback sitekey
   * @returns {Promise<{sitekey: string, token: string|null}>}
   */
  async obtainSitekeyAndToken(fallback = '0x4AAAAAABpqJe8FO0N84q0F') {
    // Cache sitekey to avoid repeated DOM queries
    if (this._cachedSitekey) {
      console.log('🔍 Using cached sitekey:', this._cachedSitekey);

      return this.isTokenValid()
        ? {
            sitekey: this._cachedSitekey,
            token: this.turnstileToken,
          }
        : { sitekey: this._cachedSitekey, token: null };
    }

    // List of potential sitekeys to try
    const potentialSitekeys = [
      '0x4AAAAAABpqJe8FO0N84q0F', // WPlace common sitekey
      '0x4AAAAAAAJ7xjKAp6Mt_7zw', // Alternative WPlace sitekey
      '0x4AAAAAADm5QWx6Ov2LNF2g', // Another common sitekey
    ];
    
    const trySitekey = async (sitekey, source) => {
      if (!sitekey || sitekey.length < 10) return null;

      console.log(`🔍 Testing sitekey from ${source}:`, sitekey);
      const token = await this.executeTurnstile(sitekey);

      if (token && token.length >= 20) {
        console.log(`✅ Valid token generated from ${source} sitekey`);
        this.setTurnstileToken(token);
        this._cachedSitekey = sitekey;
        return { sitekey, token };
      } else {
        console.log(`❌ Failed to get token from ${source} sitekey`);
        return null;
      }
    };

    try {
      // 1️⃣ data-sitekey attribute
      const sitekeySel = document.querySelector('[data-sitekey]');
      if (sitekeySel) {
        const sitekey = sitekeySel.getAttribute('data-sitekey');
        const result = await trySitekey(sitekey, 'data attribute');
        if (result) {
          return result;
        }
      }

      // 2️⃣ Turnstile element
      const turnstileEl = document.querySelector('.cf-turnstile');
      if (turnstileEl?.dataset?.sitekey) {
        const sitekey = turnstileEl.dataset.sitekey;
        const result = await trySitekey(sitekey, 'turnstile element');
        if (result) {
          return result;
        }
      }

      // 3️⃣ Meta tags
      const metaTags = document.querySelectorAll(
        'meta[name*="turnstile"], meta[property*="turnstile"]'
      );
      for (const meta of metaTags) {
        const content = meta.getAttribute('content');
        const result = await trySitekey(content, 'meta tag');
        if (result) {
          return result;
        }
      }

      // 4️⃣ Global variable
      if (window.__TURNSTILE_SITEKEY) {
        const result = await trySitekey(window.__TURNSTILE_SITEKEY, 'global variable');
        if (result) {
          return result;
        }
      }

      // 5️⃣ Script tags
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const content = script.textContent || script.innerHTML;
        const match = content.match(
          /(?:sitekey|data-sitekey)['"\s\[\]:\=\(]*['"]?([0-9a-zA-Z_-]{20,})['"]?/i
        );
        if (match && match[1]) {
          const extracted = match[1].replace(/['"]/g, '');
          const result = await trySitekey(extracted, 'script content');
          if (result) {
            return result;
          }
        }
      }

      // 6️⃣ Known potential sitekeys
      console.log('🔍 Testing known potential sitekeys...');
      for (const testSitekey of potentialSitekeys) {
        const result = await trySitekey(testSitekey, 'known list');
        if (result) {
          return result;
        }
      }
    } catch (error) {
      console.warn('⚠️ Error during sitekey detection:', error);
    }

    // 7️⃣ Fallback
    console.log('🔧 Trying fallback sitekey:', fallback);
    const fallbackResult = await trySitekey(fallback, 'fallback');
    if (fallbackResult) {
      return fallbackResult;
    }

    // 8️⃣ Ultimate fallback with no token
    console.warn('❌ All sitekey detection methods failed, using fallback without token validation');
    this._cachedSitekey = fallback;
    return { sitekey: fallback, token: null };
  }

  // =============================================
  // UTILITY METHODS
  // =============================================

  /**
   * Sleep utility
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise<void>}
   */
  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Wait for DOM element to appear
   * @param {string} selector - CSS selector
   * @param {number} pollInterval - Polling interval in ms
   * @param {number} timeout - Timeout in ms
   * @returns {Promise<Element|null>} The element or null if timeout
   * @private
   */
  _waitForSelector(selector, pollInterval = 200, timeout = 10000) {
    return new Promise((resolve) => {
      const endTime = Date.now() + timeout;
      const poll = () => {
        const element = document.querySelector(selector);
        if (element) {
          resolve(element);
        } else if (Date.now() < endTime) {
          setTimeout(poll, pollInterval);
        } else {
          resolve(null);
        }
      };
      poll();
    });
  }

  /**
   * Simple translation helper (fallback to English)
   * @param {string} key - Translation key
   * @param {string} fallback - Fallback text
   * @returns {string} Translated text or fallback
   */
  _getText(key, fallback = '') {
    // Try to use external translation function if available
    if (typeof window.Utils?.t === 'function') {
      return window.Utils.t(key);
    }
    
    // Fallback translations
    const translations = {
      turnstileInstructions: 'Complete the verification',
      hideTurnstileBtn: 'Hide',
      tokenCapturedSuccess: 'Token captured successfully'
    };
    
    return translations[key] || fallback || key;
  }

  /**
   * Show alert helper (uses external alert if available)
   * @param {string} message - Message to show
   * @param {string} type - Alert type
   */
  _showAlert(message, type = 'info') {
    // Try to use external alert function if available
    if (typeof window.Utils?.showAlert === 'function') {
      window.Utils.showAlert(message, type);
    } else {
      console.log(`${type.toUpperCase()}: ${message}`);
    }
  }

  /**
   * Generate random string utility
   * @param {number} len - Length of string
   * @param {string} chars - Character set
   * @returns {string} Random string
   */
  _randStr(len, chars = 'abcdefghijklmnopqrstuvwxyz0123456789') {
    return [...Array(len)]
      .map(() => 
        chars[
          (crypto?.getRandomValues?.(new Uint32Array(1))[0] % chars.length) || 
          Math.floor(Math.random() * chars.length)
        ]
      )
      .join('');
  }
}

// Create global instance
window.WPlaceTokenManager = new TokenManager();

// Create global instance alias for Auto-Image.js compatibility
window.globalTokenManager = window.WPlaceTokenManager;

// Legacy compatibility - expose key methods globally for backward compatibility
window.setTurnstileToken = (token) => window.WPlaceTokenManager.setTurnstileToken(token);
window.ensureToken = (forceRefresh) => window.WPlaceTokenManager.ensureToken(forceRefresh);
window.isTokenValid = () => window.WPlaceTokenManager.isTokenValid();
window.invalidateToken = () => window.WPlaceTokenManager.invalidateToken();

console.log('✅ WPlace Token Manager loaded and ready');