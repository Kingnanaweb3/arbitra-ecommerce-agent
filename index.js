const express = require("express");
const axios = require("axios");
const { SuiClient, getFullnodeUrl } = require("@mysten/sui.js/client");
const { Ed25519Keypair } = require("@mysten/sui.js/keypairs/ed25519");
const { TransactionBlock } = require("@mysten/sui.js/transactions");
const { fromB64 } = require("@mysten/sui.js/utils");

const app = express();
app.use(express.json());

const ARBITRA_ENDPOINT = process.env.ARBITRA_ENDPOINT ?? "https://arbitra-nine.vercel.app/api/action";
const POLICY_ID = process.env.POLICY_ID ?? "";
const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY ?? "";
const VENDOR_ADDRESS = process.env.VENDOR_ADDRESS ?? "0x7190887dc52006630b989af6ba2b3456491be283e03e2cee82c0dd0897280f3c";
const USDC_TYPE = "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC";

const suiClient = new SuiClient({ url: getFullnodeUrl("testnet") });

// Product catalog
const CATALOG = [
  { name: "API Credits Bundle", vendor: "DevTools Inc", price: 3, category: "saas" },
  { name: "Cloud Storage 10GB", vendor: "CloudVault", price: 3, category: "cloud" },
  { name: "Analytics Dashboard", vendor: "DataPulse", price: 3, category: "saas" },
  { name: "Email Campaign 100", vendor: "MailFlow", price: 3, category: "marketing" },
  { name: "SSL Certificate", vendor: "SecureNet", price: 3, category: "security" },
  { name: "CDN Bandwidth 10GB", vendor: "FastEdge", price: 3, category: "cloud" },
];

const state = {
  totalCycles: 0,
  totalPurchases: 0,
  totalSkips: 0,
  totalRejected: 0,
  totalSpent: 0,
  lastAction: null,
  history: [],
};

function calculateRiskScore(price, totalSpent, budget) {
  const spendRate = totalSpent / budget;
  const priceRisk = price / 50 * 40;
  const spendRisk = spendRate * 40;
  const noise = Math.random() * 20;
  return Math.min(95, Math.round(priceRisk + spendRisk + noise));
}

async function getUSDCBalance() {
  try {
    const balance = await suiClient.getBalance({
      owner: Ed25519Keypair.fromSecretKey(fromB64(PRIVATE_KEY)).getPublicKey().toSuiAddress(),
      coinType: USDC_TYPE,
    });
    return Number(balance.totalBalance) / 1_000_000;
  } catch {
    return 0;
  }
}

async function transferUSDC(amount) {
  if (!PRIVATE_KEY) {
    console.log("[Transfer] No private key — skipping real transfer");
    return null;
  }
  try {
    const keypair = Ed25519Keypair.fromSecretKey(fromB64(PRIVATE_KEY));
    const amountInUnits = Math.round(amount * 1_000_000);

    // Get USDC coins
    const coins = await suiClient.getCoins({
      owner: keypair.getPublicKey().toSuiAddress(),
      coinType: USDC_TYPE,
    });

    if (!coins.data || coins.data.length === 0) {
      console.log("[Transfer] No USDC coins found");
      return null;
    }

    // Find coin with sufficient balance
    const validCoin = coins.data.find(c => Number(c.balance) >= amountInUnits);
    if (!validCoin) {
      console.log("[Transfer] No coin with sufficient balance found");
      return null;
    }

    const tx = new TransactionBlock();
    const [coin] = tx.splitCoins(tx.object(validCoin.coinObjectId), [
      tx.pure(amountInUnits, "u64"),
    ]);
    tx.transferObjects([coin], tx.pure(VENDOR_ADDRESS, "address"));

    const result = await suiClient.signAndExecuteTransactionBlock({
      transactionBlock: tx,
      signer: keypair,
      options: { showEffects: true },
    });

    console.log(`[Transfer] Sent ${amount} USDC to vendor | tx: ${result.digest}`);
    // Wait for transaction to be confirmed before next transfer
    await suiClient.waitForTransactionBlock({ digest: result.digest });
    return result.digest;
  } catch (e) {
    console.error("[Transfer] Error:", e.message);
    return null;
  }
}

async function runCycle() {
  state.totalCycles++;

  // Check wallet balance first
  const balance = await getUSDCBalance();
  console.log(`[Cycle ${state.totalCycles}] Wallet balance: ${balance} USDC`);

  // Pick affordable product
  const affordable = CATALOG.filter(p => p.price <= balance);
  if (affordable.length === 0) {
    console.log("  No affordable products — skipping cycle");
    state.totalSkips++;
    state.lastAction = { action: "SKIP", reason: `Insufficient balance: ${balance} USDC`, timestamp: Date.now() };
    state.history.unshift(state.lastAction);
    return;
  }
  const product = affordable[Math.floor(Math.random() * affordable.length)];
  const riskScore = calculateRiskScore(product.price, state.totalSpent, 200);

  console.log(`\n[Cycle ${state.totalCycles}] Product: ${product.name} | Price: $${product.price} | Risk: ${riskScore}`);

  try {
    // Ask Arbitra for approval
    const response = await axios.post(ARBITRA_ENDPOINT, {
      action: "PURCHASE",
      amount: product.price,
      token: "USDC",
      vendor: product.vendor,
      product: product.name,
      category: product.category,
      riskScore,
      slippageBps: 0,
      policyId: POLICY_ID,
      scope: "custom",
      walletAddress: "0x75380bca19fad6159850104a134d131f46408f4759df47179b2350d231805630",
      timestamp: Date.now(),
    }, {
      headers: { "Content-Type": "application/json" },
      timeout: 10000,
    });

    const approved = response.data?.approved ?? false;

    if (approved) {
      console.log(`  Arbitra approved PURCHASE — transferring ${product.price} USDC to vendor`);

      // Execute real USDC transfer
      const txDigest = await transferUSDC(product.price);

      state.totalPurchases++;
      state.totalSpent += product.price;
      state.lastAction = {
        action: "PURCHASE",
        product: product.name,
        vendor: product.vendor,
        amount: product.price,
        arbitraDecision: "approved",
        txDigest,
        timestamp: Date.now(),
      };
    } else {
      console.log(`  Arbitra rejected PURCHASE — ${response.data?.rejectionReason ?? "policy check failed"}`);
      state.totalRejected++;
      state.lastAction = {
        action: "PURCHASE",
        product: product.name,
        vendor: product.vendor,
        amount: product.price,
        arbitraDecision: "rejected",
        reason: response.data?.rejectionReason,
        timestamp: Date.now(),
      };
    }
  } catch (e) {
    console.log(`  Error: ${e.message}`);
    state.totalSkips++;
    state.lastAction = { action: "SKIP", reason: e.message, timestamp: Date.now() };
  }

  state.history.unshift(state.lastAction);
  if (state.history.length > 20) state.history.pop();
}

// Routes
app.get("/", (req, res) => res.json({
  agent: "Arbitra E-Commerce Agent",
  strategy: "Autonomous purchasing with vendor controls",
  status: "running",
  cycles: state.totalCycles,
}));

app.get("/state", (req, res) => res.json(state));
app.get("/history", (req, res) => res.json(state.history));

app.post("/trigger", async (req, res) => {
  await runCycle();
  res.json({ success: true, lastAction: state.lastAction, state });
});

app.post("/force-purchase", async (req, res) => {
  await runCycle();
  res.json({ success: true, lastAction: state.lastAction, state });
});

const PORT = process.env.PORT ?? 10000;
app.listen(PORT, () => {
  console.log("==================================================");
  console.log("Arbitra E-Commerce Agent");
  console.log(`Running on: http://localhost:${PORT}`);
  console.log(`Arbitra endpoint: ${ARBITRA_ENDPOINT}`);
  console.log(`Policy ID: ${POLICY_ID}`);
  console.log(`Vendor address: ${VENDOR_ADDRESS}`);
  console.log("==================================================");
  console.log("Starting purchasing loop — executing every 7 minutes");

  // Run every 7 minutes
  setInterval(runCycle, 7 * 60 * 1000);
  // First cycle after 10 seconds
  setTimeout(runCycle, 10000);
});
