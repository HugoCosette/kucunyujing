// 兼容入口：读取工作簿首张工作表的全部行。实际解析在 xlsxStream（支持分段读取大表）。
export { readWorkbookRows } from './xlsxStream'
