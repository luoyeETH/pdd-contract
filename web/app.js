/* global ethers */

const FACTORY_ABI = [
  "function factoryAdmin() view returns (address)",
  "function token() view returns (address)",
  "function createRoundWithSeed((address admin,address merchant,uint256 totalCost,uint256 deadline,uint256 minParticipants,uint256 targetParticipants,uint256 maxParticipants,uint256 maxBatchSize) params,address[] seedUsers,uint256[] seedAmounts) returns (address roundAddress)",
  "event RoundCreated(address indexed round,address indexed admin,address indexed merchant,uint256 totalCost,uint256 seedCount,uint256 deadline)"
];

const ROUND_ABI = [
  "function join(uint256 expectedCount,uint256 maxQuote)",
  "function claimRefund()",
  "function batchRefundSurplus(address[] users,uint256 maxUsers)",
  "function finalizeSuccess()",
  "function finalizeFailed()",
  "function withdrawMerchant()",
  "function viewJoinQuote() view returns (uint256)",
  "function viewRefundable(address user) view returns (uint256)",
  "function viewUnitCost() view returns (uint256)",
  "function viewOutstandingSurplusRefunds() view returns (uint256)",
  "function participantCount() view returns (uint256)",
  "function finalParticipantCount() view returns (uint256)",
  "function state() view returns (uint8)",
  "function paid(address user) view returns (uint256)",
  "function claimed(address user) view returns (uint256)",
  "function totalCost() view returns (uint256)",
  "function deadline() view returns (uint256)",
  "function admin() view returns (address)",
  "function merchant() view returns (address)"
];

const ERC20_ABI = [
  "function approve(address spender,uint256 amount) returns (bool)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)"
];

const DEFAULTS_KEY = "dcs.defaults.v1";
const API_BASE = window.location.pathname.startsWith("/groupbuy") ? "/groupbuy-api" : "";
const REQUIRED_CHAIN_ID = 97n; // BSC Testnet
const REQUIRED_CHAIN_NAME = "BSC 测试网";
const AUTH_MESSAGE_PREFIX = "DCS_AUTH_V1";

const state = {
  provider: null,
  signer: null,
  account: "",
  chainId: "",
  campaigns: [],
  defaults: {
    factoryAddress: "",
    tokenAddress: "",
    tokenSymbol: "USDT",
    tokenDecimals: 18,
  },
  onchainCache: new Map(),
};

const dom = {
  connectWalletBtn: document.getElementById("connectWalletBtn"),
  walletInfo: document.getElementById("walletInfo"),
  logs: document.getElementById("logs"),
  campaignList: document.getElementById("campaignList"),
  refreshCampaignsBtn: document.getElementById("refreshCampaignsBtn"),
  saveDefaultsBtn: document.getElementById("saveDefaultsBtn"),
  campaignForm: document.getElementById("campaignForm"),
  defaultFactoryAddress: document.getElementById("defaultFactoryAddress"),
  defaultTokenAddress: document.getElementById("defaultTokenAddress"),
  defaultTokenSymbol: document.getElementById("defaultTokenSymbol"),
  defaultTokenDecimals: document.getElementById("defaultTokenDecimals"),
  campaignTitle: document.getElementById("campaignTitle"),
  campaignDescription: document.getElementById("campaignDescription"),
  campaignTotalCost: document.getElementById("campaignTotalCost"),
  campaignDeadline: document.getElementById("campaignDeadline"),
  campaignMinParticipants: document.getElementById("campaignMinParticipants"),
  campaignTargetParticipants: document.getElementById("campaignTargetParticipants"),
  campaignMaxParticipants: document.getElementById("campaignMaxParticipants"),
  campaignMaxBatchSize: document.getElementById("campaignMaxBatchSize"),
  campaignAdminAddress: document.getElementById("campaignAdminAddress"),
  campaignMerchantAddress: document.getElementById("campaignMerchantAddress"),
  campaignFactoryAddress: document.getElementById("campaignFactoryAddress"),
  campaignTokenAddress: document.getElementById("campaignTokenAddress"),
  campaignTokenSymbol: document.getElementById("campaignTokenSymbol"),
  campaignTokenDecimals: document.getElementById("campaignTokenDecimals"),
};

function log(message) {
  const timestamp = new Date().toISOString();
  dom.logs.textContent = `[${timestamp}] ${message}\n${dom.logs.textContent}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function shortAddress(address) {
  if (!address || address.length < 12) {
    return address;
  }
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function stateLabel(stateValue) {
  switch (Number(stateValue)) {
    case 0:
      return "未初始化";
    case 1:
      return "进行中";
    case 2:
      return "成功已结算";
    case 3:
      return "失败已结算";
    default:
      return `未知状态(${stateValue})`;
  }
}

function saveDefaults() {
  localStorage.setItem(DEFAULTS_KEY, JSON.stringify(state.defaults));
}

function loadDefaults() {
  try {
    const raw = localStorage.getItem(DEFAULTS_KEY);
    if (!raw) {
      return;
    }

    const parsed = JSON.parse(raw);
    state.defaults = {
      ...state.defaults,
      ...parsed,
    };
  } catch (error) {
    log(`默认配置解析失败: ${error.message}`);
  }
}

function fillDefaultsUi() {
  dom.defaultFactoryAddress.value = state.defaults.factoryAddress;
  dom.defaultTokenAddress.value = state.defaults.tokenAddress;
  dom.defaultTokenSymbol.value = state.defaults.tokenSymbol;
  dom.defaultTokenDecimals.value = String(state.defaults.tokenDecimals);

  dom.campaignFactoryAddress.value = state.defaults.factoryAddress;
  dom.campaignTokenAddress.value = state.defaults.tokenAddress;
  dom.campaignTokenSymbol.value = state.defaults.tokenSymbol;
  dom.campaignTokenDecimals.value = String(state.defaults.tokenDecimals);
}

function readDefaultsFromUi() {
  state.defaults.factoryAddress = dom.defaultFactoryAddress.value.trim().toLowerCase();
  state.defaults.tokenAddress = dom.defaultTokenAddress.value.trim().toLowerCase();
  state.defaults.tokenSymbol = dom.defaultTokenSymbol.value.trim() || "USDT";
  state.defaults.tokenDecimals = Number(dom.defaultTokenDecimals.value || "18");
}

async function api(path, options = {}) {
  const { authAction = "", ...fetchOptions } = options;
  const bodyRaw = typeof fetchOptions.body === "string" ? fetchOptions.body : "";
  const authHeaders = authAction ? await buildSignedAuthHeaders(authAction, bodyRaw) : {};

  const normalizedPath = API_BASE ? path.replace(/^\/api/, "") : path;
  const response = await fetch(`${API_BASE}${normalizedPath}`, {
    headers: {
      "content-type": "application/json",
      ...authHeaders,
      ...(fetchOptions.headers || {}),
    },
    ...fetchOptions,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `请求失败: ${response.status}`);
  }

  return payload;
}

function buildAuthMessage({ action, timestamp, nonce, body }) {
  return [AUTH_MESSAGE_PREFIX, `action:${action}`, `timestamp:${timestamp}`, `nonce:${nonce}`, "body:", body].join("\n");
}

async function buildSignedAuthHeaders(action, body) {
  if (!state.signer || !state.account) {
    throw new Error("请先连接钱包以完成请求签名");
  }

  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonceBase = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().replaceAll("-", "")
    : `${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
  const nonce = nonceBase.slice(0, 64);
  const message = buildAuthMessage({
    action,
    timestamp,
    nonce,
    body,
  });

  const signature = await state.signer.signMessage(message);
  return {
    "x-auth-address": state.account,
    "x-auth-signature": signature,
    "x-auth-timestamp": timestamp,
    "x-auth-nonce": nonce,
  };
}

function toBigInt(value) {
  return BigInt(String(value));
}

function formatAmount(raw, decimals) {
  return ethers.formatUnits(toBigInt(raw), decimals);
}

function parseAmount(value, decimals) {
  return ethers.parseUnits(value.trim(), decimals);
}

function ceilDiv(a, b) {
  if (a === 0n) {
    return 0n;
  }
  return ((a - 1n) / b) + 1n;
}

function computeSeedPlan(totalCost, registrations) {
  if (registrations.length === 0) {
    return [];
  }

  const total = toBigInt(totalCost);
  const n = BigInt(registrations.length);
  const base = total / n;
  const remainder = total % n;

  return registrations.map((entry, index) => ({
    address: entry.address,
    amount: (base + (BigInt(index) < remainder ? 1n : 0n)).toString(),
  }));
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function accountMatches(address) {
  return !!state.account && address && state.account === address.toLowerCase();
}

async function ensureNetworkAndContracts(campaign, { needRound = false } = {}) {
  if (!window.ethereum) {
    throw new Error("未检测到浏览器钱包，请先安装并启用 MetaMask");
  }

  if (!state.provider) {
    state.provider = new ethers.BrowserProvider(window.ethereum);
  }

  const network = await state.provider.getNetwork();
  if (network.chainId !== REQUIRED_CHAIN_ID) {
    throw new Error(`请将钱包切换到 ${REQUIRED_CHAIN_NAME}（chainId=97）`);
  }

  const tokenCode = await state.provider.getCode(campaign.tokenAddress);
  if (tokenCode === "0x") {
    throw new Error(`Token 地址在 ${REQUIRED_CHAIN_NAME} 上没有合约代码，请检查地址是否填错`);
  }

  const factoryCode = await state.provider.getCode(campaign.factoryAddress);
  if (factoryCode === "0x") {
    throw new Error(`Factory 地址在 ${REQUIRED_CHAIN_NAME} 上没有合约代码，请检查地址是否填错`);
  }

  if (needRound) {
    const roundCode = await state.provider.getCode(campaign.roundAddress);
    if (roundCode === "0x") {
      throw new Error(`拼单合约地址在 ${REQUIRED_CHAIN_NAME} 上没有代码，请先创建或检查地址`);
    }
  }
}

function asDateTimeLocalDefault() {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const pad = (num) => String(num).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function hydrateCreateFormDefaults() {
  if (!dom.campaignDeadline.value) {
    dom.campaignDeadline.value = asDateTimeLocalDefault();
  }

  if (!dom.campaignAdminAddress.value && state.account) {
    dom.campaignAdminAddress.value = state.account;
  }

  if (!dom.campaignMerchantAddress.value && state.account) {
    dom.campaignMerchantAddress.value = state.account;
  }
}

function getCampaignById(campaignId) {
  return state.campaigns.find((item) => item.id === campaignId);
}

function renderCampaigns() {
  if (state.campaigns.length === 0) {
    dom.campaignList.innerHTML = "<div class=\"muted\">暂无活动。</div>";
    return;
  }

  dom.campaignList.innerHTML = state.campaigns
    .map((campaign) => {
      const decimals = Number(campaign.tokenDecimals);
      const registrationRows = campaign.registrations
        .map((entry, idx) => {
          const planned = campaign.seedPlan[idx]?.amount || "0";
          return `<li><span class=\"code\">${escapeHtml(shortAddress(entry.address))}</span> 已授权 ${escapeHtml(
            formatAmount(entry.approvalAmount, decimals)
          )} ${escapeHtml(campaign.tokenSymbol)} | 预计扣款 ${escapeHtml(
            formatAmount(planned, decimals)
          )}</li>`;
        })
        .join("");

      const chain = state.onchainCache.get(campaign.id);
      const chainHtml = campaign.roundAddress
        ? `<div class="kv">
            <div>拼单合约: <span class="code">${escapeHtml(campaign.roundAddress)}</span></div>
            <div>状态: ${escapeHtml(chain ? stateLabel(chain.state) : "(点击刷新链上数据)")}</div>
            <div>参与人数: ${escapeHtml(chain ? String(chain.participantCount) : "-")}</div>
            <div>当前人均: ${escapeHtml(
              chain ? `${formatAmount(chain.unitCost, decimals)} ${campaign.tokenSymbol}` : "-"
            )}</div>
            <div>当前加入需支付: ${escapeHtml(
              chain ? `${formatAmount(chain.joinQuote, decimals)} ${campaign.tokenSymbol}` : "-"
            )}</div>
            <div>我的可退金额: ${escapeHtml(
              chain ? `${formatAmount(chain.myRefundable, decimals)} ${campaign.tokenSymbol}` : "-"
            )}</div>
            <div>我的已支付: ${escapeHtml(chain ? formatAmount(chain.myPaid, decimals) : "-")}</div>
            <div>我的已退款: ${escapeHtml(chain ? formatAmount(chain.myClaimed, decimals) : "-")}</div>
          </div>
          <div class="actions">
            <button class="secondary" data-action="refreshOnchain" data-id="${campaign.id}">刷新链上数据</button>
            <button class="secondary" data-action="join" data-id="${campaign.id}">链上参与</button>
            <button class="secondary" data-action="claimRefund" data-id="${campaign.id}">手动退款</button>
            <button class="secondary" data-action="finalizeSuccess" data-id="${campaign.id}">结算成功</button>
            <button class="critical" data-action="finalizeFailed" data-id="${campaign.id}">结算失败（管理员）</button>
            <button class="secondary" data-action="withdrawMerchant" data-id="${campaign.id}">商家提取</button>
          </div>
          <label>
            批量退款地址（逗号/换行分隔）
            <textarea id="batch-${campaign.id}" rows="2" placeholder="0xabc...,0xdef..."></textarea>
          </label>
          <div class="actions">
            <button class="secondary" data-action="batchRefund" data-id="${campaign.id}">批量退溢缴（管理员）</button>
          </div>`
        : `<div class="kv">
            <div>拼单合约: 未创建</div>
            <div>预登记人数: ${campaign.registrationCount}</div>
            <div>建议下一位授权: ${escapeHtml(
              formatAmount(campaign.suggestedNextApproval, decimals)
            )} ${escapeHtml(campaign.tokenSymbol)}</div>
            <div>当前最高预计扣款: ${escapeHtml(formatAmount(campaign.highestPlannedSeed, decimals))} ${escapeHtml(
              campaign.tokenSymbol
            )}</div>
          </div>
          <label>
            我的授权金额（${escapeHtml(campaign.tokenSymbol)}）
            <input id="register-${campaign.id}" value="${escapeHtml(
              formatAmount(campaign.suggestedNextApproval, decimals)
            )}" />
          </label>
          <div class="actions">
            <button class="secondary" data-action="approveRegister" data-id="${campaign.id}">授权并登记</button>
            <button class="primary" data-action="createRound" data-id="${campaign.id}">管理员创建链上拼单</button>
          </div>`;

      const canCreateHint =
        campaign.roundAddress || accountMatches(campaign.adminAddress)
          ? ""
          : `<div class=\"muted\">创建链上拼单需使用管理员钱包: ${escapeHtml(shortAddress(campaign.adminAddress))}</div>`;

      return `<article class="campaign">
        <div class="campaign-head">
          <div>
            <h3>${escapeHtml(campaign.title)}</h3>
            <div class="muted">${escapeHtml(campaign.description || "无描述")}</div>
          </div>
          <span class="badge ${campaign.roundAddress ? "onchain" : ""}">${campaign.roundAddress ? "已上链" : "预热中"}</span>
        </div>
        <div class="kv">
          <div>总价: ${escapeHtml(formatAmount(campaign.totalCost, decimals))} ${escapeHtml(campaign.tokenSymbol)}</div>
          <div>截止时间: ${escapeHtml(new Date(Number(campaign.deadline) * 1000).toLocaleString())}</div>
          <div>最小/目标/最大人数: ${escapeHtml(
            `${campaign.minParticipants}/${campaign.targetParticipants}/${campaign.maxParticipants}`
          )}</div>
          <div>管理员: <span class="code">${escapeHtml(shortAddress(campaign.adminAddress))}</span></div>
          <div>商家: <span class="code">${escapeHtml(shortAddress(campaign.merchantAddress))}</span></div>
          <div>Factory: <span class="code">${escapeHtml(shortAddress(campaign.factoryAddress))}</span></div>
        </div>
        <div>
          <div class="muted">预热登记列表</div>
          <ul>${registrationRows || "<li class='muted'>暂无登记。</li>"}</ul>
        </div>
        ${chainHtml}
        ${canCreateHint}
      </article>`;
    })
    .join("");
}

async function loadCampaigns() {
  const { campaigns } = await api("/api/campaigns");
  state.campaigns = campaigns;
  renderCampaigns();
}

async function connectWallet() {
  if (!window.ethereum) {
    throw new Error("未检测到浏览器钱包，请先安装并启用 MetaMask");
  }

  state.provider = new ethers.BrowserProvider(window.ethereum);
  await state.provider.send("eth_requestAccounts", []);
  state.signer = await state.provider.getSigner();
  state.account = (await state.signer.getAddress()).toLowerCase();
  const network = await state.provider.getNetwork();
  state.chainId = String(network.chainId);

  dom.walletInfo.textContent = `已连接: ${shortAddress(state.account)} | 链ID=${state.chainId}`;
  hydrateCreateFormDefaults();
  log(`钱包已连接: ${state.account}`);
}

async function submitCampaign(event) {
  event.preventDefault();

  try {
    if (!state.account) {
      throw new Error("请先连接钱包");
    }

    const tokenDecimals = Number(dom.campaignTokenDecimals.value || state.defaults.tokenDecimals);
    const totalCost = parseAmount(dom.campaignTotalCost.value, tokenDecimals).toString();

    const deadlineIso = dom.campaignDeadline.value;
    const deadline = Math.floor(new Date(deadlineIso).getTime() / 1000);
    if (!Number.isFinite(deadline) || deadline <= nowUnix()) {
      throw new Error("截止时间必须晚于当前时间");
    }

    const payload = {
      title: dom.campaignTitle.value,
      description: dom.campaignDescription.value,
      totalCost,
      deadline: String(deadline),
      minParticipants: String(dom.campaignMinParticipants.value),
      targetParticipants: String(dom.campaignTargetParticipants.value),
      maxParticipants: String(dom.campaignMaxParticipants.value),
      maxBatchSize: String(dom.campaignMaxBatchSize.value),
      adminAddress: (dom.campaignAdminAddress.value || state.account).trim(),
      merchantAddress: (dom.campaignMerchantAddress.value || state.account).trim(),
      factoryAddress: (dom.campaignFactoryAddress.value || state.defaults.factoryAddress).trim(),
      tokenAddress: (dom.campaignTokenAddress.value || state.defaults.tokenAddress).trim(),
      tokenSymbol: dom.campaignTokenSymbol.value || state.defaults.tokenSymbol,
      tokenDecimals,
    };

    await ensureNetworkAndContracts({
      tokenAddress: payload.tokenAddress,
      factoryAddress: payload.factoryAddress,
    });

    const [adminCode, merchantCode] = await Promise.all([
      state.provider.getCode(payload.adminAddress),
      state.provider.getCode(payload.merchantAddress),
    ]);
    if (adminCode !== "0x") {
      throw new Error("管理员地址必须是 EOA（当前为合约地址，后续 onlyEOA 会导致操作失败）");
    }
    if (merchantCode !== "0x") {
      throw new Error("商家地址必须是 EOA（当前为合约地址，后续 onlyEOA 会导致提取失败）");
    }

    if (!accountMatches(payload.adminAddress)) {
      throw new Error(`创建活动需使用管理员钱包签名: ${payload.adminAddress}`);
    }

    await api("/api/campaigns", {
      method: "POST",
      body: JSON.stringify(payload),
      authAction: "campaigns:create",
    });

    log(`活动已创建: ${payload.title}`);
    await loadCampaigns();
  } catch (error) {
    log(`创建活动失败: ${error.message}`);
  }
}

async function approveAndRegister(campaign) {
  if (!state.account || !state.signer) {
    throw new Error("请先连接钱包");
  }
  await ensureNetworkAndContracts(campaign);

  if (campaign.roundAddress) {
    throw new Error("拼单合约已创建，预登记已关闭");
  }

  const input = document.getElementById(`register-${campaign.id}`);
  const humanAmount = input?.value?.trim();
  if (!humanAmount) {
    throw new Error("请填写授权金额");
  }

  const amount = parseAmount(humanAmount, Number(campaign.tokenDecimals));
  const token = new ethers.Contract(campaign.tokenAddress, ERC20_ABI, state.signer);

  const allowance = await token.allowance(state.account, campaign.factoryAddress);
  let approvalTxHash = "";

  if (allowance < amount) {
    log(`正在发送授权交易: ${campaign.title} ...`);
    const approveTx = await token.approve(campaign.factoryAddress, amount);
    approvalTxHash = approveTx.hash;
    await approveTx.wait();
    log(`授权已确认: ${approveTx.hash}`);
  } else {
    log("当前授权额度充足，跳过授权交易");
  }

  await api(`/api/campaigns/${campaign.id}/register`, {
    method: "POST",
    body: JSON.stringify({
      address: state.account,
      approvalAmount: amount.toString(),
      approvalTxHash,
    }),
    authAction: `campaigns:${campaign.id}:register`,
  });

  log(`登记完成: ${campaign.title}`);
  await loadCampaigns();
}

function parseRoundAddressFromReceipt(receipt) {
  const iface = new ethers.Interface(FACTORY_ABI);
  for (const logItem of receipt.logs) {
    try {
      const parsed = iface.parseLog(logItem);
      if (parsed && parsed.name === "RoundCreated") {
        return String(parsed.args.round).toLowerCase();
      }
    } catch {
      // ignore non-matching logs
    }
  }
  return "";
}

async function createRound(campaign) {
  if (!state.account || !state.signer) {
    throw new Error("请先连接钱包");
  }
  await ensureNetworkAndContracts(campaign);

  if (!accountMatches(campaign.adminAddress)) {
    throw new Error(`仅管理员可创建拼单: ${campaign.adminAddress}`);
  }

  if (campaign.roundAddress) {
    throw new Error("拼单合约已创建");
  }

  const registrations = [...campaign.registrations].sort((a, b) => (a.registeredAt > b.registeredAt ? 1 : -1));
  const seedPlan = computeSeedPlan(campaign.totalCost, registrations);

  if (seedPlan.length > 0) {
    const token = new ethers.Contract(campaign.tokenAddress, ERC20_ABI, state.provider);
    const insufficient = [];

    for (const item of seedPlan) {
      const allowance = await token.allowance(item.address, campaign.factoryAddress);
      if (allowance < toBigInt(item.amount)) {
        insufficient.push(`${shortAddress(item.address)} 还需 ${formatAmount(item.amount, Number(campaign.tokenDecimals))}`);
      }
    }

    if (insufficient.length > 0) {
      throw new Error(`预热用户授权不足: ${insufficient.join(" | ")}`);
    }
  }

  const factory = new ethers.Contract(campaign.factoryAddress, FACTORY_ABI, state.signer);
  const params = {
    admin: campaign.adminAddress,
    merchant: campaign.merchantAddress,
    totalCost: toBigInt(campaign.totalCost),
    deadline: toBigInt(campaign.deadline),
    minParticipants: toBigInt(campaign.minParticipants),
    targetParticipants: toBigInt(campaign.targetParticipants),
    maxParticipants: toBigInt(campaign.maxParticipants),
    maxBatchSize: toBigInt(campaign.maxBatchSize),
  };

  const seedUsers = seedPlan.map((item) => item.address);
  const seedAmounts = seedPlan.map((item) => toBigInt(item.amount));

  log(`正在创建链上拼单: ${campaign.title}，预热人数 ${seedUsers.length} ...`);
  const tx = await factory.createRoundWithSeed(params, seedUsers, seedAmounts);
  const receipt = await tx.wait();

  const roundAddress = parseRoundAddressFromReceipt(receipt);
  if (!roundAddress) {
    throw new Error("交易日志中未找到拼单合约地址");
  }

  await api(`/api/campaigns/${campaign.id}/mark-onchain`, {
    method: "POST",
    body: JSON.stringify({
      roundAddress,
      roundCreateTxHash: tx.hash,
    }),
    authAction: `campaigns:${campaign.id}:mark-onchain`,
  });

  log(`链上拼单创建成功: ${roundAddress}`);
  await loadCampaigns();
}

async function refreshOnchain(campaign) {
  if (!campaign.roundAddress) {
    throw new Error("拼单合约尚未创建");
  }
  await ensureNetworkAndContracts(campaign, { needRound: true });

  if (!state.provider) {
    state.provider = new ethers.BrowserProvider(window.ethereum);
  }

  const round = new ethers.Contract(campaign.roundAddress, ROUND_ABI, state.provider);
  const [roundState, participantCount, unitCost, joinQuote] = await Promise.all([
    round.state(),
    round.participantCount(),
    round.viewUnitCost(),
    round.viewJoinQuote(),
  ]);

  let myRefundable = 0n;
  let myPaid = 0n;
  let myClaimed = 0n;

  if (state.account) {
    [myRefundable, myPaid, myClaimed] = await Promise.all([
      round.viewRefundable(state.account),
      round.paid(state.account),
      round.claimed(state.account),
    ]);
  }

  state.onchainCache.set(campaign.id, {
    state: Number(roundState),
    participantCount: toBigInt(participantCount),
    unitCost: toBigInt(unitCost),
    joinQuote: toBigInt(joinQuote),
    myRefundable: toBigInt(myRefundable),
    myPaid: toBigInt(myPaid),
    myClaimed: toBigInt(myClaimed),
  });

  renderCampaigns();
  log(`链上数据已刷新: ${campaign.title}`);
}

async function joinRound(campaign) {
  if (!state.signer || !state.account) {
    throw new Error("请先连接钱包");
  }

  if (!campaign.roundAddress) {
    throw new Error("拼单合约尚未创建");
  }
  await ensureNetworkAndContracts(campaign, { needRound: true });

  const round = new ethers.Contract(campaign.roundAddress, ROUND_ABI, state.signer);
  const token = new ethers.Contract(campaign.tokenAddress, ERC20_ABI, state.signer);

  const [expectedCount, quote] = await Promise.all([round.participantCount(), round.viewJoinQuote()]);
  if (quote === 0n) {
    throw new Error("当前加入报价为 0，可能已截止或不可加入");
  }

  const allowance = await token.allowance(state.account, campaign.roundAddress);
  if (allowance < quote) {
    log(`正在授权 ${formatAmount(quote, Number(campaign.tokenDecimals))} ${campaign.tokenSymbol} 给拼单合约...`);
    const approveTx = await token.approve(campaign.roundAddress, quote);
    await approveTx.wait();
    log(`参与授权已确认: ${approveTx.hash}`);
  }

  const maxQuote = quote + quote / 50n + 1n;
  log(`正在链上参与: ${campaign.title} ...`);
  const tx = await round.join(expectedCount, maxQuote);
  await tx.wait();

  log(`参与成功: ${tx.hash}`);
  await refreshOnchain(campaign);
}

function actionLabel(action) {
  const map = {
    claimRefund: "手动退款",
    finalizeSuccess: "结算成功",
    finalizeFailed: "结算失败",
    withdrawMerchant: "商家提取",
    batchRefundSurplus: "批量退溢缴",
  };
  return map[action] || action;
}

async function callRoundTx(campaign, action, fn) {
  if (!state.signer || !state.account) {
    throw new Error("请先连接钱包");
  }
  if (!campaign.roundAddress) {
    throw new Error("拼单合约尚未创建");
  }
  await ensureNetworkAndContracts(campaign, { needRound: true });

  const round = new ethers.Contract(campaign.roundAddress, ROUND_ABI, state.signer);
  log(`${actionLabel(action)} 交易已提交...`);
  const tx = await fn(round);
  await tx.wait();
  log(`${actionLabel(action)} 成功: ${tx.hash}`);
  await refreshOnchain(campaign);
}

async function handleCampaignAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) {
    return;
  }

  const campaignId = button.dataset.id;
  const action = button.dataset.action;
  const campaign = getCampaignById(campaignId);
  if (!campaign) {
    return;
  }

  try {
    button.disabled = true;

    if (action === "approveRegister") {
      await approveAndRegister(campaign);
    } else if (action === "createRound") {
      await createRound(campaign);
    } else if (action === "refreshOnchain") {
      await refreshOnchain(campaign);
    } else if (action === "join") {
      await joinRound(campaign);
    } else if (action === "claimRefund") {
      await callRoundTx(campaign, "claimRefund", (round) => round.claimRefund());
    } else if (action === "finalizeSuccess") {
      await callRoundTx(campaign, "finalizeSuccess", (round) => round.finalizeSuccess());
    } else if (action === "finalizeFailed") {
      await callRoundTx(campaign, "finalizeFailed", (round) => round.finalizeFailed());
    } else if (action === "withdrawMerchant") {
      await callRoundTx(campaign, "withdrawMerchant", (round) => round.withdrawMerchant());
    } else if (action === "batchRefund") {
      const textarea = document.getElementById(`batch-${campaign.id}`);
      const raw = textarea?.value || "";
      const users = raw
        .split(/[\n,\s]+/)
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);

      if (users.length === 0) {
        throw new Error("批量退款至少填写 1 个地址");
      }

      for (const addr of users) {
        if (!ethers.isAddress(addr)) {
          throw new Error(`批量地址格式错误: ${addr}`);
        }
      }

      await callRoundTx(campaign, "batchRefundSurplus", (round) => round.batchRefundSurplus(users, users.length));
    }
  } catch (error) {
    log(`${actionLabel(action)} 失败: ${error.message}`);
  } finally {
    button.disabled = false;
  }
}

function bindEvents() {
  dom.connectWalletBtn.addEventListener("click", async () => {
    try {
      await connectWallet();
    } catch (error) {
      log(`连接钱包失败: ${error.message}`);
    }
  });

  dom.saveDefaultsBtn.addEventListener("click", () => {
    try {
      readDefaultsFromUi();
      saveDefaults();
      fillDefaultsUi();
      log("默认配置已保存");
    } catch (error) {
      log(`保存默认配置失败: ${error.message}`);
    }
  });

  dom.refreshCampaignsBtn.addEventListener("click", async () => {
    try {
      await loadCampaigns();
      log("活动列表已刷新");
    } catch (error) {
      log(`刷新失败: ${error.message}`);
    }
  });

  dom.campaignForm.addEventListener("submit", submitCampaign);
  dom.campaignList.addEventListener("click", handleCampaignAction);

  if (window.ethereum) {
    window.ethereum.on("accountsChanged", async (accounts) => {
      if (!Array.isArray(accounts) || accounts.length === 0) {
        state.account = "";
        state.signer = null;
        dom.walletInfo.textContent = "钱包已断开";
        renderCampaigns();
        return;
      }

      try {
        await connectWallet();
        renderCampaigns();
      } catch (error) {
        log(`钱包状态更新失败: ${error.message}`);
      }
    });
  }
}

async function bootstrap() {
  loadDefaults();
  fillDefaultsUi();
  hydrateCreateFormDefaults();
  bindEvents();
  await loadCampaigns();
  log("门户已就绪");
}

bootstrap().catch((error) => {
  log(`初始化失败: ${error.message}`);
});
