const { spawn, exec } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const axios = require('axios');
const compressing = require('compressing');
const fsExtra = require('fs-extra');
const fastify = require('fastify')({ logger: !!process.env.ENABLE_LOG });
const proxy = require('@fastify/http-proxy');
const crypto = require('crypto');

// ────────────────────────────────────────────────
// 固定版本
const VERSIONS = {
  SING_BOX: '1.13.2',
  NEZHA_AGENT: 'v0.20.23',
  CLOUDFLARED: '2026.2.0',
  MIHOMO: 'v1.19.32',
};

// ────────────────────────────────────────────────
// 环境变量
const ENV = {
  // UUID:            process.env.UUID || crypto.randomUUID(),
  UUID: process.env.UUID || "ffffffff-ffff-ffff-ffff-ffffffffffff",
  PORT: Number(process.env.PORT) || 3000,
  WS_PATH: process.env.WS_PATH || 'xray2026',
  AUTH_TOKEN: process.env.AUTH_TOKEN || 'lalifeier',

  NEZHA_SERVER: process.env.NEZHA_SERVER || 'nezha.lalifeier.eu.org',
  NEZHA_PORT: process.env.NEZHA_PORT || '443',
  NEZHA_KEY: process.env.NEZHA_KEY || 'cEjHDQYuIgoy6K60U6',

  CF_TOKEN: process.env.CLOUDFLARE_TOKEN || 'eyJhIjoiMjMxZDY0YTVkYWQ2ODIwMWRjNGIwY2IyNjJlMWUxOTkiLCJ0IjoiMjc5ZTEwZWUtYzZiOS00NWM1LThmYjUtZmU2YzU3ZmE0NWM5IiwicyI6IlpUQXpOelZpWWpJdE56SmlZUzAwTjJWbExXRXlPV0l0T0RNMlptTXlZVEUxTnpjeSJ9',

  DOMAIN: process.env.DOMAIN,
  TLS_SERVER: process.env.TLS_SERVER || 'addons.mozilla.org',
  REALITY_PRIVATE: process.env.REALITY_PRIVATE || 'GL_HdaX-VQVBStvCjmXqcAT-jaO4TH74_fzqEmK-CWU',
  REALITY_PUBLIC: process.env.REALITY_PUBLIC || 'NvbPo4WyN3p4MIQgaz9N6CHzdWEtzem8hcUOqCxfQiU',

  VPNGATE_SUB: process.env.VPNGATE_SUB || 'https://cf-cdn-vpngate.lalifeier.eu.org/sub?token=lalifeier',
  VPNGATE_REGIONS: (process.env.VPNGATE_REGIONS || 'JP,KR,US,TH,RU')
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean),

  WG_ENDPOINT: process.env.WG_ENDPOINT || 'engage.cloudflareclient.com',
  WG_PRIVATE_KEY: process.env.WG_PRIVATE_KEY || 'YFYOAdbw1bKTHlNNi+aEjBM3BO7unuFC5rOkMRAz9XY=',
  WG_PEER_PUB_KEY: process.env.WG_PEER_PUBLIC_KEY || 'bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=',
  WG_IP6_ADDR: process.env.WG_IP6_ADDR || '2606:4700:110:8a36:df92:102a:9602:fa18',
  WG_RESERVED: process.env.WG_RESERVED || '[78, 135, 76]',

  ENABLE_LOG: process.env.ENABLE_LOG,
};

const LOG_REDIRECT_OPTION = ENV.ENABLE_LOG ? '' : '>/dev/null 2>&1 &';


// 检查关键变量
if (!ENV.UUID || !ENV.REALITY_PRIVATE || !ENV.WG_PRIVATE_KEY || !ENV.WG_PEER_PUB_KEY) {
  console.error('[FATAL] Missing required env vars');
  process.exit(1);
}

// ────────────────────────────────────────────────
// 路径 & 常量
const BIN_DIR = path.join(__dirname, 'bin');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const ARCH = process.arch === 'x64' ? 'amd64' : 'arm64';

const NEZHA_TLS_PORTS = new Set(['443', '8443', '2096', '2087', '2083', '2053']);

const BIN = {
  nezha: path.join(BIN_DIR, 'mysql'),
  cloudflared: path.join(BIN_DIR, 'nginx'),
  singbox: path.join(BIN_DIR, 'redis'),
  mihomo: path.join(BIN_DIR, 'mongod'),
};

const MIHOMO_CONFIG_FILE = path.join(BIN_DIR, 'mihomo.yaml');
const VPNGATE_PROVIDER_CACHE = path.join(BIN_DIR, 'vpngate-provider.yaml');
const MIHOMO_SOCKS_PORT = 7891;
const VPNGATE_REFRESH_SEC = 1800;
const HEALTH_CHECK_URL = 'https://www.gstatic.com/generate_204';

// 每个地区一个 socks 出站，端口在 MIHOMO_SOCKS_PORT 之后顺延
const regionSocksPort = i => MIHOMO_SOCKS_PORT + 1 + i;
// 每个地区三个协议入站，端口从 3020 起每地区 3 个
const regionInboundTags = r => {
  const p = r.toLowerCase();
  return [`vp${p}vl-in`, `vp${p}vm-in`, `vp${p}tr-in`];
};

const WS_PROXIES = [
  { suffix: 'vl', port: 3011 },
  { suffix: 'vm', port: 3012 },
  { suffix: 'tr', port: 3013 },
  { suffix: 'wgvm', port: 3014 },
  { suffix: 'wgtr', port: 3015 },
  { suffix: 'wgvl', port: 3016 },
  { suffix: 'vpvl', port: 3017 },
  { suffix: 'vpvm', port: 3018 },
  { suffix: 'vptr', port: 3019 },
  ...ENV.VPNGATE_REGIONS.flatMap((r, i) => {
    const p = r.toLowerCase();
    return [
      { suffix: `vp${p}vl`, port: 3020 + i * 3 },
      { suffix: `vp${p}vm`, port: 3021 + i * 3 },
      { suffix: `vp${p}tr`, port: 3022 + i * 3 },
    ];
  }),
];

// ────────────────────────────────────────────────
// 日志
const log = (...args) => ENV.ENABLE_LOG && console.log('[INFO]', new Date().toISOString(), ...args);
const err = (...args) => console.error('[ERROR]', new Date().toISOString(), ...args);

// ────────────────────────────────────────────────
// 工具函数
async function downloadFile(url, dest) {
  const response = await axios({ method: 'GET', url, responseType: 'stream', timeout: 60000 });
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const writer = fs.createWriteStream(dest);
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

async function isProcessRunning(binPath) {
  return new Promise(r => exec(`pgrep -x "${path.basename(binPath)}"`, (_, s) => r(!!s.trim())));
}

async function killProcess(binPath) {
  return new Promise(r => exec(`pkill -x "${path.basename(binPath)}"`, () => r()));
}

function spawnDetached(cmd, name) {
  const cp = spawn(cmd, { shell: true, detached: true, stdio: ENV.ENABLE_LOG ? 'inherit' : 'ignore' });
  cp.unref();
  log(`${name} started (PID: ${cp.pid})`);
  return cp;
}

// ────────────────────────────────────────────────
// 安装器
async function ensureInstalled(binPath, installer, name, version) {
  if (fs.existsSync(binPath)) return binPath;
  await fsExtra.ensureDir(BIN_DIR);
  await installer(binPath, version);
  await fsp.chmod(binPath, '755');
  log(`Installed ${name} ${version}`);
  return binPath;
}

async function installSingBox(binPath, version) {
  const dirName = `sing-box-${version}-linux-${ARCH}`;
  const tarName = `${dirName}.tar.gz`;
  const tarPath = path.join(BIN_DIR, tarName);
  const url = `https://github.com/SagerNet/sing-box/releases/download/v${version}/${tarName}`;

  await downloadFile(url, tarPath);
  await compressing.tgz.uncompress(tarPath, BIN_DIR);

  await fsExtra.move(path.join(BIN_DIR, dirName, 'sing-box'), binPath, { overwrite: true });

  const cronetSrc = path.join(BIN_DIR, dirName, 'libcronet.so');
  const cronetDest = path.join(BIN_DIR, 'libcronet.so');
  if (await fsExtra.pathExists(cronetSrc)) {
    await fsExtra.move(cronetSrc, cronetDest, { overwrite: true });
    log('Moved libcronet.so to bin directory');
  } else {
    log('[WARN] libcronet.so not found in release archive');
  }

  await fsExtra.remove(tarPath);
  await fsExtra.remove(path.join(BIN_DIR, dirName));
}

async function installNezha(binPath, version) {
  const url = `https://github.com/railzen/nezha-zero/releases/download/${version}/nezha-agent_linux_${ARCH}.zip`;
  const zipPath = `${binPath}.zip`;

  await downloadFile(url, zipPath);
  await compressing.zip.uncompress(zipPath, BIN_DIR);
  await fsExtra.move(path.join(BIN_DIR, 'nezha-agent'), binPath, { overwrite: true });
  await fsp.unlink(zipPath);
}

async function installCloudflared(binPath, version) {
  const url = `https://github.com/cloudflare/cloudflared/releases/download/${version}/cloudflared-linux-${ARCH}`;
  await downloadFile(url, binPath);
}

async function installMihomo(binPath, version) {
  const url = `https://github.com/MetaCubeX/mihomo/releases/download/${version}/mihomo-linux-${ARCH}-${version}.gz`;
  const gzPath = `${binPath}.gz`;

  await downloadFile(url, gzPath);
  await compressing.gzip.uncompress(gzPath, binPath);
  await fsExtra.remove(gzPath);
}

// ────────────────────────────────────────────────
// 生成 mihomo 配置（VPNGate OpenVPN 出站引擎）
function generateMihomoConfig() {
  const autoGroup = name => ({
    name,
    type: 'url-test',
    use: ['vpngate'],
    url: HEALTH_CHECK_URL,
    interval: 300,
    tolerance: 50,
    lazy: true,
  });

  const config = {
    'log-level': 'warning',
    mode: 'rule',
    'proxy-providers': {
      vpngate: {
        type: 'http',
        url: vpngateSubUrl(),
        path: VPNGATE_PROVIDER_CACHE,
        interval: VPNGATE_REFRESH_SEC,
        'health-check': { enable: false },
      },
    },
    'proxy-groups': [
      autoGroup('VPNAUTO'),
      ...ENV.VPNGATE_REGIONS.map(r => ({ ...autoGroup(`VPNAUTO-${r}`), filter: `^${r}-` })),
    ],
    listeners: [
      {
        name: 'vpngate-socks',
        type: 'socks',
        listen: '127.0.0.1',
        port: MIHOMO_SOCKS_PORT,
        proxy: 'VPNAUTO',
        udp: true,
      },
      ...ENV.VPNGATE_REGIONS.map((r, i) => ({
        name: `vpngate-socks-${r.toLowerCase()}`,
        type: 'socks',
        listen: '127.0.0.1',
        port: regionSocksPort(i),
        proxy: `VPNAUTO-${r}`,
        udp: true,
      })),
    ],
  };

  fsExtra.writeJsonSync(MIHOMO_CONFIG_FILE, config, { spaces: 2 });
  log('Mihomo config generated');
}

// ────────────────────────────────────────────────
// 生成 sing-box 配置
function generateSingBoxConfig() {
  const mux = { enabled: true, padding: true, brutal: { enabled: false, up_mbps: 1000, down_mbps: 1000 } };
  const ws = suffix => ({ type: 'ws', path: `/${ENV.WS_PATH}-${suffix}`, max_early_data: 2560, early_data_header_name: 'Sec-WebSocket-Protocol' });

  const config = {
    log: { disabled: false, level: "debug", timestamp: true },
    experimental: { cache_file: { enabled: false, store_fakeip: false } },
    dns: {
      servers: [
        { tag: "dns-direct", type: "local" },
        { tag: "dns-domestic", type: "https", server: "doh.pub", server_port: 443, path: "/dns-query", "domain_resolver": "dns-direct" },
        { tag: "dns-remote", type: "https", server: "1.1.1.1", server_port: 443, path: "/dns-query", "domain_resolver": "dns-direct" },
      ],
      rules: [{
        inbound: ["vm-wg-in", "tr-wg-in", "vl-wg-in", "vpvl-in", "vpvm-in", "vptr-in",
          ...ENV.VPNGATE_REGIONS.flatMap(regionInboundTags)],
        server: "dns-remote"
      }],
      strategy: "prefer_ipv4",
      final: "dns-domestic"
    },
    inbounds: [
      {
        type: "vless",
        tag: "xtls-reality-in",
        listen: "::",
        listen_port: 8443,
        users: [{ uuid: ENV.UUID, flow: "xtls-rprx-vision" }],
        tls: {
          enabled: true,
          server_name: ENV.TLS_SERVER,
          reality: {
            enabled: true,
            handshake: { server: ENV.TLS_SERVER, server_port: 443 },
            private_key: ENV.REALITY_PRIVATE,
            short_id: ["a1b2c3d4"]
          }
        },
        sniff: true,
        sniff_override_destination: true,
        multiplex: mux
      },
      ...WS_PROXIES.map(p => ({
        type: p.suffix.includes('vl') ? 'vless' : p.suffix.includes('vm') ? 'vmess' : 'trojan',
        tag: p.suffix.includes('wg')
          ? `${p.suffix.replace('wg', '')}-wg-in`
          : `${p.suffix}-in`,
        listen: "::",
        listen_port: p.port,
        "tcp_fast_open": false,
        "proxy_protocol": false,
        users: p.suffix.includes('tr') ? [{ password: ENV.UUID }] : [{ uuid: ENV.UUID, ...(p.suffix.includes('vm') ? { alterId: 0 } : { flow: "" }) }],
        transport: ws(p.suffix),
        sniff: true,
        sniff_override_destination: true,
        multiplex: mux,
      }))
    ],
    outbounds: [
      { type: "direct", tag: "direct", domain_resolver: { server: "dns-direct", strategy: 'prefer_ipv4' } },
      { "type": "block", "tag": "block" },
      { type: "socks", tag: "tor", server: "127.0.0.1", server_port: 9050, domain_resolver: { server: "dns-direct", strategy: 'prefer_ipv4' } },
      { type: "socks", tag: "vpngate", server: "127.0.0.1", server_port: MIHOMO_SOCKS_PORT },
      ...ENV.VPNGATE_REGIONS.map((r, i) => ({
        type: "socks", tag: `vpngate-${r.toLowerCase()}`, server: "127.0.0.1", server_port: regionSocksPort(i)
      }))
    ],
    endpoints: [{
      type: "wireguard",
      tag: "wg-ep",
      system: false,
      name: "wg0",
      address: ["172.16.0.2/32", `${ENV.WG_IP6_ADDR}/128`],
      private_key: ENV.WG_PRIVATE_KEY,
      listen_port: 10000,
      peers: [{
        address: ENV.WG_ENDPOINT,
        port: 2408,
        public_key: ENV.WG_PEER_PUB_KEY,
        reserved: JSON.parse(ENV.WG_RESERVED),
        allowed_ips: ["0.0.0.0/0", "::/0"],
        persistent_keepalive_interval: 30
      }],
      mtu: 1280
    }],
    route: {
      final: "direct",
      default_domain_resolver: "dns-direct",
      rules: [
        { inbound: ["vm-wg-in", "tr-wg-in", "vl-wg-in"], outbound: "wg-ep" },
        { inbound: ["vpvl-in", "vpvm-in", "vptr-in"], outbound: "vpngate" },
        ...ENV.VPNGATE_REGIONS.map(r => ({
          inbound: regionInboundTags(r), outbound: `vpngate-${r.toLowerCase()}`
        })),
        { rule_set: "geosite-tor", outbound: "tor" },
        { rule_set: ["geosite-openai", "geosite-netflix"], outbound: "wg-ep" },
        { rule_set: "geosite-disney", outbound: "wg-ep" }
      ],
      rule_set: [
        { tag: "geosite-openai", type: "remote", format: "binary", url: "https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@sing/geo/geosite/openai.srs", download_detour: "direct" },
        { tag: "geosite-netflix", type: "remote", format: "binary", url: "https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@sing/geo/geosite/netflix.srs", download_detour: "direct" },
        { tag: "geosite-disney", type: "remote", format: "binary", url: "https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@sing/geo/geosite/disney.srs", download_detour: "direct" },
        { tag: "geosite-tor", type: "remote", format: "binary", url: "https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@sing/geo/geosite/tor.srs", download_detour: "direct" }
      ]
    }
  };

  fsExtra.writeJsonSync(CONFIG_FILE, config, { spaces: 2 });
  log('Config generated');
}

// ────────────────────────────────────────────────
// VPNGate 订阅地址（带上要暴露的地区）
function vpngateSubUrl() {
  const url = new URL(ENV.VPNGATE_SUB);
  if (ENV.VPNGATE_REGIONS.length) {
    url.searchParams.set('country', ENV.VPNGATE_REGIONS.join(','));
  }
  return url.toString();
}

// ────────────────────────────────────────────────
// 服务启动
async function startNezha() {
  if (!ENV.NEZHA_SERVER || !ENV.NEZHA_KEY) return;
  await ensureInstalled(BIN.nezha, installNezha, 'nezha-agent', VERSIONS.NEZHA_AGENT);
  if (await isProcessRunning(BIN.nezha)) {
    await killProcess(BIN.nezha);
  }

  // const configPath = path.join(BIN_DIR, 'nezha-config.yml');
  // const tls = NEZHA_TLS_PORTS.has(ENV.NEZHA_PORT);
  // const yml = [
  //   `server: ${ENV.NEZHA_SERVER}:${ENV.NEZHA_PORT}`,
  //   `client_secret: ${ENV.NEZHA_KEY}`,
  //   `tls: ${tls}`,
  //   `disable_auto_update: true`,
  //   `report_delay: 3`,
  //   `skip_connection_count: true`,
  //   `skip_procs_count: true`,
  //   `debug: false`,
  //   `disable_command_execute: false`,
  //   `disable_force_update: false`,
  //   `disable_nat: false`,
  //   `disable_send_query: false`,
  //   `gpu: false`,
  //   `insecure_tls: false`,
  //   `ip_report_period: 1800`,
  //   `temperature: false`,
  //   `use_gitee_to_upgrade: false`,
  //   `use_ipv6_country_code: false`,
  // ].join('\n');

  // await fsp.writeFile(configPath, yml);
  // spawnDetached(`${BIN.nezha} -c ${configPath}`, 'nezha');

  let NEZHA_TLS = "";
  if (["443", "8443", "2096", "2087", "2083", "2053"].includes(ENV.NEZHA_PORT)) {
    NEZHA_TLS = "--tls";
  }

  log((`${BIN.nezha} -s ${ENV.NEZHA_SERVER}:${ENV.NEZHA_PORT} -p ${ENV.NEZHA_KEY} ${NEZHA_TLS} --disable-auto-update --report-delay=3 --skip-conn --skip-procs -d`))

  spawnDetached(`${BIN.nezha} -s ${ENV.NEZHA_SERVER}:${ENV.NEZHA_PORT} -p ${ENV.NEZHA_KEY} ${NEZHA_TLS} --disable-auto-update --report-delay=3 --skip-conn --skip-procs -d ${LOG_REDIRECT_OPTION}`, 'nezha')
}

async function startCloudflared() {
  if (!ENV.CF_TOKEN) return;
  await ensureInstalled(BIN.cloudflared, installCloudflared, 'cloudflared', VERSIONS.CLOUDFLARED);
  if (await isProcessRunning(BIN.cloudflared)) {
    await killProcess(BIN.cloudflared);
  }

  spawnDetached(`${BIN.cloudflared} tunnel --edge-ip-version auto --protocol http2 run --token ${ENV.CF_TOKEN} ${LOG_REDIRECT_OPTION}`, 'cloudflared');
}

async function startMihomo() {
  if (!ENV.VPNGATE_SUB) return;
  await ensureInstalled(BIN.mihomo, installMihomo, 'mihomo', VERSIONS.MIHOMO);
  generateMihomoConfig();
  if (await isProcessRunning(BIN.mihomo)) {
    await killProcess(BIN.mihomo);
  }

  spawnDetached(`${BIN.mihomo} -d ${BIN_DIR} -f ${MIHOMO_CONFIG_FILE} ${LOG_REDIRECT_OPTION}`, 'mihomo');
}

async function startSingBox() {
  await ensureInstalled(BIN.singbox, installSingBox, 'sing-box', VERSIONS.SING_BOX);
  generateSingBoxConfig();
  if (await isProcessRunning(BIN.singbox)) {
    await killProcess(BIN.singbox);
  }

  spawnDetached(`${BIN.singbox} run -c ${CONFIG_FILE} ${LOG_REDIRECT_OPTION}`, 'sing-box');
}

// ────────────────────────────────────────────────
// Fastify WS 代理
for (const { suffix, port } of WS_PROXIES) {
  const prefix = `/${ENV.WS_PATH}-${suffix}`;
  fastify.register(proxy, {
    upstream: `http://127.0.0.1:${port}`,
    prefix,
    rewritePrefix: prefix,
    websocket: true,
  });
}

// ────────────────────────────────────────────────
// 订阅路由
const SUB_TTL = 5 * 60 * 1000;
let subCache = { content: null, ts: 0 };

const PREFER_DOMAINS = [
  "www.visa.com.hk", "www.visa.cn", "www.mastercard.com.hk", "www.paypal.com",
  "ip.sb", "time.is", "speed.cloudflare.com", "www.udemy.com",
  "www.shopify.com", "www.vimeo.com", "www.digitalocean.com",
  "icook.tw", "www.skyscanner.jp", "singapore.com", "japan.com", "www.hktv.com.hk",
  "dash.cloudflare.com", "workers.dev", "pages.dev", "cdnjs.cloudflare.com",
  "www.who.int", "www.un.org", "www.csgo.com", "update.microsoft.com", "gateway.icloud.com"
];

fastify.get('/sub', async (req, reply) => {
  if (req.query.token !== ENV.AUTH_TOKEN) {
    return reply.code(403).send({ error: 'Forbidden' });
  }

  const SUB_TTL = 5 * 60 * 1000;
  if (subCache.content && Date.now() - subCache.ts < SUB_TTL) {
    return reply.type('text/plain; charset=utf-8').send(subCache.content);
  }

  const host = (ENV.DOMAIN ? ENV.DOMAIN.split(',')[0] : req.hostname);
  const { UUID, WS_PATH } = ENV;
  const nodes = [];

  const realityQs = new URLSearchParams({
    encryption: 'none',
    security: 'reality',
    sni: ENV.TLS_SERVER || 'addons.mozilla.org',
    fp: 'chrome',
    pbk: ENV.REALITY_PUBLIC,
    sid: 'a1b2c3d4',
    type: 'tcp',
    flow: 'xtls-rprx-vision'
  }).toString();
  // nodes.push(`vless://${UUID}@${host}:8443?${realityQs}#${host}-REALITY-直连`);

  const selectedPrefers = PREFER_DOMAINS
    .sort(() => Math.random() - 0.5)
    .slice(0, 6);

  const addressPool = [host, ...selectedPrefers];

  const vlessQs = (suffix) => new URLSearchParams({
    encryption: 'none',
    security: 'tls',
    sni: host,
    type: 'ws',
    host: host,
    path: `/${WS_PATH}-${suffix}`
  }).toString();

  const trojanQs = (suffix) => new URLSearchParams({
    security: 'tls',
    sni: host,
    type: 'ws',
    host: host,
    path: `/${WS_PATH}-${suffix}`
  }).toString();

  const getVmess = (addr, tag, suffix, extra = '') => {
    const vmessObj = {
      v: '2',
      ps: `${addr}-VMESS${extra}-${tag}`,
      add: addr,
      port: '443',
      id: UUID,
      aid: '0',
      scy: 'auto',
      net: 'ws',
      type: 'none',
      host: host,
      path: `/${WS_PATH}-${suffix}`,
      tls: 'tls',
      sni: host
    };
    return `vmess://${Buffer.from(JSON.stringify(vmessObj)).toString('base64')}`;
  };

  addressPool.forEach(addr => {
    const tag = addr === host ? '直连' : '优选';

    nodes.push(`vless://${UUID}@${addr}:443?${vlessQs('vl')}#${addr}-VLESS-${tag}`);
    nodes.push(`vless://${UUID}@${addr}:443?${vlessQs('wgvl')}#${addr}-VLESS-WARP-${tag}`);
    nodes.push(`vless://${UUID}@${addr}:443?${vlessQs('vpvl')}#${addr}-VLESS-VPNGate-${tag}`);
    nodes.push(`trojan://${UUID}@${addr}:443?${trojanQs('tr')}#${addr}-Trojan-${tag}`);
    nodes.push(`trojan://${UUID}@${addr}:443?${trojanQs('wgtr')}#${addr}-Trojan-WARP-${tag}`);
    nodes.push(`trojan://${UUID}@${addr}:443?${trojanQs('vptr')}#${addr}-Trojan-VPNGate-${tag}`);
    nodes.push(getVmess(addr, tag, 'vm'));
    nodes.push(getVmess(addr, tag, 'wgvm', '-WARP'));
    nodes.push(getVmess(addr, tag, 'vpvm', '-VPNGate'));
  });

  // 地区节点只走直连域名，避免和优选域名相乘导致节点数爆炸
  for (const region of ENV.VPNGATE_REGIONS) {
    const p = region.toLowerCase();
    const tag = `VPNGate-${region}`;

    nodes.push(`vless://${UUID}@${host}:443?${vlessQs(`vp${p}vl`)}#${host}-VLESS-${tag}`);
    nodes.push(`trojan://${UUID}@${host}:443?${trojanQs(`vp${p}tr`)}#${host}-Trojan-${tag}`);
    nodes.push(getVmess(host, tag, `vp${p}vm`));
  }

  const finalContent = nodes.sort(() => Math.random() - 0.5).join('\n');

  subCache = {
    content: Buffer.from(finalContent).toString('base64'), // 标准 Base64 编码
    ts: Date.now()
  };

  return reply.type('text/plain; charset=utf-8').send(subCache.content);
});

async function cleanupArtifacts() {
  log('Cleaning up bin files and config...');
  await Promise.allSettled([
    fsExtra.remove(BIN_DIR),
    fsExtra.remove(CONFIG_FILE),
  ]);
  log('Cleanup done.');
}

async function shutdown(signal) {
  log(`Received ${signal}, shutting down...`);
  await Promise.all([
    killProcess(BIN.singbox),
    killProcess(BIN.cloudflared),
    killProcess(BIN.nezha),
    killProcess(BIN.mihomo),
  ]);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ────────────────────────────────────────────────
// 主函数
async function main() {
  try {
    await Promise.all([startNezha(), startCloudflared(), startMihomo()]);
    await startSingBox();

    fastify.get("/", async (request, reply) => {
      return { hello: "world" };
    });


    await new Promise(r => exec(`fuser -k ${ENV.PORT}/tcp 2>/dev/null; true`, () => r()));
    await fastify.listen({ port: ENV.PORT, host: '0.0.0.0' });
    log(`Listening on :${ENV.PORT}`);


    // await cleanupArtifacts();
  } catch (e) {
    err('Startup failed:', e.message);
    process.exit(1);
  }
}

main().catch(e => { err('Fatal:', e); process.exit(1); });
