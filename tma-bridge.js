/**
 * ==========================================================================
 * TMA BRIDGE - TELEGRAM MINI APP SDK & MONETIZATION CONTROLLER
 * ==========================================================================
 */

const TMABridge = (function () {
    // Инициализация Telegram WebApp
    const tg = window.Telegram ? window.Telegram.WebApp : null;
    
    // URL вашего Cloudflare Worker
    const API_URL = 'https://my-english-app.kotikoner5.workers.dev';
    
    // Состояние пользователя
    let isPremium = false;
    let audioUnlocked = false;
    let selectedEnglishVoice = null;

    // Инициализация и поиск доступных английских голосов (критично для Android)
    function initEnglishVoices() {
        if (!window.speechSynthesis) return;
        const voices = window.speechSynthesis.getVoices();
        if (!voices || voices.length === 0) return;

        selectedEnglishVoice = voices.find(v => v.lang === 'en-US' && !v.localService) ||
                               voices.find(v => v.lang === 'en-US') ||
                               voices.find(v => v.lang === 'en-GB') ||
                               voices.find(v => v.lang.startsWith('en')) ||
                               null;
    }

    if (window.speechSynthesis) {
        window.speechSynthesis.onvoiceschanged = initEnglishVoices;
        initEnglishVoices();
    }

    // 1. РАЗБЛОКИРОВКА ЗВУКА НА iOS И ANDROID
    function unlockAudio() {
        if (!window.speechSynthesis) return;
        window.speechSynthesis.resume();
        initEnglishVoices();
        audioUnlocked = true;
        
        document.removeEventListener('touchstart', unlockAudio);
        document.removeEventListener('click', unlockAudio);
    }

    // 2. ИНЖЕКЦИЯ HTML ПЭЙВОЛЛА
    // Динамически добавляем модальное окно оплаты, чтобы не дублировать его в 11 файлах
    function injectPaywall() {
        if (document.getElementById('paywallOverlay')) return;
        
        const paywallHTML = `
            <div class="paywall-overlay" id="paywallOverlay">
                <div class="paywall-card">
                    <div class="paywall-icon">⭐️</div>
                    <div class="paywall-title">Полный доступ</div>
                    <div class="paywall-desc">Откройте все 10 модулей, 228 заданий и 30 диалогов навсегда.</div>
                    <div class="paywall-features">
                        <div class="paywall-feature-item">✅ Словарь Oxford</div>
                        <div class="paywall-feature-item">✅ Все грамматические скелеты</div>
                        <div class="paywall-feature-item">✅ Тренажер письма и чаты</div>
                    </div>
                    <button class="paywall-btn" id="paywallBtn" onclick="TMABridge.buyPremium()">
                        Разблокировать за <span class="paywall-btn-stars">399</span> ⭐️
                    </button>
                    <button style="background:none; border:none; color:#94a3b8; margin-top:16px; font-size:0.85rem; font-weight:600; cursor:pointer;" onclick="TMABridge.hidePaywall()">Позже</button>
                </div>
            </div>
        `;
        document.body.insertAdjacentHTML('beforeend', paywallHTML);
    }

    // 3. ПРОВЕРКА ДОСТУПА (БЭКЕНД)
    async function checkAccess() {
        if (!tg || !tg.initDataUnsafe?.user) {
            console.warn("TMA Bridge: Запуск вне Telegram. Демо-режим.");
            return;
        }

        try {
            const response = await fetch(`${API_URL}/check-access`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ initData: tg.initData })
            });
            const data = await response.json();
            isPremium = data.hasAccess === true;
        } catch (error) {
            console.error("TMA Bridge: Ошибка проверки доступа", error);
        }
    }

    // Инициализация при загрузке
    document.addEventListener('DOMContentLoaded', () => {
        if (tg) {
            tg.ready();
            tg.expand(); // Разворачиваем на весь экран
        }
        
        // Вешаем слушатели для разблокировки аудио
        document.addEventListener('touchstart', unlockAudio, { once: true });
        document.addEventListener('click', unlockAudio, { once: true });

        injectPaywall();
        checkAccess();
    });

    // ПУБЛИЧНЫЙ API МОСТА
    return {
        // Виброотклик
        haptic: function(style = 'light') {
            if (tg && tg.HapticFeedback) {
                tg.HapticFeedback.impactOccurred(style);
            }
        },

        // Универсальная озвучка для всех смартфонов и ПК
        speak: function(text, rate = 0.88, onEndCallback = null) {
            if (!window.speechSynthesis) return;

            const synth = window.speechSynthesis;
            synth.resume();
            synth.cancel();

            // Задержка 15 мс обходит баг сброса очереди в WebKit / Android WebView
            setTimeout(() => {
                const clean = text.replace(/[^a-zA-Z0-9\s',.?!-]/g, ' ').trim();
                if (!clean) return;

                const utter = new SpeechSynthesisUtterance(clean);
                utter.lang = 'en-US';
                utter.rate = rate;
                utter.pitch = 1.0;

                if (!selectedEnglishVoice) initEnglishVoices();
                if (selectedEnglishVoice) utter.voice = selectedEnglishVoice;

                if (typeof onEndCallback === 'function') {
                    utter.onend = onEndCallback;
                    utter.onerror = onEndCallback;
                }

                synth.speak(utter);
            }, 15);
        },

        // Настройка кнопки "Назад"
        setupBackButton: function(backUrl = 'index.html') {
            if (tg && tg.BackButton) {
                tg.BackButton.show();
                tg.BackButton.onClick(() => {
                    this.haptic('light');
                    window.location.href = backUrl;
                });
            }
        },

        // Скрыть кнопку "Назад" (для главной страницы)
        hideBackButton: function() {
            if (tg && tg.BackButton) {
                tg.BackButton.hide();
            }
        },

        // Показ пэйволла
        showPaywall: function() {
            this.haptic('medium');
            const overlay = document.getElementById('paywallOverlay');
            if (overlay) overlay.classList.add('visible');
        },

        // Скрытие пэйволла
        hidePaywall: function() {
            const overlay = document.getElementById('paywallOverlay');
            if (overlay) overlay.classList.remove('visible');
        },

        // Проверка лимита демо-версии
        // Возвращает true, если доступ разрешен, и false, если показан пэйволл
        checkDemoLimit: function(currentIndex, limit) {
            if (isPremium) return true; // Если куплено — пускаем везде
            
            if (currentIndex >= limit) {
                this.showPaywall();
                return false;
            }
            return true;
        },

        // Оплата через Telegram Stars
        buyPremium: async function() {
            this.haptic('heavy');
            const btn = document.getElementById('paywallBtn');
            if (btn) btn.innerText = 'Создание счета...';

            if (!tg || !tg.initDataUnsafe?.user) {
                alert("Оплата доступна только внутри Telegram.");
                if (btn) btn.innerHTML = 'Разблокировать за <span class="paywall-btn-stars">399</span> ⭐️';
                return;
            }

            try {
                // Запрашиваем ссылку на инвойс у нашего Cloudflare Worker
                const response = await fetch(`${API_URL}/create-stars-invoice`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ initData: tg.initData })
                });
                
                const data = await response.json();
                
                if (data.invoiceUrl) {
                    // Открываем нативное окно оплаты Telegram
                    tg.openInvoice(data.invoiceUrl, (status) => {
                        if (status === 'paid') {
                            isPremium = true;
                            this.hidePaywall();
                            if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
                            tg.showAlert('Оплата успешна! Полный доступ открыт навсегда. 🎉');
                        } else {
                            // status === 'cancelled' или 'failed'
                            if (btn) btn.innerHTML = 'Разблокировать за <span class="paywall-btn-stars">399</span> ⭐️';
                        }
                    });
                } else {
                    throw new Error('Invoice URL not found');
                }
            } catch (error) {
                console.error("Payment error:", error);
                tg.showAlert('Произошла ошибка при создании счета. Попробуйте позже.');
                if (btn) btn.innerHTML = 'Разблокировать за <span class="paywall-btn-stars">399</span> ⭐️';
            }
        },

        // Получить статус премиума (для UI)
        isPremiumUser: function() {
            return isPremium;
        }
    };
})();