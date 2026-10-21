export const stockingRules = {
  SS: {
    黑白: {
      基础: { redLine: 4, normal: 8, peak: 12 },
      热销: { redLine: null, normal: null, peak: null },
    },
    彩色: {
      基础: { redLine: null, normal: null, peak: null },
      热销: { redLine: 3, normal: 5, peak: 8 },
    },
  },
  S: {
    黑白: {
      基础: { redLine: 3, normal: 6, peak: 10 },
      热销: { redLine: null, normal: null, peak: null },
    },
    彩色: {
      基础: { redLine: null, normal: null, peak: null },
      热销: { redLine: 2, normal: 4, peak: 6 },
    },
  },
  A: {
    黑白: {
      基础: { redLine: 3, normal: 5, peak: 8 },
      热销: { redLine: null, normal: null, peak: null },
    },
    彩色: {
      基础: { redLine: null, normal: null, peak: null },
      热销: { redLine: 2, normal: 3, peak: 5 },
    },
  },
}
