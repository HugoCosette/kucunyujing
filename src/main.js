import './assets/main.css'
import 'element-plus/es/components/table/style/css'
import 'element-plus/es/components/table-column/style/css'
import 'element-plus/es/components/button/style/css'
import 'element-plus/es/components/dialog/style/css'
import 'element-plus/es/components/form/style/css'
import 'element-plus/es/components/form-item/style/css'
import 'element-plus/es/components/message/style/css'
import 'element-plus/es/components/input-number/style/css'
import 'element-plus/es/components/input/style/css'
import 'element-plus/es/components/select/style/css'
import 'element-plus/es/components/switch/style/css'
import 'element-plus/es/components/tag/style/css'
import 'element-plus/es/components/tooltip/style/css'
import 'element-plus/es/components/message-box/style/css'
import 'element-plus/es/components/checkbox/style/css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { bootstrapPersistence } from './data/bootstrap'

const app = createApp(App)

app.use(createPinia())

// 先把 IndexedDB 里的快照、需安排与订单读回内存，再挂载路由与页面。
// 读失败不影响启动：退回演示种子数据，页面照常可用。
bootstrapPersistence()
  .catch((error) => console.warn('持久化数据加载失败', error))
  .finally(() => {
    app.use(router)
    app.mount('#app')
  })
