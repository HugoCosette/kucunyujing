<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useInventoryStore } from '@/stores/inventory'
import { usePurchaseStore } from '@/stores/purchase'
import {
  MAX_SNAPSHOTS,
  deleteSnapshot,
  getStorageSummary,
  requestPersistence,
  switchSnapshot,
} from '@/data/persistence'
import { clearLocalData, exportAllData, importAllData } from '@/data/transfer'

// 「登录即可看」= 打开页面就是上次的库存 + 需安排 + 订单，不再需要导入。
// 这一页只做透明度与兜底：占用多少、什么时候导入的、导出一份留底、彻底清空。
const inventoryStore = useInventoryStore()
const purchaseStore = usePurchaseStore()

const summary = ref({
  supported: true,
  persistent: false,
  snapshots: [],
  activeSnapshotId: null,
  storage: null,
  error: '',
})
const fileInput = ref(null)

async function refresh() {
  summary.value = await getStorageSummary()
}

onMounted(refresh)

const itemCount = computed(() => inventoryStore.inventoryItems.length)
const skuCount = computed(() => {
  const ids = new Set()
  for (const item of inventoryStore.inventoryItems) {
    const skuId = String(item.skuId ?? '').trim()
    if (skuId) ids.add(skuId)
  }
  return ids.size
})
const plannedCount = computed(
  () => inventoryStore.inventoryItems.filter((item) => Number(item.planned) > 0).length,
)
const purchaseCount = computed(() => inventoryStore.purchaseList.length)
const orderCount = computed(() => purchaseStore.orders.orders.length)
const draftSkuCount = computed(() => Object.keys(purchaseStore.orders.drafts ?? {}).length)

const statusText = computed(() => {
  if (!summary.value.supported) return '不可用'
  return summary.value.persistent ? '已持久化' : '本机保存（未申请持久配额）'
})

const usageText = computed(() => {
  const storage = summary.value.storage
  if (!storage || !storage.quota) return '未知'
  return `${formatBytes(storage.usage)} / ${formatBytes(storage.quota)}`
})

function formatBytes(size) {
  const value = Number(size)
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let index = 0
  let rest = value
  while (rest >= 1024 && index < units.length - 1) {
    rest /= 1024
    index += 1
  }
  return `${rest >= 10 || index === 0 ? Math.round(rest) : rest.toFixed(1)} ${units[index]}`
}

function formatTime(iso) {
  const date = new Date(iso ?? '')
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error ?? '未知错误')
}

async function requestPersist() {
  const granted = await requestPersistence()
  await refresh()
  if (granted) ElMessage.success('已获得持久化配额')
  else ElMessage.warning('浏览器暂时没有授予持久化配额，数据仍会保存，但请定期导出留底')
}

async function handleExport() {
  try {
    await exportAllData()
    ElMessage.success('已导出全量数据，可留作换机或清缓存前的备份')
  } catch (error) {
    ElMessage.error(`导出失败：${errorText(error)}`)
  }
}

function triggerImport() {
  fileInput.value?.click()
}

async function handleImportFile(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return

  try {
    await ElMessageBox.confirm(
      '导入会覆盖本机的导入数据、需安排、采购清单与订单，确定继续？',
      '导入全部数据',
      { type: 'warning', confirmButtonText: '导入', cancelButtonText: '取消' },
    )
  } catch {
    return
  }

  try {
    await importAllData(await file.text())
    ElMessage.success('已导入，正在重新加载')
    window.setTimeout(() => window.location.reload(), 400)
  } catch (error) {
    ElMessage.error(`导入失败：${errorText(error)}`)
  }
}

async function handleSwitch(entry) {
  try {
    await ElMessageBox.confirm(
      `切回到 ${formatTime(entry.createdAt)} 导入的数据？需安排、采购清单与订单不受影响。`,
      '切回历史快照',
      { type: 'warning', confirmButtonText: '切回', cancelButtonText: '取消' },
    )
  } catch {
    return
  }

  try {
    await switchSnapshot(entry.id)
    ElMessage.success('已切换，正在重新加载')
    window.setTimeout(() => window.location.reload(), 400)
  } catch (error) {
    ElMessage.error(`切回失败：${errorText(error)}`)
  }
}

async function handleDelete(entry) {
  try {
    await ElMessageBox.confirm(
      `删除 ${formatTime(entry.createdAt)} 的导入快照？需安排与订单不受影响。`,
      '删除快照',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }

  try {
    await deleteSnapshot(entry.id)
    await refresh()
    ElMessage.success('已删除')
  } catch (error) {
    ElMessage.error(`删除失败：${errorText(error)}`)
  }
}

async function handleClear() {
  try {
    await ElMessageBox.confirm(
      '清空本机保存的导入数据、需安排、采购清单与订单，配置方案保持不变。清空后无法恢复，确定继续？',
      '清空本机数据',
      { type: 'warning', confirmButtonText: '清空', cancelButtonText: '取消' },
    )
  } catch {
    return
  }

  await clearLocalData()
  ElMessage.success('已清空，正在重新加载')
  window.setTimeout(() => window.location.reload(), 400)
}
</script>

<template>
  <section class="panel">
    <div class="panel__head">
      <h2 class="panel__title">本机数据存储</h2>
      <div class="panel__head-actions">
        <button type="button" class="btn btn--sm" @click="refresh">刷新</button>
      </div>
    </div>

    <div class="panel__body">
      <div class="storage-grid">
        <div class="storage-card">
          <span class="storage-card__label">存储状态</span>
          <strong class="storage-card__value">{{ statusText }}</strong>
        </div>
        <div class="storage-card">
          <span class="storage-card__label">站点占用</span>
          <strong class="storage-card__value">{{ usageText }}</strong>
        </div>
        <div class="storage-card">
          <span class="storage-card__label">库存数据</span>
          <strong class="storage-card__value">{{ itemCount }} 行 · {{ skuCount }} 个 SKU</strong>
        </div>
        <div class="storage-card">
          <span class="storage-card__label">需安排 / 采购清单</span>
          <strong class="storage-card__value">{{ plannedCount }} / {{ purchaseCount }} 条</strong>
        </div>
        <div class="storage-card">
          <span class="storage-card__label">分订单</span>
          <strong class="storage-card__value">{{ orderCount }} 张 · 草稿 {{ draftSkuCount }} 个 SKU</strong>
        </div>
      </div>

      <p v-if="!summary.supported" class="form__note">
        当前浏览器不支持 IndexedDB：数据只在本次会话有效，请先导出留底。
      </p>
      <p v-else-if="!summary.persistent" class="form__note">
        还没拿到持久化配额，磁盘紧张时浏览器可能清理这些数据。
        <button type="button" class="btn btn--text btn--sm" @click="requestPersist">申请持久化</button>
      </p>
      <p v-if="summary.error" class="form__note">最近一次保存失败：{{ summary.error }}</p>

      <div class="storage-actions">
        <button type="button" class="btn btn--sm" @click="handleExport">导出全部数据</button>
        <button type="button" class="btn btn--sm" @click="triggerImport">导入全部数据</button>
        <button type="button" class="btn btn--sm btn--danger" @click="handleClear">清空本机数据</button>
        <input
          ref="fileInput"
          type="file"
          accept="application/json,.json"
          class="storage-file-input"
          @change="handleImportFile"
        />
      </div>

      <div class="storage-block">
        <div class="storage-block__head">
          <span class="storage-block__title">导入快照（最近 {{ MAX_SNAPSHOTS }} 份）</span>
          <span class="storage-block__hint">切回只回滚导入的库存与销售表，需安排、采购清单和订单不动</span>
        </div>
        <p v-if="!summary.snapshots.length" class="form__note">
          还没有导入过数据（当前显示的是演示种子数据）。
        </p>
        <ul v-else class="snapshot-list">
          <li
            v-for="entry in summary.snapshots"
            :key="entry.id"
            class="snapshot-row"
            :class="{ 'is-active': entry.id === summary.activeSnapshotId }"
          >
            <span class="snapshot-row__time">{{ formatTime(entry.createdAt) }}</span>
            <span class="snapshot-row__meta">
              {{ entry.itemCount }} 行 · {{ entry.skuCount }} 个 SKU · 销售表 {{ entry.saleSkuCount }} 个
            </span>
            <span class="snapshot-row__size">{{ formatBytes(entry.size) }}</span>
            <span class="snapshot-row__ops">
              <span v-if="entry.id === summary.activeSnapshotId" class="snapshot-row__badge">使用中</span>
              <button v-else type="button" class="btn btn--text btn--sm" @click="handleSwitch(entry)">
                切回
              </button>
              <button
                type="button"
                class="btn btn--text btn--sm"
                :disabled="entry.id === summary.activeSnapshotId"
                @click="handleDelete(entry)"
              >
                删除
              </button>
            </span>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>

<style scoped>
.storage-file-input {
  display: none;
}

.storage-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 8px;
}

.storage-card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid var(--industrial-grid-light);
  border-radius: 3px;
}

.storage-card__label {
  font-size: 12px;
  color: var(--industrial-muted);
}

.storage-card__value {
  font-size: 13px;
  font-weight: 600;
}

.storage-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.storage-block {
  margin-top: 16px;
}

.storage-block__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 6px;
}

.storage-block__title {
  font-size: 12.5px;
  font-weight: 600;
}

.storage-block__hint {
  font-size: 12px;
  color: var(--industrial-muted);
}

.snapshot-list {
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--industrial-grid-light);
  border-radius: 3px;
}

.snapshot-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  font-size: 12.5px;
}

.snapshot-row + .snapshot-row {
  border-top: 1px solid var(--industrial-grid-light);
}

.snapshot-row.is-active {
  background: #eef4f7;
}

.snapshot-row__time {
  min-width: 132px;
  font-variant-numeric: tabular-nums;
}

.snapshot-row__meta {
  flex: 1 1 260px;
  color: var(--industrial-muted);
}

.snapshot-row__size {
  min-width: 70px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.snapshot-row__ops {
  display: flex;
  align-items: center;
  gap: 4px;
}

.snapshot-row__badge {
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--industrial-primary);
  color: #fff;
  font-size: 11.5px;
}
</style>
