// 数据访问层契约：页面 / store 只认这里导出的方法，不直连 IndexedDB 或 localStorage。
// 阶段二做多人协作时，把下面这行实现换成 httpRepo.js 即可，调用方一行都不用改。
export * from './indexedDbRepo.js'
