const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");
const riddles = require("./riddles.json");

const app = express();
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  maxHttpBufferSize: 1e6,
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(express.static(path.join(__dirname, "public")));

// ── Configuration ────────────────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASS || "admin123";  // Change this!

// ── In-memory state ──────────────────────────────────────────────────
const players = new Map();        // sessionId → { sessionId, socketId, name, score, solved[], usedHints[], riddleOrder[], lastScoreTime, joinedAt, connected, disconnectTimer }
const socketToSession = new Map();// socketId → sessionId
const adminTokens = new Set();    // valid admin session tokens

// Game state
let gameState = "lobby";          // "lobby" | "playing" | "finished"
let gamePin = generatePin();      // 4-digit PIN for students to join
let timerDuration = 0;
let timerRemaining = 0;
let timerInterval = null;

// ── Generate a random 4-digit PIN ────────────────────────────────────
function generatePin() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// ── Generate a secure admin token ────────────────────────────────────
function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

// ── Admin auth middleware ────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"] || req.query.token;
  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ error: "Unauthorized. Please log in." });
  }
  next();
}

// ── Helper: build leaderboard array ──────────────────────────────────
function getLeaderboard() {
  return Array.from(players.values())
    .map((p) => ({
      name: p.name,
      score: p.score,
      solved: p.solved.length,
      answered: (p.answered || p.solved).length,
      total: riddles.length,
      lastScoreTime: p.lastScoreTime || 0,
      joinedAt: p.joinedAt || 0,
      tabSwitches: p.tabSwitches || 0,
    }))
    .sort((a, b) => {
      // 1. Higher score first
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      // 2. Tie-break: faster time (earlier lastScoreTime) for players who scored
      if (a.score > 0 && b.score > 0) {
        if (a.lastScoreTime !== b.lastScoreTime) {
          return a.lastScoreTime - b.lastScoreTime;
        }
      }
      // 3. Fallback: more solved questions
      if (b.solved !== a.solved) {
        return b.solved - a.solved;
      }
      // 4. Fallback: joined earlier, then alphabetical
      return (a.joinedAt - b.joinedAt) || a.name.localeCompare(b.name);
    });
}

// ── Helper: build lobby player list ──────────────────────────────────
function getLobbyList() {
  return Array.from(players.values()).map((p) => p.name);
}

// ── Helper: shuffle an array (Fisher-Yates) ─────────────────────────
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Helper: pick the next unsolved question for a player ─────────────
function nextRiddle(player) {
  if (!player.answered) player.answered = [];
  // Use the player's personal shuffled order
  for (const id of player.riddleOrder) {
    if (!player.answered.includes(id)) {
      return riddles.find((r) => r.id === id);
    }
  }
  return null;
}

// ── Helper: sanitize question (omit correct answer & jumble options) ──
function getPlayerQuestionOptions(player, r) {
  if (!player.questionOptions) player.questionOptions = {};
  if (!player.questionOptions[r.id]) {
    player.questionOptions[r.id] = shuffle(r.options || []);
  }
  return player.questionOptions[r.id];
}

function safeRiddle(r, player = null) {
  const options = player
    ? getPlayerQuestionOptions(player, r)
    : shuffle(r.options || []);
  return {
    id: r.id,
    question: r.question || r.riddle,
    riddle: r.question || r.riddle,
    category: r.category,
    options,
  };
}

// ── Timer helpers ────────────────────────────────────────────────────
function startTimer(seconds) {
  timerDuration = seconds;
  timerRemaining = seconds;
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    timerRemaining--;
    io.emit("timer_tick", timerRemaining);
    if (timerRemaining <= 0) {
      clearInterval(timerInterval);
      timerInterval = null;
      endGame();
    }
  }, 1000);
}

function endGame() {
  gameState = "finished";
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  io.emit("game_finished", { leaderboard: getLeaderboard() });
  io.emit("game_state", { state: gameState });
  console.log("🏁 Game finished!");
}

// ══════════════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════════════

// ── Admin login page ─────────────────────────────────────────────────
app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// ── Admin login endpoint ─────────────────────────────────────────────
app.post("/api/admin/login", (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    const token = generateToken();
    adminTokens.add(token);
    console.log("🔐 Admin logged in");
    return res.json({ success: true, token, pin: gamePin });
  }
  res.status(401).json({ success: false, error: "Wrong password." });
});

// ── Admin logout ─────────────────────────────────────────────────────
app.post("/api/admin/logout", requireAdmin, (req, res) => {
  const token = req.headers["x-admin-token"] || req.query.token;
  adminTokens.delete(token);
  res.json({ success: true });
});

// ── Admin: get game status ───────────────────────────────────────────
app.get("/api/status", requireAdmin, (_req, res) => {
  res.json({
    state: gameState,
    pin: gamePin,
    playerCount: players.size,
    timerDuration,
    timerRemaining,
    players: getLobbyList(),
  });
});

// ── Admin: regenerate PIN ────────────────────────────────────────────
app.post("/api/pin/regenerate", requireAdmin, (_req, res) => {
  gamePin = generatePin();
  console.log(`🔑 New game PIN: ${gamePin}`);
  res.json({ pin: gamePin });
});

// ── Admin: get leaderboard JSON ──────────────────────────────────────
app.get("/api/leaderboard", requireAdmin, (_req, res) => {
  res.json(getLeaderboard());
});

// ── Admin: start game ────────────────────────────────────────────────
app.post("/api/start", requireAdmin, (req, res) => {
  if (gameState !== "lobby") {
    return res.status(400).json({ error: "Game is not in lobby state." });
  }
  if (players.size === 0) {
    return res.status(400).json({ error: "No players have joined yet." });
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const seconds = parseInt(url.searchParams.get("timer") || "600", 10);

  gameState = "playing";
  console.log(`🚀 Game started! Timer: ${seconds}s, Players: ${players.size}`);

  for (const player of players.values()) {
    const r = nextRiddle(player);
    if (player.socketId) {
      const s = io.sockets.sockets.get(player.socketId);
      if (s) {
        s.emit("game_started", {
          sessionId: player.sessionId,
          name: player.name,
          riddle: r ? safeRiddle(r, player) : null,
          total: riddles.length,
          solved: player.solved.length,
          score: player.score,
          timeRemaining: seconds,
        });
      }
    }
  }

  io.emit("game_state", { state: gameState });
  io.emit("leaderboard", getLeaderboard());
  startTimer(seconds);

  res.json({ status: "Game started!", timer: seconds, players: players.size });
});

// ── Admin: end game early ────────────────────────────────────────────
app.post("/api/end", requireAdmin, (_req, res) => {
  if (gameState !== "playing") {
    return res.status(400).json({ error: "Game is not running." });
  }
  endGame();
  res.json({ status: "Game ended!" });
});

// ── Admin: reset game ────────────────────────────────────────────────
app.post("/api/reset", requireAdmin, (_req, res) => {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  gameState = "lobby";
  timerDuration = 0;
  timerRemaining = 0;
  gamePin = generatePin();
  for (const player of players.values()) {
    if (player.disconnectTimer) clearTimeout(player.disconnectTimer);
  }
  players.clear();
  socketToSession.clear();
  io.emit("game_reset");
  io.emit("leaderboard", []);
  io.emit("game_state", { state: "lobby" });
  console.log(`🔄 Game reset! New PIN: ${gamePin}`);
  res.json({ status: "Game reset!", pin: gamePin });
});

// ══════════════════════════════════════════════════════════════════════
// SOCKET.IO
// ══════════════════════════════════════════════════════════════════════
io.on("connection", (socket) => {
  console.log(`⚡ Connected: ${socket.id}`);
  socket.emit("game_state", { state: gameState });
  socket.emit("leaderboard", getLeaderboard());

  if (gameState === "lobby") {
    socket.emit("lobby_update", {
      playerCount: players.size,
      players: getLobbyList(),
    });
  } else if (gameState === "playing") {
    socket.emit("timer_tick", timerRemaining);
  }

  // ── Player joins with name + PIN ───────────────────────────────────
  socket.on("join", ({ name, pin }) => {
    name = (name || "").trim().substring(0, 30);
    pin = (pin || "").trim();

    if (!name) return socket.emit("error_msg", "Please enter a valid name.");
    if (!pin)  return socket.emit("error_msg", "Please enter the game PIN.");

    // Validate PIN
    if (pin !== gamePin) {
      return socket.emit("error_msg", "Wrong game PIN! Ask your teacher for the correct PIN.");
    }

    // Check duplicate names or reclaim disconnected session
    let existingPlayer = null;
    for (const p of players.values()) {
      if (p.name.toLowerCase() === name.toLowerCase()) {
        existingPlayer = p;
        break;
      }
    }

    if (existingPlayer) {
      // Disconnect previous socket if still lingering
      if (existingPlayer.socketId && existingPlayer.socketId !== socket.id) {
        const oldSock = io.sockets.sockets.get(existingPlayer.socketId);
        if (oldSock) oldSock.disconnect(true);
      }

      // Reclaim disconnected session
      if (existingPlayer.disconnectTimer) {
        clearTimeout(existingPlayer.disconnectTimer);
        existingPlayer.disconnectTimer = null;
      }
      existingPlayer.connected = true;
      existingPlayer.socketId = socket.id;
      socketToSession.set(socket.id, existingPlayer.sessionId);

      console.log(`👤 ${name} reclaimed disconnected session`);

      if (gameState === "lobby") {
        socket.emit("joined_lobby", {
          sessionId: existingPlayer.sessionId,
          name: existingPlayer.name,
          playerCount: players.size,
          players: getLobbyList(),
        });
        io.emit("lobby_update", {
          playerCount: players.size,
          players: getLobbyList(),
        });
        io.emit("leaderboard", getLeaderboard());
      } else if (gameState === "playing") {
        const r = nextRiddle(existingPlayer);
        socket.emit("joined", {
          sessionId: existingPlayer.sessionId,
          name: existingPlayer.name,
          riddle: r ? safeRiddle(r, existingPlayer) : null,
          total: riddles.length,
          solved: existingPlayer.solved.length,
          answered: (existingPlayer.answered || existingPlayer.solved).length,
          score: existingPlayer.score,
          timeRemaining: timerRemaining,
        });
        io.emit("leaderboard", getLeaderboard());
      } else if (gameState === "finished") {
        socket.emit("game_finished", { leaderboard: getLeaderboard() });
        io.emit("leaderboard", getLeaderboard());
      }
      return;
    }

    if (gameState === "finished") {
      return socket.emit("error_msg", "The game has already ended. Ask the host to reset.");
    }

    const sessionId = generateToken();
    const player = {
      sessionId,
      socketId: socket.id,
      name,
      score: 0,
      solved: [],
      answered: [],
      usedHints: [],
      questionOptions: {},
      riddleOrder: shuffle(riddles.map((r) => r.id)),
      lastScoreTime: 0,
      joinedAt: Date.now(),
      connected: true,
      disconnectTimer: null,
      tabSwitches: 0,
    };
    players.set(sessionId, player);
    socketToSession.set(socket.id, sessionId);

    if (gameState === "lobby") {
      socket.emit("joined_lobby", {
        sessionId,
        name,
        playerCount: players.size,
        players: getLobbyList(),
      });
      io.emit("lobby_update", {
        playerCount: players.size,
        players: getLobbyList(),
      });
      io.emit("leaderboard", getLeaderboard());
    } else if (gameState === "playing") {
      const r = nextRiddle(player);
      socket.emit("joined", {
        sessionId,
        name,
        riddle: r ? safeRiddle(r, player) : null,
        total: riddles.length,
        solved: 0,
        answered: 0,
        score: 0,
        timeRemaining: timerRemaining,
      });
      io.emit("leaderboard", getLeaderboard());
    }

    console.log(`👤 ${name} joined (PIN ✓)  (${players.size} online)`);
  });

  // ── Resume session after page reload ──────────────────────────────
  socket.on("resume_session", ({ sessionId, pin }) => {
    if (!sessionId) {
      return socket.emit("session_invalid", { message: "No active session." });
    }

    if (pin && pin !== gamePin) {
      return socket.emit("session_invalid", { message: "Game PIN has changed or game was reset." });
    }

    const player = players.get(sessionId);
    if (!player) {
      return socket.emit("session_invalid", { message: "Session expired or not found. Please join again." });
    }

    // Disconnect old socket if different
    if (player.socketId && player.socketId !== socket.id) {
      const oldSock = io.sockets.sockets.get(player.socketId);
      if (oldSock) oldSock.disconnect(true);
    }

    if (player.disconnectTimer) {
      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = null;
    }

    player.connected = true;
    player.socketId = socket.id;
    socketToSession.set(socket.id, sessionId);

    console.log(`🔄 ${player.name} resumed session (state: ${gameState})`);

    if (gameState === "lobby") {
      socket.emit("joined_lobby", {
        sessionId: player.sessionId,
        name: player.name,
        playerCount: players.size,
        players: getLobbyList(),
      });
      io.emit("lobby_update", {
        playerCount: players.size,
        players: getLobbyList(),
      });
      io.emit("leaderboard", getLeaderboard());
    } else if (gameState === "playing") {
      const r = nextRiddle(player);
      socket.emit("joined", {
        sessionId: player.sessionId,
        name: player.name,
        riddle: r ? safeRiddle(r, player) : null,
        total: riddles.length,
        solved: player.solved.length,
        answered: (player.answered || player.solved).length,
        score: player.score,
        timeRemaining: timerRemaining,
      });
      io.emit("leaderboard", getLeaderboard());
    } else if (gameState === "finished") {
      socket.emit("game_finished", { leaderboard: getLeaderboard() });
      io.emit("leaderboard", getLeaderboard());
    }
  });

  // ── Tab switch detected ────────────────────────────────────────────
  socket.on("tab_switch", () => {
    if (gameState !== "playing") return;
    const sessionId = socketToSession.get(socket.id);
    const player = sessionId ? players.get(sessionId) : null;
    if (!player) return;

    player.tabSwitches = (player.tabSwitches || 0) + 1;
    console.log(`⚠️ Tab switch detected: ${player.name} (${player.tabSwitches}x)`);
    io.emit("leaderboard", getLeaderboard());
  });

  // ── Request hint ───────────────────────────────────────────────────
  socket.on("hint", (riddleId) => {
    if (gameState !== "playing") return;
    const sessionId = socketToSession.get(socket.id);
    const player = sessionId ? players.get(sessionId) : null;
    if (!player) return;
    const r = riddles.find((x) => x.id === riddleId);
    if (!r) return;
    if (!player.usedHints.includes(riddleId)) {
      player.usedHints.push(riddleId);
    }
    socket.emit("hint_response", { id: riddleId, hint: r.hint });
  });

  // ── Submit answer ──────────────────────────────────────────────────
  socket.on("answer", ({ riddleId, answer }) => {
    if (gameState !== "playing") return;
    const sessionId = socketToSession.get(socket.id);
    const player = sessionId ? players.get(sessionId) : null;
    if (!player) return;
    const r = riddles.find((x) => x.id === riddleId);
    if (!r) return;

    if (!player.answered) player.answered = [];
    if (player.answered.includes(riddleId)) return; // Already answered

    player.answered.push(riddleId);

    const normalize = (s) => String(s || "").trim().toLowerCase();
    const cleanPunct = (s) => normalize(s).replace(/[.,!?;:'"()[\]{}]/g, "").replace(/\s+/g, " ");

    const userRaw = normalize(answer);
    const userClean = cleanPunct(answer);

    const acceptedList = Array.isArray(r.answers)
      ? r.answers
      : (Array.isArray(r.answer) ? r.answer : [r.answer]);

    const isCorrect = acceptedList.some((ans) => {
      const aRaw = normalize(ans);
      const aClean = cleanPunct(ans);
      return userRaw === aRaw || userClean === aClean;
    });

    let pointsAwarded = 0;
    if (isCorrect) {
      if (!player.solved.includes(riddleId)) {
        player.solved.push(riddleId);
      }
      pointsAwarded = 10;
      player.score += pointsAwarded;
      player.lastScoreTime = Date.now();
    }

    const next = nextRiddle(player);
    socket.emit("result", {
      correct: isCorrect,
      correctAnswer: r.answer,
      points: pointsAwarded,
      score: player.score,
      solved: player.solved.length,
      answered: player.answered.length,
      total: riddles.length,
      nextRiddle: next ? safeRiddle(next, player) : null,
    });
    io.emit("leaderboard", getLeaderboard());
  });

  // ── Disconnect ─────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    const sessionId = socketToSession.get(socket.id);
    socketToSession.delete(socket.id);
    if (!sessionId) return;

    const player = players.get(sessionId);
    if (!player) return;

    console.log(`👋 ${player.name} disconnected (state: ${gameState})`);
    player.connected = false;
    player.socketId = null;
    io.emit("leaderboard", getLeaderboard());

    if (gameState === "lobby") {
      // In lobby, give 30 seconds to reconnect before cleaning up
      if (player.disconnectTimer) clearTimeout(player.disconnectTimer);
      player.disconnectTimer = setTimeout(() => {
        if (!player.connected && gameState === "lobby") {
          players.delete(sessionId);
          io.emit("lobby_update", {
            playerCount: players.size,
            players: getLobbyList(),
          });
          console.log(`🗑️ Removed inactive lobby player: ${player.name}`);
        }
      }, 30000);
    }
    // During "playing" and "finished", player progress and scores remain saved!
  });
});

// ── Start server ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🎮 Riddle Quest server running!`);
  console.log(`   Local:     http://localhost:${PORT}`);
  console.log(`   Dashboard: http://localhost:${PORT}/admin`);
  console.log(`   Admin Pass: ${ADMIN_PASSWORD}`);
  console.log(`   Game PIN:   ${gamePin}`);
  const nets = require("os").networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) {
        console.log(`   Network:   http://${net.address}:${PORT}`);
      }
    }
  }
  console.log(`\n   Share the Network URL + Game PIN with your students!\n`);
});
