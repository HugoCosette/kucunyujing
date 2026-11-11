// 备货模式模块门面：配置读写、校验、计算能力都从这里对外暴露。
export {
  CATEGORIES,
  COEFFICIENT_KEYS,
  CUSTOMER_EXCLUSIVE,
  CUSTOMER_FLOW,
  HEAT_METRIC_FIELDS,
  LEGACY_METRIC_LABELS,
  MODE_KEYS,
  MODE_METRICS,
  SALES_WINDOW_DEFAULTS,
  expandMonthWeights,
} from './constants.js'

export {
  BUILTIN_MANUAL_MODES,
  BUILTIN_STRATEGIES,
  CONFIG_VERSION,
  DEFAULT_MANUAL_MODE_NAMES,
  DEFAULT_PROFILE_ID,
  DEFAULT_PROFILE_NAME,
  MANUAL_BEHAVIORS,
  createDefaultAutoModes,
  createDefaultConfig,
  createDefaultManualMode,
  createDefaultProfileFile,
} from './defaults.js'

export {
  PROFILE_FILE_VERSION,
  findManualMode,
  getActiveProfile,
  getAutoModes,
  getAutoStrategy,
  getManualModes,
  getManualStrategy,
  getSalesWeights,
  normalizeConfig,
  normalizeProfile,
  normalizeProfileFile,
  validateConfig,
} from './validate.js'

export {
  createEvaluator,
  evaluateItem,
  findBaselineMonth,
  summarizeEvaluation,
  weightedMonthlySales,
} from './engine.js'

export {
  BULK_SCORING_DEFAULTS,
  BULK_SCORING_DIMENSIONS,
  SCORING_DIMENSIONS,
  SCORING_TIERS,
  SCORING_TIER_LABELS,
  SCORING_TIER_TONES,
  computeGrowthRate,
  createDefaultScoring,
  describeScoringBand,
  describeScoringRanges,
  evaluateBulkScoring,
  evaluateScoring,
  normalizeBulkScoring,
  normalizeScoring,
  resolveGrowthMonths,
  validateBulkScoring,
  validateScoring,
} from './scoring.js'

export {
  SPU_GRADE_TIERS,
  SPU_GRADE_TONES,
  createDefaultSpuGrades,
  describeSpuGradeThresholds,
  normalizeSpuGrades,
  resolveSpuGrade,
  validateSpuGrades,
} from './spuGrades.js'

export {
  CONFIG_FILE_NAME,
  CONFIG_SAVE_ENDPOINT,
  CONFIG_STORAGE_KEY,
  activateProfile,
  exportConfigFile,
  getConfig,
  getProfiles,
  importConfigFile,
  loadConfig,
  loadProfiles,
  resetConfig,
  saveConfig,
  saveProfiles,
  setConfigRuntime,
  setProfilesRuntime,
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

export { createDemoProfile, DEMO_PROFILE_DISABLED } from './demoProfile.js'
