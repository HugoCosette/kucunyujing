/**
 * 网布库存总表清洗合并脚本（命令行版）
 * ==================================================================
 * 清洗口径（配置、唯一标识、汇总、关联、宽松合并）全部在同目录的 engine.mjs，
 * 网页「导入分表」也通过 src/cleaning/engine.js 引用它。本文件只负责命令行这一侧：
 *   定位文件 → 用 SheetJS 读表 → 写 output/*.xlsx → 打印诊断信息。
 *
 * 所以：改清洗逻辑改 engine.mjs（页面和脚本一起生效）；只想单表核对数据，跑 npm run clean。
 *
 * 目录约定：原始表放 data/，清洗结果放 output/（均为脚本所在目录下的子目录，自动创建）
 *
 * 用法：
 *   node clean-merge.js                                 # 读取 data/，输出到 output/
 *   node clean-merge.js --dir <目录> [--out-dir <目录>] [--out <文件名>]  # 指定源目录 / 输出目录 / 输出文件
 *   node clean-merge.js --list                          # 只打印匹配到的文件，不做处理
 *   node clean-merge.js --file <源id>=<路径> ...        # 临时覆盖某张表的路径
 *   node clean-merge.js <产品资料> <出入库明细> <库存结存表> [输出]   # 按配置顺序显式指定
 *
 * 代码调用：
 *   const { cleanMerge } = require("./clean-merge.js");
 *   const rows = await cleanMerge({ outputFile: null });                // 只返回数据，不写文件
 *   await cleanMerge({ files: { 库存结存表: "D:/其它/库存.xlsx" } });     // 覆盖某个数据源
 *   await cleanMerge({ inputDir: "D:/原始", outputDir: "D:/结果" });      // 自定义目录
 */

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const XLSX = require("xlsx");

/* ================================================================
 * 一、脚本侧配置
 * ================================================================ */

const PATHS = {
  inputDir: path.join(__dirname, "data"), // 原始表目录
  outputDir: path.join(__dirname, "output"), // 清洗结果目录
  outputFile: "总表_清洗结果.xlsx", // 第一个输出文件名（可用 --out 覆盖）
};

// 清洗引擎就是本目录的 engine.mjs —— 全项目唯一一份口径（网页通过 src/cleaning/engine.js 转发引用它）。
// 用 .mjs 后缀：本目录 package.json 是 CommonJS（本文件用 require），.mjs 让 Node 直接按 ESM 加载。
const ENGINE_PATH = path.join(__dirname, "engine.mjs");
let enginePromise = null;

/** 加载清洗引擎（同目录 engine.mjs） */
function loadEngine() {
  if (!enginePromise) {
    if (!fs.existsSync(ENGINE_PATH)) {
      throw new Error(`未找到清洗引擎：缺少 ${ENGINE_PATH}（应与本脚本同目录）`);
    }
    enginePromise = import(pathToFileURL(ENGINE_PATH).href);
  }
  return enginePromise;
}

/* ================================================================
 * 二、通用工具
 * ================================================================ */

/** 确保目录存在（含多级父目录），返回规范化后的绝对路径 */
function ensureDir(dir) {
  const absDir = path.resolve(dir);
  fs.mkdirSync(absDir, { recursive: true });
  return absDir;
}

/* ================================================================
 * 三、文件定位
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
 * @param {Array<object>} sources 已规范化的数据源（engine.normalizeSources() 的结果）
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

/* ================================================================
 * 四、读取（引擎调用这里把表读成记录流）
 * ================================================================ */

/** 读取工作簿指定工作表：返回工作表对象与表名 */
function openSheet(filePath, sheetRef = 0) {
  const absPath = path.resolve(filePath);
  const workbook = XLSX.readFile(absPath, { raw: true, cellDates: false });
  const sheetName =
    typeof sheetRef === "number"
      ? workbook.SheetNames[sheetRef]
      : workbook.SheetNames.includes(sheetRef)
        ? sheetRef
        : null;
  if (!sheetName) throw new Error(`文件 ${path.basename(absPath)} 中找不到工作表「${sheetRef}」`);
  return { absPath, sheetName, worksheet: workbook.Sheets[sheetName] };
}

/** 取表头行（第一行）的列名，用于校验必填列 */
function readHeaderLabels(worksheet) {
  const range = XLSX.utils.decode_range(worksheet["!ref"] || "A1");
  const labels = [];
  for (let column = range.s.c; column <= range.e.c; column += 1) {
    const cell = worksheet[XLSX.utils.encode_cell({ r: range.s.r, c: column })];
    labels.push(cell ? cell.v ?? "" : "");
  }
  return labels;
}

/** 读取工作簿指定工作表为对象数组，并过滤整行空白行 */
function readSheet(filePath, sheetRef = 0) {
  const { absPath, sheetName, worksheet } = openSheet(filePath, sheetRef);
  const raw = XLSX.utils.sheet_to_json(worksheet, { defval: null, raw: true });
  return { absPath, sheetName, worksheet, raw };
}

/**
 * 给引擎用的读取器：把定位到的文件读成「只含所需列」的记录流。
 * @param {Array<{source: object, paths: string[], skipped?: boolean}>} entries locateSources 的结果
 * @param {{cellText: Function, assertSourceHeader: Function}} engine 共享引擎
 */
function createRecordReader(entries, engine) {
  const entryById = new Map(entries.map((entry) => [entry.source.id, entry]));

  return async function readRecords(source, fields, handle) {
    const entry = entryById.get(source.id);
    if (!entry) throw new Error(`[${source.label}] 未定位到文件`);
    if (entry.skipped || entry.paths.length === 0) return {}; // 可选表缺失：按空汇总处理

    for (const filePath of entry.paths) {
      const { absPath, sheetName, worksheet, raw } = readSheet(filePath, source.sheet ?? 0);
      engine.assertSourceHeader(source, readHeaderLabels(worksheet));

      let valid = 0;
      for (const row of raw) {
        const record = {};
        let hasValue = false;
        for (const field of fields) {
          const value = row[field] ?? null;
          record[field] = value;
          if (!hasValue && engine.cellText(value) !== "") hasValue = true;
        }
        if (!hasValue) continue;
        valid += 1;
        handle(record);
      }
      console.log(`读取 ${path.basename(absPath)} [${sheetName}]：${raw.length} 行 → 有效 ${valid} 行`);
    }
    return {};
  };
}

/* ================================================================
 * 五、输出
 * ================================================================ */

function columnWidth(name) {
  if (name === "唯一标识") return 34;
  if (name === "品名") return 40;
  if (name === "颜色") return 44;
  return Math.max(12, Math.min(24, name.length * 2 + 4));
}

function writeOutput(rows, header, outputFile, sheetName) {
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

/**
 * 把引擎产出的多张表写文件。第一张（总表）的文件名可用 --out 覆盖，其余按 OUTPUTS 配置。
 * @param {Record<string, {columns: string[], rows: Array<Array>}>} tables engine.runCleaning 的 tables
 * @param {Array<{sheet: string, file: string}>} outputs engine.OUTPUTS
 */
function writeOutputs(tables, outputs, outputDir, firstFileName = PATHS.outputFile) {
  const written = [];
  outputs.forEach((output, i) => {
    const table = tables[output.sheet];
    if (!table) throw new Error(`[${output.sheet}] 引擎没有产出这张表，请检查 engine.js 的 OUTPUTS`);
    const fileName = i === 0 ? firstFileName : output.file;
    const outPath = path.isAbsolute(fileName) ? fileName : path.join(outputDir, fileName);
    writeOutput(table.rows, table.columns, outPath, output.sheet);
    written.push(`${path.basename(outPath)}（${table.columns.length} 列）`);
  });
  console.log(`输出完成：${written.join("、")}`);
}

/* ================================================================
 * 六、日志
 * ================================================================ */

/** 打印当前生效的配置，便于确认各表取到的文件与列 */
function printConfig(entries) {
  console.log("数据源配置：");
  entries.forEach((entry, i) => {
    const { source } = entry;
    const fileText = entry.paths.length
      ? entry.paths.map((p) => path.basename(p)).join("、")
      : "（缺失，填默认值）";
    const colText = source.columns
      .filter((c) => c.month === undefined)
      .map((c) => {
        if (source.role !== "base") {
          if (c.divideFrom) {
            const by = c.divideFrom.byColumn ?? c.divideFrom.by;
            return `${c.as}(÷${by})`;
          }
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

/** 打印列计划：每张输出表输出哪些列、哪些列暂时没有数据来源、哪些源列没被任何表用到 */
function printColumnPlan(entries, outputs) {
  const available = new Set();
  entries.forEach((entry) => entry.source.columns.forEach((column) => available.add(column.as)));

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
  const dropped = [...available].filter(
    (name) => !used.has(name) && !["单位", "累积销量", "月均销量"].includes(name),
  );
  if (dropped.length) console.warn(`以下列已在数据源里配置，但没有输出到任何表：${dropped.join("、")}`);
}

/** 打印引擎回传的统计信息（调试时看匹配情况） */
function printStats(stats) {
  const { base, joins } = stats;
  console.log(`[${base.label}] 基准 SKU ${base.keyCount} 个（重复丢弃 ${base.duplicatedRows} 行）`);
  for (const join of joins) {
    const yearText = join.monthlyYear ? `，按月列统计年份 ${join.monthlyYear}` : "";
    const incompleteText = join.incompleteRows ? `，主键缺字段忽略 ${join.incompleteRows} 行` : "";
    const unmatchedText = join.unmatchedKeys
      ? `，基准里没有的 SKU ${join.unmatchedKeys} 个`
      : "";
    console.log(`[${join.label}] 汇总后 SKU ${join.keyCount} 个${yearText}${incompleteText}${unmatchedText}`);
  }
  if (stats.appendedRows) console.log(`基准里没有的 SKU：追加 ${stats.appendedRows} 行`);
  console.log(`总表：${stats.rowCount} 行`);
}

/* ================================================================
 * 七、主流程
 * ================================================================ */

/**
 * 执行一次完整清洗流程
 * @param {object} [options]
 * @param {string} [options.inputDir]   原始表目录，默认 脚本所在目录/data
 * @param {string} [options.outputDir]  输出目录，默认 脚本所在目录/output（不存在会自动创建）
 * @param {string} [options.outputFile] 输出文件名；传 null 不写文件；相对路径基于 outputDir
 * @param {object} [options.files]      按源 id 覆盖文件路径，如 { 库存结存表: "D:/x.xlsx" }
 * @param {boolean} [options.listOnly]  只打印匹配结果，不读取数据
 * @returns {Promise<Array<Array>>} 总表数据行（不含表头）
 */
async function cleanMerge(options = {}) {
  const {
    inputDir = PATHS.inputDir,
    outputDir = PATHS.outputDir,
    outputFile = PATHS.outputFile,
    files = {},
    listOnly = false,
  } = options;

  const engine = await loadEngine();
  const sources = engine.normalizeSources();
  const entries = locateSources(sources, ensureDir(inputDir), files);
  printConfig(entries);
  if (listOnly) return [];

  const monthlyNames = entries.flatMap((entry) =>
    entry.source.role === "base"
      ? []
      : entry.source.columns.filter((column) => column.month !== undefined).map((column) => column.as)
  );
  const resolvedOutputs = engine.OUTPUTS.map((output) => ({
    sheet: output.sheet,
    file: output.file,
    columns: output.columns.flatMap((name) =>
      name === engine.MONTHLY_TOKEN ? monthlyNames : [name]
    ),
  }));
  printColumnPlan(entries, resolvedOutputs);

  const { tables, stats } = await engine.runCleaning({
    readRecords: createRecordReader(entries, engine),
  });
  printStats(stats);

  if (outputFile) writeOutputs(tables, engine.OUTPUTS, outputDir, outputFile);
  return tables["总表"].rows;
}

/* ================================================================
 * 八、命令行入口
 * ================================================================ */

/**
 * 解析命令行参数
 *   --dir/-d <目录>        原始表目录（默认 data/）
 *   --out-dir <目录>       输出目录（默认 output/）
 *   --out/-o <文件>        输出文件（相对 out-dir）
 *   --file/-f <源id>=<路径>  覆盖某个数据源的文件路径（可重复）
 *   --list                 只打印匹配到的文件
 *   位置参数：1 个 → 目录；2 个及以上 → 按配置顺序给出文件路径
 */
function parseArgs(argv, sources = []) {
  const options = { files: {} };
  const positional = [];

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

async function main() {
  try {
    const engine = await loadEngine();
    const options = parseArgs(process.argv.slice(2), engine.normalizeSources());
    await cleanMerge(options);
  } catch (err) {
    console.error(`处理失败：${err.message}`);
    process.exitCode = 1;
  }
}

// 命令行直接运行：node clean-merge.js；被 require 时不自动执行
if (require.main === module) main();

module.exports = {
  PATHS,
  ENGINE_PATH,
  loadEngine,
  cleanMerge,
  locateSources,
  listExcelFiles,
  ensureDir,
  openSheet,
  readSheet,
  readHeaderLabels,
  createRecordReader,
  parseArgs,
  writeOutput,
  writeOutputs,
  printConfig,
  printColumnPlan,
  printStats,
};
