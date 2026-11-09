import { computed, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import {
  activateProfile,
  getActiveProfile,
  loadManualSkus,
  loadProfiles,
  resetConfig,
  saveManualSkus,
  saveProfiles,
} from '@/stocking'

// 配置以「方案文件」为单位：一个文件里有多套方案，同一时刻只有 activeProfileId 生效。
// 主面板、销售表、SKU 弹窗与两个配置页读到的都是当前方案的配置，切换方案即全站生效。
// 手动清单仍然独立成文件：它记录「人对商品的长期决定」，跨方案、跨导入与刷新都有效。
export const useStockingConfigStore = defineStore('stocking-config', () => {
  const profileFile = shallowRef(loadProfiles())
  const manual = shallowRef(
    loadManualSkus(getActiveProfile(profileFile.value).config),
  )

  const profiles = computed(() => profileFile.value.profiles)
  const activeProfileId = computed(() => profileFile.value.activeProfileId)
  const activeProfile = computed(() => getActiveProfile(profileFile.value))
  const config = computed(() => activeProfile.value.config)

  // 评估器消费的形态：skuId → { modeId, coefficients }
  const manualOverrides = computed(() => new Map(Object.entries(manual.value.items ?? {})))

  function applySaved(saved) {
    profileFile.value = saved.profiles
    return { config: getActiveProfile(saved.profiles).config, written: saved.written }
  }

  // 保存后写回源文件（开发态）或本地缓存（构建产物），并同步到全局单例。
  async function apply(nextConfig) {
    const active = getActiveProfile(profileFile.value)
    const saved = await saveProfiles({
      ...profileFile.value,
      profiles: profileFile.value.profiles.map((profile) =>
        profile.id === active.id
          ? { ...profile, config: { ...nextConfig, updatedAt: new Date().toISOString() } }
          : profile,
      ),
    })
    return applySaved(saved)
  }

  async function restoreDefaults() {
    return applySaved(await resetConfig())
  }

  async function selectProfile(profileId) {
    if (profileId === profileFile.value.activeProfileId) {
      return { config: activeProfile.value.config, written: false }
    }
    return applySaved(await activateProfile(profileId))
  }

  async function duplicateProfile(name) {
    const active = getActiveProfile(profileFile.value)
    const id = `profile-${Date.now().toString(36)}`
    const used = new Set(profileFile.value.profiles.map((profile) => profile.name))
    const base = String(name ?? '').trim() || `${active.name} 副本`
    let finalName = base
    let index = 2
    while (used.has(finalName)) {
      finalName = `${base}（${index}）`
      index += 1
    }

    const saved = await saveProfiles({
      ...profileFile.value,
      activeProfileId: id,
      profiles: [
        ...profileFile.value.profiles,
        { id, name: finalName, config: active.config },
      ],
    })
    return applySaved(saved)
  }

  async function renameProfile(profileId, name) {
    const text = String(name ?? '').trim()
    if (!text) return { written: false }

    const saved = await saveProfiles({
      ...profileFile.value,
      profiles: profileFile.value.profiles.map((profile) =>
        profile.id === profileId ? { ...profile, name: text } : profile,
      ),
    })
    return applySaved(saved)
  }

  async function removeProfile(profileId) {
    if (profileFile.value.profiles.length <= 1) return { written: false }

    const remaining = profileFile.value.profiles.filter(
      (profile) => profile.id !== profileId,
    )
    if (!remaining.length) return { written: false }

    const saved = await saveProfiles({
      ...profileFile.value,
      activeProfileId:
        profileFile.value.activeProfileId === profileId
          ? remaining[0].id
          : profileFile.value.activeProfileId,
      profiles: remaining,
    })
    return applySaved(saved)
  }

  async function importProfiles(nextProfiles) {
    return applySaved(await saveProfiles(nextProfiles))
  }

  async function applyManual(nextManual) {
    const saved = await saveManualSkus(nextManual, config.value)
    manual.value = saved.manual
    return saved
  }

  async function setManualEntry(skuId, entry) {
    const key = String(skuId ?? '').trim()
    if (!key) return { manual: manual.value, written: false }

    const items = { ...manual.value.items }
    if (!entry) delete items[key]
    else items[key] = entry
    return applyManual({ ...manual.value, items })
  }

  async function removeManualEntries(skuIds) {
    const keys = new Set((skuIds ?? []).map((id) => String(id ?? '').trim()))
    if (keys.size === 0) return { manual: manual.value, written: false }

    const items = Object.fromEntries(
      Object.entries(manual.value.items).filter(([skuId]) => !keys.has(skuId)),
    )
    return applyManual({ ...manual.value, items })
  }

  return {
    profileFile,
    profiles,
    activeProfileId,
    activeProfile,
    config,
    manual,
    manualOverrides,
    apply,
    restoreDefaults,
    selectProfile,
    duplicateProfile,
    renameProfile,
    removeProfile,
    importProfiles,
    applyManual,
    setManualEntry,
    removeManualEntries,
  }
})
