'use strict';
/**
 * build-weather-cities.js —— 生成 src/weather-cities.js
 *
 * 数据来源：中国天气网公开的城市编码三级接口（免费、无需密钥）
 *   省      https://www.weather.com.cn/data/city3jdata/china.html
 *   省→市   https://www.weather.com.cn/data/city3jdata/provshi/<省码>.html
 *   市→站   https://www.weather.com.cn/data/city3jdata/station/<7位市码>.html
 * 最终拼出 9 位城市编码（例：10128 广东 + 06 + 01 = 101280601 深圳），
 * 与 d1.weather.com.cn/sk_2d/<9位>.html 实况接口使用的编码完全一致。
 *
 * 生成结果会被提交进仓库，运行时不再请求这些接口；需要更新数据时重跑本脚本即可：
 *   node tools/build-weather-cities.js
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const BASE = 'https://www.weather.com.cn/data/city3jdata/';

function get(file) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const fin = (v) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(v);
    };
    let req;
    try {
      req = https.get(BASE + file, {
        timeout: 6000,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Referer: 'https://www.weather.com.cn/',
          Accept: '*/*',
        },
      }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return fin(null); }
        let s = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { s += d; });
        res.on('end', () => fin(s));
      });
    } catch { return fin(null); }
    req.on('error', () => fin(null));
    req.on('timeout', () => { try { req.destroy(); } catch {} fin(null); });
    timer = setTimeout(() => { try { req.destroy(); } catch {} fin(null); }, 7000);
  });
}

function parse(txt) {
  if (!txt) return null;
  try { const v = JSON.parse(txt); return v && typeof v === 'object' ? v : null; }
  catch { return null; }
}

/** 简单并发池，避免把对方接口打爆 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

/**
 * 四个直辖市的 provshi 返回 {"00": "北京"}，但 d1 实况接口用的是 101010100
 * 这种结构，两套编码对不上；这 4 个直接用已验证过的实况编码。
 */
const DIRECT_CITIES = {
  '10101': [{ name: '北京', code: '101010100' }],
  '10102': [{ name: '上海', code: '101020100' }],
  '10103': [{ name: '天津', code: '101030100' }],
  '10104': [{ name: '重庆', code: '101040100' }],
};

async function main() {
  const china = parse(await get('china.html'));
  if (!china) throw new Error('省级列表获取失败');
  console.log('省级行政区:', Object.keys(china).length);

  const provinces = [];
  for (const [pcode, pname] of Object.entries(china)) {
    if (DIRECT_CITIES[pcode]) {
      provinces.push({ name: String(pname), cities: DIRECT_CITIES[pcode] });
      console.log(`  ${pname}: 1 个城市 (直辖市)`);
      continue;
    }

    const cityMap = parse(await get(`provshi/${pcode}.html`)) || {};
    const entries = Object.entries(cityMap).sort((a, b) => a[0].localeCompare(b[0]));
    const groups = await mapLimit(entries, 10, async ([ccode, cname]) => {
      const c7 = `${pcode}${ccode}`;
      const stations = parse(await get(`station/${c7}.html`));
      if (!stations) return [];
      const keys = Object.keys(stations);

      // 海南等少数省份：station 直接返回完整的 9 位码 -> 名称，整省城市都在这一份里。
      // 这批码不一定都以当前 c7 开头（三亚是 101310201 而 c7 是 1013101），
      // 因此这里按「全省全码列表」整体展开，后面按 code 去重即可。
      const full = keys.filter((k) => /^\d{9}$/.test(k));
      if (full.length) return full.map((k) => ({ name: String(stations[k]), code: k }));

      // 常规省份：接口 JSON 的键顺序不保证（可能 10、11… 在前，01 在后），
      // 所以不能取 Object.keys()[0]，必须优先 01，否则会把「新津」当成成都。
      const short = keys.filter((k) => /^\d{1,2}$/.test(k)).sort((a, b) => Number(a) - Number(b));
      const stationCode = stations['01'] ? '01' : short[0];
      if (!stationCode) return [];
      return [{ name: String(cname), code: `${c7}${stationCode.padStart(2, '0')}` }];
    });

    // 同一个 9 位码可能被多个市重复引用（如海南的展开结果），去重
    const seen = new Set();
    const valid = groups.flat().filter((c) => {
      if (!c || !c.name || !/^\d{9}$/.test(c.code) || seen.has(c.code)) return false;
      seen.add(c.code);
      return true;
    });
    if (valid.length) provinces.push({ name: String(pname), cities: valid });
    console.log(`  ${pname}: ${valid.length} 个城市`);
  }

  const total = provinces.reduce((n, p) => n + p.cities.length, 0);
  if (total < 200) throw new Error(`抓到的城市数偏少 (${total})，请检查网络或接口变更，未写入文件`);

  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const body = provinces.map((p) =>
    `  { name: '${esc(p.name)}', cities: [${p.cities.map((c) => `{ name: '${esc(c.name)}', code: '${c.code}' }`).join(', ')}] },`
  ).join('\n');

  const out = `'use strict';
/**
 * weather-cities.js —— 全国省 / 市两级天气城市编码表（自动生成，请勿手改）
 *
 * 由 tools/build-weather-cities.js 从中国天气网公开编码接口生成。
 * 9 位 code 直接用于 d1.weather.com.cn/sk_2d/<code>.html 实况接口。
 * 运行时完全离线，不依赖任何外部城市检索服务。
 */
module.exports = {
  provinces: [
${body}
  ],
};
`;
  const dest = path.join(__dirname, '..', 'src', 'weather-cities.js');
  fs.writeFileSync(dest, out, 'utf8');
  console.log(`\n已写入 ${dest}`);
  console.log(`共 ${provinces.length} 个省级行政区 / ${total} 个城市, ${Buffer.byteLength(out)} 字节`);
}

main().catch((e) => { console.error('生成失败:', e.message); process.exit(1); });
