// ==UserScript==
// @name         geomatchexporter
// @namespace    geomatchexporter
// @version      1.0
// @description  Geoguessr match exporter for analysis
// @downloadURL  https://raw.githubusercontent.com/poon919/geoguessr-game-analyzer-page/master/geomatchexporter.user.js
// @updateURL    https://raw.githubusercontent.com/poon919/geoguessr-game-analyzer-page/master/geomatchexporter.user.js
// @match        https://*.geoguessr.com/*
// @grant        unsafeWindow
// ==/UserScript==

let nextBuildId = null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchJSONWithRetry = async (url, options = {}, retries = 3, delay = 1000) => {
  try {
    const response = await fetch(url, options);
    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    if (retries > 0) {
      console.warn(`geomatchexporter error: Fetch failed. Retrying in ${delay}ms... (${retries} retries left). Error: ${error.message}`);

      // Wait for the specified delay
      await new Promise(resolve => setTimeout(resolve, delay));

      // Recursively call fetchJSONWithRetry, decrementing retries
      // and doubling the delay (exponential backoff)
      return fetchJSONWithRetry(url, options, retries - 1, delay * 2);
    }
    throw new Error(`Failed after maximum retries. Original error: ${error.message}`);
  }
}

const getCurrentUser = () => {
  const data = document.querySelector("script#__NEXT_DATA__");
  const { props } = JSON.parse(data.innerHTML);
  const username = props.accountProps.account.user.nick;
  // const userId = props.accountProps.account.user.userId;
  return username;
};

/* ========================== Fetch matches ========================== */

const mapNameMapping = {};

const getMapName = async (mapSlug) => {
  if (!mapSlug) {
    return "Unknown Map";
  }

  const url = `https://www.geoguessr.com/api/maps/${mapSlug}`;

  if (Object.hasOwn(mapNameMapping, mapSlug)) {
    return mapNameMapping[mapSlug];
  }

  try {
    const mapData = await fetchJSONWithRetry(url);
    if (mapData.name) {
      mapNameMapping[mapSlug] = mapData.name;
      return mapData.name;
    }
  } catch (error) {
    console.error('geomatchexporter error:', err);
  }

  return mapSlug;
}

const haversineDistance = (lat1, lon1, lat2, lon2) => {
  const EARTH_RADIUS = 6371000; // Mean radius of Earth in meters

  // Convert degrees to radians
  const toRadians = (degree) => (degree * Math.PI) / 180;

  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);

  const rLat1 = toRadians(lat1);
  const rLat2 = toRadians(lat2);

  // Haversine formula
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(rLat1) * Math.cos(rLat2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS * c;
}

const parseGuessHistory = async (games) => {
  const history = [];

  for (const game of games) {
    let movementMode = "Unknown";
    switch (game.movementRestrictions) {
      case 0:
        movementMode = "Moving";
        break;
      case 1:
        movementMode = "No Move";
        break;
      case 7:
        movementMode = "NMPZ";
        break;
    }

    const mapName = await getMapName(game.mapSlug);

    history.push({
      // Map game identifier and timestamp
      id: game.gameId || "",
      time: game.finishedAt || "",

      // Placeholders since these aren't in the original array structure
      player: "Unknown Player",
      mode: `${game.gameType || "Unknown Mode"} - ${movementMode}`,
      mapName: mapName,

      // Transform the nested rounds array
      rounds: (game.rounds || []).map((round, index) => {
        return {
          roundNumber: index + 1,
          actual: {
            lat: round.roundLat,
            lng: round.roundLng,
            country: round.roundCountryCode
          },
          guess: {
            lat: round.guessLat,
            lng: round.guessLng,
            country: round.guessCountryCode
          },
          // Distance isn't provided in the source
          distance: haversineDistance(round.roundLat, round.roundLng, round.guessLat, round.guessLng),
          score: round.roundScore || null
        };
      })
    });
  }

  return history;
}

const fetchGuessHistory = () => {
  const url = "https://www.geoguessr.com/api/v4/guess-history";
  return fetchJSONWithRetry(url)
    .then((json) => parseGuessHistory(json))
    .then((history) => history)
    .catch((err) => console.error('geomatchexporter error:', err))
}

/* ========================== Main ========================== */

const saveAsFile = (content, fileName, contentType) => {
  var a = document.createElement("a");
  var file = new Blob([content], { type: contentType });
  a.href = URL.createObjectURL(file);
  a.download = fileName;
  a.click();
};

const downloadMatchData = async () => {
  const btn = injectedEl.querySelector("button");
  btn.disabled = true;
  btn.style = btnDisabledStyle;
  btn.innerHTML = "Fetching...";

  try {
    const user = getCurrentUser();
    let history = await fetchGuessHistory();
    history = history.map((game) => ({ ...game, player: user }))

    saveAsFile(
      JSON.stringify(history),
      "geoguessr_matches.json",
      "application/json",
    );
  } catch (error) {
    console.error(`geomatchexporter error: ${error.message}`);
    btn.innerHTML = "Failed";
    await sleep(5000);
  }

  btn.disabled = false;
  btn.style = btnActiveStyle;
  btn.innerHTML = "Export";
};

/* ========================== UI ========================== */

const downloadPanel = `
<div
  id="geomatchexporter-download-panel"
  style="
  position: fixed;
  top: 80px;
  left: 20px;
  z-index: 99;
  background: #252542;
  padding: 10px;
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-family: sans-serif;
  border: 1px solid #3d3d63;
  width: 150px;
">
  <button style="
    background: #6cb928;
    color: white;
    border: none;
    border-radius: 6px;
    padding: 4px 12px;
    font-size: 12px;
    font-weight: bold;
    text-transform: uppercase;
    cursor: pointer;
    box-shadow: 0 2px 0 #4d861d;
  ">
    Export
  </button>
</div>
`;

const btnActiveStyle = `
  background: #6cb928;
  color: white;
  border: none;
  border-radius: 6px;
  padding: 4px 12px;
  font-size: 12px;
  font-weight: bold;
  text-transform: uppercase;
  cursor: pointer;
  box-shadow: 0 2px 0 #4d861d;
`;

const btnDisabledStyle = `
  background: #4a4a5e;
  color: #8a8a9e;
  border: none;
  border-radius: 6px;
  padding: 4px 12px;
  font-size: 12px;
  font-weight: bold;
  text-transform: uppercase;
  cursor: not-allowed;
  box-shadow: none;
  opacity: 0.7;
`;

let injectedEl = null;

const observer = new MutationObserver((mutations, obs) => {
  const el = document.querySelector("body");
  if (el && !injectedEl) {
    const m = document.documentElement.outerHTML.match(
      /<script src="\/_next\/static\/(\w+)\/_ssgManifest\.js"/,
    );
    if (m) {
      nextBuildId = m[1];
    }

    el.insertAdjacentHTML("beforeend", downloadPanel);
    injectedEl = document.querySelector("#geomatchexporter-download-panel");
    injectedEl
      .querySelector("button")
      .addEventListener("click", downloadMatchData);

    obs.disconnect();
  }
});

function handleUrlChange() {
  const currentUrl = window.location.href;
  const targetUrl = "https://www.geoguessr.com/me/activities";

  if (currentUrl === targetUrl) {
    observer.observe(document.body, { childList: true, subtree: true });
  } else {
    if (injectedEl) {
      injectedEl
        .querySelector("button")
        .removeEventListener("click", downloadMatchData);
      injectedEl.remove();
      injectedEl = null;
    }
    observer.disconnect();
  }
}

(function () {
  /* ========================== Handle URL changes ========================== */
  // 1. Handle Back/Forward navigation
  window.addEventListener("popstate", handleUrlChange);

  // 2. Handle Hash changes (e.g., example.com/#section1)
  window.addEventListener("hashchange", handleUrlChange);

  // 3. Handle programmatic changes (pushState and replaceState)
  // We "monkey-patch" these because they don't fire events by default.
  const patchHistory = (type) => {
    const original = history[type];
    return function () {
      const result = original.apply(this, arguments);
      const event = new Event(type);
      event.arguments = arguments;
      window.dispatchEvent(event);
      return result;
    };
  };
  history.pushState = patchHistory("pushState");
  history.replaceState = patchHistory("replaceState");
  window.addEventListener("pushState", handleUrlChange);
  window.addEventListener("replaceState", handleUrlChange);

  handleUrlChange();
})();
