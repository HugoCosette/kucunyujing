// 备货模式模块门面：字段注册表、配置读写、校验、计算能力都从这里对外暴露。
export {
  ALL_GRADES,
  COMPARE_OPERATORS,
  FIELD_GROUPS,
  GRADES,
  HEAT_METRIC_FIELDS,
  STOCKING_FIELDS,
  UNGRADED,
  createThresholds,
  getFieldLabel,
  getFieldMeta,
  getFieldsByGroup,
  operatorLabel,
  operatorsFor,
} from './fields.js'

export {
  BUILTIN_MANUAL_MODES,
  BUILTIN_STRATEGIES,
  MANUAL_BEHAVIORS,
  createDefaultCoefficients,
  createDefaultConfig,
  createDefaultManualMode,
  createDefaultRule,
  createDefaultTier,
} from './defaults.js'

export {
  detectRuleOverlap,
  findManualMode,
  getAutoModes,
  getAutoStrategy,
  getManualModes,
  getManualStrategy,
  normalizeConfig,
  validateConfig,
} from './validate.js'

export {
  createEvaluator,
  evaluateItem,
  summarizeEvaluation,
} from './engine.js'

export {
  CONFIG_FILE_NAME,
  CONFIG_SAVE_ENDPOINT,
  CONFIG_STORAGE_KEY,
  exportConfigFile,
  getConfig,
  loadConfig,
  resetConfig,
  saveConfig,
  setConfigRuntime,
} from './persistence.js'

export {
  MANUAL_FILE_NAME,
  MANUAL_SAVE_ENDPOINT,
  MANUAL_STORAGE_KEY,
  exportManualFile,
  findDanglingSkuIds,
  loadManualSkus,
  normalizeManualSkus,
  saveManualSkus,
  setManualRuntime,
} from './manual.js'
