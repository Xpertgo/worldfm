import { LANGUAGE_NORMALIZATION } from './languageNormalization.js';
import { STATIC_COUNTRIES } from './staticCountries.js';

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
const CACHE_DURATION = 24 * 60 * 60 * 1000;
const AUDIO_ERROR_RETRY_DELAY = 2000;
const MAX_AUDIO_ERROR_RETRIES = 5;
const INIT_RETRY_DELAY = 2000;
const SILENCE_DETECTION_INTERVAL = 3000;

const audio = new Audio();
const audioContext = new (window.AudioContext || window.webkitAudioContext)();
const sourceNode = audioContext.createMediaElementSource(audio);
const analyser = audioContext.createAnalyser();
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
let isStopping = false;
let audioErrorRetryCount = 0;
let isManuallyPaused = false;
let stationsFailedToLoad = false;
let lastSelectedCountry = null;
let errorDebounceTimeout = null;
let isOffline = !navigator.onLine;
let userInteracted = false;

const keepAliveAudio = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=');
keepAliveAudio.loop = true;
keepAliveAudio.volume = 0;

audio.autoplay = false;
audio.preload = 'auto';
audio.setAttribute('playsinline', '');
audio.setAttribute('crossorigin', 'anonymous');
document.body.appendChild(audio);

document.addEventListener('click', () => {
    userInteracted = true;
    console.log('User interaction detected, enabling autoplay.');
    audioContext.resume().then(() => {
        console.log('Audio context resumed');
        keepAliveAudio.play().catch(err => console.warn('Keep-alive audio failed to start:', err));
    }).catch(err => console.error('Failed to resume audio context:', err));
}, { once: true });

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
    console.warn('Audio suspended, attempting to resume...', { isPlaying, isOffline, isManuallyPaused });
    if (isPlaying && currentStation && !isOffline && !isManuallyPaused) {
        audioContext.resume().then(() => audio.play()).catch(err => {
            console.error('Failed to resume audio on suspend:', err);
            showError("The music paused unexpectedly.\nPlease press play to resume.");
        });
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
});

audio.addEventListener('pause', () => {
    isPlaying = false;
    stopHeartbeat();
    stopSilenceDetection();
    updatePlayerDisplay();
    updateMediaSession();
    console.log('Audio paused', { manual: isManuallyPaused });
});

audio.addEventListener('error', (e) => {
    if (isStopping) return;
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
        if (isPlaying && !audio.paused && audio.currentTime > 0) {
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
    console.log('Initializing app...', { retryCount });
    const requiredElements = ['countrySelect', 'volumeLevel', 'errorContainer', 'loading', 'stationImage', 'stationIcon'];
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
    const stationImage = document.getElementById('stationImage');
    const stationIcon = document.getElementById('stationIcon');
    stationImage.style.display = 'none';
    stationIcon.style.display = 'flex';

    try {
        const countrySelect = document.getElementById('countrySelect');
        console.log('Populating country dropdown...');
        populateCountryDropdown(STATIC_COUNTRIES);
        const userCountryCode = await getUserCountryCode();
        const validCountry = STATIC_COUNTRIES.some(c => c.code === userCountryCode);
        const selectedCountry = validCountry ? userCountryCode : 'IN';
        countrySelect.value = selectedCountry;
        lastSelectedCountry = selectedCountry;
        console.log('Selected country:', selectedCountry);
        updateFlagDisplay(selectedCountry);
        await fetchAndDisplayAllStations(selectedCountry);
        stationsFailedToLoad = false;
        document.getElementById('volumeLevel').textContent = `${Math.round(audio.volume * 100)}%`;
        clearError();
        console.log('App initialized successfully');
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
        const key = `${station.name.toLowerCase()}|${normalizedLanguage || 'unknown'}`;
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
        const cachedData = localStorage.getItem(cacheKey);
        let allStations = null;
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
            if (!allStations || !allStations.length) throw new Error(`No stations found for ${countryCode}`);
            localStorage.setItem(cacheKey, JSON.stringify({ data: allStations, timestamp: Date.now() }));
            console.log('Stations cached successfully');
        }
        countryStations = mergeDuplicateStations(allStations);
        filterStationsByLanguage(selectedLanguage);
        console.log('Rendering station list...', { stationCount: stations.length });
        renderStationList();
    } catch (error) {
        console.error('Failed to fetch/display stations:', error.message);
        stationsFailedToLoad = true;
        showError('No stations loaded.\nPlease try another country or check your connection.');
        stations = [];
        renderStationList();
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
        lastSelectedCountry = countryCode;
        fetchAndDisplayAllStations(countryCode).catch((err) => {
            console.error('Country change failed:', err.message);
            stationsFailedToLoad = true;
            showError(isOffline ? 'You are offline!\nPlease check your internet connection.' : 'Couldn’t load stations.\nTry another country!');
        });
    } else {
        clearError();
        selectedLanguage = '';
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
    languageSelect.disabled = false;
    languageSelect.removeEventListener('change', handleLanguageChange);
    languageSelect.addEventListener('change', handleLanguageChange);
    console.log('Language dropdown populated with', sortedLanguages.length, 'options');
}

function handleLanguageChange(e) {
    selectedLanguage = e.target.value;
    console.log('Language changed to:', selectedLanguage);
    filterStationsByLanguage(selectedLanguage);
    renderStationList();
}

function filterStationsByLanguage(language) {
    stations = language ? countryStations.filter(station => normalizeLanguage(station.language) === language) : [...countryStations];
    console.log('Filtered stations by language:', { language, count: stations.length });
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
    let favorites = getFavorites();
    const stationSelect = document.getElementById('stationSelect');
    const index = stations.findIndex(s => s.url === station.url);
    const isNowFavorite = !isFavorite(station);

    // Update favorites array
    if (isNowFavorite) {
        favorites.push(station);
        console.log(`Added ${station.name} to favorites`);
    } else {
        favorites = favorites.filter(f => f.url !== station.url);
        console.log(`Removed ${station.name} from favorites`);
    }
    saveFavorites(favorites);

    // Update the specific option's favorite status
    if (index >= 0) {
        const option = stationSelect.querySelector(`option[value="${index}"]`);
        if (option) {
            option.classList.toggle('favorited', isNowFavorite);
        }

        // Update or move to/from favorites optgroup
        let favGroup = stationSelect.querySelector('optgroup[label="Favorites"]');
        if (isNowFavorite) {
            if (!favGroup) {
                favGroup = document.createElement('optgroup');
                favGroup.label = 'Favorites';
                stationSelect.insertBefore(favGroup, stationSelect.firstChild.nextSibling);
            }
            const favOption = document.createElement('option');
            favOption.value = index;
            favOption.textContent = `${station.name} ${station.bitrate ? `(${station.bitrate}kbps)` : ''}`;
            favOption.classList.add('favorited');
            if (station.votes > 100) favOption.classList.add('high-votes');
            else if (station.votes < 10) favOption.classList.add('low-votes');
            else favOption.classList.add('medium-votes');
            favGroup.appendChild(favOption);
        } else if (favGroup) {
            const favOption = favGroup.querySelector(`option[value="${index}"]`);
            if (favOption) favOption.remove();
            if (favGroup.childElementCount === 0) favGroup.remove();
        }
    }

    updateFavoriteButton();
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

function renderStationList() {
    const stationSelect = document.getElementById('stationSelect');
    stationSelect.innerHTML = '<option value="">Select Station</option>';
    const favorites = getFavorites();

    // Create favorites optgroup if there are favorites
    let favGroup = null;
    if (favorites.length > 0) {
        favGroup = document.createElement('optgroup');
        favGroup.label = 'Favorites';
        stationSelect.appendChild(favGroup);
    }

    let index = 0;
    const start = performance.now();
    const renderBatch = () => {
        const fragment = document.createDocumentFragment();
        const favFragment = favGroup ? document.createDocumentFragment() : null;
        const end = Math.min(index + BATCH_SIZE, stations.length);

        for (; index < end; index++) {
            const station = stations[index];
            const isFav = isFavorite(station);
            const option = document.createElement('option');
            option.value = index;
            option.textContent = `${station.name} ${station.bitrate ? `(${station.bitrate}kbps)` : ''}`;
            option.classList.toggle('favorited', isFav);
            if (station.votes > 100) option.classList.add('high-votes');
            else if (station.votes < 10) option.classList.add('low-votes');
            else option.classList.add('medium-votes');

            // Place in favorites group or regular list
            if (isFav && favFragment) {
                favFragment.appendChild(option.cloneNode(true));
            }
            fragment.appendChild(option);
        }

        stationSelect.appendChild(fragment);
        if (favFragment) favGroup.appendChild(favFragment);

        if (index < stations.length) {
            requestAnimationFrame(renderBatch);
        } else {
            stationSelect.disabled = false;
            console.log(`Station list rendered: ${stations.length} stations in ${performance.now() - start}ms`);
            showLoading(false);
            populateLanguageDropdown();
            updateFavoriteButton();
        }
    };

    console.log('Starting station list render...');
    requestAnimationFrame(renderBatch);
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

async function playStation(station) {
    if (isOffline) {
        showError('You are offline!\nPlease check your internet connection.');
        return;
    }
    console.log('Attempting to play station:', { name: station.name, url: station.url, favicon: station.favicon });
    clearError();
    showLoading(true);
    hasError = false;
    isManuallyPaused = false;
    isPlaying = false;

    audio.pause();
    audio.src = '';
    audio.load();
    currentStation = station;

    const stationImage = document.getElementById('stationImage');
    const stationIcon = document.getElementById('stationIcon');
    stationImage.classList.add('loading');
    stationIcon.style.display = 'none';

    if (station.favicon && station.favicon.match(/^https?:\/\//)) {
        console.log('Attempting to load favicon:', station.favicon);
        stationImage.src = station.favicon;
        stationImage.style.display = 'block';
        stationImage.onerror = () => {
            console.warn('Station favicon failed to load, falling back to default:', station.favicon);
            stationImage.style.display = 'none';
            stationIcon.style.display = 'flex';
            stationImage.classList.remove('loading');
        };
        stationImage.onload = () => {
            console.log('Station favicon loaded successfully:', station.favicon);
            stationImage.style.display = 'block';
            stationIcon.style.display = 'none';
            stationImage.classList.remove('loading');
        };
    } else {
        console.log('No valid favicon available, using default icon:', station.favicon);
        stationImage.style.display = 'none';
        stationIcon.style.display = 'flex';
        stationImage.classList.remove('loading');
    }

    try {
        let url = station.url_resolved || station.url;
        console.log('Resolved URL:', url);
        if (url.endsWith('.m3u') || url.endsWith('.pls')) {
            console.log('Fetching playlist file:', url);
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Failed to fetch playlist: ${response.statusText}`);
            const text = await response.text();
            const lines = text.split('\n');
            let foundStreamUrl = false;
            for (const line of lines) {
                if (line.trim().startsWith('http')) {
                    url = line.trim();
                    foundStreamUrl = true;
                    console.log('Found stream URL in playlist:', url);
                    break;
                }
            }
            if (!foundStreamUrl) throw new Error('No valid stream URL found in playlist');
        }

        if (!SKIP_STREAM_TEST) {
            const isStreamValid = await testStream(url);
            if (!isStreamValid) {
                throw new Error('Stream test failed');
            }
        }

        audio.src = url;
        audio.volume = document.getElementById('volume') ? document.getElementById('volume').value : 0.5;
        audio.muted = false;
        console.log('Starting playback...', { url, volume: audio.volume });
        await audioContext.resume();
        await audio.play();
        isPlaying = true;
        hasError = false;
        const stationIndex = stations.indexOf(station);
        if (stationIndex !== -1) document.getElementById('stationSelect').value = stationIndex;
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
        showError(`We couldn’t play ${station.name}.\nPlease try another station.`);
    } finally {
        showLoading(false);
    }
}

function showLoading(show) {
    const loading = document.getElementById('loading');
    const progressBar = document.getElementById('progressBar');
    
    if (!loading || !progressBar) {
        console.error('Loading elements not found in DOM', {
            loading: !!loading,
            progressBar: !!progressBar
        });
        return;
    }

    isLoading = show;
    loading.style.display = show ? 'block' : 'none';
    loading.setAttribute('aria-busy', show ? 'true' : 'false');
    
    let animationFrame = null;
    if (window.currentLoadingAnimation) {
        cancelAnimationFrame(window.currentLoadingAnimation);
        window.currentLoadingAnimation = null;
    }

    const updateProgress = (progress) => {
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
        show: show,
        progress: progressBar.style.width,
        isLoading: isLoading
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
        console.warn('Error displayed:', message);
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

function updatePlayerDisplay() {
    const playPauseBtn = document.getElementById('playPauseBtn');
    const stopBtn = document.getElementById('stopBtn');
    const previousBtn = document.getElementById('previousBtn');
    const nextBtn = document.getElementById('nextBtn');
    const nowPlaying = document.getElementById('nowPlaying');
    const stationImage = document.getElementById('stationImage');
    const stationIcon = document.getElementById('stationIcon');
    playPauseBtn.innerHTML = isPlaying ? '<i class="fas fa-pause"></i>' : '<i class="fas fa-play"></i>';
    playPauseBtn.disabled = !currentStation || isOffline;
    stopBtn.disabled = !currentStation || isOffline;
    const currentIndex = currentStation ? stations.indexOf(currentStation) : -1;
    previousBtn.disabled = !currentStation || stations.length <= 1 || currentIndex === 0 || isOffline;
    nextBtn.disabled = !currentStation || stations.length <= 1 || currentIndex === stations.length - 1 || currentIndex === -1 || isOffline;
    if (currentStation) {
        nowPlaying.querySelector('span').textContent = `Now Playing: ${currentStation.name}${currentStation.language ? ` (${normalizeLanguage(currentStation.language)})` : ''}`;
        const isOverflowing = nowPlaying.querySelector('span').scrollWidth > nowPlaying.clientWidth;
        nowPlaying.classList.toggle('overflowing', isOverflowing);
        nowPlaying.classList.toggle('playing', isPlaying);
    } else {
        nowPlaying.querySelector('span').textContent = 'Select a station to play';
        nowPlaying.classList.remove('playing', 'overflowing');
        stationImage.style.display = 'none';
        stationIcon.style.display = 'flex';
    }
    updateFavoriteButton();
    console.log('Player display updated', { isPlaying, currentStation: currentStation?.name });
}

function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
        if (isPlaying && currentStation && !isOffline && !isManuallyPaused) {
            if (audio.paused || audio.ended) {
                console.warn('Heartbeat detected audio stopped unexpectedly');
                audioContext.resume().then(() => audio.play()).catch(err => {
                    console.error('Heartbeat resume failed:', err.name, err.message);
                    stopHeartbeat();
                    isPlaying = false;
                    showError("The music stopped unexpectedly.\nPlease tap play to resume!");
                    updatePlayerDisplay();
                });
                keepAliveAudio.play().catch(err => console.warn('Keep-alive failed in heartbeat:', err));
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
    console.log('Stopping playback...');
    isStopping = true;
    audio.pause();
    audio.src = '';
    audio.load();
    isPlaying = false;
    isManuallyPaused = false;

    const stationSelect = document.getElementById('stationSelect');
    stationSelect.value = '';

    currentStation = null;
    stopHeartbeat();
    stopSilenceDetection();
    updatePlayerDisplay();
    clearError();
    releaseWakeLock();
    keepAliveAudio.pause();
    document.getElementById('stationImage').style.display = 'none';
    document.getElementById('stationIcon').style.display = 'flex';
    localStorage.removeItem('lastStation');
    setTimeout(() => { isStopping = false; }, 100);
    showError('The playback has been interrupted.');
}

function previousStation() {
    if (isOffline) {
        console.warn('Offline, skipping previous station');
        return;
    }
    const stationSelect = document.getElementById('stationSelect');
    const currentIndex = parseInt(stationSelect.value, 10);
    if (currentIndex > 0) {
        console.log('Switching to previous station', { currentIndex });
        stationSelect.value = currentIndex - 1;
        playStation(stations[currentIndex - 1]);
    } else {
        console.log('No previous station available');
    }
}

function nextStation() {
    if (isOffline) {
        console.warn('Offline, skipping next station');
        return;
    }
    const stationSelect = document.getElementById('stationSelect');
    const currentIndex = parseInt(stationSelect.value, 10);
    if (isNaN(currentIndex) || currentIndex < 0) {
        console.log('No current station, starting from first');
        stationSelect.value = 0;
        playStation(stations[0]);
    } else if (currentIndex < stations.length - 1) {
        console.log('Switching to next station', { currentIndex });
        stationSelect.value = currentIndex + 1;
        playStation(stations[currentIndex + 1]);
    } else {
        console.log('Reached end, looping to first station');
        stationSelect.value = 0;
        playStation(stations[0]);
    }
}

document.getElementById('stationSelect').addEventListener('change', (e) => {
    const index = parseInt(e.target.value, 10);
    if (!isNaN(index) && index >= 0 && index < stations.length) {
        console.log('Station selected from dropdown:', stations[index].name);
        playStation(stations[index]);
    }
});

document.getElementById('playPauseBtn').addEventListener('click', async () => {
    if (!currentStation) {
        console.warn('No station selected for play/pause');
        showError('No station picked yet!\nPlease choose one to start the music.');
        return;
    }
    if (isOffline) {
        console.warn('Offline, cannot play/pause');
        showError('You are offline!\nPlease check your internet connection.');
        return;
    }
    try {
        if (isPlaying) {
            console.log('Pausing audio...');
            audio.pause();
            isPlaying = false;
            isManuallyPaused = true;
            stopHeartbeat();
            stopSilenceDetection();
            releaseWakeLock();
            keepAliveAudio.pause();
            clearError();
            showError('Paused! Click play to resume');
            updatePlayerDisplay();
        } else {
            console.log('Resuming audio...');
            await playStation(currentStation);
        }
    } catch (error) {
        console.error('Play/pause error:', error.message);
        hasError = true;
        isPlaying = false;
        showError('Something went wrong with the music.\nPlease try again or switch stations!');
    }
});

document.getElementById('stopBtn').addEventListener('click', () => {
    console.log('Stop button clicked');
    stopPlayback();
});

document.getElementById('previousBtn').addEventListener('click', () => {
    console.log('Previous button clicked');
    previousStation();
});

document.getElementById('nextBtn').addEventListener('click', () => {
    console.log('Next button clicked');
    nextStation();
});

document.getElementById('favoriteBtn').addEventListener('click', () => {
    if (currentStation) {
        toggleFavorite(currentStation);
    }
});

document.getElementById('muteBtn').addEventListener('click', () => {
    const muteBtn = document.getElementById('muteBtn');
    const volume = document.getElementById('volume');
    if (audio.muted) {
        audio.muted = false;
        muteBtn.innerHTML = '<i class="fas fa-volume-up"></i>';
        volume.value = audio.volume;
        console.log('Unmuted audio', { volume: audio.volume });
    } else {
        audio.muted = true;
        muteBtn.innerHTML = '<i class="fas fa-volume-mute"></i>';
        volume.value = 0;
        console.log('Muted audio');
    }
    document.getElementById('volumeLevel').textContent = `${Math.round(audio.volume * 100)}%`;
});

document.getElementById('volume').addEventListener('input', (e) => {
    const volume = e.target.value;
    audio.volume = volume;
    audio.muted = volume === '0';
    document.getElementById('muteBtn').innerHTML = audio.muted ? '<i class="fas fa-volume-mute"></i>' : '<i class="fas fa-volume-up"></i>';
    document.getElementById('volumeLevel').textContent = `${Math.round(volume * 100)}%`;
    console.log('Volume adjusted', { volume });
});

window.addEventListener('online', async () => {
    isOffline = false;
    console.log('Network restored');
    clearError();
    if (currentStation && !isManuallyPaused) {
        console.log('Attempting to resume playback after reconnect...');
        await playStation(currentStation).catch((err) => {
            console.error('Resume failed after reconnect:', err.message);
            showError('You’re back online, but the station isn’t playing.\nTry again or pick a new one!');
        });
    } else {
        showError('You’re back online!\nPlease choose a station to start the music.');
    }
    updatePlayerDisplay();
});

window.addEventListener('offline', () => {
    isOffline = true;
    console.warn('Network lost');
    if (!isManuallyPaused) {
        isPlaying = false;
        if (audio.played.length > 0) audio.pause();
        stopHeartbeat();
        stopSilenceDetection();
        releaseWakeLock();
        keepAliveAudio.pause();
        showError('You are offline!\nPlease check your internet connection.');
        updatePlayerDisplay();
    }
});

setInterval(() => {
    const newOnlineStatus = navigator.onLine;
    if (newOnlineStatus && isOffline) {
        console.log('Online status changed to online');
        window.dispatchEvent(new Event('online'));
    } else if (!newOnlineStatus && !isOffline) {
        console.log('Online status changed to offline');
        window.dispatchEvent(new Event('offline'));
    }
    isOffline = !newOnlineStatus;
}, 1000);

document.addEventListener('DOMContentLoaded', () => {
    isOffline = !navigator.onLine;
    console.log('DOM loaded, initial offline status:', isOffline);
    if (isOffline) {
        showError('You are offline!\nPlease check your internet connection.');
        window.addEventListener('online', () => initializeApp(), { once: true });
    } else {
        initializeApp();
    }
});

window.onerror = (msg, url, line, col, error) => {
    console.error(`Uncaught error: ${msg}`, { url, line, col, details: error });
    showError(isOffline ? 'You are offline!\nPlease check your internet connection.' : 'The app hit a snag.\nPlease refresh the page.');
};

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
        .then(reg => console.log('Service Worker registered:', reg.scope))
        .catch(err => console.error('Service Worker registration failed:', err.message));
    navigator.serviceWorker.addEventListener('message', (event) => {
        const { action } = event.data;
        console.log('Service Worker message received:', action);
        switch (action) {
            case 'play':
                if (currentStation && !isPlaying && !isOffline) playStation(currentStation);
                break;
            case 'pause':
                if (isPlaying) {
                    audio.pause();
                    isPlaying = false;
                    isManuallyPaused = true;
                    stopHeartbeat();
                    stopSilenceDetection();
                    releaseWakeLock();
                    keepAliveAudio.pause();
                    updatePlayerDisplay();
                }
                break;
            case 'stop':
                stopPlayback();
                break;
            case 'previous':
                previousStation();
                break;
            case 'next':
                nextStation();
                break;
        }
    });
}

function searchStations(query) {
    const searchInput = document.getElementById('stationSearch');
    const stationSelect = document.getElementById('stationSelect');
    const clearBtn = document.getElementById('clearSearchBtn');
    
    if (!query) {
        filterStationsByLanguage(selectedLanguage);
        renderStationList();
        clearBtn.style.display = 'none';
        return;
    }

    const lowercaseQuery = query.toLowerCase();
    stations = countryStations.filter(station => {
        const matchesLanguage = !selectedLanguage || normalizeLanguage(station.language) === selectedLanguage;
        return matchesLanguage && station.name.toLowerCase().includes(lowercaseQuery);
    });
    
    renderStationList();
    clearBtn.style.display = 'inline-flex';
    console.log('Station search performed', { 
        query: lowercaseQuery, 
        language: selectedLanguage,
        results: stations.length 
    });
}

function clearSearch() {
    const searchInput = document.getElementById('stationSearch');
    const clearBtn = document.getElementById('clearSearchBtn');
    
    const isKeyboardVisible = document.activeElement === searchInput;
    
    searchInput.value = '';
    filterStationsByLanguage(selectedLanguage);
    renderStationList();
    clearBtn.style.display = 'none';
    
    if (isKeyboardVisible) {
        searchInput.focus();
    }
    
    console.log('Search cleared', { 
        keyboardWasVisible: isKeyboardVisible, 
        selectedLanguage 
    });
}

document.addEventListener('DOMContentLoaded', () => {
    const searchInput = document.getElementById('stationSearch');
    const clearBtn = document.getElementById('clearSearchBtn');
    
    let searchTimeout;
    searchInput.addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
            searchStations(e.target.value.trim());
        }, 300);
    });

    clearBtn.addEventListener('click', clearSearch);

    searchInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            clearTimeout(searchTimeout);
            searchStations(e.target.value.trim());
        }
    });

    searchInput.addEventListener('focus', () => {
        if (searchInput.value) {
            clearBtn.style.display = 'inline-flex';
        }
    });

    searchInput.addEventListener('blur', () => {
        if (!searchInput.value) {
            clearBtn.style.display = 'none';
        }
    });
});