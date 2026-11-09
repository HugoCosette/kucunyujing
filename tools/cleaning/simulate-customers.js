/**
 * 出入库明细「客户」模拟列（只用于测试 / 演示数据）
 * ==================================================================
 * 清洗口径本身不在这里：本脚本只给明细表补一列「客户」，供
 * tools/cleaning/engine.mjs 的 `{ field: '客户', as: '动销客户', agg: 'distinct' }` 去重计数。
 *
 * 造数规律（对齐「热销品」的真实形态）：
 *   1. 客户按「单号」赋值：一张销售单只有一个客户，同单的多行 SKU 共用该客户；
 *      「加工出库」的往来单位是加工厂（染整 / 定型 / 印花…），「销售退货*」整列留空。
 *   2. 去重客户数随订单数次线性增长：1~2 单 → 1 个客户；3~4 单 → 2 个；
 *      之后 ≈ round(订单数^0.58)（22 单 ≈ 6 个、143 单 ≈ 18 个、上千单上百个，上限 200）。
 *   3. 一个 SKU 多出来的订单不会平均分给所有客户，而是按客户热度重复购买，
 *      热销品由少数大客户反复下单，冷门品只有一个客户。
 *   4. 客户带品名偏好：大贸易商横跨全部品名，小客户只买 1~2 个品名；
 *      两到四成客户只出现在一个 SKU 上。
 *   5. 固定随机种子，重跑结果完全一致；除新增的「客户」列外不改任何单元格。
 *
 * 用法：
 *   node simulate-customers.js                       # 就地写回演示数据（先写 .tmp 再替换）
 *   node simulate-customers.js <输入.xlsx> [输出.xlsx]
 *   node simulate-customers.js --seed 20261109 --customers 1100
 *   node simulate-customers.js --dry-run             # 只打印统计，不写文件
 */

const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const { unzipSync, zipSync } = require("fflate");

const DEFAULT_FILE = path.join(
  __dirname,
  "..",
  "..",
  "docs",
  "测试数据",
  "演示数据",
  "出入库明细（销售+加工）_演示数据.xlsx",
);

// 客户单据类型 / 非客户单据类型（退货不记客户）
const CUSTOMER_SOURCES = new Set(["销售单", "销售出库"]);
// 加工出库的往来单位是加工厂（染整 / 定型 / 印花…），同样要填，否则「订单总数 > 0 但动销客户 = 0」
const PROCESSING_SOURCE = "加工出库";
const FACTORY_KINDS = ["染整厂", "定型厂", "印花厂", "复合厂", "涂层厂", "水洗厂", "后整理厂"];

// 这几列原始导出带数字格式；SheetJS 默认读/写会丢掉 .z，这里按列补回，避免日期变成 46078、数量带小数点
const COLUMN_FORMATS = new Map([
  ["做账日期", "m/d/yy"],
  ["入库条数", "0.##"],
  ["入库数量", "0.##"],
  ["出库条数", "0.##"],
  ["出库数量", "0.##"],
]);

// 列宽（沿用原始导出模板），只在文件没有 !cols 时兜底
const COLUMN_WIDTHS = new Map([
  ["做账日期", 10.18],
  ["单号", 16.55],
  ["来源单据", 11.55],
  ["品名", 34.36],
  ["颜色", 69.18],
  ["单位", 4.82],
  ["入库条数", 8.09],
  ["入库数量", 10.18],
  ["出库条数", 8.09],
  ["出库数量", 11.18],
  ["客户", 26],
]);

const CITIES = [
  "绍兴柯桥", "吴江盛泽", "杭州", "宁波", "慈溪", "余姚", "义乌", "温州", "桐乡", "萧山",
  "南通", "苏州", "常熟", "江阴", "常州", "无锡", "武进", "嘉兴", "海宁", "湖州", "长兴",
  "广州中大", "佛山", "东莞", "深圳", "汕头", "泉州", "石狮", "晋江", "厦门", "福州",
  "青岛", "潍坊", "淄博", "临沂", "郑州", "武汉", "长沙", "南昌", "合肥", "成都",
  "重庆", "西安", "石家庄", "天津", "北京", "上海", "南京", "大连", "临平",
];

const BRANDS = [
  "宏泰", "鑫盛", "恒达", "万隆", "祥云", "锦华", "永昌", "金鹏", "华纺", "鼎盛",
  "兴业", "佳和", "顺发", "利丰", "天成", "正大", "富达", "联众", "盛世", "宏图",
  "立信", "嘉禾", "博纳", "华美", "东盛", "新宇", "广源", "瑞丰", "和信", "金仑",
  "裕丰", "德昌", "恒信", "安泰", "协成", "永盛", "汇丰", "大发", "南盛", "泰和",
  "恒丰", "华源", "金桥", "锦程", "中兴", "群力", "华联", "鑫源", "顺兴", "德盛",
  "朝阳", "百盛", "长虹", "同兴", "振华", "华兴", "金泰", "茂盛", "天成达", "万佳",
  "华鑫", "嘉华", "润丰", "建业", "广丰", "泰盛", "中盛", "福源", "长盛", "宏兴",
  "永恒", "新盛", "华宇", "金丰", "鑫达", "通达", "天成和", "顺成", "益丰", "天源",
];

const KINDS = [
  ["纺织有限公司", 4],
  ["织造有限公司", 2],
  ["布行", 5],
  ["贸易有限公司", 4],
  ["面料商行", 3],
  ["服装有限公司", 3],
  ["家纺有限公司", 2],
  ["实业有限公司", 1],
  ["纺织品经营部", 3],
  ["纺织科技", 1],
  ["针纺织品", 1],
  ["布业", 2],
];

function mulberry32(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickWeighted(random, entries) {
  const total = entries.reduce((sum, entry) => sum + entry[1], 0);
  let cursor = random() * total;
  for (const entry of entries) {
    cursor -= entry[1];
    if (cursor <= 0) return entry[0];
  }
  return entries[entries.length - 1][0];
}

/** 客户名：城市 + 字号 + 公司类型，二成用「城市 + 姓氏 + 布行」这种人名商号 */
function createCustomerNames(random, count) {
  const surnames = ["陈", "王", "李", "张", "刘", "周", "吴", "徐", "孙", "沈", "诸", "俞"];
  const names = [];
  const used = new Set();
  let guard = 0;
  while (names.length < count && guard < count * 50) {
    guard += 1;
    const city = CITIES[Math.floor(random() * CITIES.length)];
    const name =
      random() < 0.2
        ? `${city}${surnames[Math.floor(random() * surnames.length)]}氏布行`
        : `${city}${BRANDS[Math.floor(random() * BRANDS.length)]}${pickWeighted(random, KINDS)}`;
    if (used.has(name)) continue;
    used.add(name);
    names.push(name);
  }
  return names;
}

/** 加工厂名：城市 + 字号 + 厂类型，只用于「加工出库」行 */
function createFactoryNames(random, count) {
  const names = [];
  const used = new Set();
  let guard = 0;
  while (names.length < count && guard < count * 50) {
    guard += 1;
    const name = `${CITIES[Math.floor(random() * CITIES.length)]}${
      BRANDS[Math.floor(random() * BRANDS.length)]
    }${FACTORY_KINDS[Math.floor(random() * FACTORY_KINDS.length)]}`;
    if (used.has(name)) continue;
    used.add(name);
    names.push(name);
  }
  return names;
}

/**
 * 每个客户：分档（大贸易商 / 中等商户 / 散户）+ 热度 + 各品名的偏好权重。
 * 大客户什么品名都进、SKU 覆盖面广；散户只熟一个品名、通常只买一两个 SKU。
 */
function createCustomers(random, names, productNames) {
  return names.map((name) => {
    const roll = random();
    const segment = roll < 0.06 ? "core" : roll < 0.3 ? "mid" : "tail";
    const scale =
      segment === "core"
        ? 8 + random() * 6
        : segment === "mid"
          ? 3 + random() * 3
          : 0.6 + random() * 1.2;
    const preference = productNames.map(() => 0.15 + random() * random() * 2.4);
    if (segment === "core") {
      // 大贸易商：全品类都能买
      for (let index = 0; index < preference.length; index += 1) {
        preference[index] = Math.max(preference[index], 0.9 + random() * 0.6);
      }
    } else {
      const favorites = segment === "mid" ? 1 + Math.round(random()) : 1;
      for (let index = 0; index < favorites; index += 1) {
        const pick = Math.floor(random() * preference.length);
        preference[pick] += 2 + random() * 2.5;
      }
    }
    return { name, segment, scale, preference, skuCount: 0 };
  });
}

/**
 * 选客户的权重：越热销的 SKU 越容易落到大客户手里（同一批人反复复购），
 * 越冷门的 SKU 越容易落到散户手里（一人一单、彼此不重叠）。
 */
function segmentWeight(segment, heat) {
  const warm = 1 - heat;
  if (segment === "core") return 0.02 + 15 * Math.pow(warm, 4);
  if (segment === "mid") return 0.12 + 2.5 * Math.pow(warm, 2);
  return 0.18 + 0.45 * warm;
}

/** 去重客户数目标：1~2 单只给一个客户，其余按订单数次线性增长 */
function targetCustomerCount(orderCount, cap) {
  if (orderCount <= 2) return 1;
  return Math.min(cap, Math.max(2, Math.round(Math.pow(orderCount, 0.58))));
}

function parseArgs(argv) {
  const options = { input: DEFAULT_FILE, output: null, seed: 20261109, customers: 1100, dryRun: false };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--seed") options.seed = Number(argv[(index += 1)]);
    else if (arg === "--customers") options.customers = Number(argv[(index += 1)]);
    else positional.push(arg);
  }
  if (positional[0]) options.input = path.resolve(positional[0]);
  if (positional[1]) options.output = path.resolve(positional[1]);
  return options;
}

function readSheet(file) {
  const workbook = XLSX.readFile(file, { cellNF: true });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const range = XLSX.utils.decode_range(sheet["!ref"]);
  const headers = [];
  for (let column = range.s.c; column <= range.e.c; column += 1) {
    const cell = sheet[XLSX.utils.encode_cell({ r: range.s.r, c: column })];
    headers.push(cell ? String(cell.w ?? cell.v ?? "").trim() : "");
  }
  for (let column = range.s.c; column <= range.e.c; column += 1) {
    const format = COLUMN_FORMATS.get(headers[column - range.s.c]);
    if (!format) continue;
    for (let row = range.s.r; row <= range.e.r; row += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
      if (cell && typeof cell.v === "number") cell.z = format;
    }
  }
  return { workbook, sheetName, sheet, range, headers };
}

function cellValue(sheet, row, column) {
  const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
  return cell ? cell.v : "";
}

function assignCustomers(sheet, range, headers, options) {
  const columnOf = new Map();
  headers.forEach((label, index) => {
    if (label && !columnOf.has(label)) columnOf.set(label, range.s.c + index);
  });
  for (const required of ["单号", "来源单据", "品名", "出库数量"]) {
    if (!columnOf.has(required)) throw new Error(`明细表缺少列：${required}`);
  }

  const docColumn = columnOf.get("单号");
  const sourceColumn = columnOf.get("来源单据");
  const productColumn = columnOf.get("品名");
  const outColumn = columnOf.get("出库数量");
  const colorColumn = columnOf.has("颜色") ? columnOf.get("颜色") : null;

  const firstRow = range.s.r + 1;
  const lastRow = range.e.r;

  // 1. 先把单号、SKU 归属和行号收齐（销售单记客户，加工出库记加工厂）
  const docs = new Map(); // 销售单号 → { skus }
  const skuDocs = new Map(); // 销售 品名|颜色 → 单号[]
  const processingDocs = new Map(); // 加工出库单号 → { skus }
  for (let row = firstRow; row <= lastRow; row += 1) {
    const source = String(cellValue(sheet, row, sourceColumn) ?? "").trim();
    const isSales = CUSTOMER_SOURCES.has(source);
    const isProcessing = source === PROCESSING_SOURCE;
    if (!isSales && !isProcessing) continue;
    if (!(Number(cellValue(sheet, row, outColumn)) > 0)) continue;
    const docNo = String(cellValue(sheet, row, docColumn) ?? "").trim();
    if (!docNo) continue;
    const sku = `${cellValue(sheet, row, productColumn)}|${colorColumn === null ? "" : cellValue(sheet, row, colorColumn)}`;
    if (!isSales) {
      let processingDoc = processingDocs.get(docNo);
      if (!processingDoc) {
        processingDoc = { skus: new Set() };
        processingDocs.set(docNo, processingDoc);
      }
      processingDoc.skus.add(sku);
      continue;
    }
    let doc = docs.get(docNo);
    if (!doc) {
      doc = { skus: new Set() };
      docs.set(docNo, doc);
    }
    if (!doc.skus.has(sku)) {
      doc.skus.add(sku);
      if (!skuDocs.has(sku)) skuDocs.set(sku, []);
      skuDocs.get(sku).push(docNo);
    }
  }

  // 2. 客户池
  const random = mulberry32(options.seed);
  const allSkuKeys = [
    ...skuDocs.keys(),
    ...[...processingDocs.values()].flatMap((doc) => [...doc.skus]),
  ];
  const productNames = [...new Set(allSkuKeys.map((key) => key.split("|")[0]))].sort();
  const productIndex = new Map(productNames.map((name, index) => [name, index]));
  const skuProduct = new Map(
    [...skuDocs.keys()].map((key) => [key, productIndex.get(key.split("|")[0])]),
  );
  const customers = createCustomers(
    random,
    createCustomerNames(random, options.customers),
    productNames,
  );

  const docCustomer = new Map(); // 单号 → 客户名
  const customerOf = new Map(customers.map((customer) => [customer.name, customer]));
  const cap = 200;

  // 3. 从最热销的 SKU 开始分客户：热的先挑，冷的自然只剩独有客户
  const skuEntries = [...skuDocs.entries()].sort(
    (a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1),
  );
  for (let skuIndex = 0; skuIndex < skuEntries.length; skuIndex += 1) {
    const [sku, docList] = skuEntries[skuIndex];
    const heat = skuIndex / Math.max(1, skuEntries.length - 1);
    const orderCount = docList.length;
    const target = Math.min(targetCustomerCount(orderCount, cap), orderCount);
    const product = skuProduct.get(sku);
    const assigned = new Set();
    const pending = [];
    for (const docNo of docList) {
      const name = docCustomer.get(docNo);
      if (name) assigned.add(name);
      else pending.push(docNo);
    }

    let need = Math.min(Math.max(0, target - assigned.size), pending.length);
    let fresh = [];
    if (need > 0) {
      // A-Res 加权无放回抽样：权重越高越容易入选，但同一 SKU 不会重复取到同一客户。
      // 用抽样而不是「按分数取前 N」是为了让散户也能分到冷门 SKU，避免几个大客户吃掉整张目录。
      const ranking = [];
      for (const customer of customers) {
        if (assigned.has(customer.name)) continue;
        const weight = segmentWeight(customer.segment, heat) * customer.preference[product];
        if (weight <= 0) continue;
        ranking.push({
          name: customer.name,
          key: Math.pow(random(), 1 / weight) * (0.98 + random() * 0.04),
        });
      }
      ranking.sort((a, b) => b.key - a.key || (a.name < b.name ? -1 : 1));
      fresh = ranking.slice(0, need).map((entry) => entry.name);
      if (fresh.length < need) need = fresh.length;
      for (let index = 0; index < need; index += 1) {
        docCustomer.set(pending[index], fresh[index]);
        assigned.add(fresh[index]);
      }
    }

    // 多出来的订单：按客户热度重复购买（热销品由少数大客户反复下单）
    const repeatPool = [...assigned];
    if (repeatPool.length > 0) {
      const cumulative = [];
      let total = 0;
      for (const name of repeatPool) {
        const customer = customerOf.get(name);
        total += Math.max(0.05, customer.scale * customer.preference[product]);
        cumulative.push(total);
      }
      for (let index = need; index < pending.length; index += 1) {
        const cursor = random() * total;
        let slot = 0;
        while (slot < cumulative.length - 1 && cumulative[slot] < cursor) slot += 1;
        docCustomer.set(pending[index], repeatPool[slot]);
      }
    }

    for (const name of assigned) {
      const customer = customerOf.get(name);
      customer.skuCount += 1;
    }
  }

  // 4. 加工出库：按 SKU 分给 1~2 家加工厂（订单总数把这些行也算进去了，客户列不能空着）
  const factories = createFactoryNames(random, 26).map((name) => ({
    name,
    preference: productNames.map(() => 0.2 + random() * random() * 2),
  }));
  const processingSkuDocs = new Map();
  for (const [docNo, doc] of processingDocs) {
    for (const sku of doc.skus) {
      if (!processingSkuDocs.has(sku)) processingSkuDocs.set(sku, []);
      processingSkuDocs.get(sku).push(docNo);
    }
  }
  const processingEntries = [...processingSkuDocs.entries()].sort(
    (a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1),
  );
  for (const [sku, docList] of processingEntries) {
    const product = productIndex.get(sku.split("|")[0]) ?? 0;
    const target = docList.length <= 3 ? 1 : 2;
    const pickup = factories
      .map((factory) => ({
        name: factory.name,
        key: Math.pow(random(), 1 / factory.preference[product]),
      }))
      .sort((a, b) => b.key - a.key)
      .slice(0, target)
      .map((entry) => entry.name);
    docList.forEach((docNo, index) => {
      if (docCustomer.has(docNo)) return;
      docCustomer.set(docNo, pickup[index % pickup.length]);
    });
  }

  return { docCustomer, docs, skuDocs, customers, factories, processingDocs, columnOf };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const { workbook, sheetName, sheet, range, headers } = readSheet(options.input);
  const { docCustomer, docs, skuDocs, customers, factories, processingDocs, columnOf } = assignCustomers(
    sheet,
    range,
    headers,
    options,
  );

  const docColumn = columnOf.get("单号");
  const existingColumn = columnOf.has("客户") ? columnOf.get("客户") : null;
  const newColumn = existingColumn ?? range.e.c + 1;
  if (existingColumn === null) {
    sheet[XLSX.utils.encode_cell({ r: range.s.r, c: newColumn })] = { t: "s", v: "客户" };
  }
  let filled = 0;
  for (let row = range.s.r + 1; row <= range.e.r; row += 1) {
    const docNo = String(cellValue(sheet, row, docColumn) ?? "").trim();
    const name = docCustomer.get(docNo);
    if (!name) continue;
    sheet[XLSX.utils.encode_cell({ r: row, c: newColumn })] = { t: "s", v: name };
    filled += 1;
  }
  if (existingColumn === null) {
    sheet["!ref"] = XLSX.utils.encode_range({
      s: range.s,
      e: { r: range.e.r, c: newColumn },
    });
  }
  const lastColumn = Math.max(range.e.c, newColumn);
  const cols = Array.isArray(sheet["!cols"]) ? sheet["!cols"].slice() : [];
  while (cols.length <= lastColumn) cols.push({});
  for (let column = 0; column <= lastColumn; column += 1) {
    const header = sheet[XLSX.utils.encode_cell({ r: range.s.r, c: column })];
    const width = COLUMN_WIDTHS.get(String(header?.v ?? "").trim());
    if (width !== undefined && !cols[column]?.wch) cols[column] = { ...cols[column], wch: width };
  }
  sheet["!cols"] = cols;

  // 校验用统计
  const skuCounts = [...skuDocs.values()].map((list) => new Set(list.map((docNo) => docCustomer.get(docNo))).size);
  const sorted = skuCounts.slice().sort((a, b) => a - b);
  const skuBuckets = {};
  const usedCustomers = customers.filter((customer) => customer.skuCount > 0);
  for (const customer of usedCustomers) {
    const bucket = customer.skuCount === 1 ? "1" : customer.skuCount <= 3 ? "2-3" : customer.skuCount <= 8 ? "4-8" : customer.skuCount <= 20 ? "9-20" : "21+";
    skuBuckets[bucket] = (skuBuckets[bucket] || 0) + 1;
  }
  const singleSkuCustomers = usedCustomers.filter((customer) => customer.skuCount === 1).length;
  const segmentCoverage = ["core", "mid", "tail"].map((segment) => {
    const list = usedCustomers.filter((customer) => customer.segment === segment);
    const avgSku = list.length
      ? (list.reduce((sum, customer) => sum + customer.skuCount, 0) / list.length).toFixed(1)
      : "0";
    return `${segment} ${list.length} 家/均 ${avgSku} SKU`;
  });
  const hottest = [...skuDocs.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  const hottestOrders = new Map();
  for (const docNo of hottest[1]) {
    const name = docCustomer.get(docNo);
    hottestOrders.set(name, (hottestOrders.get(name) || 0) + 1);
  }
  const hottestTop = [...hottestOrders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const topSkus = [...skuDocs.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 8)
    .map(([sku, list]) => {
      const distinct = new Set(list.map((docNo) => docCustomer.get(docNo))).size;
      return `${sku}: ${list.length} 单 / ${distinct} 客户`;
    });

  const usedFactoryNames = new Set(
    [...processingDocs.keys()].map((docNo) => docCustomer.get(docNo)).filter(Boolean),
  );
  console.log(`文件：${options.input}`);
  console.log(
    `销售单 ${docs.size} 张 / 客户 ${usedCustomers.length} 家（客户池 ${customers.length}）；加工出库单 ${processingDocs.size} 张 / 加工厂 ${usedFactoryNames.size} 家；合计出库行 ${filled}`,
  );
  console.log(
    `每 SKU 客户数 min ${sorted[0]} p50 ${sorted[sorted.length >> 1]} p90 ${sorted[Math.floor(sorted.length * 0.9)]} max ${sorted.at(-1)}`,
  );
  console.log(`客户覆盖 SKU 数分档 ${JSON.stringify(skuBuckets)}（只 1 个 SKU：${singleSkuCustomers} 家）`);
  console.log(`分档覆盖：${segmentCoverage.join("；")}`);
  console.log(`最热 SKU 前 5 客户下单数：${hottestTop.map(([name, count]) => `${name} ${count}`).join("；")}`);
  console.log(`最热销：\n  ${topSkus.join("\n  ")}`);

  if (options.dryRun) return;

  const output = options.output ?? options.input;
  const tempRaw = `${output}.raw.tmp.xlsx`;
  XLSX.writeFile(workbook, tempRaw, {
    bookType: "xlsx",
    compression: false,
    // 只写数字格式（日期 m/d/yy、数量 0.##）
    cellNF: true,
  });
  // SheetJS 的 zip 是分块 deflate，几十万行的 sheet.xml 会比整体压缩大近 3 倍；重打包一次回到原始导出体积
  const entries = unzipSync(new Uint8Array(fs.readFileSync(tempRaw)));
  fs.writeFileSync(`${output}.tmp.xlsx`, Buffer.from(zipSync(entries, { level: 9 })));
  fs.unlinkSync(tempRaw);
  fs.renameSync(`${output}.tmp.xlsx`, output);
  console.log(`已写入：${output}（工作表 ${sheetName}，新增列「客户」）`);
}

main();
