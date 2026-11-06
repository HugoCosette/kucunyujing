// 清洗口径的唯一定义在 tools/cleaning/engine.mjs（命令行脚本也用它）。
// 这里只做一行转发：应用侧统一从 '@/cleaning/engine' 引入，目录搬家时只改这一处。
export * from '../../tools/cleaning/engine.mjs'
