const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(express.json());
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "data.json");

const START_BALANCE = Math.max(
  10,
  Number(process.env.START_BALANCE || 100)
);

const POSITION_SIZE = Math.max(
  1,
  Number(process.env.POSITION_SIZE || 10)
);

const MIN_LIQUIDITY = Math.max(
  100,
  Number(process.env.MIN_LIQUIDITY || 10000)
);

const MIN_VOLUME = Math.max(
  100,
  Number(process.env.MIN_VOLUME || 25000)
);

const TAKE_PROFIT = Math.max(
  1,
  Number(process.env.TAKE_PROFIT || 20)
);

const STOP_LOSS = Math.max(
  1,
  Number(process.env.STOP_LOSS || 10)
);

const MAX_OPEN_POSITIONS = Math.max(
  1,
  Number(process.env.MAX_OPEN_POSITIONS || 3)
);

const SCAN_MS = Math.max(
  30000,
  Number(process.env.SCAN_MS || 60000)
);

let state = loadState();
let scanning = false;
let lastScanAt = null;

let lastStatus =
  "Server berjalan; menunggu pemindaian pertama.";

let latestTokens = [];

function loadState() {
  try {
    const s = JSON.parse(
      fs.readFileSync(DATA_FILE, "utf8")
    );

    return {
      cash: Number(s.cash ?? START_BALANCE),
      realized: Number(s.realized || 0),
      positions: Array.isArray(s.positions)
        ? s.positions
        : [],
      history: Array.isArray(s.history)
        ? s.history
        : []
    };
  } catch {
    return {
      cash: START_BALANCE,
      realized: 0,
      positions: [],
      history: []
    };
  }
}

function saveState() {
  try {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify(state, null, 2)
    );
  } catch (error) {
    console.error(
      "Gagal menyimpan data:",
      error.message
    );
  }
}

const n = value => Number(value || 0);

const label = pair =>
  pair?.baseToken?.symbol ||
  pair?.baseToken?.name ||
  "TOKEN";

const now = () => new Date().toISOString();

function addHistory(
  token,
  action,
  price,
  amount,
  result = "—"
) {
  state.history.unshift({
    time: now(),
    token,
    action,
    price: n(price),
    amount: n(amount),
    result
  });

  state.history = state.history.slice(0, 300);
}

function markToMarket() {
  const byAddress = new Map(
    latestTokens.map(pair => [
      pair.pairAddress,
      pair
    ])
  );

  for (const position of state.positions) {
    const fresh = byAddress.get(
      position.pairAddress
    );

    if (fresh && n(fresh.priceUsd) > 0) {
      position.price = n(fresh.priceUsd);

      position.peak = Math.max(
        n(position.peak),
        position.price
      );

      position.tokenName = label(fresh);
    }
  }
}

function closePosition(position, reason) {
  const price = n(position.price);

  if (!(price > 0)) {
    return false;
  }

  const proceeds = position.qty * price;

  const pnl = proceeds - position.cost;

  state.cash += proceeds;
  state.realized += pnl;

  addHistory(
    position.tokenName,
    reason,
    price,
    proceeds,
    `${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} USD`
  );

  state.positions = state.positions.filter(
    item => item.id !== position.id
  );

  return true;
}

function evaluateExits() {
  for (const position of [...state.positions]) {
    if (!(position.price > 0 && position.entry > 0)) {
      continue;
    }

    const change =
      (position.price / position.entry - 1) * 100;

    if (change >= TAKE_PROFIT) {
      closePosition(
        position,
        `TAKE PROFIT ${TAKE_PROFIT}% (paper)`
      );
    } else if (change <= -STOP_LOSS) {
      closePosition(
        position,
        `STOP LOSS -${STOP_LOSS}% (paper)`
      );
    }
  }
}

function score(pair) {
  return (
    n(pair.priceChange?.h1) * 0.55 +
    Math.log10(
      Math.max(1, n(pair.volume?.h24))
    ) * 2 +
    Math.log10(
      Math.max(1, n(pair.liquidity?.usd))
    )
  );
}

function eligible(pair) {
  const change = n(pair.priceChange?.h1);

  return (
    pair.chainId === "solana" &&
    Boolean(pair.pairAddress) &&
    n(pair.priceUsd) > 0 &&
    n(pair.liquidity?.usd) >= MIN_LIQUIDITY &&
    n(pair.volume?.h24) >= MIN_VOLUME &&
    change <= 80 &&
    change >= -15
  );
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "SolanaMemecoinBotV8Paper/1.0"
    },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} dari API`
    );
  }

  return response.json();
}

async function scanMarket() {
  if (scanning) {
    return;
  }

  scanning = true;

  try {
    const profiles = await getJson(
      "https://api.dexscreener.com/token-profiles/latest/v1"
    );

    const solanaTokens = (
      Array.isArray(profiles) ? profiles : []
    )
      .filter(
        token =>
          token.chainId === "solana" &&
          token.tokenAddress
      )
      .slice(0, 35);

    const results = await Promise.all(
      solanaTokens.map(async token => {
        try {
          const data = await getJson(
            "https://api.dexscreener.com/token-pairs/v1/solana/" +
            encodeURIComponent(token.tokenAddress)
          );

          return Array.isArray(data) ? data : [];
        } catch {
          return [];
        }
      })
    );

    const seen = new Set();

    latestTokens = results
      .flat()
      .filter(pair => {
        if (
          pair.chainId !== "solana" ||
          !pair.pairAddress ||
          seen.has(pair.pairAddress)
        ) {
          return false;
        }

        seen.add(pair.pairAddress);

        return (
          n(pair.liquidity?.usd) >= MIN_LIQUIDITY &&
          n(pair.volume?.h24) >= MIN_VOLUME &&
          n(pair.priceUsd) > 0
        );
      })
      .sort((a, b) => score(b) - score(a))
      .slice(0, 100);

    const candidates = latestTokens.filter(
      eligible
    );

    // SIMULASI BELI OTOMATIS.
    // Tidak menggunakan wallet atau uang sungguhan.

    for (const pair of candidates) {
      if (
        state.positions.length >=
        MAX_OPEN_POSITIONS
      ) {
        break;
      }

      const alreadyOpen = state.positions.some(
        position =>
          position.pairAddress === pair.pairAddress
      );

      if (alreadyOpen) {
        continue;
      }

      if (state.cash < POSITION_SIZE) {
        break;
      }

      const price = n(pair.priceUsd);

      if (!(price > 0)) {
        continue;
      }

      const cost = POSITION_SIZE;
      const qty = cost / price;

      state.cash -= cost;

      const
