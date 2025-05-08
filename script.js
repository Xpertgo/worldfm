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

const failedFaviconCache = new Set();

const keepAliveAudio = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=');
keepAliveAudio.loop = true;
keepAliveAudio.volume = 0;

function initializeAudioElement() {
    // Remove existing audio element if it exists
    if (audio) {
        audio.pause();
        audio.remove();
    }
    // Create a new audio element
    audio = new Audio();
    audio.autoplay = false;
    audio.preload = 'auto';
    audio.setAttribute('playsinline', '');
    audio.setAttribute('crossorigin', 'anonymous');
    document.body.appendChild(audio);
    // Reconnect audio context
    sourceNode = audioContext.createMediaElementSource(audio);
    analyser = audioContext.createAnalyser();
    sourceNode.connect(analyser);
    analyser.connect(audioContext.destination);
    analyser.fftSize = 256;
    console.log('Audio element reinitialized');
}

initializeAudioElement();

document.addEventListener('click', () => {
    userInteracted = true;
    console.log('User interaction detected, enabling autoplay.');
    audioContext.resume().then(() => {
        console.log('Audio context resumed');
        keepAliveAudio.play().catch(err => console.warn('Keep-alive audio failed to start:', err));
    }).catch(err => console.error('Failed to resume audio context:', err));
}, { once: true });

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
            });
        }).catch(err => {
            console.error('Failed to resume audio context on suspend:', err);
            showError("The music paused unexpectedly.\nPlease press play to resume.");
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
    }
    console.log('Audio paused', { manual: isManuallyPaused });
    updateFavoriteItemButtons();
});

audio.addEventListener('error', (e) => {
    if (isChecking) return;
    hasError = true;
    console.error('Audio error occurred:', e, { code: e.target?.error?.code, message: e.target?.error?.message });
    stopHeartbeat();
    stopSilenceDetection();
    isPlaying = false;
    if (isOffline) {
        showError('You are offline!\nPlease check your internet connection.');
        return;
    }
    const errorMessage = getAudioErrorMessage(e);
    if (currentStation && audioErrorRetryCount < MAX_AUDIO_ERROR_RETRIES) {
        audioErrorRetryCount++;
        console.warn(`Retrying ${currentStation.name} due to error (attempt ${audioErrorRetryCount}/${MAX_AUDIO_ERROR_RETRIES})`);
        showError(`${errorMessage} Retrying ${currentStation.name}... (attempt ${audioErrorRetryCount})`);
        setTimeout(() => playStation(currentStation), AUDIO_ERROR_RETRY_DELAY);
    } else {
        console.error(`${currentStation?.name || 'Station'} failed after ${MAX_AUDIO_ERROR_RETRIES} retries`);
        showError(`${errorMessage}\nPlease try another station.`);
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
        });
        keepAliveAudio.play().catch(err => console.warn('Keep-alive failed in background:', err));
    } else if (document.visibilityState === 'visible' && !isPlaying && currentStation && !isOffline && !isManuallyPaused) {
        console.log('App restored, resuming audio...');
        audioContext.resume().then(() => audio.play()).catch(err => {
            console.error('Failed to resume audio on visibility restore:', err);
            showError("The music didn’t restart.\nPlease tap play to bring it back!");
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
    if ('mediaSession' in navigator) {
        console.log('Updating media session', { station: currentStation?.name, isPlaying });
        navigator.mediaSession.metadata = new MediaMetadata({
            title: currentStation ? currentStation.name : 'World FM Radio',
            artist: 'World FM Radio',
            album: 'Live Stream',
            artwork: [
                { src: currentStation?.favicon || 'https://via.placeholder.com/96x96', sizes: '96x96', type: 'image/png' },
                { src: currentStation?.favicon || 'https://via.placeholder.com/128x128', sizes: '128x128', type: 'image/png' }
            ]
        });
        navigator.mediaSession.setActionHandler('play', async () => {
            if (currentStation && !isOffline) {
                console.log('Media session play triggered');
                audioContext.resume().then(() => {
                    audio.play().then(() => {
                        isPlaying = true;
                        isManuallyPaused = false;
                        updatePlayerDisplay();
                        startHeartbeat();
                        startSilenceDetection();
                        requestWakeLock();
                        keepAliveAudio.play().catch(err => console.warn('Keep-alive failed on play:', err));
                    }).catch(err => {
                        console.error('Media session play failed:', err);
                        showError("We couldn’t start the music.\nPlease try again or pick a new station!");
                    });
                });
            }
        });
        navigator.mediaSession.setActionHandler('pause', () => {
            console.log('Media session pause triggered');
            audio.pause();
            isPlaying = false;
            isManuallyPaused = true;
            stopHeartbeat();
            stopSilenceDetection();
            releaseWakeLock();
            updatePlayerDisplay();
            showError("Paused! Click play to resume");
        });
        navigator.mediaSession.setActionHandler('stop', stopPlayback);
        navigator.mediaSession.setActionHandler('previoustrack', previousStation);
        navigator.mediaSession.setActionHandler('nexttrack', nextStation);
        navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    }
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
    // Reset userInteracted on app load to ensure fresh user interaction
    userInteracted = false;
    console.log('Initializing app...', { retryCount, userInteracted });

    const requiredElements = ['countrySelect', 'volumeLevel', 'errorContainer', 'loading', 'stationImage', 'stationIcon', 'stationSearch', 'clearSearchBtn', 'mainContent', 'favoritesContent', 'favoritesList', 'muteBtn', 'aboutContent'];
    if (!requiredElements.every(id => document.getElementById(id))) {
        console.error('Required DOM elements missing:', requiredElements.filter(id => !document.getElementById(id)));
        if (retryCount < 3) {
            console.log(`Retrying initialization in ${INIT_RETRY_DELAY}ms...`);
            setTimeout(() => initializeApp(retryCount + 1), INIT_RETRY_DELAY);
            return;
        }
        showError('The app couldn’t load properly.\nPlease refresh the page.');
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
            // Validate the lastStation URL before proceeding
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
                    // Only prompt to play; do not auto-play without user interaction
                    console.log('Showing restore message for station:', station.name);
                    showError(`Your last station, ${station.name}, is ready!\nTap play to listen.`);
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
    console.log('Fetching stations for country:', countryCode);
    showLoading(true);
    try {
        const cacheKey = `${CACHE_KEY}_${countryCode}`;
        let allStations = null;

        if (countryCode.toUpperCase() === 'IN') {
            console.log('Using custom stations for India, sorting by votes');
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
        if (countryCode.toUpperCase() === 'IN') {
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
        });
    } else {
        clearError();
        selectedLanguage = '';
        searchQuery = '';
        document.getElementById('stationSearch').value = '';
        updateSearchVisibility();
        document.getElementById('languageSelect').innerHTML = '<option value="">Select country first</option>';
        document.getElementById('languageSelect').disabled = true;
        document.getElementById('stationSelect').innerHTML = '<option value="">Select language first</option>';
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
    } else {
        favorites = favorites.filter(f => f.url !== station.url);
        console.log(`Removed ${station.name} from favorites`);
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
            if (station.votes > 100) favOption.classList.add('high-votes');
            else if (station.votes < 10) favOption.classList.add('low-votes');
            else favOption.classList.add('medium-votes');
            favGroup.appendChild(favOption);
            console.log(`Added ${station.name} to Favorites optgroup`);
        } else if (favGroup) {
            const favOption = favGroup.querySelector(`option[value="fav-${index}"]`);
            if (favOption) {
                favOption.remove();
                console.log(`Removed ${station.name} from Favorites optgroup`);
            }
            if (favGroup.childElementCount === 0) {
                favGroup.remove();
                console.log('Removed empty Favorites optgroup');
            }
        }

        if (station.url === currentStation?.url) {
            const selectValue = selectedFromFavorites && isNowFavorite ? `fav-${index}` : `main-${index}`;
            stationSelect.value = selectValue;
            console.log(`Selected current station: ${station.name}`, { selectValue, selectedFromFavorites });
        }
    }

    updateFavoriteButton();
    updatePlayerDisplay();
    renderFavoritesList();
}

function updateFavoriteButton() {
    const favoriteBtn = document.getElementById('favoriteBtn');
    if (currentStation) {
        favoriteBtn.disabled = false;
        favoriteBtn.classList.toggle('favorited', isFavorite(currentStation));
    } else {
        favoriteBtn.disabled = true;
        favoriteBtn.classList.remove('favorited');
    }
}

function renderStationList(isLanguageChange = false) {
    const stationSelect = document.getElementById('stationSelect');
    stationSelect.innerHTML = '<option value="">Select Station</option>';
    const favorites = getFavorites();

    // Create optgroups for Favorites and Main stations
    const favGroup = document.createElement('optgroup');
    favGroup.label = 'Favorites';
    const mainGroup = document.createElement('optgroup');
    mainGroup.label = 'Main';

    // Append optgroups only if they will have content
    if (favorites.length > 0) {
        stationSelect.appendChild(favGroup);
    }
    if (stations.length > 0) {
        stationSelect.appendChild(mainGroup);
    }

    let index = 0;
    const start = performance.now();
    const renderBatch = () => {
        const mainFragment = document.createDocumentFragment();
        const favFragment = document.createDocumentFragment();
        const end = Math.min(index + BATCH_SIZE, stations.length);

        for (; index < end; index++) {
            const station = stations[index];
            const isFav = isFavorite(station);
            console.log('Rendering station:', { name: station.name, isFavorite: isFav });

            // Create main option
            const mainOption = document.createElement('option');
            mainOption.value = `main-${index}`;
            mainOption.textContent = `${isFav ? '★ ' : ''}${station.name} ${station.bitrate ? `(${station.bitrate}kbps)` : ''}`;
            mainOption.classList.toggle('favorited', isFav);
            mainOption.setAttribute('aria-label', isFav ? `Favorite: ${station.name}` : station.name);
            if (station.votes > 100) mainOption.classList.add('high-votes');
            else if (station.votes < 10) mainOption.classList.add('low-votes');
            else mainOption.classList.add('medium-votes');
            mainFragment.appendChild(mainOption);

            // Create favorite option if station is favorited
            if (isFav) {
                const favOption = document.createElement('option');
                favOption.value = `fav-${index}`;
                favOption.textContent = `★ ${station.name} ${station.bitrate ? `(${station.bitrate}kbps)` : ''}`;
                favOption.classList.add('favorited');
                favOption.setAttribute('aria-label', `Favorite: ${station.name}`);
                if (station.votes > 100) favOption.classList.add('high-votes');
                else if (station.votes < 10) favOption.classList.add('low-votes');
                else favOption.classList.add('medium-votes');
                favFragment.appendChild(favOption);
            }
        }

        mainGroup.appendChild(mainFragment);
        favGroup.appendChild(favFragment);

        if (index < stations.length) {
            requestAnimationFrame(renderBatch);
        } else {
            stationSelect.disabled = false;
            console.log(`Station list rendered: ${stations.length} stations in ${performance.now() - start}ms`);
            showLoading(false);
            updateFavoriteButton();
            if (!isLanguageChange && currentStation) {
                const currentIndex = stations.findIndex(s => s.url === currentStation.url);
                if (currentIndex >= 0) {
                    const selectValue = selectedFromFavorites && isFavorite(currentStation) ? `fav-${currentIndex}` : `main-${currentIndex}`;
                    stationSelect.value = selectValue;
                    console.log(`Restored current station selection: ${currentStation.name}`, { currentIndex, selectValue, selectedFromFavorites });
                }
            }
            updateSearchVisibility();
        }
    };

    console.log('Starting station list render...', { isLanguageChange });
    requestAnimationFrame(renderBatch);
}

function moveFavorite(index, direction) {
    const favorites = getFavorites();
    if (!favorites || favorites.length < 2) {
        console.log('Not enough favorites to reorder');
        return;
    }

    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= favorites.length) {
        console.log('Cannot move favorite beyond list bounds:', { index, direction });
        return;
    }

    [favorites[index], favorites[newIndex]] = [favorites[newIndex], favorites[index]];
    console.log(`Moved favorite from index ${index} to ${newIndex}`);

    saveFavorites(favorites);
    renderFavoritesList();
    renderStationList();
}

function renderFavoritesList() {
    const favoritesList = document.getElementById('favoritesList');
    const favorites = getFavorites();

    favoritesList.innerHTML = '';
    if (favorites.length === 0) {
        favoritesList.innerHTML = '<p class="no-favorites">No favorite stations yet.</p>';
        console.log('No favorites to display');
        return;
    }

    const fragment = document.createDocumentFragment();
    favorites.forEach((station, index) => {
        const favoriteItem = document.createElement('div');
        favoriteItem.className = 'favorite-item';

        const stationName = document.createElement('span');
        stationName.textContent = station.name;
        stationName.setAttribute('aria-label', `Play ${station.name}`);
        stationName.addEventListener('click', () => {
            console.log('Playing favorite station:', station.name);
            selectedFromFavorites = true;
            playStation(station);
            const stationIndex = stations.findIndex(s => s.url === station.url);
            if (stationIndex >= 0) {
                document.getElementById('stationSelect').value = `fav-${stationIndex}`;
            }
        });

        const actions = document.createElement('div');
        actions.className = 'favorite-actions';

        const upBtn = document.createElement('button');
        upBtn.className = 'move-btn up-btn';
        upBtn.innerHTML = '<i class="fas fa-arrow-up"></i>';
        upBtn.setAttribute('aria-label', `Move ${station.name} up`);
        upBtn.disabled = index === 0;
        upBtn.addEventListener('click', () => moveFavorite(index, -1));

        const downBtn = document.createElement('button');
        downBtn.className = 'move-btn down-btn';
        downBtn.innerHTML = '<i class="fas fa-arrow-down"></i>';
        downBtn.setAttribute('aria-label', `Move ${station.name} down`);
        downBtn.disabled = index === favorites.length - 1;
        downBtn.addEventListener('click', () => moveFavorite(index, 1));

        const playBtn = document.createElement('button');
        playBtn.className = 'play-btn';
        playBtn.innerHTML = (currentStation && station.url === currentStation.url && isPlaying)
            ? '<i class="fas fa-pause"></i>'
            : '<i class="fas fa-play"></i>';
        playBtn.setAttribute('aria-label',
            (currentStation && station.url === currentStation.url && isPlaying)
                ? `Pause ${station.name}`
                : `Play ${station.name}`
        );
        playBtn.addEventListener('click', () => {
            if (currentStation && station.url === currentStation.url && isPlaying) {
                console.log('Pausing current station:', station.name);
                audio.pause();
                isManuallyPaused = true;
                isPlaying = false;
                stopHeartbeat();
                stopSilenceDetection();
                releaseWakeLock();
                updatePlayerDisplay();
                showError("Paused! Click play to resume");
                playBtn.innerHTML = '<i class="fas fa-play"></i>';
                playBtn.setAttribute('aria-label', `Play ${station.name}`);
            } else {
                console.log('Playing favorite station:', station.name);
                selectedFromFavorites = true;
                playStation(station);
                const stationIndex = stations.findIndex(s => s.url === station.url);
                if (stationIndex >= 0) {
                    document.getElementById('stationSelect').value = `fav-${stationIndex}`;
                }
                playBtn.innerHTML = '<i class="fas fa-pause"></i>';
                playBtn.setAttribute('aria-label', `Pause ${station.name}`);
            }
            updateFavoriteItemButtons();
        });

        const removeBtn = document.createElement('button');
        removeBtn.className = 'remove-btn';
        removeBtn.innerHTML = '<i class="fas fa-trash"></i>';
        removeBtn.setAttribute('aria-label', `Remove ${station.name} from favorites`);
        removeBtn.addEventListener('click', () => {
            const confirmDelete = window.confirm(`Are you sure you want to remove ${station.name} from favorites?`);
            if (confirmDelete) {
                console.log('Removing favorite:', station.name);
                toggleFavorite(station);
            } else {
                console.log('Favorite removal cancelled:', station.name);
            }
        });

        actions.appendChild(upBtn);
        actions.appendChild(downBtn);
        actions.appendChild(playBtn);
        actions.appendChild(removeBtn);
        favoriteItem.appendChild(stationName);
        favoriteItem.appendChild(actions);
        fragment.appendChild(favoriteItem);
    });

    favoritesList.appendChild(fragment);
    console.log('Favorites list rendered:', favorites.length, 'items');
}

function updateFavoriteItemButtons() {
    const favoriteItems = document.querySelectorAll('.favorite-item');
    favoriteItems.forEach(item => {
        const stationName = item.querySelector('span').textContent;
        const playBtn = item.querySelector('.play-btn');
        const station = getFavorites().find(f => f.name === stationName);
        if (station && playBtn) {
            playBtn.innerHTML = (currentStation && station.url === currentStation.url && isPlaying)
                ? '<i class="fas fa-pause"></i>'
                : '<i class="fas fa-play"></i>';
            playBtn.setAttribute('aria-label',
                (currentStation && station.url === currentStation.url && isPlaying)
                    ? `Pause ${station.name}`
                    : `Play ${station.name}`
            );
        }
    });
}

async function testStream(url) {
    if (isOffline) {
        console.warn('Offline, skipping stream test');
        return false;
    }
    console.log('Testing stream:', url);
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TEST_STREAM_TIMEOUT);
        const response = await fetch(url, { method: 'HEAD', signal: controller.signal });
        clearTimeout(timeoutId);
        const contentType = response.headers.get('Content-Type') || '';
        const isValid = (contentType.includes('audio/mpeg') || contentType.includes('audio/mp3')) && response.ok;
        console.log('Stream test result:', { url, isValid, contentType });
        return isValid;
    } catch (error) {
        console.error('Stream test failed:', error.message);
        return false;
    }
}

async function checkAudioReady(audioElement) {
    return new Promise((resolve) => {
        if (audioElement.readyState >= 2) { // HAVE_CURRENT_DATA or higher
            console.log('Audio element ready:', { readyState: audioElement.readyState });
            resolve(true);
        } else {
            console.log('Waiting for audio to be ready...', { readyState: audioElement.readyState });
            audioElement.addEventListener('loadeddata', () => {
                console.log('Audio data loaded:', { readyState: audioElement.readyState });
                resolve(true);
            }, { once: true });
            audioElement.addEventListener('error', () => {
                console.error('Audio failed to load data');
                resolve(false);
            }, { once: true });
            // Timeout to avoid hanging
            setTimeout(() => {
                console.warn('Audio readiness check timed out');
                resolve(false);
            }, 5000);
        }
    });
}

async function playStation(station) {
    if (isOffline) {
        showError('You are offline!\nPlease check your internet connection.');
        return;
    }

    if (!station || !station.url) {
        console.error('Invalid station or missing URL:', station);
        showError('No valid station selected.\nPlease choose another station.');
        return;
    }

    // Debounce rapid station changes
    const now = Date.now();
    if (now - lastPlayAttempt < 500) {
        console.warn('Station change debounced: too frequent');
        return;
    }
    lastPlayAttempt = now;

    console.log('Attempting to play station:', { name: station.name, url: station.url, favicon: station.favicon });
    clearError();
    showLoading(true);
    hasError = false;
    isManuallyPaused = false;
    isPlaying = false;

    // Fully reset audio element by reinitializing it
    initializeAudioElement();
    stopHeartbeat();
    stopSilenceDetection();
    currentStation = station;

    updateStationVisuals(station);
    updatePlayerDisplay();

    try {
        // Ensure audio context is resumed
        if (audioContext.state === 'suspended') {
            if (!userInteracted) {
                throw new Error('Audio context suspended: user interaction required');
            }
            await audioContext.resume();
            console.log('Audio context resumed for playback');
        }

        let url = station.url_resolved || station.url;
        if (!url || !/^https?:\/\//.test(url)) {
            throw new Error('Invalid stream URL');
        }
        console.log('Resolved URL:', url);

        // Handle playlist files (.m3u, .pls)
        if (url.endsWith('.m3u') || url.endsWith('.pls')) {
            console.log('Fetching playlist file:', url);
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);
            try {
                const response = await fetch(url, { signal: controller.signal });
                clearTimeout(timeoutId);
                if (!response.ok) {
                    throw new Error(`Failed to fetch playlist: ${response.statusText}`);
                }
                const text = await response.text();
                const lines = text.split('\n');
                const streamUrl = lines.find(line => line.trim().startsWith('http'));
                if (!streamUrl) {
                    throw new Error('No valid stream URL found in playlist');
                }
                url = streamUrl.trim();
                console.log('Found stream URL in playlist:', url);
            } catch (err) {
                console.error('Playlist fetch failed:', err.message);
                throw new Error('Unable to process playlist file');
            }
        }

        // Validate the final URL after playlist resolution
        if (!url || !/^https?:\/\//.test(url)) {
            throw new Error('Station URL is invalid or empty after resolution');
        }

        // Skip stream test if configured to do so
        if (!SKIP_STREAM_TEST) {
            const isStreamValid = await testStream(url);
            if (!isStreamValid) {
                throw new Error('Stream test failed: This station isn’t supported by your device.');
            }
        }

        // Configure audio element
        audio.src = url;
        audio.crossOrigin = 'anonymous';
        audio.volume = document.getElementById('volume') ? parseFloat(document.getElementById('volume').value) : 0.5;
        audio.muted = isMuted;
        console.log('Starting playback...', { url, volume: audio.volume, muted: isMuted });

        // Wait for audio to be ready
        const isReady = await checkAudioReady(audio);
        if (!isReady) {
            throw new Error('Audio failed to load: stream not ready');
        }

        // Attempt playback with timeout
        const playPromise = audio.play();
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Playback timed out')), 15000);
        });

        await Promise.race([playPromise, timeoutPromise]);

        isPlaying = true;
        hasError = false;
        const stationIndex = stations.indexOf(station);
        if (stationIndex >= 0) {
            const selectValue = selectedFromFavorites && isFavorite(station) ? `fav-${stationIndex}` : `main-${stationIndex}`;
            document.getElementById('stationSelect').value = selectValue;
            console.log(`Set station selection: ${station.name}`, { selectValue, selectedFromFavorites });
        }
        clearError();
        updatePlayerDisplay();
        updateMediaSession();
        requestWakeLock();
        keepAliveAudio.play().catch(err => console.warn('Keep-alive failed on station play:', err));
        localStorage.setItem('lastStation', JSON.stringify(station));
        console.log('Station playing successfully:', station.name);
    } catch (error) {
        console.error('Failed to play station:', error.message, { station });
        hasError = true;
        isPlaying = false;
        let errorMessage = `We couldn’t play ${station.name}.\nPlease try another station.`;
        if (error.message.includes('Invalid stream URL')) {
            errorMessage = `Invalid URL for ${station.name}.\nPlease select another station.`;
        } else if (error.message.includes('Station URL is invalid or empty after resolution')) {
            errorMessage = `Station URL is invalid or empty for ${station.name}.\nPlease try another station.`;
        } else if (error.message.includes('playlist')) {
            errorMessage = `Unable to load playlist for ${station.name}.\nPlease try another station.`;
        } else if (error.message.includes('timed out')) {
            errorMessage = `Connection to ${station.name} timed out.\nPlease try again or select another station.`;
        } else if (error.message.includes('Stream test failed')) {
            errorMessage = `This station isn’t supported by your device.\nPlease try another station.`;
        } else if (error.message.includes('user interaction required')) {
            errorMessage = `Please interact with the page (e.g., click) to play ${station.name}.`;
        } else if (error.message.includes('stream not ready')) {
            errorMessage = `Stream for ${station.name} failed to load.\nPlease try again or select another station.`;
        } else if (error.message.includes('play() request was interrupted')) {
            errorMessage = `Playback of ${station.name} was interrupted.\nPlease try again.`;
        }
        showError(errorMessage);
    } finally {
        showLoading(false);
    }
}

function animateVolumeChange(start, end, callback) {
    const duration = VOLUME_ANIMATION_DURATION;
    const startTime = performance.now();
    const volumeInput = document.getElementById('volume');
    const volumeLevel = document.getElementById('volumeLevel');

    function step() {
        const elapsed = performance.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const easedProgress = progress;
        const currentValue = start + (end - start) * easedProgress;
        volumeInput.value = currentValue / 100;
        audio.volume = isMuted ? 0 : currentValue / 100;
        volumeLevel.textContent = `${Math.round(currentValue)}%`;
        if (progress < 1) {
            requestAnimationFrame(step);
        } else {
            callback();
        }
    }

    volumeLevel.style.transition = `opacity ${duration}ms`;
    volumeLevel.style.opacity = '0.5';
    requestAnimationFrame(step);
    setTimeout(() => {
        volumeLevel.style.opacity = '1';
    }, duration);
}

function toggleMute() {
    isMuted = !isMuted;
    const muteBtn = document.getElementById('muteBtn');
    const volumeLevel = document.getElementById('volumeLevel');
    const volumeInput = document.getElementById('volume');

    muteBtn.innerHTML = isMuted 
        ? '<i class="fas fa-volume-mute"></i>' 
        : '<i class="fas fa-volume-up"></i>';
    muteBtn.setAttribute('aria-label', isMuted ? 'Unmute' : 'Mute');

    if (isMuted) {
        previousVolume = audio.volume || 0.5; // Store current volume or default to 0.5
        animateVolumeChange(audio.volume * 100, 0, () => {
            audio.volume = 0;
            audio.muted = true;
            volumeLevel.textContent = '0%';
            volumeInput.value = 0;
            console.log('Muted with animation', { volume: audio.volume, isMuted });
        });
    } else {
        const targetVolume = previousVolume || 0.5; // Restore previous volume or default to 0.5
        animateVolumeChange(0, targetVolume * 100, () => {
            audio.volume = targetVolume;
            audio.muted = false;
            volumeLevel.textContent = `${Math.round(targetVolume * 100)}%`;
            volumeInput.value = targetVolume;
            console.log('Unmuted with animation', { volume: audio.volume, isMuted });
        });
    }
}

function showLoading(show) {
    const loading = document.getElementById('loading');
    const progressBar = document.getElementById('progressBar');
    const player = document.querySelector('.player');

    if (!loading || !progressBar || !player) {
        console.error('Loading elements not found in DOM', {
            loading: !!loading,
            progressBar: !!progressBar,
            player: !!player
        });
        return;
    }

    isLoading = show;
    loading.style.display = show ? 'block' : 'none';
    loading.setAttribute('aria-busy', show ? 'true' : 'false');

    player.classList.toggle('progress-active', show);

    let animationFrame = null;
    if (window.currentLoadingAnimation) {
        cancelAnimationFrame(window.currentLoadingAnimation);
        window.currentLoadingAnimation = null;
    }

    const updateProgress = progress => {
        progressBar.style.width = `${progress}%`;
        progressBar.setAttribute('aria-valuenow', Math.round(progress));
    };

    if (show) {
        updateProgress(0);
        let progress = 0;

        const animateProgress = () => {
            if (!isLoading) return;

            const increment = Math.random() * (90 - progress) * 0.05;
            progress = Math.min(progress + increment, 90);
            updateProgress(progress);

            if (progress < 90 && isLoading) {
                window.currentLoadingAnimation = requestAnimationFrame(animateProgress);
            }
        };

        window.currentLoadingAnimation = requestAnimationFrame(animateProgress);
    } else {
        if (progressBar.style.width !== '100%') {
            updateProgress(100);
            setTimeout(() => {
                if (!isLoading) updateProgress(0);
            }, 300);
        }
    }

    console.log('Loading state changed:', {
        show,
        progress: progressBar.style.width,
        isLoading
    });
}

function showError(message) {
    const errorContainer = document.getElementById('errorContainer');
    if (!errorContainer) {
        console.error('Error container not found in DOM');
        return;
    }
    if (!message || (lastError.message === message && !isLoading)) return;

    if (errorDebounceTimeout) clearTimeout(errorDebounceTimeout);
    errorDebounceTimeout = setTimeout(() => {
        errorContainer.innerHTML = '';
        const errorDiv = document.createElement('div');
        errorDiv.className = 'error-container';
        const errorMessage = document.createElement('div');
        errorMessage.className = 'error';
        errorMessage.textContent = message;
        errorDiv.appendChild(errorMessage);
        errorContainer.appendChild(errorDiv);
        lastError = { message };
        hasError = true;
        console.log('Error displayed:', message);
        updatePlayerDisplay();
    }, 250);
}

function clearError() {
    const errorContainer = document.getElementById('errorContainer');
    if (!errorContainer) return;
    if (errorDebounceTimeout) clearTimeout(errorDebounceTimeout);
    errorContainer.innerHTML = '';
    lastError = { message: null };
    hasError = false;
    console.log('Error cleared');
    updatePlayerDisplay();
}

function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
        if (isPlaying && !audio.paused && audio.currentTime > 0) {
            console.log('Heartbeat: Audio is playing', { station: currentStation?.name, time: audio.currentTime });
        } else {
            console.warn('Heartbeat: Audio stopped unexpectedly', { isPlaying, paused: audio.paused, time: audio.currentTime });
            if (!isManuallyPaused && !isOffline && currentStation) {
                showError("The music stopped unexpectedly.\nPlease press play to resume.");
                audio.pause();
                isPlaying = false;
                updatePlayerDisplay();
                stopHeartbeat();
                stopSilenceDetection();
            }
        }
    }, HEARTBEAT_INTERVAL);
    console.log('Heartbeat started');
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
    audio.pause();
    audio.src = '';
    audio.load();
    isPlaying = false;
    isManuallyPaused = true;
    currentStation = null;
    stopHeartbeat();
    stopSilenceDetection();
    releaseWakeLock();
    updateStationVisuals(null, true);
    updatePlayerDisplay();
    updateMediaSession();
    clearError();
    document.getElementById('stationSelect').value = '';
    
    console.log('Playback stopped, state reset');
}

function previousStation() {
    const stationSelect = document.getElementById('stationSelect');
    const options = Array.from(stationSelect.options).filter(opt => opt.value !== '');
    const currentValue = stationSelect.value;
    if (!currentValue || options.length === 0) {
        console.log('No previous station available');
        return;
    }
    const currentIndex = options.findIndex(opt => opt.value === currentValue);
    if (currentIndex <= 0) {
        console.log('At the first station');
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
        return;
    }
    const currentIndex = options.findIndex(opt => opt.value === currentValue);
    if (currentIndex >= options.length - 1) {
        console.log('At the last station');
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
    const playPauseBtn = document.getElementById('playPauseBtn');
    const stopBtn = document.getElementById('stopBtn');
    const previousBtn = document.getElementById('previousBtn');
    const nextBtn = document.getElementById('nextBtn');
    const nowPlaying = document.getElementById('nowPlaying');
    const stationSelect = document.getElementById('stationSelect');
    const muteBtn = document.getElementById('muteBtn');

    playPauseBtn.innerHTML = isPlaying ? '<i class="fas fa-pause"></i>' : '<i class="fas fa-play"></i>';
    playPauseBtn.disabled = !currentStation || isOffline;
    playPauseBtn.classList.toggle('active', isPlaying);

    stopBtn.disabled = !currentStation || isOffline;

    const options = Array.from(stationSelect.options).filter(opt => opt.value !== '');
    const currentValue = stationSelect.value;
    const currentIndex = currentValue ? options.findIndex(opt => opt.value === currentValue) : -1;
    previousBtn.disabled = !currentStation || isOffline || currentIndex <= 0;
    nextBtn.disabled = !currentStation || isOffline || currentIndex >= options.length - 1 || currentIndex === -1;

    nowPlaying.innerHTML = currentStation
        ? `<span>Now Playing: ${currentStation.name}</span>`
        : `<span>Select a station to play</span>`;
    nowPlaying.classList.toggle('playing', isPlaying && !!currentStation);
    nowPlaying.classList.toggle('overflowing', currentStation && currentStation.name.length > 20);

    muteBtn.innerHTML = isMuted 
        ? '<i class="fas fa-volume-mute"></i>' 
        : '<i class="fas fa-volume-up"></i>';
    muteBtn.disabled = !currentStation || isOffline;

    updateFavoriteButton();
    console.log('Player display updated:', {
        station: currentStation?.name,
        isPlaying,
        hasError,
        isOffline,
        isMuted,
        currentValue
    });
}

function setupNavigation() {
    const toggleBtn = document.querySelector('.toggle-btn');
    const menu = document.querySelector('.menu');
    const navLinks = document.querySelectorAll('.menu a');
    const mainContent = document.getElementById('mainContent');
    const favoritesContent = document.getElementById('favoritesContent');
    const aboutContent = document.getElementById('aboutContent');

    toggleBtn.addEventListener('click', () => {
        const isMenuOpen = menu.classList.toggle('show');
        toggleBtn.classList.toggle('active', isMenuOpen);
        toggleBtn.innerHTML = isMenuOpen
            ? '<i class="fas fa-times"></i>'
            : '<i class="fas fa-bars"></i>';
        console.log('Menu toggled:', isMenuOpen ? 'open' : 'closed');
    });

    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const view = link.getAttribute('data-view');
            console.log('Navigation clicked:', view);

            navLinks.forEach(l => l.classList.remove('active'));
            link.classList.add('active');

            // Hide all content sections
            mainContent.style.display = 'none';
            favoritesContent.style.display = 'none';
            aboutContent.style.display = 'none';

            // Show the selected content section
            if (view === 'home') {
                mainContent.style.display = 'block';
            } else if (view === 'favorites') {
                favoritesContent.style.display = 'block';
                renderFavoritesList();
            } else if (view === 'about') {
                aboutContent.style.display = 'block';
            }

            menu.classList.remove('show');
            toggleBtn.classList.remove('active');
            toggleBtn.innerHTML = '<i class="fas fa-bars"></i>';
            console.log('View switched to:', view);
        });
    });

    console.log('Navigation setup completed');
}

document.addEventListener('DOMContentLoaded', () => {
    initializeApp();

    const stationSelect = document.getElementById('stationSelect');
    stationSelect.addEventListener('change', (e) => {
        const value = e.target.value;
        if (!value) {
            console.log('Station selection cleared');
            stopPlayback();
            return;
        }
        const [type, index] = value.split('-');
        const station = stations[parseInt(index)];
        console.log('Station selected:', { name: station.name, type, index });
        selectedFromFavorites = type === 'fav';
        playStation(station);
    });

    const playPauseBtn = document.getElementById('playPauseBtn');
    playPauseBtn.addEventListener('click', () => {
        const now = Date.now();
        if (now - lastPlayButtonClick < PLAY_BUTTON_DEBOUNCE) {
            console.warn('Play button click debounced: too frequent');
            return;
        }
        lastPlayButtonClick = now;

        if (!currentStation) {
            console.log('No station selected for play/pause');
            showError('Please select a station first!');
            return;
        }
        if (isPlaying) {
            console.log('Pausing playback');
            audio.pause();
            isManuallyPaused = true;
            isPlaying = false;
            stopHeartbeat();
            stopSilenceDetection();
            releaseWakeLock();
            updatePlayerDisplay();
            showError("Paused! Click play to resume");
        } else {
            console.log('Initiating playback for station:', currentStation.name);
            playStation(currentStation);
        }
    });

    const stopBtn = document.getElementById('stopBtn');
    stopBtn.addEventListener('click', stopPlayback);

    const previousBtn = document.getElementById('previousBtn');
    previousBtn.addEventListener('click', previousStation);

    const nextBtn = document.getElementById('nextBtn');
    nextBtn.addEventListener('click', nextStation);

    const favoriteBtn = document.getElementById('favoriteBtn');
    favoriteBtn.addEventListener('click', () => {
        if (currentStation) {
            toggleFavorite(currentStation);
        }
    });

    const volumeInput = document.getElementById('volume');
    const volumeLevel = document.getElementById('volumeLevel');
    const muteBtn = document.getElementById('muteBtn');
    volumeInput.addEventListener('input', () => {
        const volume = parseFloat(volumeInput.value);
        if (volume === 0) {
            isMuted = true;
            previousVolume = previousVolume || 0.5; // Store last non-zero volume or default
            audio.volume = 0;
            audio.muted = true;
            volumeLevel.textContent = '0%';
            muteBtn.innerHTML = '<i class="fas fa-volume-mute"></i>';
            muteBtn.setAttribute('aria-label', 'Unmute');
            console.log('Volume manually set to 0, muted', { volume, isMuted });
        } else {
            isMuted = false;
            audio.volume = volume;
            audio.muted = false;
            previousVolume = volume;
            volumeLevel.textContent = `${Math.round(volume * 100)}%`;
            muteBtn.innerHTML = '<i class="fas fa-volume-up"></i>';
            muteBtn.setAttribute('aria-label', 'Mute');
            console.log('Volume changed:', { volume, isMuted });
        }
    });

    muteBtn.addEventListener('click', toggleMute);

    const stationSearch = document.getElementById('stationSearch');
    const clearSearchBtn = document.getElementById('clearSearchBtn');
    stationSearch.addEventListener('input', (e) => {
        searchQuery = e.target.value.trim();
        console.log('Search query updated:', searchQuery);
        updateSearchVisibility();
        filterStationsByLanguage(selectedLanguage);
        renderStationList();
    });

    clearSearchBtn.addEventListener('click', () => {
        stationSearch.value = '';
        searchQuery = '';
        console.log('Search cleared');
        updateSearchVisibility();
        filterStationsByLanguage(selectedLanguage);
        renderStationList();
    });

    window.addEventListener('online', () => {
        isOffline = false;
        console.log('Network online');
        clearError();
        if (currentStation && !isPlaying && !isManuallyPaused) {
            console.log('Network restored, resuming playback');
            playStation(currentStation);
        } else if (currentStation && !isPlaying && isManuallyPaused) {
            console.log('Network restored after manual pause, showing message');
            showError("Network Restored.\nClick play button to resume.");
        }
    });

    window.addEventListener('offline', () => {
        isOffline = true;
        console.log('Network offline');
        showError('You are offline!\nPlease check your internet connection.');
        if (isPlaying) {
            audio.pause();
            isPlaying = false;
            updatePlayerDisplay();
        }
    });
});