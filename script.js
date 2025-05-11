import { LANGUAGE_NORMALIZATION } from './languageNormalization.js';
import { STATIC_COUNTRIES } from './staticCountries.js';
import { CUSTOM_INDIAN_STATIONS } from './customStations.js';

const API_SERVERS = [
    'https://all.api.radio-browser.info',
    'https://fi1.api.radio-browser.info',
    'https://de2.api.radio-browser.info'
];
const MAX_RETRIES = 3;
const TEST_STREAM_TIMEOUT = 2000;
const SKIP_STREAM_TEST = true;
const BATCH_SIZE = 50;
const HEARTBEAT_INTERVAL = 5000;
const CACHE_KEY = 'world_fm_radio_stations';
const CACHE_DURATION = 12 * 60 * 60 * 1000;
const AUDIO_ERROR_RETRY_DELAY = 2000;
const MAX_AUDIO_ERROR_RETRIES = 5;
const INIT_RETRY_DELAY = 2000;
const SILENCE_DETECTION_INTERVAL = 3000;
const VOLUME_ANIMATION_DURATION = 300;
const PLAY_BUTTON_DEBOUNCE = 500;

let audio = new Audio();
let audioContext = new (window.AudioContext || window.webkitAudioContext)();
let sourceNode = audioContext.createMediaElementSource(audio);
let analyser = audioContext.createAnalyser();
sourceNode.connect(analyser);
analyser.connect(audioContext.destination);
analyser.fftSize = 256;

let currentStation = null;
let isPlaying = false;
let hasError = false;
let isLoading = false;
let countryStations = [];
let stations = [];
let heartbeatTimer = null;
let silenceTimer = null;
let lastError = { message: null };
let selectedLanguage = '';
let isChecking = false;
let audioErrorRetryCount = 0;
let isManuallyPaused = false;
let stationsFailedToLoad = false;
let lastSelectedCountry = null;
let errorDebounceTimeout = null;
let isOffline = !navigator.onLine;
let userInteracted = false;
let selectedFromFavorites = false;
let searchQuery = '';
let previousVolume = 0.5;
let isMuted = false;
let lastPlayAttempt = 0;
let lastPlayButtonClick = 0;
let isStopping = false;
let stationDisplayMode = 'custom-only';

const failedFaviconCache = new Set();

const keepAliveAudio = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=');
keepAliveAudio.loop = true;
keepAliveAudio.volume = 0;

window.setStationDisplayMode = function(mode) {
    const validModes = ['both', 'custom-only', 'api-only'];
    if (!validModes.includes(mode)) {
        console.error(`Invalid station display mode: ${mode}. Valid modes are: ${validModes.join(', ')}`);
        throw new Error('Invalid station display mode');
    }
    stationDisplayMode = mode;
    console.log(`Station display mode set to: ${mode}`);
    
    if (lastSelectedCountry) {
        console.log(`Refreshing stations for country ${lastSelectedCountry} with mode ${mode}`);
        fetchAndDisplayAllStations(lastSelectedCountry).catch(err => {
            console.error('Failed to refresh stations after mode change:', err.message);
            showError('Couldn’t refresh stations.\nPlease try again!');
        });
    }
};

function initializeAudioElement() {
    if (audio) {
        audio.pause();
        audio.remove();
    }
    audio = new Audio();
    audio.autoplay = false;
    audio.preload = 'auto';
    audio.setAttribute('playsinline', '');
    audio.setAttribute('crossorigin', 'anonymous');
    document.body.appendChild(audio);
    sourceNode = audioContext.createMediaElementSource(audio);
    analyser = audioContext.createAnalyser();
    sourceNode.connect(analyser);
    analyser.connect(audioContext.destination);
    analyser.fftSize = 256;
    console.log('Audio element reinitialized');
}

initializeAudioElement();

async function requestNotificationPermission() {
    if (!("Notification" in window)) {
        console.warn("Notifications API not supported in this browser.");
        return false;
    }

    const permission = await Notification.requestPermission();
    console.log("Notification permission status:", permission);
    return permission === "granted";
}

function showCustomNotification(title, options = {}) {
    if (!("Notification" in window) || Notification.permission !== "granted") {
        console.warn("Cannot show notification: API not supported or permission denied.");
        return;
    }

    const defaultOptions = {
        body: "World FM Radio",
        icon: currentStation?.favicon || "/apple-touch-icon.png",
        badge: "/apple-touch-icon.png",
        silent: false,
        tag: "world-fm-radio",
        renotify: true,
        vibrate: [200, 100, 200],
        actions: [
            {
                action: "play-pause",
                title: isPlaying ? "Pause" : "Play",
                icon: isPlaying ? "/pause-icon.png" : "/play-icon.png",
            },
        ],
    };

    const notificationOptions = { ...defaultOptions, ...options };

    try {
        const notification = new Notification(title, notificationOptions);
        
        notification.onclick = () => {
            window.focus();
            if (currentStation && !isPlaying && !isOffline) {
                playStation(currentStation);
            }
            console.log("Notification clicked, window focused");
        };

        notification.onactionclick = (event) => {
            if (event.action === "play-pause") {
                if (isPlaying) {
                    audio.pause();
                    isPlaying = false;
                    isManuallyPaused = true;
                    updatePlayerDisplay();
                    updateMediaSession();
                } else if (currentStation) {
                    playStation(currentStation);
                }
            }
            console.log("Notification action clicked:", event.action);
        };

        console.log("Notification shown:", title, notificationOptions);
    } catch (err) {
        console.error("Failed to show notification:", err.message);
    }
}

function handleUserInteraction() {
    if (!userInteracted) {
        userInteracted = true;
        console.log('User interaction detected, enabling autoplay.');
        audioContext.resume().then(() => {
            console.log('Audio context resumed');
            keepAliveAudio.play().catch(err => console.warn('Keep-alive audio failed to start:', err));
            requestNotificationPermission().then(hasPermission => {
                if (!hasPermission) {
                    console.warn("Notifications disabled; user denied permission.");
                }
            });
        }).catch(err => console.error('Failed to resume audio context:', err));
    }
}

document.addEventListener('click', handleUserInteraction, { once: true });

function updateStationVisuals(station = null, forceReset = false) {
    const stationImage = document.getElementById('stationImage');
    const stationIcon = document.getElementById('stationIcon');

    if (!stationImage || !stationIcon) {
        console.error('Station image or icon element missing', { stationImage, stationIcon });
        return;
    }

    if (!station || forceReset) {
        stationImage.style.display = 'none';
        stationImage.src = '';
        stationImage.alt = '';
        stationImage.classList.remove('loading', 'loaded');
        stationIcon.classList.add('loading');
        stationIcon.style.display = 'flex';
        console.log('Station visuals reset to default icon');
        return;
    }

    const favicon = station.favicon && station.favicon.match(/^https?:\/\//) ? station.favicon : null;
    if (!favicon || failedFaviconCache.has(favicon)) {
        stationImage.style.display = 'none';
        stationImage.alt = '';
        stationImage.classList.remove('loading', 'loaded');
        stationIcon.classList.add('loading');
        stationIcon.style.display = 'flex';
        console.log('Showing default icon due to invalid or failed favicon', { station: station.name, favicon });
        return;
    }

    stationImage.classList.add('loading');
    stationImage.style.display = 'block';
    stationImage.alt = `Logo for ${station.name}`;
    stationImage.src = favicon;
    stationIcon.classList.remove('loading');
    stationIcon.style.display = 'none';
    console.log('Loading favicon', { station: station.name, favicon });

    const onLoad = () => {
        stationImage.classList.remove('loading');
        stationImage.classList.add('loaded');
        stationImage.style.display = 'block';
        stationIcon.style.display = 'none';
        console.log('Favicon loaded successfully', { station: station.name, favicon });
        stationImage.removeEventListener('load', onLoad);
        stationImage.removeEventListener('error', onError);
    };

    const onError = () => {
        failedFaviconCache.add(favicon);
        stationImage.style.display = 'none';
        stationImage.alt = '';
        stationImage.classList.remove('loading', 'loaded');
        stationIcon.classList.add('loading');
        stationIcon.style.display = 'flex';
        console.warn('Favicon failed to load, showing default icon', { station: station.name, favicon });
        stationImage.removeEventListener('load', onLoad);
        stationImage.removeEventListener('error', onError);
    };

    stationImage.addEventListener('load', onLoad, { once: true });
    stationImage.addEventListener('error', onError, { once: true });
}

function getAudioErrorMessage(error) {
    if (!error) return "Oops! Something went wrong with the music.";
    const audioError = error.target?.error;
    if (!audioError) return "The music stopped for an unexpected reason.";
    switch (audioError.code) {
        case MediaError.MEDIA_ERR_ABORTED: return "The music was interrupted.";
        case MediaError.MEDIA_ERR_NETWORK: return "Looks like your internet dropped.";
        case MediaError.MEDIA_ERR_DECODE: return "This station’s sound isn’t working right now.";
        case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED: return "This station isn’t supported by your device.";
        default: return "Something’s up with the music.";
    }
}

audio.addEventListener('suspend', () => {
    console.warn('Audio suspended, checking state...', { isPlaying, isOffline, isManuallyPaused });
    if (isPlaying && currentStation && !isOffline && !isManuallyPaused && audio.src) {
        console.log('Attempting to resume audio...');
        audioContext.resume().then(() => {
            audio.play().catch(err => {
                console.error('Failed to resume audio on suspend:', err);
                showError("The music paused unexpectedly.\nPlease press play to resume.");
                showCustomNotification("Playback Suspended", {
                    body: "The music paused unexpectedly. Press play to resume.",
                });
            });
        }).catch(err => {
            console.error('Failed to resume audio context on suspend:', err);
            showError("The music paused unexpectedly.\nPlease press play to resume.");
            showCustomNotification("Playback Suspended", {
                body: "The music paused unexpectedly. Press play to resume.",
            });
        });
    } else {
        console.log('No resume needed: audio not playing or manually paused');
    }
});

audio.addEventListener('playing', () => {
    isPlaying = true;
    hasError = false;
    audioErrorRetryCount = 0;
    isManuallyPaused = false;
    clearError();
    updatePlayerDisplay();
    showLoading(false);
    startHeartbeat();
    startSilenceDetection();
    updateMediaSession();
    console.log('Audio started playing', { station: currentStation?.name });
    updateFavoriteItemButtons();
});

audio.addEventListener('pause', () => {
    isPlaying = false;
    stopHeartbeat();
    stopSilenceDetection();
    updatePlayerDisplay();
    updateMediaSession();
    if (isManuallyPaused) {
        showError("Paused! Click play to resume");
        showCustomNotification("Paused", {
            body: `Station: ${currentStation?.name || "Unknown"}`,
        });
    }
    console.log('Audio paused', { manual: isManuallyPaused });
    updateFavoriteItemButtons();
});

audio.addEventListener('error', (e) => {
    if (isChecking || isStopping) {
        console.log('Ignoring audio error during checking or stopping', { isChecking, isStopping });
        return;
    }
    hasError = true;
    console.error('Audio error occurred:', e, { code: e.target?.error?.code, message: e.target?.error?.message });
    stopHeartbeat();
    stopSilenceDetection();
    isPlaying = false;
    if (isOffline) {
        showError('You are offline!\nPlease check your internet connection.');
        showCustomNotification("Offline", {
            body: "You are offline! Please check your internet connection.",
        });
        return;
    }
    const errorMessage = getAudioErrorMessage(e);
    if (currentStation && audioErrorRetryCount < MAX_AUDIO_ERROR_RETRIES) {
        audioErrorRetryCount++;
        console.warn(`Retrying ${currentStation.name} due to error (attempt ${audioErrorRetryCount}/${MAX_AUDIO_ERROR_RETRIES})`);
        showError(`${errorMessage} Retrying ${currentStation.name}... (attempt ${audioErrorRetryCount})`);
        showCustomNotification("Retrying Station", {
            body: `${errorMessage} Retrying ${currentStation.name}... (attempt ${audioErrorRetryCount})`,
        });
        setTimeout(() => playStation(currentStation), AUDIO_ERROR_RETRY_DELAY);
    } else {
        console.error(`${currentStation?.name || 'Station'} failed after ${MAX_AUDIO_ERROR_RETRIES} retries`);
        showError(`${errorMessage}\nPlease try another station.`);
        showCustomNotification("Playback Failed", {
            body: `${errorMessage}\nPlease try another station.`,
        });
        audioErrorRetryCount = 0;
        updatePlayerDisplay();
        showLoading(false);
    }
});

audio.addEventListener('canplay', () => console.log('Audio can play', { src: audio.src }));

document.addEventListener('visibilitychange', () => {
    console.log('Visibility changed:', document.visibilityState);
    if (document.visibilityState === 'hidden' && isPlaying && currentStation && !isOffline && !isManuallyPaused) {
        console.log('App minimized or screen off, ensuring audio continues...');
        audioContext.resume().then(() => audio.play()).catch(err => {
            console.error('Failed to keep audio playing in background:', err);
            showError("The music stopped when the screen turned off.\nPlease tap play to resume!");
            showCustomNotification("Playback Interrupted", {
                body: "The music stopped when the screen turned off. Tap play to resume!",
            });
        });
        keepAliveAudio.play().catch(err => console.warn('Keep-alive failed in background:', err));
    } else if (document.visibilityState === 'visible' && !isPlaying && currentStation && !isOffline && !isManuallyPaused) {
        console.log('App restored, resuming audio...');
        audioContext.resume().then(() => audio.play()).catch(err => {
            console.error('Failed to resume audio on visibility restore:', err);
            showError("The music didn’t restart.\nPlease tap play to bring it back!");
            showCustomNotification("Playback Not Resumed", {
                body: "The music didn’t restart. Tap play to bring it back!",
            });
        });
    }
});

let wakeLock = null;
async function requestWakeLock() {
    if ('wakeLock' in navigator && isPlaying && !isOffline) {
        try {
            wakeLock = await navigator.wakeLock.request('screen');
            console.log('Wake lock acquired');
            wakeLock.addEventListener('release', () => {
                console.log('Wake lock released');
            });
        } catch (err) {
            console.error('Failed to acquire wake lock:', err);
        }
    }
}

async function releaseWakeLock() {
    if (wakeLock) {
        try {
            await wakeLock.release();
            wakeLock = null;
            console.log('Wake lock released manually');
        } catch (err) {
            console.error('Failed to release wake lock:', err);
        }
    }
}

function startSilenceDetection() {
    stopSilenceDetection();
    silenceTimer = setInterval(() => {
        if (isPlaying && !audio.paused && audio.currentTime > 0 && !audio.muted && audio.volume > 0) {
            const bufferLength = analyser.frequencyBinCount;
            const dataArray = new Uint8Array(bufferLength);
            analyser.getByteFrequencyData(dataArray);
            const average = dataArray.reduce((a, b) => a + b, 0) / bufferLength;
            console.log('Audio level check:', { average });
            if (average < 1) {
                console.warn('Silence detected in audio output');
                showError("No sound detected from this station.\nPlease select another station.");
                showCustomNotification("No Sound Detected", {
                    body: "No sound detected from this station. Please select another station.",
                });
                audio.pause();
                audioErrorRetryCount = 0;
            }
        }
    }, SILENCE_DETECTION_INTERVAL);
    console.log('Silence detection started');
}

function stopSilenceDetection() {
    if (silenceTimer) {
        clearInterval(silenceTimer);
        silenceTimer = null;
        console.log('Silence detection stopped');
    }
}

function updateMediaSession() {
    if (!("mediaSession" in navigator)) {
        console.warn("Media Session API not supported in this browser.");
        return;
    }

    console.log("Updating media session", {
        station: currentStation?.name,
        isPlaying,
        isOffline,
        isMuted,
    });

    navigator.mediaSession.metadata = new MediaMetadata({
        title: currentStation ? currentStation.name : "World FM Radio",
        artist: normalizeLanguage(currentStation?.language) || "Unknown",
        album: currentStation?.country || "World FM Radio",
        artwork: [
            {
                src: currentStation?.favicon || "/apple-touch-icon.png",
                sizes: "96x96",
                type: "image/png",
            },
            {
                src: currentStation?.favicon || "/apple-touch-icon.png",
                sizes: "128x128",
                type: "image/png",
            },
            {
                src: currentStation?.favicon || "/apple-touch-icon.png",
                sizes: "192x192",
                type: "image/png",
            },
            {
                src: currentStation?.favicon || "/apple-touch-icon.png",
                sizes: "512x512",
                type: "image/png",
            },
        ],
    });

    navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";

    navigator.mediaSession.setActionHandler("play", async () => {
        if (!currentStation || isOffline) {
            console.warn("Cannot play: no station or offline.");
            showCustomNotification("Cannot Play", {
                body: isOffline ? "You are offline!" : "No station selected.",
            });
            return;
        }
        console.log("Media session: Play triggered");
        handleUserInteraction();
        try {
            await audioContext.resume();
            await audio.play();
            isPlaying = true;
            isManuallyPaused = false;
            updatePlayerDisplay();
            startHeartbeat();
            startSilenceDetection();
            requestWakeLock();
            keepAliveAudio.play().catch(err => console.warn("Keep-alive failed on play:", err));
            showCustomNotification(`Now Playing: ${currentStation.name}`, {
                body: `Resumed playback.`,
            });
        } catch (err) {
            console.error("Media session play failed:", err.message);
            showCustomNotification("Playback Failed", {
                body: "Couldn’t start the music. Try another station.",
            });
        }
    });

    navigator.mediaSession.setActionHandler("pause", () => {
        console.log("Media session: Pause triggered");
        audio.pause();
        isPlaying = false;
        isManuallyPaused = true;
        stopHeartbeat();
        stopSilenceDetection();
        releaseWakeLock();
        updatePlayerDisplay();
        showCustomNotification("Paused", {
            body: `Station: ${currentStation?.name || "Unknown"}`,
        });
    });

    navigator.mediaSession.setActionHandler("stop", () => {
        console.log("Media session: Stop triggered");
        stopPlayback();
    });

    navigator.mediaSession.setActionHandler("previoustrack", () => {
        console.log("Media session: Previous track triggered");
        handleUserInteraction();
        previousStation();
    });

    navigator.mediaSession.setActionHandler("nexttrack", () => {
        console.log("Media session: Next track triggered");
        handleUserInteraction();
        nextStation();
    });

    navigator.mediaSession.setActionHandler("seekbackward", null);
    navigator.mediaSession.setActionHandler("seekforward", null);
}

async function fetchFromFastestServer(endpoint, retryCount = 0) {
    if (isOffline) throw new Error('Offline: Cannot fetch stations.');
    console.log(`Fetching from servers: ${endpoint}, retry ${retryCount + 1}/${MAX_RETRIES}`);
    const fetchPromises = API_SERVERS.map(server =>
        fetch(`${server}${endpoint}`).then(res => {
            if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
            console.log(`Server ${server} responded successfully`);
            return res.json();
        }).catch(err => {
            console.warn(`Server ${server} failed:`, err.message);
            return null;
        })
    );
    try {
        const results = await Promise.race(fetchPromises.filter(p => p));
        if (!results) throw new Error('All servers failed');
        console.log('Fetched stations:', results.slice(0, 5));
        return results;
    } catch (error) {
        console.error('Fetch attempt failed:', error.message);
        if (retryCount < MAX_RETRIES - 1) {
            console.log('Retrying fetch...');
            return fetchFromFastestServer(endpoint, retryCount + 1);
        }
        throw error;
    }
}

async function getUserCountryCode() {
    if (isOffline) {
        console.warn('Offline, defaulting to country code "IN"');
        return 'IN';
    }
    console.log('Detecting user country code...');
    try {
        const response = await fetch('https://ipapi.co/json/');
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        console.log('Country code detected:', data.country_code || 'IN');
        return data.country_code || 'IN';
    } catch (error) {
        console.error('Failed to detect country code:', error.message);
        return 'IN';
    }
}

async function initializeApp(retryCount = 0) {
    userInteracted = false;
    console.log('Initializing app...', { retryCount, userInteracted });

    const requiredElements = ['countrySelect', 'volumeLevel', 'errorContainer', 'loading', 'stationImage', 'stationIcon', 'stationSearch', 'clearSearchBtn', 'mainContent', 'favoritesContent', 'favoritesList', 'muteBtn', 'aboutContent', 'enableNotificationsBtn'];
    if (!requiredElements.every(id => document.getElementById(id))) {
        console.error('Required DOM elements missing:', requiredElements.filter(id => !document.getElementById(id)));
        if (retryCount < 3) {
            console.log(`Retrying initialization in ${INIT_RETRY_DELAY}ms...`);
            setTimeout(() => initializeApp(retryCount + 1), INIT_RETRY_DELAY);
            return;
        }
        showError('The app couldn’t load properly.\nPlease refresh the page.');
        showCustomNotification("App Load Failed", {
            body: "The app couldn’t load properly. Please refresh the page.",
        });
        return;
    }

    showLoading(true);
    updateStationVisuals();

    try {
        const countrySelect = document.getElementById('countrySelect');
        console.log('Populating country dropdown...');
        populateCountryDropdown(STATIC_COUNTRIES);
        const userCountryCode = await getUserCountryCode();
        const validCountry = STATIC_COUNTRIES.some(c => c.code === userCountryCode);
        let selectedCountry = validCountry ? userCountryCode : 'IN';

        let lastStation = null;
        try {
            lastStation = JSON.parse(localStorage.getItem('lastStation'));
            console.log('Last station retrieved from localStorage:', lastStation);
        } catch (err) {
            console.warn('Failed to parse lastStation from localStorage:', err.message);
            localStorage.removeItem('lastStation');
        }

        if (lastStation && lastStation.countrycode && STATIC_COUNTRIES.some(c => c.code.toUpperCase() === lastStation.countrycode.toUpperCase())) {
            selectedCountry = lastStation.countrycode.toUpperCase();
            console.log('Setting country from last station:', selectedCountry);
        } else if (lastStation) {
            console.warn('Last station has invalid country code, clearing:', lastStation.countrycode);
            localStorage.removeItem('lastStation');
            lastStation = null;
        }

        countrySelect.value = selectedCountry;
        lastSelectedCountry = selectedCountry;
        console.log('Selected country:', selectedCountry);
        updateFlagDisplay(selectedCountry);
        await fetchAndDisplayAllStations(selectedCountry);

        if (lastStation && lastStation.language) {
            selectedLanguage = normalizeLanguage(lastStation.language) || '';
            console.log('Restoring language from last station:', selectedLanguage);
            if (selectedLanguage) {
                filterStationsByLanguage(selectedLanguage);
                populateLanguageDropdown();
                document.getElementById('languageSelect').value = selectedLanguage;
            }
        }

        if (lastStation && !isOffline) {
            console.log('Attempting to restore last station:', lastStation.name);
            const stationUrl = lastStation.url_resolved || lastStation.url;
            if (!stationUrl || !/^https?:\/\//.test(stationUrl)) {
                console.warn('Last station has invalid URL, clearing:', stationUrl);
                localStorage.removeItem('lastStation');
                lastStation = null;
            } else {
                const station = countryStations.find(s => s.url === lastStation.url);
                if (station) {
                    console.log('Last station found in countryStations:', station.name);
                    currentStation = station;
                    updateStationVisuals(station);
                    updatePlayerDisplay();
                    console.log('Showing restore message for station:', station.name);
                    showError(`Your last station, ${station.name}, is ready!\nTap play to listen.`);
                    showCustomNotification("Last Station Ready", {
                        body: `Your last station, ${station.name}, is ready! Tap play to listen.`,
                    });
                } else {
                    console.warn('Last station not found in countryStations, clearing lastStation');
                    localStorage.removeItem('lastStation');
                }
            }
        }

        if (!selectedLanguage) {
            populateLanguageDropdown();
        }

        stationsFailedToLoad = false;
        document.getElementById('volumeLevel').textContent = `${Math.round(audio.volume * 100)}%`;
        if (!lastStation || !currentStation) {
            clearError();
        }
        console.log('App initialized successfully');
        renderFavoritesList();
        setupNavigation();
        const homeLink = document.querySelector('.menu a[data-view="home"]');
        if (homeLink && !document.querySelector('.menu a.active')) {
            homeLink.classList.add('active');
            console.log('Set HOME as active on first load');
        }
    } catch (error) {
        console.error('Initialization failed:', error.message);
        stationsFailedToLoad = true;
        showError(isOffline ? 'You are offline!\nPlease check your internet connection.' : 'Failed to initialize app.\nPlease check your connection and refresh!');
        showCustomNotification("Initialization Failed", {
            body: isOffline ? "You are offline! Please check your internet connection." : "Failed to initialize app. Please check your connection and refresh!",
        });
    } finally {
        showLoading(false);
    }
}

function mergeDuplicateStations(stations) {
    const seen = new Map();
    const deduplicated = [];
    for (const station of stations) {
        const normalizedLanguage = normalizeLanguage(station.language);
        const key = `${station.name.toLowerCase()}|${normalizedLanguage || 'unknown'}|${station.url}`;
        if (!seen.has(key)) {
            seen.set(key, station);
            deduplicated.push(station);
        }
    }
    console.log(`Merged duplicates: ${stations.length} -> ${deduplicated.length} stations`);
    return deduplicated;
}

async function fetchAndDisplayAllStations(countryCode) {
    console.log('Fetching stations for country:', countryCode, 'with display mode:', stationDisplayMode);
    showLoading(true);
    try {
        const cacheKey = `${CACHE_KEY}_${countryCode}`;
        let allStations = null;

        if (countryCode.toUpperCase() === 'IN' && stationDisplayMode !== 'api-only') {
            console.log('Using custom stations for India, sorting by votes');
            allStations = [...CUSTOM_INDIAN_STATIONS].sort((a, b) => (b.votes || 0) - (a.votes || 0));
            if (stationDisplayMode === 'both') {
                console.log('Fetching additional API stations for India (both mode)...');
                const apiStations = await fetchFromFastestServer(`/json/stations/bycountrycodeexact/${countryCode}?hidebroken=true&order=votes&reverse=true`);
                allStations = [...allStations, ...(apiStations || [])];
            }
            localStorage.setItem(cacheKey, JSON.stringify({ data: allStations, timestamp: Date.now() }));
        } else if (stationDisplayMode === 'custom-only' && countryCode.toUpperCase() === 'IN') {
            console.log('Using only custom stations for India (custom-only mode)');
            allStations = [...CUSTOM_INDIAN_STATIONS].sort((a, b) => (b.votes || 0) - (a.votes || 0));
            localStorage.setItem(cacheKey, JSON.stringify({ data: allStations, timestamp: Date.now() }));
        } else {
            const cachedData = localStorage.getItem(cacheKey);
            if (cachedData) {
                const { data, timestamp } = JSON.parse(cachedData);
                if (Date.now() - timestamp < CACHE_DURATION) {
                    console.log('Using cached stations for:', countryCode);
                    allStations = data;
                }
            }
            if (!allStations) {
                console.log('Fetching fresh stations from API...');
                allStations = await fetchFromFastestServer(`/json/stations/bycountrycodeexact/${countryCode}?hidebroken=true&order=votes&reverse=true`);
                if (!allStations || !allStations.length) {
                    console.warn('No stations returned from API for:', countryCode);
                    allStations = [];
                }
                localStorage.setItem(cacheKey, JSON.stringify({ data: allStations, timestamp: Date.now() }));
                console.log('Stations cached successfully');
            }
        }

        countryStations = mergeDuplicateStations(allStations);
        selectedLanguage = '';
        searchQuery = '';
        document.getElementById('stationSearch').value = '';
        filterStationsByLanguage(selectedLanguage);
        populateLanguageDropdown();
        console.log('Rendering station list...', { stationCount: stations.length });
        renderStationList();
        renderFavoritesList();
        updateSearchVisibility();
    } catch (error) {
        console.error('Failed to fetch/display stations:', error.message);
        stationsFailedToLoad = true;
        if (countryCode.toUpperCase() === 'IN' && stationDisplayMode !== 'api-only') {
            console.log('Using custom stations for IN due to API failure');
            countryStations = mergeDuplicateStations([...CUSTOM_INDIAN_STATIONS].sort((a, b) => (b.votes || 0) - (a.votes || 0)));
            selectedLanguage = '';
            searchQuery = '';
            document.getElementById('stationSearch').value = '';
            filterStationsByLanguage(selectedLanguage);
            populateLanguageDropdown();
            renderStationList();
            renderFavoritesList();
            localStorage.setItem(`${CACHE_KEY}_${countryCode}`, JSON.stringify({
                data: countryStations,
                timestamp: Date.now()
            }));
        } else {
            showError('No stations loaded.\nPlease try another country or check your connection.');
            showCustomNotification("No Stations Loaded", {
                body: "No stations loaded. Please try another country or check your connection.",
            });
            stations = [];
            renderStationList();
            renderFavoritesList();
            populateLanguageDropdown();
        }
        updateSearchVisibility();
    } finally {
        showLoading(false);
    }
}

function populateCountryDropdown(countries) {
    const countrySelect = document.getElementById('countrySelect');
    if (!countrySelect) {
        console.error('Country select element not found');
        return;
    }
    countrySelect.innerHTML = '<option value="">Select Country</option>';
    const fragment = document.createDocumentFragment();
    countries.forEach(country => {
        const option = document.createElement('option');
        option.value = country.code;
        option.textContent = country.name;
        option.style.backgroundImage = `url('https://flagcdn.com/24x18/${country.code.toLowerCase()}.png')`;
        fragment.appendChild(option);
    });
    countrySelect.appendChild(fragment);
    countrySelect.disabled = false;
    countrySelect.removeEventListener('change', handleCountryChange);
    countrySelect.addEventListener('change', handleCountryChange);
    console.log('Country dropdown populated with', countries.length, 'options');
}

function handleCountryChange(e) {
    const countryCode = e.target.value;
    console.log('Country changed to:', countryCode);
    updateFlagDisplay(countryCode);
    if (countryCode) {
        clearError();
        selectedLanguage = '';
        searchQuery = '';
        document.getElementById('stationSearch').value = '';
        updateSearchVisibility();
        lastSelectedCountry = countryCode;
        document.getElementById('languageSelect').value = '';
        fetchAndDisplayAllStations(countryCode).catch(err => {
            console.error('Country change failed:', err.message);
            stationsFailedToLoad = true;
            showError(isOffline ? 'You are offline!\nPlease check your internet connection.' : 'Couldn’t load stations.\nTry another country!');
            showCustomNotification("Failed to Load Stations", {
                body: isOffline ? "You are offline! Please check your internet connection." : "Couldn’t load stations. Try another country!",
            });
        });
    } else {
        clearError();
        selectedLanguage = '';
        searchQuery = '';
        document.getElementById('stationSearch').value = '';
        updateSearchVisibility();
        document.getElementById('languageSelect').innerHTML = '<option value="">Select country first</option>';
        document.getElementById('languageSelect').disabled = true;
        document.getElementById('stationSelect').innerHTML = '<option value="">Select Station</option>';
        document.getElementById('stationSelect').disabled = true;
        console.log('Country reset, clearing language and station options');
    }
}

function updateFlagDisplay(countryCode) {
    const countrySelect = document.getElementById('countrySelect');
    if (countryCode) {
        countrySelect.style.backgroundImage = `url('https://flagcdn.com/24x18/${countryCode.toLowerCase()}.png')`;
        console.log('Flag updated for country:', countryCode);
    } else {
        countrySelect.style.backgroundImage = 'none';
        console.log('Flag cleared');
    }
}

function normalizeLanguage(rawLanguage) {
    if (!rawLanguage) return null;
    const cleanedLanguage = rawLanguage.toLowerCase().replace(/[^a-z\s,;-]/g, '').trim();
    if (!cleanedLanguage) return null;
    const languages = cleanedLanguage.split(/[,;-]/).map(lang => lang.trim());
    for (let lang of languages) {
        if (lang && LANGUAGE_NORMALIZATION[lang]) return LANGUAGE_NORMALIZATION[lang];
    }
    const firstLang = languages[0];
    if (firstLang && /^[a-z]+$/.test(firstLang)) {
        return firstLang.charAt(0).toUpperCase() + firstLang.slice(1);
    }
    return null;
}

function populateLanguageDropdown() {
    const languageSelect = document.getElementById('languageSelect');
    if (!languageSelect) {
        console.error('Language select element not found');
        return;
    }
    const languageCounts = new Map();
    countryStations.forEach(station => {
        const normalizedLanguage = normalizeLanguage(station.language);
        if (normalizedLanguage) {
            languageCounts.set(normalizedLanguage, (languageCounts.get(normalizedLanguage) || 0) + 1);
        }
    });
    const sortedLanguages = Array.from(languageCounts.keys()).sort();
    languageSelect.innerHTML = '<option value="">All Languages</option>';
    sortedLanguages.forEach(lang => {
        const count = languageCounts.get(lang);
        const option = document.createElement('option');
        option.value = lang;
        option.textContent = `${lang} (${count} station${count !== 1 ? 's' : ''})`;
        languageSelect.appendChild(option);
    });
    languageSelect.value = selectedLanguage || '';
    languageSelect.disabled = sortedLanguages.length === 0;
    languageSelect.removeEventListener('change', handleLanguageChange);
    languageSelect.addEventListener('change', handleLanguageChange);
    console.log('Language dropdown populated with', sortedLanguages.length, 'options');
}

function handleLanguageChange(e) {
    selectedLanguage = e.target.value;
    console.log('Language changed to:', selectedLanguage);
    searchQuery = '';
    document.getElementById('stationSearch').value = '';
    updateSearchVisibility();
    filterStationsByLanguage(selectedLanguage);
    renderStationList(true);
}

function filterStationsByLanguage(language) {
    let filteredStations = language ? countryStations.filter(station => normalizeLanguage(station.language) === language) : [...countryStations];
    if (searchQuery) {
        filteredStations = filteredStations.filter(station => 
            station.name.toLowerCase().includes(searchQuery.toLowerCase())
        );
    }
    stations = filteredStations;
    console.log('Filtered stations:', { language, searchQuery, count: stations.length });
}

function updateSearchVisibility() {
    const clearSearchBtn = document.getElementById('clearSearchBtn');
    const stationSearch = document.getElementById('stationSearch');
    clearSearchBtn.style.display = stationSearch.value.trim() ? 'flex' : 'none';
    console.log('Search visibility updated:', { hasValue: !!stationSearch.value.trim() });
}

function getFavorites() {
    return JSON.parse(localStorage.getItem('favorites') || '[]');
}

function saveFavorites(favorites) {
    localStorage.setItem('favorites', JSON.stringify(favorites));
}

function isFavorite(station) {
    const favorites = getFavorites();
    return favorites.some(f => f.url === station.url);
}

function toggleFavorite(station) {
    if (!station) return;
    console.log(`Toggling favorite for ${station.name}`);
    let favorites = getFavorites();
    const stationSelect = document.getElementById('stationSelect');
    const index = stations.findIndex(s => s.url === station.url);
    const isNowFavorite = !isFavorite(station);

    if (isNowFavorite) {
        favorites.push(station);
        console.log(`Added ${station.name} to favorites`);
        showCustomNotification("Added to Favorites", {
            body: `${station.name} has been added to your favorites.`,
        });
    } else {
        favorites = favorites.filter(f => f.url !== station.url);
        console.log(`Removed ${station.name} from favorites`);
        showCustomNotification("Removed from Favorites", {
            body: `${station.name} has been removed from your favorites.`,
        });
    }
    saveFavorites(favorites);

    if (index >= 0) {
        const mainOption = stationSelect.querySelector(`option[value="main-${index}"]`);
        if (mainOption) {
            mainOption.textContent = `${isNowFavorite ? '★ ' : ''}${station.name} ${station.bitrate ? `(${station.bitrate}kbps)` : ''}`;
            mainOption.classList.toggle('favorited', isNowFavorite);
            mainOption.setAttribute('aria-label', isNowFavorite ? `Favorite: ${station.name}` : station.name);
            console.log(`Updated main option for ${station.name}`, { isFavorite: isNowFavorite });
        }

        let favGroup = stationSelect.querySelector('optgroup[label="Favorites"]');
        if (isNowFavorite) {
            if (!favGroup) {
                favGroup = document.createElement('optgroup');
                favGroup.label = 'Favorites';
                stationSelect.insertBefore(favGroup, stationSelect.firstChild.nextSibling);
                console.log('Created Favorites optgroup');
            }
            const favOption = document.createElement('option');
            favOption.value = `fav-${index}`;
            favOption.textContent = `★ ${station.name} ${station.bitrate ? `(${station.bitrate}kbps)` : ''}`;
            favOption.classList.add('favorited');
            favOption.setAttribute('aria-label', `Favorite: ${station.name}`);
            favGroup.appendChild(favOption);
            console.log(`Added favorite option for ${station.name}`);
        } else {
            const favOption = stationSelect.querySelector(`option[value="fav-${index}"]`);
            if (favOption) {
                favOption.remove();
                console.log(`Removed favorite option for ${station.name}`);
            }
            if (favGroup && !favGroup.hasChildNodes()) {
                favGroup.remove();
                console.log('Removed empty Favorites optgroup');
            }
        }
    }

    if (stationSelect.value === `fav-${index}` && !isNowFavorite) {
        console.log(`Favorite option for ${station.name} was selected but removed, switching to main-${index}`);
        stationSelect.value = `main-${index}`;
    }

    updateFavoriteButton();
    renderFavoritesList();
}

function updateFavoriteButton() {
    const favoriteBtn = document.getElementById('favoriteBtn');
    if (!favoriteBtn) {
        console.error('Favorite button not found');
        return;
    }
    favoriteBtn.classList.toggle('favorited', currentStation && isFavorite(currentStation));
    favoriteBtn.disabled = !currentStation;
    favoriteBtn.setAttribute('aria-label', currentStation && isFavorite(currentStation) ? 'Remove from Favorites' : 'Add to Favorites');
    console.log('Favorite button updated', { isFavorited: currentStation && isFavorite(currentStation), station: currentStation?.name });
}

function renderFavoritesList() {
    const favoritesList = document.getElementById('favoritesList');
    if (!favoritesList) {
        console.error('Favorites list element not found');
        return;
    }
    const favorites = getFavorites();
    favoritesList.innerHTML = '';

    if (favorites.length === 0) {
        favoritesList.innerHTML = '<p class="no-favorites">No favorite stations yet.</p>';
        console.log('No favorites to display');
        return;
    }

    favorites.forEach((station, index) => {
        const favoriteItem = document.createElement('div');
        favoriteItem.classList.add('favorite-item');
        favoriteItem.setAttribute('data-url', station.url);

        const stationName = document.createElement('span');
        stationName.textContent = station.name;
        stationName.setAttribute('aria-label', `Select ${station.name}`);
        stationName.addEventListener('click', () => {
            console.log(`Favorite station clicked: ${station.name}`);
            handleUserInteraction();
            selectedFromFavorites = true;
            const stationSelect = document.getElementById('stationSelect');
            const optionIndex = stations.findIndex(s => s.url === station.url);
            if (optionIndex >= 0) {
                stationSelect.value = `fav-${optionIndex}`;
                playStation(stations[optionIndex]);
            } else {
                console.warn(`Favorite station ${station.name} not found in current stations`);
                showError(`Station ${station.name} is not available in the current country.\nPlease select another country.`);
                showCustomNotification("Station Not Available", {
                    body: `Station ${station.name} is not available in the current country. Please select another country.`,
                });
            }
        });

        const actionsDiv = document.createElement('div');
        actionsDiv.classList.add('favorite-actions');

        const playBtn = document.createElement('button');
        playBtn.classList.add('play-btn');
        playBtn.innerHTML = `<i class="fas ${currentStation?.url === station.url && isPlaying ? 'fa-pause' : 'fa-play'}"></i>`;
        playBtn.setAttribute('aria-label', currentStation?.url === station.url && isPlaying ? `Pause ${station.name}` : `Play ${station.name}`);
        playBtn.addEventListener('click', () => {
            console.log(`Play button clicked for favorite: ${station.name}`);
            handleUserInteraction();
            if (currentStation?.url === station.url && isPlaying) {
                audio.pause();
                isPlaying = false;
                isManuallyPaused = true;
                updatePlayerDisplay();
                updateMediaSession();
                showCustomNotification("Paused", {
                    body: `Station: ${station.name}`,
                });
            } else {
                selectedFromFavorites = true;
                const stationSelect = document.getElementById('stationSelect');
                const optionIndex = stations.findIndex(s => s.url === station.url);
                if (optionIndex >= 0) {
                    stationSelect.value = `fav-${optionIndex}`;
                    playStation(stations[optionIndex]);
                } else {
                    console.warn(`Favorite station ${station.name} not found in current stations`);
                    showError(`Station ${station.name} is not available in the current country.\nPlease select another country.`);
                    showCustomNotification("Station Not Available", {
                        body: `Station ${station.name} is not available in the current country. Please select another country.`,
                    });
                }
            }
        });

        const removeBtn = document.createElement('button');
        removeBtn.classList.add('remove-btn');
        removeBtn.innerHTML = '<i class="fas fa-trash"></i>';
        removeBtn.setAttribute('aria-label', `Remove ${station.name} from favorites`);
        removeBtn.addEventListener('click', () => {
            console.log(`Removing favorite: ${station.name}`);
            toggleFavorite(station);
        });

        const upBtn = document.createElement('button');
        upBtn.classList.add('move-btn', 'up-btn');
        upBtn.innerHTML = '<i class="fas fa-arrow-up"></i>';
        upBtn.setAttribute('aria-label', `Move ${station.name} up`);
        upBtn.disabled = index === 0;
        upBtn.addEventListener('click', () => {
            console.log(`Moving favorite up: ${station.name}`);
            const newFavorites = [...favorites];
            [newFavorites[index - 1], newFavorites[index]] = [newFavorites[index], newFavorites[index - 1]];
            saveFavorites(newFavorites);
            renderFavoritesList();
        });

        const downBtn = document.createElement('button');
        downBtn.classList.add('move-btn', 'down-btn');
        downBtn.innerHTML = '<i class="fas fa-arrow-down"></i>';
        downBtn.setAttribute('aria-label', `Move ${station.name} down`);
        downBtn.disabled = index === favorites.length - 1;
        downBtn.addEventListener('click', () => {
            console.log(`Moving favorite down: ${station.name}`);
            const newFavorites = [...favorites];
            [newFavorites[index], newFavorites[index + 1]] = [newFavorites[index + 1], newFavorites[index]];
            saveFavorites(newFavorites);
            renderFavoritesList();
        });

        actionsDiv.append(playBtn, removeBtn, upBtn, downBtn);
        favoriteItem.append(stationName, actionsDiv);
        favoritesList.appendChild(favoriteItem);
    });
    console.log('Favorites list rendered:', { count: favorites.length });
}

function updateFavoriteItemButtons() {
    const favoritesList = document.getElementById('favoritesList');
    if (!favoritesList) {
        console.error('Favorites list element not found');
        return;
    }
    const favoriteItems = favoritesList.querySelectorAll('.favorite-item');
    favoriteItems.forEach(item => {
        const stationUrl = item.getAttribute('data-url');
        const playBtn = item.querySelector('.play-btn');
        if (playBtn) {
            const isCurrentPlaying = currentStation?.url === stationUrl && isPlaying;
            playBtn.innerHTML = `<i class="fas ${isCurrentPlaying ? 'fa-pause' : 'fa-play'}"></i>`;
            playBtn.setAttribute('aria-label', isCurrentPlaying ? `Pause ${item.querySelector('span').textContent}` : `Play ${item.querySelector('span').textContent}`);
        }
    });
}

function renderStationList(clearPrevious = false) {
    const stationSelect = document.getElementById('stationSelect');
    if (!stationSelect) {
        console.error('Station select element not found');
        return;
    }
    if (clearPrevious) {
        stationSelect.innerHTML = '<option value="">Select Station</option>';
    }

    if (stations.length === 0) {
        stationSelect.innerHTML = '<option value="">No stations available</option>';
        stationSelect.disabled = true;
        console.log('No stations to render');
        return;
    }

    const fragment = document.createDocumentFragment();
    const favorites = getFavorites();
    const favGroup = document.createElement('optgroup');
    favGroup.label = 'Favorites';
    let hasFavorites = false;

    stations.forEach((station, index) => {
        const isFavorited = favorites.some(f => f.url === station.url);
        let favOption = null;

        if (isFavorited) {
            favOption = document.createElement('option');
            favOption.value = `fav-${index}`;
            favOption.textContent = `★ ${station.name} ${station.bitrate ? `(${station.bitrate}kbps)` : ''}`;
            favOption.classList.add('favorited');
            favOption.setAttribute('aria-label', `Favorite: ${station.name}`);
            favGroup.appendChild(favOption);
            hasFavorites = true;
            console.log(`Added favorite option for ${station.name}`);
        }

        const mainOption = document.createElement('option');
        mainOption.value = `main-${index}`;
        mainOption.textContent = `${isFavorited ? '★ ' : ''}${station.name} ${station.bitrate ? `(${station.bitrate}kbps)` : ''}`;
        if (isFavorited) {
            mainOption.classList.add('favorited');
        }
        mainOption.setAttribute('aria-label', isFavorited ? `Favorite: ${station.name}` : station.name);

        // Apply vote-based classes
        if (station.votes) {
            let voteClass;
            if (station.votes >= 1000) {
                voteClass = 'high-votes';
            } else if (station.votes <= 100) {
                voteClass = 'low-votes';
            } else {
                voteClass = 'medium-votes';
            }
            mainOption.classList.add(voteClass);
            if (favOption) {
                favOption.classList.add(voteClass);
            }
            console.log(`Applied vote class ${voteClass} to ${station.name}`, { votes: station.votes });
        }

        fragment.appendChild(mainOption);
    });

    if (hasFavorites) {
        fragment.insertBefore(favGroup, fragment.firstChild);
    }

    stationSelect.appendChild(fragment);
    stationSelect.disabled = false;
    console.log('Station list rendered:', { count: stations.length, hasFavorites });
}

async function testStream(url) {
    if (SKIP_STREAM_TEST) {
        console.log('Skipping stream test for:', url);
        return true;
    }
    console.log('Testing stream:', url);
    isChecking = true;
    const testAudio = new Audio();
    testAudio.src = url;
    testAudio.preload = 'none';
    testAudio.setAttribute('crossorigin', 'anonymous');

    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            console.warn('Stream test timed out for:', url);
            testAudio.src = '';
            testAudio.remove();
            isChecking = false;
            resolve(false);
        }, TEST_STREAM_TIMEOUT);

        testAudio.addEventListener('canplay', () => {
            console.log('Stream test successful for:', url);
            clearTimeout(timeout);
            testAudio.src = '';
            testAudio.remove();
            isChecking = false;
            resolve(true);
        }, { once: true });

        testAudio.addEventListener('error', () => {
            console.warn('Stream test failed for:', url);
            clearTimeout(timeout);
            testAudio.src = '';
            testAudio.remove();
            isChecking = false;
            resolve(false);
        }, { once: true });

        testAudio.load();
    });
}

async function playStation(station) {
    if (!station) {
        console.error('No station provided to play');
        showError('Please select a station first!');
        showCustomNotification("No Station Selected", {
            body: "Please select a station to play.",
        });
        return;
    }

    const now = Date.now();
    if (now - lastPlayAttempt < 1000) {
        console.warn('Play attempt debounced: too frequent');
        return;
    }
    lastPlayAttempt = now;

    showLoading(true);
    console.log('Attempting to play station:', station.name, { url: station.url });

    if (isOffline) {
        console.warn('Cannot play: device is offline');
        showError('You are offline!\nPlease check your internet connection.');
        showCustomNotification("Offline", {
            body: "You are offline! Please check your internet connection.",
        });
        showLoading(false);
        return;
    }

    try {
        const url = station.url_resolved || station.url;
        if (!url || !/^https?:\/\//.test(url)) {
            console.error('Invalid station URL:', url);
            showError('This station’s URL isn’t valid.\nPlease try another station.');
            showCustomNotification("Invalid Station URL", {
                body: `This station’s URL isn’t valid. Please try another station.`,
            });
            showLoading(false);
            return;
        }

        let streamUrl = url;
        if (url.toLowerCase().endsWith('.m3u8') && typeof Hls !== 'undefined' && Hls.isSupported()) {
            console.log('Using HLS for m3u8 stream:', url);
            const hls = new Hls();
            hls.loadSource(url);
            hls.attachMedia(audio);
            hls.on(Hls.Events.ERROR, (event, data) => {
                console.error('HLS error:', data);
                showError('This station’s stream failed.\nPlease try another station.');
                showCustomNotification("Stream Failed", {
                    body: `This station’s stream failed. Please try another station.`,
                });
                audio.pause();
                isPlaying = false;
                updatePlayerDisplay();
                showLoading(false);
            });
            streamUrl = null;
        } else {
            audio.src = streamUrl;
        }

        const isStreamValid = await testStream(streamUrl);
        if (!isStreamValid) {
            console.warn(`Stream test failed for ${station.name}`);
            showError('This station isn’t available right now.\nPlease try another one.');
            showCustomNotification("Station Unavailable", {
                body: `This station isn’t available right now. Please try another one.`,
            });
            showLoading(false);
            return;
        }

        await audioContext.resume();
        await audio.play();
        isPlaying = true;
        currentStation = station;
        localStorage.setItem('lastStation', JSON.stringify(station));
        updateStationVisuals(station);
        updatePlayerDisplay();
        startHeartbeat();
        startSilenceDetection();
        requestWakeLock();
        keepAliveAudio.play().catch(err => console.warn('Keep-alive audio failed:', err));
        console.log(`Playing ${station.name} successfully`);
        showCustomNotification(`Now Playing: ${station.name}`, {
            body: `Country: ${station.country || "Unknown"} | Language: ${normalizeLanguage(station.language) || "Unknown"}`,
            icon: station.favicon || "/apple-touch-icon.png",
        });
    } catch (error) {
        console.error(`Failed to play ${station.name}:`, error.message);
        isPlaying = false;
        const errorMessage = getAudioErrorMessage(error);
        showError(`${errorMessage}\nPlease try another station.`);
        showCustomNotification("Playback Error", {
            body: `${errorMessage}\nPlease try another station.`,
            icon: "/apple-touch-icon.png",
            vibrate: [300, 100, 300],
        });
        updatePlayerDisplay();
    } finally {
        showLoading(false);
    }
}

function startHeartbeat() {
    stopHeartbeat();
    if (!currentStation || isOffline) {
        console.warn('Heartbeat not started: no station or offline');
        return;
    }
    heartbeatTimer = setInterval(() => {
        console.log('Heartbeat check:', { isPlaying, station: currentStation.name });
        if (isPlaying && !audio.paused && audio.currentTime > 0) {
            console.log('Station is alive:', currentStation.name);
        } else if (!isManuallyPaused) {
            console.warn('Heartbeat failed, attempting to reconnect...');
            showError('Lost connection to the station.\nTrying to reconnect...');
            showCustomNotification("Lost Connection", {
                body: `Lost connection to ${currentStation.name}. Trying to reconnect...`,
            });
            playStation(currentStation);
        }
    }, HEARTBEAT_INTERVAL);
    console.log('Heartbeat started for:', currentStation.name);
}

function stopHeartbeat() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        console.log('Heartbeat stopped');
    }
}

function stopPlayback() {
    console.log('Stopping playback');
    isStopping = true;
    audio.pause();
    audio.src = '';
    audio.load();
    isPlaying = false;
    isManuallyPaused = true;
    currentStation = null;
    document.getElementById('stationSelect').value = '';
    stopHeartbeat();
    stopSilenceDetection();
    releaseWakeLock();
    updateStationVisuals(null, true);
    updatePlayerDisplay();
    updateMediaSession();
    showError('Music is manually stopped.');
    showCustomNotification("Playback Stopped", {
        body: "Music has been stopped.",
    });
    setTimeout(() => {
        isStopping = false;
        console.log('Stopping flag reset');
    }, 500);
}

function previousStation() {
    const stationSelect = document.getElementById('stationSelect');
    const options = Array.from(stationSelect.options).filter(opt => opt.value !== '');
    const currentValue = stationSelect.value;
    if (!currentValue || options.length === 0) {
        console.log('No previous station available');
        showCustomNotification("No Previous Station", {
            body: "No stations available.",
        });
        return;
    }
    const currentIndex = options.findIndex(opt => opt.value === currentValue);
    if (currentIndex <= 0) {
        console.log('At the first station');
        showCustomNotification("No Previous Station", {
            body: "You’re at the first station.",
        });
        return;
    }
    const prevOption = options[currentIndex - 1];
    const [type, index] = prevOption.value.split('-');
    const station = stations[parseInt(index)];
    console.log('Switching to previous station:', station.name);
    selectedFromFavorites = type === 'fav';
    playStation(station);
    stationSelect.value = prevOption.value;
}

function nextStation() {
    const stationSelect = document.getElementById('stationSelect');
    const options = Array.from(stationSelect.options).filter(opt => opt.value !== '');
    const currentValue = stationSelect.value;
    if (!currentValue || options.length === 0) {
        console.log('No next station available');
        showCustomNotification("No Next Station", {
            body: "No stations available.",
        });
        return;
    }
    const currentIndex = options.findIndex(opt => opt.value === currentValue);
    if (currentIndex >= options.length - 1) {
        console.log('At the last station');
        showCustomNotification("No Next Station", {
            body: "You’re at the last station.",
        });
        return;
    }
    const nextOption = options[currentIndex + 1];
    const [type, index] = nextOption.value.split('-');
    const station = stations[parseInt(index)];
    console.log('Switching to next station:', station.name);
    selectedFromFavorites = type === 'fav';
    playStation(station);
    stationSelect.value = nextOption.value;
}

function updatePlayerDisplay() {
    const nowPlaying = document.getElementById('nowPlaying');
    const playPauseBtn = document.getElementById('playPauseBtn');
    const stopBtn = document.getElementById('stopBtn');
    const previousBtn = document.getElementById('previousBtn');
    const nextBtn = document.getElementById('nextBtn');
    const player = document.querySelector('.player');
    const muteBtn = document.getElementById('muteBtn');
    const volumeSlider = document.getElementById('volume');

    if (!nowPlaying || !playPauseBtn || !stopBtn || !previousBtn || !nextBtn || !player || !muteBtn || !volumeSlider) {
        console.error('Player display elements missing');
        return;
    }

    if (currentStation) {
        nowPlaying.textContent = isPlaying ? currentStation.name : `Paused: ${currentStation.name}`;
        nowPlaying.classList.toggle('playing', isPlaying);
        const isOverflowing = nowPlaying.scrollWidth > nowPlaying.clientWidth;
        nowPlaying.classList.toggle('overflowing', isOverflowing && isPlaying);
        playPauseBtn.innerHTML = isPlaying ? '<i class="fas fa-pause"></i>' : '<i class="fas fa-play"></i>';
        playPauseBtn.classList.toggle('active', isPlaying);
        playPauseBtn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
        playPauseBtn.disabled = false;
        stopBtn.disabled = false;
        previousBtn.disabled = false;
        nextBtn.disabled = false;
        player.classList.toggle('progress-active', isPlaying);
    } else {
        nowPlaying.textContent = 'Select a station to play';
        nowPlaying.classList.remove('playing', 'overflowing');
        playPauseBtn.innerHTML = '<i class="fas fa-play"></i>';
        playPauseBtn.classList.remove('active');
        playPauseBtn.setAttribute('aria-label', 'Play');
        playPauseBtn.disabled = true;
        stopBtn.disabled = true;
        previousBtn.disabled = true;
        nextBtn.disabled = true;
        player.classList.remove('progress-active');
    }

    muteBtn.innerHTML = isMuted ? '<i class="fas fa-volume-mute"></i>' : '<i class="fas fa-volume-up"></i>';
    muteBtn.setAttribute('aria-label', isMuted ? 'Unmute' : 'Mute');
    volumeSlider.value = audio.volume;
    updateFavoriteButton();
    console.log('Player display updated', { station: currentStation?.name, isPlaying, isMuted });
}

function showError(message) {
    const errorContainer = document.getElementById('errorContainer');
    if (!errorContainer) {
        console.error('Error container not found');
        return;
    }
    if (lastError.message === message) {
        console.log('Duplicate error suppressed:', message);
        return;
    }
    lastError.message = message;

    if (errorDebounceTimeout) {
        clearTimeout(errorDebounceTimeout);
    }

    errorDebounceTimeout = setTimeout(() => {
        console.log('Displaying error:', message);
        errorContainer.innerHTML = `
            <div class="error-container">
                <span class="error">${message}</span>
                <button class="retry-button" aria-label="Retry"><i class="fas fa-redo"></i> Retry</button>
            </div>
        `;
        errorContainer.style.display = 'block';
        const retryButton = errorContainer.querySelector('.retry-button');
        if (retryButton) {
            retryButton.addEventListener('click', () => {
                console.log('Retry button clicked');
                handleUserInteraction();
                if (currentStation) {
                    console.log('Retrying current station:', currentStation.name);
                    playStation(currentStation);
                } else {
                    console.log('No current station, reinitializing app');
                    initializeApp();
                }
            });
        }
    }, 250);
}

function clearError() {
    const errorContainer = document.getElementById('errorContainer');
    if (!errorContainer) {
        console.error('Error container not found');
        return;
    }
    if (errorDebounceTimeout) {
        clearTimeout(errorDebounceTimeout);
        errorDebounceTimeout = null;
    }
    errorContainer.innerHTML = '';
    errorContainer.style.display = 'none';
    lastError.message = null;
    console.log('Error cleared');
}

function showLoading(show) {
    const loading = document.getElementById('loading');
    const progressBar = document.getElementById('progressBar');
    if (!loading || !progressBar) {
        console.error('Loading elements not found');
        return;
    }
    isLoading = show;
    loading.style.display = show ? 'block' : 'none';
    loading.setAttribute('aria-busy', show);
    if (show) {
        let progress = 0;
        progressBar.style.width = '0%';
        const interval = setInterval(() => {
            if (!isLoading) {
                clearInterval(interval);
                progressBar.style.width = '100%';
                setTimeout(() => {
                    loading.style.display = 'none';
                    progressBar.style.width = '0%';
                }, 300);
                return;
            }
            progress = (progress + 1) % 100;
            progressBar.style.width = `${progress}%`;
            progressBar.setAttribute('aria-valuenow', progress);
        }, 100);
    }
    console.log('Loading state:', show);
}

function setupNavigation() {
    const menuLinks = document.querySelectorAll('.menu a');
    const toggleBtn = document.querySelector('.toggle-btn');
    const menu = document.querySelector('.menu');
    const views = {
        home: document.getElementById('mainContent'),
        favorites: document.getElementById('favoritesContent'),
        about: document.getElementById('aboutContent')
    };

    if (!menuLinks.length || !toggleBtn || !menu || !Object.values(views).every(v => v)) {
        console.error('Navigation elements missing');
        return;
    }

    menuLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const view = link.getAttribute('data-view');
            console.log('Navigating to view:', view);
            menuLinks.forEach(l => l.classList.remove('active'));
            link.classList.add('active');
            Object.values(views).forEach(v => v.style.display = 'none');
            views[view].style.display = 'block';
            menu.classList.remove('show');
            toggleBtn.classList.remove('active');
            if (view === 'favorites') {
                renderFavoritesList();
            }
        });
    });

    toggleBtn.addEventListener('click', () => {
        const isActive = menu.classList.toggle('show');
        toggleBtn.classList.toggle('active', isActive);
        console.log('Menu toggled:', isActive ? 'shown' : 'hidden');
    });
}

document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM content loaded, setting up event listeners');
    const stationSelect = document.getElementById('stationSelect');
    const playPauseBtn = document.getElementById('playPauseBtn');
    const stopBtn = document.getElementById('stopBtn');
    const previousBtn = document.getElementById('previousBtn');
    const nextBtn = document.getElementById('nextBtn');
    const favoriteBtn = document.getElementById('favoriteBtn');
    const volumeSlider = document.getElementById('volume');
    const muteBtn = document.getElementById('muteBtn');
    const stationSearch = document.getElementById('stationSearch');
    const clearSearchBtn = document.getElementById('clearSearchBtn');
    const enableNotificationsBtn = document.getElementById('enableNotificationsBtn');

    if (!stationSelect || !playPauseBtn || !stopBtn || !previousBtn || !nextBtn || !favoriteBtn || !volumeSlider || !muteBtn || !stationSearch || !clearSearchBtn || !enableNotificationsBtn) {
        console.error('Required elements not found during setup');
        showError('The app couldn’t load properly.\nPlease refresh the page.');
        showCustomNotification("App Load Failed", {
            body: "The app couldn’t load properly. Please refresh the page.",
        });
        return;
    }

    stationSelect.addEventListener('change', (e) => {
        const value = e.target.value;
        console.log('Station select changed:', value);
        handleUserInteraction();
        if (!value) {
            stopPlayback();
            return;
        }
        const [type, index] = value.split('-');
        const station = stations[parseInt(index)];
        if (!station) {
            console.error('Selected station not found:', value);
            showError('Selected station not found.\nPlease try another.');
            showCustomNotification("Station Not Found", {
                body: "Selected station not found. Please try another.",
            });
            return;
        }
        console.log(`Selected station: ${station.name}, type: ${type}`);
        selectedFromFavorites = type === 'fav';
        playStation(station);
    });

    playPauseBtn.addEventListener('click', () => {
        const now = Date.now();
        if (now - lastPlayButtonClick < PLAY_BUTTON_DEBOUNCE) {
            console.warn('Play button click debounced: too frequent');
            return;
        }
        lastPlayButtonClick = now;

        handleUserInteraction();

        if (!currentStation) {
            console.log('No station selected for play/pause');
            showError('Please select a station first!');
            showCustomNotification("No Station Selected", {
                body: "Please select a station to play.",
            });
            return;
        }
        if (isPlaying) {
            console.log('Pausing playback from main player');
            isPlaying = false;
            isManuallyPaused = true;
            audio.pause();
            stopHeartbeat();
            stopSilenceDetection();
            releaseWakeLock();
            updatePlayerDisplay();
            updateMediaSession();
            showError('Paused! Click play to resume');
        } else {
            console.log('Initiating playback for station from main player:', currentStation.name);
            playStation(currentStation);
        }
    });

    stopBtn.addEventListener('click', () => {
        console.log('Stop button clicked');
        handleUserInteraction();
        stopPlayback();
    });

    previousBtn.addEventListener('click', () => {
        console.log('Previous button clicked');
        handleUserInteraction();
        previousStation();
    });

    nextBtn.addEventListener('click', () => {
        console.log('Next button clicked');
        handleUserInteraction();
        nextStation();
    });

    favoriteBtn.addEventListener('click', () => {
        console.log('Favorite button clicked');
        handleUserInteraction();
        if (currentStation) {
            toggleFavorite(currentStation);
        }
    });

    let isVolumeChanging = false;
    volumeSlider.addEventListener('input', (e) => {
        const volume = parseFloat(e.target.value);
        console.log('Volume input changed:', volume);
        if (!isVolumeChanging) {
            isVolumeChanging = true;
            audio.volume = volume;
            isMuted = volume === 0;
            previousVolume = volume > 0 ? volume : previousVolume;
            document.getElementById('volumeLevel').textContent = `${Math.round(volume * 100)}%`;
            updatePlayerDisplay();
            setTimeout(() => {
                isVolumeChanging = false;
            }, VOLUME_ANIMATION_DURATION);
        }
    });

    muteBtn.addEventListener('click', () => {
        console.log('Mute button clicked');
        handleUserInteraction();
        isMuted = !isMuted;
        audio.volume = isMuted ? 0 : previousVolume;
        volumeSlider.value = audio.volume;
        document.getElementById('volumeLevel').textContent = `${Math.round(audio.volume * 100)}%`;
        updatePlayerDisplay();
    });

    let searchTimeout;
    stationSearch.addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        searchQuery = e.target.value.trim();
        console.log('Search query updated:', searchQuery);
        searchTimeout = setTimeout(() => {
            filterStationsByLanguage(selectedLanguage);
            renderStationList(true);
            updateSearchVisibility();
        }, 300);
    });

    clearSearchBtn.addEventListener('click', () => {
        console.log('Clear search button clicked');
        stationSearch.value = '';
        searchQuery = '';
        filterStationsByLanguage(selectedLanguage);
        renderStationList(true);
        updateSearchVisibility();
    });

    enableNotificationsBtn.addEventListener('click', async () => {
        console.log('Enable notifications button clicked');
        const hasPermission = await requestNotificationPermission();
        if (hasPermission) {
            showCustomNotification("Notifications Enabled", {
                body: "You’ll now receive updates from World FM Radio!",
            });
        } else {
            showError("Notifications were not enabled.\nPlease check your browser settings.");
            showCustomNotification("Notifications Not Enabled", {
                body: "Notifications were not enabled. Please check your browser settings.",
            });
        }
    });

    window.addEventListener('online', () => {
        console.log('Network status: online');
        isOffline = false;
        if (currentStation && !isPlaying && !isManuallyPaused) {
            console.log('Network restored, resuming playback');
            playStation(currentStation);
        }
        showCustomNotification("Back Online", {
            body: "Your internet connection is restored!",
        });
    });

    window.addEventListener('offline', () => {
        console.log('Network status: offline');
        isOffline = true;
        if (isPlaying) {
            audio.pause();
            isPlaying = false;
            updatePlayerDisplay();
            updateMediaSession();
        }
        showError('You are offline!\nPlease check your internet connection.');
        showCustomNotification("Offline", {
            body: "You are offline! Please check your internet connection.",
        });
    });

    initializeApp();
});