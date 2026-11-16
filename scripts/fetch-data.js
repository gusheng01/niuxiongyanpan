// scripts/fetch-data.js
async function fetchTencentIndex(code) {
  const res = await fetch(`https://qt.gtimg.cn/q=${code}`);
  const buf = await res.arrayBuffer();
  const text = new TextDecoder('gbk').decode(buf);
  const m = text.match(/="(.+)"/);
  if (!m) return null;
  const f = m[1].split('~');
  if (f.length < 47) return null;
  return { name: f[1], price: parseFloat(f[3]), changePct: parseFloat(f[32]), amount: parseFloat(f[37]) / 10000, pe: parseFloat(f[39]), pb: parseFloat(f[46]), time: f[30] };
}
async function fetchKline(tc, days) {
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - days * 2 * 86400000).toISOString().slice(0, 10);
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${tc},day,${start},${end},2000,qfq`;
  const res = await fetch(url);
  const text = await res.text();
  const m = text.match(/min_data\s*=\s*\(([\s\S]*)\)\s*;?/);
  const json = JSON.parse(m ? m[1] : text);
  const d = json.data && json.data[tc];
  if (!d) return [];
  const raw = d.qfqday || d.day || [];
  return raw.map(r => ({ date: r[0], close: parseFloat(r[2]) }));
}
async function fetchMargin() {
  try {
    const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_WEB_RZRQ_GGMX&columns=ALL&pageSize=1&sortColumns=DATE&sortTypes=-1';
    const res = await fetch(url);
    const json = await res.json();
    if (json.result && json.result.data && json.result.data.length > 0) {
      const row = json.result.data[0];
      return { balance: (row.RZRQYE || row.RZYE) / 1e12, date: row.DATE ? row.DATE.slice(0, 10) : '' };
    }
  } catch (e) {}
  return null;
}
async function fetchHS300Stats() {
  try {
    const url = 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=300&po=1&np=1&fltt=2&invt=2&fid=f3&fs=b:MK0300&fields=f12,f14,f2,f3,f39,f46';
    const res = await fetch(url);
    const json = await res.json();
    if (!json.data || !json.data.diff) return null;
    const list = json.data.diff;
    let total = 0, broken = 0;
    const peList = [];
    list.forEach(it => {
      const pb = parseFloat(it.f46); const pe = parseFloat(it.f39);
      if (!isNaN(pb) && pb > 0) { total++; if (pb < 1) broken++; }
      if (!isNaN(pe) && pe > 0) peList.push(pe);
    });
    peList.sort((a, b) => a - b);
    return { peMedian: peList.length > 0 ? peList[Math.floor(peList.length / 2)] : null, brokenRate: total > 0 ? (broken / total * 100) : null };
  } catch (e) { return null; }
}
function avg(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function calcScore(sh, klines, hs300, margin, amount) {
  let valuation = 50;
  if (sh.pe && sh.pe > 0) { if (sh.pe <= 12) valuation = 85; else if (sh.pe <= 15) valuation = 70; else if (sh.pe <= 18) valuation = 55; else if (sh.pe <= 22) valuation = 40; else valuation = 25; }
  if (hs300 && hs300.peMedian) { if (hs300.peMedian <= 10) valuation = Math.min(95, valuation + 10); else if (hs300.peMedian >= 20) valuation = Math.max(10, valuation - 10); }
  let capital = 45;
  if (margin && margin.balance) { if (margin.balance >= 2.5) capital = 60; else if (margin.balance >= 2.3) capital = 50; else if (margin.balance >= 2.0) capital = 40; else capital = 30; }
  if (amount >= 1.5) capital = Math.min(90, capital + 15); else if (amount >= 1.0) capital = Math.min(90, capital + 5); else if (amount < 0.8) capital = Math.max(10, capital - 10);
  let sentiment = 50;
  if (amount >= 1.5) sentiment = 70; else if (amount >= 1.0) sentiment = 55; else if (amount >= 0.8) sentiment = 45; else sentiment = 30;
  let technical = 30;
  if (klines.length >= 250) {
    const closes = klines.map(k => k.close); const cur = closes[closes.length - 1];
    const ma20 = avg(closes.slice(-20)); const ma250 = avg(closes.slice(-250));
    if (cur > ma20) technical += 20; if (cur > ma250) technical += 30; if (ma20 > ma250) technical += 20;
  } else if (klines.length >= 20) {
    const closes = klines.map(k => k.close); const cur = closes[closes.length - 1]; const ma20 = avg(closes.slice(-20)); if (cur > ma20) technical += 30;
  }
  const total = Math.round(valuation * 0.3 + capital * 0.25 + sentiment * 0.25 + technical * 0.2);
  let positionRange;
  if (total < 30) positionRange = [60, 80]; else if (total < 55) positionRange = [40, 60]; else if (total < 70) positionRange = [30, 50]; else if (total < 85) positionRange = [20, 40]; else positionRange = [0, 20];
  return { valuation: Math.round(valuation), capital: Math.round(capital), sentiment: Math.round(sentiment), technical: Math.round(technical), total: Math.max(0, Math.min(100, total)), positionRange };
}
async function main() {
  const indexCodes = { sh000001: '上证指数', sh000300: '沪深300', sh000905: '中证500', sz399006: '创业板指', sh000688: '科创50' };
  const indices = {};
  for (const code of Object.keys(indexCodes)) {
    const d = await fetchTencentIndex(code);
    if (d) { indices[code] = { name: d.name || indexCodes[code], price: d.price, changePct: d.changePct, time: d.time }; }
    await new Promise(r => setTimeout(r, 300));
  }
  const sh = await fetchTencentIndex('sh000001');
  const klines = await fetchKline('sh000001', 400);
  const hs300 = await fetchHS300Stats();
  const margin = await fetchMargin();
  const amount = sh ? sh.amount : 0;
  const score = calcScore(sh, klines, hs300, margin, amount);
  const now = new Date(); const beijing = new Date(now.getTime() + 8 * 3600 * 1000); const dateStr = beijing.toISOString().slice(0, 10);
  const snapshot = {
    date: dateStr, updatedAt: beijing.toISOString().replace('Z', '+08:00'), source: 'auto',
    marketScore: score.total, positionRange: score.positionRange, stopLoss: 3600, takeProfitScore: 70,
    fourDim: { valuation: score.valuation, capital: score.capital, sentiment: score.sentiment, technical: score.technical },
    indices,
    signals: { turnover: amount > 0 ? amount.toFixed(2) + '万亿' : null, brokenNet: hs300 && hs300.brokenRate != null ? hs300.brokenRate.toFixed(2) + '%' : null, marginBalance: margin && margin.balance ? margin.balance.toFixed(2) + '万亿' : null, marginDate: margin ? margin.date : null, hs300PeMedian: hs300 ? hs300.peMedian : null, scoreTake: score.total }
  };
  const fs = await import('fs');
  fs.writeFileSync('data/market-snapshot.json', JSON.stringify(snapshot, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
