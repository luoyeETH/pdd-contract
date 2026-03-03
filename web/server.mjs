import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const WEB_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, "web-data");
const DATA_FILE = path.join(DATA_DIR, "campaigns.json");

const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = Number(process.env.PORT ?? 3000);

const MAX_BODY_BYTES = 1024 * 1024;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function ensureStorage() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(DATA_FILE);
  } catch {
    await fs.writeFile(DATA_FILE, JSON.stringify({ campaigns: [] }, null, 2));
  }
}

async function readStore() {
  await ensureStorage();
  const raw = await fs.readFile(DATA_FILE, "utf-8");
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.campaigns)) {
    return { campaigns: [] };
  }
  return parsed;
}

async function writeStore(store) {
  const tempFile = `${DATA_FILE}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(store, null, 2));
  await fs.rename(tempFile, DATA_FILE);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

function isAddress(value) {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
}

function toChecksumAgnostic(value) {
  return value.toLowerCase();
}

function parseUnsigned(value, fieldName, { allowZero = true } = {}) {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`${fieldName} must be a string or number`);
  }

  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${fieldName} must be an integer string`);
  }

  const parsed = BigInt(normalized);
  if (!allowZero && parsed === 0n) {
    throw new Error(`${fieldName} must be greater than 0`);
  }

  return parsed.toString();
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = "";

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        return;
      }
      body += chunk;
    });

    req.on("end", () => {
      if (body.length === 0) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });

    req.on("error", reject);
  });
}

function createCampaignFromBody(body) {
  const now = new Date().toISOString();
  const id = `camp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  if (typeof body.title !== "string" || body.title.trim() === "") {
    throw new Error("title is required");
  }

  if (!isAddress(body.factoryAddress) || !isAddress(body.tokenAddress) || !isAddress(body.adminAddress) || !isAddress(body.merchantAddress)) {
    throw new Error("factoryAddress/tokenAddress/adminAddress/merchantAddress must be valid addresses");
  }

  const totalCost = parseUnsigned(body.totalCost, "totalCost", { allowZero: false });
  const minParticipants = parseUnsigned(body.minParticipants, "minParticipants", { allowZero: false });
  const targetParticipants = parseUnsigned(body.targetParticipants ?? "0", "targetParticipants");
  const maxParticipants = parseUnsigned(body.maxParticipants ?? "0", "maxParticipants");
  const maxBatchSize = parseUnsigned(body.maxBatchSize, "maxBatchSize", { allowZero: false });
  const deadline = parseUnsigned(body.deadline, "deadline", { allowZero: false });
  const tokenDecimals = Number(body.tokenDecimals ?? 18);

  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 36) {
    throw new Error("tokenDecimals must be an integer between 0 and 36");
  }

  if (BigInt(targetParticipants) !== 0n && BigInt(targetParticipants) < BigInt(minParticipants)) {
    throw new Error("targetParticipants must be 0 or >= minParticipants");
  }

  if (BigInt(maxParticipants) !== 0n && BigInt(maxParticipants) < BigInt(minParticipants)) {
    throw new Error("maxParticipants must be 0 or >= minParticipants");
  }

  if (BigInt(deadline) <= BigInt(Math.floor(Date.now() / 1000))) {
    throw new Error("deadline must be in the future");
  }

  return {
    id,
    title: body.title.trim(),
    description: typeof body.description === "string" ? body.description.trim() : "",
    tokenSymbol: typeof body.tokenSymbol === "string" && body.tokenSymbol.trim() !== "" ? body.tokenSymbol.trim() : "USDT",
    tokenDecimals,
    totalCost,
    minParticipants,
    targetParticipants,
    maxParticipants,
    maxBatchSize,
    deadline,
    factoryAddress: toChecksumAgnostic(body.factoryAddress),
    tokenAddress: toChecksumAgnostic(body.tokenAddress),
    adminAddress: toChecksumAgnostic(body.adminAddress),
    merchantAddress: toChecksumAgnostic(body.merchantAddress),
    createdAt: now,
    updatedAt: now,
    status: "draft",
    roundAddress: "",
    roundCreateTxHash: "",
    registrations: [],
  };
}

function computeSeedPlan(totalCost, registrations) {
  if (registrations.length === 0) {
    return [];
  }

  const total = BigInt(totalCost);
  const n = BigInt(registrations.length);
  const base = total / n;
  const remainder = total % n;

  return registrations.map((entry, index) => {
    const amount = base + (BigInt(index) < remainder ? 1n : 0n);
    return {
      address: entry.address,
      amount: amount.toString(),
    };
  });
}

function enrichCampaign(campaign) {
  const registrations = Array.isArray(campaign.registrations) ? campaign.registrations : [];
  const seedPlan = computeSeedPlan(campaign.totalCost, registrations);

  const highestPlannedSeed = seedPlan.reduce((acc, item) => {
    const value = BigInt(item.amount);
    return value > acc ? value : acc;
  }, 0n);

  return {
    ...campaign,
    registrationCount: registrations.length,
    seedPlan,
    highestPlannedSeed: highestPlannedSeed.toString(),
    suggestedNextApproval:
      registrations.length === 0
        ? campaign.totalCost
        : (((BigInt(campaign.totalCost) - 1n) / BigInt(registrations.length + 1)) + 1n).toString(),
  };
}

async function handleApi(req, res, url) {
  const method = req.method ?? "GET";
  const pathname = url.pathname;

  if (method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, { ok: true, timestamp: new Date().toISOString() });
    return;
  }

  if (method === "GET" && pathname === "/api/campaigns") {
    const store = await readStore();
    const campaigns = [...store.campaigns]
      .sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1))
      .map((item) => enrichCampaign(item));
    sendJson(res, 200, { campaigns });
    return;
  }

  const oneCampaignMatch = pathname.match(/^\/api\/campaigns\/([^/]+)$/);
  if (method === "GET" && oneCampaignMatch) {
    const campaignId = oneCampaignMatch[1];
    const store = await readStore();
    const campaign = store.campaigns.find((item) => item.id === campaignId);
    if (!campaign) {
      sendJson(res, 404, { error: "campaign not found" });
      return;
    }

    sendJson(res, 200, { campaign: enrichCampaign(campaign) });
    return;
  }

  if (method === "POST" && pathname === "/api/campaigns") {
    let campaign;
    try {
      const body = await readJsonBody(req);
      campaign = createCampaignFromBody(body);
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : "invalid request" });
      return;
    }

    const store = await readStore();
    store.campaigns.push(campaign);
    await writeStore(store);

    sendJson(res, 201, { campaign: enrichCampaign(campaign) });
    return;
  }

  const registerMatch = pathname.match(/^\/api\/campaigns\/([^/]+)\/register$/);
  if (method === "POST" && registerMatch) {
    const campaignId = registerMatch[1];
    let body;
    let approvalAmount;
    let address;
    try {
      body = await readJsonBody(req);
      if (!isAddress(body.address)) {
        throw new Error("invalid address");
      }
      approvalAmount = parseUnsigned(body.approvalAmount, "approvalAmount", { allowZero: false });
      address = toChecksumAgnostic(body.address);
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : "invalid request" });
      return;
    }

    const store = await readStore();
    const idx = store.campaigns.findIndex((item) => item.id === campaignId);
    if (idx === -1) {
      sendJson(res, 404, { error: "campaign not found" });
      return;
    }

    const campaign = store.campaigns[idx];
    if (campaign.roundAddress) {
      sendJson(res, 409, { error: "round already created, registration closed" });
      return;
    }

    const now = new Date().toISOString();
    const existingIdx = campaign.registrations.findIndex((item) => item.address === address);
    const entry = {
      address,
      approvalAmount,
      approvalTxHash: typeof body.approvalTxHash === "string" ? body.approvalTxHash : "",
      registeredAt: now,
      updatedAt: now,
    };

    if (existingIdx >= 0) {
      campaign.registrations[existingIdx] = {
        ...campaign.registrations[existingIdx],
        ...entry,
      };
    } else {
      campaign.registrations.push(entry);
    }

    campaign.updatedAt = now;
    await writeStore(store);

    sendJson(res, 200, { campaign: enrichCampaign(campaign) });
    return;
  }

  const onchainMatch = pathname.match(/^\/api\/campaigns\/([^/]+)\/mark-onchain$/);
  if (method === "POST" && onchainMatch) {
    const campaignId = onchainMatch[1];
    let body;
    try {
      body = await readJsonBody(req);
      if (!isAddress(body.roundAddress)) {
        throw new Error("invalid roundAddress");
      }
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : "invalid request" });
      return;
    }

    const store = await readStore();
    const idx = store.campaigns.findIndex((item) => item.id === campaignId);
    if (idx === -1) {
      sendJson(res, 404, { error: "campaign not found" });
      return;
    }

    const campaign = store.campaigns[idx];
    campaign.roundAddress = toChecksumAgnostic(body.roundAddress);
    campaign.roundCreateTxHash = typeof body.roundCreateTxHash === "string" ? body.roundCreateTxHash : "";
    campaign.status = "onchain";
    campaign.updatedAt = new Date().toISOString();

    await writeStore(store);
    sendJson(res, 200, { campaign: enrichCampaign(campaign) });
    return;
  }

  sendJson(res, 404, { error: "api route not found" });
}

async function serveStatic(req, res, url) {
  let pathname = url.pathname;
  if (pathname === "/") {
    pathname = "/index.html";
  }

  const normalized = path.normalize(pathname).replace(/^([.][.][/\\])+/, "").replace(/^[/\\]+/, "");
  const filePath = path.join(WEB_DIR, normalized);

  if (!filePath.startsWith(WEB_DIR)) {
    sendText(res, 403, "forbidden");
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": contentType });
    res.end(data);
  } catch {
    sendText(res, 404, "not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    await serveStatic(req, res, url);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unexpected error";
    sendJson(res, 500, { error: message });
  }
});

await ensureStorage();
server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`web server running at http://${HOST}:${PORT}`);
});
