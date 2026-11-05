/**
 * 网布库存总表清洗合并脚本（配置驱动，可继续加分表）
 * ==================================================================
 * 数据处理流程：定位文件 → 读取 → 以「产品资料」为基准建全集 → 分表按唯一标识汇总/关联 → 输出总表
 *
 * ★ 新增一个分表：只在 JOINS 里加一段即可
 *     { label: "成本表", columns: [{ field: "采购金额", as: "采购金额" }] }
 *   · label 同时用作文件名关键字（文件名包含它即命中）和日志名，不用再写 match
 *   · 唯一标识统一由 CONFIG.keyFields 拼成（默认 品名+颜色，品名可写成 产品名），不用每张表重复写
 *   · 只有基准表要写 role，分表默认都是按唯一标识并入
 *   · columns 省略 agg 即求和；as 省略则列名同 field；field 省略则取 as
 *   · 输出列顺序由 CONFIG.columnOrder 决定（唯一标识固定在最左），与分表配置的先后无关
 *   · columnOrder 里列出、但没有任何数据源提供的列，整列填 0（日志会列出"暂时没有数据来源"的列）
 *   · 输出哪些表、每张表取哪些列，由 OUTPUTS 决定；"{按月}" 会展开成全部按月列（默认只进销售表）
 *
 * 目录约定：原始表放 data/，清洗结果放 output/（均为脚本所在目录下的子目录，自动创建）
 *
 * 用法：
 *   node clean-merge.js                                 # 读取 data/，输出到 output/
 *   node clean-merge.js --dir <目录> [--out-dir <目录>] [--out <文件名>]  # 指定源目录 / 输出目录 / 输出文件
 *   node clean-merge.js --list                          # 只打印匹配到的文件，不做处理
 *   node clean-merge.js --file <label>=<路径> ...       # 临时覆盖某张表的路径
 *   node clean-merge.js <产品资料> <出入库明细> <库存结存表> [输出]   # 按配置顺序显式指定
 *
 * 代码调用：
 *   const { cleanMerge, JOINS } = require("./clean-merge.js");
 *   cleanMerge({ outputFile: null });                  // 只返回数据，不写文件
 *   cleanMerge({ files: { 库存结存表: "D:/其它/库存.xlsx" } });
 */

const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");

/* ================================================================
 * 一、全局配置
 * ================================================================ */
const CONFIG = {
  inputDir: path.join(__dirname, "data"), // 原始表目录
  outputDir: path.join(__dirname, "output"), // 清洗结果目录
  outputFile: "总表_清洗结果.xlsx", // 输出文件名（相对 outputDir）
  sheetName: "总表", // 输出工作表名
  keyFields: [
    { field: "品名", aliases: ["产品名"] },
    { field: "颜色", aliases: ["天鸿颜色"] },
  ], // 所有表的唯一标识都由此拼接；aliases 兼容各表不同的列名写法

  /**
   * 总表列顺序（唯一标识固定在最左，这里列它右边的列）。
   * 顺序与数据源配置里的先后无关；这里列了但没有任何数据源提供的列，整列填 0。
   * 月均条数/订单总数/动销月份/动销客户 不放总表，见下方 OUTPUTS 里的销售表。
   */
  columnOrder: [
    "品名",
    "颜色",
    "色彩",
    "生产中", // 暂无数据源（Scheduling 导出缺生产状态列）
    "欠货",
    "周消耗", // 仍由内部的「月均条数 ÷ 4」算出，月均条数本身只输出到销售表
    "周转入", // 暂无数据源（出入库明细无周转入单据）
    "在途库存",
    "在仓库存",
    "总出库数量",
  ],
};

/* ================================================================
 * 二、数据源配置（★ 唯一需要改的地方）
 * ----------------------------------------------------------------
 * 每个分表可用的完整选项（通常只写 label + columns 就够了）：
 *   match      文件名关键字数组，默认 [label]
 *   keyFields  唯一标识来源，默认 CONFIG.keyFields；表里已自带唯一标识列时写 ["唯一标识"]
 *              列名与别表不一致时可写 [{ field: "品名", aliases: ["产品名"] }, "颜色"]
 *   sheet      工作表名或下标，默认 0（第一个工作表）
 *   files      "first"=只取最新一个（默认）；"all"=同关键字多个文件全部读取并合并
 *   optional   true 时文件不存在也不报错，对应列按默认值填充
 *   rowFilter  (row) => boolean，可选，false 的行不参与聚合
 *   skipIncompleteKey  true 时主键缺字段（如颜色为空）的行直接忽略，不汇总也不新增行
 *   mergeSimilarKeys   true 时颜色"多了尾部符号/英文"（-CC、S、（H））仍视为同一个 SKU，合并进基准那一行
 *   appendUnmatched    true 时该表有、但基准表里完全没有的 SKU，追加到总表末尾（数值列按各自来源填，其余填默认值）
 *   id         命令行 --file 的键，默认等于 label
 *
 * columns 每项：
 *   field       源表列名（省略则等于 as）
 *   as          总表列名（省略则等于 field）
 *   agg         sum（默认）| count | rows | months | first | last | min | max | concat
 *   divideBy    仅数值列：{ field: "单位", map: { 码: 100, 公斤: 20 } }，先求和再按该 SKU 的单位换算（未命中的单位记 0）
 *   digits      仅求和列：保留小数位，默认 6；传 0 即四舍五入到整数（如月均条数）
 *   divideFrom  由同表另一列换算而来：{ column: "月均条数", by: 4 } → 周消耗 = 月均条数 ÷ 4
 *   monthlyColumns  按月展开：{ dateField: "做账日期", year: 2026, columns: [{ field: "出库数量", as: "{月}月条数", ... }] }
 *                   列名里的 {月} 依次替换为 1..12，输出顺序为 1月条数、1月重量、2月条数…，自动接在 columnOrder 之后
 *   onlyUnits   仅数值列：{ field: "单位", include: ["公斤"] }，不属于这些单位的行不计入该列
 *   default     匹配不到该 SKU 时填的值，默认 sum/count/min/max → 0，其它 → ""
 *   separator   concat 的连接符，默认 "、"
 *   type        仅基准表可用："text"（默认）| "number"
 *   derive      仅基准表可用：({ key, values }) => 值，按唯一标识/已算出的列推导新列（无需 field）
 *
 * 分表明细也可以写成字符串简写：columns: ["采购金额", "采购数量"] 等价于按 sum 累加同名列。
 * ================================================================ */

/** 唯一标识含这些词即算「黑白」，其余算「彩色」 */
const MONOCHROME_WORDS = ["本白", "大白", "黑白", "黑色"];

/** 基准表：决定总表的行集合（左连接主表），总表最前面的列来自这里 */
const BASE = {
  label: "产品资料",
  columns: [
    "品名",
    "颜色",
    {
      as: "色彩",
      derive: ({ key }) => (MONOCHROME_WORDS.some((word) => key.includes(word)) ? "黑白" : "彩色"),
    },
  ],
};

/** 分表：每张表按唯一标识并入总表，按数组顺序追加列 */
const JOINS = [
  {
    label: "出入库明细",
    // 出库数量=0 的行是退货/纯入库，不算订单、也不算动销月份
    rowFilter: (row) => toNumber(row["出库数量"]) > 0,
    columns: [
      { field: "出库数量", as: "总出库数量" },
      // 月均条数 = 总出库数量 ÷ 单位换算系数（码→100、公斤→20；件/条等无规则的记 0），四舍五入到整数
      {
        field: "出库数量",
        as: "月均条数",
        divideBy: { field: "单位", map: { 码: 100, 公斤: 20 } },
        digits: 0,
      },
      { as: "周消耗", divideFrom: { column: "月均条数", by: 4 }, digits: 2 }, // 月均条数 ÷ 4
      { as: "订单总数", agg: "rows" }, // 1 行 = 1 单
      { field: "做账日期", as: "动销月份", agg: "months" }, // 最长连续月份数
    ],
    // 按月展开：1月条数、1月重量、2月条数、2月重量…（自动追加到总表最后）
    monthlyColumns: {
      dateField: "做账日期",
      year: 2026, // 统计哪一年的月份；不写则取数据里最新的年份
      columns: [
        // 条数：各单位的出库数量都换算成条（码 ÷100、公斤 ÷20，其它单位记 0）
        {
          field: "出库数量",
          as: "{月}月条数",
          divideBy: { field: "单位", map: { 码: 100, 公斤: 20 } },
          digits: 0,
        },
        // 重量：只统计公斤单位产品的出库数量，码单位不填
        {
          field: "出库数量",
          as: "{月}月重量",
          onlyUnits: { field: "单位", include: ["公斤"] },
          digits: 2,
        },
      ],
    },
  },
  {
    label: "库存结存表",
    columns: [{ field: "数量", as: "在仓库存" }],
  },

  {
    label: "欠货",
    mergeSimilarKeys: true, // 颜色尾部多符号/英文的并入基准同一 SKU
    appendUnmatched: true, // 基准里完全没有的欠货 SKU 才追加成新行
    columns: [{ field: "欠货总数量", as: "欠货" }],
  },

  {
    label: "生产排单", // 文件名按 match 匹配（1793687109556productionScheduling.xlsx）
    match: ["Scheduling"],
    skipIncompleteKey: true, // 颜色为空的行无法定位 SKU，忽略
    mergeSimilarKeys: true, // 颜色尾部多符号/英文的并入基准同一 SKU
    appendUnmatched: true, // 基准里完全没有的 SKU 才追加成新行
    columns: [{ field: "进仓重量", as: "在途库存" }],
  },

  /* ---------------- 新增分表示例（解开注释即可用） ----------------
  {
    label: "成本表",                    // 文件名含「成本表」，输出列接在最后
    columns: [
      { field: "采购单价", as: "采购单价", agg: "first" },  // 取第一条非空值
      { field: "采购金额", as: "采购金额" },                 // 默认 sum
    ],
  },
  */
];

/* ================================================================
 * 输出文件配置（多表输出，都从同一份合并结果取列）
 * ----------------------------------------------------------------
 *   file      输出文件名（相对 outputDir）
 *   sheet     工作表名
 *   columns   要输出的列，按顺序；"{按月}" 会展开成所有按月列（1月条数、1月重量…）
 * ================================================================ */
const MONTHLY_TOKEN = "{按月}";

const OUTPUTS = [
  {
    file: CONFIG.outputFile,
    sheet: CONFIG.sheetName,
    columns: ["唯一标识", ...CONFIG.columnOrder],
  },
  {
    file: "销售表.xlsx",
    sheet: "销售表",
    columns: [
      "唯一标识",
      "品名",
      "颜色",
      "月均条数",
      "订单总数",
      "动销月份",
      "动销客户", // 暂无数据源（出入库明细无客户字段）
      MONTHLY_TOKEN,
    ],
  },
];

/* ================================================================
 * 三、配置规范化（把简洁写法补全成内部结构）
 * ================================================================ */

function normalizeColumns(columns, role) {
  return (columns || []).map((column) => {
    const isText = typeof column === "string";
    const raw = isText ? { field: column } : column;
    if (raw.derive !== undefined) {
      if (role !== "base") throw new Error(`derive 仅基准表可用：${JSON.stringify(column)}`);
      if (!raw.as) throw new Error(`derive 列必须指定 as：${JSON.stringify(column)}`);
      return { ...raw, field: raw.as, as: raw.as };
    }
    const field = raw.field ?? raw.as;
    const as = raw.as ?? raw.field;
    if (!field || !as) throw new Error(`columns 配置缺少列名：${JSON.stringify(column)}`);
    return role === "base"
      ? { ...raw, field, as, type: raw.type ?? "text" }
      : { ...raw, field, as, agg: raw.agg ?? "sum" };
  });
}

function normalizeSource(sourceConfig, role) {
  if (!sourceConfig || !sourceConfig.label) throw new Error("数据源配置缺少 label");
  return {
    ...sourceConfig,
    id: sourceConfig.id ?? sourceConfig.label,
    role,
    match: sourceConfig.match ?? [sourceConfig.label],
    keyFields: normalizeKeyFields(sourceConfig.keyFields ?? CONFIG.keyFields),
    columns: [
      ...normalizeColumns(sourceConfig.columns, role),
      ...expandMonthlyColumns(sourceConfig.monthlyColumns, role),
    ],
  };
}

/**
 * 按月展开列：模板 as 里的 {月} 依次替换成 1..12，
 * 展开顺序为 1月条数、1月重量、2月条数、2月重量…（同一月份的模板排在一起）
 */
function expandMonthlyColumns(config, role) {
  if (!config) return [];
  if (role !== "join") throw new Error("monthlyColumns 仅分表可用");
  if (!config.dateField) throw new Error("monthlyColumns 缺少 dateField");
  const templates = normalizeColumns(config.columns, role);
  const months = config.months ?? 12;
  const expanded = [];
  for (let month = 1; month <= months; month++) {
    for (const template of templates) {
      if (!template.as.includes("{月}")) {
        throw new Error(`monthlyColumns 的列名需要用 {月} 占位：${JSON.stringify(template.as)}`);
      }
      expanded.push({
        ...template,
        as: template.as.split("{月}").join(String(month)),
        month,
        monthYear: config.year,
        monthDateField: config.dateField,
      });
    }
  }
  return expanded;
}

/**
 * 唯一标识字段规范化：统一成 { field, aliases } 结构。
 * 字符串 = 列名本身；也可写 { field: "品名", aliases: ["产品名", "名称"] }，
 * 同一含义在不同表里列名不一致时，取第一个非空的别名。
 */
function normalizeKeyFields(keyFields) {
  return (keyFields || []).map((keyField) => {
    if (typeof keyField === "string") return { field: keyField, aliases: [] };
    const field = keyField.field;
    if (!field) throw new Error(`keyFields 配置缺少 field：${JSON.stringify(keyField)}`);
    return { field, aliases: keyField.aliases ?? [] };
  });
}

/** 合并 BASE 与 JOINS，并在调用时读取，便于运行期增删分表 */
function normalizeSources() {
  if (!BASE || !BASE.label) throw new Error("必须配置基准表 BASE");
  return [normalizeSource(BASE, "base"), ...(JOINS || []).map((config) => normalizeSource(config, "join"))];
}

/* ================================================================
 * 三、通用工具
 * ================================================================ */

/** 单元格文本：空值/null → ""，否则转字符串并去除首尾空白（含全角空格） */
function cellText(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/^[\s\u3000]+|[\s\u3000]+$/g, "");
}

/** 数量/条数统一转数字：空值、空白、非数字一律为 0，避免累加时出现 NaN；
 *  形如 "130 KG"、"1,200 米" 的带单位文本取开头数字（源表常带单位） */
function toNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const text = cellText(value).replace(/,/g, "");
  if (!text) return 0;
  const num = Number(text);
  if (Number.isFinite(num)) return num;
  const matched = text.match(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)/);
  return matched ? Number(matched[0]) : 0;
}

/** 消除浮点累加噪声（如 0.1+0.2） */
function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/** 统一换行符：\r\n / \r → \n（源数据同一单元格存在两种写法） */
function normalizeNewlines(text) {
  return text.replace(/\r\n?/g, "\n");
}

/** 输出用文本：trim + 统一换行符 */
function textValue(value) {
  return normalizeNewlines(cellText(value));
}

/** 确保目录存在（含多级父目录），返回规范化后的绝对路径 */
function ensureDir(dir) {
  const absDir = path.resolve(dir);
  fs.mkdirSync(absDir, { recursive: true });
  return absDir;
}

/**
 * 取唯一标识各段的值：keyFields 依次取 field → aliases 中第一个非空值。
 * 换行统一为 \n，否则 "A\r\n条" 与 "A\n条" 会被当成两个 SKU（源数据确有此类情况）。
 */
function keyParts(row, keyFields) {
  return keyFields.map((keyField) => {
    for (const name of [keyField.field, ...keyField.aliases]) {
      const value = textValue(row[name]);
      if (value) return value; // 同一含义的不同列名，取第一个非空值
    }
    return "";
  });
}

/**
 * 生成唯一标识：各段以 | 连接。
 * 所有 keyFields 都为空 → 返回 ""（视为合计行/空行，调用方跳过）。
 */
function makeKey(row, keyFields) {
  const parts = keyParts(row, keyFields);
  return parts.every((part) => part === "") ? "" : parts.join("|");
}

/**
 * 唯一标识的匹配用归一化：全角转半角 + 转小写。
 * 让「223#深栗红（固色）s」能对上「223#深栗红（固色）S」这类纯写法差异；
 * 输出到总表的唯一标识仍保持源表原文。
 */
function normalizeKeyText(key) {
  return key.normalize("NFKC").toLowerCase();
}

/** 数值型汇总方式（默认缺失值 0） */
const NUMERIC_AGGS = new Set(["sum", "count", "rows", "months", "min", "max"]);

function columnDefault(column) {
  if (column.default !== undefined) return column.default;
  return NUMERIC_AGGS.has(column.agg || "sum") ? 0 : "";
}

/* ================================================================
 * 四、文件定位
 * ================================================================ */

/** 列出目录下的 Excel 文件（排除 Excel 临时文件与隐藏文件） */
function listExcelFiles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /\.xls[xb]?$/i.test(name) && !name.startsWith("~$") && !name.startsWith("."));
}

/**
 * 按数据源配置逐个定位文件
 * @param {Array<object>} sources 已规范化的数据源（normalizeSources() 的结果）
 * @param {string} dir 目录
 * @param {object} [files] 形如 { 产品资料: "绝对或相对路径" } 的显式覆盖
 * @returns {Array<{source: object, paths: string[], skipped?: boolean}>}
 */
function locateSources(sources, dir, files = {}) {
  const absDir = path.resolve(dir);
  if (!fs.existsSync(absDir)) throw new Error(`目录不存在：${absDir}`);

  const available = listExcelFiles(absDir);
  const used = new Set();
  const entries = [];

  for (const source of sources) {
    const explicit = files[source.id];
    if (explicit) {
      const absPath = path.isAbsolute(explicit) ? explicit : path.resolve(absDir, explicit);
      if (!fs.existsSync(absPath)) throw new Error(`[${source.label}] 指定文件不存在：${absPath}`);
      used.add(path.basename(absPath));
      entries.push({ source, paths: [absPath] });
      continue;
    }

    const candidates = available
      .filter((name) => !used.has(name))
      .filter((name) => source.match.every((keyword) => name.includes(keyword)))
      .map((name) => {
        const fullPath = path.join(absDir, name);
        return { name, fullPath, mtime: fs.statSync(fullPath).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    if (candidates.length === 0) {
      if (source.optional) {
        console.warn(`[${source.label}] 未找到匹配文件，已按可选处理（相关列填默认值）`);
        entries.push({ source, paths: [], skipped: true });
        continue;
      }
      throw new Error(
        `[${source.label}] 未找到文件名含「${source.match.join("+")}」的表格。目录 ${absDir} 下的 Excel 文件：\n  ` +
        (available.length ? available.join("\n  ") : "（无）")
      );
    }

    if (source.files === "all") {
      if (candidates.length > 1) {
        console.log(`[${source.label}] 合并 ${candidates.length} 个文件：${candidates.map((c) => c.name).join("、")}`);
      }
      candidates.forEach((c) => used.add(c.name));
      entries.push({ source, paths: candidates.map((c) => c.fullPath) });
    } else {
      const picked = candidates[0];
      used.add(picked.name);
      entries.push({ source, paths: [picked.fullPath] });
      if (candidates.length > 1) {
        console.warn(
          `[${source.label}] 同关键字命中 ${candidates.length} 个文件，已取最新修改的；其余：` +
          candidates
            .slice(1)
            .map((c) => c.name)
            .join("、") +
          "（如需全部合并，请在该源配置中加 files: \"all\"）"
        );
      }
    }
  }

  return entries;
}

/** 读取工作簿指定工作表为对象数组，并过滤整行空白行 */
function readSheet(filePath, sheetRef = 0) {
  const absPath = path.resolve(filePath);
  const workbook = XLSX.readFile(absPath, { raw: true, cellDates: false });
  const sheetName =
    typeof sheetRef === "number" ? workbook.SheetNames[sheetRef] : workbook.SheetNames.includes(sheetRef) ? sheetRef : null;
  if (!sheetName) throw new Error(`文件 ${path.basename(absPath)} 中找不到工作表「${sheetRef}」`);

  const raw = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: null, raw: true });
  const rows = raw.filter((row) => !Object.values(row).every((v) => cellText(v) === ""));
  console.log(`读取 ${path.basename(absPath)} [${sheetName}]：${raw.length} 行 → 有效 ${rows.length} 行`);
  return rows;
}

/** 读取数据源涉及的所有文件（files: "all" 时多文件合并） */
function readSource(entry) {
  const rows = [];
  for (const filePath of entry.paths) {
    const sheetRows = readSheet(filePath, entry.source.sheet ?? 0);
    for (const row of sheetRows) rows.push(row);
  }
  return rows;
}

/* ================================================================
 * 五、汇总与关联
 * ================================================================ */

/**
 * 基准表：按唯一标识去重，保留首次出现行（保持源表顺序）
 * @returns {{keys: string[], index: Map<string, object>, lookup: Map<string, string>, looseIndex: Map<string, Array>}}
 *   lookup     归一化标识 → 基准唯一标识，匹配时忽略大小写/全半角差异
 *   looseIndex 前段（品名）相同 → [{ key, tail }]，用于「颜色尾部多了符号/英文」的合并
 */
function buildBase(entry, rows) {
  const { source } = entry;
  const keys = [];
  const index = new Map();
  const lookup = new Map();
  const looseIndex = new Map();
  let duplicated = 0;
  let shadowed = 0;

  for (const row of rows) {
    const key = makeKey(row, source.keyFields);
    if (!key) continue; // 合计行 / 空行
    if (index.has(key)) {
      duplicated++;
      continue;
    }
    const normalized = normalizeKeyText(key);
    if (lookup.has(normalized)) shadowed++;
    else lookup.set(normalized, key);
    const values = {};
    for (const column of source.columns) {
      if (column.derive) {
        values[column.as] = cellText(column.derive({ key, values }));
        continue;
      }
      values[column.as] = column.type === "number" ? toNumber(row[column.field]) : textValue(row[column.field]);
    }
    index.set(key, values);
    keys.push(key);
  }

  console.log(`[${source.label}] 基准 SKU ${keys.length} 个（重复丢弃 ${duplicated} 行）`);
  if (shadowed) {
    console.log(`[${source.label}] 忽略大小写/全半角差异后有 ${shadowed} 个 SKU 撞车，分表匹配时按第一行`);
  }

  for (const key of keys) {
    const parts = key.split("|");
    if (parts.length < 2) continue;
    const prefix = normalizeKeyText(parts.slice(0, -1).join("|"));
    if (!looseIndex.has(prefix)) looseIndex.set(prefix, []);
    looseIndex.get(prefix).push({ key, tail: parts[parts.length - 1] });
  }

  return { keys, index, lookup, looseIndex };
}

/** 尾部多出来的部分是否只是符号/英文（不含中文），如 "-CC"、"S"、"（H）" */
function isSuffixDecoration(text) {
  return text.length > 0 && text.length <= 6 && !/[\u4e00-\u9fff]/.test(text);
}

/**
 * 宽松匹配：品名（除最后一段外）完全相同，且分表颜色 = 基准颜色 + 尾部多余符号/英文时，
 * 视为同一个 SKU，返回基准的唯一标识。多个候选取最长（最具体）的那个，仍不唯一则不合并。
 */
function findLooseMatch(key, base) {
  const parts = key.split("|");
  if (parts.length < 2) return null;
  const candidates = base.looseIndex.get(normalizeKeyText(parts.slice(0, -1).join("|")));
  if (!candidates) return null;

  const color = normalizeKeyText(parts[parts.length - 1]);
  let best = null;
  let ambiguous = false;
  for (const candidate of candidates) {
    const tail = normalizeKeyText(candidate.tail);
    if (!tail || color === tail || !color.startsWith(tail)) continue;
    if (!isSuffixDecoration(color.slice(tail.length))) continue;
    if (!best || candidate.tail.length > best.tail.length) {
      best = candidate;
      ambiguous = false;
    } else if (candidate.tail.length === best.tail.length && candidate.key !== best.key) {
      ambiguous = true;
    }
  }
  return best && !ambiguous ? best.key : null;
}

/**
 * 分表主键解析：先按归一化精确匹配基准，再（源配置 mergeSimilarKeys 时）尝试宽松匹配。
 * 结果按原始标识缓存，出入库这类几十万行的表也不会重复计算。
 */
function createKeyResolver(base, source) {
  const cache = new Map();
  const stats = { folded: 0, loose: [] };

  const resolve = (rawKey) => {
    if (cache.has(rawKey)) return cache.get(rawKey);
    let resolved = base.lookup.get(normalizeKeyText(rawKey)) ?? null;
    if (resolved && resolved !== rawKey) stats.folded++;
    if (!resolved && source.mergeSimilarKeys) {
      const hit = findLooseMatch(rawKey, base);
      if (hit) {
        resolved = hit;
        stats.loose.push([rawKey, hit]);
      }
    }
    cache.set(rawKey, resolved);
    return resolved;
  };

  return { resolve, stats };
}

/** 解析日期单元格为 { year, month }：支持 Excel 序列号、Date、以及 "2026-02-25 / 2026年2月" 等文本 */
function toYearMonth(value) {
  const serial = (num) => {
    const parsed = XLSX.SSF.parse_date_code(num);
    return parsed ? { year: parsed.y, month: parsed.m } : null;
  };
  if (typeof value === "number" && Number.isFinite(value)) return serial(value);
  if (value instanceof Date) return { year: value.getFullYear(), month: value.getMonth() + 1 };
  const text = cellText(value);
  if (!text) return null;
  const matched = text.match(/(\d{4})\s*[-/.年]\s*(\d{1,2})/);
  if (matched) return { year: Number(matched[1]), month: Number(matched[2]) };
  const num = Number(text);
  return Number.isFinite(num) && num > 20000 ? serial(num) : null; // 文本形式的序列号
}

/** 数据中该日期列最大的年份（按月列默认用它作为统计年份） */
function latestYear(rows, field) {
  let max = null;
  for (const row of rows) {
    const parsed = toYearMonth(row[field]);
    if (parsed && (max === null || parsed.year > max)) max = parsed.year;
  }
  return max;
}

/** 最长连续月份数：月份换算成 年*12+月 后排序，取最长连号段（断开就有多段，取最大的那段） */
function longestConsecutiveMonths(indices) {
  const list = [...indices].sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  let prev = null;
  for (const current of list) {
    run = prev !== null && current === prev + 1 ? run + 1 : 1;
    if (run > best) best = run;
    prev = current;
  }
  return best;
}

/** 按单位取换算系数（如 码→100、公斤→20）；未配置的单位返回 null（该 SKU 的月均条数记 0） */
function resolveDivisor(divideBy, context) {
  const unit = textValue(context && context[divideBy.field]);
  const factor = divideBy.map && divideBy.map[unit];
  if (Number.isFinite(factor) && factor !== 0) return factor;
  return Number.isFinite(divideBy.default) && divideBy.default !== 0 ? divideBy.default : null;
}

/** 汇总状态初始化 */
function initState(column) {
  switch (column.agg || "sum") {
    case "concat":
      return new Set();
    case "months":
      return new Set();
    case "count":
    case "rows":
      return 0;
    case "sum":
      return 0;
    case "min":
    case "max":
      return null;
    default:
      return null; // first / last
  }
}

/** 汇总状态更新 */
function updateState(column, state, row) {
  const agg = column.agg || "sum";
  const value = row[column.field];
  switch (agg) {
    case "sum":
      return state + toNumber(value);
    case "count":
      return state + 1;
    case "rows":
      return state + 1; // 一行算一单
    case "months": {
      const month = toYearMonth(value);
      if (month) state.add(month.year * 12 + month.month);
      return state;
    }
    case "min": {
      const num = toNumber(value);
      return state === null || num < state ? num : state;
    }
    case "max": {
      const num = toNumber(value);
      return state === null || num > state ? num : state;
    }
    case "concat": {
      const text = textValue(value);
      if (text) state.add(text);
      return state;
    }
    case "last": {
      const text = textValue(value);
      if (!text) return state;
      return typeof value === "number" ? value : text;
    }
    case "first":
    default: {
      const text = textValue(value);
      if (!text) return state;
      // 数字单元格保留数字类型，避免单价等列被写成文本
      return state === null || state === "" ? (typeof value === "number" ? value : text) : state;
    }
  }
}

/** 汇总状态转为最终值 */
function finalizeState(column, state, context) {
  switch (column.agg || "sum") {
    case "concat":
      return [...state].join(column.separator || "、");
    case "months":
      return longestConsecutiveMonths(state);
    case "sum": {
      const digits = column.digits ?? 6;
      if (!column.divideBy) return round(state, digits);
      // divideBy：按该 SKU 的单位换算（码→÷100、公斤→÷20）；没有对应单位（件/条/空）记 0
      // 先换算再取整，避免"先取整再除"把误差放大（如 9.8 公斤 → 10 公斤 → 0.5 条）
      const divisor = resolveDivisor(column.divideBy, context);
      return divisor === null ? 0 : round(state / divisor, digits);
    }
    case "count":
    case "rows":
      return state;
    case "min":
    case "max":
      return state === null ? columnDefault(column) : round(state);
    default:
      return state === null ? columnDefault(column) : state;
  }
}

/**
 * 分表：按唯一标识分组汇总
 * @returns {Map<string, object>} key → { 总表列名: 值 }
 */
function aggregateSource(entry, rows, resolver) {
  const { source } = entry;
  const states = new Map();
  const contexts = new Map(); // key → { 换算依据列名: 值 }，供 divideBy 使用
  const stateColumns = source.columns.filter((column) => !column.divideFrom); // divideFrom 列由其它列算出
  const divideFields = [...new Set(source.columns.filter((column) => column.divideBy).map((column) => column.divideBy.field))];
  const monthlyDateField = source.monthlyColumns && source.monthlyColumns.dateField;
  const monthlyYear = monthlyDateField ? (source.monthlyColumns.year ?? latestYear(rows, monthlyDateField)) : null;
  let incomplete = 0;

  if (monthlyDateField) {
    console.log(`[${source.label}] 按月列统计年份：${monthlyYear ?? "（数据中无可用日期）"}`);
  }

  for (const row of rows) {
    if (source.rowFilter && !source.rowFilter(row)) continue;
    const parts = keyParts(row, source.keyFields);
    if (parts.every((part) => part === "")) continue; // 合计行 / 空行
    if (source.skipIncompleteKey && parts.some((part) => part === "")) {
      incomplete++; // 例如颜色为空，无法定位到 SKU，按配置忽略
      continue;
    }
    const rawKey = parts.join("|");
    const key = (resolver && resolver.resolve(rawKey)) || rawKey; // 已对上基准的用基准标识归集

    let current = states.get(key);
    if (!current) {
      current = stateColumns.map((column) => initState(column));
      states.set(key, current);
    }

    let month = null; // 按月列只统计该月份的记录
    if (monthlyDateField) {
      const parsed = toYearMonth(row[monthlyDateField]);
      month = parsed && (monthlyYear === null || parsed.year === monthlyYear) ? parsed.month : null;
    }

    stateColumns.forEach((column, i) => {
      if (column.month !== undefined && column.month !== month) return;
      if (column.onlyUnits && !column.onlyUnits.include.includes(textValue(row[column.onlyUnits.field]))) return;
      current[i] = updateState(column, current[i], row);
    });

    if (divideFields.length) {
      let context = contexts.get(key);
      if (!context) {
        context = {};
        contexts.set(key, context);
      }
      for (const name of divideFields) {
        if (!context[name]) context[name] = textValue(row[name]); // 同一 SKU 取第一个非空单位
      }
    }
  }

  const summary = new Map();
  for (const [key, current] of states) {
    const values = {};
    stateColumns.forEach((column, i) => {
      values[column.as] = finalizeState(column, current[i], contexts.get(key));
    });
    // 由同表其它列换算出来的列（如 周消耗 = 月均条数 ÷ 4）
    for (const column of source.columns) {
      if (!column.divideFrom) continue;
      const from = Number(values[column.divideFrom.column]) || 0;
      values[column.as] = round(from / column.divideFrom.by, column.digits ?? 6);
    }
    summary.set(key, values);
  }

  console.log(`[${source.label}] 汇总后 SKU ${summary.size} 个`);
  if (incomplete) console.log(`[${source.label}] 主键缺字段（如颜色为空）已忽略 ${incomplete} 行`);
  if (resolver) {
    if (resolver.stats.folded) {
      console.log(`[${source.label}] 其中 ${resolver.stats.folded} 个仅大小写/全半角写法不同，已并入基准对应 SKU`);
    }
    if (resolver.stats.loose.length) {
      console.log(`[${source.label}] 宽松合并 ${resolver.stats.loose.length} 个（颜色尾部多出的符号/英文已忽略）：`);
      resolver.stats.loose.forEach(([from, to]) => console.log(`  - ${JSON.stringify(from)} → ${JSON.stringify(to)}`));
    }
  }
  return summary;
}

/**
 * 以基准表为全集左连接所有分表，列顺序按 CONFIG.columnOrder；
 * 分表里没匹配到的值填列默认值，配置里的列若没有任何数据源则整列填 0；
 * 未匹配且配置了 appendUnmatched 的分表 SKU 追加为最后的新行。
 */
function joinSources(base, baseColumns, joins, columnOrder = CONFIG.columnOrder) {
  const joinColumn = new Map(); // 列名 → { entry, column }
  const summaryOf = new Map(); // entry → 汇总结果
  for (const { entry, summary } of joins) {
    summaryOf.set(entry, summary);
    for (const column of entry.source.columns) joinColumn.set(column.as, { entry, column });
  }

  /** 按列顺序取一行的值：基准列 → 分表列 → 没有来源则 0 */
  const buildLine = (key, baseValues, lookup) => {
    const line = [key];
    for (const name of columnOrder) {
      if (Object.prototype.hasOwnProperty.call(baseValues, name)) {
        line.push(baseValues[name]);
        continue;
      }
      const target = joinColumn.get(name);
      if (!target) {
        line.push(0); // 该列暂时没有数据源（如 生产中 / 周转入 / 动销客户）
        continue;
      }
      const values = lookup(target, name);
      line.push(values === undefined ? columnDefault(target.column) : values);
    }
    return line;
  };

  const rows = [];
  for (const key of base.keys) {
    const baseValues = base.index.get(key);
    rows.push(
      buildLine(key, baseValues, (target, name) => {
        const values = summaryOf.get(target.entry).get(key); // 汇总阶段已把能对上的分表标识换成基准标识
        return values ? values[name] : undefined;
      })
    );
  }

  // 基准里没有的 SKU：只对配置了 appendUnmatched 的分表追加新行
  const extras = new Map(); // 归一化标识 → { key, entry }
  const normalizedValues = new Map(); // entry → Map(归一化标识 → 汇总值)
  for (const { entry, summary } of joins) {
    const map = new Map();
    for (const [key, values] of summary) map.set(normalizeKeyText(key), values);
    normalizedValues.set(entry, map);
  }

  joins.forEach(({ entry, summary }) => {
    const { label, appendUnmatched } = entry.source;
    const unmatchedKeys = [...summary.keys()].filter((key) => !base.index.has(key));
    console.log(`[${label}] 基准里没有的 SKU：${unmatchedKeys.length} 个${appendUnmatched ? "（追加为新行）" : "（丢弃）"}`);
    unmatchedKeys.slice(0, 20).forEach((key) => console.log(`  - ${JSON.stringify(key)}`));
    if (appendUnmatched) {
      unmatchedKeys.forEach((key) => {
        const normalized = normalizeKeyText(key);
        if (!extras.has(normalized)) extras.set(normalized, { key, entry });
      });
    }
    if (summary.size > 0 && unmatchedKeys.length === summary.size) {
      const fields = entry.source.keyFields.map((keyField) => keyField.field).join("、");
      console.warn(
        `[${label}] 没有一行匹配上基准表，请确认该表的主键列名是否为「${fields}」` +
        `（列名不同可在该源配置里加 keyFields 或给 CONFIG.keyFields 加 aliases）`
      );
    }
  });

  for (const [normalized, { key, entry }] of extras) {
    const parts = key.split("|");
    const baseValues = {};
    for (const column of baseColumns) {
      if (column.derive) {
        baseValues[column.as] = textValue(column.derive({ key, values: baseValues }));
      } else {
        // 基准列若是主键的一部分（品名/颜色），用该分表里的原文
        const index = entry.source.keyFields.findIndex(
          (keyField) => keyField.field === column.as || keyField.aliases.includes(column.as)
        );
        baseValues[column.as] = index >= 0 ? textValue(parts[index]) : column.type === "number" ? 0 : "";
      }
    }
    rows.push(
      buildLine(key, baseValues, (target, name) => {
        const values = normalizedValues.get(target.entry).get(normalized);
        return values ? values[name] : undefined;
      })
    );
  }
  if (extras.size) console.log(`基准里没有的 SKU：追加 ${extras.size} 行`);

  console.log(`总表：${rows.length} 行`);
  return rows;
}

/** 根据 CONFIG.columnOrder 生成表头（唯一标识固定在最左） */
function buildHeader(baseEntry, joinEntries, columnOrder = CONFIG.columnOrder) {
  const header = ["唯一标识", ...columnOrder];

  const seen = new Set();
  for (const name of header) {
    if (seen.has(name)) throw new Error(`总表列名重复：${name}，请检查 CONFIG.columnOrder`);
    seen.add(name);
  }
  return header;
}

/** 打印列计划：每张输出表输出哪些列、哪些列暂时没有数据来源、哪些源列没被任何表用到 */
function printColumnPlan(baseEntry, joinEntries, outputs) {
  const available = new Set(baseEntry.source.columns.map((column) => column.as));
  joinEntries.forEach((entry) => entry.source.columns.forEach((column) => available.add(column.as)));

  const used = new Set();
  const missing = new Set();
  for (const output of outputs) {
    console.log(`[${output.sheet}] ${output.columns.length} 列：${output.columns.join(" | ")}`);
    for (const name of output.columns) {
      used.add(name);
      if (name !== "唯一标识" && !available.has(name)) missing.add(name);
    }
  }
  if (missing.size) console.warn(`以下几列暂时没有数据来源，整列填 0：${[...missing].join("、")}`);
  const dropped = [...available].filter((name) => !used.has(name));
  if (dropped.length) console.warn(`以下列已在数据源里配置，但没有输出到任何表：${dropped.join("、")}`);
}

/* ================================================================
 * 六、输出
 * ================================================================ */

function columnWidth(name) {
  if (name === "唯一标识") return 34;
  if (name === "品名") return 40;
  if (name === "颜色") return 44;
  return Math.max(12, Math.min(24, name.length * 2 + 4));
}

function writeOutput(rows, header, outputFile, sheetName = CONFIG.sheetName) {
  const sheet = XLSX.utils.aoa_to_sheet([header, ...rows]);
  sheet["!cols"] = header.map((name) => ({ wch: columnWidth(name) }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);

  const absPath = path.resolve(outputFile);
  ensureDir(path.dirname(absPath));
  try {
    XLSX.writeFile(workbook, absPath);
    console.log(`已输出：${absPath}`);
  } catch (err) {
    if (err.code !== "EBUSY" && err.code !== "EPERM" && err.code !== "EACCES") throw err;
    // 输出文件被 Excel/WPS 占用时，改写带时间戳的副本
    const fallback = absPath.replace(/\.xlsx?$/i, `_${timestamp()}.xlsx`);
    XLSX.writeFile(workbook, fallback);
    console.warn(`目标文件被占用（${absPath}），已改写为：${fallback}`);
  }
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/* ================================================================
 * 七、主流程
 * ================================================================ */

/** 打印当前生效的配置，便于确认各表取到的文件与列 */
function printConfig(entries) {
  console.log("数据源配置：");
  entries.forEach((entry, i) => {
    const { source } = entry;
    const fileText = entry.paths.length ? entry.paths.map((p) => path.basename(p)).join("、") : "（缺失，填默认值）";
    const colText = source.columns
      .filter((c) => c.month === undefined)
      .map((c) => {
        if (source.role !== "base") {
          if (c.divideFrom) return `${c.as}(÷${c.divideFrom.by})`;
          return `${c.as}(${c.agg || "sum"}${c.divideBy ? "÷单位" : ""})`;
        }
        return c.derive ? `${c.as}(推导)` : c.as;
      })
      .join("、");
    const monthlyCount = source.columns.filter((c) => c.month !== undefined).length;
    const monthlyText = monthlyCount ? `、按月展开 ${monthlyCount} 列` : "";
    console.log(`  ${i + 1}. ${source.role === "base" ? "[基准]" : "[分表]"} ${source.label} ← ${fileText}`);
    console.log(`     列：${colText}${monthlyText}`);
  });
}

/**
 * 执行一次完整清洗流程
 * @param {object} [options]
 * @param {string} [options.inputDir]   原始表目录，默认 脚本所在目录/data
 * @param {string} [options.outputDir]  输出目录，默认 脚本所在目录/output（不存在会自动创建）
 * @param {string} [options.outputFile] 输出文件名；传 null 不写文件；相对路径基于 outputDir
 * @param {object} [options.files]      按 label 覆盖文件路径，如 { 库存结存表: "D:/x.xlsx" }
 * @param {boolean} [options.listOnly]  只打印匹配结果，不读取数据
 * @returns {Array<Array>} 总表数据行（不含表头）
 */
function cleanMerge(options = {}) {
  const {
    inputDir = CONFIG.inputDir,
    outputDir = CONFIG.outputDir,
    outputFile = CONFIG.outputFile,
    files = {},
    listOnly = false,
  } = options;

  const sources = normalizeSources();
  const entries = locateSources(sources, ensureDir(inputDir), files);
  printConfig(entries);
  if (listOnly) return [];

  const baseEntry = entries.find((entry) => entry.source.role === "base");
  const joinEntries = entries.filter((entry) => entry.source.role !== "base");
  // 按月展开的列（1月条数、1月重量…）只进销售表
  const monthlyNames = joinEntries.flatMap((entry) =>
    entry.source.columns.filter((column) => column.month !== undefined).map((column) => column.as)
  );
  // 内部一次算全：总表列 + 按月列 + 其它输出表用到的列，输出时再按 OUTPUTS 拆表
  const resolvedOutputs = OUTPUTS.map((output) => ({
    sheet: output.sheet,
    file: output.file,
    columns: output.columns.flatMap((name) => (name === MONTHLY_TOKEN ? monthlyNames : [name])),
  }));
  const outputNames = resolvedOutputs.flatMap((output) => output.columns).filter((name) => name !== "唯一标识");
  const columnOrder = [];
  for (const name of [...CONFIG.columnOrder, ...monthlyNames, ...outputNames]) {
    if (!columnOrder.includes(name)) columnOrder.push(name);
  }
  printColumnPlan(baseEntry, joinEntries, resolvedOutputs);

  const baseRows = readSource(baseEntry);
  const base = buildBase(baseEntry, baseRows);

  const joins = joinEntries.map((entry) => ({
    entry,
    summary: entry.skipped
      ? new Map()
      : aggregateSource(entry, readSource(entry), createKeyResolver(base, entry.source)),
  }));

  const header = buildHeader(baseEntry, joinEntries, columnOrder);
  const rows = joinSources(base, baseEntry.source.columns, joins, columnOrder);

  if (outputFile) {
    writeOutputs(rows, header, resolvedOutputs, outputDir, outputFile);
  }
  return rows;
}

/**
 * 按 OUTPUTS 把同一份合并结果拆成多张表写文件。
 * 第一张（总表）的文件名可用 --out 覆盖，其余按配置。
 */
function writeOutputs(rows, header, outputs, outputDir, firstFileName = CONFIG.outputFile) {
  const written = [];
  outputs.forEach((output, i) => {
    const index = output.columns.map((name) => {
      const at = header.indexOf(name);
      if (at < 0) throw new Error(`[${output.sheet}] 输出列「${name}」不存在，请检查 OUTPUTS 配置`);
      return at;
    });
    const data = rows.map((line) => index.map((at) => line[at]));
    const fileName = i === 0 ? firstFileName : output.file;
    const outPath = path.isAbsolute(fileName) ? fileName : path.join(outputDir, fileName);
    writeOutput(data, output.columns, outPath, output.sheet);
    written.push(`${path.basename(outPath)}（${output.columns.length} 列）`);
  });
  console.log(`输出完成：${written.join("、")}`);
}

/* ================================================================
 * 八、命令行入口
 * ================================================================ */

/**
 * 解析命令行参数
 *   --dir/-d <目录>        原始表目录（默认 data/）
 *   --out-dir <目录>       输出目录（默认 output/）
 *   --out/-o <文件>        输出文件（相对 out-dir）
 *   --file/-f <label>=<路径>  覆盖某个数据源的文件路径（可重复）
 *   --list                 只打印匹配到的文件
 *   位置参数：1 个 → 目录；2 个及以上 → 按配置顺序给出文件路径
 */
function parseArgs(argv) {
  const options = { files: {} };
  const positional = [];
  const sources = normalizeSources();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dir" || arg === "-d") options.inputDir = argv[++i];
    else if (arg.startsWith("--dir=")) options.inputDir = arg.slice(6);
    else if (arg === "--out-dir") options.outputDir = argv[++i];
    else if (arg.startsWith("--out-dir=")) options.outputDir = arg.slice(10);
    else if (arg === "--out" || arg === "-o") options.outputFile = argv[++i];
    else if (arg.startsWith("--out=")) options.outputFile = arg.slice(6);
    else if (arg === "--file" || arg === "-f") {
      const pair = argv[++i] || "";
      const [id, ...rest] = pair.split("=");
      if (!id || rest.length === 0) throw new Error(`--file 参数格式应为 <源id>=<路径>，收到：${pair}`);
      options.files[id] = rest.join("=");
    } else if (arg.startsWith("--file=")) {
      const pair = arg.slice(7);
      const [id, ...rest] = pair.split("=");
      if (!id || rest.length === 0) throw new Error(`--file 参数格式应为 <源id>=<路径>，收到：${pair}`);
      options.files[id] = rest.join("=");
    } else if (arg === "--list") options.listOnly = true;
    else positional.push(arg);
  }

  if (positional.length >= 2) {
    // 最后一个多余的位置参数视为输出文件
    if (positional.length > sources.length) {
      options.outputFile = positional[sources.length];
    }
    positional.slice(0, sources.length).forEach((filePath, i) => {
      options.files[sources[i].id] = filePath;
    });
  } else if (positional.length === 1) {
    options.inputDir = positional[0];
  }

  return options;
}

function main() {
  try {
    cleanMerge(parseArgs(process.argv.slice(2)));
  } catch (err) {
    console.error(`处理失败：${err.message}`);
    process.exitCode = 1;
  }
}

// 命令行直接运行：node clean-merge.js；被 require 时不自动执行
if (require.main === module) main();

module.exports = {
  CONFIG,
  BASE,
  JOINS,
  OUTPUTS,
  MONTHLY_TOKEN,
  normalizeSources,
  normalizeColumns,
  cleanMerge,
  locateSources,
  listExcelFiles,
  ensureDir,
  parseArgs,
  readSheet,
  readSource,
  buildBase,
  aggregateSource,
  joinSources,
  findLooseMatch,
  createKeyResolver,
  buildHeader,
  writeOutput,
  makeKey,
  toNumber,
  cellText,
  textValue,
  normalizeNewlines,
};
