/**
 * ==========================================================================
 * TMA BRIDGE - TELEGRAM MINI APP SDK & MONETIZATION CONTROLLER
 * ==========================================================================
 */

const TMABridge = (function () {
    // На iOS в iframe Telegram WebApp доступен только через parent окно
    const tg = (function() {
        try {
            if (window.parent && window.parent.Telegram && window.parent.Telegram.WebApp && window.parent.Telegram.WebApp.initData) {
                return window.parent.Telegram.WebApp;
            }
        } catch (e) {}
        return window.Telegram ? window.Telegram.WebApp : null;
    })();
    
    // URL вашего Cloudflare Worker
    const API_URL = 'https://my-english-app.kotikoner5.workers.dev';
    
    // Состояние пользователя и аудио-движка
    let isPremium = false;
    let audioUnlocked = false;
    let selectedEnglishVoice = null;

    // Определение платформы: на Android WebView нативный SpeechSynthesis часто заблокирован системой
    const isAndroidDevice = /Android/i.test(navigator.userAgent);
    
    // Единый глобальный аудио-плеер для Android с мгновенным откликом
    let tmaFastAudio = null;

    function playFastGoogleTts(text, onEnd) {
        try {
            if (!tmaFastAudio) {
                tmaFastAudio = new Audio();
            }
            tmaFastAudio.pause();
            tmaFastAudio.currentTime = 0;

            const clean = encodeURIComponent(text.replace(/[^a-zA-Z0-9\s',.?!-]/g, ' ').trim());
            if (!clean) {
                if (typeof onEnd === 'function') onEnd();
                return;
            }

            // Google CDN с серверами в Европе/СНГ (отклик ~200мс без задержек Китая)
            tmaFastAudio.src = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en&q=${clean}`;

            tmaFastAudio.onended = () => {
                if (typeof onEnd === 'function') onEnd();
            };

            tmaFastAudio.onerror = () => {
                if (typeof onEnd === 'function') onEnd();
            };

            const p = tmaFastAudio.play();
            if (p !== undefined) {
                p.catch(() => { if (typeof onEnd === 'function') onEnd(); });
            }
        } catch (e) {
            if (typeof onEnd === 'function') onEnd();
        }
    }

    // ПОЛИФИЛЛ ДЛЯ ANDROID: спасает все 10 файлов от падения при отсутствии SpeechSynthesis
    if (typeof window !== 'undefined' && !window.speechSynthesis) {
        window.SpeechSynthesisUtterance = function(text) {
            this.text = text || '';
            this.lang = 'en-US';
            this.rate = 1.0;
            this.onstart = null;
            this.onend = null;
            this.onerror = null;
        };

        window.speechSynthesis = {
            speaking: false,
            paused: false,
            pending: false,
            cancel: function() {
                if (tmaFastAudio) {
                    tmaFastAudio.pause();
                    tmaFastAudio.currentTime = 0;
                }
            },
            resume: function() {},
            pause: function() {},
            getVoices: function() { return []; },
            speak: function(utterance) {
                playFastGoogleTts(utterance.text, () => {
                    if (typeof utterance.onend === 'function') utterance.onend();
                });
            }
        };
    }

    // ЕДИНАЯ ОЗВУЧКА: Диагностический перехватчик Android Chromium
    if (typeof window !== 'undefined' && window.speechSynthesis) {
        const nativeSpeak = window.speechSynthesis.speak.bind(window.speechSynthesis);

        if (isAndroidDevice) {
            // Блокируем вызов cancel(), обрывающий IPC-канал Android TTS
            window.speechSynthesis.cancel = function() {};

            window.speechSynthesis.speak = function(utterance) {
                if (!utterance) return;

                const startTime = Date.now();
                const phrase = (utterance.text || '').trim();

                try { window.speechSynthesis.resume(); } catch (e) {}

                utterance.lang = 'en-US';
                utterance.rate = utterance.rate || 0.9;
                utterance.pitch = 1.0;
                utterance.volume = 1.0;

                const voices = window.speechSynthesis.getVoices() || [];
                const enVoice = voices.find(v => v.lang && v.lang.replace('_', '-').includes('en-US')) ||
                                voices.find(v => v.lang && v.lang.toLowerCase().startsWith('en'));
                
                if (enVoice) {
                    utterance.voice = enVoice;
                }

                window._tmaActiveUtterance = utterance;

                const origEnd = utterance.onend;
                const origErr = utterance.onerror;

                // Таймер зависания: если за 2 секунды движок не подал сигнал старта
                let hasStarted = false;
                const freezeTimer = setTimeout(() => {
                    if (!hasStarted) {
                        showAndroidTtsDebug(
                            '⚠️ ДВИЖОК НЕ ОТВЕЧАЕТ (Зависание > 2 сек)',
                            `Текст: "${phrase}"\n` +
                            `Голосов в системе: ${voices.length}\n` +
                            `Выбран голос: ${enVoice ? enVoice.name : 'НЕТ (дефолт)'}\n` +
                            `Статус synth: speaking=${window.speechSynthesis.speaking}, paused=${window.speechSynthesis.paused}\n\n` +
                            `Причина: Системный сервис TTS на смартфоне спит или заблокирован разрешениями.`
                        );
                    }
                }, 2000);

                utterance.onstart = function(ev) {
                    hasStarted = true;
                    clearTimeout(freezeTimer);
                    const diff = Date.now() - startTime;
                    // Если задержка больше 1.5 сек, покажем отчет о задержке
                    if (diff > 1500) {
                        showAndroidTtsDebug(
                            `⏱️ Задержка старта: ${diff} мс`,
                            `Текст: "${phrase}"\nГолос: ${enVoice ? enVoice.name : 'системный'}`
                        );
                    }
                };

                utterance.onend = function(ev) {
                    clearTimeout(freezeTimer);
                    window._tmaActiveUtterance = null;
                    if (typeof origEnd === 'function') origEnd.call(this, ev);
                };

                utterance.onerror = function(ev) {
                    clearTimeout(freezeTimer);
                    window._tmaActiveUtterance = null;
                    showAndroidTtsDebug(
                        '❌ ОШИБКА ANDROID TTS',
                        `Код ошибки: "${ev.error}"\n` +
                        `Текст: "${phrase}"\n` +
                        `Голосов найдено: ${voices.length}\n` +
                        `Сообщение: ${ev.message || 'нет описания'}`
                    );
                    if (typeof origErr === 'function') origErr.call(this, ev);
                };

                nativeSpeak(utterance);
                try { window.speechSynthesis.resume(); } catch (e) {}
            };
        }
    }

    // Инициализация и поиск доступных английских голосов (для iPhone и ПК)
    function getSpeechSynth() {
        return window.speechSynthesis || null;
    }

    function initEnglishVoices() {
        if (isAndroidDevice) return; // На Android не тратим ресурсы на поиск неработающих голосов
        const synth = getSpeechSynth();
        if (!synth) return;
        const voices = synth.getVoices();
        if (!voices || voices.length === 0) return;

        selectedEnglishVoice = voices.find(v => (v.lang === 'en-US' || v.lang === 'en_US') && !v.localService) ||
                               voices.find(v => v.lang === 'en-US' || v.lang === 'en_US') ||
                               voices.find(v => v.lang === 'en-GB' || v.lang === 'en_GB') ||
                               voices.find(v => v.lang && v.lang.toLowerCase().startsWith('en')) ||
                               null;
    }

    const sysSynth = getSpeechSynth();
    if (sysSynth && !isAndroidDevice) {
        sysSynth.onvoiceschanged = initEnglishVoices;
        setTimeout(initEnglishVoices, 100);
    }

    // 1. РАЗБЛОКИРОВКА ЗВУКА НА iOS И ANDROID (Включая автоозвучку диалогов)
    function unlockAudio() {
        const synth = getSpeechSynth();
        if (synth) {
            try { synth.resume(); } catch (e) {}
            initEnglishVoices();
        }
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
            const clean = text.replace(/[^a-zA-Z0-9\s',.?!-]/g, ' ').trim();
            if (!clean) return;

            // Если на Android нет нативного синтезатора - сразу запускаем скоростной Google CDN
            if (isAndroidDevice && (!window.speechSynthesis || window.speechSynthesis.getVoices().length === 0)) {
                playFastGoogleTts(clean, onEndCallback);
                return;
            }

            const synth = window.speechSynthesis;
            if (!synth) {
                playFastGoogleTts(clean, onEndCallback);
                return;
            }

            try { synth.resume(); } catch (e) {}

            const utter = new SpeechSynthesisUtterance(clean);
            utter.lang = 'en-US';
            utter.rate = rate;
            utter.pitch = 1.0;
            utter.volume = 1.0;

            if (typeof onEndCallback === 'function') {
                utter.onend = onEndCallback;
                utter.onerror = onEndCallback;
            }

            synth.speak(utter);
        },

        // Настройка кнопки "Назад"
        setupBackButton: function(backUrl = 'index.html') {
            // Если код выполняется внутри iframe, блокируем перезапись кнопки!
            // Ей должно управлять только главное окно (index.html), чтобы корректно срабатывал таймер.
            if (window.self !== window.top) {
                return;
            }

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

            // На iOS берем инстанс Telegram из верхнего окна, где зарегистрирован нативный мост
            const activeTg = (window.parent && window.parent.Telegram?.WebApp?.initData) 
                ? window.parent.Telegram.WebApp 
                : tg;

            const activeInitData = activeTg?.initData || window.Telegram?.WebApp?.initData;

            if (!activeTg || !activeInitData) {
                alert("Оплата доступна только внутри Telegram.");
                if (btn) btn.innerHTML = 'Разблокировать за <span class="paywall-btn-stars">399</span> ⭐️';
                return;
            }

            try {
                // Запрашиваем ссылку на инвойс у нашего Cloudflare Worker
                const response = await fetch(`${API_URL}/create-stars-invoice`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ initData: activeInitData })
                });
                
                const data = await response.json();
                
                if (data.invoiceUrl) {
                    // Вызываем openInvoice у активного экземпляра (на iPhone вызовет плашку в основном окне)
                    activeTg.openInvoice(data.invoiceUrl, (status) => {
                        if (status === 'paid') {
                            isPremium = true;
                            this.hidePaywall();
                            if (activeTg.HapticFeedback) activeTg.HapticFeedback.notificationOccurred('success');
                            activeTg.showAlert('Оплата успешна! Полный доступ открыт навсегда. 🎉');
                        } else {
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