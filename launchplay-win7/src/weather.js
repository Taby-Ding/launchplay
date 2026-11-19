'use strict';
/**
 * weather.js —— 左上角天气（主进程）
 *
 * 渲染层有严格的 CSP（default-src 'self'），外部请求一律由主进程代发，
 * 再通过 IPC 把结果交给界面，避免放开 connect-src。
 *
 * 城市：内置全国 34 个省级行政区 / 369 个城市的两级编码表（weather-cities.js，
 * 由 tools/build-weather-cities.js 从中国天气网公开编码生成），运行时完全离线，
 * 界面用「先选省份、再选城市」两级下拉，不依赖任何城市搜索服务。
 *
 * 数据源：
 *   1) 中国天气网 d1 实时接口（按 9 位城市编码，国内直连约 1 秒，含天气现象 / 气温）
 *   2) ipwho.is —— 自动定位；定位到未收录城市时用 Open-Meteo 按经纬度补充
 *   3) 全部失败回落北京实况
 * 结果缓存 30 分钟；全部失败时界面隐藏天气，不弹错误、不影响主功能。
 */

const https = require('https');
const CITY_DATA = require('./weather-cities');

const CACHE_MS = 30 * 60 * 1000;
// 所有外部请求都设硬超时，宁可这次不显示，也不让界面干等
const REQ_TIMEOUT = 3500;

/** 中文城市名 -> 9 位编码（自动定位时用；同名取第一个） */
const NAME_TO_CODE = {};
/** 9 位编码 -> 中文城市名（设置面板显示当前值用） */
const CITY_NAMES = {};
for (const p of CITY_DATA.provinces) {
  for (const c of p.cities) {
    const n = String(c.name).replace(/[市区县]$/, '');
    if (!NAME_TO_CODE[n]) NAME_TO_CODE[n] = c.code;
    CITY_NAMES[c.code] = c.name;
  }
}

const EN_TO_CN = {
  Beijing: '北京', Shanghai: '上海', Guangzhou: '广州', Shenzhen: '深圳',
  Hangzhou: '杭州', Nanjing: '南京', Suzhou: '苏州', Chengdu: '成都',
  Chongqing: '重庆', Wuhan: '武汉', 'Xi\'an': '西安', Tianjin: '天津',
  Changsha: '长沙', Zhengzhou: '郑州', Jinan: '济南', Qingdao: '青岛',
  Shenyang: '沈阳', Dalian: '大连', Harbin: '哈尔滨', Changchun: '长春',
  Shijiazhuang: '石家庄', Taiyuan: '太原', Kunming: '昆明', Guiyang: '贵阳',
  Nanning: '南宁', Haikou: '海口', Fuzhou: '福州', Xiamen: '厦门',
  Nanchang: '南昌', Hefei: '合肥', Lanzhou: '兰州', Urumqi: '乌鲁木齐',
};

/** WMO weather code -> [中文描述, 图标]（Open-Meteo 用） */
const WMO = {
  0: ['晴', '☀️'], 1: ['晴间多云', '🌤️'], 2: ['多云', '⛅'], 3: ['阴', '☁️'],
  45: ['雾', '🌫️'], 48: ['雾凇', '🌫️'],
  51: ['毛毛雨', '🌦️'], 53: ['小雨', '🌦️'], 55: ['细雨', '🌦️'],
  56: ['冻雨', '🌧️'], 57: ['冻雨', '🌧️'],
  61: ['小雨', '🌦️'], 63: ['中雨', '🌧️'], 65: ['大雨', '🌧️'],
  66: ['冻雨', '🌧️'], 67: ['冻雨', '🌧️'],
  71: ['小雪', '🌨️'], 73: ['中雪', '❄️'], 75: ['大雪', '❄️'], 77: ['米雪', '❄️'],
  80: ['阵雨', '🌦️'], 81: ['阵雨', '🌧️'], 82: ['强阵雨', '🌧️'],
  85: ['阵雪', '🌨️'], 86: ['强阵雪', '❄️'],
  95: ['雷雨', '⛈️'], 96: ['雷雨伴冰雹', '⛈️'], 99: ['强雷雨', '⛈️'],
};

/** 中文天气现象 -> 图标 */
function iconOfCn(text) {
  if (!text) return '🌡️';
  if (/雷|冰雹/.test(text)) return '⛈️';
  if (/雪/.test(text)) return '❄️';
  if (/暴雨|大雨|中雨/.test(text)) return '🌧️';
  if (/雨/.test(text)) return '🌦️';
  if (/雾|霾|沙尘/.test(text)) return '🌫️';
  if (/阴/.test(text)) return '☁️';
  if (/多云/.test(text)) return '⛅';
  if (/晴/.test(text)) return '☀️';
  return '🌡️';
}

/**
 * 带硬超时的 HTTPS GET（socket timeout 管不到 DNS / TLS 握手，用独立定时器兜底）。
 * @returns {Promise<string|null>} 响应文本
 */
function fetchRaw(url, timeout = REQ_TIMEOUT, extraHeaders = {}) {
  return new Promise((resolve) => {
    let done = false;
    let hardTimer = null;
    const finish = (v) => { if (!done) { done = true; if (hardTimer) clearTimeout(hardTimer); resolve(v); } };
    let req;
    try {
      hardTimer = setTimeout(() => {
        try { req && req.destroy(); } catch { /* ignore */ }
        finish(null);
      }, timeout);
      req = https.get(url, {
        timeout,
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json, text/plain, */*', ...extraHeaders },
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
          return fetchRaw(res.headers.location, timeout, extraHeaders).then(finish);
        }
        let s = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { s += d; if (s.length > 256 * 1024) { try { req.destroy(); } catch {} finish(null); } });
        res.on('end', () => finish(res.statusCode === 200 ? s : null));
      });
    } catch { return finish(null); }
    req.on('error', () => finish(null));
    req.on('timeout', () => { try { req.destroy(); } catch {} finish(null); });
  });
}

async function fetchJson(url, timeout = REQ_TIMEOUT) {
  const txt = await fetchRaw(url, timeout);
  if (!txt) return null;
  try { return JSON.parse(txt); } catch { return null; }
}

/** 主源：中国天气网实时接口（var dataSK={...}），国内直连快、含天气现象 */
async function fromWeatherComCn(code, fallbackName) {
  if (!/^\d{9}$/.test(String(code || ''))) return null;
  const txt = await fetchRaw(`https://d1.weather.com.cn/sk_2d/${code}.html`, 3000, {
    Referer: 'https://www.weather.com.cn/',
  });
  if (!txt) return null;
  const i = txt.indexOf('{');
  if (i < 0) return null;
  let w;
  try { w = JSON.parse(txt.slice(i).trim().replace(/;\s*$/, '')); } catch { return null; }
  const temp = parseFloat(w.temp);
  if (!Number.isFinite(temp)) return null;
  const text = (w.weather || (w.WD ? `${w.WD} ${w.WS || ''}`.trim() : '实况')).slice(0, 12);
  return {
    ok: true,
    city: w.cityname || fallbackName || CITY_NAMES[code] || '本地',
    text,
    icon: iconOfCn(w.weather),
    temp: Math.round(temp),
  };
}

/** 补充源：Open-Meteo 按经纬度（自动定位到未收录城市时用） */
async function fromOpenMeteo(lat, lon, name) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&current=temperature_2m,weather_code&timezone=auto`;
  const j = await fetchJson(url);
  if (!j || !j.current || typeof j.current.temperature_2m !== 'number') return null;
  const [text, icon] = WMO[Number(j.current.weather_code)] || ['实况', '🌡️'];
  return { ok: true, city: name || '本地', text, icon, temp: Math.round(j.current.temperature_2m) };
}

/** 自动定位：优先把定位结果映射到内置城市编码，拿不到就保留经纬度 */
async function resolveAuto() {
  const j = await fetchJson('https://ipwho.is/', 2500);
  if (j && j.success !== false && typeof j.latitude === 'number' && typeof j.longitude === 'number') {
    const raw = String(j.city || '');
    const cn = EN_TO_CN[raw] || raw;
    const code = NAME_TO_CODE[cn.replace(/[市区县]$/, '')];
    return { code, name: cn || '本地', lat: j.latitude, lon: j.longitude };
  }
  return { code: '', name: '本地', lat: 0, lon: 0 };
}

const BEIJING = '101010100';
let cache = null; // { key, at, data }

/**
 * @param {string} cityId 'auto' 或 9 位城市编码
 * @param {boolean} force 忽略缓存
 */
async function getWeather(cityId, force = false) {
  const key = String(cityId || 'auto');
  if (!force && cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.data;

  let data = null;
  if (key === 'auto') {
    const loc = await resolveAuto();
    if (loc.code) data = await fromWeatherComCn(loc.code, loc.name);
    if (!data) data = await fromOpenMeteo(loc.lat, loc.lon, loc.name);
  } else {
    data = await fromWeatherComCn(key, CITY_NAMES[key]);
  }
  // 兜底：北京的国内实时数据，保证绝大多数情况下界面有内容
  if (!data) data = await fromWeatherComCn(BEIJING, '北京');
  if (!data) return { ok: false, error: '天气暂不可用' };
  cache = { key, at: Date.now(), data };
  return data;
}

module.exports = {
  getWeather,
  /** 省 / 市两级列表，供设置面板渲染下拉框 */
  PROVINCES: CITY_DATA.provinces,
  /** 编码 -> 城市名，供设置面板显示当前值 */
  CITY_NAMES,
};
