// ==UserScript==
// @name         geomatchexporter
// @namespace    geomatchexporter
// @version      1.0
// @description  Geoguessr match exporter for analysis
// @match        https://*.geoguessr.com/*
// @grant        unsafeWindow
// ==/UserScript==

let nextBuildId = null
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/* ========================== JSON Parser ========================== */

const findGuessbyRoundNumber = (guesses, roundNumber) => {
  let guess = guesses[roundNumber - 1]
  if (guess?.roundNumber === roundNumber) {
    // user guesses every round
    return guess
  }
  if (guess?.skippedRound === false) {
    // standard game use skippedRound flag instead of roundNumber
    return guess
  }

  // user skips guessing some rounds
  for (let i = 0; i < guesses.length; i++) {
    guess = guesses[i]
    if (guess.roundNumber === roundNumber) { return guess }
  }

  return null
}

const parseMatch = (matchData) => {
  try {
    const games = []
    const { type, time, payload, match } = matchData

    if (type !== 1 && type !== 6 && type !== 11) {
      console.error(`geomatchexporter error: match type ${type} is not supported`, matchData)
      return []
    }

    const basegame = {
      id: match.gameId ?? match.token,
      time: time,
      player: null,
      mode: payload.competitiveGameMode ?? payload.gameMode,
      mapName: match.options?.mapName ?? payload.mapName,
    }

    let players = null
    if (match.player) {
      players = [match.player]
    } else {
      players = match.teams.reduce(
        (acc, team) => acc.concat(team.players),
        []
      )
    }

    for (let i = 0; i < players.length; i++) {
      const player = players[i]
      const game = {
        ...basegame,
        player: player.playerId ?? player.id,
        rounds: [],
      }

      for (let j = 0; j < match.rounds.length; j++) {
        const actual = match.rounds[j]
        const guess = findGuessbyRoundNumber(player.guesses, j + 1)

        if (!guess) {
          console.log('geomatchexporter:', player.playerId ?? player.id, 'skipped round', j + 1)
          continue
        }

        const round = {
          roundNumber: j + 1,
          actual: {
            lat: actual.lat,
            lng: actual.lng,
          },
          guess: {
            lat: guess.lat,
            lng: guess.lng,
          },
          distance: guess.distanceInMeters ?? guess.distance,
          score: guess.roundScoreInPoints ?? guess.score,
        }

        game.rounds.push(round)
      }

      games.push(game)
    }

    return games
  } catch (error) {
    console.error(`geomatchexporter error: ${error.message}`, matchData)
  }
}

const parseActivityEntry = (entry) => {
  let payload = entry.payload
  if (typeof payload == 'string') {
    payload = JSON.parse(entry.payload)
  }

  if (entry.type === 7) {
    // collection of matches
    return payload.reduce(
      (acc, subEntry) => acc.concat(parseActivityEntry(subEntry)),
      []
    )
  }

  return [{
    type: entry.type,
    time: entry.time,
    user: entry.user,
    payload: payload
  }]
}

const getCurrentUser = () => {
  const data = document.querySelector('script#__NEXT_DATA__')
  const { props } = JSON.parse(data.innerHTML)
  const username = props.accountProps.account.user.nick
  const userId = props.accountProps.account.user.userId
  return { [userId]: username }
}

/* ========================== Fetch matches ========================== */

const fetchActivities = (currentPaginationToken = null) => {
  let url = 'https://www.geoguessr.com/api/v4/feed/private?count=26'
  if (currentPaginationToken !== null) {
    url += `&paginationToken=${currentPaginationToken}`
  }

  return fetch(url)
    .then(r => {
      if (!r.ok) {
        throw new Error(`geomatchexporter error: Response status: ${r.status}`)
      }
      return r.json()
    })
    .then(({ entries, paginationToken }) => ({
      entries: entries.reduce(
        (acc, entry) => acc.concat(parseActivityEntry(entry)),
        []
      ),
      paginationToken: paginationToken
    }))
    .catch(e => console.error(e))
}

const fetchMatchfromJson = (gameMode, gameId) => {
  if (!nextBuildId) { return null }
  let url = null

  switch (gameMode) {
    case 'Standard':
      url = `https://www.geoguessr.com/_next/data/3NBPJ70twEqloItLYpIk6/en/results/${gameId}.json`
      break
    case 'Duels':
      url = `https://www.geoguessr.com/_next/data/3NBPJ70twEqloItLYpIk6/en/duels/${gameId}/summary.json`
      break
    default:
      console.error(`geomatchexporter error: gamemode ${gameMode} is not supported (match id: ${gameId})`)
      return null
  }

  return fetch(url)
    .then(r => {
      if (!r.ok) {
        throw new Error(`geomatchexporter error: Response status: ${r.status}`)
      }
      return r.json()
    })
    .then(json => json.pageProps.game ?? json.pageProps.preselectedGame)
    .catch(e => console.error(e))
}

const fetchMatchfromPage = (gameMode, gameId) => {
  let url = null

  switch (gameMode) {
    case 'Standard':
      url = `https://www.geoguessr.com/results/${gameId}`
      break
    case 'Duels':
      url = `https://www.geoguessr.com/duels/${gameId}/summary`
      break
    default:
      console.error(`geomatchexporter error: gamemode ${gameMode} is not supported (match id: ${gameId})`)
      return null
  }

  return fetch(url)
    .then(r => {
      if (!r.ok) {
        throw new Error(`geomatchexporter error: Response status: ${r.status}`)
      }
      return r.text()
    })
    .then(html => {
      const parser = new DOMParser()
      const doc = parser.parseFromString(html, 'text/html')
      const data = doc.querySelector('script#__NEXT_DATA__')
      const matchResult = JSON.parse(data.innerHTML)
      return matchResult.props.pageProps.game ?? matchResult.props.pageProps.preselectedGame
    })
    .catch(e => console.error(e))
}

const fetchMatchfromEntry = ({ payload }) => {
  if (!nextBuildId) {
    return fetchMatchfromPage(payload.gameMode, payload.gameToken ?? payload.gameId)
  }

  return fetchMatchfromJson(payload.gameMode, payload.gameToken ?? payload.gameId)
}

/* ========================== Main ========================== */

const saveAsFile = (content, fileName, contentType) => {
  var a = document.createElement("a")
  var file = new Blob([content], { type: contentType })
  a.href = URL.createObjectURL(file)
  a.download = fileName
  a.click()
}

const downloadMatchData = async () => {
  const btn = injectedEl.querySelector('button')
  btn.disabled = true
  btn.style = btnDisabledStyle
  btn.innerHTML = 'Fetching...'

  try {
    const user = getCurrentUser()
    let entries = null
    let paginationToken = null
    let allEntries = []

    const fetchpages = document.querySelector('#geomatchexporter-page-select').value
    const batchsize = 40

    for (let i = 0; i < fetchpages; i++) {
      console.log(`geomatchexporter: fetching page ${i + 1}`)
        ; ({ entries, paginationToken } = await fetchActivities(paginationToken))
      allEntries = [...allEntries, ...entries]
      await sleep(1000)
    }

    const matchData = []
    const matchCount = allEntries.length
    console.log(`geomatchexporter: downloading ${allEntries.length} matches`)
    for (let i = 0; i < matchCount; i += batchsize) {
      btn.innerHTML = `${i}/${matchCount}`
      const batch = allEntries.slice(i, i + batchsize)
      const promises = batch.map(async (entry) => ({ ...entry, match: await fetchMatchfromEntry(entry) }))
      const matches = await Promise.all(promises)
      matchData.push(...matches)
      await sleep(10000)
    }

    let parsedMatches = matchData.reduce((acc, matchData) => acc.concat(parseMatch(matchData)), [])
    parsedMatches = parsedMatches.filter((m) => Boolean(m) && user[m.player])
    parsedMatches = parsedMatches.map((m) => ({ ...m, player: `${user[m.player]} #${m.player.slice(0, 4)}` }))

    saveAsFile(
      JSON.stringify(parsedMatches),
      'geoguessr_matches.json',
      'application/json'
    )
  } catch (error) {
    console.error(`geomatchexporter error: ${error.message}`)
    btn.innerHTML = 'Failed'
    await sleep(5000)
  }

  btn.disabled = false
  btn.style = btnActiveStyle
  btn.innerHTML = 'Export'
}

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
  width: 210px;
">
  <div style="display: flex; align-items: center; gap: 8px;">
    <select
      id="geomatchexporter-page-select"
      style="
        background: #121225;
        color: white;
        border: 1px solid #3d3d63;
        border-radius: 6px;
        padding: 4px 8px;
        font-size: 12px;
        cursor: pointer;
        flex: 1 1 0%;
      "
    >
      <option value=1>1 Page</option>
      <option value=3>3 Pages</option>
      <option value=5>5 Pages</option>
    </select>

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

  <div style="
    color: #8a8a9e; 
    font-size: 10px; 
    font-weight: 500; 
    letter-spacing: 0.3px;
    line-height: 1.3;
  ">
    Some matches may fail to export due to Cloudflare.
  </div>
</div>
`

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
`

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
`

let injectedEl = null

const observer = new MutationObserver((mutations, obs) => {
  const el = document.querySelector('body')
  if (el && !injectedEl) {
    const m = document.documentElement.outerHTML.match(/<script src="\/_next\/static\/(\w+)\/_ssgManifest\.js"/)
    if (m) {
      nextBuildId = m[1]
    }

    el.insertAdjacentHTML('beforeend', downloadPanel)
    injectedEl = document.querySelector('#geomatchexporter-download-panel')
    injectedEl.querySelector('button').addEventListener("click", downloadMatchData)

    obs.disconnect()
  }
})

function handleUrlChange() {
  const currentUrl = window.location.href
  const targetUrl = 'https://www.geoguessr.com/me/activities'

  if (currentUrl === targetUrl) {
    observer.observe(document.body, { childList: true, subtree: true })
  } else {
    if (injectedEl) {
      injectedEl.querySelector('button').removeEventListener('click', downloadMatchData)
      injectedEl.remove()
      injectedEl = null
    }
    observer.disconnect()
  }
}

; (function () {
  /* ========================== Handle URL changes ========================== */
  // 1. Handle Back/Forward navigation
  window.addEventListener('popstate', handleUrlChange)

  // 2. Handle Hash changes (e.g., example.com/#section1)
  window.addEventListener('hashchange', handleUrlChange)

  // 3. Handle programmatic changes (pushState and replaceState)
  // We "monkey-patch" these because they don't fire events by default.
  const patchHistory = (type) => {
    const original = history[type]
    return function () {
      const result = original.apply(this, arguments)
      const event = new Event(type)
      event.arguments = arguments
      window.dispatchEvent(event)
      return result
    }
  }
  history.pushState = patchHistory('pushState')
  history.replaceState = patchHistory('replaceState')
  window.addEventListener('pushState', handleUrlChange)
  window.addEventListener('replaceState', handleUrlChange)

  handleUrlChange()
})()