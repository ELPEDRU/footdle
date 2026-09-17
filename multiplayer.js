// ==========================================
// FOOTDLE - MULTIPLAYER (PARTY MODE)
// ==========================================
// Realtime sync via Supabase Broadcast + Presence.
// No database table is required — rooms are ephemeral
// Realtime channels keyed by a short party code.
//
// Trust model: the HOST's browser is authoritative — it
// holds the secret player and evaluates every guess, then
// broadcasts back only the clue colors for that guess. This
// keeps regular players from reading the answer directly,
// but broadcast payloads can technically be inspected via
// devtools by a determined player, same as most client-side
// party games. Good enough for playing with friends.
//
// NOTE: escapeHtml() is defined in script.js (which loads
// first) and is reused here — do not redefine it below.
// ==========================================

const MP_SUPABASE_URL = "https://eimkkncewgxfyonssiyn.supabase.co";
const MP_SUPABASE_KEY = "sb_publishable_8tSkLBH-oqFtQDb2EUwdYA_UafG6PGZ";

const mpClient = supabase.createClient(MP_SUPABASE_URL, MP_SUPABASE_KEY);

const MP_CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

function getClientId() {

    let id = localStorage.getItem("mpClientId");

    if (!id) {
        id = "p-" + Math.random().toString(36).slice(2, 10);
        localStorage.setItem("mpClientId", id);
    }

    return id;

}

function mpNickname() {
    return getNickname() || ("Player " + getClientId().slice(-4));
}

function generatePartyCode() {

    let code = "";

    for (let i = 0; i < 5; i++) {
        code += MP_CODE_CHARS[Math.floor(Math.random() * MP_CODE_CHARS.length)];
    }

    return code;

}


// ==========================================
// STATE
// ==========================================

const mp = {
    active: false,
    isHost: false,
    channel: null,
    code: null,
    password: "",
    difficulty: "easy",
    totalRounds: 5,
    round: 0,
    maxAttempts: 7,
    status: "lobby",
    secretPlayer: null,       // only ever populated on the host
    hintsPerRound: 0,
    myHintsUsed: 0,
    myAttemptsUsed: 0,
    players: {},              // clientId -> {nickname, isHost, attemptsUsed, finished}
    scores: {},                // clientId -> number
    roundEndTimer: null,
    _joinTimeout: null
};

let pendingPartyDifficulty = "easy";
let pendingPartyPrivate = false;
let pendingPartyHints = 0;


// ==========================================
// SCREEN NAVIGATION
// ==========================================

function showMultiplayerMenu() {

    if (!getNickname()) {
        showNicknamePrompt(false);
    }

    document.getElementById("menuScreen").classList.remove("active");
    document.getElementById("multiplayerScreen").classList.add("active");

}

function backToMultiplayerMenu() {

    document.getElementById("createPartyScreen").classList.remove("active");
    document.getElementById("joinPartyScreen").classList.remove("active");
    document.getElementById("partyLobbyScreen").classList.remove("active");
    document.getElementById("multiplayerScreen").classList.add("active");

}

function showCreateParty() {

    document.getElementById("multiplayerScreen").classList.remove("active");
    document.getElementById("createPartyScreen").classList.add("active");
    document.getElementById("createPartyError").textContent = "";

}

function showJoinParty() {

    document.getElementById("multiplayerScreen").classList.remove("active");
    document.getElementById("joinPartyScreen").classList.add("active");
    document.getElementById("joinPartyError").textContent = "";

}

function selectPartyHints(count, btn) {

    pendingPartyHints = count;

    document.querySelectorAll("#mpHintsRow .mp-pill")
        .forEach(el => el.classList.remove("active"));

    btn.classList.add("active");

}

function selectPartyDifficulty(diff, btn) {

    pendingPartyDifficulty = diff;

    document.querySelectorAll("#createPartyScreen .mp-difficulty-row .mp-pill[data-difficulty]")
        .forEach(el => el.classList.remove("active"));

    btn.classList.add("active");

}

function setPartyPrivacy(isPrivate) {

    pendingPartyPrivate = isPrivate;

    document.getElementById("publicPill").classList.toggle("active", !isPrivate);
    document.getElementById("privatePill").classList.toggle("active", isPrivate);
    document.getElementById("partyPassword").style.display = isPrivate ? "block" : "none";

}


// ==========================================
// CHANNEL SETUP
// ==========================================

function mpConnectChannel(onSubscribed) {

    mp.channel = mpClient.channel("party-" + mp.code, {
        config: {
            broadcast: { self: true },
            presence: { key: getClientId() }
        }
    });

    // Shared listeners — everyone reacts the same way,
    // including the host (thanks to broadcast self:true).
    mp.channel.on("broadcast", { event: "round_start" }, ({ payload }) => mpOnRoundStart(payload));
    mp.channel.on("broadcast", { event: "guess_result" }, ({ payload }) => mpOnGuessResult(payload));
    mp.channel.on("broadcast", { event: "player_status" }, ({ payload }) => mpOnPlayerStatus(payload));
    mp.channel.on("broadcast", { event: "round_end" }, ({ payload }) => mpOnRoundEnd(payload));
    mp.channel.on("broadcast", { event: "game_over" }, ({ payload }) => mpOnGameOver(payload));

    if (mp.isHost) {
        mp.channel.on("broadcast", { event: "join_request" }, ({ payload }) => mpHostOnJoinRequest(payload));
        mp.channel.on("broadcast", { event: "guess" }, ({ payload }) => mpHostOnGuess(payload));
        mp.channel.on("broadcast", { event: "hint_request" }, ({ payload }) => mpHostOnHintRequest(payload));
    } else {
        mp.channel.on("broadcast", { event: "join_accepted" }, ({ payload }) => mpOnJoinAccepted(payload));
        mp.channel.on("broadcast", { event: "join_denied" }, ({ payload }) => mpOnJoinDenied(payload));
        mp.channel.on("broadcast", { event: "hint_granted" }, ({ payload }) => mpOnHintGranted(payload));
    }

    mp.channel.on("presence", { event: "sync" }, () => mpOnPresenceSync());
    mp.channel.on("presence", { event: "leave" }, ({ leftPresences }) => mpOnPresenceLeave(leftPresences));

    mp.channel.subscribe((status) => {
        if (status === "SUBSCRIBED" && onSubscribed) {
            onSubscribed();
        }
    });

}

function mpTeardownChannel() {

    if (mp.channel) {
        mpClient.removeChannel(mp.channel);
        mp.channel = null;
    }

}

function resetMpState() {

    mp.active = false;
    mp.isHost = false;
    mp.code = null;
    mp.password = "";
    mp.round = 0;
    mp.secretPlayer = null;
    mp.myAttemptsUsed = 0;
    mp.players = {};
    mp.scores = {};
    mp.status = "lobby";

    clearTimeout(mp.roundEndTimer);
    clearTimeout(mp._joinTimeout);

    const roundEndOverlay = document.getElementById("mpRoundEndOverlay");
    if (roundEndOverlay) roundEndOverlay.classList.remove("show");

    const gameOverOverlay = document.getElementById("mpGameOverOverlay");
    if (gameOverOverlay) gameOverOverlay.classList.remove("show");

}


// ==========================================
// CREATE PARTY (HOST)
// ==========================================

function createParty() {

    if (!getNickname()) {
        showNicknamePrompt(false);
        document.getElementById("createPartyError").textContent = t("mpErrorNickname");
        return;
    }

    const rounds = Math.max(1, Math.min(15, Number(document.getElementById("partyRounds").value) || 5));
    const password = pendingPartyPrivate ? document.getElementById("partyPassword").value.trim() : "";

    if (pendingPartyPrivate && !password) {
        document.getElementById("createPartyError").textContent = t("mpErrorPassword");
        return;
    }

    document.getElementById("createPartyError").textContent = "";

    mp.code = generatePartyCode();
    mp.isHost = true;
    mp.password = password;
    mp.difficulty = pendingPartyDifficulty;
    mp.totalRounds = rounds;
    mp.hintsPerRound = pendingPartyHints;
    mp.round = 0;
    mp.players = {};
    mp.scores = {};
    mp.status = "lobby";

    mpConnectChannel(() => {

        mp.active = true;

        mp.channel.track({
            client_id: getClientId(),
            nickname: mpNickname(),
            isHost: true
        });

        enterLobby();

    });

}


// ==========================================
// JOIN PARTY (GUEST)
// ==========================================

function joinParty() {

    if (!getNickname()) {
        showNicknamePrompt(false);
        document.getElementById("joinPartyError").textContent = t("mpErrorNickname");
        return;
    }

    const code = document.getElementById("joinPartyCode").value.trim().toUpperCase();
    const password = document.getElementById("joinPartyPassword").value.trim();

    if (code.length !== 5) {
        document.getElementById("joinPartyError").textContent = t("mpErrorCode");
        return;
    }

    document.getElementById("joinPartyError").textContent = t("mpConnecting");
    document.getElementById("joinPartyButton").disabled = true;

    mp.code = code;
    mp.isHost = false;
    mp.players = {};
    mp.scores = {};

    mpConnectChannel(() => {

        mp.channel.send({
            type: "broadcast",
            event: "join_request",
            payload: { clientId: getClientId(), nickname: mpNickname(), password }
        });

        mp._joinTimeout = setTimeout(() => {

            document.getElementById("joinPartyError").textContent =
                t("mpNoResponse");

            document.getElementById("joinPartyButton").disabled = false;

            mpTeardownChannel();

        }, 6000);

    });

}

function mpHostOnJoinRequest(payload) {

    if (mp.status !== "lobby") {
        mp.channel.send({
            type: "broadcast",
            event: "join_denied",
            payload: { clientId: payload.clientId, reason: "already_started" }
        });
        return;
    }

    if (mp.password && payload.password !== mp.password) {
        mp.channel.send({
            type: "broadcast",
            event: "join_denied",
            payload: { clientId: payload.clientId, reason: "wrong_password" }
        });
        return;
    }

    if (!(payload.clientId in mp.scores)) mp.scores[payload.clientId] = 0;

    mp.channel.send({
        type: "broadcast",
        event: "join_accepted",
        payload: {
            clientId: payload.clientId,
            difficulty: mp.difficulty,
            totalRounds: mp.totalRounds,
            hasPassword: !!mp.password
        }
    });

}

function mpOnJoinAccepted(payload) {

    if (payload.clientId !== getClientId()) return;

    clearTimeout(mp._joinTimeout);

    mp.active = true;
    mp.difficulty = payload.difficulty;
    mp.totalRounds = payload.totalRounds;

    document.getElementById("joinPartyButton").disabled = false;

    mp.channel.track({
        client_id: getClientId(),
        nickname: mpNickname(),
        isHost: false
    });

    enterLobby();

}

function mpOnJoinDenied(payload) {

    if (payload.clientId !== getClientId()) return;

    clearTimeout(mp._joinTimeout);

    document.getElementById("joinPartyButton").disabled = false;

    const reasons = {
        wrong_password: t("mpWrongPassword"),
        already_started: t("mpAlreadyStarted")
    };

    document.getElementById("joinPartyError").textContent =
        reasons[payload.reason] || t("mpCouldntJoin");

    mpTeardownChannel();

}


// ==========================================
// PRESENCE (LOBBY ROSTER + OPPONENTS PANEL)
// ==========================================

function mpOnPresenceSync() {

    if (!mp.channel) return;

    const state = mp.channel.presenceState();
    const seen = {};

    Object.keys(state).forEach(key => {

        const metas = state[key];
        if (!metas || !metas.length) return;

        const meta = metas[0];
        const existing = mp.players[meta.client_id] || {};

        seen[meta.client_id] = {
            nickname: meta.nickname,
            isHost: meta.isHost,
            attemptsUsed: existing.attemptsUsed || 0,
            finished: existing.finished || false
        };

    });

    mp.players = seen;

    if (!(getClientId() in mp.scores)) mp.scores[getClientId()] = 0;

    renderLobbyPlayers();
    renderOpponentsPanel();

}

function mpOnPresenceLeave(leftPresences) {

    if (!leftPresences || !leftPresences.length) return;

    const leftIds = leftPresences.map(p => p.client_id);

    // Save nicknames BEFORE presence state wipes them.
    const leftNicknames = leftIds.map(id => {
        const p = mp.players[id];
        return (p && p.nickname) || t("mpPlayerDefaultName");
    });

    leftIds.forEach(id => {
        const player = mp.players[id];
        if (player) player.finished = true;
    });

    if (mp.status === "playing" || mp.status === "round_end") {

        const stillConnected = Object.keys(mp.players)
            .filter(id => !leftIds.includes(id));

        if (stillConnected.length <= 1 && stillConnected.includes(getClientId())) {
            mpHandleOpponentLeft(leftNicknames);
            return;
        }

    }

    if (mp.isHost && mp.status === "playing") {

        const everyoneFinished = Object.values(mp.players).every(p => p.finished);

        if (everyoneFinished) {
            mpHostEndRound(null, null);
        }

    }

}

    // Normal flow — if host and everyone still here is finished, end round.
    if (mp.isHost && mp.status === "playing") {

        const everyoneFinished = Object.values(mp.players).every(p => p.finished);

        if (everyoneFinished) {
            mpHostEndRound(null, null);
        }

    }


    if (mp.isHost && mp.status === "playing") {

        const everyoneFinished = Object.values(mp.players).every(p => p.finished);

        if (everyoneFinished) {
            mpHostEndRound(null, null);
        }

    }

function renderLobbyPlayers() {

    const list = document.getElementById("lobbyPlayerList");
    if (!list) return;

    const entries = Object.entries(mp.players);

    list.innerHTML = entries.map(([id, p]) => `
        <div class="lobby-player-row">
            <span class="lp-name">${escapeHtml(p.nickname)}${id === getClientId() ? t("mpYouSuffix") : ""}</span>
            ${p.isHost ? `<span class="lp-host-badge">${t("mpHostBadge")}</span>` : ""}
        </div>
    `).join("");

    document.getElementById("lobbyPartyCode").textContent = mp.code || "-----";

    const roundWord = mp.totalRounds === 1 ? t("mpRoundWord") : t("mpRoundsWord");

    const summary =
        `${t(mp.difficulty)} · ${mp.totalRounds} ${roundWord}` +
        (mp.password ? ` · ${t("mpPrivate")}` : ` · ${t("mpPublic")}`);

    document.getElementById("lobbySettingsSummary").textContent = summary;

    const startBtn = document.getElementById("startPartyButton");
    const waitingText = document.getElementById("lobbyWaitingText");

    if (mp.isHost) {
        startBtn.style.display = "block";
        startBtn.disabled = entries.length < 2;
        waitingText.textContent = entries.length < 2 ? t("mpNeedTwoPlayers") : "";
    } else {
        startBtn.style.display = "none";
        waitingText.textContent = t("mpWaitingForHost");
    }

}

function renderOpponentsPanel() {

    const panel = document.getElementById("opponentsPanel");
    if (!panel) return;

    const entries = Object.entries(mp.players).filter(([id]) => id !== getClientId());

    panel.innerHTML = entries.map(([id, p]) => {
        const cls = p.finished ? "finished" : "";
        const icon = p.finished ? "✅" : "⏳";
        return `<span class="opponent-chip ${cls}">${icon} ${escapeHtml(p.nickname)}</span>`;
    }).join("");

}

function enterLobby() {

    document.getElementById("multiplayerScreen").classList.remove("active");
    document.getElementById("createPartyScreen").classList.remove("active");
    document.getElementById("joinPartyScreen").classList.remove("active");
    document.getElementById("partyLobbyScreen").classList.add("active");

    renderLobbyPlayers();

}

function copyPartyCode() {

    if (!mp.code) return;

    if (navigator.clipboard) {
        navigator.clipboard.writeText(mp.code).catch(() => {});
    }

    const btn = document.getElementById("copyCodeButton");
    if (!btn) return;

    const original = btn.textContent;
    btn.textContent = t("mpCopied");
    setTimeout(() => { btn.textContent = original; }, 1500);

}

function leaveParty() {

    mpTeardownChannel();
    resetMpState();
    backToMenu();

}


// ==========================================
// OPPONENT DISCONNECTED — AUTO WIN
// ==========================================

function mpHandleOpponentLeft(leftNicknames) {

    if (mp.status === "finished") return;

    mp.status = "finished";

    clearTimeout(mp.roundEndTimer);

    document.getElementById("mpRoundEndOverlay").classList.remove("show");

    input.disabled = true;

    const names = (leftNicknames && leftNicknames.length)
        ? leftNicknames
        : [t("mpPlayerDefaultName")];

    const opponentRows = names.map(name => `
        <div class="mp-score-row">
            <span class="ms-name">${escapeHtml(name)}</span>
            <span class="ms-points">❌</span>
        </div>
    `).join("");

    const finalScoreboard = document.getElementById("mpFinalScoreboard");

    if (finalScoreboard) {
        finalScoreboard.innerHTML = `
            <div class="mp-score-row me">
                <span class="ms-name">${escapeHtml(mpNickname())} (you)</span>
                <span class="ms-points">🏆</span>
            </div>
            ${opponentRows}
        `;
    }

    const title = document.getElementById("mpGameOverTitle");
    if (title) title.textContent = "Opponent disconnected — you win! 🏆";

    const overlay = document.getElementById("mpGameOverOverlay");
    if (overlay) overlay.classList.add("show");

    sfxWin();
    launchConfetti();

}

    const title = document.getElementById("mpGameOverTitle");
   if (title) title.textContent = `${names.join(", ")} disconnected — you win! 🏆`;
    const overlay = document.getElementById("mpGameOverOverlay");
    if (overlay) overlay.classList.add("show");

    sfxWin();
    launchConfetti();

 {}

// ==========================================
// START GAME (HOST)
// ==========================================

function startParty() {

    if (!mp.isHost) return;

    const entries = Object.entries(mp.players);
    if (entries.length < 2) return;

    mp.status = "playing";
    mp.round = 0;
    mp.maxAttempts = attemptsByDifficulty[mp.difficulty];

    entries.forEach(([id]) => { mp.scores[id] = mp.scores[id] || 0; });

    mpStartNextRound();

}

function mpStartNextRound() {

    mp.round++;

    // Reuse the single-player difficulty pool logic.
    difficulty = mp.difficulty;
    const pool = getPlayersForDifficulty();
    mp.secretPlayer = pool[Math.floor(Math.random() * pool.length)];

    mp.channel.send({
        type: "broadcast",
        event: "round_start",
        payload: {
            round: mp.round,
            totalRounds: mp.totalRounds,
            difficulty: mp.difficulty,
            maxAttempts: mp.maxAttempts,
            hintsPerRound: mp.hintsPerRound
        }
    });

}

function mpOnRoundStart(payload) {

    mp.round = payload.round;
    mp.totalRounds = payload.totalRounds;
    mp.difficulty = payload.difficulty;
    mp.maxAttempts = payload.maxAttempts;
    mp.myAttemptsUsed = 0;
    mp.hintsPerRound = payload.hintsPerRound || 0;
    mp.myHintsUsed = 0;
    mp.status = "playing";

    Object.values(mp.players).forEach(p => {
        p.attemptsUsed = 0;
        p.finished = false;
    });

    document.getElementById("mpRoundEndOverlay").classList.remove("show");
    document.getElementById("mpGameOverOverlay").classList.remove("show");

    document.getElementById("multiplayerScreen").classList.remove("active");
    document.getElementById("createPartyScreen").classList.remove("active");
    document.getElementById("joinPartyScreen").classList.remove("active");
    document.getElementById("partyLobbyScreen").classList.remove("active");
    document.getElementById("menuScreen").classList.remove("active");
    document.getElementById("difficultyScreen").classList.remove("active");
    document.getElementById("statsScreen").classList.remove("active");
    document.getElementById("gameScreen").classList.add("active");

    document.getElementById("difficultyLabel").textContent = t(mp.difficulty);
    document.getElementById("attemptsLeft").textContent = mp.maxAttempts;
    document.getElementById("guesses").innerHTML = "";
    document.getElementById("message").textContent = "";

    input.value = "";
    input.disabled = false;
    suggestions.innerHTML = "";
    activeSuggestionIndex = -1;

    const hintBtn = document.getElementById("hintButton");
    if (hintBtn) {
        if (mp.hintsPerRound > 0) {
            hintBtn.style.display = "";
            mpUpdateHintButton();
        } else {
            hintBtn.style.display = "none";
        }
    }

    const hintTextEl = document.getElementById("hintText");
    if (hintTextEl) hintTextEl.textContent = "";

    const giveUpBtn = document.querySelector(".action-button.giveup");
    if (giveUpBtn) giveUpBtn.style.display = "none";

    const shareBtn = document.getElementById("shareButton");
    if (shareBtn) shareBtn.style.display = "none";

    document.getElementById("mpRoundInfo").style.display = "block";
    document.getElementById("mpRoundInfo").textContent = t("mpRoundInfo", { round: mp.round, total: mp.totalRounds });

    document.getElementById("opponentsPanel").style.display = "flex";

    renderOpponentsPanel();

    attempts = mp.myAttemptsUsed;
    maxAttempts = mp.maxAttempts;
    updateProgressBar();

}


// ==========================================
// GUESSING
// ==========================================

function mpSubmitGuess() {

    if (mp.status !== "playing") return;
    if (mp.myAttemptsUsed >= mp.maxAttempts) return;

    const playerName = input.value.trim();

    const guessedPlayer = players.find(
        player => player.name.toLowerCase() === playerName.toLowerCase()
    );

    if (!guessedPlayer) {
        showMessage(t("chooseSuggestion"));
        return;
    }

    mp.myAttemptsUsed++;

    suggestions.innerHTML = "";
    input.value = "";
    input.disabled = true; // re-enabled once the host replies

    mp.channel.send({
        type: "broadcast",
        event: "guess",
        payload: {
            clientId: getClientId(),
            nickname: mpNickname(),
            playerName: guessedPlayer.name,
            attemptNumber: mp.myAttemptsUsed
        }
    });

}

function computeClueStatuses(player, secret) {

    const countryStatus = player.country === secret.country ? "correct" : "wrong";
    const clubStatus = player.club === secret.club ? "correct" : "wrong";
    const leagueStatus = player.league === secret.league ? "correct" : "wrong";
    const positionStatus = player.position === secret.position ? "correct" : "wrong";

    let ageClass, ageArrow = "";

    if (player.age === secret.age) {
        ageClass = "correct";
    } else {
        ageClass = Math.abs(player.age - secret.age) <= 2 ? "close" : "wrong";
        ageArrow = player.age < secret.age ? " ⬆️" : " ⬇️";
    }

    const footStatus = player.foot === secret.foot ? "correct" : "wrong";

    return { countryStatus, clubStatus, leagueStatus, positionStatus, ageClass, ageArrow, footStatus };

}

function renderMpGuessRow(player, s) {

    const container = document.getElementById("guesses");

    const row = document.createElement("div");
    row.className = "guess-row";

    row.appendChild(createCell(player.name, "guess-cell"));
    row.appendChild(createCell(player.country, s.countryStatus, flagFor(player.country)));
    row.appendChild(createCell(player.club, s.clubStatus));
    row.appendChild(createCell(player.league, s.leagueStatus));
    row.appendChild(createCell(player.position, s.positionStatus));
    row.appendChild(createCell(player.age + s.ageArrow, s.ageClass));
    row.appendChild(createCell(player.foot, s.footStatus));

    container.appendChild(row);

    playCellCascade([s.countryStatus, s.clubStatus, s.leagueStatus, s.positionStatus, s.ageClass, s.footStatus]);

    return row;

}

function mpHostOnGuess(payload) {

    if (mp.status !== "playing" || !mp.secretPlayer) return;

    const guessedPlayer = players.find(p => p.name === payload.playerName);
    if (!guessedPlayer) return;

    const statuses = computeClueStatuses(guessedPlayer, mp.secretPlayer);
    const correct = guessedPlayer.name === mp.secretPlayer.name;
    const finished = correct || payload.attemptNumber >= mp.maxAttempts;

    if (mp.players[payload.clientId]) {
        mp.players[payload.clientId].attemptsUsed = payload.attemptNumber;
        mp.players[payload.clientId].finished = finished;
    }

    mp.channel.send({
        type: "broadcast",
        event: "guess_result",
        payload: {
            clientId: payload.clientId,
            player: guessedPlayer,
            statuses,
            correct,
            attemptNumber: payload.attemptNumber
        }
    });

    mp.channel.send({
        type: "broadcast",
        event: "player_status",
        payload: { clientId: payload.clientId, attemptsUsed: payload.attemptNumber, finished }
    });

    if (correct) {
        mpHostEndRound(payload.clientId, payload.nickname);
        return;
    }

    const everyoneFinished = Object.values(mp.players).every(p => p.finished);

    if (everyoneFinished) {
        mpHostEndRound(null, null);
    }

}

function mpOnGuessResult(payload) {

    if (payload.clientId !== getClientId()) return;

    renderMpGuessRow(payload.player, payload.statuses);

    attempts = mp.myAttemptsUsed;
    maxAttempts = mp.maxAttempts;
    document.getElementById("attemptsLeft").textContent = Math.max(0, mp.maxAttempts - mp.myAttemptsUsed);
    updateProgressBar();

    if (payload.correct) {

        showMessage(t("mpFoundFirst", { player: payload.player.name }));
        input.disabled = true;
        sfxWin();
        launchConfetti();

        const rows = document.querySelectorAll("#guesses .guess-row");
        if (rows.length) rows[rows.length - 1].classList.add("winning-row");

    } else if (mp.myAttemptsUsed >= mp.maxAttempts) {

        showMessage(t("mpOutOfAttempts"));
        input.disabled = true;
        sfxLose();

    } else {

        showMessage(t("notThisOne", { amount: mp.maxAttempts - mp.myAttemptsUsed }));
        input.disabled = false;
        sfxWrong();
        shakeMessage();

    }

}

function mpOnPlayerStatus(payload) {

    if (mp.players[payload.clientId]) {
        mp.players[payload.clientId].attemptsUsed = payload.attemptsUsed;
        mp.players[payload.clientId].finished = payload.finished;
    }

    renderOpponentsPanel();

}


// ==========================================
// ROUND END / GAME OVER
// ==========================================

function mpHostEndRound(winnerClientId, winnerNickname) {

    if (mp.status !== "playing") return;

    mp.status = "round_end";

    if (winnerClientId) {
        mp.scores[winnerClientId] = (mp.scores[winnerClientId] || 0) + 1;
    }

    mp.channel.send({
        type: "broadcast",
        event: "round_end",
        payload: {
            round: mp.round,
            totalRounds: mp.totalRounds,
            winnerClientId,
            winnerNickname,
            secretPlayerName: mp.secretPlayer.name,
            scores: mp.scores
        }
    });

    mp.roundEndTimer = setTimeout(() => {

        if (mp.round >= mp.totalRounds) {
            mp.status = "finished";
            mp.channel.send({ type: "broadcast", event: "game_over", payload: { scores: mp.scores } });
        } else {
            mp.status = "playing";
            mpStartNextRound();
        }

    }, 4500);

}

function mpOnRoundEnd(payload) {

    mp.status = "round_end";
    mp.scores = payload.scores;

    input.disabled = true;
    suggestions.innerHTML = "";

    if (payload.winnerClientId) {

        if (mp.players[payload.winnerClientId]) mp.players[payload.winnerClientId].finished = true;

        document.getElementById("mpRoundEndTitle").textContent =
            payload.winnerClientId === getClientId()
                ? t("mpWonRound")
                : t("mpPlayerWonRound", { nickname: payload.winnerNickname });

    } else {

        document.getElementById("mpRoundEndTitle").textContent = t("mpNobodyGotIt");

    }

    document.getElementById("mpRoundEndSubtitle").textContent =
        t("mpPlayerWas", { player: payload.secretPlayerName });

    renderMpScoreboard(document.getElementById("mpRoundEndScoreboard"), payload.scores);

    const isLastRound = payload.round >= payload.totalRounds;

    document.getElementById("mpRoundEndNextText").textContent =
        isLastRound ? t("mpFinalResultsComing") : t("mpRoundStartingSoon", { round: payload.round + 1 });

    document.getElementById("mpRoundEndOverlay").classList.add("show");

}

function renderMpScoreboard(container, scores) {

    if (!container) return;

    const rows = Object.entries(scores)
        .map(([id, pts]) => ({
            id,
            pts,
            nickname: (mp.players[id] && mp.players[id].nickname) || t("mpPlayerDefaultName")
        }))
        .sort((a, b) => b.pts - a.pts);

    container.innerHTML = rows.map(r => `
        <div class="mp-score-row ${r.id === getClientId() ? "me" : ""}">
            <span class="ms-name">${escapeHtml(r.nickname)}</span>
            <span class="ms-points">${r.pts} ${r.pts === 1 ? t("mpPointSingular") : t("mpPointPlural")}</span>
        </div>
    `).join("");

}

function mpOnGameOver(payload) {

    mp.status = "finished";
    mp.scores = payload.scores;

    document.getElementById("mpRoundEndOverlay").classList.remove("show");

    renderMpScoreboard(document.getElementById("mpFinalScoreboard"), payload.scores);

    document.getElementById("mpGameOverOverlay").classList.add("show");

}

function closeMpGameOver() {

    document.getElementById("mpGameOverOverlay").classList.remove("show");

    mpTeardownChannel();
    resetMpState();
    backToMenu();

}


// ==========================================
// HINT SYSTEM
// ==========================================

function mpUpdateHintButton() {

    const hintBtn = document.getElementById("hintButton");
    if (!hintBtn) return;

    const remaining = mp.hintsPerRound - mp.myHintsUsed;

    if (remaining <= 0) {
        hintBtn.disabled = true;
        hintBtn.textContent = t("hintUsed");
    } else {
        hintBtn.disabled = input.disabled;
        hintBtn.textContent = `${t("hint")} (${remaining})`;
    }

}
function mpBuildHintHTML(secret, tier) {

    const verbKey = secret.isLegend ? "hintLegend" : "hintNormal";
    const league = secret.hintLeague || secret.league;

    let html = t(verbKey, {
        flag: flagFor(secret.country),
        country: secret.country,
        league: league
    });

    if (tier >= 2) {
        html += `<br>📍 ${secret.position}`;
    }

    if (tier >= 3) {
        html += `<br>🦶 ${secret.foot}-footed`;
    }

    return html;

}

function mpUseHint() {

    if (mp.status !== "playing") return;
    if (mp.hintsPerRound <= 0) return;
    if (mp.myHintsUsed >= mp.hintsPerRound) return;
    if (input.disabled) return;

    mp.myHintsUsed++;
    mpUpdateHintButton();

    // The host already knows the answer — no round-trip needed.
    if (mp.isHost && mp.secretPlayer) {

        const hintTextEl = document.getElementById("hintText");

        if (hintTextEl) {
            hintTextEl.innerHTML = mpBuildHintHTML(mp.secretPlayer, mp.myHintsUsed);
        }

        sfxHint();
        return;
    }

    // Guest: request the hint from the host.
    const hintTextEl = document.getElementById("hintText");
    if (hintTextEl) hintTextEl.textContent = "…";

    mp.channel.send({
        type: "broadcast",
        event: "hint_request",
        payload: { clientId: getClientId() }
    });

}

    const hintTextEl = document.getElementById("hintText");
    if (hintTextEl) hintTextEl.textContent = "…";

    mp.channel.send({
        type: "broadcast",
        event: "hint_request",
        payload: { clientId: getClientId() }
    });

function mpHostOnHintRequest(payload) {

    if (!mp.isHost || mp.status !== "playing" || !mp.secretPlayer) return;

    const secret = mp.secretPlayer;

    mp.channel.send({
        type: "broadcast",
        event: "hint_granted",
        payload: {
            clientId: payload.clientId,
            country: secret.country,
            league: secret.hintLeague || secret.league,
            isLegend: !!secret.isLegend
        }
    });

}

function mpOnHintGranted(payload) {

    if (payload.clientId !== getClientId()) return;

    const hintTextEl = document.getElementById("hintText");
    if (!hintTextEl) return;

    hintTextEl.innerHTML = mpBuildHintHTML(
        {
            country: payload.country,
            hintLeague: payload.league,
            league: payload.league,
            position: payload.position,
            foot: payload.foot,
            isLegend: payload.isLegend
        },
        mp.myHintsUsed
    );

    sfxHint();

}